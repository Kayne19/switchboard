use crate::models::{CatalogKey, ModelCatalog};
use crate::pi_client::{isolate_process, SshClientOptions, ValidatedSshTarget};
use crate::registry::{Project, Registry};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::{watch, Mutex, Semaphore};
use tokio::time::timeout;

const STDOUT_LIMIT: usize = 64 * 1024;
const STDERR_LIMIT: usize = 4096;
#[cfg(not(test))]
const PREPARE_TIMEOUT_SECS: u64 = 120;
#[cfg(test)]
const PREPARE_TIMEOUT_SECS: u64 = 1;
const SSH_CHECK_TIMEOUT_SECS: u64 = 5;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TransportState {
    Pending,
    Acquiring,
    Ready {
        generation: u64,
        control_path: Option<PathBuf>,
    },
    Recovering,
    Degraded {
        generation: u64,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArtifactState {
    Pending,
    Refreshing {
        source_digest: String,
        transport_generation: u64,
    },
    Ready {
        path: String,
        digest: String,
        degraded_reason: Option<String>,
    },
    Sentinel {
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CatalogState {
    Pending,
    Refreshing {
        transport_generation: u64,
    },
    Ready {
        snapshot: ModelCatalog,
        degraded_reason: Option<String>,
    },
    Unavailable {
        reason: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrepareSource {
    Startup,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrepareOutcome {
    Success,
    Nonzero,
    TimedOut,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrepareReport {
    pub timestamp_unix_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub source: PrepareSource,
    pub outcome: PrepareOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PrepareState {
    Pending,
    Running,
    Settled { report: PrepareReport },
    InfrastructureFailed { reason: String },
}

#[derive(Clone, Debug)]
pub enum ArtifactDecision {
    None,
    Ready(String),
    Sentinel(String),
}

#[derive(Clone, Debug)]
pub struct ProjectReadiness {
    pub prepare_report: Option<PrepareReport>,
    pub artifact_decision: ArtifactDecision,
    /// The host's catalog; `available: false` when listing failed. Whether a
    /// requested model can still be used is `ModelCatalog::resolve`'s call,
    /// not prewarm's.
    pub catalog: ModelCatalog,
    pub transport_generation: u64,
}

/// Everything a project leg launches with, all of it settled by startup work,
/// so a transfer or redial does no setup of its own.
#[derive(Clone, Debug)]
pub struct LaunchPlan {
    pub prepare_report: Option<PrepareReport>,
    pub catalog: ModelCatalog,
    /// The extension to load with `-e`. `None` launches without one, and the
    /// agent is briefed to end its turn with the return sentinel instead.
    pub extension: Option<String>,
    /// How to reach a remote project's host; `None` for a local project.
    pub ssh: Option<SshClientOptions>,
}

#[derive(Debug)]
enum MasterOwnership {
    Created(Child),
    Adopted,
}

struct HostTransportInner {
    state_tx: watch::Sender<TransportState>,
    lock_file: Option<std::fs::File>,
    master: Option<MasterOwnership>,
    generation: u64,
    control_path: PathBuf,
}

pub struct PrewarmInner {
    state_dir: PathBuf,
    ssh_program: String,
    agent_extension_file: Option<String>,
    remote_cache_dir: String,
    registry: Registry,

    // One entry per host, catalog, staging host, and project in the
    // registry, all created at construction and never added to afterwards,
    // so they need no lock of their own; each state lives in its channel.
    transports: HashMap<String, Arc<Mutex<HostTransportInner>>>,
    transport_watchers: HashMap<String, watch::Receiver<TransportState>>,

    catalogs: HashMap<CatalogKey, watch::Sender<CatalogState>>,
    artifacts: HashMap<String, watch::Sender<ArtifactState>>,
    prepares: HashMap<String, watch::Sender<PrepareState>>,

    cwd_semaphores: Mutex<HashMap<(String, String), Arc<Semaphore>>>,
    ssh_semaphore: Arc<Semaphore>,
    prepare_semaphore: Arc<Semaphore>,

    shutdown_tx: watch::Sender<bool>,
}

#[derive(Clone)]
pub struct Prewarm {
    inner: Arc<PrewarmInner>,
}

/// Truncated deliberately: this names a ControlMaster socket, and sun_path is
/// 108 bytes. ssh appends a 17-byte ".XXXXXXXXXXXXXXXX" suffix while binding,
/// so a full 64-hex digest overflowed and every master died with "path too
/// long for Unix domain socket". 16 hex (64 bits) is ample for distinguishing
/// a handful of hosts, and collisions are not adversarial here.
fn host_hash(canonical_host: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(canonical_host.as_bytes());
    format!("{:x}", hasher.finalize())[..16].to_owned()
}

fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn try_flock_ex(file: &std::fs::File) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let res = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if res != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

fn unlock_flock(file: &std::fs::File) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let _ = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    }
    Ok(())
}

async fn drain_bounded<R: tokio::io::AsyncRead + Unpin>(reader: &mut R, limit: usize) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let n = match reader.read(&mut chunk).await {
            Ok(n) => n,
            Err(error) => {
                tracing::warn!(%error, captured = buf.len(), "output reader stopped; keeping partial output");
                break;
            }
        };
        if n == 0 {
            break;
        }
        if buf.len() < limit {
            let to_take = (limit - buf.len()).min(n);
            buf.extend_from_slice(&chunk[..to_take]);
        }
    }
    String::from_utf8_lossy(&buf).to_string()
}

impl Prewarm {
    /// Registers every piece of startup work the registry needs and starts
    /// it in the background. Must be called inside the Tokio runtime.
    pub fn start(config: &crate::Config, registry: &Registry) -> Self {
        let prewarm = Self::register(config, registry);
        prewarm.spawn_jobs();
        prewarm
    }

    /// A state channel for every remote host, catalog, staging host, and
    /// project in the registry, all `Pending`, with no work started.
    fn register(config: &crate::Config, registry: &Registry) -> Self {
        let (shutdown_tx, _) = watch::channel(false);

        let locks_dir = config.state_dir.join("ssh").join("locks");
        let control_dir = config.state_dir.join("ssh").join("control");
        let _ = ensure_private_dir(&locks_dir);
        let _ = ensure_private_dir(&control_dir);

        let mut transports = HashMap::new();
        let mut transport_watchers = HashMap::new();
        let mut catalogs = HashMap::new();
        let mut artifacts = HashMap::new();
        let mut prepares = HashMap::new();
        for project in &registry.projects {
            if let Some(host) = project.canonical_host() {
                if !transports.contains_key(host) {
                    let (state_tx, state_rx) = watch::channel(TransportState::Pending);
                    let transport = HostTransportInner {
                        state_tx,
                        lock_file: None,
                        master: None,
                        generation: 1,
                        control_path: control_dir.join(format!("{}.sock", host_hash(host))),
                    };
                    transports.insert(host.to_owned(), Arc::new(Mutex::new(transport)));
                    transport_watchers.insert(host.to_owned(), state_rx);
                }
                if project.stage_extension {
                    artifacts
                        .entry(host.to_owned())
                        .or_insert_with(|| watch::channel(ArtifactState::Pending).0);
                }
            }
            catalogs
                .entry(CatalogKey::for_project(project))
                .or_insert_with(|| watch::channel(CatalogState::Pending).0);
            prepares.insert(project.id.clone(), watch::channel(PrepareState::Pending).0);
        }

        Self {
            inner: Arc::new(PrewarmInner {
                state_dir: config.state_dir.clone(),
                ssh_program: config.ssh_program.clone(),
                agent_extension_file: config.agent_extension.clone(),
                remote_cache_dir: config.remote_cache_dir.clone(),
                registry: registry.clone(),

                transports,
                transport_watchers,

                catalogs,
                artifacts,
                prepares,

                cwd_semaphores: Mutex::new(HashMap::new()),
                ssh_semaphore: Arc::new(Semaphore::new(10)),
                prepare_semaphore: Arc::new(Semaphore::new(5)),

                shutdown_tx,
            }),
        }
    }

    fn spawn_jobs(&self) {
        for host in self.inner.transports.keys() {
            let (this, host) = (self.clone(), host.clone());
            tokio::spawn(async move { this.run_transport_manager(&host).await });
        }
        for key in self.inner.catalogs.keys() {
            let (this, key) = (self.clone(), key.clone());
            tokio::spawn(async move { this.run_catalog_job(key).await });
        }
        for host in self.inner.artifacts.keys() {
            let (this, host) = (self.clone(), host.clone());
            tokio::spawn(async move { this.run_artifact_job(&host).await });
        }
        for project in &self.inner.registry.projects {
            let (this, project) = (self.clone(), project.clone());
            tokio::spawn(async move { this.run_prepare_job(project).await });
        }
    }

    pub fn client_for(&self, host: &str, generation: u64) -> Result<SshClientOptions, String> {
        let canonical = host.trim();
        if canonical.is_empty() {
            let target = ValidatedSshTarget::new("local@localhost")
                .unwrap_or_else(|_| ValidatedSshTarget::new("localhost").unwrap());
            return Ok(SshClientOptions::new(&self.inner.ssh_program, target));
        }

        let target = ValidatedSshTarget::new(canonical).map_err(|e| e.to_string())?;
        let watcher = self
            .inner
            .transport_watchers
            .get(canonical)
            .ok_or_else(|| format!("no transport registered for host {canonical:?}"))?;

        let current = watcher.borrow().clone();
        match current {
            TransportState::Ready {
                generation: current_gen,
                control_path,
            } => {
                if current_gen != generation {
                    return Err(format!(
                        "transport generation mismatch: requested {generation}, current is {current_gen}"
                    ));
                }
                let mut opts = SshClientOptions::new(&self.inner.ssh_program, target);
                if let Some(cp) = control_path {
                    opts = opts.with_control_path(cp);
                }
                Ok(opts)
            }
            TransportState::Degraded { reason, .. } => Err(format!(
                "transport is degraded for host {canonical:?}: {reason}"
            )),
            _ => Err(format!("transport not ready for host {canonical:?}")),
        }
    }

    pub async fn await_project(&self, project: &Project) -> Result<ProjectReadiness, String> {
        let canonical = project.canonical_host().unwrap_or("");

        // 1. Wait for transport
        let generation = self.await_transport_ready(canonical).await?;

        // 2. Wait for prepare
        let prepare_report = self.await_prepare_settled(&project.id).await?;

        // 3. Wait for catalog
        let catalog = self
            .await_catalog(&CatalogKey::for_project(project))
            .await?;

        // 4. Wait for artifact decision if needed
        let artifact_decision = if project.is_remote() && project.stage_extension {
            self.await_artifact(canonical).await?
        } else {
            ArtifactDecision::None
        };

        Ok(ProjectReadiness {
            prepare_report,
            artifact_decision,
            catalog,
            transport_generation: generation,
        })
    }

    /// Waits for the project's startup work and turns it into what the leg
    /// launches with. Errors name the piece of setup that is not usable.
    pub async fn launch_plan(&self, project: &Project) -> Result<LaunchPlan, String> {
        let readiness = self.await_project(project).await?;
        let ssh = match project.canonical_host() {
            Some(host) => Some(self.client_for(host, readiness.transport_generation)?),
            None => None,
        };
        let extension = if project.is_remote() {
            match readiness.artifact_decision {
                ArtifactDecision::Ready(path) => Some(path),
                ArtifactDecision::Sentinel(reason) => {
                    tracing::info!(project = %project.id, %reason, "launching without the switchboard extension; the agent is briefed to use the return sentinel");
                    None
                }
                ArtifactDecision::None => None,
            }
        } else {
            self.inner
                .agent_extension_file
                .clone()
                .filter(|path| Path::new(path).is_file())
        };
        Ok(LaunchPlan {
            prepare_report: readiness.prepare_report,
            catalog: readiness.catalog,
            extension,
            ssh,
        })
    }

    async fn await_transport_ready(&self, canonical_host: &str) -> Result<u64, String> {
        if canonical_host.is_empty() {
            return Ok(0);
        }

        let mut rx = self
            .inner
            .transport_watchers
            .get(canonical_host)
            .cloned()
            .ok_or_else(|| format!("no transport found for host {canonical_host:?}"))?;
        loop {
            let state = rx.borrow().clone();
            match state {
                TransportState::Ready { generation, .. } => return Ok(generation),
                TransportState::Degraded { reason, .. } => {
                    return Err(format!("transport degraded for {canonical_host}: {reason}"));
                }
                _ => {
                    if rx.changed().await.is_err() {
                        return Err(format!("transport watch closed for {canonical_host}"));
                    }
                }
            }
        }
    }

    async fn await_prepare_settled(
        &self,
        project_id: &str,
    ) -> Result<Option<PrepareReport>, String> {
        let mut rx = self
            .inner
            .prepares
            .get(project_id)
            .map(|tx| tx.subscribe())
            .ok_or_else(|| format!("no prepare task found for project {project_id}"))?;

        loop {
            let state = rx.borrow().clone();
            match state {
                PrepareState::Settled { report } => return Ok(Some(report)),
                PrepareState::InfrastructureFailed { reason } => {
                    return Err(format!(
                        "prepare infrastructure failed for {project_id}: {reason}"
                    ));
                }
                _ => {
                    if rx.changed().await.is_err() {
                        return Err(format!("prepare watch closed for {project_id}"));
                    }
                }
            }
        }
    }

    async fn await_catalog(&self, key: &CatalogKey) -> Result<ModelCatalog, String> {
        let mut rx = self
            .inner
            .catalogs
            .get(key)
            .map(|tx| tx.subscribe())
            .ok_or_else(|| format!("no catalog task for key {:?}", key.to_key_string()))?;

        loop {
            let state = rx.borrow().clone();
            match state {
                CatalogState::Ready { snapshot, .. } => return Ok(snapshot),
                CatalogState::Unavailable { reason } => {
                    return Ok(ModelCatalog::unavailable(reason));
                }
                _ => {
                    if rx.changed().await.is_err() {
                        return Err(format!(
                            "catalog watch closed for key {:?}",
                            key.to_key_string()
                        ));
                    }
                }
            }
        }
    }

    async fn await_artifact(&self, canonical_host: &str) -> Result<ArtifactDecision, String> {
        let mut rx = self
            .inner
            .artifacts
            .get(canonical_host)
            .map(|tx| tx.subscribe())
            .ok_or_else(|| format!("no artifact task for host {canonical_host:?}"))?;

        loop {
            let state = rx.borrow().clone();
            match state {
                ArtifactState::Ready { path, .. } => return Ok(ArtifactDecision::Ready(path)),
                ArtifactState::Sentinel { reason } => {
                    return Ok(ArtifactDecision::Sentinel(reason))
                }
                _ => {
                    if rx.changed().await.is_err() {
                        return Err(format!("artifact watch closed for host {canonical_host:?}"));
                    }
                }
            }
        }
    }

    async fn run_transport_manager(&self, host: &str) {
        let lock_path = self
            .inner
            .state_dir
            .join("ssh")
            .join("locks")
            .join(format!("{}.lock", host_hash(host)));

        let transport_lock = Arc::clone(&self.inner.transports[host]);

        let mut shutdown_rx = self.inner.shutdown_tx.subscribe();
        const MAX_ATTEMPTS: u32 = 3;
        const LOCK_WAIT_ATTEMPTS: u32 = 50;
        const LOCK_WAIT_MS: u64 = 200;

        if *shutdown_rx.borrow() {
            self.cleanup_transport(host, &transport_lock).await;
            return;
        }

        let mut attempts = 0;
        let mut last_error = String::new();

        while attempts < MAX_ATTEMPTS {
            if *shutdown_rx.borrow() {
                self.cleanup_transport(host, &transport_lock).await;
                return;
            }

            attempts += 1;

            {
                let guard = transport_lock.lock().await;
                guard.state_tx.send_replace(TransportState::Acquiring);
            }

            // Acquire the shared lock without blocking a Tokio worker.
            // A sibling process may own it while its master is live; wait
            // for a bounded interval, then publish degradation instead of
            // hanging startup or transfer forever.
            let control_path = {
                let guard = transport_lock.lock().await;
                guard.control_path.clone()
            };

            let target = match ValidatedSshTarget::new(host) {
                Ok(t) => t,
                Err(e) => {
                    last_error = e.to_string();
                    break;
                }
            };

            let options = SshClientOptions::new(&self.inner.ssh_program, target.clone())
                .with_control_path(&control_path);

            // Check existing master socket BEFORE trying to acquire creation flock.
            // If another process is running the master, we can adopt it immediately.
            if self.check_master(&options, &control_path).await {
                let mut guard = transport_lock.lock().await;
                let gen = guard.generation;
                guard.master = Some(MasterOwnership::Adopted);
                guard.state_tx.send_replace(TransportState::Ready {
                    generation: gen,
                    control_path: Some(control_path.clone()),
                });
            } else {
                // Acquire the shared lock to create or recover the master process.
                let mut file = None;
                for _ in 0..LOCK_WAIT_ATTEMPTS {
                    if *shutdown_rx.borrow() {
                        self.cleanup_transport(host, &transport_lock).await;
                        return;
                    }
                    let lock_path_clone = lock_path.clone();
                    let flock_res = tokio::task::spawn_blocking(move || {
                        let file = std::fs::OpenOptions::new()
                            .create(true)
                            .read(true)
                            .write(true)
                            .truncate(false)
                            .open(&lock_path_clone)?;
                        try_flock_ex(&file)?;
                        Ok::<_, std::io::Error>(file)
                    })
                    .await;
                    match flock_res {
                        Ok(Ok(acquired)) => {
                            file = Some(acquired);
                            break;
                        }
                        Ok(Err(error)) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            tokio::time::sleep(Duration::from_millis(LOCK_WAIT_MS)).await;
                        }
                        Ok(Err(error)) => {
                            last_error = format!("failed to acquire flock lock: {error}");
                            break;
                        }
                        Err(error) => {
                            last_error = format!("flock task join error: {error}");
                            break;
                        }
                    }
                }
                let Some(file) = file else {
                    if last_error.is_empty() {
                        last_error = "timed out waiting for the host transport lock".into();
                    }
                    continue;
                };

                {
                    let mut guard = transport_lock.lock().await;
                    guard.lock_file = Some(file);
                }

                // Re-check master under flock in case another process created it
                if self.check_master(&options, &control_path).await {
                    let mut guard = transport_lock.lock().await;
                    let gen = guard.generation;
                    guard.master = Some(MasterOwnership::Adopted);
                    if let Some(f) = guard.lock_file.take() {
                        let _ = unlock_flock(&f);
                    }
                    guard.state_tx.send_replace(TransportState::Ready {
                        generation: gen,
                        control_path: Some(control_path.clone()),
                    });
                } else {
                    // Remove stale socket ONLY after lock held
                    let _ = std::fs::remove_file(&control_path);

                    // Create master
                    let mut master_cmd = options.master_command(&control_path);
                    isolate_process(&mut master_cmd);
                    match master_cmd.spawn() {
                        Ok(mut child) => {
                            let process_guard = crate::pi_client::ProcessTreeGuard::new(&child);
                            let start = Instant::now();
                            let mut ready = false;
                            let mut master_error = None;
                            while start.elapsed() < Duration::from_secs(5) {
                                if *shutdown_rx.borrow() {
                                    break;
                                }
                                match child.try_wait() {
                                    Ok(Some(status)) => {
                                        master_error =
                                            Some(format!("master process exited with {status}"));
                                        break;
                                    }
                                    Ok(None) => {}
                                    Err(error) => {
                                        master_error = Some(format!(
                                            "could not inspect master process: {error}"
                                        ));
                                        break;
                                    }
                                }
                                if self.check_master(&options, &control_path).await {
                                    ready = true;
                                    break;
                                }
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            }

                            if ready {
                                process_guard.disarm();
                                let mut guard = transport_lock.lock().await;
                                let gen = guard.generation;
                                guard.master = Some(MasterOwnership::Created(child));
                                if let Some(f) = guard.lock_file.take() {
                                    let _ = unlock_flock(&f);
                                }
                                guard.state_tx.send_replace(TransportState::Ready {
                                    generation: gen,
                                    control_path: Some(control_path.clone()),
                                });
                            } else {
                                last_error = master_error.unwrap_or_else(|| {
                                    "master process socket did not become ready".into()
                                });
                                crate::pi_client::terminate_process(&mut child).await;
                                process_guard.disarm();

                                {
                                    let mut guard = transport_lock.lock().await;
                                    if let Some(f) = guard.lock_file.take() {
                                        let _ = unlock_flock(&f);
                                    }
                                }
                                tokio::time::sleep(Duration::from_millis(200)).await;
                                continue;
                            }
                        }
                        Err(e) => {
                            last_error = format!("failed to spawn master process: {e}");
                            {
                                let mut guard = transport_lock.lock().await;
                                if let Some(f) = guard.lock_file.take() {
                                    let _ = unlock_flock(&f);
                                }
                            }
                            tokio::time::sleep(Duration::from_millis(200)).await;
                            continue;
                        }
                    }
                }
            }

            // Health monitoring loop. A failed probe means the current
            // generation is unusable and the outer loop must reacquire it.
            let health_failed = loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() {
                            self.cleanup_transport(host, &transport_lock).await;
                            return;
                        }
                    }
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {
                        let ok = self.check_master(&options, &control_path).await;
                        if !ok {
                            let mut guard = transport_lock.lock().await;
                            guard.generation += 1;
                            let gen = guard.generation;
                            guard.state_tx.send_replace(TransportState::Recovering);
                            tracing::warn!(host, generation = gen, "master health probe failed; reconnecting");
                            break true;
                        }
                    }
                }
            };

            {
                let mut guard = transport_lock.lock().await;
                if let Some(file) = guard.lock_file.take() {
                    let _ = unlock_flock(&file);
                }
            }

            if health_failed {
                continue;
            }
        }

        {
            let guard = transport_lock.lock().await;
            let gen = guard.generation;
            guard.state_tx.send_replace(TransportState::Degraded {
                generation: gen,
                reason: if last_error.is_empty() {
                    "transport acquisition attempts exhausted".into()
                } else {
                    last_error.clone()
                },
            });
        }

        // Keep an exhausted startup acquisition terminal for this
        // prewarm instance. Re-entering Acquiring immediately would let a
        // watch receiver miss the degraded state and wait forever. A
        // future explicit rearm can start a fresh generation deliberately.
        self.cleanup_transport(host, &transport_lock).await;
    }

    async fn check_master(&self, options: &SshClientOptions, control_path: &Path) -> bool {
        let mut cmd = options.check_command(control_path);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        isolate_process(&mut cmd);

        match cmd.spawn() {
            Ok(mut child) => {
                let guard = crate::pi_client::ProcessTreeGuard::new(&child);
                match timeout(Duration::from_secs(SSH_CHECK_TIMEOUT_SECS), child.wait()).await {
                    Ok(Ok(status)) => {
                        guard.disarm();
                        status.success()
                    }
                    _ => {
                        crate::pi_client::terminate_process(&mut child).await;
                        guard.disarm();
                        false
                    }
                }
            }
            Err(_) => false,
        }
    }

    async fn cleanup_transport(&self, host: &str, transport_lock: &Arc<Mutex<HostTransportInner>>) {
        let (master, control_path, file) = {
            let mut guard = transport_lock.lock().await;
            (
                guard.master.take(),
                guard.control_path.clone(),
                guard.lock_file.take(),
            )
        };

        if let Some(MasterOwnership::Created(mut child)) = master {
            let guard = crate::pi_client::ProcessTreeGuard::new(&child);
            if let Ok(target) = ValidatedSshTarget::new(host) {
                let options = SshClientOptions::new(&self.inner.ssh_program, target)
                    .with_control_path(&control_path);
                let mut exit_cmd = options.exit_command(&control_path);
                isolate_process(&mut exit_cmd);
                if let Ok(mut exit_child) = exit_cmd.spawn() {
                    let exit_guard = crate::pi_client::ProcessTreeGuard::new(&exit_child);
                    let _ = timeout(Duration::from_secs(3), exit_child.wait()).await;
                    crate::pi_client::terminate_process(&mut exit_child).await;
                    exit_guard.disarm();
                }
            }
            crate::pi_client::terminate_process(&mut child).await;
            guard.disarm();
        }

        if let Some(file) = file {
            let _ = unlock_flock(&file);
        }
    }

    async fn run_catalog_job(&self, key: CatalogKey) {
        let tx = &self.inner.catalogs[&key];

        let host = key.host.as_deref().unwrap_or("");
        let mut prior_snapshot: Option<ModelCatalog> = None;
        let mut shutdown_rx = self.inner.shutdown_tx.subscribe();

        loop {
            if *shutdown_rx.borrow() {
                break;
            }

            let generation = tokio::select! {
                _ = shutdown_rx.changed() => break,
                res = self.await_transport_ready(host) => match res {
                    Ok(gen) => gen,
                    Err(reason) => {
                        if let Some(snapshot) = &prior_snapshot {
                            tx.send_replace(CatalogState::Ready {
                                snapshot: snapshot.clone(),
                                degraded_reason: Some(reason.clone()),
                            });
                        } else {
                            tx.send_replace(CatalogState::Unavailable { reason });
                        }
                        tokio::select! {
                            _ = shutdown_rx.changed() => break,
                            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                        }
                        continue;
                    }
                }
            };

            tx.send_replace(CatalogState::Refreshing {
                transport_generation: generation,
            });

            let client_opts = match self.client_for(host, generation) {
                Ok(opts) => opts,
                Err(e) => {
                    if let Some(snapshot) = &prior_snapshot {
                        tx.send_replace(CatalogState::Ready {
                            snapshot: snapshot.clone(),
                            degraded_reason: Some(e.clone()),
                        });
                    } else {
                        tx.send_replace(CatalogState::Unavailable { reason: e });
                    }
                    tokio::select! {
                        _ = shutdown_rx.changed() => break,
                        _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                    }
                    continue;
                }
            };

            let _permit = tokio::select! {
                _ = shutdown_rx.changed() => break,
                p = self.inner.ssh_semaphore.acquire() => match p {
                    Ok(p) => p,
                    Err(_) => break,
                }
            };

            let mut cmd = if host.is_empty() {
                let mut c = Command::new(&key.runtime);
                c.arg("--list-models");
                isolate_process(&mut c);
                c
            } else {
                let mut c = client_opts.remote_command(&format!(
                    "{} --list-models",
                    crate::pi_client::shell_quote(&key.runtime)
                ));
                isolate_process(&mut c);
                c
            };

            cmd.stdin(std::process::Stdio::null());
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());

            let output_res = match cmd.spawn() {
                Ok(mut child) => {
                    let guard = crate::pi_client::ProcessTreeGuard::new(&child);
                    let mut stdout_pipe = child.stdout.take();
                    let mut stderr_pipe = child.stderr.take();

                    let stdout_task = tokio::spawn(async move {
                        if let Some(pipe) = &mut stdout_pipe {
                            drain_bounded(pipe, STDOUT_LIMIT).await
                        } else {
                            String::new()
                        }
                    });

                    let stderr_task = tokio::spawn(async move {
                        if let Some(pipe) = &mut stderr_pipe {
                            drain_bounded(pipe, STDERR_LIMIT).await
                        } else {
                            String::new()
                        }
                    });

                    let wait_res = tokio::select! {
                        _ = shutdown_rx.changed() => {
                            crate::pi_client::terminate_process(&mut child).await;
                            guard.disarm();
                            Err("prewarm shutdown requested".to_string())
                        }
                        res = timeout(Duration::from_secs(15), child.wait()) => {
                            match res {
                                Ok(Ok(status)) => {
                                    guard.disarm();
                                    Ok(status)
                                }
                                Ok(Err(e)) => {
                                    crate::pi_client::terminate_process(&mut child).await;
                                    guard.disarm();
                                    Err(format!("catalog wait error: {e}"))
                                }
                                Err(_) => {
                                    crate::pi_client::terminate_process(&mut child).await;
                                    guard.disarm();
                                    Err("catalog command timed out".to_string())
                                }
                            }
                        }
                    };

                    let stdout = stdout_task.await.unwrap_or_default();
                    let stderr = stderr_task.await.unwrap_or_default();

                    match wait_res {
                        Ok(status) => Ok((status, stdout, stderr)),
                        Err(e) => Err(e),
                    }
                }
                Err(e) => Err(format!("catalog command failed to spawn: {e}")),
            };

            let retry_soon = match output_res {
                Ok((status, stdout, _stderr)) if status.success() => {
                    let catalog = ModelCatalog::parse(&stdout);
                    if catalog.entries.is_empty() {
                        let err_msg = "catalog returned no entries".to_string();
                        if let Some(snapshot) = &prior_snapshot {
                            tx.send_replace(CatalogState::Ready {
                                snapshot: snapshot.clone(),
                                degraded_reason: Some(err_msg),
                            });
                        } else {
                            tx.send_replace(CatalogState::Unavailable { reason: err_msg });
                        }
                        true
                    } else {
                        prior_snapshot = Some(catalog.clone());
                        tx.send_replace(CatalogState::Ready {
                            snapshot: catalog,
                            degraded_reason: None,
                        });
                        false
                    }
                }
                Ok((status, _stdout, stderr)) => {
                    let err_msg = format!("catalog command exited with {status}: {stderr}");
                    if let Some(snapshot) = &prior_snapshot {
                        tx.send_replace(CatalogState::Ready {
                            snapshot: snapshot.clone(),
                            degraded_reason: Some(err_msg),
                        });
                    } else {
                        tx.send_replace(CatalogState::Unavailable { reason: err_msg });
                    }
                    true
                }
                Err(err_msg) => {
                    if let Some(snapshot) = &prior_snapshot {
                        tx.send_replace(CatalogState::Ready {
                            snapshot: snapshot.clone(),
                            degraded_reason: Some(err_msg),
                        });
                    } else {
                        tx.send_replace(CatalogState::Unavailable { reason: err_msg });
                    }
                    true
                }
            };

            let delay = if retry_soon { 5 } else { 300 };
            tokio::select! {
                _ = shutdown_rx.changed() => break,
                _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
            }
        }
    }

    async fn run_artifact_job(&self, host: &str) {
        let tx = &self.inner.artifacts[host];
        let mut shutdown_rx = self.inner.shutdown_tx.subscribe();

        let source_file = match &self.inner.agent_extension_file {
            Some(path) => path.clone(),
            None => {
                tx.send_replace(ArtifactState::Sentinel {
                    reason: "no agent extension file configured".into(),
                });
                return;
            }
        };

        let source_bytes = match std::fs::read(&source_file) {
            Ok(bytes) => bytes,
            Err(e) => {
                tx.send_replace(ArtifactState::Sentinel {
                    reason: format!("could not read extension file {source_file:?}: {e}"),
                });
                return;
            }
        };

        let source_digest = format!("{:x}", Sha256::digest(&source_bytes));
        let filename = Path::new(&source_file)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("agent.ts");

        let mut prior_artifact: Option<(String, String)> = None;

        loop {
            if *shutdown_rx.borrow() {
                break;
            }

            let generation = tokio::select! {
                _ = shutdown_rx.changed() => break,
                res = self.await_transport_ready(host) => match res {
                    Ok(gen) => gen,
                    Err(reason) => {
                        if let Some((path, digest)) = &prior_artifact {
                            tx.send_replace(ArtifactState::Ready {
                                path: path.clone(),
                                digest: digest.clone(),
                                degraded_reason: Some(reason),
                            });
                        } else {
                            tx.send_replace(ArtifactState::Sentinel { reason });
                        }
                        tokio::select! {
                            _ = shutdown_rx.changed() => break,
                            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                        }
                        continue;
                    }
                }
            };

            tx.send_replace(ArtifactState::Refreshing {
                source_digest: source_digest.clone(),
                transport_generation: generation,
            });

            let client_opts = match self.client_for(host, generation) {
                Ok(opts) => opts,
                Err(e) => {
                    if let Some((path, digest)) = &prior_artifact {
                        tx.send_replace(ArtifactState::Ready {
                            path: path.clone(),
                            digest: digest.clone(),
                            degraded_reason: Some(e),
                        });
                    } else {
                        tx.send_replace(ArtifactState::Sentinel { reason: e });
                    }
                    tokio::select! {
                        _ = shutdown_rx.changed() => break,
                        _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                    }
                    continue;
                }
            };

            let nonce = crate::pbx::uuid_like();
            let configured_cache = self.inner.remote_cache_dir.trim_end_matches('/');
            let (cache_dir, fallback_path) = if configured_cache.starts_with('/') {
                let dir = format!("{configured_cache}/extensions");
                (
                    crate::pi_client::shell_quote(&dir),
                    format!("{dir}/{filename}"),
                )
            } else {
                let relative = if configured_cache.is_empty() {
                    ".cache/switchboard"
                } else {
                    configured_cache.trim_start_matches('/')
                };
                let dir = format!("{relative}/extensions");
                (
                    format!("\"$HOME\"/{}", crate::pi_client::shell_quote(&dir)),
                    format!("$HOME/{dir}/{filename}"),
                )
            };
            let fname_q = crate::pi_client::shell_quote(filename);
            let nonce_q = crate::pi_client::shell_quote(&nonce);
            let script = format!(
                "umask 077 && FN={fname_q} && NONCE={nonce_q} && CDIR={cache_dir} && mkdir -p \"$CDIR\" && \
                 TMP=\"$CDIR/.$FN.$NONCE.tmp\" && \
                 TARGET=\"$CDIR/$FN\" && \
                 MANIFEST=\"$CDIR/$FN.digest\" && \
                 LKG=\"$CDIR/$FN.lkg\" && \
                 LKG_MAN=\"$CDIR/$FN.digest.lkg\" && \
                 cat > \"$TMP\" && \
                 REM_DIGEST=$(sha256sum \"$TMP\" 2>/dev/null | awk '{{print $1}}') && \
                 if [ -z \"$REM_DIGEST\" ]; then REM_DIGEST=$(shasum -a 256 \"$TMP\" 2>/dev/null | awk '{{print $1}}'); fi && \
                 if [ \"$REM_DIGEST\" != \"{source_digest}\" ]; then rm -f \"$TMP\"; exit 2; fi && \
                 chmod 0600 \"$TMP\" && \
                 if [ -f \"$TARGET\" ]; then cp -f \"$TARGET\" \"$LKG\" 2>/dev/null || true; cp -f \"$MANIFEST\" \"$LKG_MAN\" 2>/dev/null || true; fi && \
                 printf '%s' \"$REM_DIGEST\" > \"$TMP.digest\" && \
                 chmod 0600 \"$TMP.digest\" && \
                 mv -f \"$TMP\" \"$TARGET\" && \
                 mv -f \"$TMP.digest\" \"$MANIFEST\" && \
                 printf '%s' \"$TARGET\""
            );

            let _permit = tokio::select! {
                _ = shutdown_rx.changed() => break,
                p = self.inner.ssh_semaphore.acquire() => match p {
                    Ok(p) => p,
                    Err(_) => break,
                }
            };

            let mut cmd = client_opts.remote_command(&script);
            cmd.stdin(std::process::Stdio::piped());
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            isolate_process(&mut cmd);

            let mut child = match cmd.spawn() {
                Ok(child) => child,
                Err(e) => {
                    let err = format!("staging spawn failed: {e}");
                    if let Some((path, digest)) = &prior_artifact {
                        tx.send_replace(ArtifactState::Ready {
                            path: path.clone(),
                            digest: digest.clone(),
                            degraded_reason: Some(err),
                        });
                    } else {
                        tx.send_replace(ArtifactState::Sentinel { reason: err });
                    }
                    break;
                }
            };

            let guard = crate::pi_client::ProcessTreeGuard::new(&child);

            let mut stdout_pipe = child.stdout.take();
            let mut stderr_pipe = child.stderr.take();

            let stdout_task = tokio::spawn(async move {
                if let Some(pipe) = &mut stdout_pipe {
                    drain_bounded(pipe, STDOUT_LIMIT).await
                } else {
                    String::new()
                }
            });

            let stderr_task = tokio::spawn(async move {
                if let Some(pipe) = &mut stderr_pipe {
                    drain_bounded(pipe, STDERR_LIMIT).await
                } else {
                    String::new()
                }
            });

            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt;
                let _ = stdin.write_all(&source_bytes).await;
            }

            let wait_res = tokio::select! {
                _ = shutdown_rx.changed() => {
                    crate::pi_client::terminate_process(&mut child).await;
                    guard.disarm();
                    break;
                }
                res = timeout(Duration::from_secs(15), child.wait()) => res
            };

            let stdout = stdout_task.await.unwrap_or_default();
            let stderr = stderr_task.await.unwrap_or_default();

            match wait_res {
                Ok(Ok(status)) if status.success() => {
                    guard.disarm();
                    let target_path = stdout.trim().to_string();
                    let target_path = if target_path.is_empty() {
                        fallback_path.clone()
                    } else {
                        target_path
                    };
                    prior_artifact = Some((target_path.clone(), source_digest.clone()));
                    tx.send_replace(ArtifactState::Ready {
                        path: target_path,
                        digest: source_digest.clone(),
                        degraded_reason: None,
                    });
                }
                Ok(Ok(status)) => {
                    crate::pi_client::terminate_process(&mut child).await;
                    guard.disarm();
                    let err = format!("staging remote script failed (exit {status}): {stderr}");
                    if let Some((path, digest)) = &prior_artifact {
                        tx.send_replace(ArtifactState::Ready {
                            path: path.clone(),
                            digest: digest.clone(),
                            degraded_reason: Some(err),
                        });
                    } else {
                        tx.send_replace(ArtifactState::Sentinel { reason: err });
                    }
                }
                Ok(Err(e)) => {
                    crate::pi_client::terminate_process(&mut child).await;
                    guard.disarm();
                    let err = format!("staging wait error: {e}");
                    if let Some((path, digest)) = &prior_artifact {
                        tx.send_replace(ArtifactState::Ready {
                            path: path.clone(),
                            digest: digest.clone(),
                            degraded_reason: Some(err),
                        });
                    } else {
                        tx.send_replace(ArtifactState::Sentinel { reason: err });
                    }
                }
                Err(_) => {
                    crate::pi_client::terminate_process(&mut child).await;
                    guard.disarm();
                    let err = "staging timed out".to_string();
                    if let Some((path, digest)) = &prior_artifact {
                        tx.send_replace(ArtifactState::Ready {
                            path: path.clone(),
                            digest: digest.clone(),
                            degraded_reason: Some(err),
                        });
                    } else {
                        tx.send_replace(ArtifactState::Sentinel { reason: err });
                    }
                }
            }

            let _ = &prior_artifact;
            break;
        }
    }

    async fn run_prepare_job(&self, project: Project) {
        let tx = &self.inner.prepares[&project.id];
        let mut shutdown_rx = self.inner.shutdown_tx.subscribe();

        let timestamp_unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        if project.prepare.trim().is_empty() {
            tx.send_replace(PrepareState::Settled {
                report: PrepareReport {
                    timestamp_unix_ms,
                    stdout: String::new(),
                    stderr: String::new(),
                    exit_code: Some(0),
                    duration_ms: 0,
                    source: PrepareSource::Startup,
                    outcome: PrepareOutcome::Success,
                },
            });
            return;
        }

        let host = project.canonical_host().unwrap_or("");
        let generation = tokio::select! {
            _ = shutdown_rx.changed() => return,
            res = self.await_transport_ready(host) => match res {
                Ok(gen) => gen,
                Err(reason) => {
                    tx.send_replace(PrepareState::InfrastructureFailed {
                        reason: format!("host transport unavailable: {reason}"),
                    });
                    return;
                }
            }
        };

        let cwd_sem = {
            let mut semaphores = self.inner.cwd_semaphores.lock().await;
            semaphores
                .entry((host.to_string(), project.cwd.clone()))
                .or_insert_with(|| Arc::new(Semaphore::new(1)))
                .clone()
        };

        let _cwd_permit = tokio::select! {
            _ = shutdown_rx.changed() => return,
            p = cwd_sem.acquire() => match p { Ok(p) => p, Err(_) => return },
        };
        let _prep_permit = tokio::select! {
            _ = shutdown_rx.changed() => return,
            p = self.inner.prepare_semaphore.acquire() => match p { Ok(p) => p, Err(_) => return },
        };

        tx.send_replace(PrepareState::Running);

        let start_time = Instant::now();

        let mut cmd = if host.is_empty() {
            let mut c = Command::new("sh");
            c.args(["-c", &project.prepare]);
            c.current_dir(&project.cwd);
            c
        } else {
            let client_opts = match self.client_for(host, generation) {
                Ok(opts) => opts,
                Err(e) => {
                    tx.send_replace(PrepareState::InfrastructureFailed {
                        reason: format!("client options unavailable: {e}"),
                    });
                    return;
                }
            };
            let remote = format!(
                "set -e; cd {}; {}",
                crate::pi_client::shell_quote(&project.cwd),
                project.prepare
            );
            client_opts.remote_command(&remote)
        };

        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        isolate_process(&mut cmd);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                tx.send_replace(PrepareState::InfrastructureFailed {
                    reason: format!("prepare spawn failed: {e}"),
                });
                return;
            }
        };

        let guard = crate::pi_client::ProcessTreeGuard::new(&child);

        let mut stdout_pipe = child.stdout.take();
        let mut stderr_pipe = child.stderr.take();

        let stdout_task = tokio::spawn(async move {
            if let Some(pipe) = &mut stdout_pipe {
                drain_bounded(pipe, STDOUT_LIMIT).await
            } else {
                String::new()
            }
        });

        let stderr_task = tokio::spawn(async move {
            if let Some(pipe) = &mut stderr_pipe {
                drain_bounded(pipe, STDERR_LIMIT).await
            } else {
                String::new()
            }
        });

        let wait_res = tokio::select! {
            _ = shutdown_rx.changed() => {
                crate::pi_client::terminate_process(&mut child).await;
                guard.disarm();
                tx.send_replace(PrepareState::InfrastructureFailed {
                    reason: "prewarm shutdown requested".into(),
                });
                return;
            }
            res = timeout(Duration::from_secs(PREPARE_TIMEOUT_SECS), child.wait()) => res
        };

        let duration_ms = start_time.elapsed().as_millis() as u64;

        let (outcome, exit_code) = match wait_res {
            Ok(Ok(status)) if status.success() => {
                guard.disarm();
                (PrepareOutcome::Success, status.code())
            }
            Ok(Ok(status)) => {
                guard.disarm();
                (PrepareOutcome::Nonzero, status.code())
            }
            Ok(Err(_)) => {
                crate::pi_client::terminate_process(&mut child).await;
                guard.disarm();
                (PrepareOutcome::Nonzero, None)
            }
            Err(_) => {
                crate::pi_client::terminate_process(&mut child).await;
                guard.disarm();
                (PrepareOutcome::TimedOut, None)
            }
        };

        let (stdout, stderr) = (
            stdout_task.await.unwrap_or_default(),
            stderr_task.await.unwrap_or_default(),
        );

        let report = PrepareReport {
            timestamp_unix_ms,
            stdout,
            stderr,
            exit_code,
            duration_ms,
            source: PrepareSource::Startup,
            outcome,
        };

        tx.send_replace(PrepareState::Settled { report });
    }

    pub async fn shutdown(&self) {
        let _ = self.inner.shutdown_tx.send_replace(true);
        for (host, transport_lock) in &self.inner.transports {
            self.cleanup_transport(host, transport_lock).await;
        }
    }
}

#[cfg(test)]
impl Prewarm {
    /// A prewarm whose startup work has already finished, with no jobs
    /// running: every host transport ready at generation 1, every catalog
    /// `catalog`, every prepare an empty success, and every staging host on
    /// the sentinel. Tests change one piece with the `settle_*` methods and
    /// then drive the PBX through the same reads production uses.
    pub(crate) fn settled(
        config: &crate::Config,
        registry: &Registry,
        catalog: ModelCatalog,
    ) -> Self {
        let prewarm = Self::register(config, registry);
        for (host, transport) in &prewarm.inner.transports {
            let control_path = transport.try_lock().unwrap().control_path.clone();
            prewarm.settle_transport(
                host,
                TransportState::Ready {
                    generation: 1,
                    control_path: Some(control_path),
                },
            );
        }
        for sender in prewarm.inner.catalogs.values() {
            sender.send_replace(CatalogState::Ready {
                snapshot: catalog.clone(),
                degraded_reason: None,
            });
        }
        for sender in prewarm.inner.prepares.values() {
            sender.send_replace(PrepareState::Settled {
                report: PrepareReport {
                    timestamp_unix_ms: 0,
                    stdout: String::new(),
                    stderr: String::new(),
                    exit_code: Some(0),
                    duration_ms: 0,
                    source: PrepareSource::Startup,
                    outcome: PrepareOutcome::Success,
                },
            });
        }
        for host in prewarm.inner.artifacts.keys() {
            prewarm.settle_artifact(
                host,
                ArtifactState::Sentinel {
                    reason: "not staged in this test".into(),
                },
            );
        }
        prewarm
    }

    pub(crate) fn settle_transport(&self, host: &str, state: TransportState) {
        self.inner.transports[host]
            .try_lock()
            .unwrap()
            .state_tx
            .send_replace(state);
    }

    pub(crate) fn settle_artifact(&self, host: &str, state: ArtifactState) {
        self.inner.artifacts[host].send_replace(state);
    }

    pub(crate) fn settle_catalog(&self, project: &Project, state: CatalogState) {
        self.inner.catalogs[&CatalogKey::for_project(project)].send_replace(state);
    }
}

#[cfg(test)]
#[path = "../tests/test_prewarm.rs"]
mod tests;

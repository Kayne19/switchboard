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
use tokio::sync::{watch, Mutex, RwLock, Semaphore};
use tokio::time::timeout;

const STDOUT_LIMIT: usize = 4096;
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
    NotRequired,
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
    Legacy,
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
    pub catalog: Option<ModelCatalog>,
    pub transport_generation: u64,
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
    _pi_binary: String,
    registry: Registry,

    transports: RwLock<HashMap<String, Arc<Mutex<HostTransportInner>>>>,
    transport_watchers: RwLock<HashMap<String, watch::Receiver<TransportState>>>,

    catalogs: RwLock<HashMap<CatalogKey, watch::Sender<CatalogState>>>,
    artifacts: RwLock<HashMap<String, watch::Sender<ArtifactState>>>,
    prepares: RwLock<HashMap<String, watch::Sender<PrepareState>>>,

    cwd_semaphores: Mutex<HashMap<(String, String), Arc<Semaphore>>>,
    ssh_semaphore: Arc<Semaphore>,
    prepare_semaphore: Arc<Semaphore>,

    shutdown_tx: watch::Sender<bool>,
}

#[derive(Clone)]
pub struct Prewarm {
    inner: Arc<PrewarmInner>,
}

fn host_hash(canonical_host: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(canonical_host.as_bytes());
    format!("{:x}", hasher.finalize())
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

async fn drain_bounded<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> std::io::Result<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let n = reader.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        if buf.len() < limit {
            let to_take = (limit - buf.len()).min(n);
            buf.extend_from_slice(&chunk[..to_take]);
        }
    }
    Ok(String::from_utf8_lossy(&buf).to_string())
}

impl Prewarm {
    pub async fn start(config: &crate::Config, registry: &Registry) -> Self {
        let (shutdown_tx, _) = watch::channel(false);

        let locks_dir = config.state_dir.join("ssh").join("locks");
        let control_dir = config.state_dir.join("ssh").join("control");
        let _ = ensure_private_dir(&locks_dir);
        let _ = ensure_private_dir(&control_dir);

        let inner = Arc::new(PrewarmInner {
            state_dir: config.state_dir.clone(),
            ssh_program: config.ssh_program.clone(),
            agent_extension_file: config.agent_extension.clone(),
            remote_cache_dir: config.remote_cache_dir.clone(),
            _pi_binary: config.pi_binary.clone(),
            registry: registry.clone(),

            transports: RwLock::new(HashMap::new()),
            transport_watchers: RwLock::new(HashMap::new()),

            catalogs: RwLock::new(HashMap::new()),
            artifacts: RwLock::new(HashMap::new()),
            prepares: RwLock::new(HashMap::new()),

            cwd_semaphores: Mutex::new(HashMap::new()),
            ssh_semaphore: Arc::new(Semaphore::new(10)),
            prepare_semaphore: Arc::new(Semaphore::new(5)),

            shutdown_tx,
        });

        let prewarm = Self { inner };
        prewarm.schedule_all().await;
        prewarm
    }

    pub fn client_for(&self, host: &str, generation: u64) -> Result<SshClientOptions, String> {
        let canonical = host.trim();
        if canonical.is_empty() {
            let target = ValidatedSshTarget::new("local@localhost")
                .unwrap_or_else(|_| ValidatedSshTarget::new("localhost").unwrap());
            return Ok(SshClientOptions::new(&self.inner.ssh_program, target));
        }

        let target = ValidatedSshTarget::new(canonical).map_err(|e| e.to_string())?;
        let watchers = self
            .inner
            .transport_watchers
            .try_read()
            .map_err(|_| format!("transport watchers lock busy for host {canonical:?}"))?;
        let watcher = watchers
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
        let catalog_key = CatalogKey::for_project(project);
        let catalog = self.await_catalog(&catalog_key, &project.model).await?;

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

    pub fn prepare_report(&self, project_id: &str) -> Option<PrepareReport> {
        let prepares = self.inner.prepares.try_read().ok()?;
        if let Some(rx) = prepares.get(project_id) {
            if let PrepareState::Settled { report } = rx.borrow().clone() {
                return Some(report);
            }
        }
        None
    }

    pub fn catalog_snapshot(&self, project: &Project) -> Option<ModelCatalog> {
        let catalog_key = CatalogKey::for_project(project);
        let catalogs = self.inner.catalogs.try_read().ok()?;
        if let Some(rx) = catalogs.get(&catalog_key) {
            if let CatalogState::Ready { snapshot, .. } = rx.borrow().clone() {
                return Some(snapshot);
            }
        }
        None
    }

    pub fn artifact_path(&self, host: &str) -> Option<String> {
        let canonical = host.trim();
        let artifacts = self.inner.artifacts.try_read().ok()?;
        if let Some(rx) = artifacts.get(canonical) {
            if let ArtifactState::Ready { path, .. } = rx.borrow().clone() {
                return Some(path);
            }
        }
        None
    }

    async fn await_transport_ready(&self, canonical_host: &str) -> Result<u64, String> {
        if canonical_host.is_empty() {
            return Ok(0);
        }

        let rx = {
            let watchers = self.inner.transport_watchers.read().await;
            watchers
                .get(canonical_host)
                .cloned()
                .ok_or_else(|| format!("no transport found for host {canonical_host:?}"))?
        };

        let mut rx = rx;
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
        let mut rx = {
            let prepares = self.inner.prepares.read().await;
            prepares
                .get(project_id)
                .map(|tx| tx.subscribe())
                .ok_or_else(|| format!("no prepare task found for project {project_id}"))?
        };

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

    async fn await_catalog(
        &self,
        key: &CatalogKey,
        requested_model: &Option<String>,
    ) -> Result<Option<ModelCatalog>, String> {
        let mut rx = {
            let catalogs = self.inner.catalogs.read().await;
            catalogs
                .get(key)
                .map(|tx| tx.subscribe())
                .ok_or_else(|| format!("no catalog task for key {:?}", key.to_key_string()))?
        };

        loop {
            let state = rx.borrow().clone();
            match state {
                CatalogState::Ready { snapshot, .. } => return Ok(Some(snapshot)),
                CatalogState::Unavailable { reason } => {
                    // Check if requested model contains slash (qualified name)
                    let is_qualified = requested_model
                        .as_deref()
                        .map(|m| m.contains('/'))
                        .unwrap_or(false);
                    if is_qualified {
                        return Ok(None);
                    }
                    return Err(format!(
                        "catalog unavailable for key {:?}: {reason}",
                        key.to_key_string()
                    ));
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
        let mut rx = {
            let artifacts = self.inner.artifacts.read().await;
            artifacts
                .get(canonical_host)
                .map(|tx| tx.subscribe())
                .ok_or_else(|| format!("no artifact task for host {canonical_host:?}"))?
        };

        loop {
            let state = rx.borrow().clone();
            match state {
                ArtifactState::Ready { path, .. } => return Ok(ArtifactDecision::Ready(path)),
                ArtifactState::Sentinel { reason } => {
                    return Ok(ArtifactDecision::Sentinel(reason))
                }
                ArtifactState::NotRequired => return Ok(ArtifactDecision::None),
                _ => {
                    if rx.changed().await.is_err() {
                        return Err(format!("artifact watch closed for host {canonical_host:?}"));
                    }
                }
            }
        }
    }

    async fn schedule_all(&self) {
        // Collect distinct canonical hosts
        let mut remote_hosts = std::collections::HashSet::new();
        let mut catalog_keys = std::collections::HashSet::new();
        let mut staging_hosts = std::collections::HashSet::new();

        for project in &self.inner.registry.projects {
            let host = project.canonical_host().unwrap_or("");
            if !host.is_empty() {
                remote_hosts.insert(host.to_string());
                if project.stage_extension {
                    staging_hosts.insert(host.to_string());
                }
            }
            catalog_keys.insert(CatalogKey::for_project(project));
        }

        // Initialize state channels
        for host in &remote_hosts {
            let (tx, rx) = watch::channel(TransportState::Pending);
            let control_path = self
                .inner
                .state_dir
                .join("ssh")
                .join("control")
                .join(format!("{}.sock", host_hash(host)));

            let inner_transport = HostTransportInner {
                state_tx: tx,
                lock_file: None,
                master: None,
                generation: 1,
                control_path,
            };
            self.inner
                .transports
                .write()
                .await
                .insert(host.clone(), Arc::new(Mutex::new(inner_transport)));
            self.inner
                .transport_watchers
                .write()
                .await
                .insert(host.clone(), rx);
        }

        for key in &catalog_keys {
            let (tx, _) = watch::channel(CatalogState::Pending);
            self.inner.catalogs.write().await.insert(key.clone(), tx);
        }

        for host in &staging_hosts {
            let (tx, _) = watch::channel(ArtifactState::Pending);
            self.inner.artifacts.write().await.insert(host.clone(), tx);
        }

        for project in &self.inner.registry.projects {
            let (tx, _) = watch::channel(PrepareState::Pending);
            self.inner
                .prepares
                .write()
                .await
                .insert(project.id.clone(), tx);
        }

        // Spawn transport managers for remote hosts
        for host in remote_hosts {
            let this = self.clone();
            tokio::spawn(async move {
                this.run_transport_manager(&host).await;
            });
        }

        // Spawn catalog prewarm tasks
        for key in catalog_keys {
            let this = self.clone();
            tokio::spawn(async move {
                this.run_catalog_job(key).await;
            });
        }

        // Spawn staging prewarm tasks
        for host in staging_hosts {
            let this = self.clone();
            tokio::spawn(async move {
                this.run_artifact_job(&host).await;
            });
        }

        // Spawn prepare tasks
        for project in self.inner.registry.projects.clone() {
            let this = self.clone();
            tokio::spawn(async move {
                this.run_prepare_job(project).await;
            });
        }
    }

    async fn run_transport_manager(&self, host: &str) {
        let lock_path = self
            .inner
            .state_dir
            .join("ssh")
            .join("locks")
            .join(format!("{}.lock", host_hash(host)));

        let transport_lock = {
            let transports = self.inner.transports.read().await;
            transports.get(host).cloned().unwrap()
        };

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
        let tx = {
            let catalogs = self.inner.catalogs.read().await;
            catalogs.get(&key).cloned().unwrap()
        };

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

            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());

            let output_res = match cmd.spawn() {
                Ok(mut child) => {
                    let guard = crate::pi_client::ProcessTreeGuard::new(&child);
                    let mut stdout_pipe = child.stdout.take();
                    let mut stderr_pipe = child.stderr.take();

                    let stdout_task = tokio::spawn(async move {
                        if let Some(pipe) = &mut stdout_pipe {
                            drain_bounded(pipe, STDOUT_LIMIT).await.unwrap_or_default()
                        } else {
                            String::new()
                        }
                    });

                    let stderr_task = tokio::spawn(async move {
                        if let Some(pipe) = &mut stderr_pipe {
                            drain_bounded(pipe, STDERR_LIMIT).await.unwrap_or_default()
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

            match output_res {
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
                    } else {
                        prior_snapshot = Some(catalog.clone());
                        tx.send_replace(CatalogState::Ready {
                            snapshot: catalog,
                            degraded_reason: None,
                        });
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
                }
            }

            tokio::select! {
                _ = shutdown_rx.changed() => break,
                _ = tokio::time::sleep(Duration::from_secs(300)) => {}
            }
        }
    }

    async fn run_artifact_job(&self, host: &str) {
        let tx = {
            let artifacts = self.inner.artifacts.read().await;
            artifacts.get(host).cloned().unwrap()
        };
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
                    drain_bounded(pipe, STDOUT_LIMIT).await.unwrap_or_default()
                } else {
                    String::new()
                }
            });

            let stderr_task = tokio::spawn(async move {
                if let Some(pipe) = &mut stderr_pipe {
                    drain_bounded(pipe, STDERR_LIMIT).await.unwrap_or_default()
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
        let tx = {
            let prepares = self.inner.prepares.read().await;
            prepares.get(&project.id).cloned().unwrap()
        };
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
                drain_bounded(pipe, STDOUT_LIMIT).await.unwrap_or_default()
            } else {
                String::new()
            }
        });

        let stderr_task = tokio::spawn(async move {
            if let Some(pipe) = &mut stderr_pipe {
                drain_bounded(pipe, STDERR_LIMIT).await.unwrap_or_default()
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
        let transports = self.inner.transports.read().await;
        for (host, transport_lock) in transports.iter() {
            self.cleanup_transport(host, transport_lock).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pi_client::write_executable_script;

    fn uuid_like_test() -> String {
        format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    fn test_config(root: &Path) -> crate::Config {
        crate::Config {
            env_file: root.join("env"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
            projects_file: root.join("projects.json"),
            operator_prompt: root.join("prompt.md"),
            operator_extension: None,
            agent_extension: None,
            persona: "".into(),
            stt_command: None,
            stt_stream_command: None,
            bind: "127.0.0.1:0".into(),
            pi_binary: "pi".into(),
            ssh_program: "ssh".into(),
            operator_model: None,
            agent_model: None,
            agent_thinking: "medium".into(),
            remote_cache_dir: ".cache/switchboard".into(),
            model_swaps: true,
            speak_url: "".into(),
            state_url: "".into(),
            diagram_url: "".into(),
            self_url: "".into(),
            idle_timeout: 300.0,
            idle_poll: 10.0,
            max_spoken_chars: 1000,
            speech_deadline_ms: 25000,
            history_limit: 100,
            session: "test-session".into(),
            environment: HashMap::new(),
        }
    }

    fn fake_pi_script(root: &Path) -> PathBuf {
        let runtime = root.join("fake-pi");
        write_executable_script(
            &runtime,
            "printf 'provider model alias default thinks\\ncustom pi-model pi-model yes yes\\n'",
        );
        runtime
    }

    fn fake_ssh_script(root: &Path) -> PathBuf {
        let ssh = root.join("fake-ssh");
        write_executable_script(
            &ssh,
            r#"for arg in "$@"; do
    if [ "$arg" = "-O" ] || [ "$arg" = "check" ] || [ "$arg" = "exit" ]; then
        exit 0
    fi
done
exit 0
"#,
        );
        ssh
    }

    #[tokio::test]
    async fn local_catalog_and_prepare_prewarm() {
        let root = std::env::temp_dir().join(format!(
            "switchboard-test-prewarm-local-{}",
            uuid_like_test()
        ));
        let _ = std::fs::create_dir_all(&root);

        let runtime = fake_pi_script(&root);

        let project = Project {
            id: "local-proj".into(),
            description: "test".into(),
            aliases: vec![],
            host: None,
            cwd: root.to_string_lossy().into_owned(),
            runtime: runtime.to_string_lossy().into_owned(),
            model: None,
            stage_extension: false,
            extra_args: vec![],
            prepare: "echo prepare_done".into(),
        };

        let registry = Registry::new(vec![project.clone()]);
        let mut config = test_config(&root);
        config.pi_binary = runtime.to_string_lossy().into_owned();

        let prewarm = Prewarm::start(&config, &registry).await;

        let readiness = prewarm
            .await_project(&project)
            .await
            .expect("project readiness");
        assert_eq!(readiness.transport_generation, 0);

        let prep = readiness.prepare_report.expect("prepare report");
        assert_eq!(prep.outcome, PrepareOutcome::Success);
        assert!(prep.stdout.contains("prepare_done"));

        let cat = readiness.catalog.expect("catalog");
        assert!(cat.available);
        assert_eq!(cat.entries.len(), 1);

        prewarm.shutdown().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn host_deduplication_and_canonicalization() {
        let root = std::env::temp_dir().join(format!(
            "switchboard-test-prewarm-dedup-{}",
            uuid_like_test()
        ));
        let _ = std::fs::create_dir_all(&root);

        let proj1 = Project {
            id: "p1".into(),
            description: "".into(),
            aliases: vec![],
            host: Some(" host.example.com ".into()),
            cwd: "/tmp".into(),
            runtime: "pi".into(),
            model: None,
            stage_extension: false,
            extra_args: vec![],
            prepare: "".into(),
        };
        let proj2 = Project {
            id: "p2".into(),
            description: "".into(),
            aliases: vec![],
            host: Some("host.example.com".into()),
            cwd: "/tmp".into(),
            runtime: "pi".into(),
            model: None,
            stage_extension: false,
            extra_args: vec![],
            prepare: "".into(),
        };

        let registry = Registry::new(vec![proj1, proj2]);
        let ssh = fake_ssh_script(&root);
        let mut config = test_config(&root);
        config.ssh_program = ssh.to_string_lossy().into_owned();

        let prewarm = Prewarm::start(&config, &registry).await;
        assert_eq!(prewarm.inner.transports.read().await.len(), 1);
        assert!(prewarm
            .inner
            .transports
            .read()
            .await
            .contains_key("host.example.com"));

        prewarm.shutdown().await;
        let _ = std::fs::remove_dir_all(root);
    }

    fn fake_failing_ssh_script(root: &Path) -> PathBuf {
        let ssh = root.join("fake-failing-ssh");
        write_executable_script(&ssh, "exit 1\n");
        ssh
    }

    #[tokio::test]
    async fn remote_transport_degraded_on_ssh_failure_returns_error_to_await_project() {
        let root = std::env::temp_dir().join(format!(
            "switchboard-test-prewarm-degraded-{}",
            uuid_like_test()
        ));
        let _ = std::fs::create_dir_all(&root);

        let proj = Project {
            id: "p1".into(),
            description: "".into(),
            aliases: vec![],
            host: Some("remote.example.com".into()),
            cwd: "/tmp".into(),
            runtime: "pi".into(),
            model: None,
            stage_extension: false,
            extra_args: vec![],
            prepare: "".into(),
        };

        let registry = Registry::new(vec![proj.clone()]);
        let ssh = fake_failing_ssh_script(&root);
        let mut config = test_config(&root);
        config.ssh_program = ssh.to_string_lossy().into_owned();

        let prewarm = Prewarm::start(&config, &registry).await;

        let res = timeout(Duration::from_secs(5), prewarm.await_project(&proj)).await;
        assert!(
            res.is_ok(),
            "await_project should return within timeout, not hang"
        );
        let readiness_res = res.unwrap();
        assert!(
            readiness_res.is_err(),
            "should return readiness error on degraded transport"
        );
        let err = readiness_res.unwrap_err();
        assert!(
            err.contains("transport degraded"),
            "error should mention transport degraded: {err}"
        );

        prewarm.shutdown().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn failed_prepare_is_terminal_and_launchable() {
        let root = std::env::temp_dir().join(format!(
            "switchboard-test-prewarm-failprep-{}",
            uuid_like_test()
        ));
        let _ = std::fs::create_dir_all(&root);

        let runtime = fake_pi_script(&root);

        let project = Project {
            id: "fail-prep".into(),
            description: "test".into(),
            aliases: vec![],
            host: None,
            cwd: root.to_string_lossy().into_owned(),
            runtime: runtime.to_string_lossy().into_owned(),
            model: Some("anthropic/claude-3-5-sonnet".into()),
            stage_extension: false,
            extra_args: vec![],
            prepare: "echo error_out >&2; exit 42".into(),
        };

        let registry = Registry::new(vec![project.clone()]);
        let mut config = test_config(&root);
        config.pi_binary = runtime.to_string_lossy().into_owned();

        let prewarm = Prewarm::start(&config, &registry).await;
        let readiness = prewarm
            .await_project(&project)
            .await
            .expect("project readiness");

        let prep = readiness.prepare_report.expect("prepare report");
        assert_eq!(prep.outcome, PrepareOutcome::Nonzero);
        assert_eq!(prep.exit_code, Some(42));
        assert!(prep.stderr.contains("error_out"));

        prewarm.shutdown().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn startup_returns_before_delayed_work() {
        let root = std::env::temp_dir().join(format!(
            "switchboard-test-prewarm-async-start-{}",
            uuid_like_test()
        ));
        let _ = std::fs::create_dir_all(&root);

        let runtime = fake_pi_script(&root);

        let project = Project {
            id: "slow-prep".into(),
            description: "test".into(),
            aliases: vec![],
            host: None,
            cwd: root.to_string_lossy().into_owned(),
            runtime: runtime.to_string_lossy().into_owned(),
            model: None,
            stage_extension: false,
            extra_args: vec![],
            prepare: "sleep 0.5".into(),
        };

        let registry = Registry::new(vec![project.clone()]);
        let mut config = test_config(&root);
        config.pi_binary = runtime.to_string_lossy().into_owned();

        let start_time = Instant::now();
        let prewarm = Prewarm::start(&config, &registry).await;
        let elapsed = start_time.elapsed();

        assert!(elapsed < Duration::from_millis(150));

        let readiness = prewarm.await_project(&project).await.unwrap();
        assert_eq!(
            readiness.prepare_report.unwrap().outcome,
            PrepareOutcome::Success
        );

        prewarm.shutdown().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn transport_generation_mismatch_and_reconnect() {
        let root = std::env::temp_dir().join(format!(
            "switchboard-test-prewarm-gen-mismatch-{}",
            uuid_like_test()
        ));
        let _ = std::fs::create_dir_all(&root);

        let proj = Project {
            id: "p1".into(),
            description: "".into(),
            aliases: vec![],
            host: Some("remote.example.com".into()),
            cwd: "/tmp".into(),
            runtime: "pi".into(),
            model: None,
            stage_extension: false,
            extra_args: vec![],
            prepare: "".into(),
        };

        let registry = Registry::new(vec![proj]);
        let ssh = fake_ssh_script(&root);
        let mut config = test_config(&root);
        config.ssh_program = ssh.to_string_lossy().into_owned();

        let prewarm = Prewarm::start(&config, &registry).await;

        let transport_lock = prewarm
            .inner
            .transports
            .read()
            .await
            .get("remote.example.com")
            .cloned()
            .unwrap();
        {
            let guard = transport_lock.lock().await;
            guard.state_tx.send_replace(TransportState::Ready {
                generation: 1,
                control_path: Some(guard.control_path.clone()),
            });
        }

        let client_res = prewarm.client_for("remote.example.com", 1);
        assert!(client_res.is_ok());

        let stale_res = prewarm.client_for("remote.example.com", 2);
        assert!(stale_res.is_err());
        assert!(stale_res
            .unwrap_err()
            .contains("transport generation mismatch"));

        {
            let mut guard = transport_lock.lock().await;
            guard.generation = 2;
            guard.state_tx.send_replace(TransportState::Ready {
                generation: 2,
                control_path: Some(guard.control_path.clone()),
            });
        }

        let old_gen_res = prewarm.client_for("remote.example.com", 1);
        assert!(old_gen_res.is_err());

        let new_gen_res = prewarm.client_for("remote.example.com", 2);
        assert!(new_gen_res.is_ok());

        prewarm.shutdown().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn injected_ssh_program_in_prewarm() {
        let root = std::env::temp_dir().join(format!(
            "switchboard-test-injected-ssh-{}",
            uuid_like_test()
        ));
        let _ = std::fs::create_dir_all(&root);

        let custom_ssh = fake_ssh_script(&root);

        let proj = Project {
            id: "p1".into(),
            description: "".into(),
            aliases: vec![],
            host: Some("remote.example.com".into()),
            cwd: "/tmp".into(),
            runtime: "pi".into(),
            model: None,
            stage_extension: false,
            extra_args: vec![],
            prepare: "".into(),
        };

        let registry = Registry::new(vec![proj]);
        let mut config = test_config(&root);
        config.ssh_program = custom_ssh.to_string_lossy().into_owned();

        let prewarm = Prewarm::start(&config, &registry).await;

        let transport_lock = prewarm
            .inner
            .transports
            .read()
            .await
            .get("remote.example.com")
            .cloned()
            .unwrap();
        {
            let guard = transport_lock.lock().await;
            guard.state_tx.send_replace(TransportState::Ready {
                generation: 1,
                control_path: Some(guard.control_path.clone()),
            });
        }

        let opts = prewarm.client_for("remote.example.com", 1).unwrap();
        assert_eq!(opts.ssh_program, custom_ssh.to_string_lossy());
        let base_args = opts.base_args();
        assert!(base_args.contains(&"ControlMaster=no".into()));

        prewarm.shutdown().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn prepare_caching_nonzero_exit_not_retried() {
        let root = std::env::temp_dir().join(format!(
            "switchboard-test-prepare-cached-{}",
            uuid_like_test()
        ));
        let _ = std::fs::create_dir_all(&root);

        let runtime = fake_pi_script(&root);

        let counter_file = root.join("prep_counter.txt");
        let prep_script = format!(
            "count=0\nif [ -f {} ]; then count=$(cat {}); fi\nprintf '%s' \"$((count + 1))\" > {}\nprintf 'failed output\\n' >&2\nexit 5\n",
            crate::pi_client::shell_quote(&counter_file.to_string_lossy()),
            crate::pi_client::shell_quote(&counter_file.to_string_lossy()),
            crate::pi_client::shell_quote(&counter_file.to_string_lossy()),
        );

        let project = Project {
            id: "counter-prep".into(),
            description: "test".into(),
            aliases: vec![],
            host: None,
            cwd: root.to_string_lossy().into_owned(),
            runtime: runtime.to_string_lossy().into_owned(),
            model: None,
            stage_extension: false,
            extra_args: vec![],
            prepare: prep_script,
        };

        let registry = Registry::new(vec![project.clone()]);
        let mut config = test_config(&root);
        config.pi_binary = runtime.to_string_lossy().into_owned();

        let prewarm = Prewarm::start(&config, &registry).await;

        let r1 = prewarm.await_project(&project).await.unwrap();
        let prep1 = r1.prepare_report.unwrap();
        assert_eq!(prep1.outcome, PrepareOutcome::Nonzero);
        assert_eq!(prep1.exit_code, Some(5));
        assert!(prep1.stderr.contains("failed output"));
        assert_eq!(std::fs::read_to_string(&counter_file).unwrap(), "1");

        let r2 = prewarm.await_project(&project).await.unwrap();
        let prep2 = r2.prepare_report.unwrap();
        assert_eq!(prep2, prep1);
        assert_eq!(std::fs::read_to_string(&counter_file).unwrap(), "1");

        prewarm.shutdown().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn no_duplicate_prewarm_work_on_concurrent_or_late_transfers() {
        let root = std::env::temp_dir().join(format!(
            "switchboard-test-no-dup-prewarm-{}",
            uuid_like_test()
        ));
        let _ = std::fs::create_dir_all(&root);

        let runtime = fake_pi_script(&root);

        let counter_file = root.join("prep_count.txt");
        let prep_script = format!(
            "count=0\nif [ -f {} ]; then count=$(cat {}); fi\nprintf '%s' \"$((count + 1))\" > {}\nsleep 0.2\n",
            crate::pi_client::shell_quote(&counter_file.to_string_lossy()),
            crate::pi_client::shell_quote(&counter_file.to_string_lossy()),
            crate::pi_client::shell_quote(&counter_file.to_string_lossy()),
        );

        let project = Project {
            id: "shared-prep".into(),
            description: "test".into(),
            aliases: vec![],
            host: None,
            cwd: root.to_string_lossy().into_owned(),
            runtime: runtime.to_string_lossy().into_owned(),
            model: None,
            stage_extension: false,
            extra_args: vec![],
            prepare: prep_script,
        };

        let registry = Registry::new(vec![project.clone()]);
        let mut config = test_config(&root);
        config.pi_binary = runtime.to_string_lossy().into_owned();

        let prewarm = Prewarm::start(&config, &registry).await;

        let p_clone1 = project.clone();
        let p_clone2 = project.clone();
        let pre1 = prewarm.clone();
        let pre2 = prewarm.clone();

        let task1 = tokio::spawn(async move { pre1.await_project(&p_clone1).await });
        let task2 = tokio::spawn(async move { pre2.await_project(&p_clone2).await });

        let (res1, res2) = tokio::join!(task1, task2);
        assert_eq!(
            res1.unwrap().unwrap().prepare_report.unwrap().outcome,
            PrepareOutcome::Success
        );
        assert_eq!(
            res2.unwrap().unwrap().prepare_report.unwrap().outcome,
            PrepareOutcome::Success
        );

        assert_eq!(std::fs::read_to_string(&counter_file).unwrap(), "1");

        tokio::time::sleep(Duration::from_millis(100)).await;
        let res3 = prewarm.await_project(&project).await.unwrap();
        assert_eq!(
            res3.prepare_report.unwrap().outcome,
            PrepareOutcome::Success
        );
        assert_eq!(std::fs::read_to_string(&counter_file).unwrap(), "1");

        prewarm.shutdown().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn prepare_shutdown_reaps_child_process() {
        let root = std::env::temp_dir().join(format!(
            "switchboard-test-prep-shutdown-{}",
            uuid_like_test()
        ));
        let _ = std::fs::create_dir_all(&root);

        let runtime = fake_pi_script(&root);
        let pid_file = root.join("prep.pid");
        let hanging_script = format!(
            "echo $$ > {}\nsleep 300\n",
            crate::pi_client::shell_quote(&pid_file.to_string_lossy())
        );
        let project = Project {
            id: "hang-prep".into(),
            description: "test".into(),
            aliases: vec![],
            host: None,
            cwd: root.to_string_lossy().into_owned(),
            runtime: runtime.to_string_lossy().into_owned(),
            model: None,
            stage_extension: false,
            extra_args: vec![],
            prepare: hanging_script,
        };

        let registry = Registry::new(vec![project]);
        let mut config = test_config(&root);
        config.pi_binary = runtime.to_string_lossy().into_owned();
        let prewarm = Prewarm::start(&config, &registry).await;

        for _ in 0..100 {
            if pid_file.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(pid_file.exists(), "prepare child did not start");
        let pid: i32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();

        prewarm.shutdown().await;

        #[cfg(unix)]
        {
            for _ in 0..100 {
                if unsafe { libc::kill(pid, 0) != 0 } {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(
                unsafe { libc::kill(pid, 0) != 0 },
                "prepare child should be killed and reaped during shutdown"
            );
        }

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn stage_extension_opt_out() {
        let root = std::env::temp_dir().join(format!(
            "switchboard-test-stage-opt-out-{}",
            uuid_like_test()
        ));
        let _ = std::fs::create_dir_all(&root);

        let ext_file = root.join("agent.ts");
        std::fs::write(&ext_file, "console.log('hi');").unwrap();

        let ssh = fake_ssh_script(&root);

        let project = Project {
            id: "no-stage".into(),
            description: "test".into(),
            aliases: vec![],
            host: Some("remote.example.com".into()),
            cwd: "/tmp".into(),
            runtime: "pi".into(),
            model: Some("anthropic/claude-3-5-sonnet".into()),
            stage_extension: false,
            extra_args: vec![],
            prepare: "".into(),
        };

        let registry = Registry::new(vec![project.clone()]);
        let mut config = test_config(&root);
        config.ssh_program = ssh.to_string_lossy().into_owned();
        config.agent_extension = Some(ext_file.to_string_lossy().into_owned());

        let prewarm = Prewarm::start(&config, &registry).await;

        let readiness = prewarm.await_project(&project).await.unwrap();
        assert!(matches!(
            readiness.artifact_decision,
            ArtifactDecision::None
        ));

        prewarm.shutdown().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn digest_mismatch_and_lkg_retention() {
        let root =
            std::env::temp_dir().join(format!("switchboard-test-digest-lkg-{}", uuid_like_test()));
        let _ = std::fs::create_dir_all(&root);

        let cdir = root.join("extensions");
        std::fs::create_dir_all(&cdir).unwrap();

        let filename = "agent.ts";
        let target = cdir.join(filename);
        let manifest = cdir.join("agent.ts.digest");

        std::fs::write(&target, "LKG extension content").unwrap();
        std::fs::write(&manifest, "old-digest").unwrap();

        let expected_digest = "0000000000000000000000000000000000000000000000000000000000000000";
        let nonce = "test-nonce";

        let script = format!(
            "umask 077 && CDIR=\"{}\" && mkdir -p \"$CDIR\" && \
             TMP=\"$CDIR/.{filename}.{nonce}.tmp\" && \
             TARGET=\"$CDIR/{filename}\" && \
             MANIFEST=\"$CDIR/{filename}.digest\" && \
             LKG=\"$CDIR/{filename}.lkg\" && \
             LKG_MAN=\"$CDIR/{filename}.digest.lkg\" && \
             cat > \"$TMP\" && \
             REM_DIGEST=$(sha256sum \"$TMP\" 2>/dev/null | awk '{{print $1}}') && \
             if [ -z \"$REM_DIGEST\" ]; then REM_DIGEST=$(shasum -a 256 \"$TMP\" 2>/dev/null | awk '{{print $1}}'); fi && \
             if [ \"$REM_DIGEST\" != \"{expected_digest}\" ]; then rm -f \"$TMP\"; exit 2; fi && \
             chmod 0600 \"$TMP\" && \
             if [ -f \"$TARGET\" ]; then cp -f \"$TARGET\" \"$LKG\" 2>/dev/null || true; cp -f \"$MANIFEST\" \"$LKG_MAN\" 2>/dev/null || true; fi && \
             printf '%s' \"$REM_DIGEST\" > \"$TMP.digest\" && \
             chmod 0600 \"$TMP.digest\" && \
             mv -f \"$TMP\" \"$TARGET\" && \
             mv -f \"$TMP.digest\" \"$MANIFEST\" && \
             printf '%s' \"$TARGET\"",
            cdir.to_string_lossy()
        );

        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(&script)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();

        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(b"corrupted payload").await;
        }

        let out = child.wait_with_output().await.unwrap();
        assert_eq!(out.status.code(), Some(2));
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "LKG extension content"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn unsafe_filename_shell_quoting() {
        let root =
            std::env::temp_dir().join(format!("switchboard-test-unsafe-fn-{}", uuid_like_test()));
        let _ = std::fs::create_dir_all(&root);
        let cdir = root.join("extensions");
        std::fs::create_dir_all(&cdir).unwrap();

        let unsafe_filename = "agent;touch-bad.ts";
        let payload = b"test payload";
        let source_digest = format!("{:x}", Sha256::digest(payload));

        let cache_dir_q = crate::pi_client::shell_quote(&cdir.to_string_lossy());
        let fname_q = crate::pi_client::shell_quote(unsafe_filename);
        let nonce_q = crate::pi_client::shell_quote("nonce-123");

        let script = format!(
            "umask 077 && FN={fname_q} && NONCE={nonce_q} && CDIR={cache_dir_q} && mkdir -p \"$CDIR\" && \
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

        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(&script)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();

        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(payload).await;
        }

        let out = child.wait_with_output().await.unwrap();
        assert!(out.status.success());
        let target_file = cdir.join(unsafe_filename);
        assert!(target_file.is_file());
        assert_eq!(std::fs::read(&target_file).unwrap(), payload);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn bounded_shutdown() {
        let root = std::env::temp_dir().join(format!(
            "switchboard-test-bounded-shutdown-{}",
            uuid_like_test()
        ));
        let _ = std::fs::create_dir_all(&root);

        let proj = Project {
            id: "p1".into(),
            description: "".into(),
            aliases: vec![],
            host: Some("remote.example.com".into()),
            cwd: "/tmp".into(),
            runtime: "pi".into(),
            model: None,
            stage_extension: false,
            extra_args: vec![],
            prepare: "".into(),
        };

        let registry = Registry::new(vec![proj]);
        let ssh = fake_ssh_script(&root);
        let mut config = test_config(&root);
        config.ssh_program = ssh.to_string_lossy().into_owned();

        let prewarm = Prewarm::start(&config, &registry).await;

        let start = Instant::now();
        prewarm.shutdown().await;
        let elapsed = start.elapsed();

        assert!(elapsed < Duration::from_secs(1));

        let _ = std::fs::remove_dir_all(root);
    }
}

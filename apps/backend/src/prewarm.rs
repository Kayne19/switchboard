//! Startup work for project legs, owned in one place: each host's model
//! catalog and each project's prepare command. Both run through the project's
//! host agent (`docs/host-link.md`) as soon as its link is up, so a transfer
//! or a model change does no setup of its own; it waits on what is here.
use crate::hosts::{CommandError, Hosts};
use crate::models::ModelCatalog;
use crate::registry::{Project, Registry};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

/// How long a project's prepare command may run on its host.
const PREPARE_TIMEOUT: Duration = Duration::from_secs(120);
/// How long past `PREPARE_TIMEOUT` the host agent has to report the result.
const PREPARE_REPORT_GRACE: Duration = Duration::from_secs(30);
/// How long a host has to list its models.
const LIST_MODELS_WAIT: Duration = Duration::from_secs(30);
/// How soon a failed listing is tried again, and how often a good one is
/// refreshed.
const CATALOG_RETRY: Duration = Duration::from_secs(5);
const CATALOG_REFRESH: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CatalogState {
    /// Not listed yet: the host has not been connected since startup.
    Pending,
    Ready {
        snapshot: ModelCatalog,
        /// Why the last refresh failed, while an older listing is kept.
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

/// Everything a project leg launches with, all of it settled by startup work,
/// so a transfer or model change does no setup of its own.
#[derive(Clone, Debug)]
pub struct LaunchPlan {
    pub prepare_report: Option<PrepareReport>,
    /// The host's catalog; `available: false` when listing failed. Whether a
    /// requested model can still be used is `ModelCatalog::resolve`'s call.
    pub catalog: ModelCatalog,
    /// The host agent the leg runs on.
    pub host: String,
}

struct PrewarmInner {
    hosts: Hosts,
    registry: Registry,
    // One entry per host and per project in the registry, created at
    // construction and never added to afterwards; each state lives in its
    // channel.
    catalogs: HashMap<String, watch::Sender<CatalogState>>,
    prepares: HashMap<String, watch::Sender<PrepareState>>,
    shutdown_tx: watch::Sender<bool>,
}

#[derive(Clone)]
pub struct Prewarm {
    inner: Arc<PrewarmInner>,
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// A host agent's `run_prepare` result as a report.
fn prepare_report(result: &Value, timestamp_unix_ms: u64) -> PrepareReport {
    let outcome = match result["outcome"].as_str() {
        Some("succeeded") => PrepareOutcome::Success,
        Some("timed_out") => PrepareOutcome::TimedOut,
        _ => PrepareOutcome::Nonzero,
    };
    PrepareReport {
        timestamp_unix_ms,
        stdout: result["stdout"].as_str().unwrap_or_default().to_owned(),
        stderr: result["stderr"].as_str().unwrap_or_default().to_owned(),
        exit_code: result["exit_code"]
            .as_i64()
            .and_then(|code| i32::try_from(code).ok()),
        duration_ms: result["duration_ms"].as_u64().unwrap_or_default(),
        source: PrepareSource::Startup,
        outcome,
    }
}

/// The link went away under a command: worth trying again on the next one.
fn link_gone(error: &CommandError) -> bool {
    matches!(error.code.as_str(), "not_connected" | "link_lost")
}

impl Prewarm {
    /// Registers every piece of startup work the registry needs and starts
    /// it in the background. Must be called inside the Tokio runtime.
    pub fn start(registry: &Registry, hosts: Hosts) -> Self {
        let prewarm = Self::register(registry, hosts);
        prewarm.spawn_jobs();
        prewarm
    }

    /// A state channel for every host and project in the registry, all
    /// `Pending`, with no work started.
    fn register(registry: &Registry, hosts: Hosts) -> Self {
        let (shutdown_tx, _) = watch::channel(false);
        let mut catalogs = HashMap::new();
        let mut prepares = HashMap::new();
        for project in &registry.projects {
            if let Some(host) = project.canonical_host() {
                catalogs
                    .entry(host.to_owned())
                    .or_insert_with(|| watch::channel(CatalogState::Pending).0);
            }
            prepares.insert(project.id.clone(), watch::channel(PrepareState::Pending).0);
        }
        Self {
            inner: Arc::new(PrewarmInner {
                hosts,
                registry: registry.clone(),
                catalogs,
                prepares,
                shutdown_tx,
            }),
        }
    }

    fn spawn_jobs(&self) {
        for host in self.inner.catalogs.keys() {
            let (this, host) = (self.clone(), host.clone());
            tokio::spawn(async move { this.run_catalog_job(&host).await });
        }
        for project in &self.inner.registry.projects {
            let (this, project) = (self.clone(), project.clone());
            tokio::spawn(async move { this.run_prepare_job(project).await });
        }
    }

    /// Waits for the project's startup work and turns it into what the leg
    /// launches with. Errors name the piece of setup that is not usable; a
    /// host that is not connected is one, with no other way to reach it.
    pub async fn launch_plan(&self, project: &Project) -> Result<LaunchPlan, String> {
        if !project.is_remote() {
            return Err(format!(
                "{} has no host in the project registry",
                project.id
            ));
        }
        let host = project.canonical_host().unwrap_or_default();
        if self.inner.hosts.link_epoch(host).is_none() {
            return Err(format!("its host {host} is not connected"));
        }
        let prepare_report = self.await_prepare_settled(project, host).await?;
        let catalog = self.await_catalog(host).await?;
        Ok(LaunchPlan {
            prepare_report,
            catalog,
            host: host.to_owned(),
        })
    }

    /// Waits until `settled` says what `state` has come to, while `host`
    /// stays connected.
    async fn settle<S, T>(
        &self,
        host: &str,
        mut state: watch::Receiver<S>,
        settled: impl Fn(&S) -> Option<Result<T, String>>,
    ) -> Result<T, String> {
        let mut changes = self.inner.hosts.changes();
        loop {
            if let Some(outcome) = settled(&state.borrow_and_update()) {
                return outcome;
            }
            if self.inner.hosts.link_epoch(host).is_none() {
                return Err(format!("its host {host} disconnected"));
            }
            tokio::select! {
                changed = state.changed() => if changed.is_err() {
                    return Err(format!("startup work for host {host} stopped"));
                },
                changed = changes.changed() => if changed.is_err() {
                    return Err(format!("the link to host {host} is gone"));
                },
            }
        }
    }

    async fn await_prepare_settled(
        &self,
        project: &Project,
        host: &str,
    ) -> Result<Option<PrepareReport>, String> {
        let state = self
            .inner
            .prepares
            .get(&project.id)
            .map(watch::Sender::subscribe)
            .ok_or_else(|| format!("no prepare task found for project {}", project.id))?;
        let id = project.id.clone();
        self.settle(host, state, move |state| match state {
            PrepareState::Settled { report } => Some(Ok(Some(report.clone()))),
            PrepareState::InfrastructureFailed { reason } => Some(Err(format!(
                "prepare infrastructure failed for {id}: {reason}"
            ))),
            _ => None,
        })
        .await
    }

    async fn await_catalog(&self, host: &str) -> Result<ModelCatalog, String> {
        let state = self
            .inner
            .catalogs
            .get(host)
            .map(watch::Sender::subscribe)
            .ok_or_else(|| format!("no catalog task for host {host:?}"))?;
        self.settle(host, state, |state| match state {
            CatalogState::Ready { snapshot, .. } => Some(Ok(snapshot.clone())),
            CatalogState::Unavailable { reason } => {
                Some(Ok(ModelCatalog::unavailable(reason.clone())))
            }
            CatalogState::Pending => None,
        })
        .await
    }

    /// Lists `host`'s models on every new link, and again every
    /// `CATALOG_REFRESH`. A failed refresh keeps the last good listing.
    async fn run_catalog_job(&self, host: &str) {
        let tx = &self.inner.catalogs[host];
        let mut shutdown = self.inner.shutdown_tx.subscribe();
        let mut changes = self.inner.hosts.changes();
        let mut listed: Option<u64> = None;
        loop {
            if *shutdown.borrow() {
                break;
            }
            let mut wait = CATALOG_REFRESH;
            if let Some(epoch) = self.inner.hosts.link_epoch(host) {
                if listed != Some(epoch) {
                    let reply = self
                        .inner
                        .hosts
                        .command(host, "list_models", json!({}), LIST_MODELS_WAIT)
                        .await;
                    let failure = match reply {
                        Ok(reply) => {
                            let catalog = ModelCatalog::from_host_models(&reply.result);
                            if catalog.available {
                                tracing::info!(%host, models = catalog.entries.len(), "host listed its models");
                                tx.send_replace(CatalogState::Ready {
                                    snapshot: catalog,
                                    degraded_reason: None,
                                });
                                listed = Some(epoch);
                                None
                            } else {
                                Some(catalog.diagnostic.unwrap_or_default())
                            }
                        }
                        Err(error) => Some(error.message),
                    };
                    if let Some(reason) = failure {
                        tracing::warn!(%host, %reason, "host model listing failed");
                        tx.send_modify(|state| match state {
                            CatalogState::Ready {
                                degraded_reason, ..
                            } => *degraded_reason = Some(reason),
                            _ => *state = CatalogState::Unavailable { reason },
                        });
                        wait = CATALOG_RETRY;
                    }
                }
            }
            tokio::select! {
                _ = shutdown.changed() => break,
                changed = changes.changed() => if changed.is_err() { break },
                _ = tokio::time::sleep(wait) => listed = None,
            }
        }
    }

    /// Runs the project's prepare command once, on its host, as soon as the
    /// host is connected. Its outcome, whatever it is, is final; only a link
    /// that went away under it is tried again, on the next link.
    async fn run_prepare_job(&self, project: Project) {
        let tx = &self.inner.prepares[&project.id];
        let mut shutdown = self.inner.shutdown_tx.subscribe();
        if project.prepare.trim().is_empty() {
            tx.send_replace(PrepareState::Settled {
                report: PrepareReport {
                    timestamp_unix_ms: now_unix_ms(),
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
        let Some(host) = project.canonical_host() else {
            tx.send_replace(PrepareState::InfrastructureFailed {
                reason: "the project has no host".into(),
            });
            return;
        };
        let mut changes = self.inner.hosts.changes();
        loop {
            if *shutdown.borrow() {
                return;
            }
            if self.inner.hosts.link_epoch(host).is_some() {
                tx.send_replace(PrepareState::Running);
                let started = now_unix_ms();
                let args = json!({
                    "cwd": project.cwd,
                    "command": project.prepare,
                    "timeout_ms": PREPARE_TIMEOUT.as_millis() as u64,
                });
                let reply = tokio::select! {
                    _ = shutdown.changed() => return,
                    reply = self.inner.hosts.command(
                        host,
                        "run_prepare",
                        args,
                        PREPARE_TIMEOUT + PREPARE_REPORT_GRACE,
                    ) => reply,
                };
                match reply {
                    Ok(reply) => {
                        let report = prepare_report(&reply.result, started);
                        tracing::info!(project = %project.id, outcome = ?report.outcome, duration_ms = report.duration_ms, "prepare settled");
                        tx.send_replace(PrepareState::Settled { report });
                        return;
                    }
                    Err(error) if link_gone(&error) => {
                        tracing::info!(project = %project.id, %error, "prepare interrupted; it runs again on the next link");
                        tx.send_replace(PrepareState::Pending);
                    }
                    Err(error) => {
                        tracing::warn!(project = %project.id, %error, "prepare could not run");
                        tx.send_replace(PrepareState::InfrastructureFailed {
                            reason: error.message,
                        });
                        return;
                    }
                }
            }
            tokio::select! {
                _ = shutdown.changed() => return,
                changed = changes.changed() => if changed.is_err() { return },
            }
        }
    }

    /// The host links this prewarm, and the legs it launches, run over.
    pub fn hosts(&self) -> Hosts {
        self.inner.hosts.clone()
    }

    /// Stops the startup jobs. Idempotent.
    pub fn shutdown(&self) {
        self.inner.shutdown_tx.send_replace(true);
    }
}

#[cfg(test)]
impl Prewarm {
    /// A prewarm whose startup work has already finished, with no jobs
    /// running: every host's catalog `catalog` and every prepare an empty
    /// success. Tests change one piece with the `settle_*` methods and then
    /// drive the PBX through the same reads production uses.
    ///
    /// Its hosts have no tokens and no links; a test links a host with
    /// `prewarm.hosts().connect_fake(..)`. The configuration is taken, as
    /// `Switchboard::new` takes it, so a test builds both the same way.
    pub(crate) fn settled(
        _config: &crate::Config,
        registry: &Registry,
        catalog: ModelCatalog,
    ) -> Self {
        let hosts = Hosts::new(HashMap::new(), crate::hosts::Heartbeat::default());
        let prewarm = Self::register(registry, hosts);
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
        prewarm
    }

    pub(crate) fn settle_catalog(&self, host: &str, state: CatalogState) {
        self.inner.catalogs[host].send_replace(state);
    }

    pub(crate) fn settle_prepare(&self, project: &Project, state: PrepareState) {
        self.inner.prepares[&project.id].send_replace(state);
    }

    /// How many launch plans are waiting for `host`'s catalog to settle.
    pub(crate) fn catalog_waiters(&self, host: &str) -> usize {
        self.inner.catalogs[host].receiver_count()
    }
}

#[cfg(test)]
#[path = "../tests/test_prewarm.rs"]
mod tests;

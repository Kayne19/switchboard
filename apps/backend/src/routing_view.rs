//! What routing reads about the call without the PBX lock. The turn worker
//! holds that lock for a whole prompt, so Jev's call summary, the router, the
//! host links and the desk sessions open on the hosts come from `RoutingView`,
//! which shares its state with the switchboard instead of borrowing it (#108).
use crate::history::TranscriptEntry;
use crate::hosts::Hosts;
use crate::lifecycle::Coordinator;
use crate::pbx::Switchboard;
use crate::registry::{Project, Registry};
use crate::residents::BackgroundRegistry;
use crate::router::{CallSummary, DeskSession, Router};
use futures_util::future::join_all;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::time::Duration;

/// What routing reads about the call, without the PBX lock. The turn worker
/// holds that lock for a whole prompt; a caller utterance that arrives during
/// the prompt must still be routed while it runs, or it can never be steered
/// into it (#108). Every field is shared with the switchboard, not copied.
#[derive(Clone)]
pub struct RoutingView {
    hosts: Hosts,
    registry: Arc<Registry>,
    router: Router,
    coordinator: Coordinator,
    background_agents: BackgroundRegistry,
    agent_tasks: Arc<StdMutex<HashMap<String, String>>>,
}

impl RoutingView {
    pub fn hosts(&self) -> Hosts {
        self.hosts.clone()
    }

    pub fn registry(&self) -> Arc<Registry> {
        Arc::clone(&self.registry)
    }

    pub fn router(&self) -> Router {
        self.router.clone()
    }

    pub fn call_summary(
        &self,
        transcript: &[TranscriptEntry],
        screen: Value,
        utterance: impl Into<String>,
    ) -> CallSummary {
        let background = self.background_agents.projects();
        let agent_tasks = self
            .agent_tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        CallSummary::from_runtime(
            &self.coordinator.status(),
            &self.registry,
            transcript,
            screen,
            utterance,
            &background,
            &agent_tasks,
        )
    }
}

impl Switchboard {
    /// What routing reads about this call, readable without the PBX lock.
    pub fn routing_view(&self) -> RoutingView {
        RoutingView {
            hosts: self.hosts.clone(),
            registry: Arc::clone(&self.registry),
            router: self.router.clone(),
            coordinator: self.coordinator.clone(),
            background_agents: self.background_agents.clone(),
            agent_tasks: Arc::clone(&self.agent_tasks),
        }
    }

    pub fn call_summary(
        &self,
        transcript: &[TranscriptEntry],
        screen: Value,
        utterance: impl Into<String>,
    ) -> CallSummary {
        self.routing_view()
            .call_summary(transcript, screen, utterance)
    }

    /// List foreign live sessions in registered project folders. The service
    /// labels a session as `taken_over` in the routing summary because that is
    /// the provenance it will record if the caller selects it.
    #[cfg(test)]
    pub async fn live_desk_sessions(&self) -> Vec<DeskSession> {
        Self::live_desk_sessions_from(self.hosts.clone(), Arc::clone(&self.registry)).await
    }

    /// Host I/O for the desk-session summary. Keep this outside the PBX lock:
    /// a slow host must not stall unrelated caller turns or lifecycle actions.
    pub(crate) async fn live_desk_sessions_from(
        hosts: Hosts,
        registry: Arc<Registry>,
    ) -> Vec<DeskSession> {
        let mut projects_by_host: HashMap<String, Vec<&Project>> = HashMap::new();
        for project in &registry.projects {
            if let Some(host) = project.canonical_host() {
                projects_by_host
                    .entry(host.to_owned())
                    .or_default()
                    .push(project);
            }
        }
        let replies = join_all(projects_by_host.into_iter().map(|(host, projects)| {
            let hosts = hosts.clone();
            async move {
                let reply = hosts
                    .command(&host, "list_sessions", json!({}), Duration::from_secs(5))
                    .await;
                (host, projects, reply)
            }
        }))
        .await;
        let mut result = Vec::new();
        let mut seen = HashSet::new();
        for (host, projects, reply) in replies {
            let reply = match reply {
                Ok(reply) => reply,
                Err(error) => {
                    tracing::debug!(%host, %error, "could not list desk sessions for routing summary");
                    continue;
                }
            };
            let Some(sessions) = reply.result["sessions"].as_array() else {
                continue;
            };
            for session in sessions {
                if !session["provenance"].is_null() {
                    continue;
                }
                let Some(cwd) = session["cwd"].as_str() else {
                    continue;
                };
                let Some(project) = projects.iter().find(|project| project.cwd == cwd) else {
                    continue;
                };
                let key = session["session"].as_str().unwrap_or_default();
                if key.is_empty() || !seen.insert((host.clone(), key.to_owned())) {
                    continue;
                }
                result.push(DeskSession {
                    project: project.id.clone(),
                    state: if session["busy"] == true || session["turn_open"] == true {
                        "busy".into()
                    } else {
                        "idle".into()
                    },
                    provenance: "taken_over".into(),
                });
            }
        }
        result.sort_by(|left, right| {
            left.project
                .cmp(&right.project)
                .then(left.state.cmp(&right.state))
        });
        result
    }
}

#[cfg(test)]
#[path = "../tests/test_routing_view.rs"]
mod tests;

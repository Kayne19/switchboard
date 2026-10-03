//! Resident project agents: sessions that stay up in the background while
//! the caller is on other work. `BackgroundRegistry` owns their sessions,
//! their detached prompt tasks and the task epochs that keep a late completion
//! from making a replaced or promoted session look idle. The switchboard
//! shelves the previous foreground here, starts split parts here, and evicts a
//! resident whose host reports it closed.
use crate::pbx::{uuid_like, AgentStateNotice, Switchboard, TransferContext};
use crate::pi_client::ProjectSession;
use crate::prompts::{build_intro_prompt, BACKGROUND_NOTICE};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::task::JoinHandle;

/// Owns resident sessions and the task reservations that may write their
/// lifecycle projection. Callers never mutate the resident map directly: every
/// removal invalidates the task epoch first, so a late completion cannot make a
/// replaced or promoted session look idle.
#[derive(Clone)]
pub(crate) struct BackgroundRegistry {
    // Session membership is shared with the closed-session reaper. The PBX
    // still owns lifecycle decisions, while a host death can evict its
    // resident immediately from the pump task.
    sessions: Arc<StdMutex<HashMap<String, ProjectSession>>>,
    tasks: Arc<StdMutex<HashMap<String, JoinHandle<()>>>>,
    epochs: Arc<StdMutex<HashMap<String, Arc<AtomicU64>>>>,
    next_epoch: Arc<AtomicU64>,
}

impl Default for BackgroundRegistry {
    fn default() -> Self {
        Self {
            sessions: Arc::new(StdMutex::new(HashMap::new())),
            tasks: Arc::new(StdMutex::new(HashMap::new())),
            epochs: Arc::new(StdMutex::new(HashMap::new())),
            next_epoch: Arc::new(AtomicU64::new(1)),
        }
    }
}

impl BackgroundRegistry {
    #[cfg(test)]
    fn sessions_snapshot_for_test(&self) -> Vec<(String, ProjectSession)> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|(project, session)| (project.clone(), session.clone()))
            .collect()
    }

    pub(crate) fn projects(&self) -> Vec<String> {
        let mut projects = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        projects.sort();
        projects
    }

    pub(crate) fn contains_key(&self, project: &str) -> bool {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(project)
    }

    pub(crate) fn get(&self, project: &str) -> Option<ProjectSession> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(project)
            .cloned()
    }

    fn insert(&self, project: String, session: ProjectSession) {
        self.epochs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(project.clone())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)));
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(project, session);
    }

    pub(crate) fn remove(&self, project: &str) -> Option<ProjectSession> {
        self.invalidate(project);
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(project)
    }

    pub(crate) fn remove_closed(
        &self,
        project: &str,
        session_id: &str,
        instance_id: u64,
    ) -> Option<ProjectSession> {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if sessions.get(project).is_some_and(|session| {
            session.session_id() == session_id && session.instance_id() == instance_id
        }) {
            self.invalidate(project);
            sessions.remove(project)
        } else {
            None
        }
    }

    fn invalidate(&self, project: &str) {
        if let Some(epoch) = self
            .epochs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(project)
        {
            epoch.fetch_add(1, Ordering::AcqRel);
        }
    }

    fn begin_task(&self, project: &str) -> (Arc<AtomicU64>, u64) {
        let mut epochs = self
            .epochs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let epoch = epochs
            .entry(project.to_owned())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)))
            .clone();
        let generation = self.next_epoch.fetch_add(1, Ordering::Relaxed);
        epoch.store(generation, Ordering::Release);
        (epoch, generation)
    }

    fn set_task(&self, project: String, task: JoinHandle<()>) {
        if let Some(previous) = self
            .tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(project, task)
        {
            previous.abort();
        }
    }

    fn take_task(&self, project: &str) -> Option<JoinHandle<()>> {
        self.invalidate(project);
        self.tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(project)
    }

    pub(crate) async fn cancel_task(&self, project: &str) {
        if let Some(task) = self.take_task(project) {
            task.abort();
            let _ = task.await;
        }
    }

    pub(crate) fn drain_sessions(&self) -> Vec<ProjectSession> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .map(|(_, session)| session)
            .collect()
    }

    pub(crate) async fn cancel_all_tasks(&self) {
        let tasks = self
            .tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .map(|(_, task)| task)
            .collect::<Vec<_>>();
        for task in tasks {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Switchboard {
    #[cfg(test)]
    pub(crate) fn residents_for_test(&self) -> Vec<(String, bool, bool)> {
        self.background_agents
            .sessions_snapshot_for_test()
            .into_iter()
            .map(|(project, session)| (project, session.alive(), session.busy()))
            .collect()
    }

    /// Removes a resident whose host session has already closed. The map is
    /// otherwise enough to enforce one live session per project, but a closed
    /// handle would make later work prompt a dead session and reject a fresh
    /// start forever.
    pub(crate) async fn remove_dead_background(&mut self, project: &str) -> bool {
        let dead = self
            .background_agents
            .get(project)
            .is_some_and(|session| !session.alive());
        if !dead {
            return false;
        }
        self.background_agents.cancel_task(project).await;
        if let Some(session) = self.background_agents.remove(project) {
            self.coordinator.remove_background(&session.token());
        }
        true
    }

    /// Removes a resident for a foreground promotion only after its detached
    /// prompt has been cancelled and joined. This is the reservation boundary:
    /// mode and token cannot change while the old background task is running.
    pub(crate) async fn take_background(&mut self, project: &str) -> Option<ProjectSession> {
        let session = self.background_agents.remove(project)?;
        self.background_agents.cancel_task(project).await;
        self.coordinator.remove_background(&session.token());
        Some(session)
    }

    /// Shelves the former foreground leg when another project takes the line.
    /// Foreign desk sessions are released, never made resident: the service
    /// owns only sessions it created.
    pub(crate) async fn shelve_previous_foreground(&mut self, next_project: &str) {
        let Some(previous) = self.agent.take() else {
            return;
        };
        let previous_label = previous.label().to_owned();
        if previous_label == next_project || previous.is_taken_over() {
            previous.close();
            self.announce_agent_state(&previous_label, "finished").await;
            return;
        }
        if let Err(error) = previous.set_mode("background").await {
            // The host still treats it as foreground, so its speech and
            // displays would not follow background rules. Do not keep a
            // resident whose host and service disagree about its mode.
            tracing::warn!(project = %previous_label, %error, "could not move the previous agent to the background; closing it");
            previous.close();
            self.announce_agent_state(&previous_label, "finished").await;
            return;
        }
        if previous.busy() {
            let _ = previous.steer(BACKGROUND_NOTICE, None).await;
        }
        let state = if previous.busy() { "busy" } else { "idle" };
        let registered = self.register_background_session(previous_label.clone(), previous);
        self.announce_agent_state(&previous_label, if registered { state } else { "finished" })
            .await;
    }

    /// Registers a resident and rechecks the host handle after insertion. A
    /// host can report death between the token registration and map insertion;
    /// the final check closes that gap without leaving a dead token resident.
    fn register_background_session(&self, project: String, session: ProjectSession) -> bool {
        self.register_background_session_with(project, session, || {})
    }

    fn register_background_session_with(
        &self,
        project: String,
        session: ProjectSession,
        before_insert: impl FnOnce(),
    ) -> bool {
        let token = session.token();
        self.coordinator.register_background(project.clone(), token);
        before_insert();
        self.background_agents
            .insert(project.clone(), session.clone());
        let still_registered = session.alive()
            && self
                .background_agents
                .get(&project)
                .is_some_and(|current| current.same_session(&session));
        if !still_registered {
            if let Some(removed) = self.background_agents.remove(&project) {
                self.coordinator.remove_background(&removed.token());
            }
        }
        still_registered
    }

    #[cfg(test)]
    fn register_background_session_with_fake_death(
        &self,
        project: String,
        session: ProjectSession,
    ) -> bool {
        self.register_background_session_with(project, session.clone(), || session.close())
    }

    /// Prompts a background agent without waiting for its turn. `source` is
    /// what the prompt is for the debug page (`caller` or `intro`); the
    /// caller line it carries is read now, before the task leaves the
    /// decision that set it.
    fn spawn_background_prompt(
        &mut self,
        project: &str,
        session: ProjectSession,
        text: String,
        source: &'static str,
    ) {
        let (epoch, generation) = self.background_agents.begin_task(project);
        let utterance = self.current_utterance();
        let token = session.token();
        let callback = self.agent_state_callback.clone();
        let closed_callback = self.session_closed_callback();
        let project_id = project.to_owned();
        let session_id = session.session_id().to_owned();
        let instance_id = session.instance_id();
        let task = tokio::spawn(async move {
            let result = session.prompt_as(&text, source, utterance.as_deref()).await;
            if let Err(error) = result {
                tracing::warn!(%error, project = %project_id, "background agent prompt failed");
                // Prompt transport failure is terminal for this resident. Do
                // not leave a dead token reusable or publish an idle notice.
                session.close();
                closed_callback(project_id.clone(), session_id, instance_id).await;
                return;
            }
            if let Some(callback) = callback {
                if session.alive()
                    && !session.busy()
                    && epoch.load(Ordering::Acquire) == generation
                    && session.token() == token
                {
                    callback(AgentStateNotice {
                        project: project_id,
                        state: "idle".into(),
                    })
                    .await;
                }
            }
        });
        self.background_agents.set_task(project.to_owned(), task);
    }

    /// Start one split part without changing the caller's foreground route.
    pub(crate) async fn start_background_part(
        &mut self,
        target: &str,
        text: &str,
    ) -> Result<(), String> {
        let project = match self.registry.resolve_detailed(target) {
            crate::registry::ResolveResult::Exact(project) => project.clone(),
            _ => return Err(format!("unknown project {target}")),
        };
        self.set_agent_task(&project.id, text);
        if self
            .agent
            .as_ref()
            .is_some_and(|agent| agent.label() == project.id)
        {
            return Err(format!("project {} is already busy", project.id));
        }
        if self.remove_dead_background(&project.id).await {
            self.announce_agent_state(&project.id, "finished").await;
        }
        // A resident background session can be idle after its prior turn. Keep
        // its history and address it instead of treating existence as busy.
        if let Some(session) = self.background_agents.get(&project.id) {
            if session.busy() {
                return Err(format!("project {} is already busy", project.id));
            }
            self.announce_agent_state(&project.id, "busy").await;
            self.spawn_background_prompt(&project.id, session, text.to_owned(), "caller");
            return Ok(());
        }
        let plan = self
            .prewarm
            .launch_plan(&project)
            .await
            .map_err(|error| error.to_string())?;
        let model = self
            .select_transfer_model(&project, &plan.catalog, "", "")
            .map_err(|error| error.to_string())?;
        let token = uuid_like();
        let session = self
            .start_agent_mode(&project, &model, &token, &plan, "background")
            .await
            .map_err(|error| error.to_string())?;
        let intro = build_intro_prompt(
            &TransferContext {
                exact_caller_transcript: text.to_owned(),
                ..TransferContext::default()
            },
            &project,
            plan.prepare_report.as_ref(),
        );
        if !self.register_background_session(project.id.clone(), session.clone()) {
            self.announce_agent_state(&project.id, "finished").await;
            return Err(format!(
                "project {} ended before background registration",
                project.id
            ));
        }
        self.announce_agent_state(&project.id, "busy").await;
        self.spawn_background_prompt(&project.id, session, intro, "intro");
        Ok(())
    }
}

#[cfg(test)]
#[path = "../tests/test_residents.rs"]
mod tests;

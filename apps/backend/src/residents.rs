//! Resident project agents: sessions that stay up in the background while
//! the caller is on other work. `BackgroundRegistry` holds one `Resident` per
//! project: its session and the background prompt running for it. A
//! resident enters through `admit` and leaves through `retire`, whose
//! `Leaving` reason decides everything leaving does. The switchboard shelves
//! the previous foreground here, starts split parts here, and evicts a
//! resident whose host reports it closed.
use crate::lifecycle::Coordinator;
use crate::pbx::{uuid_like, AgentNotice, AgentStateCallback, Switchboard, TransferContext};
use crate::project_session::ProjectSession;
use crate::prompts::{build_intro_prompt, BACKGROUND_NOTICE};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};
use tokio::task::JoinHandle;

/// One resident: its session and, once one was started, the background
/// prompt given to it. The prompt's number is what lets the prompt's own
/// task publish idle: it does so only while it is still its resident's
/// prompt, so a late completion cannot make a replaced, promoted or stopped
/// resident look idle.
struct Resident {
    session: ProjectSession,
    prompt: Option<BackgroundPrompt>,
}

struct BackgroundPrompt {
    number: u64,
    task: JoinHandle<()>,
}

/// Why a resident leaves the registry. The reason decides all of what
/// leaving does (`Leaving::exit`):
///
/// | reason         | its prompt           | its session        | publishes  |
/// |----------------|----------------------|--------------------|------------|
/// | `Stopped`      | cancelled and joined | ended              | `finished` |
/// | `Dead`         | cancelled and joined | left (it is dead)  | `finished` |
/// | `Promoted`     | cancelled and joined | handed to the line | nothing    |
/// | `ClosedOnHost` | left to end          | left (it is dead)  | `finished` |
/// | `Shutdown`     | cancelled and joined | ended              | nothing    |
///
/// Every reason retires the resident's call token first, so no request or
/// display passes the lifecycle check while the rest runs.
#[derive(Debug)]
pub(crate) enum Leaving {
    /// The caller stopped it.
    Stopped,
    /// Its handle was found closed before work was given to it.
    Dead,
    /// The caller is put through to it: the session goes on the line.
    Promoted,
    /// Its host reported this session closed. Only the exact session (its
    /// persistent id and live-handle instance) leaves, so a report about an
    /// older handle cannot evict its replacement. Its prompt is left to end:
    /// the report can come from inside that prompt's own task (a prompt the
    /// host refused), which must not wait on itself, and a closed session's
    /// prompt ends by itself.
    ClosedOnHost {
        session_id: String,
        instance_id: u64,
    },
    /// The service is shutting down.
    Shutdown,
}

/// What leaving does, besides retiring the call token.
struct Exit {
    cancel_prompt: bool,
    end_session: bool,
    publish_finished: bool,
}

impl Leaving {
    fn exit(&self) -> Exit {
        let (cancel_prompt, end_session, publish_finished) = match self {
            Leaving::Stopped => (true, true, true),
            Leaving::Dead => (true, false, true),
            Leaving::Promoted => (true, false, false),
            Leaving::ClosedOnHost { .. } => (false, false, true),
            Leaving::Shutdown => (true, true, false),
        };
        Exit {
            cancel_prompt,
            end_session,
            publish_finished,
        }
    }

    /// Whether this reason is about `session`: the host's report names one
    /// session; every other reason is about whichever resident the project
    /// has.
    fn names(&self, session: &ProjectSession) -> bool {
        match self {
            Leaving::ClosedOnHost {
                session_id,
                instance_id,
            } => session.session_id() == session_id && session.instance_id() == *instance_id,
            Leaving::Stopped | Leaving::Dead | Leaving::Promoted | Leaving::Shutdown => true,
        }
    }
}

/// Owns the residents. A resident's call token is registered with the
/// coordinator in `admit` and retired in `retire`, nowhere else, so the
/// coordinator's background tokens and this map name the same residents.
/// Shared with the closed-session reaper, which retires a resident from its
/// host's pump without the PBX lock.
#[derive(Clone)]
pub(crate) struct BackgroundRegistry {
    residents: Arc<StdMutex<HashMap<String, Resident>>>,
    coordinator: Coordinator,
    next_prompt: Arc<AtomicU64>,
}

impl BackgroundRegistry {
    pub(crate) fn new(coordinator: Coordinator) -> Self {
        Self {
            residents: Arc::new(StdMutex::new(HashMap::new())),
            coordinator,
            next_prompt: Arc::new(AtomicU64::new(1)),
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Resident>> {
        self.residents
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(test)]
    fn sessions_snapshot_for_test(&self) -> Vec<(String, ProjectSession)> {
        self.lock()
            .iter()
            .map(|(project, resident)| (project.clone(), resident.session.clone()))
            .collect()
    }

    pub(crate) fn projects(&self) -> Vec<String> {
        let mut projects = self.lock().keys().cloned().collect::<Vec<_>>();
        projects.sort();
        projects
    }

    pub(crate) fn contains_key(&self, project: &str) -> bool {
        self.lock().contains_key(project)
    }

    pub(crate) fn get(&self, project: &str) -> Option<ProjectSession> {
        self.lock()
            .get(project)
            .map(|resident| resident.session.clone())
    }

    /// Makes `session` the project's resident: registers its call token and
    /// enters it, under the registry's lock. Refused, leaving nothing
    /// behind, when its handle has already closed (a host death the reaper
    /// could not see yet, since the session was not resident) or the
    /// project already has a resident. A death reported after the check
    /// waits for the lock and retires the resident. `before_check` runs
    /// between the entry and the check, where a test closes the handle.
    fn admit(&self, project: String, session: ProjectSession, before_check: impl FnOnce()) -> bool {
        let mut residents = self.lock();
        if residents.contains_key(&project) {
            tracing::error!(%project, "the project already has a resident; not admitting a second");
            return false;
        }
        self.coordinator
            .register_background(project.clone(), session.token());
        residents.insert(
            project.clone(),
            Resident {
                session: session.clone(),
                prompt: None,
            },
        );
        before_check();
        if session.alive() {
            return true;
        }
        self.take_out(&mut residents, &project);
        false
    }

    /// Takes the project's resident out of the map and retires its call
    /// token: the one removal, under the registry's lock.
    fn take_out(
        &self,
        residents: &mut HashMap<String, Resident>,
        project: &str,
    ) -> Option<Resident> {
        let resident = residents.remove(project)?;
        self.coordinator
            .remove_background(&resident.session.token());
        Some(resident)
    }

    /// Runs a background prompt for the project's resident: `prompt` gets
    /// the prompt's number and returns its task's future. A prompt it
    /// replaces is aborted. False when the project has no resident (its
    /// host closed it), and nothing is started.
    fn start_prompt<F>(&self, project: &str, prompt: impl FnOnce(u64) -> F) -> bool
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let mut residents = self.lock();
        let Some(resident) = residents.get_mut(project) else {
            return false;
        };
        let number = self.next_prompt.fetch_add(1, Ordering::Relaxed);
        // Spawned under the lock: the task's own check of its number takes
        // this lock, so it finds itself entered.
        let task = tokio::spawn(prompt(number));
        if let Some(replaced) = resident.prompt.replace(BackgroundPrompt { number, task }) {
            replaced.task.abort();
        }
        true
    }

    /// Whether prompt `number` is still the project's resident's prompt.
    fn prompt_is_current(&self, project: &str, number: u64) -> bool {
        self.lock()
            .get(project)
            .and_then(|resident| resident.prompt.as_ref())
            .is_some_and(|prompt| prompt.number == number)
    }

    /// The one way a resident leaves. Takes the resident `why` names out of
    /// the registry and retires its call token, both under the registry's
    /// lock, then does what `why` says leaving does (`Leaving`). Returns the
    /// session that left, or `None` when no resident matched.
    pub(crate) async fn retire(
        &self,
        project: &str,
        why: Leaving,
        announce: Option<&AgentStateCallback>,
    ) -> Option<ProjectSession> {
        let Resident { session, prompt } = {
            let mut residents = self.lock();
            if !residents
                .get(project)
                .is_some_and(|resident| why.names(&resident.session))
            {
                return None;
            }
            self.take_out(&mut residents, project)?
        };
        let exit = why.exit();
        if let Some(prompt) = prompt.filter(|_| exit.cancel_prompt) {
            prompt.task.abort();
            let _ = prompt.task.await;
        }
        if exit.end_session {
            session.close();
        }
        if exit.publish_finished {
            if let Some(announce) = announce {
                announce(crate::pbx::AgentStateNotice {
                    project: project.to_owned(),
                    state: AgentNotice::Finished,
                })
                .await;
            }
        }
        Some(session)
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

    /// Retires the project's resident for `why`, publishing through this
    /// switchboard's agent state callback.
    pub(crate) async fn retire_resident(
        &self,
        project: &str,
        why: Leaving,
    ) -> Option<ProjectSession> {
        self.background_agents
            .retire(project, why, self.agent_state_callback.as_ref())
            .await
    }

    /// Retires a resident whose handle has closed without its host saying
    /// so, before work is given to the project. A closed handle would make
    /// later work prompt a dead session and refuse a fresh start forever.
    pub(crate) async fn retire_dead_resident(&self, project: &str) {
        if self
            .background_agents
            .get(project)
            .is_some_and(|session| !session.alive())
        {
            self.retire_resident(project, Leaving::Dead).await;
        }
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
            self.announce_agent_state(&previous_label, AgentNotice::Finished)
                .await;
            return;
        }
        if let Err(error) = previous.set_mode("background").await {
            // The host still treats it as foreground, so its speech and
            // displays would not follow background rules. Do not keep a
            // resident whose host and service disagree about its mode.
            tracing::warn!(project = %previous_label, %error, "could not move the previous agent to the background; closing it");
            previous.close();
            self.announce_agent_state(&previous_label, AgentNotice::Finished)
                .await;
            return;
        }
        if previous.busy() {
            let _ = previous.steer(BACKGROUND_NOTICE, None).await;
        }
        let state = if previous.busy() {
            AgentNotice::Busy
        } else {
            AgentNotice::Idle
        };
        let admitted = self
            .background_agents
            .admit(previous_label.clone(), previous, || {});
        let state = if admitted {
            state
        } else {
            AgentNotice::Finished
        };
        self.announce_agent_state(&previous_label, state).await;
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
        let utterance = self.current_utterance();
        let callback = self.agent_state_callback.clone();
        let closed_callback = self.session_closed_callback();
        let registry = self.background_agents.clone();
        let project_id = project.to_owned();
        let session_id = session.session_id().to_owned();
        let instance_id = session.instance_id();
        let started = self
            .background_agents
            .start_prompt(project, |number| async move {
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
                        && registry.prompt_is_current(&project_id, number)
                    {
                        callback(crate::pbx::AgentStateNotice {
                            project: project_id,
                            state: AgentNotice::Idle,
                        })
                        .await;
                    }
                }
            });
        if !started {
            tracing::info!(%project, "the resident closed before its prompt could start");
        }
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
        self.retire_dead_resident(&project.id).await;
        // A resident background session can be idle after its prior turn. Keep
        // its history and address it instead of treating existence as busy.
        if let Some(session) = self.background_agents.get(&project.id) {
            if session.busy() {
                return Err(format!("project {} is already busy", project.id));
            }
            self.announce_agent_state(&project.id, AgentNotice::Busy)
                .await;
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
        if !self
            .background_agents
            .admit(project.id.clone(), session.clone(), || {})
        {
            self.announce_agent_state(&project.id, AgentNotice::Finished)
                .await;
            return Err(format!(
                "project {} ended before background registration",
                project.id
            ));
        }
        self.announce_agent_state(&project.id, AgentNotice::Busy)
            .await;
        self.spawn_background_prompt(&project.id, session, intro, "intro");
        Ok(())
    }
}

#[cfg(test)]
#[path = "../tests/test_residents.rs"]
mod tests;

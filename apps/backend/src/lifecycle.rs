//! Synchronous ownership for call identity, the current route, operations, and
//! the status the page is shown.
//!
//! The coordinator deliberately contains no async code. Callers take a short
//! linearization point here, then perform PBX, process, or callback work after
//! releasing it.
//!
//! It is the one owner of the leg on the line: its route, project, model,
//! session, thinking, and catalog. The PBX owns the processes and changes the
//! leg only through the named transitions here; everything else reads it.

use crate::models::{parse_spec, ModelCatalog, THINKING_LEVELS};
use crate::protocol::{CandidateEnd, ModelEntry, Status};
use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::Notify;

const OPERATOR: &str = "operator";

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct LegIdentity {
    pub token: String,
    pub generation: u64,
}

impl LegIdentity {
    pub fn new(token: impl Into<String>, generation: u64) -> Self {
        Self {
            token: token.into(),
            generation,
        }
    }
}

/// The project leg on the line, read in one piece. Every adoption and rescue
/// gives the leg a new identity, and a return to the operator
/// ends it, so an equal value read later means nothing has replaced the leg
/// in between.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectLeg {
    pub project: String,
    pub identity: LegIdentity,
    /// The model spec the leg was started with.
    pub model: String,
    /// The pi session the leg writes; a redial that keeps context reopens it.
    pub persistent_session_id: String,
}

/// Where the call is. `Starting` is the only phase in which a candidate leg
/// exists; its side effects stay private until it is adopted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Operator,
    Starting,
    Active,
    TurnRunning,
    Quiescing,
    Shutdown,
}

/// One prompt turn on one leg. A steer attaches to the turn already running.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OperationIdentity {
    pub id: u64,
    pub leg: LegIdentity,
    /// The host-agent turn that owns project side effects, when known. Older
    /// hosts omit it for ordinary caller turns; autonomous turns require it.
    pub turn_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct CandidateLeg {
    pub route: String,
    pub project: String,
    pub persistent_session_id: String,
    pub identity: LegIdentity,
    pub model: String,
    pub thinking: String,
    pub startup_thinking: String,
    pub catalog: Option<Arc<ModelCatalog>>,
}

impl CandidateLeg {
    pub fn new(
        route: impl Into<String>,
        project: impl Into<String>,
        persistent_session_id: impl Into<String>,
        token: impl Into<String>,
        model: impl Into<String>,
        thinking: impl Into<String>,
    ) -> Self {
        Self {
            route: route.into(),
            project: project.into(),
            persistent_session_id: persistent_session_id.into(),
            identity: LegIdentity::new(token, 0),
            model: model.into(),
            thinking: thinking.into(),
            startup_thinking: String::new(),
            catalog: None,
        }
    }

    pub fn with_catalog(mut self, catalog: ModelCatalog) -> Self {
        self.catalog = Some(Arc::new(catalog));
        self
    }
}

/// Notice to the presentation layer that a candidate leg began or ended.
/// The browser shows "connecting to {route}" while a candidate is starting.
/// Speech recorded during that window, and not yet sent, is carried to the
/// next epoch only when the candidate ends `Adopted`: a rollback or a rescue
/// sends the same clear notice, and a rescue a new epoch as well, but the
/// caller never reached the leg those words were addressed to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandidateNotice {
    /// The route of the leg that was starting, however it ended.
    pub route: String,
    pub generation: u64,
    /// `None` while the candidate is starting; how it ended once it has.
    pub ended: Option<CandidateEnd>,
}

pub type CandidateCallback = Arc<dyn Fn(&CandidateNotice) + Send + Sync>;

/// What becomes of RPC activity from a pi process, decided by the leg the
/// process was started for (`Coordinator::classify_activity`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActivityDisposition {
    /// The starting candidate's own sign of life: adopt it, then publish.
    Promote,
    /// The leg on the line: publish it.
    Publish,
    /// A leg the call has left, a rescued one, or a process that is neither
    /// the candidate nor the current leg: drop it.
    Discard,
}

/// What the status needs besides the call's state: the deployment's settings,
/// which no transition changes.
#[derive(Clone, Debug, Default)]
pub struct StatusConfig {
    /// The operator's model spec, as the operator is launched with it.
    pub operator_model: String,
    pub model_swaps: bool,
    /// Every project the caller can be put through to.
    pub projects: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LifecycleError {
    StaleLeg,
    WrongPhase,
    OperationActive,
    NoActiveOperation,
    Shutdown,
    NoCandidate,
    CandidateTokenMismatch,
    CandidateSideEffect,
    CandidateActive,
}

impl fmt::Display for LifecycleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::StaleLeg => "leg is stale",
            Self::WrongPhase => "operation is not valid in this phase",
            Self::OperationActive => "a prompt operation is already active",
            Self::NoActiveOperation => "no prompt operation is active",
            Self::Shutdown => "switchboard is shutting down",
            Self::NoCandidate => "no candidate leg is staged",
            Self::CandidateTokenMismatch => "candidate token does not match",
            Self::CandidateSideEffect => "candidate side effects are private",
            Self::CandidateActive => "a candidate leg is already staged",
        })
    }
}
impl std::error::Error for LifecycleError {}

/// What a rescue retired, for the notice sent once the state lock is released.
struct Rescue {
    /// The route of the candidate the rescue abandoned, if one was starting.
    abandoned_candidate: Option<String>,
    next: LegIdentity,
}

/// The leg a startup replaces, restored if the startup fails.
#[derive(Clone)]
struct StartupRollback {
    route: String,
    project: Option<String>,
    persistent_session_id: String,
    leg: LegIdentity,
    model: String,
    thinking_requested: String,
    thinking_effective: String,
    catalog: Option<Arc<ModelCatalog>>,
}

pub struct CallLifecycle {
    route: String,
    /// The project on the line; `None` on the operator.
    project: Option<String>,
    persistent_session_id: String,
    leg: LegIdentity,
    phase: Phase,
    /// The project leg's model spec; empty on the operator, whose model is a
    /// deployment setting (`StatusConfig::operator_model`).
    model: String,
    thinking_requested: String,
    /// The level the leg reported through `/leg-state`; empty until it does.
    thinking_effective: String,
    /// The level the next project call is asked for when the caller names
    /// none. `/thinking` changes it.
    thinking_default: String,
    operation: Option<OperationIdentity>,
    terminal_reason: Option<String>,
    candidate: Option<CandidateLeg>,
    startup_rollback: Option<StartupRollback>,
    /// The leg the last adoption put on the line. While it is still the leg
    /// on the line, the generation is the one it was adopted at.
    adopted: Option<LegIdentity>,
    /// The catalog the project leg launched with.
    catalog: Option<Arc<ModelCatalog>>,
    /// Tokens belonging to resident sessions that are not foreground.
    background_tokens: HashMap<String, String>,
}

impl CallLifecycle {
    fn operator(thinking_default: String) -> Self {
        Self {
            route: OPERATOR.into(),
            project: None,
            persistent_session_id: String::new(),
            leg: LegIdentity::new(OPERATOR, 0),
            phase: Phase::Operator,
            model: String::new(),
            thinking_requested: String::new(),
            thinking_effective: String::new(),
            thinking_default,
            operation: None,
            terminal_reason: None,
            candidate: None,
            startup_rollback: None,
            adopted: None,
            catalog: None,
            background_tokens: HashMap::new(),
        }
    }

    fn on_operator(&self) -> bool {
        self.route == OPERATOR
    }

    /// The phase a call at rest on its route is in.
    fn resting_phase(&self) -> Phase {
        if self.on_operator() {
            Phase::Operator
        } else {
            Phase::Active
        }
    }

    fn route_label(&self) -> String {
        if self.on_operator() {
            "Operator".into()
        } else {
            self.project.clone().unwrap_or_else(|| self.route.clone())
        }
    }

    fn project_leg(&self) -> Option<ProjectLeg> {
        Some(ProjectLeg {
            project: self.project.clone()?,
            identity: self.leg.clone(),
            model: self.model.clone(),
            persistent_session_id: self.persistent_session_id.clone(),
        })
    }

    /// The status the page is shown, built from this lifecycle alone. On the
    /// operator the model and its thinking are the operator's deployment
    /// setting; on a project they are the leg's.
    fn status(&self, config: &StatusConfig) -> Status {
        let on_operator = self.on_operator();
        let model = if on_operator {
            config.operator_model.clone()
        } else {
            self.model.clone()
        };
        let (provider, model_id, spec_thinking) = parse_spec(&model);
        let model_name = if provider.is_empty() {
            model_id
        } else {
            format!("{provider}/{model_id}")
        };
        let thinking_requested = if on_operator {
            spec_thinking
        } else {
            self.thinking_requested.clone()
        };
        let thinking = if self.thinking_effective.is_empty() {
            thinking_requested.clone()
        } else {
            self.thinking_effective.clone()
        };
        let (models, models_available, models_diagnostic) = if on_operator {
            (Vec::new(), true, None)
        } else if let Some(catalog) = &self.catalog {
            (
                catalog
                    .entries
                    .iter()
                    .map(|entry| ModelEntry {
                        provider: entry.provider.clone(),
                        model: entry.model.clone(),
                        thinks: entry.thinks,
                    })
                    .collect(),
                catalog.available,
                catalog.diagnostic.clone(),
            )
        } else {
            (
                Vec::new(),
                false,
                Some("model catalog has not been loaded".into()),
            )
        };
        Status {
            route: self.route.clone(),
            label: self.route_label(),
            model,
            model_name,
            thinking,
            thinking_requested,
            thinking_confirmed: !self.thinking_effective.is_empty(),
            thinking_default: self.thinking_default.clone(),
            levels: THINKING_LEVELS
                .iter()
                .map(|level| (*level).to_owned())
                .collect(),
            models,
            models_available,
            models_diagnostic,
            model_swaps: config.model_swaps,
            projects: config.projects.clone(),
        }
    }
}

#[derive(Clone)]
pub struct Coordinator {
    state: Arc<Mutex<CallLifecycle>>,
    config: Arc<StatusConfig>,
    projection: Arc<RwLock<Arc<Status>>>,
    next_operation: Arc<AtomicU64>,
    /// Wakes queued caller turns when a lifecycle operation or candidate
    /// settles. The coordinator remains synchronous; API workers await it.
    operation_changed: Arc<Notify>,
    on_candidate: Arc<Mutex<Option<CandidateCallback>>>,
    /// Serializes a background-token check with the projection mutation that
    /// follows it. Promotion/removal takes this same owner lock.
    background_owner: Arc<std::sync::Mutex<()>>,
}

impl Coordinator {
    /// A call on the operator. `thinking_default` is the level the first
    /// project call is asked for.
    pub fn new(config: StatusConfig, thinking_default: impl Into<String>) -> Self {
        let lifecycle = CallLifecycle::operator(thinking_default.into());
        let projection = Arc::new(RwLock::new(Arc::new(lifecycle.status(&config))));
        Self {
            state: Arc::new(Mutex::new(lifecycle)),
            config: Arc::new(config),
            projection,
            next_operation: Arc::new(AtomicU64::new(1)),
            operation_changed: Arc::new(Notify::new()),
            on_candidate: Arc::new(Mutex::new(None)),
            background_owner: Arc::new(std::sync::Mutex::new(())),
        }
    }

    /// Registers a synchronous, non-blocking notice of candidate-leg
    /// transitions. The callback fires while the coordinator's state lock is
    /// held and must not call back into the coordinator.
    pub fn set_candidate_callback(&mut self, callback: CandidateCallback) {
        *self
            .on_candidate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(callback);
    }

    fn notify_candidate(&self, notice: &CandidateNotice) {
        let callback = self
            .on_candidate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(callback) = callback {
            callback(notice);
        }
    }

    pub fn linearize<R>(&self, operation: impl FnOnce(&mut CallLifecycle) -> R) -> R {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        operation(&mut state)
    }

    fn refresh_locked(&self, state: &CallLifecycle) {
        let projection = Arc::new(state.status(&self.config));
        *self
            .projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = projection;
    }

    /// The status the page is shown. Read without waiting for a transition in
    /// progress: it is the projection the last one left.
    pub fn status(&self) -> Status {
        Status::clone(
            &self
                .projection
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    /// `operator`, or the id of the project on the line.
    pub fn route(&self) -> String {
        self.linearize(|state| state.route.clone())
    }

    /// The route and the generation of the leg on it, read together.
    pub fn route_and_generation(&self) -> (String, u64) {
        self.linearize(|state| (state.route.clone(), state.leg.generation))
    }

    /// The name the page shows for whoever is on the line.
    pub fn route_label(&self) -> String {
        self.linearize(|state| state.route_label())
    }

    /// The project leg on the line; `None` on the operator.
    pub fn project_leg(&self) -> Option<ProjectLeg> {
        self.linearize(|state| state.project_leg())
    }

    /// True while a leg is coming up: from `begin_candidate` until its
    /// startup commits (`finish_intro`) or is rolled back. The leg on the
    /// line may already be the new one, adopted on its first sign of life,
    /// while the PBX still holds the leg before it.
    pub fn startup_in_flight(&self) -> bool {
        self.linearize(|state| state.startup_rollback.is_some())
    }

    /// The level the next project call is asked for when the caller names
    /// none.
    pub fn thinking_default(&self) -> String {
        self.linearize(|state| state.thinking_default.clone())
    }

    pub fn current_identity(&self) -> LegIdentity {
        self.linearize(|state| state.leg.clone())
    }

    pub fn generation(&self) -> u64 {
        self.current_identity().generation
    }

    /// Notifications for API workers waiting behind a live operation or
    /// candidate. The coordinator itself remains synchronous.
    pub fn operation_changed(&self) -> Arc<Notify> {
        Arc::clone(&self.operation_changed)
    }

    /// Applies a synchronous projection mutation only while the stamped leg
    /// generation is still current. The lifecycle lock covers both the check
    /// and mutation, so a rescue/adoption cannot land between them.
    pub fn with_generation<R>(&self, generation: u64, operation: impl FnOnce() -> R) -> Option<R> {
        self.linearize(|state| (state.leg.generation == generation).then(operation))
    }

    pub fn begin_prompt(&self, leg: &LegIdentity) -> Result<OperationIdentity, LifecycleError> {
        let id = self.next_operation.fetch_add(1, Ordering::Relaxed);
        self.linearize(|state| {
            if state.leg != *leg {
                return Err(LifecycleError::StaleLeg);
            }
            if matches!(state.phase, Phase::Quiescing | Phase::Shutdown) {
                return Err(if state.phase == Phase::Shutdown {
                    LifecycleError::Shutdown
                } else {
                    LifecycleError::WrongPhase
                });
            }
            if state.operation.is_some() {
                return Err(LifecycleError::OperationActive);
            }
            // Beginning a turn now would move the call out of `Starting` with
            // the candidate still staged, and a candidate the PBX no longer
            // sees starting is never adopted.
            if state.phase == Phase::Starting {
                return Err(LifecycleError::CandidateActive);
            }
            let operation = OperationIdentity {
                id,
                leg: leg.clone(),
                turn_id: None,
            };
            state.operation = Some(operation.clone());
            state.phase = Phase::TurnRunning;
            self.refresh_locked(state);
            self.operation_changed.notify_waiters();
            Ok(operation)
        })
    }

    /// Opens the operation for a self-woken project turn. Unlike an ordinary
    /// caller prompt, its host turn id is known before any module call arrives.
    pub fn begin_autonomous(
        &self,
        leg: &LegIdentity,
        turn_id: impl Into<String>,
    ) -> Result<OperationIdentity, LifecycleError> {
        let id = self.next_operation.fetch_add(1, Ordering::Relaxed);
        let turn_id = turn_id.into();
        self.linearize(|state| {
            if state.leg != *leg {
                return Err(LifecycleError::StaleLeg);
            }
            if state.phase != Phase::Active {
                return Err(if state.phase == Phase::Starting {
                    LifecycleError::CandidateActive
                } else {
                    LifecycleError::WrongPhase
                });
            }
            if state.operation.is_some() {
                return Err(LifecycleError::OperationActive);
            }
            let operation = OperationIdentity {
                id,
                leg: leg.clone(),
                turn_id: Some(turn_id),
            };
            state.operation = Some(operation.clone());
            state.phase = Phase::TurnRunning;
            self.refresh_locked(state);
            self.operation_changed.notify_waiters();
            Ok(operation)
        })
    }

    /// Binds the host's turn id to an operation opened for a caller prompt.
    /// Older hosts do not report a turn id and keep the legacy token check.
    pub fn bind_turn(&self, token: &str, turn_id: &str) -> Result<(), LifecycleError> {
        self.linearize(|state| {
            if state.leg.token != token || state.operation.is_none() {
                return Err(LifecycleError::StaleLeg);
            }
            let operation = state.operation.as_mut().expect("checked above");
            match operation.turn_id.as_deref() {
                Some(current) if current != turn_id => Err(LifecycleError::StaleLeg),
                Some(_) => Ok(()),
                None => {
                    operation.turn_id = Some(turn_id.to_owned());
                    Ok(())
                }
            }
        })
    }

    /// Closes the operation bound to host turn `turn_id` on the leg holding
    /// `token`: the host reported that turn settled. It is the same close as
    /// `finish_operation`, reached from the host's report instead of the
    /// prompt's return, so a run the host starts right behind the caller's
    /// turn (a resume after an external abort, a child's wake) is not refused
    /// as racing a turn that is already over. False when no such operation is
    /// open; its owner's later `finish_operation` is then a no-op.
    pub fn settle_turn(&self, token: &str, turn_id: &str) -> bool {
        self.linearize(|state| {
            // A new leg's intro is closed by `finish_intro`, which also ends
            // its startup; it is not this report's to close.
            let bound = state.leg.token == token
                && state.startup_rollback.is_none()
                && state
                    .operation
                    .as_ref()
                    .is_some_and(|operation| operation.turn_id.as_deref() == Some(turn_id));
            if !bound {
                return false;
            }
            self.close_operation_locked(state);
            true
        })
    }

    pub fn attach_steer(&self, leg: &LegIdentity) -> Result<OperationIdentity, LifecycleError> {
        self.linearize(|state| {
            if state.leg != *leg {
                return Err(LifecycleError::StaleLeg);
            }
            if !matches!(state.phase, Phase::TurnRunning | Phase::Active) {
                return Err(LifecycleError::WrongPhase);
            }
            state
                .operation
                .clone()
                .ok_or(LifecycleError::NoActiveOperation)
        })
    }

    pub fn finish_operation(&self, operation: &OperationIdentity) -> bool {
        self.linearize(|state| {
            // Match on the operation's id and leg, not the whole value:
            // `bind_turn` stamps the host turn id onto the live operation after
            // the owner took its copy, and that must not orphan the operation.
            let owns = state
                .operation
                .as_ref()
                .is_some_and(|current| current.id == operation.id && current.leg == operation.leg);
            if !owns {
                return false;
            }
            self.close_operation_locked(state);
            true
        })
    }

    fn close_operation_locked(&self, state: &mut CallLifecycle) {
        state.operation = None;
        if state.phase == Phase::TurnRunning {
            state.phase = state.resting_phase();
        }
        self.refresh_locked(state);
        self.operation_changed.notify_waiters();
    }

    pub fn begin_rescue(&self, reason: impl Into<String>) -> LegIdentity {
        let rescue = self.linearize(|state| self.rescue_locked(state, reason.into()));
        self.announce_rescue(&rescue);
        rescue.next
    }

    /// `begin_rescue`, only while `leg` is still the leg on the line and no
    /// startup is in flight; `None` rescues nothing. A control that decided on
    /// the leg it read earlier does not cancel work on a leg the caller has
    /// since moved to, nor on one the PBX does not hold yet. Returns
    /// the leg as the rescue left it: the same project, model, and session
    /// under a new identity.
    pub fn begin_rescue_of(
        &self,
        leg: &ProjectLeg,
        reason: impl Into<String>,
    ) -> Option<ProjectLeg> {
        let (rescue, rescued) = self.linearize(|state| {
            if state.phase == Phase::Shutdown
                || state.startup_rollback.is_some()
                || state.project_leg().as_ref() != Some(leg)
            {
                return None;
            }
            let rescue = self.rescue_locked(state, reason.into());
            Some((rescue, state.project_leg()?))
        })?;
        self.announce_rescue(&rescue);
        Some(rescued)
    }

    /// Retires the current leg. A rescue abandons any in-flight startup: a
    /// rescued candidate must never be adopted, and the browser must stop
    /// showing "connecting". A candidate already adopted on its first sign of
    /// life keeps the line, but its startup is over too: the rescue cancels
    /// the work that would have committed or rolled it back, so nothing is
    /// left for a late rollback to restore.
    fn rescue_locked(&self, state: &mut CallLifecycle, reason: String) -> Rescue {
        let abandoned = state.candidate.take();
        // The rescue retires the candidate's generation too, so work stamped
        // with the abandoned candidate's generation is stale after it.
        let retired = abandoned
            .as_ref()
            .map_or(state.leg.generation, |candidate| {
                candidate.identity.generation.max(state.leg.generation)
            });
        let abandoned_candidate = abandoned.map(|candidate| candidate.route);
        state.startup_rollback = None;
        let next_token = format!("{}-rescue-{}", state.leg.token, retired + 1);
        state.leg = LegIdentity::new(next_token, retired + 1);
        if state.phase != Phase::Shutdown {
            state.phase = Phase::Quiescing;
            state.operation = None;
            state.terminal_reason = Some(reason);
        }
        self.refresh_locked(state);
        self.operation_changed.notify_waiters();
        Rescue {
            abandoned_candidate,
            next: state.leg.clone(),
        }
    }

    /// Tells the presentation layer what a rescue ended. The clear notice
    /// carries the post-rescue generation.
    fn announce_rescue(&self, rescue: &Rescue) {
        if let Some(route) = &rescue.abandoned_candidate {
            self.notify_candidate(&CandidateNotice {
                route: route.clone(),
                generation: rescue.next.generation,
                ended: Some(CandidateEnd::Rescued),
            });
        }
        tracing::info!(
            generation = rescue.next.generation,
            abandoned_candidate = rescue.abandoned_candidate.as_deref(),
            "rescue retired the current leg"
        );
    }

    /// Ends the quiet a rescue left: a `Quiescing` call comes to rest on the
    /// route it is on, and callbacks and steers are admitted again. Every
    /// page control settles on its way out, and so does every delivered turn,
    /// including one that was refused. Returns the status to publish.
    pub fn settle(&self) -> Status {
        self.linearize(|state| {
            if state.phase == Phase::Quiescing {
                state.phase = state.resting_phase();
            }
            self.refresh_locked(state);
            state.status(&self.config)
        })
    }

    /// The caller is back on the operator: the project, its model, session,
    /// thinking, and catalog are gone with its leg. A call at rest or
    /// quiescing is now at rest on the operator; a turn still running (the
    /// operator is being told why the caller came back) settles when it ends.
    ///
    /// The project leg's token is retired with it. The leg takes the
    /// operator's identity at the same generation, so a callback still
    /// carrying the project's token (a module call already in flight) is
    /// refused rather than taken as the operator's.
    pub fn return_to_operator(&self) {
        self.linearize(|state| {
            if !state.on_operator() {
                state.leg = LegIdentity::new(OPERATOR, state.leg.generation);
            }
            state.route = OPERATOR.into();
            state.project = None;
            state.persistent_session_id.clear();
            state.model.clear();
            state.thinking_requested.clear();
            state.thinking_effective.clear();
            state.catalog = None;
            if matches!(state.phase, Phase::Quiescing | Phase::Active) {
                state.phase = Phase::Operator;
            }
            self.refresh_locked(state);
        });
    }

    /// `/thinking`: the level the next project call is asked for when the
    /// caller names none.
    pub fn set_thinking_default(&self, level: &str) {
        self.linearize(|state| {
            state.thinking_default = level.to_owned();
            self.refresh_locked(state);
        });
    }

    /// Stages `candidate` and returns the identity it is staged under, the
    /// one an adoption puts on the line: its first turn is delivered at that
    /// generation.
    pub fn begin_candidate(
        &self,
        mut candidate: CandidateLeg,
    ) -> Result<LegIdentity, LifecycleError> {
        self.linearize(|state| {
            if state.phase == Phase::Shutdown {
                return Err(LifecycleError::Shutdown);
            }
            if state.candidate.is_some() || matches!(state.phase, Phase::Starting) {
                return Err(LifecycleError::CandidateActive);
            }
            if candidate.identity.token.trim().is_empty() {
                return Err(LifecycleError::CandidateTokenMismatch);
            }
            candidate.identity.generation = state.leg.generation + 1;
            state.startup_rollback = Some(StartupRollback {
                route: state.route.clone(),
                project: state.project.clone(),
                persistent_session_id: state.persistent_session_id.clone(),
                leg: state.leg.clone(),
                model: state.model.clone(),
                thinking_requested: state.thinking_requested.clone(),
                thinking_effective: state.thinking_effective.clone(),
                catalog: state.catalog.clone(),
            });
            state.phase = Phase::Starting;
            let route = candidate.route.clone();
            let identity = candidate.identity.clone();
            state.candidate = Some(candidate);
            self.notify_candidate(&CandidateNotice {
                route,
                generation: state.leg.generation,
                ended: None,
            });
            self.operation_changed.notify_waiters();
            Ok(identity)
        })
    }

    pub fn is_candidate(&self) -> bool {
        self.linearize(|state| matches!(state.phase, Phase::Starting))
    }

    /// Register a resident session that may continue while another agent is
    /// foreground. Its token is still valid for display and request calls, but
    /// not for speech.
    pub fn register_background(&self, project: impl Into<String>, token: impl Into<String>) {
        let _owner = self
            .background_owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.linearize(|state| {
            state.background_tokens.insert(token.into(), project.into());
        });
    }

    pub fn remove_background(&self, token: &str) {
        let _owner = self
            .background_owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.linearize(|state| {
            state.background_tokens.remove(token);
        });
    }

    /// Runs one background projection mutation while owning the token's
    /// lifecycle check. Promotion/removal cannot happen between the check and
    /// the mutation, so a request or held display cannot land on a foreground
    /// session.
    pub fn with_background<R>(&self, token: &str, operation: impl FnOnce(&str) -> R) -> Option<R> {
        let _owner = self
            .background_owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.linearize(|state| {
            let project = state.background_tokens.get(token)?.clone();
            Some(operation(&project))
        })
    }

    pub fn project_is_background(&self, project: &str) -> bool {
        self.linearize(|state| state.background_tokens.values().any(|name| name == project))
    }

    pub fn is_background(&self, token: &str) -> bool {
        self.linearize(|state| state.background_tokens.contains_key(token))
    }

    pub fn accept_side_effect(
        &self,
        token: &str,
        turn_id: Option<&str>,
        turn_cause: Option<&str>,
    ) -> Result<(), LifecycleError> {
        self.linearize(|state| {
            if state.background_tokens.contains_key(token) {
                return Ok(());
            }
            if matches!(state.phase, Phase::Starting) {
                return Err(LifecycleError::CandidateSideEffect);
            }
            if matches!(state.phase, Phase::Quiescing | Phase::Shutdown) {
                return Err(LifecycleError::StaleLeg);
            }
            // The operator's leg has an identity of its own: a project leg's
            // token is retired when the caller comes back
            // (`return_to_operator`), so it cannot speak for the operator.
            if state.on_operator() {
                if token.is_empty() || token == state.leg.token {
                    return Ok(());
                }
                return Err(LifecycleError::StaleLeg);
            }
            if token.is_empty() || state.leg.token != token {
                return Err(LifecycleError::StaleLeg);
            }
            let Some(operation) = state.operation.as_ref() else {
                return Err(LifecycleError::StaleLeg);
            };
            // A self-woken call without a host turn authority must never use a
            // caller operation that happened to win the race. Older hosts do
            // not report a cause, so their ordinary caller calls retain the
            // old token-only behavior.
            if turn_cause.is_some_and(|cause| cause == "autonomous" || cause == "unknown") {
                let Some(turn_id) = turn_id else {
                    return Err(LifecycleError::StaleLeg);
                };
                if operation.turn_id.as_deref() != Some(turn_id) {
                    return Err(LifecycleError::StaleLeg);
                }
            } else if let Some(expected) = operation.turn_id.as_deref() {
                if turn_id != Some(expected) {
                    return Err(LifecycleError::StaleLeg);
                }
            }
            Ok(())
        })
    }

    pub fn accept_thinking_callback(
        &self,
        token: &str,
        thinking: &str,
    ) -> Result<bool, LifecycleError> {
        self.linearize(|state| {
            if !THINKING_LEVELS.contains(&thinking) {
                return Err(LifecycleError::WrongPhase);
            }
            if let Some(candidate) = state.candidate.as_mut() {
                if candidate.identity.token == token && matches!(state.phase, Phase::Starting) {
                    candidate.startup_thinking = thinking.to_owned();
                    return Ok(false);
                }
            }
            if state.leg.token != token || matches!(state.phase, Phase::Quiescing | Phase::Shutdown)
            {
                return Err(LifecycleError::StaleLeg);
            }
            state.thinking_effective = thinking.to_owned();
            self.refresh_locked(state);
            Ok(true)
        })
    }

    /// The generation, read together with the route of the leg on the line
    /// if an adoption put it there at that generation and nothing has
    /// replaced it since: no rescue or return to the operator,
    /// each of which gives the line a new identity. A reconnecting browser is
    /// told of the adoption, because it may hold speech recorded while that
    /// leg was connecting (see `CandidateNotice`).
    pub fn generation_and_adoption(&self) -> (u64, Option<String>) {
        self.linearize(|state| {
            let adopted = (state.adopted.as_ref() == Some(&state.leg)).then(|| state.route.clone());
            (state.leg.generation, adopted)
        })
    }

    pub fn candidate_identity(&self) -> Option<LegIdentity> {
        self.linearize(|state| {
            state
                .candidate
                .as_ref()
                .map(|candidate| candidate.identity.clone())
        })
    }

    /// Classifies activity from the process started for `leg`. The operator's
    /// process is started for the leg `operator`; a project leg's, for its
    /// session token.
    pub fn classify_activity(&self, leg: &str) -> ActivityDisposition {
        self.linearize(|state| {
            let candidate = state.candidate.as_ref();
            if state.phase == Phase::Starting
                && candidate.is_some_and(|candidate| candidate.identity.token == leg)
            {
                return ActivityDisposition::Promote;
            }
            if matches!(state.phase, Phase::Quiescing | Phase::Shutdown) {
                return ActivityDisposition::Discard;
            }
            let current = if state.on_operator() {
                OPERATOR
            } else {
                state.leg.token.as_str()
            };
            if leg == current {
                ActivityDisposition::Publish
            } else {
                ActivityDisposition::Discard
            }
        })
    }

    /// Adopts the staged candidate if it is the leg `token` names: the PBX
    /// once its intro turn ends, or a sign of life from the candidate itself.
    #[cfg(test)]
    pub(crate) fn set_candidate_token_for_test(&self, token: &str) {
        self.linearize(|state| {
            if let Some(candidate) = state.candidate.as_mut() {
                candidate.identity.token = token.to_owned();
            }
        });
    }

    pub fn adopt_candidate(&self, token: &str) -> Result<LegIdentity, LifecycleError> {
        self.linearize(|state| {
            let candidate = match state
                .candidate
                .take_if(|candidate| candidate.identity.token == token)
            {
                Some(candidate) => candidate,
                None if state.candidate.is_some() => {
                    return Err(LifecycleError::CandidateTokenMismatch)
                }
                None => return Err(LifecycleError::NoCandidate),
            };
            let identity = candidate.identity.clone();
            let route = candidate.route.clone();
            state.route = candidate.route;
            state.project = Some(candidate.project);
            state.persistent_session_id = candidate.persistent_session_id;
            state.leg = identity.clone();
            state.phase = Phase::TurnRunning;
            state.model = candidate.model;
            state.thinking_requested = candidate.thinking;
            // Confirmed only by the leg's own report: what it was asked for
            // is not what it runs at when its model clamps the level.
            state.thinking_effective =
                if THINKING_LEVELS.contains(&candidate.startup_thinking.as_str()) {
                    candidate.startup_thinking
                } else {
                    String::new()
                };
            state.operation = Some(OperationIdentity {
                id: self.next_operation.fetch_add(1, Ordering::Relaxed),
                leg: identity.clone(),
                turn_id: None,
            });
            state.terminal_reason = None;
            state.catalog = candidate.catalog;
            state.adopted = Some(identity.clone());
            self.notify_candidate(&CandidateNotice {
                route,
                generation: identity.generation,
                ended: Some(CandidateEnd::Adopted),
            });
            self.refresh_locked(state);
            self.operation_changed.notify_waiters();
            Ok(identity)
        })
    }

    pub fn finish_intro(&self) -> bool {
        self.linearize(|state| {
            if state.startup_rollback.is_none() || state.phase != Phase::TurnRunning {
                return false;
            }
            state.operation = None;
            state.phase = Phase::Active;
            state.startup_rollback = None;
            self.refresh_locked(state);
            self.operation_changed.notify_waiters();
            true
        })
    }

    pub fn rollback_startup(&self, reason: impl Into<String>) -> bool {
        self.linearize(|state| {
            if let Some(candidate) = state.candidate.take() {
                state.startup_rollback = None;
                state.terminal_reason = Some(reason.into());
                state.phase = state.resting_phase();
                self.notify_candidate(&CandidateNotice {
                    route: candidate.route,
                    generation: state.leg.generation,
                    ended: Some(CandidateEnd::RolledBack),
                });
                self.refresh_locked(state);
                return true;
            }
            let Some(previous) = state.startup_rollback.take() else {
                return false;
            };
            let generation = state.leg.generation;
            let abandoned_route = std::mem::replace(&mut state.route, previous.route);
            state.project = previous.project;
            state.persistent_session_id = previous.persistent_session_id;
            state.leg = LegIdentity::new(previous.leg.token, generation);
            state.phase = state.resting_phase();
            state.model = previous.model;
            state.thinking_requested = previous.thinking_requested;
            state.thinking_effective = previous.thinking_effective;
            state.operation = None;
            state.terminal_reason = Some(reason.into());
            state.catalog = previous.catalog;
            self.notify_candidate(&CandidateNotice {
                route: abandoned_route,
                generation: state.leg.generation,
                ended: Some(CandidateEnd::RolledBack),
            });
            self.refresh_locked(state);
            true
        })
    }

    pub fn begin_shutdown(&self) -> bool {
        self.linearize(|state| {
            if state.phase == Phase::Shutdown {
                false
            } else {
                state.phase = Phase::Shutdown;
                state.operation = None;
                state.background_tokens.clear();
                let next_token =
                    format!("{}-shutdown-{}", state.leg.token, state.leg.generation + 1);
                state.leg = LegIdentity::new(next_token, state.leg.generation + 1);
                self.refresh_locked(state);
                true
            }
        })
    }

    pub fn finish_shutdown(&self) {
        self.linearize(|state| state.terminal_reason = Some("shutdown".into()));
    }
}

#[cfg(test)]
#[path = "../tests/test_lifecycle.rs"]
mod tests;

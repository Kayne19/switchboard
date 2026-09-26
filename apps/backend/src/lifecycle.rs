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
use crate::protocol::{ModelEntry, Status};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

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

/// The project leg on the line, read in one piece. Every adoption, rescue,
/// and idle return gives the leg a new identity, and a return to the operator
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
/// The browser shows "connecting to {route}" while a notice is active and
/// resubmits speech recorded during that window once the epoch moves; the
/// clear notice arrives on adoption, rollback, and rescue.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandidateNotice {
    pub route: String,
    pub generation: u64,
    pub active: bool,
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
    abandoned_candidate: bool,
    route: String,
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
    last_activity: Instant,
    operation: Option<OperationIdentity>,
    terminal_reason: Option<String>,
    candidate: Option<CandidateLeg>,
    startup_rollback: Option<StartupRollback>,
    /// The catalog the project leg launched with.
    catalog: Option<Arc<ModelCatalog>>,
}

impl CallLifecycle {
    fn operator(thinking_default: String) -> Self {
        Self {
            route: OPERATOR.into(),
            project: None,
            persistent_session_id: String::new(),
            leg: LegIdentity::new("operator", 0),
            phase: Phase::Operator,
            model: String::new(),
            thinking_requested: String::new(),
            thinking_effective: String::new(),
            thinking_default,
            last_activity: Instant::now(),
            operation: None,
            terminal_reason: None,
            candidate: None,
            startup_rollback: None,
            catalog: None,
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
    on_candidate: Arc<Mutex<Option<CandidateCallback>>>,
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
            on_candidate: Arc::new(Mutex::new(None)),
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
            let operation = OperationIdentity {
                id,
                leg: leg.clone(),
            };
            state.operation = Some(operation.clone());
            state.phase = Phase::TurnRunning;
            state.last_activity = Instant::now();
            self.refresh_locked(state);
            Ok(operation)
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
            state.last_activity = Instant::now();
            state
                .operation
                .clone()
                .ok_or(LifecycleError::NoActiveOperation)
        })
    }

    pub fn finish_operation(&self, operation: &OperationIdentity) -> bool {
        self.linearize(|state| {
            if state.operation.as_ref() != Some(operation) {
                return false;
            }
            state.operation = None;
            state.last_activity = Instant::now();
            if state.phase == Phase::TurnRunning {
                state.phase = state.resting_phase();
            }
            self.refresh_locked(state);
            true
        })
    }

    pub fn begin_rescue(&self, reason: impl Into<String>) -> LegIdentity {
        let rescue = self.linearize(|state| self.rescue_locked(state, reason.into()));
        self.announce_rescue(&rescue);
        rescue.next
    }

    /// `begin_rescue`, only while `leg` is still the leg on the line; `None`
    /// rescues nothing. A control that decided on the leg it read earlier
    /// does not cancel work on a leg the caller has since moved to. Returns
    /// the leg as the rescue left it: the same project, model, and session
    /// under a new identity.
    pub fn begin_rescue_of(
        &self,
        leg: &ProjectLeg,
        reason: impl Into<String>,
    ) -> Option<ProjectLeg> {
        let (rescue, rescued) = self.linearize(|state| {
            if state.phase == Phase::Shutdown || state.project_leg().as_ref() != Some(leg) {
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
    /// showing "connecting".
    fn rescue_locked(&self, state: &mut CallLifecycle, reason: String) -> Rescue {
        let abandoned_candidate = state.candidate.take().is_some();
        let route = state.route.clone();
        let next_token = format!("{}-rescue-{}", state.leg.token, state.leg.generation + 1);
        state.leg = LegIdentity::new(next_token, state.leg.generation + 1);
        if state.phase != Phase::Shutdown {
            state.phase = Phase::Quiescing;
            state.operation = None;
            state.terminal_reason = Some(reason);
        }
        self.refresh_locked(state);
        Rescue {
            abandoned_candidate,
            route,
            next: state.leg.clone(),
        }
    }

    /// Tells the presentation layer what a rescue ended. The clear notice
    /// carries the post-rescue generation.
    fn announce_rescue(&self, rescue: &Rescue) {
        if rescue.abandoned_candidate {
            self.notify_candidate(&CandidateNotice {
                route: rescue.route.clone(),
                generation: rescue.next.generation,
                active: false,
            });
        }
        tracing::info!(
            generation = rescue.next.generation,
            abandoned_candidate = rescue.abandoned_candidate,
            "rescue retired the current leg"
        );
    }

    /// Caller or agent activity outside a turn boundary: a clip arriving, a
    /// reply being spoken. Starting, steering, and ending a turn count on
    /// their own; the idle timeout measures silence from the latest of these.
    pub fn touch_activity(&self) {
        self.linearize(|state| state.last_activity = Instant::now());
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
    pub fn return_to_operator(&self) {
        self.linearize(|state| {
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

    pub fn begin_candidate(&self, mut candidate: CandidateLeg) -> Result<(), LifecycleError> {
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
            state.candidate = Some(candidate);
            self.notify_candidate(&CandidateNotice {
                route,
                generation: state.leg.generation,
                active: true,
            });
            Ok(())
        })
    }

    pub fn is_candidate(&self) -> bool {
        self.linearize(|state| matches!(state.phase, Phase::Starting))
    }

    pub fn accept_side_effect(&self, token: &str) -> Result<(), LifecycleError> {
        self.linearize(|state| {
            if matches!(state.phase, Phase::Starting) {
                return Err(LifecycleError::CandidateSideEffect);
            }
            if matches!(state.phase, Phase::Quiescing | Phase::Shutdown) {
                return Err(LifecycleError::StaleLeg);
            }
            if state.on_operator() {
                if token.is_empty() || token == state.leg.token {
                    return Ok(());
                }
                return Err(LifecycleError::StaleLeg);
            }
            if token.is_empty() || state.leg.token != token || state.operation.is_none() {
                return Err(LifecycleError::StaleLeg);
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
            });
            state.terminal_reason = None;
            state.catalog = candidate.catalog;
            self.notify_candidate(&CandidateNotice {
                route,
                generation: identity.generation,
                active: false,
            });
            self.refresh_locked(state);
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
            state.last_activity = Instant::now();
            self.refresh_locked(state);
            true
        })
    }

    pub fn rollback_startup(&self, reason: impl Into<String>) -> bool {
        self.linearize(|state| {
            if state.candidate.take().is_some() {
                state.startup_rollback = None;
                state.terminal_reason = Some(reason.into());
                state.phase = state.resting_phase();
                self.notify_candidate(&CandidateNotice {
                    route: state.route.clone(),
                    generation: state.leg.generation,
                    active: false,
                });
                self.refresh_locked(state);
                return true;
            }
            let Some(previous) = state.startup_rollback.take() else {
                return false;
            };
            let generation = state.leg.generation;
            state.route = previous.route;
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
                route: state.route.clone(),
                generation: state.leg.generation,
                active: false,
            });
            self.refresh_locked(state);
            true
        })
    }

    pub fn return_if_idle(&self, timeout: std::time::Duration) -> Option<LegIdentity> {
        self.linearize(|state| {
            if state.on_operator()
                || state.operation.is_some()
                || state.candidate.is_some()
                || state.last_activity.elapsed() < timeout
                || matches!(state.phase, Phase::Quiescing | Phase::Shutdown)
            {
                return None;
            }
            state.phase = Phase::Quiescing;
            state.operation = None;
            let next_token = format!("{}-idle-{}", state.leg.token, state.leg.generation + 1);
            state.leg = LegIdentity::new(next_token, state.leg.generation + 1);
            self.refresh_locked(state);
            Some(state.leg.clone())
        })
    }

    pub fn begin_shutdown(&self) -> bool {
        self.linearize(|state| {
            if state.phase == Phase::Shutdown {
                false
            } else {
                state.phase = Phase::Shutdown;
                state.operation = None;
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

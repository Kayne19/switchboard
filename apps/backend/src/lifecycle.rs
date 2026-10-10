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
//!
//! The call is one value, a `Line` (`call_line.rs`), whose phases carry
//! what exists only in them. `Line::next` is its one transition function and
//! `CallLifecycle::step` its one writer; each public transition below is
//! one event through them.

use crate::call_line::{Event, Line, LiveLeg, RescueOf, OPERATOR};
use crate::models::{ModelCatalog, THINKING_LEVELS};
use crate::protocol::{CandidateEnd, Status};
use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::Notify;

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

struct CallLifecycle {
    line: Line,
    /// The level the next project call is asked for when the caller names
    /// none. `/thinking` changes it.
    thinking_default: String,
    /// Tokens belonging to resident sessions that are not foreground.
    background_tokens: HashMap<String, String>,
}

impl CallLifecycle {
    /// The one writer of the call line: moves it by `event`, or leaves it
    /// as it is if the event is refused. Returns the notice the move owes
    /// the browser.
    fn step(&mut self, event: Event) -> Result<Option<CandidateNotice>, LifecycleError> {
        let (line, notice) = self.line.next(event)?;
        self.line = line;
        Ok(notice)
    }

    fn status(&self, config: &StatusConfig) -> Status {
        self.line.leg().status(config, &self.thinking_default)
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
        let lifecycle = CallLifecycle {
            line: Line::at_rest(LiveLeg::operator()),
            thinking_default: thinking_default.into(),
            background_tokens: HashMap::new(),
        };
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

    fn linearize<R>(&self, operation: impl FnOnce(&mut CallLifecycle) -> R) -> R {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        operation(&mut state)
    }

    /// Moves the call line by `event` under the state lock, then, still
    /// under it, sends the candidate notice the move owes the browser,
    /// refreshes the status projection, and wakes the turns waiting to be
    /// admitted. A refused event does none of that.
    fn step_locked(
        &self,
        state: &mut CallLifecycle,
        event: Event,
    ) -> Result<Option<CandidateNotice>, LifecycleError> {
        let notice = state.step(event)?;
        if let Some(notice) = &notice {
            self.notify_candidate(notice);
        }
        self.refresh_locked(state);
        self.operation_changed.notify_waiters();
        Ok(notice)
    }

    fn refresh_locked(&self, state: &CallLifecycle) {
        let projection = Arc::new(state.status(&self.config));
        *self
            .projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = projection;
    }

    fn step(&self, event: Event) -> Result<Option<CandidateNotice>, LifecycleError> {
        self.linearize(|state| self.step_locked(state, event))
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
        self.linearize(|state| state.line.leg().route().to_owned())
    }

    /// The route and the generation of the leg on it, read together.
    pub fn route_and_generation(&self) -> (String, u64) {
        self.linearize(|state| {
            let leg = state.line.leg();
            (leg.route().to_owned(), leg.identity.generation)
        })
    }

    /// The name the page shows for whoever is on the line.
    pub fn route_label(&self) -> String {
        self.linearize(|state| state.line.leg().label())
    }

    /// The project leg on the line; `None` on the operator.
    pub fn project_leg(&self) -> Option<ProjectLeg> {
        self.linearize(|state| state.line.leg().project_leg())
    }

    /// True while a leg is coming up: from `begin_candidate` until its
    /// startup commits (`finish_intro`) or is rolled back. The leg on the
    /// line may already be the new one, adopted on its first sign of life,
    /// while the PBX still holds the leg before it.
    pub fn startup_in_flight(&self) -> bool {
        self.linearize(|state| matches!(state.line, Line::Starting { .. } | Line::Adopted { .. }))
    }

    /// The level the next project call is asked for when the caller names
    /// none.
    pub fn thinking_default(&self) -> String {
        self.linearize(|state| state.thinking_default.clone())
    }

    pub fn current_identity(&self) -> LegIdentity {
        self.linearize(|state| state.line.leg().identity.clone())
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
        self.linearize(|state| (state.line.leg().identity.generation == generation).then(operation))
    }

    pub fn begin_prompt(&self, leg: &LegIdentity) -> Result<OperationIdentity, LifecycleError> {
        let operation = OperationIdentity {
            id: self.next_operation.fetch_add(1, Ordering::Relaxed),
            leg: leg.clone(),
            turn_id: None,
        };
        self.step(Event::BeginPrompt(operation.clone()))?;
        Ok(operation)
    }

    /// Opens the operation for a self-woken project turn. Unlike an ordinary
    /// caller prompt, its host turn id is known before any module call arrives.
    pub fn begin_autonomous(
        &self,
        leg: &LegIdentity,
        turn_id: impl Into<String>,
    ) -> Result<OperationIdentity, LifecycleError> {
        let operation = OperationIdentity {
            id: self.next_operation.fetch_add(1, Ordering::Relaxed),
            leg: leg.clone(),
            turn_id: Some(turn_id.into()),
        };
        self.step(Event::BeginAutonomous(operation.clone()))?;
        Ok(operation)
    }

    /// Binds the host's turn id to an operation opened for a caller prompt.
    /// Older hosts do not report a turn id and keep the legacy token check.
    pub fn bind_turn(&self, token: &str, turn_id: &str) -> Result<(), LifecycleError> {
        self.step(Event::BindTurn { token, turn_id }).map(drop)
    }

    /// Closes the operation bound to host turn `turn_id` on the leg holding
    /// `token`: the host reported that turn settled. It is the same close as
    /// `finish_operation`, reached from the host's report instead of the
    /// prompt's return, so a run the host starts right behind the caller's
    /// turn (a resume after an external abort, a child's wake) is not refused
    /// as racing a turn that is already over. False when no such operation is
    /// open; its owner's later `finish_operation` is then a no-op.
    pub fn settle_turn(&self, token: &str, turn_id: &str) -> bool {
        self.step(Event::SettleTurn { token, turn_id }).is_ok()
    }

    pub fn attach_steer(&self, leg: &LegIdentity) -> Result<OperationIdentity, LifecycleError> {
        self.linearize(|state| {
            if state.line.leg().identity != *leg {
                return Err(LifecycleError::StaleLeg);
            }
            match &state.line {
                Line::Open { turn, .. } | Line::Adopted { turn, .. } => {
                    turn.clone().ok_or(LifecycleError::NoActiveOperation)
                }
                Line::Starting { .. } | Line::Quiescing { .. } | Line::Shutdown { .. } => {
                    Err(LifecycleError::WrongPhase)
                }
            }
        })
    }

    pub fn finish_operation(&self, operation: &OperationIdentity) -> bool {
        self.step(Event::FinishOperation(operation)).is_ok()
    }

    /// Retires the leg on the line: the call quiesces under a new identity
    /// until it settles. A rescue abandons any in-flight startup: a rescued
    /// candidate must never be adopted, and the browser must stop showing
    /// "connecting". A candidate already adopted on its first sign of life
    /// keeps the line, but its startup is over too: the rescue cancels the
    /// work that would have committed or rolled it back, so nothing is left
    /// for a late rollback to restore.
    fn rescue(&self, of: RescueOf, reason: String) -> Option<LegIdentity> {
        let (notice, next) = self.linearize(|state| {
            let notice = self.step_locked(state, Event::Rescue(of)).ok()?;
            Some((notice, state.line.leg().identity.clone()))
        })?;
        tracing::info!(
            %reason,
            generation = next.generation,
            abandoned_candidate = notice.as_ref().map(|notice| notice.route.as_str()),
            "rescue retired the current leg"
        );
        Some(next)
    }

    pub fn begin_rescue(&self, reason: impl Into<String>) -> LegIdentity {
        self.rescue(RescueOf::Line, reason.into())
            .expect("a rescue of the line is admitted in every phase")
    }

    /// `begin_rescue`, only while the call is still at `generation`; `None`
    /// rescues nothing. A page control carries the generation the page held
    /// when the caller acted, so one meant for a leg the call has since left
    /// does not rescue the leg it moved to (#263).
    pub fn begin_rescue_at(
        &self,
        generation: u64,
        reason: impl Into<String>,
    ) -> Option<LegIdentity> {
        self.rescue(RescueOf::Generation(generation), reason.into())
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
        let identity = self.rescue(RescueOf::Leg(leg), reason.into())?;
        Some(ProjectLeg {
            identity,
            ..leg.clone()
        })
    }

    /// Ends the quiet a rescue left: a `Quiescing` call comes to rest on the
    /// route it is on, and callbacks and steers are admitted again. Every
    /// page control settles on its way out, and so does every delivered turn,
    /// including one that was refused. Returns the status to publish.
    pub fn settle(&self) -> Status {
        self.linearize(|state| {
            self.step_locked(state, Event::Settle)
                .expect("a settle is admitted in every phase");
            state.status(&self.config)
        })
    }

    /// The caller is back on the operator: the project, its model, session,
    /// thinking, and catalog are gone with its leg, and so is its token. The
    /// line takes the operator's identity at the same generation.
    pub fn return_to_operator(&self) {
        self.step(Event::ReturnToOperator)
            .expect("a return to the operator is admitted in every phase");
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
    pub fn begin_candidate(&self, candidate: CandidateLeg) -> Result<LegIdentity, LifecycleError> {
        self.linearize(|state| {
            self.step_locked(state, Event::BeginCandidate(candidate))?;
            Ok(state
                .line
                .candidate()
                .expect("a candidate is staged")
                .identity
                .clone())
        })
    }

    pub fn is_candidate(&self) -> bool {
        self.linearize(|state| matches!(state.line, Line::Starting { .. }))
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
            let (leg, turn) = match &state.line {
                Line::Starting { .. } => return Err(LifecycleError::CandidateSideEffect),
                Line::Quiescing { .. } | Line::Shutdown { .. } => {
                    return Err(LifecycleError::StaleLeg)
                }
                Line::Open { leg, turn } | Line::Adopted { leg, turn, .. } => (leg, turn),
            };
            // The operator's leg has an identity of its own: a project leg's
            // token is retired when the caller comes back
            // (`return_to_operator`), so it cannot speak for the operator.
            if leg.launch.is_none() {
                if token.is_empty() || token == leg.identity.token {
                    return Ok(());
                }
                return Err(LifecycleError::StaleLeg);
            }
            if token.is_empty() || leg.identity.token != token {
                return Err(LifecycleError::StaleLeg);
            }
            let Some(operation) = turn else {
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

    /// The leg `token` reports the level it runs at: kept private for a
    /// starting candidate (`Ok(false)`), shown for the leg on the line
    /// (`Ok(true)`).
    pub fn accept_thinking_callback(
        &self,
        token: &str,
        thinking: &str,
    ) -> Result<bool, LifecycleError> {
        if !THINKING_LEVELS.contains(&thinking) {
            return Err(LifecycleError::WrongPhase);
        }
        self.linearize(|state| {
            let startup = Event::StartupThinking {
                token,
                level: thinking,
            };
            if self.step_locked(state, startup).is_ok() {
                return Ok(false);
            }
            let leg = Event::LegThinking {
                token,
                level: thinking,
            };
            self.step_locked(state, leg).map(|_| true)
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
            let leg = state.line.leg();
            let adopted = leg.adopted.then(|| leg.route().to_owned());
            (leg.identity.generation, adopted)
        })
    }

    pub fn candidate_identity(&self) -> Option<LegIdentity> {
        self.linearize(|state| {
            state
                .line
                .candidate()
                .map(|candidate| candidate.identity.clone())
        })
    }

    /// Classifies activity from the process started for `leg`. The operator's
    /// process is started for the leg `operator`; a project leg's, for its
    /// session token.
    pub fn classify_activity(&self, leg: &str) -> ActivityDisposition {
        self.linearize(|state| {
            let on_line = match &state.line {
                Line::Starting { candidate, .. } if candidate.identity.token == leg => {
                    return ActivityDisposition::Promote
                }
                Line::Quiescing { .. } | Line::Shutdown { .. } => {
                    return ActivityDisposition::Discard
                }
                Line::Open { leg, .. } | Line::Starting { leg, .. } | Line::Adopted { leg, .. } => {
                    leg
                }
            };
            let current = if on_line.launch.is_none() {
                OPERATOR
            } else {
                on_line.identity.token.as_str()
            };
            if leg == current {
                ActivityDisposition::Publish
            } else {
                ActivityDisposition::Discard
            }
        })
    }

    /// Gives the staged candidate another token, so a test can make its
    /// adoption fail. It edits the candidate in place: a test-only writer.
    #[cfg(test)]
    pub(crate) fn set_candidate_token_for_test(&self, token: &str) {
        self.linearize(|state| {
            if let Line::Starting { candidate, .. } = &mut state.line {
                candidate.identity.token = token.to_owned();
            }
        });
    }

    /// Adopts the staged candidate if it is the leg `token` names: the PBX
    /// once its intro turn ends, or a sign of life from the candidate itself.
    pub fn adopt_candidate(&self, token: &str) -> Result<LegIdentity, LifecycleError> {
        let intro = self.next_operation.fetch_add(1, Ordering::Relaxed);
        self.linearize(|state| {
            self.step_locked(state, Event::Adopt { token, intro })?;
            Ok(state.line.leg().identity.clone())
        })
    }

    pub fn finish_intro(&self) -> bool {
        self.step(Event::FinishIntro).is_ok()
    }

    /// Rolls back the startup staged at `generation`, if it is still in
    /// flight: the line goes back to the leg before it. False if that
    /// startup has already ended (committed, rescued, rolled back) or
    /// another is in flight.
    pub fn rollback_startup(&self, generation: u64, reason: impl Into<String>) -> bool {
        let Ok(Some(notice)) = self.step(Event::Rollback { generation }) else {
            return false;
        };
        tracing::info!(route = %notice.route, reason = %reason.into(), "a startup was rolled back");
        true
    }

    pub fn begin_shutdown(&self) -> bool {
        self.linearize(|state| {
            if self.step_locked(state, Event::BeginShutdown).is_err() {
                return false;
            }
            state.background_tokens.clear();
            true
        })
    }
}

#[cfg(test)]
#[path = "../tests/test_lifecycle.rs"]
mod tests;

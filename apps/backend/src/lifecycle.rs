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
//! The call is one value, a `Line`, whose phases carry what exists only in
//! them: the staged candidate, the leg a startup would restore, the turn
//! open on the leg. `Line::next` is its one transition function and
//! `CallLifecycle::step` its one writer; each public transition below is
//! one event through them.

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

/// What a project leg was launched with. The operator has none: its model
/// is a deployment setting (`StatusConfig::operator_model`).
#[derive(Clone, Debug)]
struct Launch {
    route: String,
    project: String,
    /// The pi session the leg writes; a redial that keeps context reopens it.
    persistent_session_id: String,
    /// The model spec the leg was started with.
    model: String,
    thinking_requested: String,
    /// The catalog the leg launched with.
    catalog: Option<Arc<ModelCatalog>>,
}

/// The leg on the line. Every phase of the call has one.
#[derive(Clone, Debug)]
struct LiveLeg {
    identity: LegIdentity,
    /// What the project leg was launched with; `None` on the operator.
    launch: Option<Launch>,
    /// The level the leg reported through `/leg-state`; empty until it does.
    thinking_effective: String,
    /// The identity is the one an adoption put on the line. Every other
    /// identity (a rescue's, a rollback's, a return's, a shutdown's) is not.
    adopted: bool,
}

impl LiveLeg {
    fn operator() -> Self {
        Self {
            identity: LegIdentity::new(OPERATOR, 0),
            launch: None,
            thinking_effective: String::new(),
            adopted: false,
        }
    }

    /// The leg an adoption puts on the line. Its level is confirmed only by
    /// its own report: what it was asked for is not what it runs at when
    /// its model clamps the level.
    fn adopted(candidate: &CandidateLeg) -> Self {
        Self {
            identity: candidate.identity.clone(),
            launch: Some(Launch {
                route: candidate.route.clone(),
                project: candidate.project.clone(),
                persistent_session_id: candidate.persistent_session_id.clone(),
                model: candidate.model.clone(),
                thinking_requested: candidate.thinking.clone(),
                catalog: candidate.catalog.clone(),
            }),
            thinking_effective: if THINKING_LEVELS.contains(&candidate.startup_thinking.as_str()) {
                candidate.startup_thinking.clone()
            } else {
                String::new()
            },
            adopted: true,
        }
    }

    /// The same leg under a new identity.
    fn renamed(&self, identity: LegIdentity) -> Self {
        Self {
            identity,
            adopted: false,
            ..self.clone()
        }
    }

    /// The same leg, its work retired at `generation`: a rescue or a
    /// shutdown.
    fn retired(&self, why: &str, generation: u64) -> Self {
        let token = format!("{}-{why}-{generation}", self.identity.token);
        self.renamed(LegIdentity::new(token, generation))
    }

    /// The operator, back on the line at the same generation. A project
    /// leg's token is retired with it, so a callback still carrying it (a
    /// module call already in flight) is refused rather than taken as the
    /// operator's.
    fn returned(&self) -> Self {
        let identity = if self.launch.is_some() {
            LegIdentity::new(OPERATOR, self.identity.generation)
        } else {
            self.identity.clone()
        };
        Self {
            identity,
            launch: None,
            thinking_effective: String::new(),
            adopted: false,
        }
    }

    fn route(&self) -> &str {
        self.launch
            .as_ref()
            .map_or(OPERATOR, |launch| launch.route.as_str())
    }

    fn label(&self) -> String {
        self.launch
            .as_ref()
            .map_or_else(|| "Operator".into(), |launch| launch.project.clone())
    }

    fn project_leg(&self) -> Option<ProjectLeg> {
        let launch = self.launch.as_ref()?;
        Some(ProjectLeg {
            project: launch.project.clone(),
            identity: self.identity.clone(),
            model: launch.model.clone(),
            persistent_session_id: launch.persistent_session_id.clone(),
        })
    }

    /// The status the page is shown for this leg. On the operator the model
    /// and its thinking are the operator's deployment setting; on a project
    /// they are the leg's.
    fn status(&self, config: &StatusConfig, thinking_default: &str) -> Status {
        let model = self
            .launch
            .as_ref()
            .map_or(&config.operator_model, |launch| &launch.model)
            .clone();
        let (provider, model_id, spec_thinking) = parse_spec(&model);
        let model_name = if provider.is_empty() {
            model_id
        } else {
            format!("{provider}/{model_id}")
        };
        let thinking_requested = self
            .launch
            .as_ref()
            .map_or(spec_thinking, |launch| launch.thinking_requested.clone());
        let thinking = if self.thinking_effective.is_empty() {
            thinking_requested.clone()
        } else {
            self.thinking_effective.clone()
        };
        let (models, models_available, models_diagnostic) = match &self.launch {
            None => (Vec::new(), true, None),
            Some(Launch {
                catalog: Some(catalog),
                ..
            }) => (
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
            ),
            Some(_) => (
                Vec::new(),
                false,
                Some("model catalog has not been loaded".into()),
            ),
        };
        Status {
            route: self.route().to_owned(),
            label: self.label(),
            model,
            model_name,
            thinking,
            thinking_requested,
            thinking_confirmed: !self.thinking_effective.is_empty(),
            thinking_default: thinking_default.to_owned(),
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

/// Where the call is. Each phase carries what exists only in it, so a
/// candidate, the leg a startup would restore, or a turn cannot outlive
/// the phase it belongs to. `Line::next` is the one transition function.
#[derive(Clone, Debug)]
enum Line {
    /// The leg on the line takes turns. `turn` is the one running, if any.
    Open {
        leg: LiveLeg,
        turn: Option<OperationIdentity>,
    },
    /// A candidate is staged behind the leg on the line, which still
    /// answers; `turn` is the leg's (a transfer runs inside the caller's
    /// turn). The candidate's side effects stay private until it is adopted.
    Starting {
        leg: LiveLeg,
        candidate: CandidateLeg,
        turn: Option<OperationIdentity>,
    },
    /// The candidate was adopted on its first sign of life and holds the
    /// line, opening with its intro turn. The PBX commits it when the intro
    /// ends (`finish_intro`); a rollback puts `replaced` back.
    Adopted {
        leg: LiveLeg,
        replaced: LiveLeg,
        turn: Option<OperationIdentity>,
    },
    /// A rescue retired the leg's work: nothing is admitted until the call
    /// settles.
    Quiescing { leg: LiveLeg },
    /// For good.
    Shutdown { leg: LiveLeg },
}

/// Which leg a rescue may retire. The check and the rescue are one
/// transition, so nothing lands between them.
enum RescueOf<'a> {
    /// Whatever is on the line.
    Line,
    /// The leg on the line, only while the call is at this generation.
    Generation(u64),
    /// This project leg, only while it is on the line and no startup is in
    /// flight: the leg the coordinator names then is not yet the PBX's.
    Leg(&'a ProjectLeg),
}

/// What moves the call line.
enum Event<'a> {
    BeginPrompt(OperationIdentity),
    BeginAutonomous(OperationIdentity),
    BindTurn { token: &'a str, turn_id: &'a str },
    SettleTurn { token: &'a str, turn_id: &'a str },
    FinishOperation(&'a OperationIdentity),
    Rescue(RescueOf<'a>),
    Settle,
    ReturnToOperator,
    BeginCandidate(CandidateLeg),
    StartupThinking { token: &'a str, level: &'a str },
    LegThinking { token: &'a str, level: &'a str },
    Adopt { token: &'a str, intro: u64 },
    FinishIntro,
    Rollback,
    BeginShutdown,
}

/// The line an event moves the call to, and the notice it owes the
/// browser: a candidate began, or its startup ended.
type Transition = (Line, Option<CandidateNotice>);

fn candidate_notice(
    route: &str,
    generation: u64,
    ended: Option<CandidateEnd>,
) -> Option<CandidateNotice> {
    Some(CandidateNotice {
        route: route.to_owned(),
        generation,
        ended,
    })
}

impl Line {
    fn at_rest(leg: LiveLeg) -> Self {
        Self::Open { leg, turn: None }
    }

    fn leg(&self) -> &LiveLeg {
        match self {
            Self::Open { leg, .. }
            | Self::Starting { leg, .. }
            | Self::Adopted { leg, .. }
            | Self::Quiescing { leg }
            | Self::Shutdown { leg } => leg,
        }
    }

    fn turn(&self) -> Option<&OperationIdentity> {
        match self {
            Self::Open { turn, .. } | Self::Starting { turn, .. } | Self::Adopted { turn, .. } => {
                turn.as_ref()
            }
            Self::Quiescing { .. } | Self::Shutdown { .. } => None,
        }
    }

    fn candidate(&self) -> Option<&CandidateLeg> {
        match self {
            Self::Starting { candidate, .. } => Some(candidate),
            _ => None,
        }
    }

    /// The same phase with `turn` open in it. Quiescing and shutdown have
    /// no turn to open.
    fn with_turn(&self, turn: Option<OperationIdentity>) -> Self {
        let mut next = self.clone();
        match &mut next {
            Self::Open { turn: slot, .. }
            | Self::Starting { turn: slot, .. }
            | Self::Adopted { turn: slot, .. } => *slot = turn,
            Self::Quiescing { .. } | Self::Shutdown { .. } => {}
        }
        next
    }

    /// The same phase with `leg` on the line.
    fn with_leg(&self, leg: LiveLeg) -> Self {
        let mut next = self.clone();
        match &mut next {
            Self::Open { leg: slot, .. }
            | Self::Starting { leg: slot, .. }
            | Self::Adopted { leg: slot, .. }
            | Self::Quiescing { leg: slot }
            | Self::Shutdown { leg: slot } => *slot = leg,
        }
        next
    }

    /// The generation the next identity is issued past: the line's, or a
    /// staged candidate's, which is one past it. A rescue or shutdown that
    /// abandons a candidate retires its generation too, so work stamped
    /// with it is stale after.
    fn retired_generation(&self) -> u64 {
        let line = self.leg().identity.generation;
        self.candidate()
            .map_or(line, |candidate| candidate.identity.generation.max(line))
    }

    /// The one transition function of the call line: the line `event`
    /// moves the call to, or why the event is refused in this phase. It
    /// reads the line and never writes it, so a refused event changes
    /// nothing; `CallLifecycle::step` writes what it returns.
    fn next(&self, event: Event) -> Result<Transition, LifecycleError> {
        let leg = self.leg();
        let unchanged = || Ok((self.clone(), None));
        match event {
            Event::BeginPrompt(operation) => {
                if leg.identity != operation.leg {
                    return Err(LifecycleError::StaleLeg);
                }
                match self {
                    Self::Quiescing { .. } => Err(LifecycleError::WrongPhase),
                    Self::Shutdown { .. } => Err(LifecycleError::Shutdown),
                    _ if self.turn().is_some() => Err(LifecycleError::OperationActive),
                    // A turn begun now would move the call out of
                    // `Starting` with the candidate still staged, and a
                    // candidate the PBX no longer sees starting is never
                    // adopted.
                    Self::Starting { .. } => Err(LifecycleError::CandidateActive),
                    Self::Open { .. } | Self::Adopted { .. } => {
                        Ok((self.with_turn(Some(operation)), None))
                    }
                }
            }
            Event::BeginAutonomous(operation) => {
                if leg.identity != operation.leg {
                    return Err(LifecycleError::StaleLeg);
                }
                match self {
                    Self::Starting { .. } => Err(LifecycleError::CandidateActive),
                    // A project leg at rest; the operator wakes no turns.
                    Self::Open { leg, turn: None }
                    | Self::Adopted {
                        leg, turn: None, ..
                    } if leg.launch.is_some() => Ok((self.with_turn(Some(operation)), None)),
                    _ => Err(LifecycleError::WrongPhase),
                }
            }
            Event::BindTurn { token, turn_id } => {
                let Some(turn) = self.turn().filter(|_| leg.identity.token == token) else {
                    return Err(LifecycleError::StaleLeg);
                };
                match turn.turn_id.as_deref() {
                    Some(bound) if bound != turn_id => Err(LifecycleError::StaleLeg),
                    Some(_) => unchanged(),
                    None => {
                        let bound = OperationIdentity {
                            turn_id: Some(turn_id.to_owned()),
                            ..turn.clone()
                        };
                        Ok((self.with_turn(Some(bound)), None))
                    }
                }
            }
            // The host reported the turn settled. A new leg's intro is
            // closed by `finish_intro`, which also ends its startup: it is
            // not this report's to close, so only an open line settles.
            Event::SettleTurn { token, turn_id } => match self {
                Self::Open {
                    leg,
                    turn: Some(turn),
                } if leg.identity.token == token && turn.turn_id.as_deref() == Some(turn_id) => {
                    Ok((self.with_turn(None), None))
                }
                _ => Err(LifecycleError::NoActiveOperation),
            },
            // Matched on the operation's id and leg, not the whole value:
            // `bind_turn` stamps the host turn id onto the live operation
            // after its owner took a copy, and that must not orphan it.
            Event::FinishOperation(operation) => match self.turn() {
                Some(turn) if turn.id == operation.id && turn.leg == operation.leg => {
                    Ok((self.with_turn(None), None))
                }
                _ => Err(LifecycleError::NoActiveOperation),
            },
            Event::Rescue(of) => {
                let admitted = match of {
                    RescueOf::Line => true,
                    RescueOf::Generation(generation) => leg.identity.generation == generation,
                    RescueOf::Leg(project) => {
                        matches!(self, Self::Open { .. } | Self::Quiescing { .. })
                            && leg.project_leg().as_ref() == Some(project)
                    }
                };
                if !admitted {
                    return Err(LifecycleError::StaleLeg);
                }
                // A rescue ends any startup in flight: a staged candidate is
                // abandoned and must never be adopted, and an adopted one
                // keeps the line but loses the leg it would roll back to.
                let generation = self.retired_generation() + 1;
                let leg = leg.retired("rescue", generation);
                let notice = self.candidate().and_then(|candidate| {
                    candidate_notice(&candidate.route, generation, Some(CandidateEnd::Rescued))
                });
                let next = match self {
                    Self::Shutdown { .. } => Self::Shutdown { leg },
                    _ => Self::Quiescing { leg },
                };
                Ok((next, notice))
            }
            Event::Settle => match self {
                Self::Quiescing { leg } => Ok((Self::at_rest(leg.clone()), None)),
                _ => unchanged(),
            },
            // A call quiescing comes to rest on the operator. A turn still
            // running (the operator is being told why the caller came back)
            // stays open until it ends, and a staged candidate stays staged:
            // it is not on the line yet.
            Event::ReturnToOperator => match self {
                Self::Quiescing { leg } => Ok((Self::at_rest(leg.returned()), None)),
                _ => Ok((self.with_leg(leg.returned()), None)),
            },
            Event::BeginCandidate(mut candidate) => {
                match self {
                    Self::Shutdown { .. } => return Err(LifecycleError::Shutdown),
                    Self::Starting { .. } => return Err(LifecycleError::CandidateActive),
                    Self::Open { .. } | Self::Adopted { .. } | Self::Quiescing { .. } => {}
                }
                if candidate.identity.token.trim().is_empty() {
                    return Err(LifecycleError::CandidateTokenMismatch);
                }
                // Staged one generation past the line: its first turn is
                // delivered at the generation its adoption puts on the line.
                candidate.identity.generation = leg.identity.generation + 1;
                let notice = candidate_notice(&candidate.route, leg.identity.generation, None);
                let next = Self::Starting {
                    leg: leg.clone(),
                    candidate,
                    turn: self.turn().cloned(),
                };
                Ok((next, notice))
            }
            Event::StartupThinking { token, level } => {
                let mut next = self.clone();
                match &mut next {
                    Self::Starting { candidate, .. } if candidate.identity.token == token => {
                        candidate.startup_thinking = level.to_owned();
                        Ok((next, None))
                    }
                    _ => Err(LifecycleError::NoCandidate),
                }
            }
            Event::LegThinking { token, level } => match self {
                Self::Quiescing { .. } | Self::Shutdown { .. } => Err(LifecycleError::StaleLeg),
                _ if leg.identity.token != token => Err(LifecycleError::StaleLeg),
                _ => {
                    let leg = LiveLeg {
                        thinking_effective: level.to_owned(),
                        ..leg.clone()
                    };
                    Ok((self.with_leg(leg), None))
                }
            },
            // The candidate's own sign of life, or the PBX once its intro
            // turn ends. The caller's turn that ran the transfer, if still
            // open, is replaced by the intro: its owner's later
            // `finish_operation` finds nothing to close.
            Event::Adopt { token, intro } => match self {
                Self::Starting { leg, candidate, .. } if candidate.identity.token == token => {
                    let adopted = LiveLeg::adopted(candidate);
                    let turn = OperationIdentity {
                        id: intro,
                        leg: adopted.identity.clone(),
                        turn_id: None,
                    };
                    let notice = candidate_notice(
                        &candidate.route,
                        adopted.identity.generation,
                        Some(CandidateEnd::Adopted),
                    );
                    let next = Self::Adopted {
                        leg: adopted,
                        replaced: leg.clone(),
                        turn: Some(turn),
                    };
                    Ok((next, notice))
                }
                Self::Starting { .. } => Err(LifecycleError::CandidateTokenMismatch),
                _ => Err(LifecycleError::NoCandidate),
            },
            // The intro ended: the PBX holds the new leg. It closes the
            // turn open on the line, whichever it is.
            Event::FinishIntro => match self {
                Self::Adopted {
                    leg, turn: Some(_), ..
                } => Ok((Self::at_rest(leg.clone()), None)),
                _ => Err(LifecycleError::WrongPhase),
            },
            Event::Rollback => match self {
                // Before adoption the line never moved: the leg on it keeps
                // its turn.
                Self::Starting {
                    leg,
                    candidate,
                    turn,
                } => {
                    let notice = candidate_notice(
                        &candidate.route,
                        leg.identity.generation,
                        Some(CandidateEnd::RolledBack),
                    );
                    let next = Self::Open {
                        leg: leg.clone(),
                        turn: turn.clone(),
                    };
                    Ok((next, notice))
                }
                // After adoption the leg it replaced comes back, at the
                // generation the line is at.
                Self::Adopted { leg, replaced, .. } => {
                    let identity =
                        LegIdentity::new(replaced.identity.token.clone(), leg.identity.generation);
                    let notice = candidate_notice(
                        leg.route(),
                        leg.identity.generation,
                        Some(CandidateEnd::RolledBack),
                    );
                    Ok((Self::at_rest(replaced.renamed(identity)), notice))
                }
                _ => Err(LifecycleError::NoCandidate),
            },
            // A shutdown ends a startup the way a rescue does.
            Event::BeginShutdown => {
                if matches!(self, Self::Shutdown { .. }) {
                    return Err(LifecycleError::Shutdown);
                }
                let generation = self.retired_generation() + 1;
                let notice = self.candidate().and_then(|candidate| {
                    candidate_notice(&candidate.route, generation, Some(CandidateEnd::Rescued))
                });
                let next = Self::Shutdown {
                    leg: leg.retired("shutdown", generation),
                };
                Ok((next, notice))
            }
        }
    }
}

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

    pub fn rollback_startup(&self, reason: impl Into<String>) -> bool {
        let Ok(Some(notice)) = self.step(Event::Rollback) else {
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

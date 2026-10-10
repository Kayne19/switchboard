//! The call line: the call as one value, `Line`, and its one transition
//! function, `Line::next`. Each phase carries what exists only in it: the
//! staged candidate, the leg a startup would restore, the turn open on the
//! leg.
//!
//! It is pure: no lock, no I/O, no notices sent. `CallLifecycle::step` in
//! `lifecycle.rs` is the one writer of the line and the coordinator there
//! sends what a transition owes the browser.

use crate::lifecycle::{
    CandidateLeg, CandidateNotice, LegIdentity, LifecycleError, OperationIdentity, ProjectLeg,
    StatusConfig,
};
use crate::models::{parse_spec, ModelCatalog, THINKING_LEVELS};
use crate::protocol::{CandidateEnd, ModelEntry, Status};
use std::sync::Arc;

pub(crate) const OPERATOR: &str = "operator";

/// What a project leg was launched with. The operator has none: its model
/// is a deployment setting (`StatusConfig::operator_model`).
#[derive(Clone, Debug)]
pub(crate) struct Launch {
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
pub(crate) struct LiveLeg {
    /// Read here and by the coordinator (`lifecycle.rs`), which checks every
    /// caller's identity against it.
    pub(crate) identity: LegIdentity,
    /// What the project leg was launched with; `None` on the operator. Read
    /// here and by the coordinator (`lifecycle.rs`: the operator test).
    pub(crate) launch: Option<Launch>,
    /// The level the leg reported through `/leg-state`; empty until it does.
    thinking_effective: String,
    /// The identity is the one an adoption put on the line. Every other
    /// identity (a rescue's, a rollback's, a return's, a shutdown's) is not.
    /// Read here and by the coordinator (`lifecycle.rs`: the route a
    /// reconnecting page is told was adopted).
    pub(crate) adopted: bool,
}

impl LiveLeg {
    pub(crate) fn operator() -> Self {
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
    pub(crate) fn adopted(candidate: &CandidateLeg) -> Self {
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

    pub(crate) fn route(&self) -> &str {
        self.launch
            .as_ref()
            .map_or(OPERATOR, |launch| launch.route.as_str())
    }

    pub(crate) fn label(&self) -> String {
        self.launch
            .as_ref()
            .map_or_else(|| "Operator".into(), |launch| launch.project.clone())
    }

    pub(crate) fn project_leg(&self) -> Option<ProjectLeg> {
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
    pub(crate) fn status(&self, config: &StatusConfig, thinking_default: &str) -> Status {
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
pub(crate) enum Line {
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
pub(crate) enum RescueOf<'a> {
    /// Whatever is on the line.
    Line,
    /// The leg on the line, only while the call is at this generation.
    Generation(u64),
    /// This project leg, only while it is on the line and no startup is in
    /// flight: the leg the coordinator names then is not yet the PBX's.
    Leg(&'a ProjectLeg),
}

/// What moves the call line.
pub(crate) enum Event<'a> {
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
    Rollback { generation: u64 },
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
    pub(crate) fn at_rest(leg: LiveLeg) -> Self {
        Self::Open { leg, turn: None }
    }

    pub(crate) fn leg(&self) -> &LiveLeg {
        match self {
            Self::Open { leg, .. }
            | Self::Starting { leg, .. }
            | Self::Adopted { leg, .. }
            | Self::Quiescing { leg }
            | Self::Shutdown { leg } => leg,
        }
    }

    pub(crate) fn turn(&self) -> Option<&OperationIdentity> {
        match self {
            Self::Open { turn, .. } | Self::Starting { turn, .. } | Self::Adopted { turn, .. } => {
                turn.as_ref()
            }
            Self::Quiescing { .. } | Self::Shutdown { .. } => None,
        }
    }

    pub(crate) fn candidate(&self) -> Option<&CandidateLeg> {
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
    pub(crate) fn next(&self, event: Event) -> Result<Transition, LifecycleError> {
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
            // Only the startup staged at `generation`. A candidate's
            // generation is used again only after its own startup rolled it
            // back, and a rescue or a shutdown moves the line past it, so a
            // startup that has ended (committed, rescued, rolled back) finds
            // nothing of its own to roll back.
            Event::Rollback { generation } => match self {
                // Before adoption the line never moved: the leg on it keeps
                // its turn.
                Self::Starting {
                    leg,
                    candidate,
                    turn,
                } if candidate.identity.generation == generation => {
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
                Self::Adopted { leg, replaced, .. } if leg.identity.generation == generation => {
                    let identity =
                        LegIdentity::new(replaced.identity.token.clone(), leg.identity.generation);
                    let notice = candidate_notice(
                        leg.route(),
                        leg.identity.generation,
                        Some(CandidateEnd::RolledBack),
                    );
                    Ok((Self::at_rest(replaced.renamed(identity)), notice))
                }
                Self::Starting { .. } | Self::Adopted { .. } => Err(LifecycleError::StaleLeg),
                Self::Open { .. } | Self::Quiescing { .. } | Self::Shutdown { .. } => {
                    Err(LifecycleError::NoCandidate)
                }
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

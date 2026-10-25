//! Host-reported turns: the turn boundaries a project session's turn
//! reports (`session_turn.rs` decides which, from the host's events and
//! from the reply to a prompt), read once as a `HostTurn` and answered
//! through the coordinator, and the one self-woken run the application
//! admitted as an operation of its own (`HostTurns`).
use crate::app_state::{emit_message, AppState};
use crate::debug::DebugEvent;
use crate::history::AGENT;
use crate::lifecycle::{LegIdentity, LifecycleError, OperationIdentity};
use crate::project_session::ProjectTurn;
use crate::protocol::ServerMessage;
use tokio::sync::Mutex;

/// The application's side of host-reported turns: the self-woken run it
/// admitted, if any. `AppInner` holds one so the field is this module's own.
pub(crate) struct HostTurns {
    /// Written only by `hold_self_woken` and `release_self_woken`.
    self_woken: Mutex<Option<SelfWokenRun>>,
}

impl HostTurns {
    pub(crate) fn new() -> Self {
        Self {
            self_woken: Mutex::new(None),
        }
    }

    /// Holds `run`, just admitted. A run held before it is replaced: the
    /// coordinator opens one operation at a time, so that run's operation
    /// was already closed under it (a rescue), and its end has nothing left
    /// to close.
    async fn hold_self_woken(&self, run: SelfWokenRun) {
        *self.self_woken.lock().await = Some(run);
    }

    /// Lets go of the held run if it is session `instance_id`'s run that
    /// `which` names, and returns its operation. A late end from an older
    /// run on the same session does not release a newer one.
    async fn release_self_woken(
        &self,
        instance_id: u64,
        which: WhichRun<'_>,
    ) -> Option<OperationIdentity> {
        self.self_woken
            .lock()
            .await
            .take_if(|run| {
                run.instance_id == instance_id
                    && match which {
                        WhichRun::Turn(turn_id) => {
                            run.operation.turn_id.as_deref() == Some(turn_id)
                        }
                        WhichRun::OfClosedSession => true,
                    }
            })
            .map(|run| run.operation)
    }

    /// Whether the run held, whichever session's, is host turn `turn_id`.
    async fn holds_turn(&self, turn_id: &str) -> bool {
        self.self_woken
            .lock()
            .await
            .as_ref()
            .is_some_and(|run| run.operation.turn_id.as_deref() == Some(turn_id))
    }

    /// Whether session `instance_id` holds an admitted self-woken run.
    #[cfg(test)]
    pub(crate) async fn holds_self_woken_for_test(&self, instance_id: u64) -> bool {
        self.self_woken
            .lock()
            .await
            .as_ref()
            .is_some_and(|run| run.instance_id == instance_id)
    }
}

/// Which of a session's runs a release names.
#[derive(Clone, Copy)]
enum WhichRun<'a> {
    /// The run with this host turn id.
    Turn(&'a str),
    /// Whichever run the session held when it closed.
    OfClosedSession,
}

/// A self-woken run the application admitted as an operation of its own:
/// the session that reported it and the operation it runs under, whose
/// `turn_id` is the run's. It is held from its admission to its end; at
/// most one is, because the coordinator opens one operation at a time.
struct SelfWokenRun {
    instance_id: u64,
    operation: OperationIdentity,
}

/// A turn boundary a project session reported, as the application acts on
/// it. `HostTurn::of` reads the report's cause and end once; the session's
/// turn (`session_turn.rs`) decides which boundaries are reported.
enum HostTurn {
    /// A turn is open: the host opened it, or a prompt's reply named it. A
    /// caller's turn may be the leg on the line's or the staged candidate's;
    /// a run is admitted only from the leg on the line.
    Opened(TurnStart),
    /// The host settled a caller's (`input`) turn. The operation bound to
    /// its id closes now, not when the prompt returns, so a run the host
    /// starts right behind it is admitted (#107, #109).
    CallerSettled { turn_id: String },
    /// A self-woken run the session held ended (any cause but `input`):
    /// settled by its host, or cut short by its session's close.
    RunEnded { turn_id: String, text: String },
    /// A boundary that names no turn. Every turn a host on this protocol
    /// opens has an id (`docs/host-link.md`, "Session events"), so this is
    /// a malformed report: it is refused, and nothing is fabricated for it.
    Unnamed { cause: String },
}

/// What a turn the host opened is to the application.
enum TurnStart {
    /// A caller's turn: its id is bound to the caller's operation.
    Caller { turn_id: String },
    /// A run the session woke on its own, with its delivery authority:
    /// admitted as an operation of its own while the leg is free.
    SelfWoken { turn_id: String },
    /// A run a reconnect snapshot found open (`unknown`): it stays
    /// fail-closed.
    Reconnected,
    /// A cause the application does not act on.
    Other,
}

impl HostTurn {
    fn of(turn: &ProjectTurn) -> Self {
        let Some(turn_id) = turn.turn_id.clone() else {
            return Self::Unnamed {
                cause: turn.cause.clone(),
            };
        };
        match (turn.ended, turn.cause.as_str()) {
            (true, "input") => Self::CallerSettled { turn_id },
            (true, _) => Self::RunEnded {
                turn_id,
                text: turn.text.clone(),
            },
            (false, cause) => Self::Opened(match cause {
                "input" => TurnStart::Caller { turn_id },
                "autonomous" => TurnStart::SelfWoken { turn_id },
                "unknown" => TurnStart::Reconnected,
                _ => TurnStart::Other,
            }),
        }
    }
}

/// Admits and settles host-reported turns through the one lifecycle owner:
/// a self-woken run gets an operation of its own, and a caller turn's
/// operation closes when the host reports it settled. A self-woken run's
/// written reply is transcript-only: `Reply` updates the caller's view
/// without entering the speech worker. True when a self-woken start was
/// admitted.
pub(crate) async fn handle_project_turn(state: &AppState, mut turn: ProjectTurn) -> bool {
    // Admission, settlement, and the transcript reply share the same turn
    // gate as caller prompt admission. This prevents a queued caller from
    // entering between autonomous finish and its written reply.
    let _transition = state.0.operation_transition.lock().await;
    // A start that replaces a held run: that run ends first, under the same
    // gate, so a caller turn waiting behind it cannot take the operation
    // before the run that replaced it does.
    if let Some(replaced) = turn.replaces.take() {
        act_on_turn(state, *replaced).await;
    }
    act_on_turn(state, turn).await
}

/// What a reported boundary does, under the turn gate.
async fn act_on_turn(state: &AppState, turn: ProjectTurn) -> bool {
    match HostTurn::of(&turn) {
        HostTurn::Opened(start) => open_host_turn(state, &turn, start).await,
        HostTurn::CallerSettled { turn_id } => {
            settle_caller_turn(state, &turn, &turn_id);
            false
        }
        // A run the application never held can still be the caller's turn:
        // a prompt sent into it as a `follow_up` bound the caller's
        // operation to it, and the host's end settles that operation as it
        // settles an `input` turn's, so a run the host starts right behind
        // it is admitted (#107, #109). A run held for another session
        // instance of the leg is neither: a late end of an older run on the
        // same session ends nothing.
        HostTurn::RunEnded { turn_id, text } => {
            if !end_self_woken_run(state, &turn, &turn_id, text).await
                && !state.0.host_turns.holds_turn(&turn_id).await
            {
                settle_caller_turn(state, &turn, &turn_id);
            }
            false
        }
        HostTurn::Unnamed { cause } => {
            tracing::warn!(
                instance = turn.instance_id,
                %cause,
                ended = turn.ended,
                "refusing a turn boundary that names no turn"
            );
            false
        }
    }
}

/// A turn open on `turn`'s session. A caller's turn binds the operation of
/// the leg on the line, or the intro turn of the candidate being brought up;
/// the coordinator refuses any other leg's. A run is admitted only from the
/// leg on the line. True when it is a self-woken run admitted as an
/// operation.
async fn open_host_turn(state: &AppState, turn: &ProjectTurn, start: TurnStart) -> bool {
    match start {
        TurnStart::Caller { turn_id } => {
            if let Err(error) = state.0.coordinator.bind_turn(&turn.token, &turn_id) {
                tracing::info!(%error, "caller turn authority was stale");
            }
            false
        }
        TurnStart::Other => false,
        TurnStart::Reconnected => {
            tracing::info!(
                instance = turn.instance_id,
                "unknown reconnect turn remains fail-closed"
            );
            false
        }
        TurnStart::SelfWoken { turn_id } => {
            let current = state.0.coordinator.current_identity();
            if current.token != turn.token {
                // The leg's call token stays out of the log: the debug page
                // copies log lines to an unauthenticated listener.
                tracing::info!(
                    instance = turn.instance_id,
                    "ignoring turn start from a leg that is no longer on the call"
                );
                return false;
            }
            admit_self_woken_run(state, turn.instance_id, &current, turn_id).await
        }
    }
}

/// The host settled the caller's turn `turn_id`.
fn settle_caller_turn(state: &AppState, turn: &ProjectTurn, turn_id: &str) {
    if state.0.coordinator.settle_turn(&turn.token, turn_id) {
        tracing::info!(
            instance = turn.instance_id,
            turn_id,
            "the host settled the caller's turn"
        );
    }
}

/// Opens an operation for a self-woken run on the leg on the line, unless
/// a caller's operation (or a starting leg) holds it.
async fn admit_self_woken_run(
    state: &AppState,
    instance_id: u64,
    current: &LegIdentity,
    turn_id: String,
) -> bool {
    match state
        .0
        .coordinator
        .begin_autonomous(current, turn_id.clone())
    {
        Ok(operation) => {
            // A self-woken turn answers no caller line.
            state.0.debug.publish(DebugEvent::TurnStart {
                agent: state.0.coordinator.route(),
                turn_id,
                generation: current.generation,
                utterance_id: None,
            });
            state
                .0
                .host_turns
                .hold_self_woken(SelfWokenRun {
                    instance_id,
                    operation,
                })
                .await;
            true
        }
        Err(LifecycleError::OperationActive | LifecycleError::CandidateActive) => {
            tracing::info!(
                instance = instance_id,
                "caller operation won the autonomous-turn race"
            );
            false
        }
        Err(error) => {
            tracing::info!(instance = instance_id, %error, "autonomous turn was not admitted");
            false
        }
    }
}

/// The end of the self-woken run `turn_id` on session `instance_id`: its
/// operation closes, it is traced to its end, and its written words reach
/// the caller's transcript. The end of a run not held, or of one whose
/// operation a rescue already closed, ends nothing.
///
/// A run cut short by its session's close, while that session's leg is
/// still on the line, is left to the leg's retirement
/// (`end_run_of_closed_session`), which ends it under the PBX lock once the
/// dead leg is off the line. A caller turn waiting behind the run then runs
/// on the leg that replaced it, never on the dead one (#270).
///
/// True when the end was a held run's, or is left to the retirement; false
/// when no run of that id was held.
async fn end_self_woken_run(
    state: &AppState,
    turn: &ProjectTurn,
    turn_id: &str,
    text: String,
) -> bool {
    if turn.cut_short && state.0.coordinator.current_identity().token == turn.token {
        return true;
    }
    let Some(operation) = state
        .0
        .host_turns
        .release_self_woken(turn.instance_id, WhichRun::Turn(turn_id))
        .await
    else {
        return false;
    };
    close_self_woken_run(state, turn.instance_id, operation, text).await;
    true
}

/// Ends the self-woken run session `instance_id` held when it closed. The
/// PBX calls this after it retired the closed session's leg, under its
/// lock (`app_state.rs`, the foreground-closed callback). A run already
/// ended ends nothing.
pub(crate) async fn end_run_of_closed_session(state: &AppState, instance_id: u64) {
    let Some(operation) = state
        .0
        .host_turns
        .release_self_woken(instance_id, WhichRun::OfClosedSession)
        .await
    else {
        return;
    };
    close_self_woken_run(state, instance_id, operation, String::new()).await;
}

/// Closes a released self-woken run's operation, traces its end, and writes
/// its words, if any, to the caller's transcript.
async fn close_self_woken_run(
    state: &AppState,
    instance_id: u64,
    operation: OperationIdentity,
    text: String,
) {
    if !state.0.coordinator.finish_operation(&operation) {
        tracing::info!(
            instance = instance_id,
            "ignoring autonomous turn end from a stale leg"
        );
        return;
    }
    if let Some(turn_id) = operation.turn_id.clone() {
        state.0.debug.publish(DebugEvent::TurnEnd {
            agent: state.0.coordinator.route(),
            turn_id,
            generation: operation.leg.generation,
            utterance_id: None,
        });
    }
    if text.trim().is_empty() {
        return;
    }
    let route = state.0.coordinator.route();
    state.0.transcript_log.lock().await.add_with_id_and_voiced(
        AGENT,
        &text,
        route.clone(),
        None,
        false,
    );
    emit_message(
        state,
        ServerMessage::Reply {
            text,
            route,
            voiced: false,
            sequence: None,
        },
    );
}

/// A self-woken start from session `instance_id` on the leg holding
/// `token`, as its pump reports it.
#[cfg(test)]
#[cfg(unix)]
pub(crate) fn autonomous_turn(
    token: String,
    instance_id: u64,
    turn_id: Option<&str>,
) -> ProjectTurn {
    ProjectTurn {
        instance_id,
        token,
        turn_id: turn_id.map(str::to_owned),
        cause: "autonomous".into(),
        ended: false,
        text: String::new(),
        cut_short: false,
        replaces: None,
    }
}

#[cfg(test)]
#[path = "../tests/test_host_turns.rs"]
mod tests;

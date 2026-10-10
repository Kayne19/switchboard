//! Host-reported turns: the turn boundaries a project session's pump reports
//! (`session_turn.rs` decides which), read once as a `HostTurn` and answered
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

    /// Lets go of the held run if it is session `instance_id`'s run
    /// `turn_id`, and returns its operation. A late end from an older run
    /// on the same session does not release a newer one.
    async fn release_self_woken(
        &self,
        instance_id: u64,
        turn_id: Option<&str>,
    ) -> Option<OperationIdentity> {
        self.self_woken
            .lock()
            .await
            .take_if(|run| {
                run.instance_id == instance_id && run.operation.turn_id.as_deref() == turn_id
            })
            .map(|run| run.operation)
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

/// A self-woken run the application admitted as an operation of its own:
/// the session that reported it and the operation it runs under, whose
/// `turn_id` is the run's. It is held from its admission to its end; at
/// most one is, because the coordinator opens one operation at a time.
struct SelfWokenRun {
    instance_id: u64,
    operation: OperationIdentity,
}

/// A turn boundary a project session reported, as the application acts on
/// it. `HostTurn::of` reads the report's cause and end once; the pump's
/// turn (`session_turn.rs`) decides which boundaries are reported.
enum HostTurn {
    /// The host opened a turn. Only the leg on the line may.
    Opened(TurnStart),
    /// The host settled a caller's (`input`) turn. The operation bound to
    /// its id closes now, not when the prompt returns, so a run the host
    /// starts right behind it is admitted (#107, #109).
    CallerSettled { turn_id: Option<String> },
    /// A self-woken run the session held ended (any cause but `input`):
    /// settled by its host, or cut short by its session's close.
    RunEnded {
        turn_id: Option<String>,
        text: String,
    },
}

/// What a turn the host opened is to the application.
enum TurnStart {
    /// A caller's turn: its id is bound to the caller's operation.
    Caller { turn_id: Option<String> },
    /// A run the session woke on its own, with its delivery authority:
    /// admitted as an operation of its own while the leg is free.
    SelfWoken { turn_id: String },
    /// A self-woken run with no delivery authority: an old host's, which
    /// stamps no turn id. Nothing is fabricated for it, so its module calls
    /// stay refused and its written text stays off the caller's transcript.
    WithoutAuthority { cause: String },
    /// A run a reconnect snapshot found open (`unknown`): it stays
    /// fail-closed.
    Reconnected,
    /// A cause the application does not act on.
    Other,
}

impl HostTurn {
    fn of(turn: &ProjectTurn) -> Self {
        let turn_id = turn.turn_id.clone();
        match (turn.ended, turn.cause.as_str()) {
            (true, "input") => Self::CallerSettled { turn_id },
            (true, _) => Self::RunEnded {
                turn_id,
                text: turn.text.clone(),
            },
            (false, cause) => Self::Opened(match (cause, turn_id) {
                ("input", turn_id) => TurnStart::Caller { turn_id },
                ("autonomous" | "unknown", None) => TurnStart::WithoutAuthority {
                    cause: cause.to_owned(),
                },
                ("autonomous", Some(turn_id)) => TurnStart::SelfWoken { turn_id },
                ("unknown", Some(_)) => TurnStart::Reconnected,
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
pub(crate) async fn handle_project_turn(state: &AppState, turn: ProjectTurn) -> bool {
    // Admission, settlement, and the transcript reply share the same turn
    // gate as caller prompt admission. This prevents a queued caller from
    // entering between autonomous finish and its written reply.
    let _transition = state.0.operation_transition.lock().await;
    match HostTurn::of(&turn) {
        HostTurn::Opened(start) => open_host_turn(state, &turn, start).await,
        HostTurn::CallerSettled { turn_id } => {
            settle_caller_turn(state, &turn, turn_id.as_deref());
            false
        }
        HostTurn::RunEnded { turn_id, text } => {
            end_self_woken_run(state, turn.instance_id, turn_id.as_deref(), text).await;
            false
        }
    }
}

/// A turn the host opened on `turn`'s session, if that session is the leg
/// on the line. True when it is a self-woken run admitted as an operation.
async fn open_host_turn(state: &AppState, turn: &ProjectTurn, start: TurnStart) -> bool {
    let current = state.0.coordinator.current_identity();
    if current.token != turn.token {
        // The leg's call token stays out of the log: the debug page copies
        // log lines to an unauthenticated listener.
        tracing::info!(
            instance = turn.instance_id,
            "ignoring turn start from a leg that is no longer on the call"
        );
        return false;
    }
    match start {
        TurnStart::Caller {
            turn_id: Some(turn_id),
        } => {
            if let Err(error) = state.0.coordinator.bind_turn(&turn.token, &turn_id) {
                tracing::info!(%error, "caller turn authority was stale");
            }
            false
        }
        TurnStart::Caller { turn_id: None } | TurnStart::Other => false,
        TurnStart::WithoutAuthority { cause } => {
            tracing::info!(instance = turn.instance_id, %cause, "autonomous turn has no delivery authority");
            false
        }
        TurnStart::Reconnected => {
            tracing::info!(
                instance = turn.instance_id,
                "unknown reconnect turn remains fail-closed"
            );
            false
        }
        TurnStart::SelfWoken { turn_id } => {
            admit_self_woken_run(state, turn.instance_id, &current, turn_id).await
        }
    }
}

/// The host settled the caller's turn `turn_id` (an old host names none).
fn settle_caller_turn(state: &AppState, turn: &ProjectTurn, turn_id: Option<&str>) {
    let Some(turn_id) = turn_id else {
        return;
    };
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
async fn end_self_woken_run(
    state: &AppState,
    instance_id: u64,
    turn_id: Option<&str>,
    text: String,
) {
    let Some(operation) = state
        .0
        .host_turns
        .release_self_woken(instance_id, turn_id)
        .await
    else {
        return;
    };
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
    }
}

#[cfg(test)]
#[path = "../tests/test_host_turns.rs"]
mod tests;

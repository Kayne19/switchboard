//! Turn dispatch: routing a caller's transcript through Jev without the PBX
//! lock, the turn worker that steers or prompts the leg and settles its
//! operation, and the turns a project host reports on its own.
#[cfg(test)]
use crate::app_state::state_with_agents_and_jev;
use crate::app_state::AppState;
use crate::app_state::{
    clear_active_operation, emit_message, spawn_registered_operation, update_agent_state_if_current,
};
use crate::caller_input::{emit_clip_verdict, emit_stale_clip};
use crate::debug::DebugEvent;
use crate::history::AGENT;
#[cfg(test)]
use crate::hosts::{FakeHostAgent, FakeLog, Step};
use crate::lifecycle::{LegIdentity, LifecycleError, OperationIdentity};
use crate::pbx::{AgentStateNotice, Switchboard};
use crate::project_session::ProjectTurn;
use crate::protocol::ServerMessage;
use crate::reply::Reply;
use crate::router::{jev_outcome, Action, CallSummary, Decision, RouteRule};
use crate::routing_view::RoutingView;
use crate::speech::{deliver_turn_if_current, SpeechGroup};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::{mpsc, Mutex};
#[cfg(test)]
use tokio::time::{timeout, Duration};
use tracing::Instrument;

/// Build Jev's view of the call without the PBX lock. The turn worker holds
/// that lock for a whole prompt, so an utterance that waited on it would be
/// routed only after the turn ended, too late to steer it. The summary is
/// built after the bounded host queries, so route state is current at the
/// point Jev sees it.
async fn call_summary_without_pbx_lock(
    state: &AppState,
    entries: &[crate::history::TranscriptEntry],
    screen: Value,
    utterance: String,
) -> (crate::router::Router, CallSummary) {
    let routing = &state.0.turns.routing;
    let live_desk_sessions =
        Switchboard::live_desk_sessions_from(routing.hosts(), routing.registry()).await;
    let (router, mut summary) =
        call_summary_without_desk_sessions(state, entries, screen, utterance);
    summary.live_desk_sessions = live_desk_sessions;
    (router, summary)
}

/// Jev's view of the call without the PBX lock and without asking the hosts
/// for desk sessions: what the floor's good-moment gate weighs an update
/// against. A foreground turn holds the PBX lock for its whole prompt, and
/// that is when the caller waits on a quiet line (#245).
pub(crate) fn call_summary_without_desk_sessions(
    state: &AppState,
    entries: &[crate::history::TranscriptEntry],
    screen: Value,
    utterance: impl Into<String>,
) -> (crate::router::Router, CallSummary) {
    let routing = &state.0.turns.routing;
    let mut summary = routing.call_summary(entries, screen, utterance);
    summary.merge_live_agents(&live_agents(state));
    (routing.router(), summary)
}

/// Prepare host-owned takeover discovery before the PBX mutex is acquired by
/// the turn operation. The selected handle and provenance are checked again by
/// `Switchboard::take_over` immediately before attach.
async fn prepare_takeover_lookup(
    state: &AppState,
    decision: &Decision,
) -> Option<Result<Option<Value>, String>> {
    let target = decision
        .target
        .as_deref()
        .filter(|_| matches!(decision.action, Action::TakeOver))?;
    let routing = &state.0.turns.routing;
    Some(
        Switchboard::desk_session_for_takeover_from(routing.hosts(), routing.registry(), target)
            .await,
    )
}

/// Every agent the presentation side knows on this call, with its live
/// state, waiting request and held display.
fn live_agents(state: &AppState) -> Vec<crate::router::LiveAgent> {
    state
        .0
        .projection
        .snapshot()
        .into_iter()
        .map(|agent| crate::router::LiveAgent {
            display_ready: state.0.projection.has_held_display(&agent.project),
            pending_request: agent.pending_request.is_some(),
            project: agent.project,
            state: agent.state,
        })
        .collect()
}

/// Jev's decision for one utterance, and the call as Jev saw it in plain
/// text for the operator and the routing utility.
#[derive(Clone, Debug)]
pub(crate) struct RoutedDecision {
    decision: Decision,
    call_state: String,
}

impl From<Decision> for RoutedDecision {
    fn from(decision: Decision) -> Self {
        Self {
            decision,
            call_state: String::new(),
        }
    }
}

/// Build a summary and ask Jev once for this utterance. The operator path is
/// the only fallback for a timeout, malformed response, or missing key.
async fn route_transcript(state: &AppState, id: &str, transcript: &str) -> RoutedDecision {
    let entries = state.0.transcript_log.lock().await.entries();
    let screen = state.0.display_gate.lock().await.screen().to_value();
    let (router, summary) =
        call_summary_without_pbx_lock(state, &entries, screen, transcript.to_owned()).await;
    let request = router.build_request(&summary);
    state.0.debug.publish(DebugEvent::JevRequest {
        utterance_id: Some(id.to_owned()),
        purpose: "route".into(),
        state: request.state.clone(),
        floor_id: None,
    });
    let trace = router.route_request(request).await;
    state.0.debug.publish(jev_response_event(
        Some(id.to_owned()),
        None,
        "route",
        trace.latency_ms,
        trace.response.as_ref(),
        trace.result.as_ref().err(),
    ));
    let (mut decision, rule) = match trace.result {
        Ok(routed) => routed,
        Err(error) => {
            let decision = router.fallback(&error);
            tracing::warn!(
                action = decision.action.as_str(),
                confidence = decision.confidence,
                unsure = decision.unsure,
                reason = %decision.reason,
                "Jev routing unavailable; using the top-level LLM path"
            );
            (decision, RouteRule::JevUnavailable)
        }
    };
    let mut reason = decision.reason.clone();
    // "Answer waiting" names the agent that is waiting. When Jev leaves the
    // target out and exactly one agent has something for the caller, that
    // agent is the target; otherwise the operator asks.
    if matches!(decision.action, Action::AnswerWaiting) && decision.target.is_none() {
        if let Some(agent) = summary.single_waiting_agent() {
            tracing::info!(target = %agent, "answer_waiting without a target; using the one waiting agent");
            reason.push_str(&format!(
                "; answer_waiting named no agent, so it goes to {agent}, the only one waiting"
            ));
            decision.target = Some(agent);
        }
    }
    state.0.debug.publish(DebugEvent::RouteDecision {
        utterance_id: id.to_owned(),
        rule: rule.as_str().into(),
        reason,
        action: decision.action.as_str().into(),
        target: decision.target.clone(),
        mode: decision
            .continue_or_fresh
            .as_ref()
            .map_or("not_applicable", |mode| mode.as_str())
            .into(),
        decided_by: if matches!(rule, RouteRule::JevUnavailable) {
            "fallback".into()
        } else {
            "jev".into()
        },
    });
    RoutedDecision {
        decision,
        call_state: summary.render_for_llm(),
    }
}

/// Jev's raw answers and timing for one question set, for the debug page.
pub(crate) fn jev_response_event(
    utterance_id: Option<String>,
    floor_id: Option<String>,
    purpose: &str,
    latency_ms: u64,
    response: Option<&crate::jev::JevResponse>,
    error: Option<&crate::jev::JevError>,
) -> DebugEvent {
    DebugEvent::JevResponse {
        utterance_id,
        purpose: purpose.to_owned(),
        latency_ms,
        outcome: jev_outcome(response, error).into(),
        answers: response
            .and_then(|response| serde_json::to_value(&response.answers).ok())
            .unwrap_or_else(|| json!({})),
        error: error.map(ToString::to_string),
        floor_id,
    }
}

/// Refuses an utterance a newer generation made stale before it was acted
/// on: its routing trace ends as `dropped_stale` and the page is told with
/// an ID-bearing `stale_epoch`. Every stale exit of a caller turn, from
/// routing to registration, ends here.
fn refuse_stale(state: &AppState, id: &str, stamped: u64) {
    state.0.debug.publish(DebugEvent::PbxBranch {
        utterance_id: id.to_owned(),
        branch: "dropped_stale".into(),
        reason: format!(
            "the line changed before this was acted on (stamped generation {stamped}, now {}); it was discarded",
            state.0.coordinator.generation()
        ),
    });
    emit_stale_clip(state, id);
}

/// Ends an utterance's routing trace when its turn ended without an answer:
/// a rescue cancelled it (`dropped_stale`) or the worker failed (`failed`).
fn trace_cut_short(state: &AppState, id: &str, branch: &str, reason: String) {
    state.0.debug.publish(DebugEvent::PbxBranch {
        utterance_id: id.to_owned(),
        branch: branch.to_owned(),
        reason,
    });
}

/// Apply a Jev decision without holding the PBX lock while Jev is contacted.
/// A project turn is steered only for an explicit `continue`; every other
/// action is queued for the PBX and uses its normal operation path.
pub(crate) async fn dispatch_routed_transcript(
    state: &AppState,
    id: &str,
    generation: u64,
    transcript: String,
) {
    let talking_to = state.0.coordinator.route();
    state.0.debug.publish(DebugEvent::CallerUtterance {
        utterance_id: id.to_owned(),
        text: transcript.clone(),
        talking_to,
    });
    let routed = route_transcript(state, id, &transcript).await;
    let decision = &routed.decision;
    let can_steer = matches!(decision.action, Action::Continue) && !decision.sends_to_operator();
    // Routing itself can span a rescue. Do not let a fallback decision queue
    // words for the leg that was current when Jev started.
    if generation != state.0.coordinator.generation() {
        refuse_stale(state, id, generation);
        return;
    }
    let steered = if can_steer {
        let transition = state.0.operation_transition.lock().await;
        if generation != state.0.coordinator.generation() {
            refuse_stale(state, id, generation);
            return;
        }
        let steer_operation = state
            .0
            .coordinator
            .attach_steer(&state.0.coordinator.current_identity())
            .ok();
        let active = state.0.active_session.lock().await;
        if generation != state.0.coordinator.generation() {
            drop(active);
            refuse_stale(state, id, generation);
            return;
        }
        let queued = match active.as_ref().cloned() {
            None => None,
            Some(session)
                if steer_operation.is_none() || !session.busy() || !session.alive().await =>
            {
                None
            }
            Some(session) => match session.queue_steer(&transcript, Some(id)).await {
                Ok(queued) => Some(queued),
                Err(error) => {
                    tracing::warn!(%error, clip = id, "steering failed; queueing routed utterance");
                    None
                }
            },
        };
        // The steer is checked and queued under both guards, so it reaches
        // the host ahead of any close or abort a rescue queues after it. The
        // host's answer can take its whole command wait; a rescue, a project
        // turn's end, transcript logging and reply admission must not wait
        // for it (#250).
        let steered_into = state.0.coordinator.route();
        drop(active);
        drop(transition);
        match queued {
            None => None,
            Some(queued) => match queued.sent().await {
                Ok(()) => Some(steered_into),
                Err(error) => {
                    tracing::warn!(%error, clip = id, "steering failed; queueing routed utterance");
                    None
                }
            },
        }
    } else {
        // A non-steer action still needs the same short session guard. A
        // rescue bumps the generation before it closes that guard, so speech
        // waiting behind a connecting leg is refused rather than queued.
        let active = state.0.active_session.lock().await;
        if generation != state.0.coordinator.generation() {
            drop(active);
            refuse_stale(state, id, generation);
            return;
        }
        drop(active);
        None
    };
    if let Some(to_agent) = steered {
        // Steering is this utterance's destination: the live turn on the line.
        state.0.debug.publish(DebugEvent::Routed {
            utterance_id: id.to_owned(),
            to_agent,
            text_part: transcript,
            mode: "steer".into(),
            via: "jev".into(),
        });
        emit_message(
            state,
            ServerMessage::Queued {
                id: id.to_owned(),
                waiting: 0,
                steered: true,
            },
        );
        return;
    }
    // If the decision could not attach to a live turn, the queued worker will
    // use the same decision and deliver it to the project. This includes an
    // explicit continue on a route with no steerable session: Jev must not be
    // called again for the same utterance.
    state
        .0
        .turns
        .routed_decisions
        .lock()
        .await
        .insert(id.to_owned(), routed.clone());
    if !can_steer {
        tracing::info!(
            clip = id,
            action = decision.action.as_str(),
            confidence = decision.confidence,
            unsure = decision.unsure,
            "queued Jev routing decision"
        );
    }
    let waiting = state.0.turns.queued.fetch_add(1, Ordering::AcqRel) + 1;
    if state
        .0
        .turns
        .sender
        .send((id.to_owned(), transcript, generation))
        .await
        .is_ok()
    {
        if waiting > 1 || state.0.turns.in_flight.load(Ordering::Acquire) {
            emit_message(
                state,
                ServerMessage::Queued {
                    id: id.to_owned(),
                    waiting,
                    steered: false,
                },
            );
        }
    } else {
        state.0.turns.queued.fetch_sub(1, Ordering::AcqRel);
        state.0.turns.routed_decisions.lock().await.remove(id);
        emit_clip_verdict(
            state,
            id,
            ServerMessage::error_for(id, "The call worker is unavailable."),
        );
    }
}

/// Queued caller turns and the state only this module reads: the turn
/// channel and the receiver the turn worker takes once, what routing reads
/// about the call, the decisions made for turns still in the queue, the
/// autonomous turns in flight, how many caller turns wait, and whether one
/// is open. `AppInner` holds one so the fields are the
/// turns module's own.
pub(crate) struct TurnState {
    sender: mpsc::Sender<(String, String, u64)>,
    receiver: Mutex<Option<mpsc::Receiver<(String, String, u64)>>>,
    /// What routing reads about the call. Routing must never wait on the PBX
    /// lock: the turn worker holds it for a whole prompt, and an utterance
    /// routed only after the prompt ends can no longer steer it. The floor's
    /// good-moment gate reads it through `call_summary_without_desk_sessions`.
    routing: RoutingView,
    /// Decisions made before a queued turn reaches the PBX lock. Keeping the
    /// decision with the clip prevents a second Jev request while preserving
    /// steering for a turn that was already active.
    routed_decisions: Mutex<HashMap<String, RoutedDecision>>,
    /// Autonomous host turns admitted by the lifecycle, keyed by resident
    /// instance so a stale turn_end cannot finish a newer operation.
    autonomous_operations: Mutex<HashMap<u64, OperationIdentity>>,
    /// Caller turns sent to the worker and not yet taken: the `waiting`
    /// count the page is shown.
    queued: AtomicU64,
    /// True while a `TurnRun` is open: `TurnRun::begin` sets it and
    /// `TurnRun::finish` clears it. A turn routed meanwhile is told it
    /// waits.
    in_flight: AtomicBool,
}

impl TurnState {
    pub(crate) fn new(routing: RoutingView) -> Self {
        let (sender, receiver) = mpsc::channel(64);
        Self {
            sender,
            receiver: Mutex::new(Some(receiver)),
            routing,
            routed_decisions: Mutex::new(HashMap::new()),
            autonomous_operations: Mutex::new(HashMap::new()),
            queued: AtomicU64::new(0),
            in_flight: AtomicBool::new(false),
        }
    }

    /// The turn worker's end of the channel, for a test that stands in for
    /// the worker.
    #[cfg(test)]
    pub(crate) async fn take_receiver(&self) -> mpsc::Receiver<(String, String, u64)> {
        self.receiver
            .lock()
            .await
            .take()
            .expect("the turn receiver is taken once")
    }

    /// Queues a raw turn, as a test does in place of a transcribed clip, and
    /// counts it as waiting, as `dispatch_routed_transcript` does.
    #[cfg(test)]
    pub(crate) async fn enqueue_for_test(
        &self,
        turn: (String, String, u64),
    ) -> Result<(), mpsc::error::SendError<(String, String, u64)>> {
        self.queued.fetch_add(1, Ordering::AcqRel);
        self.sender.send(turn).await
    }

    /// How many caller turns wait for the worker.
    #[cfg(test)]
    pub(crate) fn queued_for_test(&self) -> u64 {
        self.queued.load(Ordering::Acquire)
    }

    /// Whether a caller turn is open.
    #[cfg(test)]
    pub(crate) fn in_flight_for_test(&self) -> bool {
        self.in_flight.load(Ordering::Acquire)
    }

    /// Stands in for a turn that is open (or no longer is) for a test that
    /// runs no worker.
    #[cfg(test)]
    pub(crate) fn set_in_flight_for_test(&self, in_flight: bool) {
        self.in_flight.store(in_flight, Ordering::Release);
    }
}

pub(crate) async fn process_turns(state: AppState) {
    let mut receiver = state
        .0
        .turns
        .receiver
        .lock()
        .await
        .take()
        .expect("turn worker started once");
    while let Some((id, transcript, generation)) = receiver.recv().await {
        state.0.turns.queued.fetch_sub(1, Ordering::AcqRel);
        // A leg started from the page (a connection or a redial) is held under
        // the PBX lock until it is adopted or rolled back. Wait for that
        // outcome: the stamp check below means nothing until it is known which
        // leg the turn would run on, and a prompt must not begin while a leg is
        // starting.
        drop(state.0.switchboard.lock().await);
        // Normal clip processing stores the decision beside the queued clip.
        // Tests and internal callers may enqueue a raw turn, so route that
        // compatibility path here without changing the public channel shape.
        let routed_decision = state.0.turns.routed_decisions.lock().await.remove(&id);
        if generation != state.0.coordinator.generation() {
            tracing::info!(clip = %id, stamped = generation, current = state.0.coordinator.generation(), "dropping a queued turn before Jev routing");
            refuse_stale(&state, &id, generation);
            continue;
        }
        let RoutedDecision {
            decision,
            call_state,
        } = if let Some(routed) = routed_decision {
            routed
        } else {
            route_transcript(&state, &id, &transcript).await
        };
        let takeover = prepare_takeover_lookup(&state, &decision).await;
        let started = std::time::Instant::now();
        let Some(operation) = admit_turn(&state, &id, generation).await else {
            continue;
        };
        let run = TurnRun::begin(&state, id, generation, operation, started);
        let turn_state = state.clone();
        let turn_id = run.id.clone();
        let handle_turn = async move {
            let mut board = turn_state.0.switchboard.lock().await;
            board.set_call_state(call_state);
            board
                .handle_decision_with_takeover(&turn_id, &transcript, &decision, takeover)
                .await
        };
        run.drive(&state, handle_turn).await;
    }
    tracing::warn!("the turn worker stopped; no further turns will be dispatched");
}

/// Waits until the coordinator admits the turn stamped `generation`, and
/// returns its operation. `None` when the line changed first, or the
/// lifecycle refuses a prompt for good: the turn is refused as stale.
///
/// Caller prompts wait behind a running operation, an autonomous one
/// included. The notification is created before the serialized admission
/// check, so a fast operation cannot end between them and leave the turn
/// waiting for a wakeup that already happened.
async fn admit_turn(state: &AppState, id: &str, generation: u64) -> Option<OperationIdentity> {
    let mut logged_wait = false;
    loop {
        let operation_notify = state.0.coordinator.operation_changed();
        let changed = operation_notify.notified();
        {
            let _transition = state.0.operation_transition.lock().await;
            let current = state.0.coordinator.generation();
            if generation != current {
                tracing::info!(clip = %id, stamped = generation, %current, "dropping a queued turn from before a page rescue");
                refuse_stale(state, id, generation);
                return None;
            }
            match state
                .0
                .coordinator
                .begin_prompt(&state.0.coordinator.current_identity())
            {
                Ok(operation) => return Some(operation),
                Err(LifecycleError::OperationActive | LifecycleError::CandidateActive) => {}
                Err(error) => {
                    tracing::info!(clip = %id, %error, "dropping queued turn during lifecycle transition");
                    refuse_stale(state, id, generation);
                    return None;
                }
            }
        }
        // Without this line a turn stuck behind an operation that never
        // finishes leaves nothing in the journal.
        if !logged_wait {
            logged_wait = true;
            tracing::info!(clip = %id, "queued turn waiting for the running operation to finish");
        }
        changed.await;
    }
}

/// How a caller turn's task ended.
enum TurnOutcome {
    /// A rescue landed between admission and registration, so no task ran.
    NotRegistered,
    /// A page rescue aborted the task.
    Cancelled,
    /// The task panicked.
    Failed(tokio::task::JoinError),
    /// The leg answered.
    Replied(Reply),
}

/// A caller turn from its admission to its end: the operation the
/// coordinator admitted it under, the leg it runs on, and its speech group.
/// `begin` opens it (in flight, speech group, `turn_start`, `thinking`),
/// `drive` runs its task, and `finish` is its one end, whatever the
/// outcome.
#[must_use = "a caller turn ends only through `finish`"]
struct TurnRun {
    id: String,
    /// The generation the clip was stamped with when it was recorded.
    generation: u64,
    route: String,
    operation: OperationIdentity,
    group: SpeechGroup,
    /// The PBX, the agent, and the reply's synthesis all log under the clip
    /// that started the turn.
    span: tracing::Span,
    started: std::time::Instant,
}

impl TurnRun {
    fn begin(
        state: &AppState,
        id: String,
        generation: u64,
        operation: OperationIdentity,
        started: std::time::Instant,
    ) -> Self {
        let group = state.0.new_speech_group();
        state.0.turns.in_flight.store(true, Ordering::Release);
        state.0.set_active_speech_group(group);
        let route = state.0.coordinator.route();
        let waiting = state.0.turns.queued.load(Ordering::Acquire);
        tracing::info!(clip = %id, %route, waiting, "dispatching a turn");
        state.0.debug.publish(DebugEvent::TurnStart {
            agent: route.clone(),
            turn_id: id.clone(),
            generation,
            utterance_id: Some(id.clone()),
        });
        emit_message(
            state,
            ServerMessage::Thinking {
                route: route.clone(),
                waiting,
            },
        );
        let span = tracing::info_span!("turn", clip = %id);
        Self {
            id,
            generation,
            route,
            operation,
            group,
            span,
            started,
        }
    }

    /// Runs the turn's task to its end and ends the turn with how it went.
    /// The task is registered before it is awaited, so a page rescue can
    /// cancel it even while transfer setup has no session yet, and it leaves
    /// the registry as soon as it ends.
    async fn drive(self, state: &AppState, task: impl Future<Output = Reply> + Send + 'static) {
        let registered =
            spawn_registered_operation(state, self.generation, task.instrument(self.span.clone()))
                .await;
        let outcome = match registered {
            None => TurnOutcome::NotRegistered,
            Some((task, task_id)) => {
                let ended = task.await;
                clear_active_operation(state, task_id).await;
                match ended {
                    Ok(reply) => TurnOutcome::Replied(reply),
                    Err(error) if error.is_cancelled() => TurnOutcome::Cancelled,
                    Err(error) => TurnOutcome::Failed(error),
                }
            }
        };
        self.finish(state, outcome).await;
    }

    /// The one end of a caller turn. The operation is released first, the
    /// turn is traced to its end and its outcome reported, and only then is
    /// the speech group dropped and the worker free.
    async fn finish(self, state: &AppState, outcome: TurnOutcome) {
        state.0.coordinator.finish_operation(&self.operation);
        let (id, generation) = (self.id.as_str(), self.generation);
        match outcome {
            TurnOutcome::NotRegistered => {
                tracing::info!(clip = %id, stamped = generation, "dropping turn because rescue occurred before registration");
                self.trace_end(state);
                refuse_stale(state, id, generation);
            }
            TurnOutcome::Cancelled => {
                tracing::info!(clip = %id, elapsed = ?self.started.elapsed(), "the turn was cancelled by a page rescue");
                self.trace_end(state);
                trace_cut_short(
                    state,
                    id,
                    "dropped_stale",
                    format!(
                        "a page rescue cancelled the turn (stamped generation {generation}, now {}); its answer was discarded",
                        state.0.coordinator.generation()
                    ),
                );
            }
            TurnOutcome::Failed(error) => {
                // A panic inside `handle()` arrives here. Without this line the
                // caller hears a generic apology and the journal holds nothing.
                tracing::error!(clip = %id, %error, elapsed = ?self.started.elapsed(), "the turn worker failed");
                self.trace_end(state);
                trace_cut_short(
                    state,
                    id,
                    "failed",
                    format!("the turn worker failed: {error}"),
                );
                emit_message(
                    state,
                    ServerMessage::error(format!("The call worker failed on that turn: {error}")),
                );
            }
            TurnOutcome::Replied(reply) => {
                if let Some(error) = &reply.error {
                    // The caller was answered and recovered, so this is not an
                    // error level — but a turn that carried a failure is worth
                    // an audit trail.
                    tracing::warn!(clip = %id, route = %reply.route, %error, "the turn reported a failure");
                }
                tracing::info!(clip = %id, route = %reply.route, elapsed = ?self.started.elapsed(), "turn settled");
                self.trace_end(state);
                self.deliver(state, &reply).await;
            }
        }
        state.0.clear_active_speech_group(self.group);
        state.0.turns.in_flight.store(false, Ordering::Release);
    }

    fn trace_end(&self, state: &AppState) {
        state.0.debug.publish(DebugEvent::TurnEnd {
            agent: self.route.clone(),
            turn_id: self.id.clone(),
            generation: self.generation,
            utterance_id: Some(self.id.clone()),
        });
    }

    /// Delivers the reply and settles the agent idle, both only while the
    /// generation the reply names is still current.
    async fn deliver(&self, state: &AppState, reply: &Reply) {
        let delivery_generation = reply.delivery_generation.unwrap_or(self.generation);
        let _delivered = deliver_turn_if_current(state, reply, delivery_generation, &self.id)
            .instrument(self.span.clone())
            .await;
        // Settlement belongs to the same generation as delivery. In
        // particular, do not publish idle for a stale reply after rescue has
        // already replaced the resident or foreground session.
        if reply.route != crate::pbx::OPERATOR {
            update_agent_state_if_current(
                state,
                delivery_generation,
                AgentStateNotice {
                    project: reply.route.clone(),
                    state: "idle".into(),
                },
            )
            .await;
        }
    }
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
                .turns
                .autonomous_operations
                .lock()
                .await
                .insert(instance_id, operation);
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
/// the caller's transcript. A late end from an older run on the same
/// session does not settle a newer one, and one whose operation a rescue
/// already closed ends nothing.
async fn end_self_woken_run(
    state: &AppState,
    instance_id: u64,
    turn_id: Option<&str>,
    text: String,
) {
    let mut operations = state.0.turns.autonomous_operations.lock().await;
    let Some(operation) = operations.get(&instance_id).cloned() else {
        return;
    };
    if operation.turn_id.as_deref() != turn_id {
        return;
    }
    operations.remove(&instance_id);
    drop(operations);
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

#[cfg(test)]
#[cfg(unix)]
async fn foreground_alpha_turn(state: &AppState) -> (String, u64) {
    let mut board = state.0.switchboard.lock().await;
    let reply = board
        .transfer_to(
            &crate::pbx::TransferContext {
                exact_caller_transcript: "put me through to alpha".into(),
                ..Default::default()
            },
            "alpha",
        )
        .await;
    assert_eq!(reply.route, "alpha");
    drop(board);
    let token = state.0.coordinator.current_identity().token;
    let instance = state
        .0
        .active_session
        .lock()
        .await
        .as_ref()
        .expect("foreground project session")
        .instance_id();
    (token, instance)
}

/// A call on alpha whose host stamps turn ids, with a caller turn in flight:
/// the turn worker has prompted alpha with "run the tests", and the host has
/// opened that turn (`turn-2`, after the intro's `turn-1`) and holds it.
/// Returns the state, the host's log, alpha's call token and its instance,
/// and the turn worker.
#[cfg(test)]
#[cfg(unix)]
pub(crate) async fn alpha_caller_turn_in_flight(
    root: &std::path::Path,
) -> (AppState, FakeLog, String, u64, tokio::task::JoinHandle<()>) {
    let mut host = FakeHostAgent::new(Box::new(|_, message| {
        if message.contains("run the tests") {
            vec![Step::Hold]
        } else {
            vec![Step::Event(json!({"kind":"text","text":"Alpha here."}))]
        }
    }));
    host.turn_ids = true;
    let (state, log) = state_with_agents_and_jev(root, host);
    let (token, instance_id) = foreground_alpha_turn(&state).await;
    let generation = state.0.coordinator.generation();
    let worker = tokio::spawn(process_turns(state.clone()));
    state
        .0
        .turns
        .enqueue_for_test(("caller-held".into(), "run the tests".into(), generation))
        .await
        .unwrap();
    timeout(Duration::from_secs(5), async {
        while state
            .0
            .coordinator
            .accept_side_effect(&token, Some("turn-2"), Some("input"))
            .is_err()
        {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("the caller turn is running on the host");
    (state, log, token, instance_id, worker)
}

#[cfg(test)]
#[path = "../tests/test_turns.rs"]
mod tests;

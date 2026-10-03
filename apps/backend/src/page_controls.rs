//! The caller page's controls over HTTP (`/status`, `/connect`,
//! `/thinking`, `/model`, `/hangup`) and the rescue each one starts with:
//! cancel the call's work, run the control as an operation of its own, and
//! settle the call unless a newer rescue took it over.
use crate::app_state::AppState;
use crate::app_state::{
    clear_active_operation, emit_message, publish_status, spawn_registered_operation,
};
use crate::debug::DebugEvent;
use crate::history::AGENT;
use crate::pbx::{Redial, RedialPlan};
use crate::protocol::{ServerMessage, Status};
use crate::speech::deliver_page_reply_if_current;
#[cfg(test)]
use crate::turns::process_turns;
use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::future::Future;
use tokio::task::{Id as TaskId, JoinHandle};

pub(crate) fn current_status(state: &AppState) -> Status {
    state.0.coordinator.status()
}
/// Settles the call a control rescued at `generation`, unless a newer rescue
/// has taken it over since; that one settles it instead.
async fn settle_if_current(state: &AppState, generation: u64) {
    let _transition = state.0.operation_transition.lock().await;
    if generation == state.0.coordinator.generation() {
        publish_status(state);
    }
}

async fn spawn_active_operation<F, T>(
    state: &AppState,
    future: F,
) -> Option<(JoinHandle<T>, TaskId, u64)>
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let generation = state.0.coordinator.generation();
    let (task, id) = spawn_registered_operation(state, generation, future).await?;
    Some((task, id, generation))
}
/// The status message the page is sent, `type` included.
pub(crate) async fn status(State(state): State<AppState>) -> impl IntoResponse {
    Json(ServerMessage::Status(current_status(&state)).to_value())
}
pub(crate) async fn interrupt_active_turn(state: &AppState) -> Option<String> {
    cancel_active_operations(state).await
}
pub(crate) async fn cancel_active_operations(state: &AppState) -> Option<String> {
    let generation = state
        .0
        .coordinator
        .begin_rescue("operation interrupted")
        .generation;
    release_rescued_work(state, generation, false, "operation interrupted").await
}
/// Cancels running work to make way for `plan`, but only while its leg is
/// still the one on the line: a caller who has moved since the redial was
/// decided keeps whatever they moved to, untouched. Returns the plan for the
/// leg as the rescue left it.
async fn cancel_active_operations_for(state: &AppState, plan: RedialPlan) -> Option<RedialPlan> {
    let rescued = state.0.coordinator.begin_rescue_of(plan.leg(), "redial")?;
    release_rescued_work(
        state,
        rescued.identity.generation,
        plan.keeps_session(),
        "redial",
    )
    .await;
    Some(plan.rescued(rescued))
}
/// What a rescue does once the coordinator has retired the leg: drop queued
/// audio, announce the new epoch, abort registered work, and close the live
/// leg, or, for a model change that keeps the session (`keep_session`), only
/// stop its running turn. Returns the label of the leg it closed.
async fn release_rescued_work(
    state: &AppState,
    generation: u64,
    keep_session: bool,
    reason: &str,
) -> Option<String> {
    state.0.clear_continuity();
    state.0.audio.lock().await.clear();
    // Tell the browser at once, so speech it starts recording after this point
    // is stamped with the new epoch rather than the one being retired.
    emit_message(state, ServerMessage::Epoch { generation });
    let operations = std::mem::take(&mut *state.0.active_operations.lock().await);
    for operation in operations.into_values() {
        operation.abort();
    }
    // Taken as well as closed: the PBX names the live session again when it
    // settles on a leg, and a later rescue must not report a process this one
    // has already closed.
    let active = state.0.active_session.lock().await.take();
    let label = active.as_ref().map(|session| session.label().to_owned());
    if let Some(session) = active {
        if keep_session {
            session.interrupt().await;
        } else {
            session.close().await;
        }
    }
    state.0.debug.publish(DebugEvent::Rescue {
        generation,
        reason: reason.to_owned(),
        leg: label.clone(),
    });
    label
}
async fn spawn_replacing_operation<F, T>(
    state: &AppState,
    future: F,
) -> Option<(JoinHandle<T>, TaskId, u64)>
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    cancel_active_operations(state).await;
    let generation = state.0.coordinator.generation();
    let (task, id) = spawn_registered_operation(state, generation, future).await?;
    Some((task, id, generation))
}
/// A page control's refusal: `{"detail": ...}` under `status`.
fn page_refusal(status: axum::http::StatusCode, detail: String) -> Response {
    (status, Json(json!({ "detail": detail }))).into_response()
}

/// A page control that lost to something newer: 409, "{what} was {outcome}".
fn page_conflict(what: &str, outcome: &str) -> Response {
    page_refusal(
        axum::http::StatusCode::CONFLICT,
        format!("{what} was {outcome}"),
    )
}

/// Waits for a page control's registered operation and returns its output
/// with the generation it was spawned on. An operation that could not be
/// registered, or was cancelled, lost to a newer rescue, which settles the
/// call itself: 409. One that failed settles the call unless something newer
/// has: 500.
async fn join_page_operation<T>(
    state: &AppState,
    what: &str,
    started: std::time::Instant,
    spawned: Option<(JoinHandle<T>, TaskId, u64)>,
) -> Result<(T, u64), Response> {
    let Some((task, task_id, generation)) = spawned else {
        tracing::info!("cancelled before it could start: a rescue retired the leg first");
        return Err(page_conflict(what, "cancelled"));
    };
    let joined = task.await;
    clear_active_operation(state, task_id).await;
    match joined {
        Ok(output) => Ok((output, generation)),
        Err(error) if error.is_cancelled() => {
            tracing::info!(
                elapsed = ?started.elapsed(),
                "cancelled: a rescue or a newer control replaced it"
            );
            Err(page_conflict(what, "cancelled"))
        }
        Err(error) => {
            tracing::error!(%error, elapsed = ?started.elapsed(), "failed");
            settle_if_current(state, generation).await;
            Err(page_refusal(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("{what} failed: {error}"),
            ))
        }
    }
}

/// Delivers a page control's reply, which settles the call
/// (`publish_status`), or answers 409 if its leg was superseded first.
async fn deliver_page_control(
    state: &AppState,
    what: &str,
    started: std::time::Instant,
    reply: crate::reply::Reply,
    generation: u64,
) -> Result<crate::reply::Reply, Response> {
    let generation = reply.delivery_generation.unwrap_or(generation);
    if !deliver_page_reply_if_current(state, &reply, generation).await {
        tracing::info!(
            generation,
            current = state.0.coordinator.generation(),
            elapsed = ?started.elapsed(),
            "superseded: the leg changed before the reply was delivered"
        );
        return Err(page_conflict(what, "superseded"));
    }
    Ok(reply)
}

/// `/connect`: cancel whatever is running, then run the PBX operation as a
/// registered operation a newer rescue can cancel in turn, and deliver its
/// reply. `what` names the control in its refusals ("connection attempt").
async fn run_page_control<F>(
    state: &AppState,
    what: &str,
    operation: F,
) -> Result<crate::reply::Reply, Response>
where
    F: Future<Output = crate::reply::Reply> + Send + 'static,
{
    let started = std::time::Instant::now();
    let spawned = spawn_replacing_operation(state, operation).await;
    let (reply, generation) = join_page_operation(state, what, started, spawned).await?;
    deliver_page_control(state, what, started, reply, generation).await
}

/// `/model` and `/thinking`: decide first, and touch the live leg only for a
/// redial that will go ahead.
///
/// The decision needs no PBX lock, so a wedged turn cannot hold it up; it
/// runs as a registered operation a rescue can cancel, and leaves running
/// work alone. An answer (a refusal, or a setting recorded on the operator)
/// is delivered at the generation the decision started on, and the live leg
/// keeps running: the caller's next turn reaches it. A redial that will go
/// ahead cancels running work only if the caller is still on the leg it was
/// decided for, and the PBX refuses it if the caller has left that leg by the
/// time it holds the lock. Either way the caller keeps the leg they moved to,
/// and the control answers 409 as superseded.
async fn run_redial_control<D>(
    state: &AppState,
    what: &str,
    decide: D,
) -> Result<crate::reply::Reply, Response>
where
    D: Future<Output = Redial> + Send + 'static,
{
    let started = std::time::Instant::now();
    let spawned = spawn_active_operation(state, decide).await;
    let (decided, generation) = join_page_operation(state, what, started, spawned).await?;
    let plan = match decided {
        Redial::Answered(reply) => {
            tracing::info!(
                answer = %reply.text,
                error = reply.error.as_deref().unwrap_or(""),
                elapsed = ?started.elapsed(),
                "decided without touching the live leg"
            );
            return deliver_page_control(state, what, started, reply, generation).await;
        }
        Redial::Planned(plan) => *plan,
    };
    let Some(plan) = cancel_active_operations_for(state, plan).await else {
        tracing::info!(
            elapsed = ?started.elapsed(),
            "superseded: the caller left the leg before the redial could cancel its work"
        );
        return Err(page_conflict(what, "superseded"));
    };
    let generation = plan.leg().identity.generation;
    tracing::info!(
        project = %plan.leg().project,
        generation,
        "the redial goes ahead: running work on the leg was cancelled"
    );
    let board_state = state.clone();
    let spawned = spawn_registered_operation(state, generation, async move {
        board_state.0.switchboard.lock().await.redial(plan).await
    })
    .await
    .map(|(task, task_id)| (task, task_id, generation));
    let (redialed, generation) = join_page_operation(state, what, started, spawned).await?;
    match redialed {
        Ok(reply) => deliver_page_control(state, what, started, reply, generation).await,
        Err(_left) => {
            tracing::info!(
                elapsed = ?started.elapsed(),
                "superseded: the caller left the leg before the redial reached the PBX"
            );
            // This control's rescue left the call quiescing.
            settle_if_current(state, generation).await;
            Err(page_conflict(what, "superseded"))
        }
    }
}

#[tracing::instrument(name = "http", skip_all, fields(endpoint = "/hangup"))]
pub(crate) async fn hangup(State(state): State<AppState>) -> impl IntoResponse {
    let started = std::time::Instant::now();
    tracing::info!(route = %state.0.coordinator.route(), "the page asked to hang up");
    // The process the rescue closed, and the leg the PBX then dropped.
    let closed = interrupt_active_turn(&state).await;
    let dropped = state.0.switchboard.lock().await.force_hangup().await;
    let hung_up = hangup_outcome(dropped, closed);
    // A hangup ends the call on the debug page; a page still connected is on
    // a new one with the operator.
    if hung_up.is_some() {
        state.end_debug_call("hangup");
        if state.0.delivery.connected() {
            state.start_debug_call();
        }
    }
    if let Some((_, line)) = &hung_up {
        if let Some(entry) =
            state
                .0
                .transcript_log
                .lock()
                .await
                .add_voiced(AGENT, line, state.0.coordinator.route())
        {
            // Nothing voices the hangup line, so the page shows it at once.
            emit_message(
                &state,
                ServerMessage::Spoken {
                    entry,
                    sequence: None,
                },
            );
        }
    }
    // Like every page control, a hangup settles the call on its way out, even
    // with nothing on the line: its rescue left the call quiescing, which
    // refuses callbacks and steers until something settles it.
    publish_status(&state);
    match hung_up {
        Some((left, _)) => {
            tracing::info!(%left, elapsed = ?started.elapsed(), "hung up; the caller is back on the operator");
            Json(json!({"hungup":true, "left":left}))
        }
        None => {
            tracing::info!(elapsed = ?started.elapsed(), "nothing to hang up: already on the operator");
            Json(json!({"hungup":false, "reason":"already on the operator"}))
        }
    }
}

/// What a hangup hung up on, and the line the transcript keeps for it.
/// `dropped` is what `force_hangup` let go of: a project leg by name, or
/// `operator` when it discarded the operator's process. `closed` is the
/// process the rescue closed first, which names a leg that was still starting
/// when the caller hung up on it.
fn hangup_outcome(dropped: Option<String>, closed: Option<String>) -> Option<(String, String)> {
    use crate::pbx::OPERATOR;
    match (dropped, closed) {
        (Some(project), _) if project != OPERATOR => {
            let line = format!("You hung up the line to {project}. You're back with the operator.");
            Some((project, line))
        }
        (_, Some(starting)) if starting != OPERATOR => {
            let line = format!(
                "You hung up on {starting} before it picked up. You're back with the operator."
            );
            Some((starting, line))
        }
        (Some(_), _) | (None, Some(_)) => Some((
            OPERATOR.to_owned(),
            "You cut the operator off. It starts fresh when you speak again.".to_owned(),
        )),
        (None, None) => None,
    }
}
#[derive(Deserialize)]
pub(crate) struct Connect {
    project: String,
    #[serde(default)]
    intent: String,
}
#[tracing::instrument(name = "http", skip_all, fields(endpoint = "/connect"))]
pub(crate) async fn connect(
    State(state): State<AppState>,
    body: Result<Json<Connect>, JsonRejection>,
) -> Response {
    let req = match body {
        Ok(Json(req)) => req,
        Err(rejection) => return refuse_body(rejection),
    };
    let started = std::time::Instant::now();
    tracing::info!(project = %req.project, from = %state.0.coordinator.route(), "the page asked to connect");
    // The picker is also an escape hatch. Cancel setup or a wedged live turn
    // before taking the PBX lock; otherwise a direct connection can wait for
    // the very leg the caller is trying to leave.
    let board_state = state.clone();
    let controlled = run_page_control(&state, "connection attempt", async move {
        let mut board = board_state.0.switchboard.lock().await;
        board.dial(&req.project, &req.intent).await
    })
    .await;
    match controlled {
        Ok(reply) => {
            match &reply.error {
                None => {
                    tracing::info!(route = %reply.route, elapsed = ?started.elapsed(), "connected")
                }
                Some(error) => {
                    tracing::info!(route = %reply.route, %error, elapsed = ?started.elapsed(), "the connection failed")
                }
            }
            Json(json!({"route":reply.route, "error":reply.error})).into_response()
        }
        Err(refused) => refused,
    }
}
#[derive(Deserialize)]
pub(crate) struct Thinking {
    level: String,
}
#[tracing::instrument(name = "http", skip_all, fields(endpoint = "/thinking"))]
pub(crate) async fn thinking(
    State(state): State<AppState>,
    body: Result<Json<Thinking>, JsonRejection>,
) -> Response {
    let req = match body {
        Ok(Json(req)) => req,
        Err(rejection) => return refuse_body(rejection),
    };
    let started = std::time::Instant::now();
    tracing::info!(thinking = %req.level, route = %state.0.coordinator.route(), "the page asked for a thinking level");
    let redials = state.0.redials.clone();
    let controlled = run_redial_control(&state, "thinking change", async move {
        redials.thinking_change(&req.level).await
    })
    .await;
    match controlled {
        Ok(reply) => {
            let thinking = current_status(&state).thinking;
            match &reply.error {
                None => {
                    tracing::info!(%thinking, elapsed = ?started.elapsed(), "thinking level set")
                }
                Some(error) => {
                    tracing::info!(%thinking, %error, elapsed = ?started.elapsed(), "thinking level not changed")
                }
            }
            Json(json!({"thinking":thinking, "error":reply.error})).into_response()
        }
        Err(refused) => refused,
    }
}
#[derive(Deserialize)]
pub(crate) struct Model {
    model: String,
}
#[tracing::instrument(name = "http", skip_all, fields(endpoint = "/model"))]
pub(crate) async fn model(
    State(state): State<AppState>,
    body: Result<Json<Model>, JsonRejection>,
) -> Response {
    let req = match body {
        Ok(Json(req)) => req,
        Err(rejection) => return refuse_body(rejection),
    };
    let started = std::time::Instant::now();
    tracing::info!(model = %req.model, route = %state.0.coordinator.route(), "the page asked for a model");
    let redials = state.0.redials.clone();
    let controlled = run_redial_control(&state, "model change", async move {
        redials.model_change(&req.model).await
    })
    .await;
    match controlled {
        Ok(reply) => {
            let model = current_status(&state).model_name;
            match &reply.error {
                None => tracing::info!(%model, elapsed = ?started.elapsed(), "model set"),
                Some(error) => {
                    tracing::info!(%model, %error, elapsed = ?started.elapsed(), "model not changed")
                }
            }
            Json(json!({"model":model, "error":reply.error})).into_response()
        }
        Err(refused) => refused,
    }
}
/// Axum's rejection of a control's or callback's request body, answered
/// unchanged and recorded: a body that never reached its handler is otherwise
/// a refusal only the page or agent that sent it hears about.
fn refuse_body<R>(rejection: R) -> Response
where
    R: IntoResponse + std::fmt::Display,
{
    let reason = rejection.to_string();
    let response = rejection.into_response();
    tracing::info!(
        status = response.status().as_u16(),
        %reason,
        "refused: the request body could not be read"
    );
    response
}

#[cfg(test)]
#[path = "../tests/test_page_controls.rs"]
mod tests;

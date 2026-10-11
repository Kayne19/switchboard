//! The caller page's controls over HTTP (`/status`, `/connect`,
//! `/thinking`, `/model`, `/hangup`) and the rescue each one starts with:
//! cancel the call's work, run the control as an operation of its own, and
//! settle the call unless a newer rescue took it over.
//!
//! A page control is a fixed sequence with failure exits, not a machine.
//! `PageControl::admit` checks the generation the page held and returns an
//! `Admitted` control; its rescue returns a `Rescued` one, which holds the
//! coordinator's rescue token. Every step after the rescue (the registered
//! operation, the check under the PBX lock, the delivery, the settle) acts
//! at the token's generation and nowhere else: none reads the current
//! generation again (#263, #369).
use crate::app_state::AppState;
use crate::app_state::{
    clear_active_operation, emit_message, publish_status, spawn_registered_operation,
};
use crate::debug::DebugEvent;
use crate::history::AGENT;
use crate::pbx::Switchboard;
use crate::protocol::{ServerMessage, Status};
use crate::redial::{Redial, RedialPlan};
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
use tokio::sync::MutexGuard;

pub(crate) fn current_status(state: &AppState) -> Status {
    state.0.coordinator.status()
}

/// The generation a page control acts at: the one the page held when the
/// caller acted, which the control carries (#263). It is never defaulted to
/// the current one -- that is how a request queued behind a slow one, or a
/// stale tab, acted on a leg the caller never chose (`AGENTS.md`).
fn control_generation(state: &AppState, held: Option<u64>) -> Result<u64, StaleControl> {
    let held = held.ok_or(StaleControl::Missing)?;
    let current = state.0.coordinator.generation();
    if held != current {
        return Err(StaleControl::Moved { held, current });
    }
    Ok(held)
}
/// Why a page control does not act: it carries no generation, or one the
/// call has moved on from.
enum StaleControl {
    Missing,
    Moved { held: u64, current: u64 },
}
/// What a stale control is in its answer: a picker that would start
/// something is refused, a hangup that would end something is ignored.
#[derive(Clone, Copy)]
enum StaleOutcome {
    Refused,
    Ignored,
}
/// A control refused at its admission: what it is, what a stale one is
/// called, and why.
struct Refusal {
    what: &'static str,
    outcome: StaleOutcome,
    stale: StaleControl,
}
impl IntoResponse for Refusal {
    /// 400 for a control with no generation, 409 for one the call has moved
    /// on from.
    fn into_response(self) -> Response {
        let Refusal {
            what,
            outcome,
            stale,
        } = self;
        let outcome = match outcome {
            StaleOutcome::Refused => "refused",
            StaleOutcome::Ignored => "ignored",
        };
        match stale {
            StaleControl::Missing => {
                tracing::info!("{what} {outcome}: it carries no generation");
                page_refusal(
                    axum::http::StatusCode::BAD_REQUEST,
                    format!("{what} was {outcome}: it carries no generation"),
                )
            }
            StaleControl::Moved { held, current } => {
                tracing::info!(held, current, "{what} {outcome}: the line moved on");
                page_refusal(
                    axum::http::StatusCode::CONFLICT,
                    format!(
                        "{what} was {outcome}: the line moved on \
                         (the page held generation {held}, the call is at {current})"
                    ),
                )
            }
        }
    }
}

/// The status message the page is sent, `type` included.
pub(crate) async fn status(State(state): State<AppState>) -> impl IntoResponse {
    Json(ServerMessage::Status(current_status(&state)).to_value())
}
pub(crate) async fn cancel_active_operations(state: &AppState) -> Option<String> {
    let rescued = state.0.coordinator.begin_rescue("operation interrupted");
    release_rescued_work(state, rescued.generation(), false, "operation interrupted").await
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

/// A page control on its way from admission to its answer: the call it
/// acts on, what it is called in its refusals ("connection attempt"), and
/// when the caller pressed it.
struct PageControl {
    state: AppState,
    what: &'static str,
    started: std::time::Instant,
}

/// A control admitted at the generation the page held, which is the
/// call's. Nothing has been rescued yet.
struct Admitted {
    control: PageControl,
    generation: u64,
}

/// A control after its own rescue. `rescue` is the coordinator's token for
/// it: the generation every later step acts at, and what `settle` ends.
struct Rescued {
    control: PageControl,
    rescue: crate::lifecycle::Rescued,
}

impl PageControl {
    /// Admits a control carrying `held`, the generation the page held
    /// (`control_generation`), or answers why not: 400 with none, 409 for
    /// one the call has left. `outcome` is what a stale one is called.
    fn admit(
        state: &AppState,
        what: &'static str,
        outcome: StaleOutcome,
        held: Option<u64>,
    ) -> Result<Admitted, Refusal> {
        let generation = control_generation(state, held).map_err(|stale| Refusal {
            what,
            outcome,
            stale,
        })?;
        let control = PageControl {
            state: state.clone(),
            what,
            started: std::time::Instant::now(),
        };
        Ok(Admitted {
            control,
            generation,
        })
    }

    fn elapsed(&self) -> std::time::Duration {
        self.started.elapsed()
    }

    fn conflict(&self, outcome: &str) -> Response {
        page_conflict(self.what, outcome)
    }

    /// Runs `operation` registered at `generation`, so a rescue can cancel
    /// it, and returns its output. One that could not be registered, or was
    /// cancelled, lost to a newer rescue, which settles the call itself:
    /// 409. One that failed settles the call unless something newer has:
    /// 500.
    async fn run<F, T>(&self, generation: u64, operation: F) -> Result<T, Response>
    where
        F: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let Some((task, task_id)) =
            spawn_registered_operation(&self.state, generation, operation).await
        else {
            tracing::info!("cancelled before it could start: a rescue retired the leg first");
            return Err(self.conflict("cancelled"));
        };
        let joined = task.await;
        clear_active_operation(&self.state, task_id).await;
        match joined {
            Ok(output) => Ok(output),
            Err(error) if error.is_cancelled() => {
                tracing::info!(
                    elapsed = ?self.elapsed(),
                    "cancelled: a rescue or a newer control replaced it"
                );
                Err(self.conflict("cancelled"))
            }
            Err(error) => {
                tracing::error!(%error, elapsed = ?self.elapsed(), "failed");
                self.settle(|coordinator| coordinator.settle_at(generation))
                    .await;
                Err(page_refusal(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    format!("{} failed: {error}", self.what),
                ))
            }
        }
    }

    /// Delivers the control's reply at `generation`, which settles the call
    /// (`deliver_page_reply_if_current`), or answers 409 if its leg was
    /// superseded first.
    async fn deliver(
        &self,
        reply: crate::reply::Reply,
        generation: u64,
    ) -> Result<crate::reply::Reply, Response> {
        let generation = reply.delivery_generation.unwrap_or(generation);
        if !deliver_page_reply_if_current(&self.state, &reply, generation).await {
            tracing::info!(
                generation,
                current = self.state.0.coordinator.generation(),
                elapsed = ?self.elapsed(),
                "superseded: the leg changed before the reply was delivered"
            );
            return Err(self.conflict("superseded"));
        }
        Ok(reply)
    }

    /// Ends a quiet if `settle` does (the call is still at the generation it
    /// names), and then tells the page where the call is. Under the
    /// operation transition, so it does not land inside a delivery.
    async fn settle(&self, settle: impl FnOnce(&crate::lifecycle::Coordinator) -> bool) {
        let _transition = self.state.0.operation_transition.lock().await;
        if settle(&self.state.0.coordinator) {
            publish_status(&self.state);
        }
    }
}

impl Admitted {
    /// Rescues the call, only while it is still at the admitted generation
    /// (`Coordinator::begin_rescue_at`), and releases the work on its leg.
    /// Returns the label of the leg the rescue closed. `Err` rescued
    /// nothing: the line moved on after the control was admitted.
    async fn rescue(self) -> Result<(Rescued, Option<String>), PageControl> {
        let state = &self.control.state;
        let Some(rescue) = state
            .0
            .coordinator
            .begin_rescue_at(self.generation, "operation interrupted")
        else {
            return Err(self.control);
        };
        let closed =
            release_rescued_work(state, rescue.generation(), false, "operation interrupted").await;
        let rescued = Rescued {
            control: self.control,
            rescue,
        };
        Ok((rescued, closed))
    }

    /// Runs a redial's decision registered at the admitted generation. It
    /// leaves running work alone.
    async fn decide<D>(self, decide: D) -> Result<(Self, Redial), Response>
    where
        D: Future<Output = Redial> + Send + 'static,
    {
        let decided = self.control.run(self.generation, decide).await?;
        Ok((self, decided))
    }

    /// Delivers an answer decided without a rescue, at the admitted
    /// generation.
    async fn deliver(self, reply: crate::reply::Reply) -> Result<crate::reply::Reply, Response> {
        self.control.deliver(reply, self.generation).await
    }

    /// Cancels running work to make way for `plan`, but only while its leg is
    /// still the one on the line (`Coordinator::begin_rescue_of`): a caller
    /// who has moved since the redial was decided keeps whatever they moved
    /// to, untouched, and the control answers 409. A redial keeps the
    /// session, so the rescue only stops its turn. Returns the plan for the
    /// leg as the rescue left it.
    async fn rescue_for(self, plan: RedialPlan) -> Result<(Rescued, RedialPlan), Response> {
        let state = &self.control.state;
        let Some((leg, rescue)) = state.0.coordinator.begin_rescue_of(plan.leg(), "redial") else {
            tracing::info!(
                elapsed = ?self.control.elapsed(),
                "superseded: the caller left the leg before the redial could cancel its work"
            );
            return Err(self.control.conflict("superseded"));
        };
        release_rescued_work(state, rescue.generation(), true, "redial").await;
        let rescued = Rescued {
            control: self.control,
            rescue,
        };
        Ok((rescued, plan.rescued(leg)))
    }
}

impl Rescued {
    fn state(&self) -> &AppState {
        &self.control.state
    }

    /// Runs `operation` registered at the rescue's generation, so a newer
    /// rescue can cancel it in turn.
    async fn run<F, T>(self, operation: F) -> Result<(Self, T), Response>
    where
        F: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let output = self
            .control
            .run(self.rescue.generation(), operation)
            .await?;
        Ok((self, output))
    }

    /// Delivers the control's reply at the rescue's generation, or at the
    /// one the reply names (a leg its operation brought up).
    async fn deliver(self, reply: crate::reply::Reply) -> Result<crate::reply::Reply, Response> {
        self.control.deliver(reply, self.rescue.generation()).await
    }

    /// The PBX, locked, while this control's rescue still owns the call.
    /// Checked under the lock, where the control acts: a newer control that
    /// rescued since (a /connect pressed right after a hangup, a second tab)
    /// owns the call, and this one must not act on the leg that one dials.
    /// A rescue does not take this lock, so a newer one landing after the
    /// check only finds the work done. `None`: a newer control owns it.
    async fn lock_pbx(&self) -> Option<MutexGuard<'_, Switchboard>> {
        let board = self.state().0.switchboard.lock().await;
        self.state()
            .0
            .coordinator
            .with_generation(self.rescue.generation(), || board)
    }

    /// Ends the quiet this control's rescue began, unless a newer rescue has
    /// taken the call over since; that one settles it instead.
    async fn settle(self) {
        let Rescued { control, rescue } = self;
        control
            .settle(|coordinator| coordinator.settle(rescue))
            .await;
    }
}

/// `/connect`: cancel whatever is running, then run the PBX operation as a
/// registered operation a newer rescue can cancel in turn, and deliver its
/// reply.
async fn run_page_control<F>(
    control: Admitted,
    operation: F,
) -> Result<crate::reply::Reply, Response>
where
    F: Future<Output = crate::reply::Reply> + Send + 'static,
{
    let (rescued, _closed) = match control.rescue().await {
        Ok(rescued) => rescued,
        Err(control) => {
            tracing::info!("cancelled before it could start: the line moved on before its rescue");
            return Err(control.conflict("cancelled"));
        }
    };
    let (rescued, reply) = rescued.run(operation).await?;
    rescued.deliver(reply).await
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
    control: Admitted,
    decide: D,
) -> Result<crate::reply::Reply, Response>
where
    D: Future<Output = Redial> + Send + 'static,
{
    let (control, decided) = control.decide(decide).await?;
    let plan = match decided {
        Redial::Answered(reply) => {
            tracing::info!(
                answer = %reply.text,
                error = reply.error.as_deref().unwrap_or(""),
                elapsed = ?control.control.elapsed(),
                "decided without touching the live leg"
            );
            return control.deliver(reply).await;
        }
        Redial::Planned(plan) => *plan,
    };
    let (rescued, plan) = control.rescue_for(plan).await?;
    tracing::info!(
        project = %plan.leg().project,
        generation = rescued.rescue.generation(),
        "the redial goes ahead: running work on the leg was cancelled"
    );
    let board_state = rescued.state().clone();
    let (rescued, redialed) = rescued
        .run(async move { board_state.0.switchboard.lock().await.redial(plan).await })
        .await?;
    match redialed {
        Ok(reply) => rescued.deliver(reply).await,
        Err(_left) => {
            tracing::info!(
                elapsed = ?rescued.control.elapsed(),
                "superseded: the caller left the leg before the redial reached the PBX"
            );
            let superseded = rescued.control.conflict("superseded");
            rescued.settle().await;
            Err(superseded)
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct Hangup {
    generation: Option<u64>,
}
/// `/hangup` ends the call's leg, so one meant for a leg the call has left is
/// ignored rather than ending the leg it moved to (#263). It still needs no
/// agent: it goes straight to the PBX, past a wedged turn.
#[tracing::instrument(name = "http", skip_all, fields(endpoint = "/hangup"))]
pub(crate) async fn hangup(
    State(state): State<AppState>,
    body: Result<Json<Hangup>, JsonRejection>,
) -> Response {
    let req = match body {
        Ok(Json(req)) => req,
        Err(rejection) => return refuse_body(rejection),
    };
    tracing::info!(route = %state.0.coordinator.route(), "the page asked to hang up");
    let control = match PageControl::admit(&state, "hangup", StaleOutcome::Ignored, req.generation)
    {
        Ok(control) => control,
        Err(refused) => return refused.into_response(),
    };
    // The process the rescue closed, and the leg the PBX then dropped.
    let (rescued, closed) = match control.rescue().await {
        Ok(rescued) => rescued,
        Err(control) => {
            tracing::info!("hangup ignored: the line moved on before its rescue");
            return control.conflict("ignored");
        }
    };
    // The hangup acts only while its rescue owns the call: the leg a newer
    // control dials must not be dropped by the hangup that came before it.
    let dropped = {
        let Some(mut board) = rescued.lock_pbx().await else {
            tracing::info!(
                elapsed = ?rescued.control.elapsed(),
                "superseded: a newer control took the line before the hangup reached the PBX"
            );
            return rescued.control.conflict("superseded");
        };
        board.force_hangup().await
    };
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
    // refuses callbacks and steers until something settles it. Only its own
    // rescue's quiet: a newer control that rescued after the drop owns the
    // call and settles it itself.
    let elapsed = rescued.control.elapsed();
    rescued.settle().await;
    match hung_up {
        Some((left, _)) => {
            tracing::info!(%left, ?elapsed, "hung up; the caller is back on the operator");
            Json(json!({"hungup":true, "left":left})).into_response()
        }
        None => {
            tracing::info!(?elapsed, "nothing to hang up: already on the operator");
            Json(json!({"hungup":false, "reason":"already on the operator"})).into_response()
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
    generation: Option<u64>,
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
    let control = match PageControl::admit(
        &state,
        "connection attempt",
        StaleOutcome::Refused,
        req.generation,
    ) {
        Ok(control) => control,
        Err(refused) => return refused.into_response(),
    };
    // The picker is also an escape hatch. Cancel setup or a wedged live turn
    // before taking the PBX lock; otherwise a direct connection can wait for
    // the very leg the caller is trying to leave.
    let board_state = state.clone();
    let controlled = run_page_control(control, async move {
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
    generation: Option<u64>,
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
    let control = match PageControl::admit(
        &state,
        "thinking change",
        StaleOutcome::Refused,
        req.generation,
    ) {
        Ok(control) => control,
        Err(refused) => return refused.into_response(),
    };
    let redials = state.0.redial_planner();
    let controlled =
        run_redial_control(
            control,
            async move { redials.thinking_change(&req.level).await },
        )
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
    generation: Option<u64>,
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
    let control = match PageControl::admit(
        &state,
        "model change",
        StaleOutcome::Refused,
        req.generation,
    ) {
        Ok(control) => control,
        Err(refused) => return refused.into_response(),
    };
    let redials = state.0.redial_planner();
    let controlled = run_redial_control(
        control,
        async move { redials.model_change(&req.model).await },
    )
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

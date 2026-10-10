//! A project session's module calls over the host link: the `/host`
//! upgrade, the admission every acting call passes, and `speak`,
//! `request_to_speak`, `display` and `view`.
use crate::app_state::emit_message;
use crate::app_state::AppState;
use crate::browser::MAX_WEBSOCKET_MESSAGE_BYTES;
use crate::display::DISPLAY_CONFIRM_DEADLINE_MS;
use crate::floor::FloorRequest;
use crate::project_session::AgentCall;
use crate::protocol::ServerMessage;
#[cfg(test)]
use crate::speech::start_speech_worker_for_test;
use crate::speech::{
    reserve_speech, send_speech, trace_speech, ContinuationScope, ReserveFailure, SpeakUnder,
    SpeechAdmission, SpeechFailure, WhenQueueFull,
};
use crate::visual_protocol::invalid_name;
use axum::extract::{State, WebSocketUpgrade};
#[cfg(test)]
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
#[cfg(test)]
use http_body_util::BodyExt;
use serde::Deserialize;
use serde_json::{json, Value};

/// What `request_to_speak` takes as its `reason`, in the skill module's order
/// (`_SPEAK_REASONS`).
const SPEAK_REASONS: [&str; 3] = ["finished", "needs_decision", "problem"];
/// The views `view` names when it refuses a target, in the skill module's
/// order (`_VIEW_TARGETS`). The page also takes older names for them; this
/// is the set an agent is told.
const VIEW_TARGETS: [&str; 5] = ["visual", "comms", "system", "theater", "auto"];

async fn promote_candidate_for_token(state: &AppState, token: &str) {
    if state
        .0
        .coordinator
        .candidate_identity()
        .is_some_and(|candidate| candidate.token == token)
    {
        let _ = state.0.leg_announcer.promote_candidate(token).await;
    }
}

/// What a module call from a leg that is no longer on the call is told. The
/// skill prints a refusal to the agent word for word.
const LEG_OFF_THE_CALL: &str =
    "this leg is no longer on the call: stop retrying, nothing you send reaches the caller";
/// What a self-woken module call with no host turn behind it is told.
const SELF_WOKEN_WITHOUT_AUTHORITY: &str = "no switchboard turn is running for this leg; this self-woken call has no delivery authority, so put the result in the written reply instead";

/// A module call's refusal: the leg it names may not act on the call. It is
/// answered as a 409 `invalid_leg`, with these words as its detail.
struct LegRefusal(&'static str);

impl IntoResponse for LegRefusal {
    fn into_response(self) -> Response {
        (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"delivered":false, "code":"invalid_leg", "detail":self.0})),
        )
            .into_response()
    }
}

/// A module call admitted to act on the call: its leg was on the line, and
/// a self-woken call carried the host turn it belongs to, at `generation`.
/// Only `admit_module_call` makes one.
struct ModuleAuthority<'a> {
    token: &'a str,
    turn_id: Option<&'a str>,
    cause: Option<&'a str>,
    generation: u64,
}

impl ModuleAuthority<'_> {
    /// Checks the authority again under the display gate, the screen's side
    /// effect boundary: a rescue or adoption that landed while the call
    /// waited for the gate retires it.
    fn recheck_at_the_screen(&self, state: &AppState) -> Result<(), LegRefusal> {
        let coordinator = &state.0.coordinator;
        if coordinator.generation() == self.generation
            && coordinator
                .accept_side_effect(self.token, self.turn_id, self.cause)
                .is_ok()
        {
            return Ok(());
        }
        tracing::info!(
            generation = self.generation,
            "refused: the leg changed while it waited for the screen"
        );
        Err(LegRefusal(LEG_OFF_THE_CALL))
    }
}

/// Admits a module call to act on the call (`docs/architecture.md`, rule 3),
/// for every call that acts: a call from the candidate leg promotes it
/// first, then the coordinator decides whether the leg on the line, and the
/// host turn a self-woken call names, may act now. A refusal is the
/// `LegRefusal` the skill shows the agent; only the transfer-in-progress
/// wording is the call's own (`while_starting`), because what the agent
/// should do next differs per call. What a background session's call does
/// stays with each handler: speak refuses it, display holds it, view admits
/// it here like any other.
async fn admit_module_call<'a>(
    state: &AppState,
    token: &'a str,
    turn_id: Option<&'a str>,
    cause: Option<&'a str>,
    while_starting: &'static str,
) -> Result<ModuleAuthority<'a>, LegRefusal> {
    promote_candidate_for_token(state, token).await;
    if let Err(error) = state
        .0
        .coordinator
        .accept_side_effect(token, turn_id, cause)
    {
        tracing::info!(reason = %error, "refused: the leg is not live on the call");
        let self_woken = cause.is_some_and(|cause| cause == "autonomous" || cause == "unknown");
        let detail = match error {
            crate::lifecycle::LifecycleError::CandidateSideEffect => while_starting,
            crate::lifecycle::LifecycleError::StaleLeg if self_woken => {
                SELF_WOKEN_WITHOUT_AUTHORITY
            }
            _ => LEG_OFF_THE_CALL,
        };
        return Err(LegRefusal(detail));
    }
    Ok(ModuleAuthority {
        token,
        turn_id,
        cause,
        generation: state.0.coordinator.generation(),
    })
}

/// A project session's `speak`: its words, and the call token it carried.
struct Speak {
    text: String,
    token: String,
    turn_id: Option<String>,
    cause: Option<String>,
}
#[tracing::instrument(name = "module_call", skip_all, fields(call = "speak"))]
async fn speak(state: AppState, req: Speak) -> Response {
    let started = std::time::Instant::now();
    // The words are the caller's to hear, not the journal's to keep.
    tracing::info!(chars = req.text.chars().count(), "an agent asked to speak");
    if req.text.trim().is_empty() {
        tracing::info!("refused: the text is empty");
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"detail":"text must not be empty"})),
        )
            .into_response();
    }
    if state.0.coordinator.is_background(&req.token) {
        tracing::info!("not spoken: caller is away from background agent");
        return Json(json!({"delivered":false,"reason":"caller_away","detail":"the caller is listening to another session; use request_to_speak with the actual words they should hear. While in the background, displays are held until the caller brings you forward; never say a display is on screen."})).into_response();
    }
    let authority = match admit_module_call(
        &state,
        &req.token,
        req.turn_id.as_deref(),
        req.cause.as_deref(),
        "the line is not live until this transfer completes: do not retry from this turn; the caller can see your written reply on screen",
    )
    .await
    {
        Ok(authority) => authority,
        Err(refusal) => return refusal.into_response(),
    };
    if !state.0.delivery.connected() {
        tracing::info!("not spoken: no browser is connected");
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"delivered":false, "reason":"no browser connected", "detail":"no browser connected"})),
        )
            .into_response();
    }
    if !state.0.speaker.configured() {
        tracing::warn!("not spoken: ELEVENLABS_API_KEY is not set");
        return (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(json!({"detail":"ELEVENLABS_API_KEY is not set"})),
        )
            .into_response();
    }

    let spoken = state.0.speaker.clip_for_speech(&req.text);
    if spoken.is_empty() {
        tracing::info!("not spoken: nothing in the text can be said aloud");
        return Json(json!({"delivered":false, "reason":"text contained no speakable audio", "detail":"text contained no speakable audio"})).into_response();
    }
    // speak takes the same speech path as a reply, and differs from it on
    // purpose in what it answers the agent. A line with nothing to say aloud
    // is answered as such; a reply skips it. A full speech queue is refused at
    // once as busy instead of waited on, so the agent hears it and goes on
    // with its turn; a reply is the turn's own output and waits for its
    // place. No audio slot (the leg changed, or the audio queue is full) is
    // answered as undelivered, as when no browser is connected. The words
    // are reserved at the generation they were admitted at, so a rescue
    // since then refuses them instead of playing them to the new leg.
    let generation = authority.generation;
    let reserved = match reserve_speech(
        &state,
        SpeakUnder::Generation(generation),
        WhenQueueFull::Refuse,
    )
    .await
    {
        Ok(reserved) => reserved,
        Err(ReserveFailure::WorkerUnavailable) => {
            tracing::warn!("not spoken: the speech worker is busy or gone");
            return (
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"delivered":false, "reason":"speech worker is unavailable or busy", "detail":"speech worker is unavailable or busy"})),
            )
                .into_response();
        }
        Err(ReserveFailure::Superseded) => {
            tracing::info!(
                generation,
                "not spoken: the leg changed or the audio queue is full"
            );
            return Json(json!({"delivered":false, "reason":"no browser connected", "detail":"no browser connected"})).into_response();
        }
    };
    let sequence = reserved.sequence;
    let group = state.0.active_speech_group();
    let speaker = state.0.coordinator.route();
    let admission = SpeechAdmission {
        text: spoken,
        route: speaker.clone(),
        generation,
        deadline: std::time::Instant::now() + state.0.speech_deadline,
        scope: if group.is_some() {
            ContinuationScope::ContinueCurrentTurn
        } else {
            ContinuationScope::FreshTurn
        },
        group: group.unwrap_or_else(|| state.0.new_speech_group()),
        log_spoken: true,
    };
    match send_speech(&state, admission, reserved).await {
        Ok(()) => {
            state.0.mark_foreground_audio(generation);
            tracing::info!(generation, sequence, elapsed = ?started.elapsed(), "spoken");
            trace_speech(&state, speaker, &req.text, None, None);
            Json(delivery_response(true)).into_response()
        }
        Err(SpeechFailure::NotSpoken(detail)) => {
            tracing::info!(generation, sequence, %detail, elapsed = ?started.elapsed(), "not spoken");
            trace_speech(&state, speaker, &req.text, Some(detail.clone()), None);
            (
                axum::http::StatusCode::BAD_GATEWAY,
                Json(json!({"delivered":false, "reason":detail.clone(), "detail":detail})),
            )
                .into_response()
        }
        Err(SpeechFailure::WorkerStopped) => {
            tracing::warn!(elapsed = ?started.elapsed(), "not spoken: the speech worker stopped");
            trace_speech(
                &state,
                speaker,
                &req.text,
                Some("speech worker stopped".into()),
                None,
            );
            (
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"delivered":false, "reason":"speech worker stopped", "detail":"speech worker stopped"})),
            )
                .into_response()
        }
    }
}
fn recent_floor_context(entries: &[crate::history::TranscriptEntry]) -> String {
    entries
        .iter()
        .rev()
        .take(6)
        .rev()
        .map(|entry| {
            // Name who spoke: the caller, the operator, or the project agent.
            let speaker = if entry.role == crate::history::CALLER {
                "caller"
            } else if entry.route.is_empty() {
                entry.role.as_str()
            } else {
                entry.route.as_str()
            };
            format!("{speaker}: {}", entry.text)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Queues a background agent's request to speak on the floor, without
/// speaking for it. The floor owns who is waiting (`floor::Waiting`).
pub(crate) async fn request_to_speak(state: AppState, token: &str, raw: Value) -> Response {
    let Some(message) = raw
        .get("message")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
    else {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"detail":"message is required"})),
        )
            .into_response();
    };
    // Missing or not one of the three, it is refused as the display
    // validators refuse a name (docs/display-tool.md, "How the two
    // validators agree"), in the skill module's words.
    let Some(reason) = raw
        .get("reason")
        .and_then(Value::as_str)
        .filter(|reason| SPEAK_REASONS.contains(reason))
    else {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"detail": invalid_name("reason", &SPEAK_REASONS)})),
        )
            .into_response();
    };
    let generation = state.0.coordinator.generation();
    let context = recent_floor_context(&state.0.transcript_log.lock().await.entries());
    let Some((project, held_display)) = state.0.coordinator.with_background(token, |project| {
        (
            project.to_owned(),
            state.0.projection.has_held_display(project),
        )
    }) else {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"delivered":false,"reason":"not_on_call","detail":"this session is not a background call"})),
        )
            .into_response();
    };
    // The floor marks the agent waiting as it queues the request.
    state
        .0
        .floor
        .enqueue(FloorRequest {
            floor_id: 0,
            project,
            token: token.to_owned(),
            generation,
            context,
            message: message.to_owned(),
            reason: reason.to_owned(),
            held_display,
        })
        .await;
    Json(json!({"delivered":false,"accepted":true,"reason":null})).into_response()
}

#[tracing::instrument(
    name = "module_call",
    skip_all,
    fields(
        call = "display",
        op = tracing::field::Empty,
        kind = tracing::field::Empty,
        id = tracing::field::Empty,
    )
)]
async fn display(
    state: AppState,
    token: &str,
    turn_id: Option<&str>,
    cause: Option<&str>,
    raw: Value,
) -> Response {
    let started = std::time::Instant::now();
    // Logged by size and, once it validates, by what it does and to which
    // object; the content is the caller's screen, not the journal's.
    tracing::info!(
        bytes = raw.to_string().len(),
        "an agent sent a display action"
    );
    let Some(map) = raw.as_object() else {
        tracing::info!("refused: the arguments are not an object");
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"delivered":false, "detail":"request must be an object"})),
        )
            .into_response();
    };

    for k in map.keys() {
        if k != "action" {
            tracing::info!(field = %k, "refused: unknown field in the envelope");
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(
                    json!({"delivered":false, "detail":format!("unknown field in envelope: {k}")}),
                ),
            )
                .into_response();
        }
    }

    let Some(action_val) = map.get("action") else {
        tracing::info!("refused: no action");
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"delivered":false, "detail":"action is required"})),
        )
            .into_response();
    };

    let normalized_action = match crate::visual_protocol::validate_action(action_val) {
        Ok(act) => act,
        Err(detail) => {
            tracing::info!(%detail, "refused: the action is invalid");
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({"delivered":false, "detail":detail})),
            )
                .into_response();
        }
    };
    let span = tracing::Span::current();
    for (field, key) in [("op", "op"), ("kind", "type"), ("id", "id")] {
        if let Some(value) = normalized_action.get(key).and_then(Value::as_str) {
            span.record(field, value);
        }
    }

    let held = state.0.coordinator.with_background(token, |project| {
        state
            .0
            .projection
            .hold_display(project.to_owned(), &normalized_action)
    });
    match held {
        Some(Err(detail)) => {
            tracing::info!(%detail, "refused: the held stage is full");
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({"delivered":false, "detail":detail})),
            )
                .into_response();
        }
        Some(Ok(())) => {
            return Json(json!({
                "delivered": false,
                "accepted": true,
                "held": true,
                "reason": "caller_away",
                "detail": "the display is held, not on screen yet; it will appear when the caller brings this agent forward. Say it is ready, not that it is on screen"
            }))
            .into_response();
        }
        None => {}
    }
    let authority = match admit_module_call(
        &state,
        token,
        turn_id,
        cause,
        "the caller's screen is not live until this transfer completes: draw it again on your next turn",
    )
    .await
    {
        Ok(authority) => authority,
        Err(refusal) => return refusal.into_response(),
    };
    let permit_generation = authority.generation;

    let mut gate = state.0.display_gate.lock().await;
    if let Err(refusal) = authority.recheck_at_the_screen(&state) {
        return refusal.into_response();
    }
    // Checked under the gate, so no other display fills the stage between
    // this answer and the apply below.
    if let Some(detail) = gate.projection().refusal(&normalized_action) {
        tracing::info!(%detail, "refused: the stage is full");
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"delivered":false, "detail":detail})),
        )
            .into_response();
    }

    let (delivered, sequence) =
        gate.publish(&normalized_action, &state.0.delivery, &state.0.events);
    let mut confirm_rx = gate.confirmations();
    drop(gate);

    if !delivered {
        tracing::info!(
            generation = permit_generation,
            sequence,
            "applied to the scene; no browser is connected to show it"
        );
        return Json(json!({"delivered": false, "reason": "no browser connected"})).into_response();
    }

    let deadline = tokio::time::sleep(std::time::Duration::from_millis(
        DISPLAY_CONFIRM_DEADLINE_MS,
    ));
    tokio::pin!(deadline);
    loop {
        {
            let c = confirm_rx.borrow_and_update();
            if c.generation == permit_generation {
                if let Some(reason) = c.rejection(sequence) {
                    tracing::info!(
                        generation = permit_generation,
                        sequence,
                        %reason,
                        elapsed = ?started.elapsed(),
                        "the browser could not render it"
                    );
                    return Json(json!({
                        "delivered": true, "rendered": false,
                        "rejected": true, "reason": reason
                    }))
                    .into_response();
                }
                if c.watermark.is_some_and(|w| w >= sequence) {
                    tracing::info!(
                        generation = permit_generation,
                        sequence,
                        elapsed = ?started.elapsed(),
                        "rendered"
                    );
                    return Json(json!({"delivered": true, "rendered": true})).into_response();
                }
            } else if c.generation > permit_generation {
                tracing::info!(
                    generation = permit_generation,
                    sequence,
                    current = c.generation,
                    elapsed = ?started.elapsed(),
                    "not confirmed: the screen moved to a new leg first"
                );
                return Json(json!({
                    "delivered": true, "rendered": false,
                    "reason": "the caller's screen moved to a new leg before this was confirmed"
                }))
                .into_response();
            }
        }
        tokio::select! {
            changed = confirm_rx.changed() => { if changed.is_err() { break; } }
            _ = &mut deadline => { break; }
        }
    }
    tracing::info!(
        generation = permit_generation,
        sequence,
        elapsed = ?started.elapsed(),
        "delivered; the browser did not confirm it in time"
    );
    Json(json!({
        "delivered": true, "rendered": false,
        "reason": "no confirmation from the browser"
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ViewRequest {
    #[serde(default)]
    target: String,
    #[serde(default)]
    reason: String,
}

#[tracing::instrument(name = "module_call", skip_all, fields(call = "view"))]
async fn view(
    state: AppState,
    token: &str,
    turn_id: Option<&str>,
    cause: Option<&str>,
    args: Value,
) -> Response {
    let req = match serde_json::from_value::<ViewRequest>(args) {
        Ok(req) => req,
        Err(error) => {
            tracing::info!(%error, "refused: the arguments are not a view request");
            return (
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({"delivered":false, "detail":error.to_string()})),
            )
                .into_response();
        }
    };
    // An empty target asks what the caller can see; anything else asks the
    // page to change it. The agent's stated reason is not logged.
    tracing::info!(
        requested = %req.target.chars().take(64).collect::<String>(),
        "an agent asked about the caller's view"
    );
    let target = req.target.trim().to_ascii_lowercase();
    // A background agent may ask what the caller sees, not change it: its
    // displays are held until the caller brings it forward, and the screen
    // belongs to whoever the caller is with.
    if !target.is_empty() && state.0.coordinator.is_background(token) {
        tracing::info!("not changed: caller is away from background agent");
        return Json(json!({"delivered":false,"reason":"caller_away","detail":"the caller is with another session, so their screen is not yours to change; it follows your display when they bring you forward. view() with no target still reports what they see."})).into_response();
    }
    let authority = match admit_module_call(
        &state,
        token,
        turn_id,
        cause,
        "the caller's screen is not live until this transfer completes: switch view again on your next turn",
    )
    .await
    {
        Ok(authority) => authority,
        Err(refusal) => return refusal.into_response(),
    };
    let permit_generation = authority.generation;

    let gate = state.0.display_gate.lock().await;
    if let Err(refusal) = authority.recheck_at_the_screen(&state) {
        return refusal.into_response();
    }

    if target.is_empty() {
        let (has_visual, kind, title, object_ids) = gate.projection().summary();
        let view = gate.screen().view().to_owned();
        let connected = state.0.delivery.connected();
        let confirmed = gate.stage_confirmed(permit_generation);
        tracing::info!(
            %view,
            has_visual,
            kind = kind.as_deref().unwrap_or_default(),
            confirmed,
            connected,
            "reported the caller's view"
        );
        let screen = json!({
            "view": view,
            "has_visual": has_visual,
            "visual_kind": kind,
            "title": title.unwrap_or_default(),
            "object_ids": object_ids,
            "confirmed": confirmed,
            "connected": connected,
            "stale": !confirmed,
        });
        return Json(json!({"delivered": true, "screen": screen})).into_response();
    }

    if !matches!(
        target.as_str(),
        "auto"
            | "stage"
            | "bay2"
            | "visual"
            | "comms"
            | "transcript"
            | "bay3"
            | "system"
            | "magi"
            | "routing"
            | "bay1"
            | "overview"
            | "grid"
            | "split"
            | "theater"
    ) {
        tracing::info!("refused: not a view the page has");
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({
                "delivered": false,
                "detail": invalid_name("target", &VIEW_TARGETS)
            })),
        )
            .into_response();
    }

    drop(gate);
    let delivered = emit_message(
        &state,
        ServerMessage::View {
            target,
            reason: req.reason,
        },
    );
    if delivered {
        tracing::info!(
            generation = permit_generation,
            "asked the page to change the view"
        );
    } else {
        tracing::info!("not delivered: no browser is connected");
    }
    Json(delivery_response(delivered)).into_response()
}

fn delivery_response(delivered: bool) -> Value {
    if delivered {
        json!({"delivered":true})
    } else {
        json!({"delivered":false, "reason":"no browser connected"})
    }
}

/// Answers a project session's `speak`, `display` or `view` module call
/// (`docs/host-link.md`, "Module calls") with the same checks and effects
/// for every session: the call token must name the leg on the line.
pub(crate) async fn module_call(state: &AppState, call: AgentCall) -> Value {
    let response = agent_call(state, &call).await;
    module_reply(&call.call, response).await
}

/// Runs a module call and answers it as a response: its status code says
/// how it went, and its JSON body is the result.
async fn agent_call(state: &AppState, call: &AgentCall) -> Response {
    match call.call.as_str() {
        "speak" => {
            let Some(text) = call.args.get("text").and_then(Value::as_str) else {
                return (
                    axum::http::StatusCode::BAD_REQUEST,
                    Json(json!({"detail":"text is required"})),
                )
                    .into_response();
            };
            speak(
                state.clone(),
                Speak {
                    text: text.to_owned(),
                    token: call.token.clone(),
                    turn_id: call.turn_id.clone(),
                    cause: call.cause.clone(),
                },
            )
            .await
        }
        "request_to_speak" => request_to_speak(state.clone(), &call.token, call.args.clone()).await,
        "display" => {
            display(
                state.clone(),
                &call.token,
                call.turn_id.as_deref(),
                call.cause.as_deref(),
                call.args.clone(),
            )
            .await
        }
        "view" => {
            let args = if call.args.is_null() {
                json!({})
            } else {
                call.args.clone()
            };
            view(
                state.clone(),
                &call.token,
                call.turn_id.as_deref(),
                call.cause.as_deref(),
                args,
            )
            .await
        }
        _ => (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"detail":"unknown call"})),
        )
            .into_response(),
    }
}

/// A module reply from a call's response. Delivered when the body says
/// `delivered: true`; a display the scene took with no browser to show it is
/// accepted; a call answered `delivered: false`, or refused as invalid (4xx),
/// is refused; anything else failed. The reason is the body's `reason` when
/// it has one, so a code such as `caller_away` reaches the module bare (the
/// module and SKILL.md branch on it), and its `detail` otherwise. The body,
/// detail included, goes back as the `result`.
async fn module_reply(call: &str, response: Response) -> Value {
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), MAX_WEBSOCKET_MESSAGE_BYTES)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or_else(|| json!({}));
    let stated = body
        .get("reason")
        .and_then(Value::as_str)
        .or_else(|| body.get("detail").and_then(Value::as_str))
        .map(str::to_owned);
    let (outcome, reason) = if status.is_success() && body["delivered"] == true {
        ("delivered", None)
    } else if status.is_success() && body["accepted"] == true {
        ("accepted", None)
    } else if status.is_success() && call == "display" {
        ("accepted", stated)
    } else if body["delivered"] == false || status.is_success() || status.is_client_error() {
        ("refused", stated)
    } else {
        ("failed", stated)
    };
    let mut result = body;
    if outcome == "failed" {
        result["error"] = json!(reason.clone().unwrap_or_else(|| "failed".into()));
    }
    json!({"status": outcome, "reason": reason, "result": result})
}

/// A project host's link; `hosts.rs` owns it.
pub(crate) async fn host_link(
    State(state): State<AppState>,
    upgrade: WebSocketUpgrade,
) -> Response {
    state.0.hosts.accept(upgrade, state.0.shutdown.subscribe())
}

/// A project session's module call, as the host link delivers it and the
/// application answers it: `path` names the call the way the agent callback
/// routes once did, and a `token` in `body` is the call token it carries.
#[cfg(test)]
pub(crate) async fn agent_call_json(
    state: &AppState,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    start_speech_worker_for_test(state);
    let mut args = body;
    let token = args
        .as_object_mut()
        .and_then(|args| args.remove("token"))
        .and_then(|token| token.as_str().map(str::to_owned))
        .unwrap_or_default();
    let call = AgentCall {
        call: path.trim_start_matches('/').to_owned(),
        token,
        turn_id: None,
        cause: None,
        args,
    };
    let response = agent_call(state, &call).await;
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[cfg(test)]
pub(crate) async fn post_display_in_task(
    state: &AppState,
    body: Value,
) -> tokio::task::JoinHandle<(StatusCode, Value)> {
    let state = state.clone();
    tokio::spawn(async move { agent_call_json(&state, "/display", body).await })
}

#[cfg(test)]
pub(crate) fn diagram_show() -> Value {
    json!({"action":{"op":"show","id":"d1","type":"diagram","data":{
        "mode":"graph","nodes":[{"id":"a","label":"A"}],"edges":[]}}})
}

#[cfg(test)]
#[path = "../tests/test_module_calls.rs"]
mod tests;

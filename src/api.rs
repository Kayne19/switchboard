//! HTTP, WebSocket and application workers.
use crate::audio::{Speaker, SttAdapter};
use crate::history::{TranscriptLog, AGENT, CALLER};
use crate::pbx::{ActivityClock, LiveLegState, RouteCallback, Switchboard};
use crate::pi_client::{Activity, ActivityCallback, PiSession};
use axum::extract::ws::{Message, WebSocket};
use axum::{
    extract::{State, WebSocketUpgrade},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, RwLock as StdRwLock,
    },
};
use tokio::sync::{broadcast, mpsc, watch, Mutex};
use tokio::task::{AbortHandle, Id as TaskId, JoinHandle};
use tower_http::services::ServeDir;

const MAX_WEBSOCKET_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState(pub Arc<AppInner>);
pub struct AppInner {
    pub switchboard: Mutex<Switchboard>,
    pub transcript_log: Mutex<TranscriptLog>,
    pub speaker: Speaker,
    pub stt: SttAdapter,
    pub events: broadcast::Sender<Event>,
    status_snapshot: Arc<StdRwLock<Value>>,
    speech: mpsc::Sender<String>,
    speech_rx: Mutex<Option<mpsc::Receiver<String>>>,
    clips: mpsc::Sender<Clip>,
    clip_rx: Mutex<Option<mpsc::Receiver<Clip>>>,
    pub turns: mpsc::Sender<(String, String, u64)>,
    turn_rx: Mutex<Option<mpsc::Receiver<(String, String, u64)>>>,
    pub accepted_clips: Mutex<(HashSet<String>, VecDeque<String>)>,
    pub last_diagram: Arc<Mutex<Option<Value>>>,
    pub active_session: Arc<Mutex<Option<PiSession>>>,
    activity_clock: ActivityClock,
    live_leg: LiveLegState,
    operation_transition: Mutex<()>,
    active_operations: Mutex<HashMap<TaskId, AbortHandle>>,
    pub turn_generation: AtomicU64,
    pub queued_turns: AtomicU64,
    pub turn_in_flight: AtomicBool,
    shutdown: watch::Sender<bool>,
}
#[derive(Clone, Debug)]
pub enum Event {
    Json(Value),
    Audio(Vec<u8>),
}
#[derive(Debug)]
pub struct Clip {
    id: String,
    audio: Vec<u8>,
    _mime: String,
    // Stamped when the clip is accepted, not when its transcript comes back.
    // Transcription is a sidecar round trip, and a page transfer can land
    // inside it; without this the reply epoch would be read after the rescue
    // and pre-rescue speech would count as current.
    generation: u64,
}

impl AppState {
    pub fn new(
        switchboard: Switchboard,
        transcript_log: TranscriptLog,
        speaker: Speaker,
        stt: SttAdapter,
    ) -> Self {
        let (events, _) = broadcast::channel(256);
        let (speech, speech_rx) = mpsc::channel(64);
        // Audio frames may be up to the WebSocket limit. A small bounded queue
        // prevents a stalled decoder from retaining roughly a gigabyte of
        // accepted clips while still leaving ample room for one caller's
        // retransmit/burst behavior.
        let (clips, clip_rx) = mpsc::channel(8);
        let (turns, turn_rx) = mpsc::channel(64);
        let (shutdown, _) = watch::channel(false);
        let activity_events = events.clone();
        let activity_callback: ActivityCallback = Arc::new(move |activity: Activity| {
            let events = activity_events.clone();
            Box::pin(async move {
                let _ = events.send(Event::Json(json!({
                    "type": "activity",
                    "state": activity.state,
                    "tool": activity.tool,
                    "detail": activity.detail,
                    "label": activity.label,
                })));
            })
        });
        let last_diagram = Arc::new(Mutex::new(None));
        let status_snapshot = Arc::new(StdRwLock::new(switchboard.status()));
        let route_events = events.clone();
        let route_diagram = last_diagram.clone();
        let route_status = status_snapshot.clone();
        let route_callback: RouteCallback = Arc::new(move |status| {
            let events = route_events.clone();
            let diagram = route_diagram.clone();
            let status_snapshot = route_status.clone();
            Box::pin(async move {
                *status_snapshot
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = status.clone();
                *diagram.lock().await = None;
                let _ = events.send(Event::Json(status));
            })
        });
        let active_session = switchboard.session_control();
        let activity_clock = switchboard.activity_clock();
        let live_leg = switchboard.live_leg_state();
        let mut switchboard = switchboard;
        switchboard.set_activity_callback(Some(activity_callback));
        switchboard.set_route_callback(Some(route_callback));
        Self(Arc::new(AppInner {
            switchboard: Mutex::new(switchboard),
            transcript_log: Mutex::new(transcript_log),
            speaker,
            stt,
            events,
            status_snapshot,
            speech,
            speech_rx: Mutex::new(Some(speech_rx)),
            clips,
            clip_rx: Mutex::new(Some(clip_rx)),
            turns,
            turn_rx: Mutex::new(Some(turn_rx)),
            accepted_clips: Mutex::new((HashSet::new(), VecDeque::new())),
            last_diagram,
            active_session,
            activity_clock,
            live_leg,
            operation_transition: Mutex::new(()),
            active_operations: Mutex::new(HashMap::new()),
            turn_generation: AtomicU64::new(0),
            queued_turns: AtomicU64::new(0),
            turn_in_flight: AtomicBool::new(false),
            shutdown,
        }))
    }
    pub fn router(self, static_dir: Option<ServeDir>) -> Router {
        let router = Router::new()
            .route("/healthz", get(healthz))
            .route("/status", get(status))
            .route("/hangup", post(hangup))
            .route("/connect", post(connect))
            .route("/thinking", post(thinking))
            .route("/leg-state", post(leg_state))
            .route("/speak", post(speak))
            .route("/diagram", post(diagram))
            .route("/ws", get(ws))
            .with_state(self);
        if let Some(service) = static_dir {
            router.fallback_service(service)
        } else {
            router
        }
    }
}

pub fn spawn_workers(state: AppState) {
    let speech_state = state.clone();
    tokio::spawn(async move {
        process_speech(speech_state).await;
    });
    let clip_state = state.clone();
    tokio::spawn(async move {
        process_clips(clip_state).await;
    });
    tokio::spawn(async move {
        process_turns(state).await;
    });
}
pub async fn shutdown(state: &AppState) {
    // Close upgraded WebSockets as well as the PBX children. Axum's graceful
    // shutdown waits for upgraded connections, so merely stopping the listener
    // can otherwise leave systemd waiting on a browser tab indefinitely.
    state.0.shutdown.send_replace(true);
    interrupt_active_turn(state).await;
    state.0.switchboard.lock().await.shutdown().await;
}
pub fn spawn_idle_worker(state: AppState, idle_timeout: f64, poll_seconds: f64) {
    if idle_timeout <= 0.0 {
        return;
    }
    tokio::spawn(async move {
        let poll = tokio::time::Duration::from_secs_f64(poll_seconds.max(1.0));
        let mut shutdown = state.0.shutdown.subscribe();
        loop {
            tokio::select! {
                _ = tokio::time::sleep(poll) => {}
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        return;
                    }
                    continue;
                }
            }
            let mut board = state.0.switchboard.lock().await;
            if let Some(left) = board.return_if_idle(idle_timeout).await {
                let route = board.route().to_owned();
                drop(board);
                let minutes = (idle_timeout / 60.0).floor() as u64;
                if let Some(entry) = state.0.transcript_log.lock().await.add(AGENT, &format!("Nothing was said for {minutes} minutes, so the line to {left} was dropped. You're back with the operator."), route) {
                    emit_json(&state, json!({"type":"spoken", "entry":entry}));
                }
            }
        }
    });
}
fn emit(state: &AppState, event: Event) -> bool {
    state.0.events.send(event).is_ok()
}
fn emit_json(state: &AppState, value: Value) -> bool {
    emit(state, Event::Json(value))
}
fn current_status(state: &AppState) -> Value {
    state
        .0
        .status_snapshot
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}
fn publish_status(state: &AppState, status: Value) {
    *state
        .0
        .status_snapshot
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = status.clone();
    emit_json(state, status);
}
async fn spawn_active_operation<F, T>(state: &AppState, future: F) -> (JoinHandle<T>, TaskId, u64)
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let _transition = state.0.operation_transition.lock().await;
    let generation = state.0.turn_generation.load(Ordering::Acquire);
    let (task, id) = spawn_registered_operation(state, future).await;
    (task, id, generation)
}
async fn spawn_registered_operation<F, T>(state: &AppState, future: F) -> (JoinHandle<T>, TaskId)
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    // Acquire the registry before spawning. A rescue cannot observe a task
    // that owns (or is about to own) the PBX lock without its abort handle.
    let mut active = state.0.active_operations.lock().await;
    let task = tokio::spawn(future);
    let abort = task.abort_handle();
    let id = abort.id();
    active.insert(id, abort);
    (task, id)
}
async fn clear_active_operation(state: &AppState, id: TaskId) {
    state.0.active_operations.lock().await.remove(&id);
}

async fn process_speech(state: AppState) {
    let mut receiver = state
        .0
        .speech_rx
        .lock()
        .await
        .take()
        .expect("speech worker started once");
    while let Some(text) = receiver.recv().await {
        let started = std::time::Instant::now();
        match state.0.speaker.synthesize(&text).await {
            Ok(audio) => {
                tracing::info!(
                    chars = text.chars().count(),
                    bytes = audio.len(),
                    elapsed = ?started.elapsed(),
                    "synthesized a mid-turn line"
                );
                emit(&state, Event::Audio(audio));
            }
            Err(error) => {
                // The caller hears nothing at all when this fails, so it must
                // never be inferable only from the absence of audio.
                tracing::error!(%error, chars = text.chars().count(), "synthesis failed for an agent-spoken line");
                emit_json(&state, json!({"type":"error", "message":error.to_string()}));
            }
        }
    }
    tracing::warn!("the speech worker stopped; agent-spoken lines will not be voiced");
}

async fn process_clips(state: AppState) {
    let mut receiver = state
        .0
        .clip_rx
        .lock()
        .await
        .take()
        .expect("clip worker started once");
    while let Some(clip) = receiver.recv().await {
        // The clip id is the one identifier that spans the whole call path —
        // the browser minted it, the transcript carries it, and every error
        // frame quotes it. Logging it at each stage is what makes a caller's
        // "it broke when I said X" answerable from the journal.
        let started = std::time::Instant::now();
        tracing::info!(clip = %clip.id, bytes = clip.audio.len(), "transcribing clip");
        let transcript = match state.0.stt.transcribe(&clip.audio).await {
            Ok(text) => text,
            Err(error) => {
                tracing::error!(clip = %clip.id, bytes = clip.audio.len(), %error, "transcription failed");
                emit_json(
                    &state,
                    json!({"type":"error", "id":clip.id, "message":format!("Transcription failed: {error}")}),
                );
                continue;
            }
        };
        if transcript.trim().is_empty() {
            tracing::info!(clip = %clip.id, elapsed = ?started.elapsed(), "transcription returned nothing");
            emit_json(
                &state,
                json!({"type":"error", "id":clip.id, "message":"I didn't catch that — say it again."}),
            );
            continue;
        }
        let route = state.0.live_leg.route();
        tracing::info!(
            clip = %clip.id,
            %route,
            chars = transcript.chars().count(),
            elapsed = ?started.elapsed(),
            "transcribed clip"
        );
        state.0.transcript_log.lock().await.add_with_id(
            CALLER,
            &transcript,
            route.clone(),
            Some(clip.id.clone()),
        );
        emit_json(
            &state,
            json!({"type":"transcript", "id":clip.id, "text":transcript}),
        );
        // Steering is deliberately performed through the shared session handle,
        // not while holding the PBX mutex. The turn worker keeps that mutex for
        // the duration of handle(), so awaiting here would deadlock it.
        let steered = {
            // Hold the session-control guard across the write so a hangup or
            // redial cannot replace the child between the identity check and
            // the steer. The PBX mutex is intentionally not held here.
            let active = state.0.active_session.lock().await;
            // Speech captured before a page rescue is discarded rather than
            // acted on. Checked under the session guard because a rescue bumps
            // the generation before it closes the session, so a steer that wins
            // this lock still observes the new epoch.
            let current = state.0.turn_generation.load(Ordering::Acquire);
            if clip.generation != current {
                tracing::info!(
                    clip = %clip.id,
                    stamped = clip.generation,
                    %current,
                    "discarding speech captured before a page rescue"
                );
                continue;
            }
            match active.as_ref().cloned() {
                None => false,
                Some(session) if !session.busy() || !session.alive().await => false,
                Some(session) => match session.steer(&transcript).await {
                    Ok(()) => {
                        // A session swapped out under us means the steer landed
                        // in a leg the caller has already left.
                        let same = active
                            .as_ref()
                            .is_some_and(|current| current.same_session(&session));
                        if !same {
                            tracing::warn!(clip = %clip.id, "the leg was replaced mid-steer; queueing the utterance");
                        }
                        same
                    }
                    Err(error) => {
                        tracing::warn!(clip = %clip.id, %error, "steering failed; queueing the utterance");
                        false
                    }
                },
            }
        };
        if steered {
            tracing::info!(clip = %clip.id, %route, "steered the live turn");
            state.0.activity_clock.touch();
            emit_json(
                &state,
                json!({"type":"queued", "id":clip.id, "waiting":0, "steered":true}),
            );
        } else {
            let waiting = state.0.queued_turns.fetch_add(1, Ordering::AcqRel) + 1;
            if state
                .0
                .turns
                .send((clip.id.clone(), transcript, clip.generation))
                .await
                .is_ok()
            {
                if waiting > 1 || state.0.turn_in_flight.load(Ordering::Acquire) {
                    emit_json(
                        &state,
                        json!({"type":"queued", "id":clip.id, "waiting":waiting, "steered":false}),
                    );
                }
            } else {
                tracing::error!(clip = %clip.id, "the turn worker is gone; the utterance was dropped");
                state.0.queued_turns.fetch_sub(1, Ordering::AcqRel);
            }
        }
    }
    tracing::warn!("the clip worker stopped; no further speech will be transcribed");
}
async fn process_turns(state: AppState) {
    let mut receiver = state
        .0
        .turn_rx
        .lock()
        .await
        .take()
        .expect("turn worker started once");
    while let Some((id, transcript, generation)) = receiver.recv().await {
        state.0.queued_turns.fetch_sub(1, Ordering::AcqRel);
        let turn_state = state.clone();
        let started = std::time::Instant::now();
        // Register the abort handle before awaiting the task. Page-level rescue
        // endpoints can now cancel work even while transfer setup has no
        // PiSession yet.
        let (task, task_id) = {
            let _transition = state.0.operation_transition.lock().await;
            let current = state.0.turn_generation.load(Ordering::Acquire);
            if generation != current {
                tracing::info!(clip = %id, stamped = generation, %current, "dropping a queued turn from before a page rescue");
                continue;
            }
            state.0.turn_in_flight.store(true, Ordering::Release);
            let status = current_status(&state);
            let waiting = state.0.queued_turns.load(Ordering::Acquire);
            tracing::info!(clip = %id, route = %status["route"], waiting, "dispatching a turn");
            emit_json(
                &state,
                json!({"type":"thinking", "route":status["route"], "waiting":waiting}),
            );
            spawn_registered_operation(&state, async move {
                let mut board = turn_state.0.switchboard.lock().await;
                let reply = board.handle(&transcript).await;
                let status = board.status();
                (reply, status)
            })
            .await
        };
        let (reply, status) = match task.await {
            Ok(result) => result,
            Err(error) if error.is_cancelled() => {
                tracing::info!(clip = %id, elapsed = ?started.elapsed(), "the turn was cancelled by a page rescue");
                clear_active_operation(&state, task_id).await;
                state.0.turn_in_flight.store(false, Ordering::Release);
                continue;
            }
            Err(error) => {
                // A panic inside `handle()` arrives here. Without this line the
                // caller hears a generic apology and the journal holds nothing.
                tracing::error!(clip = %id, %error, elapsed = ?started.elapsed(), "the turn worker failed");
                clear_active_operation(&state, task_id).await;
                state.0.turn_in_flight.store(false, Ordering::Release);
                emit_json(
                    &state,
                    json!({"type":"error", "message":format!("The call worker failed on that turn: {error}")}),
                );
                continue;
            }
        };
        clear_active_operation(&state, task_id).await;
        if let Some(error) = &reply.error {
            // The caller was answered and recovered, so this is not an error
            // level — but a turn that carried a failure is worth an audit trail.
            tracing::warn!(clip = %id, route = %reply.route, %error, "the turn reported a failure");
        }
        tracing::info!(clip = %id, route = %reply.route, elapsed = ?started.elapsed(), "turn settled");
        deliver_turn_if_current(&state, &reply, status, generation).await;
        state.0.turn_in_flight.store(false, Ordering::Release);
    }
    tracing::warn!("the turn worker stopped; no further turns will be dispatched");
}

async fn healthz(State(state): State<AppState>) -> impl IntoResponse {
    let status = current_status(&state);
    Json(
        json!({"status":"ok", "whisper_model":"sidecar", "stt_configured":state.0.stt.command.is_some(), "stt_adapter":"sidecar", "elevenlabs_configured":state.0.speaker.configured(), "route":status["route"], "model":status["model"], "thinking":status["thinking"], "model_swaps":status["model_swaps"], "projects":status["projects"]}),
    )
}
async fn status(State(state): State<AppState>) -> impl IntoResponse {
    Json(current_status(&state))
}
async fn interrupt_active_turn(state: &AppState) -> Option<String> {
    let _transition = state.0.operation_transition.lock().await;
    cancel_active_operations(state).await
}
async fn cancel_active_operations(state: &AppState) -> Option<String> {
    let generation = state.0.turn_generation.fetch_add(1, Ordering::AcqRel) + 1;
    // Tell the browser at once, so speech it starts recording after this point
    // is stamped with the new epoch rather than the one being retired.
    emit_json(state, json!({"type":"epoch", "generation":generation}));
    let operations = std::mem::take(&mut *state.0.active_operations.lock().await);
    for operation in operations.into_values() {
        operation.abort();
    }
    let active = state.0.active_session.lock().await.clone();
    let label = active.as_ref().map(|session| session.label().to_owned());
    if let Some(session) = active {
        session.close().await;
    }
    label
}
async fn spawn_replacing_operation<F, T>(
    state: &AppState,
    future: F,
) -> (JoinHandle<T>, TaskId, u64)
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let _transition = state.0.operation_transition.lock().await;
    cancel_active_operations(state).await;
    let generation = state.0.turn_generation.load(Ordering::Acquire);
    let (task, id) = spawn_registered_operation(state, future).await;
    (task, id, generation)
}
async fn hangup(State(state): State<AppState>) -> impl IntoResponse {
    let interrupted = interrupt_active_turn(&state).await;
    let mut board = state.0.switchboard.lock().await;
    let left = board.force_hangup().await.or(interrupted);
    let status = board.status();
    drop(board);
    if let Some(left) = &left {
        if let Some(entry) = state.0.transcript_log.lock().await.add(
            AGENT,
            &format!("You hung up the line to {left}. You're back with the operator."),
            status["route"].as_str().unwrap_or("operator"),
        ) {
            emit_json(&state, json!({"type":"spoken", "entry":entry}));
        }
        publish_status(&state, status);
    }
    match left {
        Some(left) => Json(json!({"hungup":true, "left":left})),
        None => Json(json!({"hungup":false, "reason":"already on the operator"})),
    }
}
#[derive(Deserialize)]
struct Connect {
    project: String,
    #[serde(default)]
    intent: String,
}
async fn connect(State(state): State<AppState>, Json(req): Json<Connect>) -> Response {
    // The picker is also an escape hatch. Cancel setup or a wedged live turn
    // before taking the PBX lock; otherwise a direct connection can wait for
    // the very leg the caller is trying to leave.
    let operation_state = state.clone();
    let (task, task_id, generation) = spawn_replacing_operation(&state, async move {
        let mut board = operation_state.0.switchboard.lock().await;
        let reply = board.dial(&req.project, &req.intent).await;
        let status = board.status();
        (reply, status)
    })
    .await;
    let (reply, status) = match task.await {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => {
            clear_active_operation(&state, task_id).await;
            return (
                axum::http::StatusCode::CONFLICT,
                Json(json!({"detail":"connection attempt was cancelled"})),
            )
                .into_response();
        }
        Err(error) => {
            clear_active_operation(&state, task_id).await;
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"detail":format!("connection attempt failed: {error}")})),
            )
                .into_response();
        }
    };
    clear_active_operation(&state, task_id).await;
    if !deliver_page_reply_if_current(&state, &reply, status, generation).await {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"detail":"connection attempt was superseded"})),
        )
            .into_response();
    }
    Json(json!({"route":reply.route, "error":reply.error.clone()})).into_response()
}
#[derive(Deserialize)]
struct Thinking {
    level: String,
}
async fn thinking(State(state): State<AppState>, Json(req): Json<Thinking>) -> Response {
    let operation_state = state.clone();
    let operation = async move {
        let mut board = operation_state.0.switchboard.lock().await;
        let reply = board.set_thinking(&req.level).await;
        let status = board.status();
        (reply, status)
    };
    let (task, task_id, generation) = if state.0.live_leg.route() == crate::pbx::OPERATOR {
        let (task, task_id, generation) = spawn_active_operation(&state, operation).await;
        (task, task_id, generation)
    } else {
        spawn_replacing_operation(&state, operation).await
    };
    let (reply, status) = match task.await {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => {
            clear_active_operation(&state, task_id).await;
            return (
                axum::http::StatusCode::CONFLICT,
                Json(json!({"detail":"thinking change was cancelled"})),
            )
                .into_response();
        }
        Err(error) => {
            clear_active_operation(&state, task_id).await;
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"detail":format!("thinking change failed: {error}")})),
            )
                .into_response();
        }
    };
    clear_active_operation(&state, task_id).await;
    if !deliver_page_reply_if_current(&state, &reply, status, generation).await {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"detail":"thinking change was superseded"})),
        )
            .into_response();
    }
    Json(json!({"thinking":current_status(&state)["thinking"], "error":reply.error.clone()}))
        .into_response()
}
#[derive(Deserialize)]
struct LegState {
    #[serde(default)]
    thinking: String,
}
async fn leg_state(State(state): State<AppState>, Json(req): Json<LegState>) -> impl IntoResponse {
    let accepted = state.0.live_leg.report_thinking(&req.thinking);
    if accepted {
        let mut status = current_status(&state);
        status["thinking"] = Value::String(req.thinking.clone());
        status["thinking_confirmed"] = Value::Bool(true);
        publish_status(&state, status);
    }
    Json(json!({"accepted":accepted}))
}
#[derive(Deserialize)]
struct Speak {
    text: String,
}
async fn speak(State(state): State<AppState>, Json(req): Json<Speak>) -> Response {
    if req.text.trim().is_empty() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"detail":"text must not be empty"})),
        )
            .into_response();
    }
    if !state.0.speaker.configured() {
        return (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(json!({"detail":"ELEVENLABS_API_KEY is not set"})),
        )
            .into_response();
    }

    let spoken = state.0.speaker.clip_for_speech(&req.text);
    let speech_permit = if spoken.is_empty() {
        None
    } else {
        match state.0.speech.try_reserve() {
            Ok(permit) => Some(permit),
            Err(_) => {
                return (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"detail":"speech worker is unavailable or busy"})),
                )
                    .into_response()
            }
        }
    };

    let route = state.0.live_leg.route();
    if let Some(entry) = state
        .0
        .transcript_log
        .lock()
        .await
        .add(AGENT, &req.text, route)
    {
        emit_json(&state, json!({"type":"spoken", "entry":entry}));
    }

    let delivered = state.0.events.receiver_count() > 0;
    if let Some(permit) = speech_permit {
        permit.send(spoken);
    }

    Json(delivery_response(delivered)).into_response()
}
#[derive(Deserialize)]
struct Diagram {
    source: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    notes: String,
}
async fn diagram(State(state): State<AppState>, Json(req): Json<Diagram>) -> impl IntoResponse {
    let value =
        json!({"type":"diagram", "source":req.source, "title":req.title, "notes":req.notes});
    *state.0.last_diagram.lock().await = Some(value.clone());
    let delivered = emit_json(&state, value);
    Json(delivery_response(delivered))
}
fn delivery_response(delivered: bool) -> Value {
    if delivered {
        json!({"delivered":true})
    } else {
        json!({"delivered":false, "reason":"no browser connected"})
    }
}
async fn deliver_page_reply_if_current(
    state: &AppState,
    reply: &crate::pbx::Reply,
    status: Value,
    generation: u64,
) -> bool {
    let _transition = state.0.operation_transition.lock().await;
    if generation != state.0.turn_generation.load(Ordering::Acquire) {
        return false;
    }
    if !reply.text.is_empty() {
        if let Some(entry) =
            state
                .0
                .transcript_log
                .lock()
                .await
                .add(AGENT, &reply.text, reply.route.clone())
        {
            emit_json(state, json!({"type":"spoken", "entry":entry}));
        }
    }
    publish_status(state, status);
    drop(_transition);
    synthesize_reply_if_current(state, &reply.to_speak, generation).await
}

async fn deliver_turn_if_current(
    state: &AppState,
    reply: &crate::pbx::Reply,
    status: Value,
    generation: u64,
) -> bool {
    let _transition = state.0.operation_transition.lock().await;
    if generation != state.0.turn_generation.load(Ordering::Acquire) {
        return false;
    }
    if !reply.text.is_empty() {
        state
            .0
            .transcript_log
            .lock()
            .await
            .add(AGENT, &reply.text, reply.route.clone());
    }
    emit_json(
        state,
        json!({"type":"reply", "text":reply.text, "route":reply.route}),
    );
    publish_status(state, status);
    drop(_transition);
    synthesize_reply_if_current(state, &reply.to_speak, generation).await
}

async fn synthesize_reply_if_current(
    state: &AppState,
    utterances: &[String],
    generation: u64,
) -> bool {
    for text in utterances {
        let spoken = state.0.speaker.clip_for_speech(text);
        if spoken.is_empty() {
            continue;
        }
        let started = std::time::Instant::now();
        let synthesized = state.0.speaker.synthesize(&spoken).await;
        let _transition = state.0.operation_transition.lock().await;
        if generation != state.0.turn_generation.load(Ordering::Acquire) {
            tracing::info!(
                generation,
                "discarding synthesized audio for a superseded turn"
            );
            return false;
        }
        match synthesized {
            Ok(audio) => {
                tracing::info!(
                    chars = spoken.chars().count(),
                    bytes = audio.len(),
                    elapsed = ?started.elapsed(),
                    "synthesized a reply"
                );
                emit(state, Event::Audio(audio));
            }
            Err(error) => {
                tracing::error!(%error, chars = spoken.chars().count(), "synthesis failed; the caller hears nothing for this reply");
                emit_json(state, json!({"type":"error", "message":error.to_string()}));
                break;
            }
        }
    }
    generation == state.0.turn_generation.load(Ordering::Acquire)
}

async fn ws(State(state): State<AppState>, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    upgrade
        .max_message_size(MAX_WEBSOCKET_MESSAGE_BYTES)
        .max_frame_size(MAX_WEBSOCKET_MESSAGE_BYTES)
        .on_upgrade(move |socket| websocket(socket, state))
}
async fn websocket(mut socket: WebSocket, state: AppState) {
    let mut events = state.0.events.subscribe();
    let mut shutdown = state.0.shutdown.subscribe();
    let listeners = state.0.events.receiver_count();
    tracing::info!(listeners, "browser connected");
    if let Err(error) = send_snapshot(&mut socket, &state).await {
        tracing::warn!(%error, "browser dropped before it received the opening snapshot");
        return;
    }

    let mut pending_header: Option<ClipHeader> = None;
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
            received = socket.recv() => match received {
                Some(Ok(Message::Text(text))) => {
                    if handle_text_frame(&mut socket, &mut pending_header, text.as_ref()).await.is_err() {
                        return;
                    }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    if handle_audio_frame(&mut socket, &state, &mut pending_header, bytes.to_vec()).await.is_err() {
                        return;
                    }
                }
                Some(Ok(Message::Ping(bytes))) => {
                    if socket.send(Message::Pong(bytes)).await.is_err() {
                        return;
                    }
                }
                Some(Ok(Message::Pong(_))) => {}
                // A clean close and a protocol/IO failure are the same event to
                // the caller — the page goes quiet — and opposite events to
                // whoever has to work out why.
                Some(Ok(Message::Close(frame))) => {
                    tracing::info!(code = ?frame.as_ref().map(|frame| frame.code), "browser disconnected");
                    return;
                }
                Some(Err(error)) => {
                    tracing::warn!(%error, "the websocket reader failed");
                    return;
                }
                None => {
                    tracing::info!("browser disconnected without a close frame");
                    return;
                }
            },
            event = events.recv() => match event {
                Ok(event) => {
                    if let Err(error) = send_event(&mut socket, event).await {
                        tracing::warn!(%error, "could not deliver an event to the browser");
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    tracing::warn!(missed, "the browser fell behind the event stream; resending the snapshot");
                    // Drop the retained stale tail and rebuild from durable
                    // state. History/status/diagram are authoritative; activity
                    // and already-missed audio are intentionally ephemeral.
                    events = state.0.events.subscribe();
                    if send_snapshot(&mut socket, &state).await.is_err() {
                        return;
                    }
                }
                Err(_) => return,
            },
        }
    }
}

async fn send_snapshot(socket: &mut WebSocket, state: &AppState) -> Result<(), axum::Error> {
    let initial = [
        // First, so a reconnecting tab stamps clips against the live epoch
        // instead of whatever it held before it dropped.
        Event::Json(
            json!({"type":"epoch", "generation":state.0.turn_generation.load(Ordering::Acquire)}),
        ),
        Event::Json(current_status(state)),
        Event::Json(
            serde_json::to_value(state.0.transcript_log.lock().await.payload()).unwrap_or_default(),
        ),
    ];
    for event in initial {
        send_event(socket, event).await?;
    }
    if let Some(diagram) = state.0.last_diagram.lock().await.clone() {
        send_event(socket, Event::Json(diagram)).await?;
    }
    Ok(())
}

/// A clip header: its id, its mime type, and the turn epoch the browser held
/// when it began recording.
///
/// The epoch is optional because a browser that predates it must keep working;
/// such a clip falls back to being stamped on arrival, which is what every
/// client did before. A value the browser cannot have learned yet simply fails
/// the equality check later and the clip is dropped, so a wrong number can only
/// discard speech, never route it somewhere it does not belong.
type ClipHeader = (String, String, Option<u64>);

fn parse_clip_header(command: &serde_json::Map<String, Value>) -> Option<ClipHeader> {
    let id = command
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.chars().count() <= 128)?;
    let mime = command
        .get("mime")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(100)
        .collect();
    let generation = command.get("generation").and_then(Value::as_u64);
    Some((id.to_owned(), mime, generation))
}

async fn handle_text_frame(
    socket: &mut WebSocket,
    pending_header: &mut Option<ClipHeader>,
    text: &str,
) -> Result<(), axum::Error> {
    let command: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => {
            return send_json(
                socket,
                json!({"type":"error", "message":"Invalid JSON frame."}),
            )
            .await
        }
    };
    let Some(command) = command.as_object() else {
        return send_json(
            socket,
            json!({"type":"error", "message":"Invalid command shape."}),
        )
        .await;
    };

    match command.get("type").and_then(Value::as_str) {
        Some("ping") => {
            send_json(
                socket,
                json!({"type":"pong", "nonce":command.get("nonce"), "time":command.get("time")}),
            )
            .await
        }
        Some("clip") => {
            let Some(header) = parse_clip_header(command) else {
                pending_header.take();
                return send_json(
                    socket,
                    json!({"type":"error", "message":"Invalid clip id."}),
                )
                .await;
            };
            *pending_header = Some(header);
            Ok(())
        }
        _ => {
            send_json(
                socket,
                json!({"type":"error", "message":"Unknown websocket command."}),
            )
            .await
        }
    }
}

async fn handle_audio_frame(
    socket: &mut WebSocket,
    state: &AppState,
    pending_header: &mut Option<ClipHeader>,
    audio: Vec<u8>,
) -> Result<(), axum::Error> {
    let Some((id, mime, generation)) = pending_header.take() else {
        tracing::warn!(bytes = audio.len(), "audio arrived without a clip header");
        return send_json(
            socket,
            json!({"type":"error", "message":"Audio arrived without a clip header."}),
        )
        .await;
    };

    let fresh = {
        let mut accepted = state.0.accepted_clips.lock().await;
        let fresh = accepted.0.insert(id.clone());
        if fresh {
            accepted.1.push_back(id.clone());
            while accepted.1.len() > 512 {
                if let Some(old) = accepted.1.pop_front() {
                    accepted.0.remove(&old);
                }
            }
        } else {
            // A reconnect retransmits the oldest unacknowledged clip first.
            // Keep that id recent just like the Python OrderedDict baseline so
            // a live retry cannot fall out of the bounded idempotency window.
            accepted.1.retain(|accepted_id| accepted_id != &id);
            accepted.1.push_back(id.clone());
        }
        fresh
    };
    if fresh
        && state
            .0
            .clips
            .send(Clip {
                id: id.clone(),
                audio,
                _mime: mime,
                // The browser's stamp is taken when recording starts, which is
                // earlier than anything this side can observe and therefore
                // closes the upload window too. Arrival time is the fallback
                // for clients that do not send one.
                generation: generation
                    .unwrap_or_else(|| state.0.turn_generation.load(Ordering::Acquire)),
            })
            .await
            .is_err()
    {
        // Do not acknowledge ownership the application did not actually take.
        // A reconnect must be allowed to retry this id.
        let mut accepted = state.0.accepted_clips.lock().await;
        accepted.0.remove(&id);
        accepted.1.retain(|accepted_id| accepted_id != &id);
        return send_json(
            socket,
            json!({"type":"error", "id":id, "message":"The call worker is unavailable."}),
        )
        .await;
    }
    send_json(socket, json!({"type":"accepted", "id":id})).await
}

async fn send_json(socket: &mut WebSocket, value: Value) -> Result<(), axum::Error> {
    socket.send(Message::Text(value.to_string().into())).await
}
async fn send_event(socket: &mut WebSocket, event: Event) -> Result<(), axum::Error> {
    match event {
        Event::Json(value) => socket.send(Message::Text(value.to_string().into())).await,
        Event::Audio(audio) => socket.send(Message::Binary(audio.into())).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pbx::OPERATOR;
    use crate::registry::Registry;
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use http_body_util::BodyExt;
    use std::collections::HashMap;
    use std::future::pending;
    use tokio::sync::oneshot;
    use tokio::time::{timeout, Duration};
    use tower::ServiceExt;

    fn state() -> AppState {
        state_with_stt(None)
    }

    fn state_with_stt(stt: Option<String>) -> AppState {
        let board = Switchboard::new(
            Registry::new(vec![]),
            "pi".into(),
            None,
            "".into(),
            None,
            None,
            None,
            "medium".into(),
            ".cache".into(),
            true,
            "".into(),
            "".into(),
            "".into(),
            "".into(),
            HashMap::new(),
        );
        AppState::new(
            board,
            TranscriptLog::new(10),
            Speaker::from_values(
                100,
                &HashMap::from([("ELEVENLABS_API_KEY".into(), "test-key".into())]),
            ),
            SttAdapter::from_command(stt),
        )
    }

    async fn request_json(
        state: &AppState,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        let body = match body {
            Some(value) => {
                request = request.header("content-type", "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
        };
        let response = state
            .clone()
            .router(None)
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = serde_json::from_slice(&bytes).unwrap();
        (status, value)
    }

    #[tokio::test]
    async fn http_contract_exposes_status_health_and_page_controls() {
        let state = state();
        let (code, status) = request_json(&state, Method::GET, "/status", None).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(status["type"], "status");
        assert_eq!(status["route"], OPERATOR);
        assert_eq!(
            status["levels"],
            serde_json::json!(crate::models::THINKING_LEVELS)
        );

        let (code, health) = request_json(&state, Method::GET, "/healthz", None).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(health["status"], "ok");
        assert_eq!(health["stt_adapter"], "sidecar");
        assert_eq!(health["stt_configured"], false);

        let (code, connected) = request_json(
            &state,
            Method::POST,
            "/connect",
            Some(json!({"project":"operator"})),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(connected, json!({"route":"operator", "error":null}));

        let (code, thinking) = request_json(
            &state,
            Method::POST,
            "/thinking",
            Some(json!({"level":"high"})),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(thinking, json!({"thinking":"", "error":null}));
        assert_eq!(
            state.0.switchboard.lock().await.status()["thinking_default"],
            "high"
        );

        let (code, leg) = request_json(
            &state,
            Method::POST,
            "/leg-state",
            Some(json!({"thinking":"high"})),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(leg, json!({"accepted":false}));
    }

    #[tokio::test]
    async fn diagram_contract_is_live_and_replayed() {
        let state = state();
        let mut events = state.0.events.subscribe();
        let payload = json!({
            "source":"flowchart TD; A-->B",
            "title":"Path",
            "notes":"One hop"
        });
        let (code, response) =
            request_json(&state, Method::POST, "/diagram", Some(payload.clone())).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(response, json!({"delivered":true}));
        let Event::Json(event) = events.recv().await.unwrap() else {
            panic!("diagram should be a JSON event")
        };
        assert_eq!(
            event,
            json!({"type":"diagram", "source":"flowchart TD; A-->B", "title":"Path", "notes":"One hop"})
        );
        assert_eq!(*state.0.last_diagram.lock().await, Some(event));
    }

    #[tokio::test]
    async fn speak_rejects_blank_text_without_logging_it() {
        let state = state();
        let (code, body) =
            request_json(&state, Method::POST, "/speak", Some(json!({"text":"   "}))).await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert_eq!(body, json!({"detail":"text must not be empty"}));
        assert!(state.0.transcript_log.lock().await.entries().is_empty());
    }

    #[tokio::test]
    async fn agent_callbacks_do_not_wait_for_the_turn_lock() {
        let state = state();
        let _events = state.0.events.subscribe();
        let (locked_tx, locked_rx) = oneshot::channel();
        let turn_state = state.clone();
        let turn = tokio::spawn(async move {
            let _board = turn_state.0.switchboard.lock().await;
            let _ = locked_tx.send(());
            pending::<()>().await;
        });
        locked_rx.await.unwrap();

        let (code, spoken) = timeout(
            Duration::from_secs(1),
            request_json(
                &state,
                Method::POST,
                "/speak",
                Some(json!({"text":"Still working."})),
            ),
        )
        .await
        .expect("speak must stay live during an agent turn");
        assert_eq!(code, StatusCode::OK);
        assert_eq!(spoken, json!({"delivered":true}));

        let (code, leg) = timeout(
            Duration::from_secs(1),
            request_json(
                &state,
                Method::POST,
                "/leg-state",
                Some(json!({"thinking":"high"})),
            ),
        )
        .await
        .expect("leg-state must stay live during session startup");
        assert_eq!(code, StatusCode::OK);
        assert_eq!(leg, json!({"accepted":false}));

        let (code, status) = timeout(
            Duration::from_secs(1),
            request_json(&state, Method::GET, "/status", None),
        )
        .await
        .expect("status must stay live during an agent turn");
        assert_eq!(code, StatusCode::OK);
        assert_eq!(status["route"], OPERATOR);

        let (code, health) = timeout(
            Duration::from_secs(1),
            request_json(&state, Method::GET, "/healthz", None),
        )
        .await
        .expect("health must stay live during an agent turn");
        assert_eq!(code, StatusCode::OK);
        assert_eq!(health["status"], "ok");

        turn.abort();
        assert!(turn.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn page_rescue_aborts_work_before_waiting_for_the_pbx_lock() {
        let state = state();
        let session = PiSession::start(
            vec!["sh".into(), "-c".into(), "sleep 60".into()],
            OPERATOR,
            None,
            None,
            Duration::from_secs(60),
            None,
        )
        .await
        .unwrap();
        *state.0.active_session.lock().await = Some(session.clone());

        let (locked_tx, locked_rx) = oneshot::channel();
        let turn_state = state.clone();
        let turn = tokio::spawn(async move {
            let _board = turn_state.0.switchboard.lock().await;
            let _ = locked_tx.send(());
            pending::<()>().await;
        });
        let abort = turn.abort_handle();
        state
            .0
            .active_operations
            .lock()
            .await
            .insert(abort.id(), abort);
        locked_rx.await.unwrap();

        let interrupted = timeout(Duration::from_secs(1), interrupt_active_turn(&state))
            .await
            .expect("rescue should not wait for the wedged turn");
        assert_eq!(interrupted.as_deref(), Some(OPERATOR));
        assert!(turn.await.unwrap_err().is_cancelled());
        assert!(!session.alive().await);
        assert!(timeout(Duration::from_secs(1), state.0.switchboard.lock())
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn newer_page_control_supersedes_setup_before_a_session_exists() {
        let state = state();
        let first_state = state.clone();
        let (first, first_id, _) = spawn_active_operation(&state, async move {
            let _board = first_state.0.switchboard.lock().await;
            pending::<()>().await;
        })
        .await;

        let second_state = state.clone();
        let (second, second_id, _generation) = spawn_replacing_operation(&state, async move {
            let _board = second_state.0.switchboard.lock().await;
            7
        })
        .await;

        assert!(first.await.unwrap_err().is_cancelled());
        clear_active_operation(&state, first_id).await;
        assert_eq!(
            timeout(Duration::from_secs(1), second)
                .await
                .unwrap()
                .unwrap(),
            7
        );
        clear_active_operation(&state, second_id).await;
        assert!(state.0.active_operations.lock().await.is_empty());
    }

    #[tokio::test]
    async fn superseded_reply_is_not_logged_or_broadcast() {
        let state = state();
        let mut events = state.0.events.subscribe();
        let generation = state.0.turn_generation.load(Ordering::Acquire);
        state.0.turn_generation.fetch_add(1, Ordering::AcqRel);
        let reply = crate::pbx::Reply {
            text: "stale result".into(),
            route: OPERATOR.into(),
            route_label: "Operator".into(),
            error: None,
            to_speak: Vec::new(),
        };

        assert!(
            !deliver_page_reply_if_current(&state, &reply, current_status(&state), generation)
                .await
        );
        assert!(state.0.transcript_log.lock().await.entries().is_empty());
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn queued_turn_from_before_page_rescue_never_reaches_the_new_leg() {
        let state = state();
        let mut events = state.0.events.subscribe();
        let old_generation = state.0.turn_generation.load(Ordering::Acquire);
        state.0.turn_generation.fetch_add(1, Ordering::AcqRel);
        state.0.queued_turns.store(1, Ordering::Release);
        let worker_state = state.clone();
        let worker = tokio::spawn(async move { process_turns(worker_state).await });
        state
            .0
            .turns
            .send(("old-clip".into(), "stale words".into(), old_generation))
            .await
            .unwrap();
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }

        assert!(!state.0.turn_in_flight.load(Ordering::Acquire));
        assert!(state.0.active_operations.lock().await.is_empty());
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
    }

    #[test]
    fn clip_headers_carry_an_optional_capture_epoch() {
        let header = |value: Value| parse_clip_header(value.as_object().unwrap());

        assert_eq!(
            header(json!({"type":"clip", "id":"a", "mime":"audio/webm", "generation":3})),
            Some(("a".into(), "audio/webm".into(), Some(3)))
        );
        // A browser that predates the epoch still works; the clip is stamped on
        // arrival instead, which is what every client used to do.
        assert_eq!(
            header(json!({"type":"clip", "id":"a", "mime":"audio/webm"})),
            Some(("a".into(), "audio/webm".into(), None))
        );
        // Anything that is not a plain count is ignored rather than trusted.
        assert_eq!(
            header(json!({"type":"clip", "id":"a", "generation":-1})),
            Some(("a".into(), String::new(), None))
        );
        assert_eq!(
            header(json!({"type":"clip", "id":"a", "generation":"7"})),
            Some(("a".into(), String::new(), None))
        );

        assert_eq!(header(json!({"type":"clip", "id":""})), None);
        assert_eq!(
            header(json!({"type":"clip", "id":"x".repeat(129)})),
            None,
            "an oversized id is still refused"
        );
        let long_mime = header(json!({"type":"clip", "id":"a", "mime":"m".repeat(400)}));
        assert_eq!(long_mime.unwrap().1.chars().count(), 100);
    }

    #[tokio::test]
    async fn clip_accepted_before_a_page_rescue_is_dropped_after_transcription() {
        let state = state_with_stt(Some("printf 'stale words'".into()));
        let mut events = state.0.events.subscribe();
        state
            .0
            .clips
            .send(Clip {
                id: "old-clip".into(),
                audio: vec![0],
                _mime: "audio/webm".into(),
                generation: state.0.turn_generation.load(Ordering::Acquire),
            })
            .await
            .unwrap();
        // The transfer lands while the clip is still inside the sidecar.
        state.0.turn_generation.fetch_add(1, Ordering::AcqRel);
        let worker_state = state.clone();
        let worker = tokio::spawn(async move { process_clips(worker_state).await });

        // The transcript still lands. That is what keeps the assertions below
        // from passing vacuously: it proves the worker really ran this clip.
        // Only a safety net so a regression fails instead of hanging. The happy
        // path returns as soon as the sidecar does, but process spawning can be
        // slow on a loaded CI box, so the bound is generous.
        let transcript = timeout(Duration::from_secs(60), async {
            loop {
                if let Ok(Event::Json(value)) = events.recv().await {
                    if value["type"] == "transcript" {
                        return value;
                    }
                }
            }
        })
        .await
        .expect("the clip worker transcribed the clip");
        assert_eq!(transcript["text"], "stale words");
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }

        assert_eq!(state.0.queued_turns.load(Ordering::Acquire), 0);
        let mut turns = state.0.turn_rx.lock().await.take().unwrap();
        assert!(matches!(
            turns.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn shutdown_notifies_upgraded_connections_before_reaping_the_pbx() {
        let state = state();
        let mut shutdown_notice = state.0.shutdown.subscribe();
        timeout(Duration::from_secs(1), shutdown(&state))
            .await
            .expect("shutdown should finish without a live leg");
        timeout(Duration::from_secs(1), shutdown_notice.changed())
            .await
            .expect("websocket shutdown notice should be immediate")
            .unwrap();
        assert!(*shutdown_notice.borrow());
    }
}

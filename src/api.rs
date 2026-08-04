//! HTTP, WebSocket and application workers.
use crate::audio::{Speaker, SttAdapter};
use crate::history::{TranscriptLog, AGENT, CALLER};
use crate::pbx::Switchboard;
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
    collections::{HashSet, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tokio::sync::{broadcast, mpsc, Mutex};
use tower_http::services::ServeDir;

#[derive(Clone)]
pub struct AppState(pub Arc<AppInner>);
pub struct AppInner {
    pub switchboard: Mutex<Switchboard>,
    pub transcript_log: Mutex<TranscriptLog>,
    pub speaker: Speaker,
    pub stt: SttAdapter,
    pub events: broadcast::Sender<Event>,
    clips: mpsc::Sender<Clip>,
    clip_rx: Mutex<Option<mpsc::Receiver<Clip>>>,
    pub turns: mpsc::Sender<(String, String)>,
    turn_rx: Mutex<Option<mpsc::Receiver<(String, String)>>>,
    pub accepted_clips: Mutex<(HashSet<String>, VecDeque<String>)>,
    pub last_diagram: Mutex<Option<Value>>,
    pub active_session: Arc<Mutex<Option<PiSession>>>,
    pub turn_generation: AtomicU64,
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
}

impl AppState {
    pub fn new(
        switchboard: Switchboard,
        transcript_log: TranscriptLog,
        speaker: Speaker,
        stt: SttAdapter,
    ) -> Self {
        let (events, _) = broadcast::channel(256);
        let (clips, clip_rx) = mpsc::channel(64);
        let (turns, turn_rx) = mpsc::channel(64);
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
        let active_session = switchboard.session_control();
        let mut switchboard = switchboard;
        switchboard.set_activity_callback(Some(activity_callback));
        Self(Arc::new(AppInner {
            switchboard: Mutex::new(switchboard),
            transcript_log: Mutex::new(transcript_log),
            speaker,
            stt,
            events,
            clips,
            clip_rx: Mutex::new(Some(clip_rx)),
            turns,
            turn_rx: Mutex::new(Some(turn_rx)),
            accepted_clips: Mutex::new((HashSet::new(), VecDeque::new())),
            last_diagram: Mutex::new(None),
            active_session,
            turn_generation: AtomicU64::new(0),
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
    let clip_state = state.clone();
    tokio::spawn(async move {
        process_clips(clip_state).await;
    });
    tokio::spawn(async move {
        process_turns(state).await;
    });
}
pub fn spawn_idle_worker(state: AppState, idle_timeout: f64, poll_seconds: f64) {
    if idle_timeout <= 0.0 {
        return;
    }
    tokio::spawn(async move {
        let poll = tokio::time::Duration::from_secs_f64(poll_seconds.max(1.0));
        loop {
            tokio::time::sleep(poll).await;
            let mut board = state.0.switchboard.lock().await;
            if let Some(left) = board.return_if_idle(idle_timeout).await {
                let route = board.route().to_owned();
                drop(board);
                if let Some(entry) = state.0.transcript_log.lock().await.add(AGENT, &format!("Nothing was said for {idle_timeout:.0} seconds, so the line to {left} was dropped. You're back with the operator."), route) {
                    emit_json(&state, json!({"type":"spoken", "entry":entry}));
                }
                emit_json(&state, state.0.switchboard.lock().await.status());
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

async fn process_clips(state: AppState) {
    let mut receiver = state
        .0
        .clip_rx
        .lock()
        .await
        .take()
        .expect("clip worker started once");
    while let Some(clip) = receiver.recv().await {
        let transcript = match state.0.stt.transcribe(&clip.audio).await {
            Ok(text) => text,
            Err(error) => {
                emit_json(
                    &state,
                    json!({"type":"error", "id":clip.id, "message":format!("Transcription failed: {error}")}),
                );
                continue;
            }
        };
        if transcript.trim().is_empty() {
            emit_json(
                &state,
                json!({"type":"error", "id":clip.id, "message":"I didn't catch that — say it again."}),
            );
            continue;
        }
        let route = state.0.switchboard.lock().await.route().to_owned();
        if let Some(entry) = state
            .0
            .transcript_log
            .lock()
            .await
            .add(CALLER, &transcript, route)
        {
            let object = serde_json::to_value(&entry).unwrap_or_default();
            emit_json(
                &state,
                json!({"type":"transcript", "id":clip.id, "entry":object, "text":transcript}),
            );
        } else {
            emit_json(
                &state,
                json!({"type":"transcript", "id":clip.id, "text":transcript}),
            );
        }
        let steered = state
            .0
            .switchboard
            .lock()
            .await
            .steer_if_busy(&transcript)
            .await;
        if steered {
            emit_json(
                &state,
                json!({"type":"queued", "id":clip.id, "waiting":0, "steered":true}),
            );
        } else if state
            .0
            .turns
            .send((clip.id.clone(), transcript))
            .await
            .is_ok()
        {
            emit_json(
                &state,
                json!({"type":"queued", "id":clip.id, "waiting":0, "steered":false}),
            );
        }
    }
}
async fn process_turns(state: AppState) {
    let mut receiver = state
        .0
        .turn_rx
        .lock()
        .await
        .take()
        .expect("turn worker started once");
    while let Some((_id, transcript)) = receiver.recv().await {
        let generation = state.0.turn_generation.load(Ordering::Acquire);
        let status = state.0.switchboard.lock().await.status();
        emit_json(&state, json!({"type":"thinking", "route":status["route"]}));
        let reply = state.0.switchboard.lock().await.handle(&transcript).await;
        if generation != state.0.turn_generation.load(Ordering::Acquire) {
            continue;
        }
        if !reply.text.is_empty() {
            let route = reply.route.clone();
            state
                .0
                .transcript_log
                .lock()
                .await
                .add(AGENT, &reply.text, route);
        }
        emit_json(
            &state,
            json!({"type":"reply", "text":reply.text, "route":reply.route, "error":reply.error}),
        );
        emit_json(&state, state.0.switchboard.lock().await.status());
        for text in reply.to_speak {
            let spoken = state.0.speaker.clip_for_speech(&text);
            if spoken.is_empty() {
                continue;
            }
            let _ = match state.0.speaker.synthesize(&spoken).await {
                Ok(audio) => emit(&state, Event::Audio(audio)),
                Err(error) => {
                    emit_json(&state, json!({"type":"error", "message":error.to_string()}))
                }
            };
        }
    }
}

async fn healthz(State(state): State<AppState>) -> impl IntoResponse {
    let board = state.0.switchboard.lock().await;
    let status = board.status();
    Json(
        json!({"status":"ok", "whisper_model":"sidecar", "stt_configured":state.0.stt.command.is_some(), "stt_adapter":"sidecar", "elevenlabs_configured":state.0.speaker.configured(), "route":status["route"], "model":status["model"], "thinking":status["thinking"], "model_swaps":status["model_swaps"], "projects":status["projects"]}),
    )
}
async fn status(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.0.switchboard.lock().await.status())
}
async fn hangup(State(state): State<AppState>) -> impl IntoResponse {
    state.0.turn_generation.fetch_add(1, Ordering::AcqRel);
    let active = state.0.active_session.lock().await.clone();
    if let Some(session) = active {
        session.close().await;
    }
    let mut board = state.0.switchboard.lock().await;
    let left = board.force_hangup().await;
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
        emit_json(&state, status);
    }
    Json(
        json!({"hungup":left.is_some(), "left":left, "reason":if left.is_none() { Some("already on the operator") } else { None }}),
    )
}
#[derive(Deserialize)]
struct Connect {
    project: String,
    #[serde(default)]
    intent: String,
}
async fn connect(State(state): State<AppState>, Json(req): Json<Connect>) -> impl IntoResponse {
    let reply = state
        .0
        .switchboard
        .lock()
        .await
        .dial(&req.project, &req.intent)
        .await;
    deliver_reply(&state, &reply).await;
    Json(json!({"route":reply.route, "error":reply.error.clone()}))
}
#[derive(Deserialize)]
struct Thinking {
    level: String,
}
async fn thinking(State(state): State<AppState>, Json(req): Json<Thinking>) -> impl IntoResponse {
    let reply = state
        .0
        .switchboard
        .lock()
        .await
        .set_thinking(&req.level)
        .await;
    deliver_reply(&state, &reply).await;
    Json(
        json!({"thinking":state.0.switchboard.lock().await.status()["thinking"], "error":reply.error.clone()}),
    )
}
#[derive(Deserialize)]
struct LegState {
    #[serde(default)]
    thinking: String,
}
async fn leg_state(State(state): State<AppState>, Json(req): Json<LegState>) -> impl IntoResponse {
    let accepted = state
        .0
        .switchboard
        .lock()
        .await
        .report_leg_state(&req.thinking);
    if accepted {
        emit_json(&state, state.0.switchboard.lock().await.status());
    }
    Json(json!({"accepted":accepted}))
}
#[derive(Deserialize)]
struct Speak {
    text: String,
}
async fn speak(State(state): State<AppState>, Json(req): Json<Speak>) -> Response {
    let audio = match state.0.speaker.synthesize(&req.text).await {
        Ok(a) => a,
        Err(e) => {
            return (
                axum::http::StatusCode::BAD_GATEWAY,
                Json(json!({"detail":e.to_string()})),
            )
                .into_response()
        }
    };
    let route = state.0.switchboard.lock().await.route().to_owned();
    if let Some(entry) = state
        .0
        .transcript_log
        .lock()
        .await
        .add(AGENT, &req.text, route)
    {
        emit_json(&state, json!({"type":"spoken", "entry":entry}));
    }
    if state.0.events.receiver_count() == 0 {
        return Json(json!({"delivered":false, "reason":"no browser connected"})).into_response();
    }
    let delivered = emit(&state, Event::Audio(audio));
    Json(json!({"delivered":delivered, "reason":(!delivered).then_some("no browser connected")}))
        .into_response()
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
    Json(json!({"delivered":delivered, "reason":(!delivered).then_some("no browser connected")}))
}
async fn deliver_reply(state: &AppState, reply: &crate::pbx::Reply) {
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
    emit_json(state, state.0.switchboard.lock().await.status());
    for text in &reply.to_speak {
        let spoken = state.0.speaker.clip_for_speech(text);
        if spoken.is_empty() {
            continue;
        }
        match state.0.speaker.synthesize(&spoken).await {
            Ok(audio) => {
                emit(state, Event::Audio(audio));
            }
            Err(error) => {
                emit_json(state, json!({"type":"error", "message":error.to_string()}));
                break;
            }
        }
    }
}

async fn ws(State(state): State<AppState>, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| websocket(socket, state))
}
async fn websocket(mut socket: WebSocket, state: AppState) {
    let mut events = state.0.events.subscribe();
    let initial = [
        Event::Json(state.0.switchboard.lock().await.status()),
        Event::Json(
            serde_json::to_value(state.0.transcript_log.lock().await.payload()).unwrap_or_default(),
        ),
    ];
    for event in initial {
        if send_event(&mut socket, event).await.is_err() {
            return;
        }
    }
    if let Some(diagram) = state.0.last_diagram.lock().await.clone() {
        if send_event(&mut socket, Event::Json(diagram)).await.is_err() {
            return;
        }
    }

    let mut pending_header: Option<(String, String)> = None;
    loop {
        tokio::select! {
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
                _ => return,
            },
            event = events.recv() => match event {
                Ok(event) => {
                    if send_event(&mut socket, event).await.is_err() {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            },
        }
    }
}

async fn handle_text_frame(
    socket: &mut WebSocket,
    pending_header: &mut Option<(String, String)>,
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
            let Some(id) = command
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 128)
            else {
                return send_json(
                    socket,
                    json!({"type":"error", "message":"Invalid clip id."}),
                )
                .await;
            };
            let mime = command
                .get("mime")
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(100)
                .collect();
            *pending_header = Some((id.to_owned(), mime));
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
    pending_header: &mut Option<(String, String)>,
    audio: Vec<u8>,
) -> Result<(), axum::Error> {
    let Some((id, mime)) = pending_header.take() else {
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
        }
        fresh
    };
    if fresh {
        let _ = state
            .0
            .clips
            .send(Clip {
                id: id.clone(),
                audio,
                _mime: mime,
            })
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

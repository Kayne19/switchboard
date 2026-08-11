//! HTTP, WebSocket and application workers.
use crate::audio::{Speaker, StreamResult, SttAdapter, SttStreamAdapter};
use crate::history::{TranscriptLog, AGENT, CALLER};
use crate::lifecycle::Coordinator;
use crate::pbx::{ActivityClock, LiveLegState, RouteCallback, Switchboard};
use crate::pi_client::{Activity, ActivityCallback, PiSession};
use axum::extract::ws::{Message, WebSocket};
use axum::{
    extract::{State, WebSocketUpgrade},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
use tokio::sync::{broadcast, mpsc, oneshot, watch, Mutex};
use tokio::task::{AbortHandle, Id as TaskId, JoinHandle};
use tower_http::services::ServeDir;

const MAX_WEBSOCKET_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState(pub Arc<AppInner>);
pub struct AppInner {
    pub switchboard: Mutex<Switchboard>,
    delivery: DeliveryState,
    pub transcript_log: Mutex<TranscriptLog>,
    pub speaker: Speaker,
    pub stt: SttAdapter,
    pub stt_stream: SttStreamAdapter,
    pub events: broadcast::Sender<Event>,
    pub coordinator: Coordinator,
    speech: mpsc::Sender<SpeechRequest>,
    speech_rx: Mutex<Option<mpsc::Receiver<SpeechRequest>>>,
    clips: mpsc::Sender<Clip>,
    clip_rx: Mutex<Option<mpsc::Receiver<Clip>>>,
    pub turns: mpsc::Sender<(String, String, u64)>,
    turn_rx: Mutex<Option<mpsc::Receiver<(String, String, u64)>>>,
    pub accepted_clips: Mutex<(HashSet<String>, VecDeque<String>)>,
    stream_clips: Mutex<HashMap<String, StreamClipState>>,
    pub last_diagram: Arc<Mutex<Option<Value>>>,
    pub active_session: Arc<Mutex<Option<PiSession>>>,
    activity_clock: ActivityClock,
    live_leg: LiveLegState,
    operation_transition: Mutex<()>,
    active_operations: Mutex<HashMap<TaskId, AbortHandle>>,
    pub queued_turns: AtomicU64,
    pub turn_in_flight: AtomicBool,
    shutdown: watch::Sender<bool>,
    audio: Mutex<AudioQueue>,
    speech_deadline: std::time::Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StreamClipState {
    Open {
        generation: u64,
        next_sequence: u64,
        connection: u64,
    },
    Ended {
        generation: u64,
        connection: u64,
    },
    Cancelled,
    Abandoned,
    Finalized,
}

#[derive(Clone, Debug)]
pub enum Event {
    Json(Value),
    AudioStart {
        generation: u64,
        sequence: u64,
        mime: String,
        format: String,
    },
    AudioChunk {
        audio: Vec<u8>,
        generation: u64,
        sequence: u64,
    },
    AudioDone {
        generation: u64,
        sequence: u64,
    },
}
struct SpeechRequest {
    text: String,
    generation: u64,
    sequence: u64,
    deadline: std::time::Instant,
    result: oneshot::Sender<Result<(), String>>,
}

const DELIVERY_QUEUE: usize = 256;

#[derive(Clone)]
struct DeliveryState {
    next_epoch: Arc<AtomicU64>,
    next_sequence: Arc<AtomicU64>,
    connections: Arc<std::sync::Mutex<HashMap<u64, mpsc::Sender<DeliveryFrame>>>>,
}

enum DeliveryFrame {
    Event { sequence: u64, event: Event },
    Message(Message),
}

struct DeliveryConnection {
    epoch: u64,
    receiver: mpsc::Receiver<DeliveryFrame>,
}

impl DeliveryState {
    fn new() -> Self {
        Self {
            next_epoch: Arc::new(AtomicU64::new(1)),
            next_sequence: Arc::new(AtomicU64::new(0)),
            connections: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    fn register(&self) -> DeliveryConnection {
        let epoch = self.next_epoch.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel(DELIVERY_QUEUE);
        self.connections.lock().unwrap().insert(epoch, sender);
        DeliveryConnection { epoch, receiver }
    }

    fn retire(&self, epoch: u64) {
        self.connections.lock().unwrap().remove(&epoch);
    }

    fn publish(&self, event: Event) -> bool {
        let sequence = self.next_sequence.fetch_add(1, Ordering::Relaxed);
        let mut delivered = false;
        let mut dead = Vec::new();
        let connections = self.connections.lock().unwrap();
        for (&epoch, sender) in connections.iter() {
            match sender.try_send(DeliveryFrame::Event {
                sequence,
                event: event.clone(),
            }) {
                Ok(()) => delivered = true,
                Err(_) => dead.push(epoch),
            }
        }
        drop(connections);
        if !dead.is_empty() {
            let mut connections = self.connections.lock().unwrap();
            for epoch in dead {
                connections.remove(&epoch);
            }
        }
        delivered
    }

    fn send(&self, epoch: u64, message: Message) -> bool {
        self.connections
            .lock()
            .unwrap()
            .get(&epoch)
            .is_some_and(|sender| sender.try_send(DeliveryFrame::Message(message)).is_ok())
    }

    fn connected(&self) -> bool {
        !self.connections.lock().unwrap().is_empty()
    }
}
struct AudioSlot {
    generation: u64,
    events: Vec<Event>,
    started: bool,
    done: bool,
}
struct AudioQueue {
    next: u64,
    emit: u64,
    slots: BTreeMap<u64, AudioSlot>,
}
impl AudioQueue {
    fn new() -> Self {
        Self {
            next: 0,
            emit: 0,
            slots: BTreeMap::new(),
        }
    }
    fn reserve(&mut self, generation: u64) -> u64 {
        let sequence = self.next;
        self.next += 1;
        self.slots.insert(
            sequence,
            AudioSlot {
                generation,
                events: Vec::new(),
                started: false,
                done: false,
            },
        );
        sequence
    }
    fn start(&mut self, sequence: u64, generation: u64) -> Vec<Event> {
        let Some(slot) = self.slots.get_mut(&sequence) else {
            return Vec::new();
        };
        if slot.generation == generation && !slot.started {
            slot.started = true;
            slot.events.push(Event::AudioStart {
                generation,
                sequence,
                mime: "audio/mpeg".into(),
                format: "mp3".into(),
            });
        }
        self.drain_ready()
    }
    fn append(&mut self, sequence: u64, generation: u64, audio: Vec<u8>) -> Vec<Event> {
        let Some(slot) = self.slots.get_mut(&sequence) else {
            return Vec::new();
        };
        if slot.generation == generation && !audio.is_empty() {
            slot.events.push(Event::AudioChunk {
                audio,
                generation,
                sequence,
            });
        }
        self.drain_ready()
    }
    fn cancel(&mut self, sequence: u64, generation: u64) -> Vec<Event> {
        self.finish(sequence, generation)
    }
    fn barrier(&mut self, sequence: u64, generation: u64, value: Value) -> Vec<Event> {
        let Some(slot) = self.slots.get_mut(&sequence) else {
            return Vec::new();
        };
        if slot.generation == generation && !slot.done {
            slot.events.push(Event::Json(value));
            slot.done = true;
        }
        self.drain_ready()
    }
    fn finish(&mut self, sequence: u64, generation: u64) -> Vec<Event> {
        let Some(slot) = self.slots.get_mut(&sequence) else {
            return Vec::new();
        };
        if slot.generation == generation {
            if !slot.started {
                slot.started = true;
                slot.events.push(Event::AudioStart {
                    generation,
                    sequence,
                    mime: "audio/mpeg".into(),
                    format: "mp3".into(),
                });
            }
            if !slot.done {
                slot.events.push(Event::AudioDone {
                    generation,
                    sequence,
                });
            }
        }
        slot.done = true;
        self.drain_ready()
    }
    fn drain_ready(&mut self) -> Vec<Event> {
        let mut ready = Vec::new();
        while self.slots.contains_key(&self.emit) {
            let done = {
                let slot = self.slots.get_mut(&self.emit).expect("audio slot exists");
                ready.append(&mut slot.events);
                slot.done
            };
            if !done {
                break;
            }
            self.slots.remove(&self.emit);
            self.emit += 1;
        }
        ready
    }
    fn clear(&mut self) {
        self.slots.clear();
        self.emit = self.next;
    }
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
        Self::new_with_stream(
            switchboard,
            transcript_log,
            speaker,
            stt,
            SttStreamAdapter::from_env(),
        )
    }

    pub fn new_with_stream(
        switchboard: Switchboard,
        transcript_log: TranscriptLog,
        speaker: Speaker,
        stt: SttAdapter,
        stt_stream: SttStreamAdapter,
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
        let last_diagram = Arc::new(Mutex::new(None));
        let delivery = DeliveryState::new();
        let speech_deadline = speaker.speech_deadline;
        let coordinator = Coordinator::new(switchboard.status());
        let activity_events = events.clone();
        let activity_delivery = delivery.clone();
        let activity_coordinator = coordinator.clone();
        let activity_callback: ActivityCallback = Arc::new(move |activity: Activity| {
            let events = activity_events.clone();
            let delivery = activity_delivery.clone();
            let coordinator = activity_coordinator.clone();
            Box::pin(async move {
                if coordinator.is_candidate() {
                    return;
                }
                let event = Event::Json(json!({
                    "type": "activity",
                    "state": activity.state,
                    "tool": activity.tool,
                    "detail": activity.detail,
                    "label": activity.label,
                }));
                let _ = events.send(event.clone());
                delivery.publish(event);
            })
        });
        let route_events = events.clone();
        let route_delivery = delivery.clone();
        let route_diagram = last_diagram.clone();
        let route_coordinator = coordinator.clone();
        let route_callback: RouteCallback = Arc::new(move |status| {
            let events = route_events.clone();
            let delivery = route_delivery.clone();
            let diagram = route_diagram.clone();
            let coordinator = route_coordinator.clone();
            Box::pin(async move {
                coordinator.publish_status(status.clone());
                *diagram.lock().await = None;
                let event = Event::Json(status);
                let _ = events.send(event.clone());
                delivery.publish(event);
            })
        });
        let active_session = switchboard.session_control();
        let activity_clock = switchboard.activity_clock();
        let live_leg = switchboard.live_leg_state();
        let mut switchboard = switchboard;
        switchboard.set_coordinator(coordinator.clone());
        switchboard.set_activity_callback(Some(activity_callback));
        switchboard.set_route_callback(Some(route_callback));
        Self(Arc::new(AppInner {
            switchboard: Mutex::new(switchboard),
            delivery,
            transcript_log: Mutex::new(transcript_log),
            speaker,
            stt,
            stt_stream,
            events,
            coordinator,
            speech,
            speech_rx: Mutex::new(Some(speech_rx)),
            clips,
            clip_rx: Mutex::new(Some(clip_rx)),
            turns,
            turn_rx: Mutex::new(Some(turn_rx)),
            accepted_clips: Mutex::new((HashSet::new(), VecDeque::new())),
            stream_clips: Mutex::new(HashMap::new()),
            last_diagram,
            active_session,
            activity_clock,
            live_leg,
            operation_transition: Mutex::new(()),
            active_operations: Mutex::new(HashMap::new()),
            queued_turns: AtomicU64::new(0),
            turn_in_flight: AtomicBool::new(false),
            shutdown,
            audio: Mutex::new(AudioQueue::new()),
            speech_deadline,
        }))
    }
    pub fn router(self, static_dir: Option<ServeDir>) -> Router {
        let router = Router::new()
            .route("/healthz", get(healthz))
            .route("/status", get(status))
            .route("/hangup", post(hangup))
            .route("/connect", post(connect))
            .route("/thinking", post(thinking))
            .route("/model", post(model))
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
    let stream_state = state.clone();
    tokio::spawn(async move {
        process_stream_results(stream_state).await;
    });
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
    // Linearize shutdown before cancellation so late callbacks and deliveries
    // fail closed while the process resources are being reaped.
    if !state.0.coordinator.begin_shutdown() {
        return;
    }
    // Close upgraded WebSockets as well as the PBX children. Axum's graceful
    // shutdown waits for upgraded connections, so merely stopping the listener
    // can otherwise leave systemd waiting on a browser tab indefinitely.
    state.0.shutdown.send_replace(true);
    interrupt_active_turn(state).await;
    state.0.switchboard.lock().await.shutdown().await;
    state.0.coordinator.finish_shutdown();
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
            if state
                .0
                .coordinator
                .return_if_idle(std::time::Duration::from_secs_f64(idle_timeout))
                .is_some()
            {
                let mut board = state.0.switchboard.lock().await;
                let left = board.force_hangup().await;
                let route = board.route().to_owned();
                drop(board);
                let Some(left) = left else { continue };
                let minutes = (idle_timeout / 60.0).floor() as u64;
                emit_json(
                    &state,
                    json!({"type":"epoch", "generation":state.0.coordinator.generation()}),
                );
                if let Some(entry) = state.0.transcript_log.lock().await.add(AGENT, &format!("Nothing was said for {minutes} minutes, so the line to {left} was dropped. You're back with the operator."), route) {
                    emit_json(&state, json!({"type":"spoken", "entry":entry}));
                }
                publish_status(&state, current_status(&state));
            }
        }
    });
}
fn emit(state: &AppState, event: Event) -> bool {
    let browser_delivered = state.0.delivery.publish(event.clone());
    let _ = state.0.events.send(event);
    browser_delivered
}
fn emit_json(state: &AppState, value: Value) -> bool {
    emit(state, Event::Json(value))
}
fn current_status(state: &AppState) -> Value {
    state.0.coordinator.status_json()
}
fn publish_status(state: &AppState, status: Value) {
    state.0.coordinator.publish_status(status.clone());
    emit_json(state, status);
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
async fn spawn_registered_operation<F, T>(
    state: &AppState,
    generation: u64,
    future: F,
) -> Option<(JoinHandle<T>, TaskId)>
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    // The generation check and registry insertion share the registry lock. A
    // rescue that bumps the generation before this point rejects spawning;
    // one that races after the check waits for the inserted abort handle.
    let mut active = state.0.active_operations.lock().await;
    if state.0.coordinator.generation() != generation {
        return None;
    }
    let task = tokio::spawn(future);
    let abort = task.abort_handle();
    let id = abort.id();
    active.insert(id, abort);
    Some((task, id))
}
async fn clear_active_operation(state: &AppState, id: TaskId) {
    state.0.active_operations.lock().await.remove(&id);
}

async fn reserve_audio(state: &AppState, generation: u64) -> Option<u64> {
    let mut audio = state.0.audio.lock().await;
    if generation != state.0.coordinator.generation() || audio.slots.len() >= 64 {
        return None;
    }
    Some(audio.reserve(generation))
}
async fn publish_audio_events(state: &AppState, events: Vec<Event>) -> bool {
    let mut delivered = false;
    for event in events {
        delivered |= emit(state, event);
    }
    delivered
}
async fn start_audio(state: &AppState, sequence: u64, generation: u64) -> bool {
    let events = {
        let mut audio = state.0.audio.lock().await;
        audio.start(sequence, generation)
    };
    publish_audio_events(state, events).await
}
async fn append_audio(state: &AppState, sequence: u64, generation: u64, bytes: Vec<u8>) -> bool {
    let events = {
        let mut audio = state.0.audio.lock().await;
        audio.append(sequence, generation, bytes)
    };
    publish_audio_events(state, events).await
}
async fn finish_audio(state: &AppState, sequence: u64, generation: u64, bytes: Vec<u8>) -> bool {
    let (events, current) = {
        let mut audio = state.0.audio.lock().await;
        let current = generation == state.0.coordinator.generation();
        let events = if current {
            let mut events = audio.append(sequence, generation, bytes);
            events.extend(audio.finish(sequence, generation));
            events
        } else {
            audio.cancel(sequence, generation)
        };
        (events, current)
    };
    publish_audio_events(state, events).await && current
}

async fn synthesize_audio_stream(
    state: &AppState,
    text: &str,
    sequence: u64,
    generation: u64,
    deadline: std::time::Instant,
) -> Result<(usize, bool), crate::audio::AudioError> {
    let mut delivered = start_audio(state, sequence, generation).await;
    let mut bytes = 0usize;
    let mut stream = state.0.speaker.stream_until(text, deadline).await?;
    while let Some(chunk) = stream.next().await {
        if generation != state.0.coordinator.generation() {
            return Err(crate::audio::AudioError::Tts(
                "speech generation was superseded".into(),
            ));
        }
        let chunk = chunk?;
        bytes = bytes.saturating_add(chunk.len());
        for part in chunk.chunks(32 * 1024) {
            delivered |= append_audio(state, sequence, generation, part.to_vec()).await;
        }
    }
    delivered |= finish_audio(state, sequence, generation, Vec::new()).await;
    Ok((bytes, delivered))
}

async fn process_speech(state: AppState) {
    let mut receiver = state
        .0
        .speech_rx
        .lock()
        .await
        .take()
        .expect("speech worker started once");
    while let Some(request) = receiver.recv().await {
        let SpeechRequest {
            text,
            generation,
            sequence,
            deadline,
            result,
        } = request;
        state.0.coordinator.touch_activity();
        let started = std::time::Instant::now();
        let operation_state = state.clone();
        let operation_text = text.clone();
        let synthesized = match spawn_registered_operation(&state, generation, async move {
            synthesize_audio_stream(
                &operation_state,
                &operation_text,
                sequence,
                generation,
                deadline,
            )
            .await
        })
        .await
        {
            Some((task, id)) => {
                let result = match task.await {
                    Ok(result) => result,
                    Err(error) if error.is_cancelled() => {
                        Err(crate::audio::AudioError::Tts("speech was cancelled".into()))
                    }
                    Err(error) => Err(crate::audio::AudioError::Tts(format!(
                        "speech worker failed: {error}"
                    ))),
                };
                clear_active_operation(&state, id).await;
                result
            }
            None => Err(crate::audio::AudioError::Tts(
                "speech generation was superseded".into(),
            )),
        };
        match synthesized {
            Ok((bytes, delivered)) => {
                tracing::info!(chars = text.chars().count(), bytes, elapsed = ?started.elapsed(), "synthesized a mid-turn line");
                if delivered {
                    let route = state.0.live_leg.route();
                    if let Some(entry) =
                        state.0.transcript_log.lock().await.add(AGENT, &text, route)
                    {
                        emit_json(&state, json!({"type":"spoken", "entry":entry}));
                    }
                    let _ = result.send(Ok(()));
                } else {
                    let _ = result.send(Err(
                        "no browser connected or the writer rejected audio".into()
                    ));
                }
            }
            Err(error) => {
                finish_audio(&state, sequence, generation, Vec::new()).await;
                let _ = result.send(Err(error.to_string()));
                tracing::error!(%error, chars = text.chars().count(), "synthesis failed for an agent-spoken line");
                emit_json(&state, json!({"type":"error", "message":error.to_string()}));
            }
        }
    }
    tracing::warn!("the speech worker stopped; agent-spoken lines will not be voiced");
}

async fn process_stream_results(state: AppState) {
    let Some(mut results) = state.0.stt_stream.take_results().await else {
        return;
    };
    while let Some(result) = results.recv().await {
        match result {
            StreamResult::Partial(partial) => {
                let valid = {
                    let clips = state.0.stream_clips.lock().await;
                    matches!(clips.get(&partial.clip_id), Some(StreamClipState::Open { generation, next_sequence, .. }) if *generation == partial.generation && partial.sequence <= *next_sequence)
                };
                if valid && partial.generation == state.0.coordinator.generation() {
                    emit_json(
                        &state,
                        json!({"type":"partial", "id":partial.clip_id, "generation":partial.generation, "sequence":partial.sequence, "text":partial.text}),
                    );
                }
            }
            StreamResult::Final(final_result) => {
                let claim = {
                    let mut clips = state.0.stream_clips.lock().await;
                    match clips.get(&final_result.clip_id).copied() {
                        Some(StreamClipState::Ended { generation, .. })
                            if generation == final_result.generation =>
                        {
                            clips.insert(final_result.clip_id.clone(), StreamClipState::Finalized);
                            true
                        }
                        _ => false,
                    }
                };
                if claim {
                    route_final_transcript(
                        &state,
                        &final_result.clip_id,
                        final_result.generation,
                        final_result.text,
                    )
                    .await;
                }
            }
            StreamResult::WorkerError(error) => {
                tracing::error!(%error, "streaming STT worker failed");
                let abandoned = {
                    let mut clips = state.0.stream_clips.lock().await;
                    let mut abandoned = Vec::new();
                    for (id, clip) in clips.iter_mut() {
                        match *clip {
                            StreamClipState::Open { connection, .. }
                            | StreamClipState::Ended { connection, .. } => {
                                *clip = StreamClipState::Abandoned;
                                abandoned.push((id.clone(), connection));
                            }
                            _ => {}
                        }
                    }
                    abandoned
                };
                for (id, connection) in abandoned {
                    let _ = send_json(
                        &state,
                        connection,
                        json!({"type":"abandoned", "id":id, "reason":"stream worker unavailable"}),
                    )
                    .await;
                }
            }
        }
    }
}

async fn route_final_transcript(state: &AppState, id: &str, generation: u64, transcript: String) {
    if transcript.trim().is_empty() {
        emit_json(
            state,
            json!({"type":"error", "id":id, "message":"I didn't catch that — say it again."}),
        );
        return;
    }
    let _transition = state.0.operation_transition.lock().await;
    if generation != state.0.coordinator.generation() {
        emit_stale_clip(state, id);
        return;
    }
    let route = state.0.live_leg.route();
    state.0.transcript_log.lock().await.add_with_id(
        CALLER,
        &transcript,
        route.clone(),
        Some(id.to_owned()),
    );
    emit_json(
        state,
        json!({"type":"transcript", "id":id, "text":transcript}),
    );
    drop(_transition);
    let steer_operation = state
        .0
        .coordinator
        .attach_steer(&state.0.coordinator.current_identity())
        .ok();
    let active = state.0.active_session.lock().await;
    let steered = match active.as_ref().cloned() {
        None => false,
        Some(session) if steer_operation.is_none() || !session.busy() || !session.alive().await => {
            false
        }
        Some(session) => match session.steer(&transcript).await {
            Ok(()) => active
                .as_ref()
                .is_some_and(|current| current.same_session(&session)),
            Err(error) => {
                tracing::warn!(%error, clip = id, "steering failed; queueing streamed utterance");
                false
            }
        },
    };
    drop(active);
    if steered {
        state.0.activity_clock.touch();
        emit_json(
            state,
            json!({"type":"queued", "id":id, "waiting":0, "steered":true}),
        );
    } else {
        let waiting = state.0.queued_turns.fetch_add(1, Ordering::AcqRel) + 1;
        if state
            .0
            .turns
            .send((id.to_owned(), transcript, generation))
            .await
            .is_ok()
        {
            if waiting > 1 || state.0.turn_in_flight.load(Ordering::Acquire) {
                emit_json(
                    state,
                    json!({"type":"queued", "id":id, "waiting":waiting, "steered":false}),
                );
            }
        } else {
            state.0.queued_turns.fetch_sub(1, Ordering::AcqRel);
            emit_json(
                state,
                json!({"type":"error", "id":id, "message":"The call worker is unavailable."}),
            );
        }
    }
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
        state.0.coordinator.touch_activity();
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
        let _transition = state.0.operation_transition.lock().await;
        if clip.generation != state.0.coordinator.generation() {
            tracing::info!(clip = %clip.id, "discarding stale transcript before persistence");
            emit_stale_clip(&state, &clip.id);
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
        drop(_transition);
        // Steering is deliberately performed through the shared session handle,
        // not while holding the PBX mutex. The turn worker keeps that mutex for
        // the duration of handle(), so awaiting here would deadlock it.
        let steered = {
            // Steering attaches to the prompt operation already registered by
            // the turn worker. PiSession::steer has its own wire path and is
            // intentionally not serialized by the prompt mutex.
            let steer_operation = state
                .0
                .coordinator
                .attach_steer(&state.0.coordinator.current_identity())
                .ok();
            // Hold the session-control guard across the write so a hangup or
            // redial cannot replace the child between the identity check and
            // the steer. The PBX mutex is intentionally not held here.
            let active = state.0.active_session.lock().await;
            // Speech captured before a page rescue is discarded rather than
            // acted on. Checked under the session guard because a rescue bumps
            // the generation before it closes the session, so a steer that wins
            // this lock still observes the new epoch.
            let current = state.0.coordinator.generation();
            if clip.generation != current {
                tracing::info!(
                    clip = %clip.id,
                    stamped = clip.generation,
                    %current,
                    "discarding speech captured before a page rescue"
                );
                emit_stale_clip(&state, &clip.id);
                continue;
            }
            match active.as_ref().cloned() {
                None => false,
                Some(session)
                    if steer_operation.is_none() || !session.busy() || !session.alive().await =>
                {
                    false
                }
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
fn emit_stale_clip(state: &AppState, id: &str) {
    emit_json(
        state,
        json!({
            "type":"error",
            "id":id,
            "code":"stale_epoch",
            "message":"that recording belongs to the previous leg"
        }),
    );
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
        let (operation, _status) = {
            let _transition = state.0.operation_transition.lock().await;
            let current = state.0.coordinator.generation();
            if generation != current {
                tracing::info!(clip = %id, stamped = generation, %current, "dropping a queued turn from before a page rescue");
                emit_stale_clip(&state, &id);
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
            let operation = state
                .0
                .coordinator
                .begin_prompt(&state.0.coordinator.current_identity())
                .ok();
            (operation, status)
        };
        let Some((task, task_id)) = spawn_registered_operation(&state, generation, async move {
            let mut board = turn_state.0.switchboard.lock().await;
            let reply = board.handle(&transcript).await;
            let status = board.status();
            (reply, status)
        })
        .await
        else {
            tracing::info!(clip = %id, stamped = generation, "dropping turn because rescue occurred before registration");
            if let Some(operation) = &operation {
                state.0.coordinator.finish_operation(operation);
            }
            state.0.turn_in_flight.store(false, Ordering::Release);
            continue;
        };
        let (reply, status) = match task.await {
            Ok(result) => result,
            Err(error) if error.is_cancelled() => {
                tracing::info!(clip = %id, elapsed = ?started.elapsed(), "the turn was cancelled by a page rescue");
                clear_active_operation(&state, task_id).await;
                if let Some(operation) = &operation {
                    state.0.coordinator.finish_operation(operation);
                }
                state.0.turn_in_flight.store(false, Ordering::Release);
                continue;
            }
            Err(error) => {
                // A panic inside `handle()` arrives here. Without this line the
                // caller hears a generic apology and the journal holds nothing.
                tracing::error!(clip = %id, %error, elapsed = ?started.elapsed(), "the turn worker failed");
                clear_active_operation(&state, task_id).await;
                if let Some(operation) = &operation {
                    state.0.coordinator.finish_operation(operation);
                }
                state.0.turn_in_flight.store(false, Ordering::Release);
                emit_json(
                    &state,
                    json!({"type":"error", "message":format!("The call worker failed on that turn: {error}")}),
                );
                continue;
            }
        };
        clear_active_operation(&state, task_id).await;
        if let Some(operation) = &operation {
            state.0.coordinator.finish_operation(operation);
        }
        if let Some(error) = &reply.error {
            // The caller was answered and recovered, so this is not an error
            // level — but a turn that carried a failure is worth an audit trail.
            tracing::warn!(clip = %id, route = %reply.route, %error, "the turn reported a failure");
        }
        tracing::info!(clip = %id, route = %reply.route, elapsed = ?started.elapsed(), "turn settled");
        deliver_turn_if_current(&state, &reply, status, generation, &id).await;
        state.0.turn_in_flight.store(false, Ordering::Release);
    }
    tracing::warn!("the turn worker stopped; no further turns will be dispatched");
}

async fn healthz(State(state): State<AppState>) -> impl IntoResponse {
    let status = current_status(&state);
    Json(
        json!({"status":"ok", "whisper_model":"sidecar", "stt_configured":state.0.stt.command.is_some(), "stt_stream_configured":state.0.stt_stream.configured(), "stt_adapter":"sidecar", "elevenlabs_configured":state.0.speaker.configured(), "route":status["route"], "model":status["model"], "thinking":status["thinking"], "model_swaps":status["model_swaps"], "projects":status["projects"]}),
    )
}
async fn status(State(state): State<AppState>) -> impl IntoResponse {
    Json(current_status(&state))
}
async fn interrupt_active_turn(state: &AppState) -> Option<String> {
    cancel_active_operations(state).await
}
async fn cancel_active_operations(state: &AppState) -> Option<String> {
    let generation = state
        .0
        .coordinator
        .begin_rescue("operation interrupted")
        .generation;
    state.0.audio.lock().await.clear();
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
    let Some((task, task_id, generation)) = spawn_replacing_operation(&state, async move {
        let mut board = operation_state.0.switchboard.lock().await;
        let reply = board.dial(&req.project, &req.intent).await;
        let status = board.status();
        (reply, status)
    })
    .await
    else {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"detail":"connection attempt was cancelled"})),
        )
            .into_response();
    };
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
    let Some((task, task_id, generation)) = (if state.0.live_leg.route() == crate::pbx::OPERATOR {
        spawn_active_operation(&state, operation).await
    } else {
        spawn_replacing_operation(&state, operation).await
    }) else {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"detail":"thinking change was cancelled"})),
        )
            .into_response();
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
struct Model {
    model: String,
}
async fn model(State(state): State<AppState>, Json(req): Json<Model>) -> Response {
    let operation_state = state.clone();
    let operation = async move {
        let mut board = operation_state.0.switchboard.lock().await;
        let reply = board.set_model(&req.model).await;
        let status = board.status();
        (reply, status)
    };
    let Some((task, task_id, generation)) = (if state.0.live_leg.route() == crate::pbx::OPERATOR {
        spawn_active_operation(&state, operation).await
    } else {
        spawn_replacing_operation(&state, operation).await
    }) else {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"detail":"model change was cancelled"})),
        )
            .into_response();
    };
    let (reply, status) = match task.await {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => {
            clear_active_operation(&state, task_id).await;
            return (
                axum::http::StatusCode::CONFLICT,
                Json(json!({"detail":"model change was cancelled"})),
            )
                .into_response();
        }
        Err(error) => {
            clear_active_operation(&state, task_id).await;
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"detail":format!("model change failed: {error}")})),
            )
                .into_response();
        }
    };
    clear_active_operation(&state, task_id).await;
    if !deliver_page_reply_if_current(&state, &reply, status, generation).await {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"detail":"model change was superseded"})),
        )
            .into_response();
    }
    Json(json!({"model":current_status(&state)["model_name"], "error":reply.error.clone()}))
        .into_response()
}
#[derive(Deserialize)]
struct LegState {
    #[serde(default)]
    thinking: String,
    #[serde(default)]
    token: String,
}
async fn leg_state(State(state): State<AppState>, Json(req): Json<LegState>) -> impl IntoResponse {
    let accepted = match state
        .0
        .coordinator
        .accept_thinking_callback(&req.token, &req.thinking)
    {
        Ok(public) => {
            if public {
                let _ = state.0.live_leg.report_thinking(&req.token, &req.thinking);
                let mut status = current_status(&state);
                status["thinking"] = Value::String(req.thinking.clone());
                status["thinking_confirmed"] = Value::Bool(true);
                publish_status(&state, status);
            }
            true
        }
        Err(_) => false,
    };
    Json(json!({"accepted":accepted}))
}
#[derive(Deserialize)]
struct Speak {
    text: String,
    #[serde(default)]
    token: String,
}
async fn speak(State(state): State<AppState>, Json(req): Json<Speak>) -> Response {
    if req.text.trim().is_empty() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"detail":"text must not be empty"})),
        )
            .into_response();
    }
    if let Err(error) = state.0.coordinator.accept_side_effect(&req.token) {
        let (code, detail) = match error {
            crate::lifecycle::LifecycleError::CandidateSideEffect => (
                axum::http::StatusCode::CONFLICT,
                "candidate side effects are not public yet",
            ),
            _ => (
                axum::http::StatusCode::CONFLICT,
                "the project callback is stale or invalid",
            ),
        };
        return (
            code,
            Json(json!({"delivered":false, "code":"invalid_leg", "detail":detail})),
        )
            .into_response();
    }
    if !state.0.delivery.connected() {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"delivered":false, "reason":"no browser connected", "detail":"no browser connected"})),
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
        return Json(json!({"delivered":false, "reason":"text contained no speakable audio", "detail":"text contained no speakable audio"})).into_response();
    } else {
        match state.0.speech.try_reserve() {
            Ok(permit) => Some(permit),
            Err(_) => {
                return (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"delivered":false, "reason":"speech worker is unavailable or busy", "detail":"speech worker is unavailable or busy"})),
                )
                    .into_response()
            }
        }
    };

    if let Some(permit) = speech_permit {
        let generation = state.0.coordinator.generation();
        let sequence = match reserve_audio(&state, generation).await {
            Some(sequence) => sequence,
            None => return Json(json!({"delivered":false, "reason":"no browser connected", "detail":"no browser connected"})).into_response(),
        };
        let (result_tx, result_rx) = oneshot::channel();
        permit.send(SpeechRequest {
            text: spoken,
            generation,
            sequence,
            deadline: std::time::Instant::now() + state.0.speech_deadline,
            result: result_tx,
        });
        match result_rx.await {
            Ok(Ok(())) => return Json(delivery_response(true)).into_response(),
            Ok(Err(detail)) => {
                return (
                    axum::http::StatusCode::BAD_GATEWAY,
                    Json(json!({"delivered":false, "reason":detail.clone(), "detail":detail})),
                )
                    .into_response();
            }
            Err(_) => {
                return (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"delivered":false, "reason":"speech worker stopped", "detail":"speech worker stopped"})),
                )
                    .into_response();
            }
        }
    }

    Json(json!({"delivered":false, "reason":"no browser connected", "detail":"no browser connected"})).into_response()
}
#[derive(Deserialize)]
struct Diagram {
    source: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    notes: String,
}
async fn diagram(State(state): State<AppState>, Json(req): Json<Diagram>) -> Response {
    if let Err(error) = state.0.coordinator.accept_side_effect(&req.token) {
        let detail = match error {
            crate::lifecycle::LifecycleError::CandidateSideEffect => {
                "candidate side effects are not public yet"
            }
            _ => "the project callback is stale or invalid",
        };
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"delivered":false, "code":"invalid_leg", "detail":detail})),
        )
            .into_response();
    }
    let value =
        json!({"type":"diagram", "source":req.source, "title":req.title, "notes":req.notes});
    *state.0.last_diagram.lock().await = Some(value.clone());
    let delivered = emit_json(&state, value);
    Json(delivery_response(delivered)).into_response()
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
    if generation != state.0.coordinator.generation() {
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
    let _ = synthesize_reply_if_current(
        state,
        &reply.to_speak,
        generation,
        std::time::Instant::now() + state.0.speech_deadline,
    )
    .await;
    generation == state.0.coordinator.generation()
}

async fn deliver_turn_if_current(
    state: &AppState,
    reply: &crate::pbx::Reply,
    status: Value,
    generation: u64,
    response_id: &str,
) -> bool {
    let _transition = state.0.operation_transition.lock().await;
    if generation != state.0.coordinator.generation() {
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
    let success = synthesize_reply_if_current(
        state,
        &reply.to_speak,
        generation,
        std::time::Instant::now() + state.0.speech_deadline,
    )
    .await;
    if generation != state.0.coordinator.generation() {
        return false;
    }
    let Some(sequence) = reserve_audio(state, generation).await else {
        return false;
    };
    let barrier = json!({
        "type": "final_response_audio_closed",
        "response_id": response_id,
        "generation": generation,
        "success": success,
    });
    let events = {
        let mut audio = state.0.audio.lock().await;
        audio.barrier(sequence, generation, barrier)
    };
    let _ = publish_audio_events(state, events).await;
    success
}

async fn synthesize_reply_if_current(
    state: &AppState,
    utterances: &[String],
    generation: u64,
    deadline: std::time::Instant,
) -> bool {
    let mut success = true;
    for text in utterances {
        let spoken = state.0.speaker.clip_for_speech(text);
        if spoken.is_empty() {
            continue;
        }
        let Some(sequence) = reserve_audio(state, generation).await else {
            success = false;
            break;
        };
        let started = std::time::Instant::now();
        let synthesized =
            synthesize_audio_stream(state, &spoken, sequence, generation, deadline).await;
        match synthesized {
            Ok((bytes, _delivered)) => {
                tracing::info!(chars = spoken.chars().count(), bytes, elapsed = ?started.elapsed(), "synthesized a reply");
            }
            Err(error) => {
                finish_audio(state, sequence, generation, Vec::new()).await;
                tracing::error!(%error, chars = spoken.chars().count(), "synthesis failed; the caller hears nothing for this reply");
                emit_json(state, json!({"type":"error", "message":error.to_string()}));
                success = false;
            }
        }
    }
    success && generation == state.0.coordinator.generation()
}

async fn ws(State(state): State<AppState>, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    upgrade
        .max_message_size(MAX_WEBSOCKET_MESSAGE_BYTES)
        .max_frame_size(MAX_WEBSOCKET_MESSAGE_BYTES)
        .on_upgrade(move |socket| websocket(socket, state))
}
async fn websocket(socket: WebSocket, state: AppState) {
    // Registration precedes snapshot reads. Every event published after this
    // point is queued for this epoch, so the writer can release the barrier
    // only after epoch, status, history, and the optional diagram are sent.
    let connection = state.0.delivery.register();
    let epoch = connection.epoch;
    let (mut sink, mut incoming) = socket.split();
    let mut frames = connection.receiver;
    let writer_state = state.clone();
    let mut writer = Box::pin(tokio::spawn(async move {
        send_snapshot_sink(&mut sink, &writer_state).await?;
        while let Some(frame) = frames.recv().await {
            match frame {
                DeliveryFrame::Event { sequence, event } => {
                    tracing::trace!(sequence, epoch, "delivering sequenced event");
                    send_event_sink(&mut sink, event).await?
                }
                DeliveryFrame::Message(message) => sink.send(message).await?,
            }
        }
        Ok::<(), axum::Error>(())
    }));
    let writer_id = writer.id();
    let mut shutdown = state.0.shutdown.subscribe();
    let mut pending_header: Option<ClipHeader> = None;
    let mut pending_stream_chunk: Option<StreamChunkHeader> = None;
    loop {
        tokio::select! {
            result = &mut writer => {
                if let Ok(Err(error)) = result { tracing::warn!(%error, "could not deliver an event to the browser"); }
                break;
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() { break; }
            }
            received = incoming.next() => match received {
                Some(Ok(Message::Text(text))) => {
                    if handle_text_frame(&state, epoch, &mut pending_header, &mut pending_stream_chunk, text.as_ref()).await.is_err() { break; }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    if handle_audio_frame(&state, epoch, &mut pending_header, &mut pending_stream_chunk, bytes.to_vec()).await.is_err() { break; }
                }
                Some(Ok(Message::Ping(bytes))) => {
                    if !state.0.delivery.send(epoch, Message::Pong(bytes)) { break; }
                }
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Close(frame))) => {
                    tracing::info!(code = ?frame.as_ref().map(|frame| frame.code), "browser disconnected");
                    break;
                }
                Some(Err(error)) => { tracing::warn!(%error, "the websocket reader failed"); break; }
                None => break,
            },
        }
    }
    state.0.delivery.retire(epoch);
    // The writer owns the only sink. Retiring first prevents new events from
    // being accepted while its final send is being canceled.
    writer.abort();
    tracing::debug!(?writer_id, epoch, "browser connection retired");
}

async fn send_snapshot_sink(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    state: &AppState,
) -> Result<(), axum::Error> {
    let initial = [
        Event::Json(json!({"type":"epoch", "generation":state.0.coordinator.generation()})),
        Event::Json(current_status(state)),
        Event::Json(
            serde_json::to_value(state.0.transcript_log.lock().await.payload()).unwrap_or_default(),
        ),
    ];
    for event in initial {
        send_event_sink(sink, event).await?;
    }
    if let Some(diagram) = state.0.last_diagram.lock().await.clone() {
        send_event_sink(sink, Event::Json(diagram)).await?;
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
type StreamChunkHeader = (String, u64, u64);

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
    state: &AppState,
    epoch: u64,
    pending_header: &mut Option<ClipHeader>,
    pending_stream_chunk: &mut Option<StreamChunkHeader>,
    text: &str,
) -> Result<(), ()> {
    let command: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => {
            return send_json(
                state,
                epoch,
                json!({"type":"error", "message":"Invalid JSON frame."}),
            )
            .await
        }
    };
    let Some(command) = command.as_object() else {
        return send_json(
            state,
            epoch,
            json!({"type":"error", "message":"Invalid command shape."}),
        )
        .await;
    };

    match command.get("type").and_then(Value::as_str) {
        Some("hello") => {
            let version = command.get("version").and_then(Value::as_u64).unwrap_or(0);
            let capabilities = command.get("capabilities").and_then(Value::as_object);
            let stream_requested = capabilities
                .and_then(|caps| caps.get("stt_streaming"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mse_requested = capabilities
                .and_then(|caps| caps.get("mse_mp3"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mse_selected = version == 1 && mse_requested;
            send_json(state, epoch, json!({"type":"hello_ack", "version":1, "stt_streaming": version == 1 && stream_requested && state.0.stt_stream.configured(), "audio_streaming":mse_selected, "mse_mp3":mse_selected})).await
        }
        Some("stt_start") => {
            pending_header.take();
            let Some(id) = command
                .get("clip_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 128)
            else {
                return send_json(
                    state,
                    epoch,
                    json!({"type":"error", "message":"Invalid streaming clip id."}),
                )
                .await;
            };
            let generation = command
                .get("generation")
                .and_then(Value::as_u64)
                .unwrap_or_else(|| state.0.coordinator.generation());
            let mime = command.get("mime").and_then(Value::as_str).unwrap_or("");
            if mime != "audio/webm;codecs=opus" || !state.0.stt_stream.configured() {
                return send_json(state, epoch, json!({"type":"abandoned", "id":id, "reason":"streaming STT is unavailable for this clip"})).await;
            }
            let mut clips = state.0.stream_clips.lock().await;
            match clips.get(id).copied() {
                Some(StreamClipState::Open { connection, .. }) if connection == epoch => {
                    return send_json(
                        state,
                        epoch,
                        json!({"type":"accepted", "id":id, "streaming":true}),
                    )
                    .await;
                }
                Some(StreamClipState::Ended {
                    generation: _,
                    connection,
                }) if connection == epoch => {
                    return send_json(
                        state,
                        epoch,
                        json!({"type":"accepted", "id":id, "streaming":true}),
                    )
                    .await;
                }
                Some(StreamClipState::Ended { generation, .. }) => {
                    clips.insert(
                        id.to_owned(),
                        StreamClipState::Open {
                            generation,
                            next_sequence: 0,
                            connection: epoch,
                        },
                    );
                    drop(clips);
                    if let Err(reason) =
                        state
                            .0
                            .stt_stream
                            .try_start(id.to_owned(), generation, mime.to_owned())
                    {
                        state
                            .0
                            .stream_clips
                            .lock()
                            .await
                            .insert(id.to_owned(), StreamClipState::Abandoned);
                        return send_json(
                            state,
                            epoch,
                            json!({"type":"abandoned", "id":id, "reason":reason}),
                        )
                        .await;
                    }
                    return send_json(
                        state,
                        epoch,
                        json!({"type":"accepted", "id":id, "streaming":true}),
                    )
                    .await;
                }
                Some(
                    StreamClipState::Abandoned
                    | StreamClipState::Cancelled
                    | StreamClipState::Finalized,
                ) => {
                    return send_json(state, epoch, json!({"type":"abandoned", "id":id, "reason":"clip is no longer resumable"})).await;
                }
                _ => {}
            }
            if clips.len() >= 512 {
                let retired = clips
                    .iter()
                    .find(|(_, state)| {
                        matches!(
                            state,
                            StreamClipState::Cancelled
                                | StreamClipState::Abandoned
                                | StreamClipState::Finalized
                        )
                    })
                    .map(|(id, _)| id.clone());
                if let Some(retired) = retired {
                    clips.remove(&retired);
                }
            }
            if clips.len() >= 512 {
                return send_json(state, epoch, json!({"type":"abandoned", "id":id, "reason":"too many active streaming clips"})).await;
            }
            clips.insert(
                id.to_owned(),
                StreamClipState::Open {
                    generation,
                    next_sequence: 0,
                    connection: epoch,
                },
            );
            drop(clips);
            if let Err(reason) =
                state
                    .0
                    .stt_stream
                    .try_start(id.to_owned(), generation, mime.to_owned())
            {
                state
                    .0
                    .stream_clips
                    .lock()
                    .await
                    .insert(id.to_owned(), StreamClipState::Abandoned);
                return send_json(
                    state,
                    epoch,
                    json!({"type":"abandoned", "id":id, "reason":reason}),
                )
                .await;
            }
            send_json(
                state,
                epoch,
                json!({"type":"accepted", "id":id, "streaming":true}),
            )
            .await
        }
        Some("stt_chunk") => {
            let Some(id) = command
                .get("clip_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 128)
            else {
                return send_json(
                    state,
                    epoch,
                    json!({"type":"error", "message":"Invalid streaming clip id."}),
                )
                .await;
            };
            let generation = command
                .get("generation")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let sequence = command
                .get("sequence")
                .and_then(Value::as_u64)
                .unwrap_or(u64::MAX);
            *pending_stream_chunk = Some((id.to_owned(), generation, sequence));
            Ok(())
        }
        Some("stt_end") => {
            let Some(id) = command.get("clip_id").and_then(Value::as_str) else {
                return Ok(());
            };
            let generation = command
                .get("generation")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let valid = {
                let mut clips = state.0.stream_clips.lock().await;
                match clips.get(id).copied() {
                    Some(StreamClipState::Open {
                        generation: current,
                        connection,
                        ..
                    }) if current == generation && connection == epoch => {
                        clips.insert(
                            id.to_owned(),
                            StreamClipState::Ended {
                                generation,
                                connection,
                            },
                        );
                        true
                    }
                    Some(StreamClipState::Ended { .. })
                    | Some(StreamClipState::Cancelled)
                    | Some(StreamClipState::Abandoned)
                    | Some(StreamClipState::Finalized) => false,
                    _ => false,
                }
            };
            if valid {
                if let Err(reason) = state.0.stt_stream.try_end(id.to_owned(), generation) {
                    state
                        .0
                        .stream_clips
                        .lock()
                        .await
                        .insert(id.to_owned(), StreamClipState::Abandoned);
                    return send_json(
                        state,
                        epoch,
                        json!({"type":"abandoned", "id":id, "reason":reason}),
                    )
                    .await;
                }
            }
            Ok(())
        }
        Some("stt_cancel") => {
            let Some(id) = command.get("clip_id").and_then(Value::as_str) else {
                return Ok(());
            };
            let generation = command
                .get("generation")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let should_cancel = {
                let mut clips = state.0.stream_clips.lock().await;
                match clips.get(id).copied() {
                    Some(StreamClipState::Cancelled)
                    | Some(StreamClipState::Finalized)
                    | Some(StreamClipState::Abandoned)
                    | None => false,
                    Some(_) => {
                        clips.insert(id.to_owned(), StreamClipState::Cancelled);
                        true
                    }
                }
            };
            if should_cancel {
                let _ = state.0.stt_stream.try_cancel(id.to_owned(), generation);
            }
            Ok(())
        }
        Some("ping") => {
            send_json(
                state,
                epoch,
                json!({"type":"pong", "nonce":command.get("nonce"), "time":command.get("time")}),
            )
            .await
        }
        Some("clip") => {
            let Some(header) = parse_clip_header(command) else {
                pending_header.take();
                return send_json(
                    state,
                    epoch,
                    json!({"type":"error", "message":"Invalid clip id."}),
                )
                .await;
            };
            *pending_header = Some(header);
            Ok(())
        }
        _ => {
            send_json(
                state,
                epoch,
                json!({"type":"error", "message":"Unknown websocket command."}),
            )
            .await
        }
    }
}

async fn handle_audio_frame(
    state: &AppState,
    epoch: u64,
    pending_header: &mut Option<ClipHeader>,
    pending_stream_chunk: &mut Option<StreamChunkHeader>,
    audio: Vec<u8>,
) -> Result<(), ()> {
    if let Some((id, generation, sequence)) = pending_stream_chunk.take() {
        let admitted = {
            let mut clips = state.0.stream_clips.lock().await;
            match clips.get_mut(&id) {
                Some(StreamClipState::Open {
                    generation: current,
                    next_sequence,
                    connection,
                }) if *current == generation
                    && *connection == epoch
                    && *next_sequence == sequence =>
                {
                    *next_sequence += 1;
                    true
                }
                _ => false,
            }
        };
        if !admitted {
            return send_json(state, epoch, json!({"type":"error", "id":id, "message":"Invalid or out-of-order streaming chunk."})).await;
        }
        if let Err(reason) = state
            .0
            .stt_stream
            .try_chunk(id.clone(), generation, sequence, audio)
        {
            state
                .0
                .stream_clips
                .lock()
                .await
                .insert(id.clone(), StreamClipState::Abandoned);
            return send_json(
                state,
                epoch,
                json!({"type":"abandoned", "id":id, "reason":reason}),
            )
            .await;
        }
        return Ok(());
    }
    let Some((id, mime, generation)) = pending_header.take() else {
        tracing::warn!(bytes = audio.len(), "audio arrived without a clip header");
        return send_json(
            state,
            epoch,
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
                generation: generation.unwrap_or_else(|| state.0.coordinator.generation()),
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
            state,
            epoch,
            json!({"type":"error", "id":id, "message":"The call worker is unavailable."}),
        )
        .await;
    }
    send_json(state, epoch, json!({"type":"accepted", "id":id})).await
}

async fn send_json(state: &AppState, epoch: u64, value: Value) -> Result<(), ()> {
    state
        .0
        .delivery
        .send(epoch, Message::Text(value.to_string().into()))
        .then_some(())
        .ok_or(())
}
async fn send_event_sink(
    socket: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    event: Event,
) -> Result<(), axum::Error> {
    match event {
        Event::Json(value) => socket.send(Message::Text(value.to_string().into())).await,
        Event::AudioStart { generation, sequence, mime, format } => {
            socket.send(Message::Text(json!({"type":"audio_start", "generation":generation, "sequence":sequence, "mime":mime, "format":format}).to_string().into())).await
        }
        Event::AudioChunk { audio, .. } => socket.send(Message::Binary(audio.into())).await,
        Event::AudioDone { generation, sequence } => {
            socket.send(Message::Text(json!({"type":"audio_done", "generation":generation, "sequence":sequence, "done":true}).to_string().into())).await
        }
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
        state_with_stream(stt, None)
    }

    fn state_with_stream(stt: Option<String>, stream: Option<String>) -> AppState {
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
        AppState::new_with_stream(
            board,
            TranscriptLog::new(10),
            Speaker::from_values(
                100,
                &HashMap::from([("ELEVENLABS_API_KEY".into(), "test-key".into())]),
            ),
            SttAdapter::from_command(stt),
            SttStreamAdapter::from_command(stream),
        )
    }

    async fn next_delivery(connection: &mut DeliveryConnection) -> Value {
        let Some(DeliveryFrame::Message(Message::Text(text))) = connection.receiver.recv().await
        else {
            panic!("expected a websocket response");
        };
        serde_json::from_str(&text).unwrap()
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

        let (code, model) = request_json(
            &state,
            Method::POST,
            "/model",
            Some(json!({"model":"anthropic/next"})),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(model["model"], "");
        assert!(model["error"].as_str().unwrap().contains("project leg"));

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
        assert_eq!(
            response,
            json!({"delivered":false, "reason":"no browser connected"})
        );
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
    async fn delivery_registration_captures_live_events_for_snapshot_barrier() {
        let delivery = DeliveryState::new();
        let mut connection = delivery.register();
        delivery.publish(Event::Json(json!({"type":"status"})));
        let Some(DeliveryFrame::Event {
            sequence,
            event: Event::Json(value),
        }) = connection.receiver.recv().await
        else {
            panic!("registered connection should receive live event");
        };
        assert_eq!(sequence, 0);
        assert_eq!(value["type"], "status");
        delivery.retire(connection.epoch);
        assert!(!delivery.connected());
    }

    #[test]
    fn audio_queue_emits_reserved_sequences_in_order_and_drops_on_clear() {
        let mut queue = AudioQueue::new();
        let first = queue.reserve(3);
        let second = queue.reserve(3);
        assert!(queue.start(second, 3).is_empty());
        assert!(queue.append(second, 3, vec![2]).is_empty());
        assert!(queue.finish(second, 3).is_empty());
        assert!(matches!(
            queue.start(first, 3).as_slice(),
            [Event::AudioStart { sequence: 0, .. }]
        ));
        assert!(matches!(
            queue.append(first, 3, vec![1]).as_slice(),
            [Event::AudioChunk { sequence: 0, .. }]
        ));
        let events = queue.finish(first, 3);
        assert!(matches!(
            events.as_slice(),
            [
                Event::AudioDone { sequence: 0, .. },
                Event::AudioStart { sequence: 1, .. },
                Event::AudioChunk { sequence: 1, .. },
                Event::AudioDone { sequence: 1, .. }
            ]
        ));
        let stale = queue.reserve(3);
        queue.clear();
        assert!(queue.finish(stale, 3).is_empty());
    }

    #[tokio::test]
    async fn final_response_barrier_is_emitted_once_after_a_settled_turn() {
        let state = state();
        let mut events = state.0.events.subscribe();
        let generation = state.0.coordinator.generation();
        let reply = crate::pbx::Reply {
            text: "Final answer".into(),
            route: OPERATOR.into(),
            route_label: "Operator".into(),
            error: None,
            to_speak: Vec::new(),
        };

        assert!(
            deliver_turn_if_current(&state, &reply, current_status(&state), generation, "clip-1",)
                .await
        );
        let mut barriers = Vec::new();
        while let Ok(Event::Json(value)) = events.try_recv() {
            if value["type"] == "final_response_audio_closed" {
                barriers.push(value);
            }
        }
        assert_eq!(barriers.len(), 1);
        assert_eq!(
            barriers[0],
            json!({
                "type": "final_response_audio_closed",
                "response_id": "clip-1",
                "generation": generation,
                "success": true,
            })
        );
    }

    #[tokio::test]
    async fn stale_final_response_does_not_emit_a_barrier() {
        let state = state();
        let mut events = state.0.events.subscribe();
        let generation = state.0.coordinator.generation();
        state.0.coordinator.begin_rescue("test rescue");
        let reply = crate::pbx::Reply {
            text: "stale".into(),
            route: OPERATOR.into(),
            route_label: "Operator".into(),
            error: None,
            to_speak: Vec::new(),
        };

        assert!(
            !deliver_turn_if_current(
                &state,
                &reply,
                current_status(&state),
                generation,
                "stale-clip",
            )
            .await
        );
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn audio_queue_barrier_waits_for_reserved_audio_before_it() {
        let mut queue = AudioQueue::new();
        let audio = queue.reserve(1);
        let marker = queue.reserve(1);
        assert!(queue
            .barrier(marker, 1, json!({"type":"barrier"}))
            .is_empty());
        assert!(matches!(
            queue.start(audio, 1).as_slice(),
            [Event::AudioStart { sequence: 0, .. }]
        ));
        let events = queue.finish(audio, 1);
        assert!(matches!(
            events.as_slice(),
            [
                Event::AudioDone { sequence: 0, .. },
                Event::Json(value)
            ] if value["type"] == "barrier"
        ));
    }

    #[test]
    fn audio_queue_cancellation_releases_following_audio() {
        let mut queue = AudioQueue::new();
        let first = queue.reserve(1);
        let second = queue.reserve(1);
        assert!(matches!(
            queue.cancel(first, 1).as_slice(),
            [
                Event::AudioStart { sequence: 0, .. },
                Event::AudioDone { sequence: 0, .. }
            ]
        ));
        assert!(matches!(
            queue.start(second, 1).as_slice(),
            [Event::AudioStart { sequence: 1, .. }]
        ));
        assert!(matches!(
            queue.append(second, 1, vec![7]).as_slice(),
            [Event::AudioChunk { sequence: 1, .. }]
        ));
        let events = queue.finish(second, 1);
        assert!(matches!(
            events.as_slice(),
            [Event::AudioDone { sequence: 1, .. }]
        ));
    }

    #[tokio::test]
    async fn streaming_clip_rejects_duplicate_chunks_and_repeats_end_cancel_safely() {
        let state = state_with_stream(None, Some("true".into()));
        let mut connection = state.0.delivery.register();
        let epoch = connection.epoch;
        let mut pending_header = None;
        let mut pending_chunk = None;

        handle_text_frame(
            &state,
            epoch,
            &mut pending_header,
            &mut pending_chunk,
            r#"{"type":"stt_start","clip_id":"clip","generation":1,"mime":"audio/webm;codecs=opus"}"#,
        )
        .await
        .unwrap();
        assert_eq!(next_delivery(&mut connection).await["type"], "accepted");

        handle_text_frame(
            &state,
            epoch,
            &mut pending_header,
            &mut pending_chunk,
            r#"{"type":"stt_chunk","clip_id":"clip","generation":1,"sequence":0}"#,
        )
        .await
        .unwrap();
        handle_audio_frame(
            &state,
            epoch,
            &mut pending_header,
            &mut pending_chunk,
            b"first".to_vec(),
        )
        .await
        .unwrap();
        handle_text_frame(
            &state,
            epoch,
            &mut pending_header,
            &mut pending_chunk,
            r#"{"type":"stt_chunk","clip_id":"clip","generation":1,"sequence":0}"#,
        )
        .await
        .unwrap();
        handle_audio_frame(
            &state,
            epoch,
            &mut pending_header,
            &mut pending_chunk,
            b"duplicate".to_vec(),
        )
        .await
        .unwrap();
        assert_eq!(next_delivery(&mut connection).await["type"], "error");

        for _ in 0..2 {
            handle_text_frame(
                &state,
                epoch,
                &mut pending_header,
                &mut pending_chunk,
                r#"{"type":"stt_end","clip_id":"clip","generation":1}"#,
            )
            .await
            .unwrap();
        }
        for _ in 0..2 {
            handle_text_frame(
                &state,
                epoch,
                &mut pending_header,
                &mut pending_chunk,
                r#"{"type":"stt_cancel","clip_id":"clip","generation":1}"#,
            )
            .await
            .unwrap();
        }
        assert_eq!(
            state.0.stream_clips.lock().await.get("clip"),
            Some(&StreamClipState::Cancelled)
        );
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
        assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            spoken,
            json!({"delivered":false, "reason":"no browser connected", "detail":"no browser connected"})
        );

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
    async fn speak_reports_failure_and_does_not_log_transcript_when_delivery_fails() {
        let state = state();
        let (code, spoken) = request_json(
            &state,
            Method::POST,
            "/speak",
            Some(json!({"text":"Hello world."})),
        )
        .await;
        assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(spoken["delivered"], false);
        assert_eq!(spoken["reason"], "no browser connected");
        assert!(state.0.transcript_log.lock().await.entries().is_empty());
    }

    #[tokio::test]
    async fn generation_mismatch_prevents_turn_spawn() {
        let state = state();
        let current = state.0.coordinator.generation();
        state.0.coordinator.begin_rescue("test bump");
        let result = spawn_registered_operation(&state, current, async move { 42 }).await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn newer_page_control_supersedes_setup_before_a_session_exists() {
        let state = state();
        let first_state = state.clone();
        let (first, first_id, _) = spawn_active_operation(&state, async move {
            let _board = first_state.0.switchboard.lock().await;
            pending::<()>().await;
        })
        .await
        .unwrap();

        let second_state = state.clone();
        let (second, second_id, _generation) = spawn_replacing_operation(&state, async move {
            let _board = second_state.0.switchboard.lock().await;
            7
        })
        .await
        .unwrap();

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
        let generation = state.0.coordinator.generation();
        state.0.coordinator.begin_rescue("test rescue");
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
        let old_generation = state.0.coordinator.generation();
        state.0.coordinator.begin_rescue("test rescue");
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
        let stale = events
            .try_recv()
            .expect("stale queued turn is acknowledged");
        assert!(matches!(stale, Event::Json(ref value) if value["code"] == "stale_epoch"));
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
                generation: state.0.coordinator.generation(),
            })
            .await
            .unwrap();
        // The transfer lands while the clip is still inside the sidecar.
        state.0.coordinator.begin_rescue("test rescue");
        let worker_state = state.clone();
        let worker = tokio::spawn(async move { process_clips(worker_state).await });

        // The worker may finish transcription, but stale history and live
        // transcript events must be suppressed before either side effect.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(state.0.transcript_log.lock().await.entries().is_empty());
        let stale = events.try_recv().expect("stale clip is acknowledged");
        assert!(matches!(stale, Event::Json(ref value) if value["code"] == "stale_epoch"));
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

//! HTTP, WebSocket and application workers.
use crate::audio::{Speaker, SttAdapter, SttStreamAdapter};
use crate::caller_input::{
    handle_audio_frame, parse_clip_header, parse_typed_turn, process_clips, process_stream_results,
    route_final_transcript, start_stream_clip, Clip, ClipHeader, ClipVerdicts, StreamChunkHeader,
    StreamClipState,
};
use crate::debug::{DebugBus, DebugEvent};
use crate::delivery::{AudioQueue, DeliveryConnection, DeliveryFrame, DeliveryState, Event};
use crate::display::{
    is_display_event, stamp_display_seq, ConfirmState, DisplayGateState, DisplayProjection,
    DISPLAY_CONFIRM_DEADLINE_MS,
};
use crate::floor::{Floor, FloorRequest};
#[cfg(test)]
use crate::history::CALLER;
use crate::history::{TranscriptLog, AGENT};
use crate::hosts::Hosts;
#[cfg(test)]
use crate::hosts::{FakeHostAgent, FakeLog, Step};
#[cfg(test)]
use crate::jev::fake_jev_client;
use crate::leg_announcer::LegAnnouncer;
use crate::lifecycle::{Coordinator, OperationIdentity};
#[cfg(test)]
use crate::pbx::OPERATOR;
use crate::pbx::{
    AgentStateCallback, AgentStateNotice, Redial, RedialPlan, RedialPlanner, RouteCallback,
    RoutingView, Switchboard,
};
use crate::pi_client::{
    Activity, ActivityCallback, AgentCall, LegSession, ModuleCallback, ProjectTurn, TurnCallback,
};
use crate::protocol::{AgentRequest, AgentState, CandidateEnd, ServerMessage, Status};
#[cfg(test)]
use crate::registry::Registry;
#[cfg(test)]
use crate::speech::start_speech_worker_for_test;
use crate::speech::{
    deliver_page_reply_if_current, ensure_speech_worker, reserve_speech, send_speech,
    spawn_floor_worker, trace_speech, ContinuationScope, ReserveFailure, SpeechAdmission,
    SpeechContinuity, SpeechFailure, SpeechGroup, SpeechRequest, WhenQueueFull,
};
use crate::turns::{handle_project_turn, process_turns, RoutedDecision};
use axum::extract::ws::{Message, WebSocket};
#[cfg(test)]
use axum::http::StatusCode;
use axum::{
    extract::rejection::JsonRejection,
    extract::{State, WebSocketUpgrade},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
#[cfg(test)]
use http_body_util::BodyExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
};
use tokio::sync::{broadcast, mpsc, watch, Mutex};
use tokio::task::{AbortHandle, Id as TaskId, JoinHandle};
#[cfg(test)]
use tokio::time::{timeout, Duration};
use tower_http::services::ServeDir;
use tracing::Instrument;

const MAX_WEBSOCKET_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// The presentation-side owner of resident agent state and held displays.
/// PBX transitions and turn settlement feed it notices; no caller edits either
/// projection directly, so waiting requests cannot be lost by a late idle.
#[derive(Clone)]
pub(crate) struct AgentProjection {
    // These are deliberately synchronous locks. Coordinator's background
    // owner holds its lifecycle mutex while it validates a resident and
    // applies a waiting/display mutation, so the check and write cannot be
    // separated by promotion.
    pub(crate) states: Arc<StdMutex<Vec<AgentState>>>,
    displays: Arc<StdMutex<HashMap<String, Value>>>,
}

impl AgentProjection {
    fn notice(&self, notice: &AgentStateNotice) -> Vec<AgentState> {
        if notice.state == "finished" {
            self.displays
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&notice.project);
        }
        let mut agents = self
            .states
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(agent) = agents
            .iter_mut()
            .find(|agent| agent.project == notice.project)
        {
            if !(agent.state == "waiting" && notice.state == "idle") {
                agent.state = notice.state.clone();
                if notice.state != "waiting" {
                    agent.pending_request = None;
                }
            }
        } else {
            agents.push(AgentState {
                project: notice.project.clone(),
                state: notice.state.clone(),
                pending_request: None,
            });
            agents.sort_by(|left, right| left.project.cmp(&right.project));
        }
        agents.clone()
    }

    fn waiting(&self, project: String, request: AgentRequest) -> Vec<AgentState> {
        let mut agents = self
            .states
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(agent) = agents.iter_mut().find(|agent| agent.project == project) {
            agent.state = "waiting".into();
            agent.pending_request = Some(request);
        } else {
            agents.push(AgentState {
                project,
                state: "waiting".into(),
                pending_request: Some(request),
            });
            agents.sort_by(|left, right| left.project.cmp(&right.project));
        }
        agents.clone()
    }

    /// A floor message consumed the pending request. This is distinct from a
    /// normal idle settlement, which deliberately preserves a request that a
    /// turn finished beside.
    pub(crate) fn floor_released(&self, project: &str) -> Vec<AgentState> {
        let mut agents = self
            .states
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(agent) = agents.iter_mut().find(|agent| agent.project == project) {
            if agent.state == "waiting" {
                agent.state = "idle".into();
                agent.pending_request = None;
            }
        }
        agents.clone()
    }

    pub(crate) fn hold_display(&self, project: String, action: Value) {
        self.displays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(project, action);
    }

    pub(crate) fn has_held_display(&self, project: &str) -> bool {
        self.displays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(project)
    }

    pub(crate) fn take_display(&self, project: &str) -> Option<Value> {
        self.displays
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(project)
    }

    pub(crate) fn snapshot(&self) -> Vec<AgentState> {
        self.states
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

#[derive(Clone)]
pub struct AppState(pub Arc<AppInner>);
pub struct AppInner {
    pub switchboard: Mutex<Switchboard>,
    /// The project hosts' links (`/host`).
    pub(crate) hosts: Hosts,
    /// Read-only, bounded observability. It never participates in call control.
    pub(crate) debug: DebugBus,
    /// The call the debug page groups events under, while a page is on it.
    debug_call: std::sync::Mutex<Option<String>>,
    next_debug_call: AtomicU64,
    /// What routing reads about the call. Routing must never wait on the PBX
    /// lock: the turn worker holds it for a whole prompt, and an utterance
    /// routed only after the prompt ends can no longer steer it.
    pub(crate) routing: RoutingView,
    pub(crate) delivery: DeliveryState,
    pub transcript_log: Mutex<TranscriptLog>,
    pub speaker: Speaker,
    /// Call-scoped TTS stitching state. The synchronous lock keeps lifecycle
    /// clear/commit linearization short and lets the leg announcer share it.
    pub(crate) continuity: Arc<StdMutex<SpeechContinuity>>,
    /// The active model-turn group lets several `/speak` calls share one
    /// continuity chain without carrying that state in the host protocol.
    pub(crate) active_speech_group: Arc<StdMutex<Option<SpeechGroup>>>,
    pub(crate) next_speech_group: AtomicU64,
    /// Set after foreground audio is admitted. A floor release consumes it so
    /// only an immediate same-generation update can continue that clip.
    pub(crate) foreground_audio_generation: Arc<StdMutex<Option<u64>>>,
    pub stt: SttAdapter,
    pub stt_stream: SttStreamAdapter,
    pub events: broadcast::Sender<Event>,
    pub coordinator: Coordinator,
    /// Decides the pickers' redials without the PBX lock.
    redials: RedialPlanner,
    pub(crate) speech: mpsc::Sender<SpeechRequest>,
    pub(crate) speech_rx: Mutex<Option<mpsc::Receiver<SpeechRequest>>>,
    pub(crate) speech_worker_started: AtomicBool,
    pub(crate) clips: mpsc::Sender<Clip>,
    pub(crate) clip_rx: Mutex<Option<mpsc::Receiver<Clip>>>,
    pub turns: mpsc::Sender<(String, String, u64)>,
    pub(crate) turn_rx: Mutex<Option<mpsc::Receiver<(String, String, u64)>>>,
    pub accepted_clips: Mutex<(HashSet<String>, VecDeque<String>)>,
    /// The last word sent on each recent clip, replayed when it comes again.
    pub(crate) clip_verdicts: std::sync::Mutex<ClipVerdicts>,
    pub(crate) stream_clips: Mutex<HashMap<String, StreamClipState>>,
    pub last_display: Arc<Mutex<Option<Value>>>,
    pub screen_state: Mutex<Value>,
    pub display_gate: Arc<Mutex<DisplayGateState>>,
    pub display_confirm: watch::Sender<ConfirmState>,
    pub active_session: Arc<Mutex<Option<LegSession>>>,
    /// Last known state for resident project agents, including pending speak requests.
    pub(crate) projection: AgentProjection,
    /// One owner of queued background speech and its release order.
    pub(crate) floor: Floor,
    pub(crate) leg_announcer: LegAnnouncer,
    pub(crate) operation_transition: Mutex<()>,
    pub(crate) active_operations: Mutex<HashMap<TaskId, AbortHandle>>,
    /// Autonomous host turns admitted by the lifecycle, keyed by resident
    /// instance so a stale turn_end cannot finish a newer operation.
    pub(crate) autonomous_operations: Mutex<HashMap<u64, OperationIdentity>>,
    pub queued_turns: AtomicU64,
    pub turn_in_flight: AtomicBool,
    /// Decisions made before a queued turn reaches the PBX lock. Keeping the
    /// decision with the clip prevents a second Jev request while preserving
    /// steering for a turn that was already active.
    pub(crate) routed_decisions: Mutex<HashMap<String, RoutedDecision>>,
    shutdown: watch::Sender<bool>,
    pub(crate) audio: Mutex<AudioQueue>,
    pub(crate) speech_deadline: std::time::Duration,
}

impl AppState {
    pub async fn register_connection(&self) -> (DeliveryConnection, Vec<Value>, u64) {
        let mut gate = self.0.display_gate.lock().await;
        let connection = self.0.delivery.register();
        let epoch = connection.epoch;
        gate.active_epoch = Some(epoch);
        gate.screen_state["stale"] = json!(true);
        self.0.floor.set_page_connected(true).await;
        self.start_debug_call();
        *self.0.screen_state.lock().await = gate.screen_state.clone();
        let snapshot_actions = gate.projection.snapshot_actions();
        let watermark = gate.watermark;
        (connection, snapshot_actions, watermark)
    }

    pub async fn retire_connection(&self, epoch: u64) {
        {
            let mut gate = self.0.display_gate.lock().await;
            if gate.active_epoch == Some(epoch) || gate.active_epoch.is_none() {
                gate.active_epoch = None;
                gate.screen_state["stale"] = json!(true);
                *self.0.screen_state.lock().await = gate.screen_state.clone();
            }
        }
        self.0.delivery.retire(epoch);
        let connected = self.0.delivery.connected();
        self.0.floor.set_page_connected(connected).await;
        if !connected {
            self.end_debug_call("page_closed");
        }
    }

    /// Opens the debug page's call when a caller page connects to none.
    fn start_debug_call(&self) {
        let mut call = self
            .0
            .debug_call
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if call.is_some() {
            return;
        }
        let call_id = format!(
            "call-{}",
            self.0.next_debug_call.fetch_add(1, Ordering::Relaxed)
        );
        *call = Some(call_id.clone());
        self.0.debug.publish(DebugEvent::CallBoundary {
            phase: "started".into(),
            call_id,
            reason: None,
        });
    }

    /// Closes the debug page's call, if one is open.
    fn end_debug_call(&self, reason: &str) {
        let ended = self
            .0
            .debug_call
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(call_id) = ended {
            self.0.debug.publish(DebugEvent::CallBoundary {
                phase: "ended".into(),
                call_id,
                reason: Some(reason.to_owned()),
            });
        }
    }

    #[cfg(test)]
    pub fn new(
        switchboard: Switchboard,
        transcript_log: TranscriptLog,
        speaker: Speaker,
        stt: SttAdapter,
        stt_stream: SttStreamAdapter,
    ) -> Self {
        Self::new_with_debug(
            switchboard,
            transcript_log,
            speaker,
            stt,
            stt_stream,
            DebugBus::new(),
        )
    }

    pub fn new_with_debug(
        switchboard: Switchboard,
        transcript_log: TranscriptLog,
        speaker: Speaker,
        stt: SttAdapter,
        stt_stream: SttStreamAdapter,
        debug: DebugBus,
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
        let last_display = Arc::new(Mutex::new(None));
        let background_displays = Arc::new(StdMutex::new(HashMap::new()));
        let agent_states = Arc::new(StdMutex::new(Vec::new()));
        let projection = AgentProjection {
            states: agent_states.clone(),
            displays: background_displays.clone(),
        };
        let delivery = DeliveryState::new();
        let speech_deadline = speaker.speech_deadline;
        let mut coordinator = switchboard.coordinator();
        let display_gate = Arc::new(Mutex::new(DisplayGateState {
            projection: DisplayProjection::default(),
            screen_state: json!({
                "view": "auto",
                "pinned": false,
                "has_visual": false,
                "visual_kind": Value::Null,
                "object_ids": [],
                "title": "",
                "stale": false,
                "generation": 0,
            }),
            active_epoch: None,
            report_epoch: None,
            report_generation: None,
            scene_leg: None,
            watermark: 0,
        }));
        let (display_confirm_tx, _) = watch::channel(ConfirmState::default());
        let continuity = Arc::new(StdMutex::new(SpeechContinuity {
            generation: coordinator.generation(),
            model: coordinator.status().model.clone(),
            ..SpeechContinuity::default()
        }));
        let active_speech_group = Arc::new(StdMutex::new(None));
        let foreground_audio_generation = Arc::new(StdMutex::new(None));
        let leg_announcer = LegAnnouncer {
            coordinator: coordinator.clone(),
            events: events.clone(),
            delivery: delivery.clone(),
            display_gate: display_gate.clone(),
            display_confirm: display_confirm_tx.clone(),
            last_display: last_display.clone(),
            projection: projection.clone(),
            continuity: continuity.clone(),
            active_speech_group: active_speech_group.clone(),
            foreground_audio_generation: foreground_audio_generation.clone(),
        };
        let activity_announcer = leg_announcer.clone();
        let activity_callback: ActivityCallback = Arc::new(move |activity: Activity| {
            let announcer = activity_announcer.clone();
            Box::pin(async move { announcer.on_activity(activity).await })
        });
        let candidate_events = events.clone();
        let candidate_delivery = delivery.clone();
        coordinator.set_candidate_callback(Arc::new(
            move |notice: &crate::lifecycle::CandidateNotice| {
                // The callback fires under the coordinator's lock: publish
                // non-blockingly and never re-enter the coordinator here.
                let message = match notice.ended {
                    None => ServerMessage::Candidate {
                        route: notice.route.clone(),
                        generation: notice.generation,
                    },
                    Some(reason) => ServerMessage::CandidateCleared {
                        route: notice.route.clone(),
                        generation: notice.generation,
                        reason,
                    },
                };
                let event = Event::Json(message.to_value());
                let _ = candidate_events.send(event.clone());
                candidate_delivery.publish(event);
            },
        ));
        let route_announcer = leg_announcer.clone();
        let route_callback: RouteCallback = Arc::new(move || {
            let announcer = route_announcer.clone();
            Box::pin(async move { announcer.announce_route().await })
        });
        let floor = Floor::new(switchboard.floor_quiet_threshold()).with_debug(debug.clone());
        let active_session = switchboard.session_control();
        let redials = switchboard.redial_planner();
        let hosts = switchboard.hosts();
        hosts.set_debug_bus(debug.clone());
        let routing = switchboard.routing_view();
        let mut switchboard = switchboard;
        switchboard.set_activity_callback(Some(activity_callback));
        switchboard.set_route_callback(Some(route_callback));
        switchboard.set_debug_bus(debug.clone());
        Self(Arc::new_cyclic(|app: &std::sync::Weak<AppInner>| {
            let state_app = app.clone();
            let state_callback: AgentStateCallback = Arc::new(move |notice: AgentStateNotice| {
                let app = state_app.upgrade();
                Box::pin(async move {
                    if let Some(app) = app {
                        update_agent_state(&AppState(app), notice).await;
                    }
                })
            });
            switchboard.set_agent_state_callback(Some(state_callback));
            let closed_app = app.clone();
            let foreground_closed: crate::pbx::ForegroundClosedCallback = Arc::new(
                move |project: String, session_id: String, instance_id: u64| {
                    let app = closed_app.upgrade();
                    Box::pin(async move {
                        let Some(app) = app else { return };
                        // Never wait on the PBX from the host pump: a turn
                        // may hold the lock while this session's reply is
                        // being read. Retire it once the lock is free.
                        tokio::spawn(async move {
                            let state = AppState(app);
                            let retired = state
                                .0
                                .switchboard
                                .lock()
                                .await
                                .retire_closed_foreground(&project, &session_id, instance_id)
                                .await;
                            if retired {
                                publish_status(&state);
                            }
                        });
                    })
                },
            );
            switchboard.set_foreground_closed_callback(Some(foreground_closed));
            let turn_app = app.clone();
            let turn_callback: TurnCallback = Arc::new(move |turn: ProjectTurn| {
                let app = turn_app.upgrade();
                Box::pin(async move {
                    match app {
                        Some(app) => handle_project_turn(&AppState(app), turn).await,
                        None => false,
                    }
                })
            });
            switchboard.set_turn_callback(Some(turn_callback));
            // A project session's `speak`, `display` and `view` are answered
            // here, by the same code for every one of them.
            let app = app.clone();
            let module_callback: ModuleCallback = Arc::new(move |call: AgentCall| {
                let app = app.upgrade();
                Box::pin(async move {
                    match app {
                        Some(app) => module_call(&AppState(app), call).await,
                        None => json!({"status": "failed", "reason": "failed"}),
                    }
                })
            });
            switchboard.set_module_callback(Some(module_callback));
            AppInner {
                switchboard: Mutex::new(switchboard),
                hosts,
                debug,
                debug_call: std::sync::Mutex::new(None),
                next_debug_call: AtomicU64::new(1),
                routing,
                delivery,
                transcript_log: Mutex::new(transcript_log),
                speaker,
                continuity,
                active_speech_group,
                next_speech_group: AtomicU64::new(1),
                foreground_audio_generation,
                stt,
                stt_stream,
                events,
                coordinator,
                redials,
                speech,
                speech_rx: Mutex::new(Some(speech_rx)),
                speech_worker_started: AtomicBool::new(false),
                clips,
                clip_rx: Mutex::new(Some(clip_rx)),
                turns,
                turn_rx: Mutex::new(Some(turn_rx)),
                accepted_clips: Mutex::new((HashSet::new(), VecDeque::new())),
                clip_verdicts: std::sync::Mutex::new(ClipVerdicts::default()),
                stream_clips: Mutex::new(HashMap::new()),
                last_display,
                screen_state: Mutex::new(json!({
                    "view": "auto",
                    "pinned": false,
                    "has_visual": false,
                    "visual_kind": Value::Null,
                    "object_ids": [],
                    "title": "",
                    "stale": false,
                    "generation": 0,
                })),
                display_gate,
                display_confirm: display_confirm_tx,
                active_session,
                projection,
                floor,
                leg_announcer,
                operation_transition: Mutex::new(()),
                active_operations: Mutex::new(HashMap::new()),
                autonomous_operations: Mutex::new(HashMap::new()),
                queued_turns: AtomicU64::new(0),
                turn_in_flight: AtomicBool::new(false),
                routed_decisions: Mutex::new(HashMap::new()),
                shutdown,
                audio: Mutex::new(AudioQueue::new()),
                speech_deadline,
            }
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
            .route("/ws", get(ws))
            .route("/host", get(host_link))
            .with_state(self);
        if let Some(service) = static_dir {
            router.fallback_service(service)
        } else {
            router
        }
    }

    /// The optional read-only listener. It has no call controls and serves
    /// only the embedded debug page and its WebSocket.
    pub fn debug_router(&self) -> Router {
        let state = self.clone();
        crate::debug::router(
            self.0.debug.clone(),
            move || state.0.projection.snapshot(),
            self.0.shutdown.subscribe(),
        )
    }

    /// Wait for the same idempotent shutdown signal used by the main server.
    pub async fn wait_for_shutdown(self) {
        let mut shutdown = self.0.shutdown.subscribe();
        if *shutdown.borrow() {
            return;
        }
        let _ = shutdown.changed().await;
    }
}

pub fn spawn_workers(state: AppState) {
    ensure_speech_worker(&state);
    let stream_state = state.clone();
    tokio::spawn(async move {
        process_stream_results(stream_state).await;
    });
    let clip_state = state.clone();
    tokio::spawn(async move {
        process_clips(clip_state).await;
    });
    let turn_state = state.clone();
    tokio::spawn(async move {
        process_turns(turn_state).await;
    });
    spawn_floor_worker(state);
}
pub async fn shutdown(state: &AppState) {
    // Linearize shutdown before cancellation so late callbacks and deliveries
    // fail closed while the process resources are being reaped.
    if !state.0.coordinator.begin_shutdown() {
        return;
    }
    state.0.clear_continuity();
    interrupt_active_turn(state).await;
    // Ends the legs first: a project session is ended by a command on its
    // host's link, which has to be queued before the links close.
    state.0.switchboard.lock().await.shutdown().await;
    // Close upgraded WebSockets as well as the PBX children. Axum's graceful
    // shutdown waits for upgraded connections, so merely stopping the listener
    // can otherwise leave systemd waiting on a browser tab indefinitely.
    state.0.shutdown.send_replace(true);
    state.end_debug_call("shutdown");
    state.0.coordinator.finish_shutdown();
}
pub(crate) fn emit(state: &AppState, event: Event) -> bool {
    let browser_delivered = state.0.delivery.publish(event.clone());
    let _ = state.0.events.send(event);
    browser_delivered
}
pub(crate) fn emit_message(state: &AppState, message: ServerMessage) -> bool {
    emit(state, Event::Json(message.to_value()))
}
fn current_status(state: &AppState) -> Status {
    state.0.coordinator.status()
}
/// Settles the call (see `Coordinator::settle`) and tells the browser where
/// it is.
pub(crate) fn publish_status(state: &AppState) {
    emit_message(state, ServerMessage::Status(state.0.coordinator.settle()));
}
/// Settles the call a control rescued at `generation`, unless a newer rescue
/// has taken it over since; that one settles it instead.
async fn settle_if_current(state: &AppState, generation: u64) {
    let _transition = state.0.operation_transition.lock().await;
    if generation == state.0.coordinator.generation() {
        publish_status(state);
    }
}

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
pub(crate) async fn spawn_registered_operation<F, T>(
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
    // A page control's operation logs under the request that started it.
    let task = tokio::spawn(future.in_current_span());
    let abort = task.abort_handle();
    let id = abort.id();
    active.insert(id, abort);
    Some((task, id))
}
pub(crate) async fn clear_active_operation(state: &AppState, id: TaskId) {
    state.0.active_operations.lock().await.remove(&id);
}

async fn healthz(State(state): State<AppState>) -> impl IntoResponse {
    let status = current_status(&state);
    Json(
        json!({"status":"ok", "git":crate::GIT_SHA, "stt_configured":state.0.stt.command.is_some(), "stt_stream_configured":state.0.stt_stream.configured(), "elevenlabs_configured":state.0.speaker.configured(), "route":status.route, "model":status.model, "thinking":status.thinking, "model_swaps":status.model_swaps, "projects":status.projects, "hosts":state.0.hosts.status()}),
    )
}
/// The status message the page is sent, `type` included.
async fn status(State(state): State<AppState>) -> impl IntoResponse {
    Json(ServerMessage::Status(current_status(&state)).to_value())
}
async fn interrupt_active_turn(state: &AppState) -> Option<String> {
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
    reply: crate::pbx::Reply,
    generation: u64,
) -> Result<crate::pbx::Reply, Response> {
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
) -> Result<crate::pbx::Reply, Response>
where
    F: Future<Output = crate::pbx::Reply> + Send + 'static,
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
) -> Result<crate::pbx::Reply, Response>
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
async fn hangup(State(state): State<AppState>) -> impl IntoResponse {
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
struct Connect {
    project: String,
    #[serde(default)]
    intent: String,
}
#[tracing::instrument(name = "http", skip_all, fields(endpoint = "/connect"))]
async fn connect(
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
struct Thinking {
    level: String,
}
#[tracing::instrument(name = "http", skip_all, fields(endpoint = "/thinking"))]
async fn thinking(
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
struct Model {
    model: String,
}
#[tracing::instrument(name = "http", skip_all, fields(endpoint = "/model"))]
async fn model(
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
/// Updates the page projection for a resident project session. The PBX sends
/// lifecycle notices; waiting requests are kept until promotion or stop.
async fn update_agent_state(state: &AppState, notice: AgentStateNotice) {
    let agents = state.0.projection.notice(&notice);
    state.0.debug.publish(DebugEvent::AgentsState {
        agents: agents.clone(),
    });
    emit_message(state, ServerMessage::AgentsState { agents });
}

/// Settles a turn only if its stamped generation still owns the lifecycle.
/// The coordinator owns the check and projection mutation together; stale
/// replies cannot mark a replacement resident idle.
pub(crate) async fn update_agent_state_if_current(
    state: &AppState,
    generation: u64,
    notice: AgentStateNotice,
) -> bool {
    let Some(agents) = state
        .0
        .coordinator
        .with_generation(generation, || state.0.projection.notice(&notice))
    else {
        return false;
    };
    state.0.debug.publish(DebugEvent::AgentsState {
        agents: agents.clone(),
    });
    emit_message(state, ServerMessage::AgentsState { agents });
    true
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
    let reserved = match reserve_speech(&state, generation, WhenQueueFull::Refuse).await {
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

/// Records a background agent's request without speaking for it. The floor
/// slice consumes this state when the caller answers waiting.
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
    let Some(reason) = raw.get("reason").and_then(Value::as_str) else {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"detail":"reason is required"})),
        )
            .into_response();
    };
    if !matches!(reason, "finished" | "needs_decision" | "problem") {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"detail":"reason must be finished, needs_decision or problem"})),
        )
            .into_response();
    }
    let request = AgentRequest {
        message: message.to_owned(),
        reason: reason.to_owned(),
    };
    let generation = state.0.coordinator.generation();
    let context = recent_floor_context(&state.0.transcript_log.lock().await.entries());
    let Some((project, agents, held_display)) =
        state.0.coordinator.with_background(token, |project| {
            let project = project.to_owned();
            let held_display = state.0.projection.has_held_display(&project);
            let agents = state.0.projection.waiting(project.clone(), request.clone());
            (project, agents, held_display)
        })
    else {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"delivered":false,"reason":"not_on_call","detail":"this session is not a background call"})),
        )
            .into_response();
    };
    emit_message(&state, ServerMessage::AgentsState { agents });
    state
        .0
        .floor
        .enqueue(FloorRequest {
            floor_id: 0,
            project,
            token: token.to_owned(),
            generation,
            context,
            message: request.message,
            reason: request.reason,
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

    if state
        .0
        .coordinator
        .with_background(token, |project| {
            state
                .0
                .projection
                .hold_display(project.to_owned(), normalized_action.clone())
        })
        .is_some()
    {
        return Json(json!({
            "delivered": false,
            "accepted": true,
            "held": true,
            "reason": "caller_away",
            "detail": "the display is held, not on screen yet; it will appear when the caller brings this agent forward. Say it is ready, not that it is on screen"
        }))
        .into_response();
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

    let value = ServerMessage::Display {
        action: normalized_action.clone(),
        seq: None,
    }
    .to_value();
    let event = Event::Json(value.clone());
    let _ = state.0.events.send(event.clone());
    let (delivered, sequence) = state.0.delivery.publish_sequenced(event);

    gate.projection.apply(&normalized_action, sequence);
    gate.watermark = sequence;
    *state.0.last_display.lock().await = Some(value);
    drop(gate);

    if !delivered {
        tracing::info!(
            generation = permit_generation,
            sequence,
            "applied to the scene; no browser is connected to show it"
        );
        return Json(json!({"delivered": false, "reason": "no browser connected"})).into_response();
    }

    let mut confirm_rx = state.0.display_confirm.subscribe();
    let deadline = tokio::time::sleep(std::time::Duration::from_millis(
        DISPLAY_CONFIRM_DEADLINE_MS,
    ));
    tokio::pin!(deadline);
    loop {
        {
            let c = confirm_rx.borrow_and_update();
            if c.generation == permit_generation {
                if let Some((rseq, reason)) = &c.rejection {
                    if *rseq == sequence {
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
    let target = req.target.trim().to_ascii_lowercase();

    let gate = state.0.display_gate.lock().await;
    if let Err(refusal) = authority.recheck_at_the_screen(&state) {
        return refusal.into_response();
    }

    if target.is_empty() {
        let (has_visual, kind, title, object_ids) = gate.projection.summary();
        let view = gate
            .screen_state
            .get("view")
            .and_then(Value::as_str)
            .unwrap_or("auto")
            .to_string();
        let connected = state.0.delivery.connected();
        let confirm = state.0.display_confirm.borrow().clone();
        // Nothing is on screen, so there is nothing outstanding to confirm:
        // a fresh call or an emptied stage is trivially "confirmed" without
        // ever having heard from the browser in this generation.
        let confirmed = !has_visual
            || (confirm.generation == permit_generation
                && confirm.watermark.is_some_and(|w| w >= gate.watermark));
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
                "detail": "target must be one of: auto, visual, comms, system, theater"
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
/// is refused with the detail as its reason; anything else failed. The body
/// goes back as the `result`.
async fn module_reply(call: &str, response: Response) -> Value {
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), MAX_WEBSOCKET_MESSAGE_BYTES)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or_else(|| json!({}));
    let detail = body
        .get("detail")
        .or_else(|| body.get("reason"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let (outcome, reason) = if status.is_success() && body["delivered"] == true {
        ("delivered", None)
    } else if status.is_success() && body["accepted"] == true {
        ("accepted", None)
    } else if status.is_success() && call == "display" {
        ("accepted", detail)
    } else if body["delivered"] == false || status.is_success() || status.is_client_error() {
        ("refused", detail)
    } else {
        ("failed", detail)
    };
    let mut result = body;
    if outcome == "failed" {
        result["error"] = json!(reason.clone().unwrap_or_else(|| "failed".into()));
    }
    json!({"status": outcome, "reason": reason, "result": result})
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
/// A project host's link; `hosts.rs` owns it.
async fn host_link(State(state): State<AppState>, upgrade: WebSocketUpgrade) -> Response {
    state.0.hosts.accept(upgrade, state.0.shutdown.subscribe())
}
async fn ws(State(state): State<AppState>, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    upgrade
        .max_message_size(MAX_WEBSOCKET_MESSAGE_BYTES)
        .max_frame_size(MAX_WEBSOCKET_MESSAGE_BYTES)
        .on_upgrade(move |socket| websocket(socket, state))
}
async fn websocket(socket: WebSocket, state: AppState) {
    let (connection, snapshot_actions, watermark) = state.register_connection().await;
    // Two tabs are two connections. Everything one does, and the work it
    // starts, logs under its id and the generation it joined at.
    let span = tracing::info_span!(
        "ws",
        connection = connection.epoch,
        joined_generation = state.0.coordinator.generation()
    );
    serve_connection(socket, state, connection, snapshot_actions, watermark)
        .instrument(span)
        .await;
}

async fn serve_connection(
    socket: WebSocket,
    state: AppState,
    connection: DeliveryConnection,
    snapshot_actions: Vec<Value>,
    watermark: u64,
) {
    let epoch = connection.epoch;
    let connected_at = std::time::Instant::now();
    tracing::info!("browser connected");
    let (mut sink, mut incoming) = socket.split();
    let mut frames = connection.receiver;
    let writer_state = state.clone();
    let deliver = async move {
        send_snapshot_sink(&mut sink, &writer_state, &snapshot_actions, watermark).await?;
        while let Some(frame) = frames.recv().await {
            match frame {
                DeliveryFrame::Event { sequence, event } => {
                    if sequence <= watermark && is_display_event(&event) {
                        tracing::trace!(
                            sequence,
                            epoch,
                            "discarding replayed display event <= watermark"
                        );
                        continue;
                    }
                    tracing::trace!(sequence, epoch, "delivering sequenced event");
                    send_event_sink(&mut sink, stamp_display_seq(event, sequence)).await?
                }
                DeliveryFrame::Message(message) => sink.send(message).await?,
            }
        }
        Ok::<(), axum::Error>(())
    };
    let mut writer = Box::pin(tokio::spawn(deliver.in_current_span()));
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
    state.retire_connection(epoch).await;
    // The writer owns the only sink. Retiring first prevents new events from
    // being accepted while its final send is being canceled.
    writer.abort();
    tracing::info!(
        ?writer_id,
        connected_for = ?connected_at.elapsed(),
        "browser connection retired"
    );
}

/// What a connection is told before any live event: the epoch, the line's
/// status, and the conversation. The epoch is preceded by an `adopted`
/// candidate notice when the leg on the line was adopted at it, which a tab
/// that was away for the adoption needs in order to carry speech recorded
/// while that leg was connecting (#70). Without it, the tab cannot tell an
/// adoption from the hangup that moves the epoch the same way.
async fn snapshot_messages(state: &AppState) -> Vec<ServerMessage> {
    let mut messages = Vec::with_capacity(5);
    let (generation, adopted_route) = state.0.coordinator.generation_and_adoption();
    if let Some(route) = adopted_route {
        messages.push(ServerMessage::CandidateCleared {
            route,
            generation,
            reason: CandidateEnd::Adopted,
        });
    }
    messages.push(ServerMessage::Epoch { generation });
    messages.push(ServerMessage::Status(current_status(state)));
    messages.push(ServerMessage::History {
        entries: state.0.transcript_log.lock().await.entries(),
    });
    let agents = state.0.projection.snapshot();
    if !agents.is_empty() {
        messages.push(ServerMessage::AgentsState { agents });
    }
    messages
}

async fn send_snapshot_sink(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    state: &AppState,
    snapshot_actions: &[Value],
    watermark: u64,
) -> Result<(), axum::Error> {
    for message in snapshot_messages(state).await {
        send_event_sink(sink, Event::Json(message.to_value())).await?;
    }
    for action in snapshot_actions {
        let replay = ServerMessage::Display {
            action: action.clone(),
            seq: Some(watermark),
        };
        send_event_sink(sink, Event::Json(replay.to_value())).await?;
    }
    Ok(())
}

/// `screen_state`: the browser's report of what it is showing. Updates the
/// view the agent's `view` tool reads and confirms or rejects the display
/// actions the browser has applied.
async fn apply_screen_state(
    state: &AppState,
    epoch: u64,
    command: crate::protocol::ScreenState,
) -> Result<(), ()> {
    let Some(view) = command.view.filter(|view| {
        matches!(
            view.as_str(),
            "auto" | "system" | "visual" | "comms" | "theater"
        )
    }) else {
        return send_message(state, epoch, ServerMessage::error("Invalid screen view.")).await;
    };
    let title = command
        .title
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect::<String>();
    let visual_kind = command
        .visual_kind
        .filter(|kind| crate::visual_protocol::CONTENT_TYPES.contains(&kind.as_str()))
        .map_or(Value::Null, Value::String);
    let object_ids = command.object_ids.unwrap_or_default();
    let pinned = command.pinned.unwrap_or(false);
    let has_visual = command.has_visual.unwrap_or(false);
    let stale = command.stale.unwrap_or(false);
    let report_gen = command
        .generation
        .unwrap_or_else(|| state.0.coordinator.generation());

    let current_gen = state.0.coordinator.generation();
    let active_ep = state.0.delivery.active_epoch();
    if active_ep != Some(epoch) || report_gen != current_gen {
        return Ok(());
    }
    let mut gate = state.0.display_gate.lock().await;

    let report = json!({
        "view": view,
        "pinned": pinned,
        "has_visual": has_visual,
        "visual_kind": visual_kind,
        "object_ids": object_ids,
        "title": title,
        "stale": stale,
        "generation": current_gen,
    });
    gate.screen_state = report.clone();
    gate.report_epoch = Some(epoch);
    gate.report_generation = Some(current_gen);
    *state.0.screen_state.lock().await = report;
    drop(gate);

    let applied_seq = command.applied_seq;
    let rejected = command.rejected.map(|rejection| {
        let reason = rejection
            .reason
            .unwrap_or_else(|| "the caller's screen could not render it".to_string());
        (rejection.seq, reason)
    });
    state.0.display_confirm.send_modify(|c| {
        if c.generation != current_gen {
            c.generation = current_gen;
            c.watermark = None;
        }
        if let Some(seq) = applied_seq {
            if c.watermark.is_none_or(|w| seq > w) {
                c.watermark = Some(seq);
            }
        }
        c.rejection = rejected.clone();
    });

    send_message(state, epoch, ServerMessage::ScreenStateAck).await
}

pub(crate) async fn handle_text_frame(
    state: &AppState,
    epoch: u64,
    pending_header: &mut Option<ClipHeader>,
    pending_stream_chunk: &mut Option<StreamChunkHeader>,
    text: &str,
) -> Result<(), ()> {
    use crate::protocol::{ClientMessage, UnreadableFrame};
    let command = match ClientMessage::parse(text) {
        Ok(command) => command,
        Err(unreadable) => {
            let message = match unreadable {
                UnreadableFrame::NotJson => "Invalid JSON frame.",
                UnreadableFrame::NotAnObject => "Invalid command shape.",
                UnreadableFrame::UnknownType => "Unknown websocket command.",
            };
            return send_message(state, epoch, ServerMessage::error(message)).await;
        }
    };

    match command {
        ClientMessage::Hello {
            version,
            capabilities,
        } => {
            let version = version.unwrap_or(0);
            let stream_requested = capabilities
                .as_ref()
                .and_then(|caps| caps.stt_streaming)
                .unwrap_or(false);
            let mse_requested = capabilities
                .as_ref()
                .and_then(|caps| caps.mse_mp3)
                .unwrap_or(false);
            let audio_requested = capabilities
                .as_ref()
                .and_then(|caps| caps.audio_streaming)
                .unwrap_or(false);
            let mse_selected = version == 1 && mse_requested;
            send_message(
                state,
                epoch,
                ServerMessage::HelloAck {
                    version: 1,
                    stt_streaming: version == 1
                        && stream_requested
                        && state.0.stt_stream.configured(),
                    // Speech is streamed only as MSE mp3, so streaming is
                    // offered to a page that asked for it and can play that.
                    audio_streaming: mse_selected && audio_requested,
                    mse_mp3: mse_selected,
                },
            )
            .await
        }
        ClientMessage::SttStart {
            clip_id,
            generation,
            mime,
        } => {
            pending_header.take();
            start_stream_clip(state, epoch, clip_id, generation, mime).await
        }
        ClientMessage::SttChunk {
            clip_id,
            generation,
            sequence,
        } => {
            let Some(id) = clip_id.filter(|id| !id.is_empty() && id.len() <= 128) else {
                return send_message(
                    state,
                    epoch,
                    ServerMessage::error("Invalid streaming clip id."),
                )
                .await;
            };
            let generation = generation.unwrap_or(0);
            let sequence = sequence.unwrap_or(u64::MAX);
            *pending_stream_chunk = Some((id, generation, sequence));
            Ok(())
        }
        ClientMessage::SttEnd {
            clip_id,
            generation,
        } => {
            let Some(id) = clip_id.as_deref() else {
                return Ok(());
            };
            let generation = generation.unwrap_or(0);
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
                    return send_message(
                        state,
                        epoch,
                        ServerMessage::Abandoned {
                            id: id.to_owned(),
                            reason: reason.into(),
                        },
                    )
                    .await;
                }
            }
            Ok(())
        }
        ClientMessage::SttCancel {
            clip_id,
            generation,
        } => {
            let Some(id) = clip_id.as_deref() else {
                return Ok(());
            };
            let generation = generation.unwrap_or(0);
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
        ClientMessage::ScreenState(report) => apply_screen_state(state, epoch, report).await,
        ClientMessage::Ping { nonce, time } => {
            send_message(state, epoch, ServerMessage::Pong { nonce, time }).await
        }
        ClientMessage::TypedTurn {
            id,
            generation,
            text,
        } => {
            let Some((turn, generation, text)) =
                parse_typed_turn(id.as_deref(), generation, text.as_deref())
            else {
                return send_message(
                    state,
                    epoch,
                    ServerMessage::Error {
                        id,
                        code: None,
                        message: "That message could not be sent.".into(),
                    },
                )
                .await;
            };
            tracing::info!(turn = %turn, generation, chars = text.chars().count(), "typed turn");
            // A typed turn is a transcript that needs no transcription, so it
            // takes the same path as a streamed one: epoch check, log, echo,
            // then steer or queue. It runs off this reader because that path
            // waits on `operation_transition`, which a transfer can hold for
            // seconds, and the reader must keep answering pings meanwhile.
            let state = state.clone();
            tokio::spawn(
                async move { route_final_transcript(&state, &turn, generation, text).await }
                    .in_current_span(),
            );
            Ok(())
        }
        ClientMessage::Clip {
            id,
            mime,
            generation,
        } => {
            let Some(header) = parse_clip_header(id, mime, generation) else {
                pending_header.take();
                return send_message(state, epoch, ServerMessage::error("Invalid clip id.")).await;
            };
            *pending_header = Some(header);
            Ok(())
        }
    }
}

pub(crate) async fn send_message(
    state: &AppState,
    epoch: u64,
    message: ServerMessage,
) -> Result<(), ()> {
    state
        .0
        .delivery
        .send(epoch, Message::Text(message.to_value().to_string().into()))
        .then_some(())
        .ok_or(())
}
async fn send_event_sink(
    socket: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    event: Event,
) -> Result<(), axum::Error> {
    match event {
        Event::Json(value) => socket.send(Message::Text(value.to_string().into())).await,
        Event::AudioStart {
            generation,
            sequence,
            mime,
            format,
        } => {
            let message = ServerMessage::AudioStart {
                generation,
                sequence,
                mime,
                format,
            };
            socket
                .send(Message::Text(message.to_value().to_string().into()))
                .await
        }
        Event::AudioChunk { audio } => socket.send(Message::Binary(audio.into())).await,
        Event::AudioDone {
            generation,
            sequence,
        } => {
            let message = ServerMessage::AudioDone {
                generation,
                sequence,
                done: true,
            };
            socket
                .send(Message::Text(message.to_value().to_string().into()))
                .await
        }
    }
}

#[cfg(test)]
pub(crate) fn state() -> AppState {
    state_with_stt(None)
}

#[cfg(test)]
pub(crate) fn state_with_stt(stt: Option<String>) -> AppState {
    state_with_stream(stt, None)
}

#[cfg(test)]
pub(crate) fn state_with_stream(stt: Option<String>, stream: Option<String>) -> AppState {
    let config = crate::Config::for_tests(&[]);
    let registry = Registry::new(vec![]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("no projects are registered"),
    );
    let board = Switchboard::new(&config, registry, std::sync::Arc::new(prewarm));
    state_on_with_stream(board, stt, stream)
}

#[cfg(test)]
pub(crate) fn state_on_with_stream(
    board: Switchboard,
    stt: Option<String>,
    stream: Option<String>,
) -> AppState {
    AppState::new(
        board,
        TranscriptLog::new(10),
        Speaker::offline(100, std::time::Duration::from_millis(25_000)),
        SttAdapter::from_command(stt),
        SttStreamAdapter::from_command(stream),
    )
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
pub(crate) fn begin_alpha_candidate(state: &AppState, token: &str) {
    state
        .0
        .coordinator
        .begin_candidate(crate::lifecycle::CandidateLeg::new(
            "alpha",
            "alpha",
            "pi-session",
            token,
            "anthropic/opus",
            "medium",
        ))
        .unwrap();
}

/// A delivery frame as the browser would read it; display frames carry the
/// sequence the socket writer stamps on them.
#[cfg(test)]
pub(crate) fn frame_json(frame: DeliveryFrame) -> Option<Value> {
    match frame {
        DeliveryFrame::Event { sequence, event } => match stamp_display_seq(event, sequence) {
            Event::Json(value) => Some(value),
            _ => None,
        },
        DeliveryFrame::Message(Message::Text(text)) => Some(serde_json::from_str(&text).unwrap()),
        DeliveryFrame::Message(_) => None,
    }
}

/// Receives frames up to and including the first of type `until`.
#[cfg(test)]
pub(crate) async fn frames_until(connection: &mut DeliveryConnection, until: &str) -> Vec<Value> {
    let mut frames = Vec::new();
    loop {
        let frame = timeout(Duration::from_secs(2), connection.receiver.recv())
            .await
            .expect("a frame before the deadline")
            .expect("an open connection");
        let Some(value) = frame_json(frame) else {
            continue;
        };
        let done = value["type"] == until;
        frames.push(value);
        if done {
            return frames;
        }
    }
}

/// Every frame already waiting on the connection.
#[cfg(test)]
pub(crate) fn queued_frames(connection: &mut DeliveryConnection) -> Vec<Value> {
    std::iter::from_fn(|| connection.receiver.try_recv().ok())
        .filter_map(frame_json)
        .collect()
}

#[cfg(test)]
pub(crate) fn types_of(frames: &[Value]) -> Vec<&str> {
    frames
        .iter()
        .filter_map(|frame| frame["type"].as_str())
        .collect()
}

/// The application around `board`, with no speech-to-text configured.
#[cfg(test)]
pub(crate) fn state_on(board: Switchboard) -> AppState {
    let state = state_on_with_stream(board, None, None);
    // Most API tests exercise direct delivery rather than the production
    // bootstrap. Keep the one worker lifecycle in the shared setup helper.
    if tokio::runtime::Handle::try_current().is_ok() {
        start_speech_worker_for_test(&state);
    }
    state
}

/// Test-only lifecycle oracle. It checks the projections together rather
/// than asserting a single event, so every failure path can use the same
/// consistency contract.
#[cfg(test)]
pub(crate) async fn assert_lifecycle_consistent(state: &AppState) {
    let agents = state.0.projection.states.lock().unwrap().clone();
    let displays = state.0.projection.displays.lock().unwrap().clone();
    let route = state.0.coordinator.route();
    let board = state.0.switchboard.lock().await;
    for agent in &agents {
        if agent.state == "busy" {
            let in_flight = if agent.project == route {
                board.foreground_busy_for_test(&agent.project)
            } else {
                board
                    .residents_for_test()
                    .into_iter()
                    .find(|(project, _, _)| project == &agent.project)
                    .is_some_and(|(_, alive, busy)| alive && busy)
            };
            assert!(in_flight, "busy agent has no in-flight turn: {:?}", agent);
        }
        assert_eq!(
            agent.pending_request.is_some(),
            agent.state == "waiting",
            "waiting state and request must agree: {:?}",
            agent
        );
    }
    for project in displays.keys() {
        let resident = board
            .residents_for_test()
            .into_iter()
            .find(|(name, _, _)| name == project)
            .expect("held display belongs to a resident");
        assert!(resident.1, "held display belongs to a dead resident");
    }
    if route != OPERATOR {
        let foreground = agents.iter().find(|agent| agent.project == route);
        assert!(foreground.is_none_or(|agent| agent.pending_request.is_none()));
        assert!(!displays.contains_key(&route));
    }
    for (project, alive, _) in board.residents_for_test() {
        assert!(alive, "dead resident remains in registry: {project}");
        assert!(board.coordinator().project_is_background(&project));
    }
}

/// The debug events published so far, oldest first.
#[cfg(test)]
pub(crate) fn debug_events(state: &AppState) -> Vec<crate::debug::DebugEvent> {
    state.0.debug.events_for_test()
}

/// Waits for the first debug event `want` accepts.
#[cfg(test)]
pub(crate) async fn until_debug(
    state: &AppState,
    want: impl Fn(&crate::debug::DebugEvent) -> bool,
) -> crate::debug::DebugEvent {
    for _ in 0..2_000 {
        if let Some(event) = debug_events(state).into_iter().find(|event| want(event)) {
            return event;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("no such debug event: {:?}", debug_events(state));
}

#[cfg(test)]
pub(crate) async fn next_delivery(connection: &mut DeliveryConnection) -> Value {
    let Some(DeliveryFrame::Message(Message::Text(text))) = connection.receiver.recv().await else {
        panic!("expected a websocket response");
    };
    serde_json::from_str(&text).unwrap()
}

#[cfg(test)]
pub(crate) async fn next_event_of(
    events: &mut broadcast::Receiver<Event>,
    event_type: &str,
) -> Value {
    timeout(Duration::from_secs(1), async {
        loop {
            if let Ok(Event::Json(value)) = events.recv().await {
                if value["type"] == event_type {
                    return value;
                }
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no {event_type} event"))
}

#[cfg(test)]
#[cfg(unix)]
pub(crate) fn scratch_root(label: &str) -> std::path::PathBuf {
    let root =
        std::env::temp_dir().join(format!("switchboard-{label}-{}", crate::pbx::uuid_like()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

#[cfg(test)]
#[cfg(unix)]
pub(crate) fn answering_agent(
    root: &std::path::Path,
    name: &str,
    reply: &str,
) -> std::path::PathBuf {
    let path = root.join(name);
    crate::pi_client::write_executable_script(
        &path,
        &format!(
            r#"while IFS= read -r line; do
  printf '%s\n' '{{"type":"message_update","assistantMessageEvent":{{"type":"text_end","content":"{reply}"}}}}'
  printf '%s\n' '{{"type":"agent_settled"}}'
done
"#
        ),
    );
    path
}

/// An app whose operator is a pi stand-in under `root`, and whose one
/// project, alpha, runs on host scriptorium, where a fake host agent answers
/// every prompt "Alpha here.".
#[cfg(test)]
#[cfg(unix)]
pub(crate) fn state_with_agents(root: &std::path::Path) -> AppState {
    state_with_agents_speaker(
        root,
        Speaker::offline(100, std::time::Duration::from_millis(25_000)),
    )
}

#[cfg(test)]
pub(crate) fn state_with_agents_speaker(root: &std::path::Path, speaker: Speaker) -> AppState {
    state_with_agents_options(root, speaker, false)
}

#[cfg(test)]
pub(crate) fn state_with_agents_options(
    root: &std::path::Path,
    speaker: Speaker,
    speaks_during_turn: bool,
) -> AppState {
    let operator = answering_agent(root, "fake-operator", "Operator here.");
    let config =
        crate::Config::for_tests(&[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())]);
    let registry = Registry::new(vec![serde_json::from_value(json!({
        "id": "alpha",
        "host": "scriptorium",
        "cwd": root.to_string_lossy(),
        "model": "anthropic/current",
    }))
    .unwrap()]);
    let catalog = crate::models::ModelCatalog {
        entries: vec![crate::models::CatalogEntry {
            provider: "anthropic".into(),
            model: "current".into(),
            thinks: true,
        }],
        available: true,
        diagnostic: None,
    };
    let prewarm = crate::prewarm::Prewarm::settled(&config, &registry, catalog);
    FakeHostAgent::new(Box::new(move |_, _| {
        let mut steps = Vec::new();
        if speaks_during_turn {
            steps.push(Step::Call("speak", json!({"text":"Foreground answer"})));
        }
        steps.push(Step::Event(json!({"kind":"text","text":"Alpha here."})));
        steps
    }))
    .serve(prewarm.hosts().connect_fake("scriptorium"));
    let state = AppState::new(
        Switchboard::new(&config, registry, std::sync::Arc::new(prewarm)),
        TranscriptLog::new(10),
        speaker,
        SttAdapter::from_command(None),
        SttStreamAdapter::from_command(None),
    );
    if tokio::runtime::Handle::try_current().is_ok() {
        start_speech_worker_for_test(&state);
    }
    state
}

#[cfg(test)]
pub(crate) fn catalog_of(models: &[&str]) -> crate::models::ModelCatalog {
    crate::models::ModelCatalog {
        entries: models
            .iter()
            .map(|model| crate::models::CatalogEntry {
                provider: "anthropic".into(),
                model: (*model).into(),
                thinks: true,
            })
            .collect(),
        available: true,
        diagnostic: None,
    }
}

/// A call on alpha (as `state_with_agents`) whose utterances Jev routes as
/// `continue`, and the log of `host`, alpha's host agent.
#[cfg(test)]
#[cfg(unix)]
pub(crate) fn state_with_agents_and_jev(
    root: &std::path::Path,
    host: FakeHostAgent,
) -> (AppState, FakeLog) {
    let (client, _requests, _responded) = fake_jev_client();
    let operator = answering_agent(root, "fake-operator", "Operator here.");
    let config =
        crate::Config::for_tests(&[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())]);
    let registry = Registry::new(vec![serde_json::from_value(json!({
        "id": "alpha",
        "host": "scriptorium",
        "cwd": root.to_string_lossy(),
        "model": "anthropic/current",
    }))
    .unwrap()]);
    let prewarm = crate::prewarm::Prewarm::settled(&config, &registry, catalog_of(&["current"]));
    let log = host.serve(prewarm.hosts().connect_fake("scriptorium"));
    let state = state_on(Switchboard::new_with_jev(
        &config,
        registry,
        std::sync::Arc::new(prewarm),
        client,
    ));
    (state, log)
}

#[cfg(test)]
#[path = "../tests/test_api.rs"]
mod tests;

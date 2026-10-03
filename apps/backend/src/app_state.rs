//! The application state every handler and worker shares: `AppState` and
//! the `AppInner` it wraps, how it is built (the callbacks it installs into
//! the PBX and the coordinator), the workers it starts, shutdown, the event
//! fan-out, the operation registry rescues abort, and the projection of
//! resident agents.
use crate::audio::{Speaker, SttAdapter, SttStreamAdapter};
use crate::caller_input::{process_clips, process_stream_results, ClipState};
use crate::debug::{DebugBus, DebugEvent};
use crate::delivery::{AudioQueue, DeliveryState, Event};
use crate::display::{ConfirmState, DisplayGateState, DisplayProjection};
use crate::floor::Floor;
use crate::history::TranscriptLog;
use crate::hosts::Hosts;
#[cfg(test)]
use crate::hosts::{FakeHostAgent, FakeLog, Step};
#[cfg(test)]
use crate::jev::fake_jev_client;
use crate::leg_announcer::LegAnnouncer;
use crate::lifecycle::Coordinator;
use crate::module_calls::module_call;
use crate::page_controls::interrupt_active_turn;
#[cfg(test)]
use crate::pbx::OPERATOR;
use crate::pbx::{AgentStateCallback, AgentStateNotice, RouteCallback, Switchboard};
use crate::pi_client::{
    Activity, ActivityCallback, AgentCall, LegSession, ModuleCallback, ProjectTurn, TurnCallback,
};
use crate::protocol::{AgentRequest, AgentState, ServerMessage};
use crate::redial::RedialPlanner;
#[cfg(test)]
use crate::registry::Registry;
#[cfg(test)]
use crate::speech::start_speech_worker_for_test;
use crate::speech::{
    ensure_speech_worker, spawn_floor_worker, SpeechContinuity, SpeechGroup, SpeechQueue,
};
use crate::turns::{handle_project_turn, process_turns, TurnState};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
#[cfg(test)]
use tokio::sync::oneshot;
use tokio::sync::{broadcast, watch, Mutex};
use tokio::task::{AbortHandle, Id as TaskId, JoinHandle};
#[cfg(test)]
use tokio::time::{timeout, Duration};
use tracing::Instrument;

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
    pub(crate) displays: Arc<StdMutex<HashMap<String, Value>>>,
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

    pub(crate) fn waiting(&self, project: String, request: AgentRequest) -> Vec<AgentState> {
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
    /// Queued caller turns, their routing decisions, and the autonomous
    /// turns in flight: the state only `turns.rs` reads.
    pub(crate) turns: TurnState,
    pub(crate) delivery: DeliveryState,
    pub transcript_log: Mutex<TranscriptLog>,
    pub speaker: Speaker,
    /// Call-scoped TTS stitching state. The synchronous lock keeps lifecycle
    /// clear/commit linearization short and lets the leg announcer share it.
    pub(crate) continuity: Arc<StdMutex<SpeechContinuity>>,
    /// The active model-turn group lets several `/speak` calls share one
    /// continuity chain without carrying that state in the host protocol.
    pub(crate) active_speech_group: Arc<StdMutex<Option<SpeechGroup>>>,
    /// Set after foreground audio is admitted. A floor release consumes it so
    /// only an immediate same-generation update can continue that clip.
    pub(crate) foreground_audio_generation: Arc<StdMutex<Option<u64>>>,
    pub stt: SttAdapter,
    pub stt_stream: SttStreamAdapter,
    pub events: broadcast::Sender<Event>,
    pub coordinator: Coordinator,
    /// Decides the pickers' redials without the PBX lock.
    pub(crate) redials: RedialPlanner,
    /// The speech worker's queue and the state only `speech.rs` reads.
    pub(crate) speech: SpeechQueue,
    /// Caller audio clips and the state only `caller_input.rs` reads.
    pub(crate) clips: ClipState,
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
    pub queued_turns: AtomicU64,
    pub turn_in_flight: AtomicBool,
    pub(crate) shutdown: watch::Sender<bool>,
    pub(crate) audio: Mutex<AudioQueue>,
    pub(crate) speech_deadline: std::time::Duration,
}

impl AppState {
    /// Opens the debug page's call when a caller page connects to none.
    pub(crate) fn start_debug_call(&self) {
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
    pub(crate) fn end_debug_call(&self, reason: &str) {
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
        let speech = SpeechQueue::new();
        let clips = ClipState::new();
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
        let turns = TurnState::new(switchboard.routing_view());
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
                delivery,
                transcript_log: Mutex::new(transcript_log),
                speaker,
                continuity,
                active_speech_group,
                foreground_audio_generation,
                stt,
                stt_stream,
                events,
                coordinator,
                redials,
                speech,
                clips,
                turns,
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
                queued_turns: AtomicU64::new(0),
                turn_in_flight: AtomicBool::new(false),
                shutdown,
                audio: Mutex::new(AudioQueue::new()),
                speech_deadline,
            }
        }))
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
/// Settles the call (see `Coordinator::settle`) and tells the browser where
/// it is.
pub(crate) fn publish_status(state: &AppState) {
    emit_message(state, ServerMessage::Status(state.0.coordinator.settle()));
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

/// Updates the page projection for a resident project session. The PBX sends
/// lifecycle notices; waiting requests are kept until promotion or stop.
pub(crate) async fn update_agent_state(state: &AppState, notice: AgentStateNotice) {
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
fn state_on_with_stream(
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
fn answering_agent(root: &std::path::Path, name: &str, reply: &str) -> std::path::PathBuf {
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
fn state_with_agents_speaker(root: &std::path::Path, speaker: Speaker) -> AppState {
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
pub(crate) async fn hold_turn_lock(state: &AppState, signal: Option<oneshot::Sender<()>>) {
    let guard = state.0.switchboard.lock().await;
    if let Some(tx) = signal {
        let _ = tx.send(());
    }
    futures_util::future::poll_fn(move |_cx| {
        let _keep = &guard;
        std::task::Poll::Pending::<()>
    })
    .await;
}

#[cfg(test)]
#[path = "../tests/test_app_state.rs"]
mod tests;

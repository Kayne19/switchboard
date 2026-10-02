//! Read-only observability for the debug page.
//!
//! The debug bus is deliberately independent from call control. Publishing is
//! synchronous and bounded: it records a small in-memory copy and uses
//! `broadcast::Sender::send`, so a slow browser can never hold up a call.
use crate::protocol::AgentState;
use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    http::header,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
#[cfg(test)]
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::{
    cell::Cell,
    collections::VecDeque,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{broadcast, watch},
    time::{timeout, Duration},
};
use tracing_subscriber::{layer::Context, registry::LookupSpan, Layer};

/// The compiled debug page. It is embedded at build time so it is served only
/// by the debug listener's router: the primary listener's static directory
/// never holds it, so no path spelling there can reach it.
pub(crate) const INDEX_HTML: &str = include_str!("../../../static-debug/index.html");
pub(crate) const DEBUG_JS: &str = include_str!("../../../static-debug/debug.js");
pub(crate) const DEBUG_CSS: &str = include_str!("../../../static-debug/debug.css");

/// What the debug listener's routes share.
#[derive(Clone)]
struct Site {
    bus: DebugBus,
    agents: Arc<dyn Fn() -> Vec<AgentState> + Send + Sync>,
    shutdown: watch::Receiver<bool>,
}

/// The debug listener's whole router: the embedded page and the read-only
/// WebSocket. `agents` reads the current agent projection for snapshots;
/// `shutdown` is the service's shutdown signal.
pub(crate) fn router(
    bus: DebugBus,
    agents: impl Fn() -> Vec<AgentState> + Send + Sync + 'static,
    shutdown: watch::Receiver<bool>,
) -> Router {
    asset_routes().route("/ws", get(ws)).with_state(Site {
        bus,
        agents: Arc::new(agents),
        shutdown,
    })
}

/// The debug page's asset routes. Anything else is a 404.
fn asset_routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    fn asset(content_type: &'static str, body: &'static str) -> Response {
        (
            [
                (header::CONTENT_TYPE, content_type),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            body,
        )
            .into_response()
    }
    Router::new()
        .route(
            "/",
            get(|| async { asset("text/html; charset=utf-8", INDEX_HTML) }),
        )
        .route(
            "/debug.js",
            get(|| async { asset("text/javascript; charset=utf-8", DEBUG_JS) }),
        )
        .route(
            "/debug.css",
            get(|| async { asset("text/css; charset=utf-8", DEBUG_CSS) }),
        )
}

const EVENT_CAPACITY: usize = 4_000;
const LOG_CAPACITY: usize = 2_000;
const LIVE_CAPACITY: usize = 256;
/// Bounds on one record, so a single event (a long prompt, a large tool
/// result) cannot grow the rings by more than a few kilobytes.
const MAX_FIELD_BYTES: usize = 4 * 1024;
const MAX_RECORD_BYTES: usize = 16 * 1024;
const MAX_JSON_ITEMS: usize = 64;
const CLIP_MARKER: &str = "…[clipped]";
/// A debug client that does not take a frame within this time is dropped; it
/// can reconnect and get a fresh snapshot.
const SEND_TIMEOUT: Duration = Duration::from_secs(5);

/// One event in the debug page's immutable event stream. This is the schema
/// shared with `apps/frontend/src/debug/protocol.ts` and its fixture.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum DebugEvent {
    CallerUtterance {
        utterance_id: String,
        text: String,
        talking_to: String,
    },
    JevRequest {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        utterance_id: Option<String>,
        purpose: String,
        state: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        floor_id: Option<String>,
    },
    JevResponse {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        utterance_id: Option<String>,
        purpose: String,
        latency_ms: u64,
        outcome: String,
        answers: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        floor_id: Option<String>,
    },
    RouteDecision {
        utterance_id: String,
        rule: String,
        reason: String,
        action: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        mode: String,
        decided_by: String,
    },
    PbxBranch {
        utterance_id: String,
        branch: String,
        reason: String,
    },
    UtilityRequest {
        utterance_id: String,
        attempt: String,
        prompt: String,
    },
    UtilityDecision {
        utterance_id: String,
        attempt: String,
        decision: Value,
        latency_ms: u64,
    },
    OperatorHop {
        utterance_id: String,
        text: String,
        outcome: String,
    },
    OperatorRouteTool {
        utterance_id: String,
        target: String,
        mode: String,
        action: String,
    },
    Routed {
        utterance_id: String,
        to_agent: String,
        text_part: String,
        mode: String,
        via: String,
    },
    AgentInput {
        agent: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        text: String,
        source: String,
        /// The caller line this input carries, when routing sent one here.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        utterance_id: Option<String>,
    },
    AgentText {
        agent: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        text: String,
        #[serde(rename = "final")]
        final_: bool,
    },
    ToolStart {
        agent: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        tool: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    ToolEnd {
        agent: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        tool: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    ModuleCall {
        agent: String,
        call_id: String,
        name: String,
        args: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
    },
    ModuleResult {
        agent: String,
        call_id: String,
        ok: bool,
        detail: Value,
    },
    TurnStart {
        agent: String,
        turn_id: String,
        generation: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        utterance_id: Option<String>,
    },
    TurnEnd {
        agent: String,
        turn_id: String,
        generation: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        utterance_id: Option<String>,
    },
    Rescue {
        generation: u64,
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        leg: Option<String>,
    },
    Speech {
        agent: String,
        text: String,
        delivered: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        floor_id: Option<String>,
    },
    FloorRequest {
        agent: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        floor_id: Option<String>,
    },
    FloorHeld {
        agent: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        floor_id: Option<String>,
    },
    FloorGate {
        agent: String,
        answer: String,
        latency_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        floor_id: Option<String>,
    },
    FloorRewrite {
        agent: String,
        original: String,
        rewritten: String,
        latency_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        floor_id: Option<String>,
    },
    FloorReleased {
        agent: String,
        how: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        floor_id: Option<String>,
    },
    AgentsState {
        agents: Vec<AgentState>,
    },
    HostLink {
        host: String,
        connected: bool,
    },
    /// One call's start or end. Every event between a `started` and the
    /// `ended` with the same `call_id` belongs to that call.
    CallBoundary {
        phase: String,
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

/// A numbered event retained in the ring and sent to a live client.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
pub(crate) struct DebugRecord {
    pub seq: u64,
    pub timestamp_ms: u64,
    /// True when a field was shortened to the record bounds.
    #[serde(default, skip_serializing_if = "is_false")]
    pub clipped: bool,
    #[serde(flatten)]
    pub event: DebugEvent,
}

/// One captured tracing line. Logs have their own ring and do not evict event
/// history, but share the sequence space so a client can order both streams.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
pub(crate) struct DebugLog {
    pub seq: u64,
    pub timestamp_ms: u64,
    pub level: String,
    pub target: String,
    pub message: String,
    pub fields: Value,
    /// True when the message or a field was shortened to the record bounds.
    #[serde(default, skip_serializing_if = "is_false")]
    pub clipped: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Makes one record safe for the debug page, before it takes the publish
/// lock. Every text field and JSON string goes through `scrub_text`, a JSON
/// string under a credential-like name (`secret_name`) becomes `[redacted]`,
/// and then strings and JSON values are shortened to the record bounds, with
/// each cut marked. This is the only place debug records are scrubbed or
/// clipped; producers publish raw values.
struct Clip {
    remaining: usize,
    clipped: bool,
}

impl Clip {
    fn new() -> Self {
        Self {
            remaining: MAX_RECORD_BYTES,
            clipped: false,
        }
    }

    fn spend(&mut self, bytes: usize) {
        self.remaining = self.remaining.saturating_sub(bytes.max(1));
    }

    fn text(&mut self, text: &mut String) {
        *text = scrub_text(text);
        let limit = MAX_FIELD_BYTES.min(self.remaining);
        if text.len() > limit {
            let mut cut = limit;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            text.push_str(CLIP_MARKER);
            self.clipped = true;
        }
        self.spend(text.len());
    }

    fn json(&mut self, value: &mut Value) {
        match value {
            Value::String(text) => self.text(text),
            Value::Array(items) => {
                let mut kept = 0;
                for item in items.iter_mut() {
                    if self.remaining == 0 || kept == MAX_JSON_ITEMS {
                        break;
                    }
                    self.json(item);
                    kept += 1;
                }
                if kept < items.len() {
                    let dropped = items.len() - kept;
                    items.truncate(kept);
                    items.push(Value::String(format!("{CLIP_MARKER} {dropped} more")));
                    self.clipped = true;
                }
            }
            Value::Object(map) => {
                let mut kept = 0;
                let mut dropped = 0;
                map.retain(|key, value| {
                    if self.remaining == 0 || kept == MAX_JSON_ITEMS {
                        dropped += 1;
                        return false;
                    }
                    self.spend(key.len());
                    if value.is_string() && secret_name(key) {
                        *value = Value::String(REDACTED.to_owned());
                    }
                    self.json(value);
                    kept += 1;
                    true
                });
                if dropped > 0 {
                    map.insert(
                        "…".to_owned(),
                        Value::String(format!("{CLIP_MARKER} {dropped} more")),
                    );
                    self.clipped = true;
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => self.spend(8),
        }
    }

    fn opt_text(&mut self, text: &mut Option<String>) {
        if let Some(text) = text {
            self.text(text);
        }
    }

    fn opt_json(&mut self, value: &mut Option<Value>) {
        if let Some(value) = value {
            self.json(value);
        }
    }

    /// Scrubs and clips the fields of `event` that can carry caller, prompt,
    /// reply or tool text. Names and ids are short by construction and left
    /// alone. A new variant or text field must be added here.
    fn event(&mut self, event: &mut DebugEvent) {
        match event {
            DebugEvent::CallerUtterance { text, .. }
            | DebugEvent::OperatorHop { text, .. }
            | DebugEvent::AgentInput { text, .. }
            | DebugEvent::AgentText { text, .. } => self.text(text),
            DebugEvent::JevRequest { state, .. } => self.json(state),
            DebugEvent::JevResponse { answers, error, .. } => {
                self.opt_text(error);
                self.json(answers);
            }
            DebugEvent::RouteDecision { reason, .. } | DebugEvent::PbxBranch { reason, .. } => {
                self.text(reason)
            }
            DebugEvent::UtilityRequest { prompt, .. } => self.text(prompt),
            DebugEvent::UtilityDecision { decision, .. } => self.json(decision),
            DebugEvent::Routed { text_part, .. } => self.text(text_part),
            DebugEvent::ToolStart { args, .. } => self.opt_json(args),
            DebugEvent::ToolEnd { result, error, .. } => {
                self.opt_text(error);
                self.opt_json(result);
            }
            DebugEvent::ModuleCall { args, .. } => self.json(args),
            DebugEvent::ModuleResult { detail, .. } => self.json(detail),
            DebugEvent::Rescue { reason, .. } => self.text(reason),
            DebugEvent::CallBoundary { reason, .. } => self.opt_text(reason),
            DebugEvent::Speech { text, reason, .. } => {
                self.opt_text(reason);
                self.text(text);
            }
            DebugEvent::FloorRequest { message, .. } | DebugEvent::FloorHeld { message, .. } => {
                self.text(message)
            }
            DebugEvent::FloorRewrite {
                original,
                rewritten,
                ..
            } => {
                self.text(original);
                self.text(rewritten);
            }
            DebugEvent::OperatorRouteTool { .. }
            | DebugEvent::TurnStart { .. }
            | DebugEvent::TurnEnd { .. }
            | DebugEvent::FloorGate { .. }
            | DebugEvent::FloorReleased { .. }
            | DebugEvent::AgentsState { .. }
            | DebugEvent::HostLink { .. } => {}
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
pub(crate) struct DebugConfig {
    pub jev_for_current_agent_lower: f64,
    pub jev_for_current_agent_upper: f64,
    pub jev_action_threshold: f64,
}

impl Default for DebugConfig {
    fn default() -> Self {
        Self {
            jev_for_current_agent_lower: 0.3,
            jev_for_current_agent_upper: 0.7,
            jev_action_threshold: 0.6,
        }
    }
}

/// Frames sent only on the debug listener, serialized from borrowed records
/// so a snapshot never deep-copies the rings. Event records are flattened so
/// a frontend can switch on `kind` without a second nested object.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum DebugFrame<'a> {
    Snapshot {
        /// Every record with `seq <= last_seq` is in this snapshot or was
        /// evicted before it; a client drops live frames at or below it.
        last_seq: u64,
        events: Vec<&'a DebugRecord>,
        logs: Vec<&'a DebugLog>,
        agents: &'a [AgentState],
        config: &'a DebugConfig,
    },
    Event {
        #[serde(flatten)]
        record: &'a DebugRecord,
    },
    Log {
        #[serde(flatten)]
        log: &'a DebugLog,
    },
}

/// One record on the live broadcast. Cloning it is a reference-count bump.
#[derive(Clone, Debug)]
pub(crate) enum LiveFrame {
    Event(Arc<DebugRecord>),
    Log(Arc<DebugLog>),
}

impl LiveFrame {
    pub(crate) fn seq(&self) -> u64 {
        match self {
            Self::Event(record) => record.seq,
            Self::Log(log) => log.seq,
        }
    }

    pub(crate) fn to_json(&self) -> String {
        let frame = match self {
            Self::Event(record) => DebugFrame::Event { record },
            Self::Log(log) => DebugFrame::Log { log },
        };
        serde_json::to_string(&frame).unwrap_or_default()
    }
}

/// The rings as they stood at one sequence number. Taking it costs only
/// reference-count bumps under the publish lock; serializing it happens later,
/// off that lock.
#[derive(Clone, Debug)]
pub(crate) struct Snapshot {
    pub last_seq: u64,
    pub events: Vec<Arc<DebugRecord>>,
    pub logs: Vec<Arc<DebugLog>>,
    pub config: DebugConfig,
}

impl Snapshot {
    pub(crate) fn to_json(&self, agents: &[AgentState]) -> String {
        let frame = DebugFrame::Snapshot {
            last_seq: self.last_seq,
            events: self.events.iter().map(AsRef::as_ref).collect(),
            logs: self.logs.iter().map(AsRef::as_ref).collect(),
            agents,
            config: &self.config,
        };
        serde_json::to_string(&frame).unwrap_or_default()
    }
}

struct Rings {
    last_seq: u64,
    events: VecDeque<Arc<DebugRecord>>,
    logs: VecDeque<Arc<DebugLog>>,
    config: DebugConfig,
}

struct DebugInner {
    /// One short critical section per publish: sequence assignment, ring push
    /// and broadcast send happen together, so the ring and every live
    /// receiver see records in `seq` order with no gaps. Nothing awaits or
    /// does I/O under it.
    rings: Mutex<Rings>,
    live: broadcast::Sender<LiveFrame>,
}

/// Bounded, process-local observability state. There is intentionally no disk
/// writer and no await in `publish` or `publish_log`.
#[derive(Clone)]
pub(crate) struct DebugBus(Arc<DebugInner>);

thread_local! {
    /// Set while this thread is inside a publish. The log layer skips events
    /// raised there, so a log line can never re-enter the publish lock.
    static PUBLISHING: Cell<bool> = const { Cell::new(false) };
}

impl DebugBus {
    pub(crate) fn new() -> Self {
        let (live, _) = broadcast::channel(LIVE_CAPACITY);
        Self(Arc::new(DebugInner {
            rings: Mutex::new(Rings {
                last_seq: 0,
                events: VecDeque::with_capacity(EVENT_CAPACITY),
                logs: VecDeque::with_capacity(LOG_CAPACITY),
                config: DebugConfig::default(),
            }),
            live,
        }))
    }

    fn rings(&self) -> MutexGuard<'_, Rings> {
        self.0.rings.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `f` under the publish lock with the re-entry guard set.
    fn locked<T>(&self, f: impl FnOnce(&mut Rings) -> T) -> T {
        PUBLISHING.with(|publishing| publishing.set(true));
        let result = f(&mut self.rings());
        PUBLISHING.with(|publishing| publishing.set(false));
        result
    }

    pub(crate) fn set_config(&self, config: DebugConfig) {
        self.locked(|rings| rings.config = config);
    }

    /// Records `event` and sends it to live clients. Returns its sequence.
    pub(crate) fn publish(&self, mut event: DebugEvent) -> u64 {
        let timestamp_ms = now_ms();
        let mut clip = Clip::new();
        clip.event(&mut event);
        self.locked(|rings| {
            rings.last_seq += 1;
            let record = Arc::new(DebugRecord {
                seq: rings.last_seq,
                timestamp_ms,
                clipped: clip.clipped,
                event,
            });
            push_bounded(&mut rings.events, record.clone(), EVENT_CAPACITY);
            let _ = self.0.live.send(LiveFrame::Event(record));
            rings.last_seq
        })
    }

    pub(crate) fn publish_log(
        &self,
        level: String,
        target: String,
        mut message: String,
        mut fields: Value,
    ) -> u64 {
        let timestamp_ms = now_ms();
        let mut clip = Clip::new();
        clip.text(&mut message);
        clip.json(&mut fields);
        self.locked(|rings| {
            rings.last_seq += 1;
            let log = Arc::new(DebugLog {
                seq: rings.last_seq,
                timestamp_ms,
                level,
                target,
                message,
                fields,
                clipped: clip.clipped,
            });
            push_bounded(&mut rings.logs, log.clone(), LOG_CAPACITY);
            let _ = self.0.live.send(LiveFrame::Log(log));
            rings.last_seq
        })
    }

    /// A bare live receiver, unpaired with a snapshot.
    #[cfg(test)]
    pub(crate) fn subscribe_for_test(&self) -> broadcast::Receiver<LiveFrame> {
        self.0.live.subscribe()
    }

    /// The rings now. Records after `last_seq` arrive only live.
    #[cfg(test)]
    pub(crate) fn snapshot(&self) -> Snapshot {
        self.locked(|rings| take_snapshot(rings))
    }

    /// The events in the ring now, oldest first, without their records.
    #[cfg(test)]
    pub(crate) fn events_for_test(&self) -> Vec<DebugEvent> {
        self.snapshot()
            .events
            .iter()
            .map(|record| record.event.clone())
            .collect()
    }

    /// Subscribes to the live stream and takes a snapshot in one critical
    /// section, so the receiver holds exactly the records after `last_seq`.
    pub(crate) fn attach(&self) -> (broadcast::Receiver<LiveFrame>, Snapshot) {
        self.locked(|rings| (self.0.live.subscribe(), take_snapshot(rings)))
    }
}

fn take_snapshot(rings: &Rings) -> Snapshot {
    Snapshot {
        last_seq: rings.last_seq,
        events: rings.events.iter().cloned().collect(),
        logs: rings.logs.iter().cloned().collect(),
        config: rings.config.clone(),
    }
}

fn push_bounded<T>(ring: &mut VecDeque<T>, item: T, capacity: usize) {
    if ring.len() == capacity {
        ring.pop_front();
    }
    ring.push_back(item);
}

/// What a debug client is sent next.
pub(crate) enum Outgoing {
    Snapshot(Snapshot),
    Live(LiveFrame),
}

/// One client's view of the bus: live frames after the last snapshot, and a
/// fresh snapshot in place of anything it fell behind on.
pub(crate) struct Feed {
    bus: DebugBus,
    receiver: broadcast::Receiver<LiveFrame>,
    last_seq: u64,
}

impl Feed {
    pub(crate) fn attach(bus: DebugBus) -> (Self, Snapshot) {
        let (receiver, snapshot) = bus.attach();
        let feed = Self {
            bus,
            receiver,
            last_seq: snapshot.last_seq,
        };
        (feed, snapshot)
    }

    /// The next frame, or `None` once the bus is gone. Cancel-safe.
    pub(crate) async fn next(&mut self) -> Option<Outgoing> {
        loop {
            match self.receiver.recv().await {
                // Already in the snapshot the client holds.
                Ok(frame) if frame.seq() <= self.last_seq => continue,
                Ok(frame) => {
                    self.last_seq = frame.seq();
                    return Some(Outgoing::Live(frame));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    // Skip the stale backlog: a fresh receiver starts at the
                    // tail, and the snapshot taken with it covers the rest.
                    let (receiver, snapshot) = self.bus.attach();
                    self.receiver = receiver;
                    self.last_seq = snapshot.last_seq;
                    return Some(Outgoing::Snapshot(snapshot));
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }
}

async fn ws(State(site): State<Site>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| serve_socket(socket, site))
}

async fn send_text(socket: &mut WebSocket, text: String) -> Result<(), ()> {
    match timeout(SEND_TIMEOUT, socket.send(Message::Text(text.into()))).await {
        Ok(Ok(())) => Ok(()),
        _ => Err(()),
    }
}

/// Serializes a snapshot on the blocking pool: it can be megabytes, and the
/// runtime workers also carry audio and turns.
async fn send_snapshot(socket: &mut WebSocket, site: &Site, snapshot: Snapshot) -> Result<(), ()> {
    let agents = (site.agents)();
    let text = tokio::task::spawn_blocking(move || snapshot.to_json(&agents))
        .await
        .map_err(|_| ())?;
    send_text(socket, text).await
}

async fn serve_socket(mut socket: WebSocket, site: Site) {
    let mut shutdown = site.shutdown.clone();
    if *shutdown.borrow_and_update() {
        return;
    }
    let (mut feed, snapshot) = Feed::attach(site.bus.clone());
    if send_snapshot(&mut socket, &site, snapshot).await.is_err() {
        return;
    }
    loop {
        let outgoing = tokio::select! {
            outgoing = feed.next() => outgoing,
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return,
                Some(Ok(_)) => continue,
            },
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    let _ = timeout(SEND_TIMEOUT, socket.send(Message::Close(None))).await;
                    return;
                }
                continue;
            }
        };
        let sent = match outgoing {
            Some(Outgoing::Live(frame)) => send_text(&mut socket, frame.to_json()).await,
            Some(Outgoing::Snapshot(snapshot)) => send_snapshot(&mut socket, &site, snapshot).await,
            None => return,
        };
        if sent.is_err() {
            return;
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Default)]
struct FieldsVisitor {
    fields: serde_json::Map<String, Value>,
    message: Option<String>,
}

impl tracing::field::Visit for FieldsVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        let value = format!("{value:?}");
        self.record(field.name(), Value::String(value));
    }
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        self.record(field.name(), Value::String(value.to_owned()));
    }
    // Fields are kept as JSON numbers and booleans where they are ones:
    // `Clip` redacts only strings under a secret-like name, because a number
    // cannot carry a credential (`*_token_budget`, `*_key_configured`).
    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.fields
            .insert(field.name().to_owned(), Value::from(value));
    }
    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.fields
            .insert(field.name().to_owned(), Value::from(value));
    }
    fn record_i128(&mut self, field: &tracing::field::Field, value: i128) {
        self.record(field.name(), Value::String(value.to_string()));
    }
    fn record_u128(&mut self, field: &tracing::field::Field, value: u128) {
        self.record(field.name(), Value::String(value.to_string()));
    }
    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.fields
            .insert(field.name().to_owned(), Value::Bool(value));
    }
}

impl FieldsVisitor {
    fn record(&mut self, name: &str, value: Value) {
        if name == "message" {
            self.message = value.as_str().map(ToOwned::to_owned);
        } else {
            self.fields.insert(name.to_owned(), value);
        }
    }
}

/// A copy layer beside the normal journal formatter. It deliberately uses
/// only event metadata and fields, and never asks a span or application lock.
pub(crate) struct DebugLogLayer {
    bus: DebugBus,
}

impl DebugLogLayer {
    pub(crate) fn new(bus: DebugBus) -> Self {
        Self { bus }
    }
}

impl<S> Layer<S> for DebugLogLayer
where
    S: tracing::Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        // Never log from the publish path; this guard makes a mistake there
        // drop the line instead of deadlocking on the publish lock.
        if PUBLISHING.with(Cell::get) {
            return;
        }
        let metadata = event.metadata();
        let mut visitor = FieldsVisitor::default();
        event.record(&mut visitor);
        let message = visitor.message.unwrap_or_default();
        self.bus.publish_log(
            metadata.level().to_string(),
            metadata.target().to_owned(),
            message,
            Value::Object(visitor.fields),
        );
    }
}

/// What replaces a credential on the debug page. The page is
/// unauthenticated; the journal keeps whatever the log line carried.
const REDACTED: &str = "[redacted]";

/// True for a field name that usually holds a credential: `token`,
/// `call_token`, `api_key`, `apiKey`, `Authorization`, `client_secret` and so
/// on. Case-insensitive. `key` counts only as a whole name part, so `keyboard`
/// and `monkey` do not.
fn secret_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.split(['_', '-', '.'])
        .any(|part| part == "key" || part == "keys")
        || [
            "token",
            "secret",
            "password",
            "passwd",
            "apikey",
            "privatekey",
            "authorization",
            "bearer",
            "credential",
            "cookie",
        ]
        .iter()
        .any(|word| name.contains(word))
}

/// Replaces credential-looking parts of text: the value after a
/// credential-like name and `=` or `:` (`API_KEY=...`, `"token": "..."`), the
/// word after `Bearer`, and words with a well-known key prefix. A heuristic:
/// it keeps a pasted `.env` or auth header off the page, not every secret.
pub(crate) fn scrub_text(text: &str) -> String {
    const KEY_PREFIXES: [&str; 8] = [
        "sk-",
        "ghp_",
        "gho_",
        "ghs_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
        "glpat-",
    ];
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let is_value = |c: char| !c.is_whitespace() && !matches!(c, '"' | '\'' | ',' | '}' | ']');
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut redact_next_word = false;
    while i < chars.len() {
        let c = chars[i];
        if !is_word(c) {
            out.push(c);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && is_word(chars[i]) {
            i += 1;
        }
        let word: String = chars[start..i].iter().collect();
        if redact_next_word
            || (word.len() >= 16 && KEY_PREFIXES.iter().any(|p| word.starts_with(p)))
        {
            redact_next_word = false;
            // The rest of a value such as `abc.def/ghi` goes with it.
            while i < chars.len() && is_value(chars[i]) {
                i += 1;
            }
            out.push_str(REDACTED);
            continue;
        }
        out.push_str(&word);
        if word.eq_ignore_ascii_case("bearer") {
            redact_next_word = chars.get(i).is_some_and(|c| *c == ' ');
            continue;
        }
        if !secret_name(&word) {
            continue;
        }
        // `name`, an optional closing quote, spaces, `=` or `:`, spaces and an
        // optional opening quote, then the value.
        let mut j = i;
        if matches!(chars.get(j), Some('"' | '\'')) {
            j += 1;
        }
        while matches!(chars.get(j), Some(' ' | '\t')) {
            j += 1;
        }
        if !matches!(chars.get(j), Some('=' | ':')) {
            continue;
        }
        j += 1;
        while matches!(chars.get(j), Some(' ' | '\t')) {
            j += 1;
        }
        if matches!(chars.get(j), Some('"' | '\'')) {
            j += 1;
        }
        let value_start = j;
        while j < chars.len() && is_value(chars[j]) {
            j += 1;
        }
        // A count such as `tokens: 500` is not a credential.
        let numeric = chars[value_start..j].iter().all(|c| c.is_ascii_digit());
        if j > value_start && !numeric {
            let value: String = chars[value_start..j].iter().collect();
            // `Authorization: Bearer <token>`: the scheme, then the token.
            redact_next_word = ["bearer", "basic"]
                .iter()
                .any(|scheme| value.eq_ignore_ascii_case(scheme));
            out.extend(&chars[i..value_start]);
            out.push_str(REDACTED);
            i = j;
        }
    }
    out
}

#[cfg(test)]
#[path = "../tests/test_debug.rs"]
mod tests;

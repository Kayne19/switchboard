//! Read-only observability for the debug page.
//!
//! The debug bus is deliberately independent from call control. Publishing is
//! synchronous and bounded: it records a small in-memory copy and uses
//! `broadcast::Sender::send`, so a slow browser can never hold up a call.
use crate::debug_record::{Clip, MAX_RECORD_BYTES, RECORD_OVERHEAD_BYTES};
use crate::protocol::AgentState;
#[cfg(test)]
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::{
    cell::Cell,
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard, PoisonError,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::broadcast,
    time::{Duration, Instant},
};
use tracing_subscriber::{layer::Context, registry::LookupSpan, Layer};

const EVENT_CAPACITY: usize = 4_000;
const LOG_CAPACITY: usize = 2_000;
const LIVE_CAPACITY: usize = 256;
/// Each ring's total size bound, from the records' estimated sizes. The
/// oldest records go first past it, as past the ring's capacity.
const EVENT_BUDGET_BYTES: usize = 32 << 20;
const LOG_BUDGET_BYTES: usize = 8 << 20;
const _: () = assert!(EVENT_BUDGET_BYTES > 1000 * (MAX_RECORD_BYTES + RECORD_OVERHEAD_BYTES));
const _: () = assert!(LOG_BUDGET_BYTES > 256 * (MAX_RECORD_BYTES + RECORD_OVERHEAD_BYTES));
/// A client that falls behind twice within this time is closed instead of
/// resynced again: each resync is a full snapshot.
const RESYNC_INTERVAL: Duration = Duration::from_secs(10);

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

/// The routing thresholds the page shows beside Jev's answers.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
pub(crate) struct DebugConfig {
    pub jev_for_current_agent_lower: f64,
    pub jev_for_current_agent_upper: f64,
    pub jev_action_threshold: f64,
}

impl DebugConfig {
    pub(crate) fn from_config(config: &crate::Config) -> Self {
        Self {
            jev_for_current_agent_lower: config.jev_for_current_agent_lower,
            jev_for_current_agent_upper: config.jev_for_current_agent_upper,
            jev_action_threshold: config.jev_action_threshold,
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
        /// Set from the service's configuration when recording starts.
        config: Option<&'a DebugConfig>,
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
    pub config: Option<DebugConfig>,
}

impl Snapshot {
    pub(crate) fn to_json(&self, agents: &[AgentState]) -> String {
        let frame = DebugFrame::Snapshot {
            last_seq: self.last_seq,
            events: self.events.iter().map(AsRef::as_ref).collect(),
            logs: self.logs.iter().map(AsRef::as_ref).collect(),
            agents,
            config: self.config.as_ref(),
        };
        serde_json::to_string(&frame).unwrap_or_default()
    }
}

struct Rings {
    last_seq: u64,
    events: Ring<DebugRecord>,
    logs: Ring<DebugLog>,
    config: Option<DebugConfig>,
}

/// A bounded history: at most `capacity` records and `budget` estimated
/// bytes. The oldest go first.
struct Ring<T> {
    items: VecDeque<(usize, Arc<T>)>,
    bytes: usize,
    capacity: usize,
    budget: usize,
}

impl<T> Ring<T> {
    fn new(capacity: usize, budget: usize) -> Self {
        Self {
            items: VecDeque::new(),
            bytes: 0,
            capacity,
            budget,
        }
    }

    fn push(&mut self, bytes: usize, item: Arc<T>) {
        while !self.items.is_empty()
            && (self.items.len() >= self.capacity || self.bytes + bytes > self.budget)
        {
            if let Some((evicted, _)) = self.items.pop_front() {
                self.bytes -= evicted;
            }
        }
        self.bytes += bytes;
        self.items.push_back((bytes, item));
    }

    fn records(&self) -> Vec<Arc<T>> {
        self.items.iter().map(|(_, item)| item.clone()).collect()
    }
}

struct DebugInner {
    /// Off until `enable`: with no debug listener nothing reads the rings,
    /// so nothing is recorded and publishing returns at once.
    enabled: AtomicBool,
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
    /// A bus that records nothing until `enable`. The service enables it
    /// only once its debug listener is bound.
    pub(crate) fn off() -> Self {
        let (live, _) = broadcast::channel(LIVE_CAPACITY);
        Self(Arc::new(DebugInner {
            enabled: AtomicBool::new(false),
            rings: Mutex::new(Rings {
                last_seq: 0,
                events: Ring::new(EVENT_CAPACITY, EVENT_BUDGET_BYTES),
                logs: Ring::new(LOG_CAPACITY, LOG_BUDGET_BYTES),
                config: None,
            }),
            live,
        }))
    }

    /// A recording bus with the test configuration's thresholds.
    #[cfg(test)]
    pub(crate) fn new() -> Self {
        let bus = Self::off();
        bus.enable(DebugConfig::from_config(&crate::Config::for_tests(&[])));
        bus
    }

    /// Starts recording, with the thresholds the page shows.
    pub(crate) fn enable(&self, config: DebugConfig) {
        self.locked(|rings| rings.config = Some(config));
        self.0.enabled.store(true, Ordering::Release);
    }

    /// True once `enable` was called. A producer can check it before it
    /// builds an expensive event.
    pub(crate) fn enabled(&self) -> bool {
        self.0.enabled.load(Ordering::Acquire)
    }

    fn rings(&self) -> MutexGuard<'_, Rings> {
        self.0.rings.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `f` under the publish lock with the re-entry guard set. The
    /// guard puts the flag back as it was, even if `f` panics.
    fn locked<T>(&self, f: impl FnOnce(&mut Rings) -> T) -> T {
        struct Publishing(bool);
        impl Drop for Publishing {
            fn drop(&mut self) {
                PUBLISHING.with(|publishing| publishing.set(self.0));
            }
        }
        let _guard = Publishing(PUBLISHING.with(|publishing| publishing.replace(true)));
        f(&mut self.rings())
    }

    /// Records `event` and sends it to live clients. Returns its sequence,
    /// or 0 when the bus is off.
    pub(crate) fn publish(&self, mut event: DebugEvent) -> u64 {
        if !self.enabled() {
            return 0;
        }
        let timestamp_ms = now_ms();
        let bound = Clip::bound_event(&mut event);
        self.locked(|rings| {
            rings.last_seq += 1;
            let record = Arc::new(DebugRecord {
                seq: rings.last_seq,
                timestamp_ms,
                clipped: bound.clipped,
                event,
            });
            rings.events.push(bound.bytes, record.clone());
            let _ = self.0.live.send(LiveFrame::Event(record));
            rings.last_seq
        })
    }

    pub(crate) fn publish_log(
        &self,
        mut level: String,
        mut target: String,
        mut message: String,
        mut fields: Value,
    ) -> u64 {
        if !self.enabled() {
            return 0;
        }
        let timestamp_ms = now_ms();
        let bound = Clip::bound_log(&mut level, &mut target, &mut message, &mut fields);
        self.locked(|rings| {
            rings.last_seq += 1;
            let log = Arc::new(DebugLog {
                seq: rings.last_seq,
                timestamp_ms,
                level,
                target,
                message,
                fields,
                clipped: bound.clipped,
            });
            rings.logs.push(bound.bytes, log.clone());
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
        events: rings.events.records(),
        logs: rings.logs.records(),
        config: rings.config.clone(),
    }
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
    /// When this client was last sent a resync snapshot.
    last_resync: Option<Instant>,
}

impl Feed {
    pub(crate) fn attach(bus: DebugBus) -> (Self, Snapshot) {
        let (receiver, snapshot) = bus.attach();
        let feed = Self {
            bus,
            receiver,
            last_seq: snapshot.last_seq,
            last_resync: None,
        };
        (feed, snapshot)
    }

    /// The next frame, or `None` once the bus is gone or the client fell
    /// behind again within `RESYNC_INTERVAL` of its last resync: a client
    /// that cannot keep up is closed rather than sent snapshot after
    /// snapshot, and the page reconnects with its backoff. Cancel-safe.
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
                    let now = Instant::now();
                    if self
                        .last_resync
                        .is_some_and(|last| now.duration_since(last) < RESYNC_INTERVAL)
                    {
                        return None;
                    }
                    self.last_resync = Some(now);
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
    // Fields are kept as JSON numbers and booleans where they are ones, so
    // `Clip` can keep a count or a flag under a secret-like name
    // (`*_token_budget`, `*_key_configured`); see `debug_record::secret_value`.
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
        // drop the line instead of deadlocking on the publish lock. With the
        // bus off, the layer does nothing at all.
        if !self.bus.enabled() || PUBLISHING.with(Cell::get) {
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

/// A small event for tests.
#[cfg(test)]
pub(crate) fn host_link(n: usize) -> DebugEvent {
    DebugEvent::HostLink {
        host: format!("host-{n}"),
        connected: true,
    }
}

#[cfg(test)]
thread_local! {
    static CAPTURE: std::cell::RefCell<Option<DebugLogLayer>> = const { std::cell::RefCell::new(None) };
}

/// Copies the `switchboard=info` lines this thread logs to `bus` until the
/// guard drops: how a test asserts on a log line. A subscriber scoped to one
/// thread loses lines (docs/concurrency-and-test-hazards.md, "A log capture
/// scoped to one thread").
#[cfg(test)]
pub(crate) fn capture_logs(bus: &DebugBus) -> LogCapture {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        use tracing_subscriber::prelude::*;
        tracing::subscriber::set_global_default(
            tracing_subscriber::registry()
                .with(tracing_subscriber::EnvFilter::new("switchboard=info"))
                .with(CaptureRouter),
        )
        .expect("capture_logs installs the test binary's only subscriber");
        // The install enables `info` before it publishes the subscriber. A
        // callsite another thread registered in between found no subscriber
        // and was cached as never.
        tracing::callsite::rebuild_interest_cache();
    });
    CAPTURE.with(|capture| {
        let mut capture = capture.borrow_mut();
        assert!(capture.is_none(), "this thread already captures its logs");
        *capture = Some(DebugLogLayer::new(bus.clone()));
    });
    LogCapture {
        _not_send: std::marker::PhantomData,
    }
}

#[cfg(test)]
#[must_use = "the capture ends when the guard drops"]
pub(crate) struct LogCapture {
    _not_send: std::marker::PhantomData<*const ()>,
}

#[cfg(test)]
impl Drop for LogCapture {
    fn drop(&mut self) {
        CAPTURE.with(|capture| capture.borrow_mut().take());
    }
}

#[cfg(test)]
struct CaptureRouter;

#[cfg(test)]
impl<S> Layer<S> for CaptureRouter
where
    S: tracing::Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &tracing::Event<'_>, ctx: Context<'_, S>) {
        let _ = CAPTURE.try_with(|capture| {
            if let Some(layer) = capture.borrow().as_ref() {
                layer.on_event(event, ctx);
            }
        });
    }
}

#[cfg(test)]
#[path = "../tests/test_debug.rs"]
mod tests;

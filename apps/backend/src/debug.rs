//! Read-only observability for the debug page.
//!
//! The debug bus is deliberately independent from call control. Publishing is
//! synchronous and bounded: it records a small in-memory copy and uses
//! `broadcast::Sender::send`, so a slow browser can never hold up a call.
use crate::protocol::AgentState;
#[cfg(test)]
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::broadcast;
use tracing_subscriber::{layer::Context, registry::LookupSpan, Layer};

const EVENT_CAPACITY: usize = 4_000;
const LOG_CAPACITY: usize = 2_000;
const LIVE_CAPACITY: usize = 256;

/// One event in the debug page's immutable event stream. This is the schema
/// shared with `apps/frontend/src/debug/protocol.ts` and its fixture.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(tag = "kind", rename_all = "snake_case")]
// The schema is deliberately complete before all producers land in later
// slices. Unemitted variants are still public within the crate by design.
#[allow(dead_code)]
pub(crate) enum DebugEvent {
    CallerUtterance {
        utterance_id: String,
        text: String,
        talking_to: String,
    },
    JevRequest {
        utterance_id: String,
        purpose: String,
        state: Value,
    },
    JevResponse {
        utterance_id: String,
        purpose: String,
        latency_ms: u64,
        outcome: String,
        answers: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
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
    },
    ModuleCall {
        agent: String,
        call_id: String,
        name: String,
        args: Value,
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
    },
    TurnEnd {
        agent: String,
        turn_id: String,
        generation: u64,
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
    },
    FloorRequest {
        agent: String,
        message: String,
    },
    FloorHeld {
        agent: String,
        message: String,
    },
    FloorGate {
        agent: String,
        answer: String,
        latency_ms: u64,
    },
    FloorRewrite {
        agent: String,
        original: String,
        rewritten: String,
        latency_ms: u64,
    },
    FloorReleased {
        agent: String,
        how: String,
    },
    AgentsState {
        agents: Vec<AgentState>,
    },
    HostLink {
        host: String,
        connected: bool,
    },
}

/// A numbered event retained in the ring and sent to a live client.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
pub(crate) struct DebugRecord {
    pub seq: u64,
    pub timestamp_ms: u64,
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

/// Frames sent only on the debug listener. Event records are flattened so a
/// frontend can switch on `kind` without a second nested object.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum DebugFrame {
    Snapshot {
        events: Vec<DebugRecord>,
        logs: Vec<DebugLog>,
        agents: Vec<AgentState>,
        config: DebugConfig,
    },
    Event {
        #[serde(flatten)]
        record: DebugRecord,
    },
    Log {
        #[serde(flatten)]
        log: DebugLog,
    },
}

struct DebugInner {
    next_seq: AtomicU64,
    events: Mutex<VecDeque<DebugRecord>>,
    logs: Mutex<VecDeque<DebugLog>>,
    config: Mutex<DebugConfig>,
    live: broadcast::Sender<DebugFrame>,
}

/// Bounded, process-local observability state. There is intentionally no disk
/// writer and no await in `publish` or `publish_log`.
#[derive(Clone)]
pub(crate) struct DebugBus(Arc<DebugInner>);

impl DebugBus {
    pub(crate) fn new() -> Self {
        let (live, _) = broadcast::channel(LIVE_CAPACITY);
        Self(Arc::new(DebugInner {
            next_seq: AtomicU64::new(1),
            events: Mutex::new(VecDeque::with_capacity(EVENT_CAPACITY)),
            logs: Mutex::new(VecDeque::with_capacity(LOG_CAPACITY)),
            config: Mutex::new(DebugConfig::default()),
            live,
        }))
    }

    pub(crate) fn set_config(&self, config: DebugConfig) {
        if let Ok(mut current) = self.0.config.lock() {
            *current = config;
        }
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<DebugFrame> {
        self.0.live.subscribe()
    }

    pub(crate) fn publish(&self, event: DebugEvent) -> DebugRecord {
        let record = DebugRecord {
            seq: self.0.next_seq.fetch_add(1, Ordering::Relaxed),
            timestamp_ms: now_ms(),
            event,
        };
        if let Ok(mut events) = self.0.events.try_lock() {
            events.push_back(record.clone());
            if events.len() > EVENT_CAPACITY {
                events.pop_front();
            }
        }
        let _ = self.0.live.send(DebugFrame::Event {
            record: record.clone(),
        });
        record
    }

    pub(crate) fn publish_log(
        &self,
        level: String,
        target: String,
        message: String,
        fields: Value,
    ) -> DebugLog {
        let log = DebugLog {
            seq: self.0.next_seq.fetch_add(1, Ordering::Relaxed),
            timestamp_ms: now_ms(),
            level,
            target,
            message,
            fields,
        };
        if let Ok(mut logs) = self.0.logs.try_lock() {
            logs.push_back(log.clone());
            if logs.len() > LOG_CAPACITY {
                logs.pop_front();
            }
        }
        let _ = self.0.live.send(DebugFrame::Log { log: log.clone() });
        log
    }

    pub(crate) fn snapshot(&self, agents: Vec<AgentState>) -> DebugFrame {
        let events = self
            .0
            .events
            .lock()
            .map(|events| events.iter().cloned().collect())
            .unwrap_or_default();
        let logs = self
            .0
            .logs
            .lock()
            .map(|logs| logs.iter().cloned().collect())
            .unwrap_or_default();
        let config = self
            .0
            .config
            .lock()
            .map(|config| config.clone())
            .unwrap_or_default();
        DebugFrame::Snapshot {
            events,
            logs,
            agents,
            config,
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
    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.record(field.name(), Value::from(value));
    }
    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.record(field.name(), Value::from(value));
    }
    fn record_i128(&mut self, field: &tracing::field::Field, value: i128) {
        self.record(field.name(), Value::String(value.to_string()));
    }
    fn record_u128(&mut self, field: &tracing::field::Field, value: u128) {
        self.record(field.name(), Value::String(value.to_string()));
    }
    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.record(field.name(), Value::Bool(value));
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn examples() -> Vec<(&'static str, DebugEvent)> {
        vec![
            (
                "caller_utterance",
                DebugEvent::CallerUtterance {
                    utterance_id: "clip-42".into(),
                    text: "Please send me to alpha.".into(),
                    talking_to: "operator".into(),
                },
            ),
            (
                "jev_request",
                DebugEvent::JevRequest {
                    utterance_id: "clip-42".into(),
                    purpose: "route".into(),
                    state: json!({"caller_just_said":"Please send me to alpha."}),
                },
            ),
            (
                "jev_response",
                DebugEvent::JevResponse {
                    utterance_id: "clip-42".into(),
                    purpose: "route".into(),
                    latency_ms: 83,
                    outcome: "ok".into(),
                    answers: json!({"action":{"selected":"transfer","probabilities":{"transfer":0.92}},"target":{"selected":"alpha","confidence":0.97}}),
                    error: None,
                },
            ),
            (
                "route_decision",
                DebugEvent::RouteDecision {
                    utterance_id: "clip-42".into(),
                    rule: "jev_action".into(),
                    reason: "action confidence 0.92 meets threshold 0.60".into(),
                    action: "transfer".into(),
                    target: Some("alpha".into()),
                    mode: "fresh".into(),
                    decided_by: "jev".into(),
                },
            ),
            (
                "pbx_branch",
                DebugEvent::PbxBranch {
                    utterance_id: "clip-42".into(),
                    branch: "utility".into(),
                    reason: "Jev requested a fresh transfer with an uncertain target".into(),
                },
            ),
            (
                "utility_request",
                DebugEvent::UtilityRequest {
                    utterance_id: "clip-42".into(),
                    attempt: "first".into(),
                    prompt: "Choose a destination for the caller.".into(),
                },
            ),
            (
                "utility_decision",
                DebugEvent::UtilityDecision {
                    utterance_id: "clip-42".into(),
                    attempt: "first".into(),
                    decision: json!({"kind":"second_opinion","target":"alpha","mode":"fresh","confident":true}),
                    latency_ms: 211,
                },
            ),
            (
                "operator_hop",
                DebugEvent::OperatorHop {
                    utterance_id: "clip-42".into(),
                    text: "The caller asked to inspect the build.".into(),
                    outcome: "route_tool".into(),
                },
            ),
            (
                "operator_route_tool",
                DebugEvent::OperatorRouteTool {
                    utterance_id: "clip-42".into(),
                    target: "alpha".into(),
                    mode: "fresh".into(),
                    action: "transfer".into(),
                },
            ),
            (
                "routed",
                DebugEvent::Routed {
                    utterance_id: "clip-42".into(),
                    to_agent: "alpha".into(),
                    text_part: "Please inspect the build.".into(),
                    mode: "fresh".into(),
                    via: "utility".into(),
                },
            ),
            (
                "agent_input",
                DebugEvent::AgentInput {
                    agent: "alpha".into(),
                    turn_id: Some("turn-8".into()),
                    text: "The caller asked to inspect the build.".into(),
                    source: "caller".into(),
                },
            ),
            (
                "agent_text",
                DebugEvent::AgentText {
                    agent: "alpha".into(),
                    turn_id: Some("turn-8".into()),
                    text: "I will check the build now.".into(),
                    final_: true,
                },
            ),
            (
                "tool_start",
                DebugEvent::ToolStart {
                    agent: "alpha".into(),
                    call_id: Some("call-3".into()),
                    tool: "bash".into(),
                    args: Some(json!({"command":"cargo test"})),
                },
            ),
            (
                "tool_end",
                DebugEvent::ToolEnd {
                    agent: "alpha".into(),
                    call_id: Some("call-3".into()),
                    tool: "bash".into(),
                    result: Some(json!({"exit_code":0})),
                    error: None,
                },
            ),
            (
                "module_call",
                DebugEvent::ModuleCall {
                    agent: "alpha".into(),
                    call_id: "call-4".into(),
                    name: "speak".into(),
                    args: json!({"text":"The build passes."}),
                },
            ),
            (
                "module_result",
                DebugEvent::ModuleResult {
                    agent: "alpha".into(),
                    call_id: "call-4".into(),
                    ok: true,
                    detail: json!({"status":"delivered"}),
                },
            ),
            (
                "turn_start",
                DebugEvent::TurnStart {
                    agent: "alpha".into(),
                    turn_id: "turn-8".into(),
                    generation: 3,
                },
            ),
            (
                "turn_end",
                DebugEvent::TurnEnd {
                    agent: "alpha".into(),
                    turn_id: "turn-8".into(),
                    generation: 3,
                },
            ),
            (
                "rescue",
                DebugEvent::Rescue {
                    generation: 4,
                    reason: "caller hung up".into(),
                    leg: Some("alpha".into()),
                },
            ),
            (
                "speech",
                DebugEvent::Speech {
                    agent: "alpha".into(),
                    text: "The build passes.".into(),
                    delivered: true,
                    reason: None,
                },
            ),
            (
                "floor_request",
                DebugEvent::FloorRequest {
                    agent: "alpha".into(),
                    message: "The build passes.".into(),
                },
            ),
            (
                "floor_held",
                DebugEvent::FloorHeld {
                    agent: "alpha".into(),
                    message: "The build passes.".into(),
                },
            ),
            (
                "floor_gate",
                DebugEvent::FloorGate {
                    agent: "alpha".into(),
                    answer: "yes".into(),
                    latency_ms: 41,
                },
            ),
            (
                "floor_rewrite",
                DebugEvent::FloorRewrite {
                    agent: "alpha".into(),
                    original: "The build passes.".into(),
                    rewritten: "I have good news: the build passes.".into(),
                    latency_ms: 127,
                },
            ),
            (
                "floor_released",
                DebugEvent::FloorReleased {
                    agent: "alpha".into(),
                    how: "quiet".into(),
                },
            ),
            (
                "agents_state",
                DebugEvent::AgentsState {
                    agents: vec![AgentState {
                        project: "alpha".into(),
                        state: "busy".into(),
                        pending_request: None,
                    }],
                },
            ),
            (
                "host_link",
                DebugEvent::HostLink {
                    host: "builder-1".into(),
                    connected: true,
                },
            ),
        ]
    }

    #[test]
    fn every_event_variant_matches_fixture() {
        #[derive(Deserialize)]
        struct Fixture {
            events: Vec<FixtureEvent>,
        }
        #[derive(Deserialize)]
        struct FixtureEvent {
            name: String,
            event: Value,
        }
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../apps/frontend/tests/fixtures/debug-events.json"
        ))
        .expect("debug fixture");
        let examples = examples();
        assert_eq!(fixture.events.len(), examples.len());
        for (name, event) in examples {
            let fixture_event = fixture
                .events
                .iter()
                .find(|item| item.name == name)
                .expect("fixture variant");
            assert_eq!(
                serde_json::to_value(event).unwrap(),
                fixture_event.event,
                "fixture shape for {name}"
            );
        }
    }

    #[test]
    fn snapshot_frame_round_trips_fixture() {
        #[derive(Deserialize)]
        struct Fixture {
            snapshot: Value,
        }
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../apps/frontend/tests/fixtures/debug-events.json"
        ))
        .unwrap();
        let snapshot: DebugFrame = serde_json::from_value(fixture.snapshot.clone()).unwrap();
        assert_eq!(serde_json::to_value(snapshot).unwrap(), fixture.snapshot);
    }

    #[test]
    fn publishing_is_bounded_and_numbered() {
        let bus = DebugBus::new();
        let first = bus.publish(DebugEvent::HostLink {
            host: "one".into(),
            connected: true,
        });
        let second = bus.publish(DebugEvent::HostLink {
            host: "one".into(),
            connected: false,
        });
        assert_eq!((first.seq, second.seq), (1, 2));
        let DebugFrame::Snapshot { events, .. } = bus.snapshot(vec![]) else {
            panic!("snapshot")
        };
        assert_eq!(events.len(), 2);
    }
}

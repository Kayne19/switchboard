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
        "../../frontend/tests/fixtures/debug-events.json"
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
        "../../frontend/tests/fixtures/debug-events.json"
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

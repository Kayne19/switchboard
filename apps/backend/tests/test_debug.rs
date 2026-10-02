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
fn snapshot_frame_matches_fixture() {
    #[derive(Deserialize)]
    struct Fixture {
        snapshot: Value,
    }
    #[derive(Deserialize)]
    struct OwnedSnapshot {
        last_seq: u64,
        events: Vec<DebugRecord>,
        logs: Vec<DebugLog>,
        agents: Vec<AgentState>,
        config: DebugConfig,
    }
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../frontend/tests/fixtures/debug-events.json"
    ))
    .unwrap();
    let owned: OwnedSnapshot = serde_json::from_value(fixture.snapshot.clone()).unwrap();
    let snapshot = Snapshot {
        last_seq: owned.last_seq,
        events: owned.events.into_iter().map(Arc::new).collect(),
        logs: owned.logs.into_iter().map(Arc::new).collect(),
        config: owned.config,
    };
    let json: Value = serde_json::from_str(&snapshot.to_json(&owned.agents)).unwrap();
    assert_eq!(json, fixture.snapshot);
}

fn host_link(n: usize) -> DebugEvent {
    DebugEvent::HostLink {
        host: format!("host-{n}"),
        connected: true,
    }
}

#[test]
fn publishing_is_numbered_and_snapshot_reports_last_seq() {
    let bus = DebugBus::new();
    let first = bus.publish(host_link(1));
    let log = bus.publish_log("INFO".into(), "t".into(), "m".into(), json!({}));
    let second = bus.publish(host_link(2));
    assert_eq!((first, log, second), (1, 2, 3));
    let snapshot = bus.snapshot();
    assert_eq!(snapshot.last_seq, 3);
    assert_eq!(snapshot.events.len(), 2);
    assert_eq!(snapshot.logs.len(), 1);
}

#[test]
fn rings_evict_the_oldest_record_at_capacity() {
    let bus = DebugBus::new();
    for n in 0..EVENT_CAPACITY + 5 {
        bus.publish(host_link(n));
    }
    for _ in 0..LOG_CAPACITY + 3 {
        bus.publish_log("INFO".into(), "t".into(), "m".into(), json!({}));
    }
    let snapshot = bus.snapshot();
    assert_eq!(snapshot.events.len(), EVENT_CAPACITY);
    assert_eq!(snapshot.events[0].seq, 6);
    assert_eq!(
        snapshot.events.last().unwrap().seq,
        (EVENT_CAPACITY + 5) as u64
    );
    assert_eq!(snapshot.logs.len(), LOG_CAPACITY);
    assert_eq!(snapshot.logs[0].seq, (EVENT_CAPACITY + 5 + 4) as u64);
    assert_eq!(
        snapshot.last_seq,
        (EVENT_CAPACITY + 5 + LOG_CAPACITY + 3) as u64
    );
}

#[test]
fn concurrent_publishers_keep_ring_and_live_order_without_gaps() {
    // One critical section assigns the seq, pushes and broadcasts, so a
    // receiver and the rings agree on order even under contention, and a
    // concurrent snapshot never drops a record from the ring.
    const THREADS: usize = 4;
    const EACH: usize = 50; // THREADS * EACH stays under LIVE_CAPACITY.
    let bus = DebugBus::new();
    let (mut receiver, _) = bus.attach();
    std::thread::scope(|scope| {
        for thread in 0..THREADS {
            let bus = bus.clone();
            scope.spawn(move || {
                for n in 0..EACH {
                    if n % 2 == 0 {
                        bus.publish(host_link(thread * EACH + n));
                    } else {
                        bus.publish_log("INFO".into(), "t".into(), "m".into(), json!({}));
                    }
                }
            });
        }
        let bus = bus.clone();
        scope.spawn(move || {
            for _ in 0..20 {
                let _ = bus.snapshot();
            }
        });
    });
    let total = (THREADS * EACH) as u64;
    let live: Vec<u64> = std::iter::from_fn(|| receiver.try_recv().ok())
        .map(|frame| frame.seq())
        .collect();
    assert_eq!(live, (1..=total).collect::<Vec<_>>());
    let snapshot = bus.snapshot();
    let mut ring: Vec<u64> = snapshot
        .events
        .iter()
        .map(|record| record.seq)
        .chain(snapshot.logs.iter().map(|log| log.seq))
        .collect();
    let events_in_order = snapshot.events.windows(2).all(|w| w[0].seq < w[1].seq);
    let logs_in_order = snapshot.logs.windows(2).all(|w| w[0].seq < w[1].seq);
    assert!(events_in_order && logs_in_order);
    ring.sort_unstable();
    assert_eq!(ring, (1..=total).collect::<Vec<_>>());
}

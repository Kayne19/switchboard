use super::*;
use crate::within;
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
                utterance_id: Some("clip-42".into()),
                purpose: "route".into(),
                state: json!({"caller_just_said":"Please send me to alpha."}),
                floor_id: None,
            },
        ),
        (
            "jev_response",
            DebugEvent::JevResponse {
                utterance_id: Some("clip-42".into()),
                purpose: "route".into(),
                latency_ms: 83,
                outcome: "ok".into(),
                answers: json!({
                    "action": {"type":"choice","choice":"go_to_project","probabilities":{"go_to_project":0.92,"continue":0.05,"general":0.03},"confidence":0.92,"noul":null},
                    "for_current_agent": {"type":"noul","choice":null,"probabilities":null,"confidence":null,"noul":0.08},
                    "target": {"type":"choice","choice":"alpha","probabilities":{"alpha":0.97,"none":0.03},"confidence":0.97,"noul":null}
                }),
                error: None,
                floor_id: None,
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
                utterance_id: Some("clip-42".into()),
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
                turn_id: Some("turn-8".into()),
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
                turn_id: Some("turn-8".into()),
            },
        ),
        (
            "module_call",
            DebugEvent::ModuleCall {
                agent: "alpha".into(),
                call_id: "call-4".into(),
                name: "speak".into(),
                args: json!({"text":"The build passes."}),
                turn_id: Some("turn-8".into()),
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
                utterance_id: Some("clip-42".into()),
            },
        ),
        (
            "turn_end",
            DebugEvent::TurnEnd {
                agent: "alpha".into(),
                turn_id: "turn-8".into(),
                generation: 3,
                utterance_id: Some("clip-42".into()),
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
                floor_id: Some("floor-7".into()),
            },
        ),
        (
            "floor_request",
            DebugEvent::FloorRequest {
                agent: "alpha".into(),
                message: "The build passes.".into(),
                floor_id: Some("floor-7".into()),
            },
        ),
        (
            "floor_held",
            DebugEvent::FloorHeld {
                agent: "alpha".into(),
                message: "The build passes.".into(),
                floor_id: Some("floor-7".into()),
            },
        ),
        (
            "floor_gate",
            DebugEvent::FloorGate {
                agent: "alpha".into(),
                answer: "yes".into(),
                latency_ms: 41,
                floor_id: Some("floor-7".into()),
            },
        ),
        (
            "floor_rewrite",
            DebugEvent::FloorRewrite {
                agent: "alpha".into(),
                original: "The build passes.".into(),
                rewritten: "I have good news: the build passes.".into(),
                latency_ms: 127,
                floor_id: Some("floor-7".into()),
            },
        ),
        (
            "floor_released",
            DebugEvent::FloorReleased {
                agent: "alpha".into(),
                how: "quiet_after_hold".into(),
                floor_id: Some("floor-7".into()),
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
        (
            "jev_request_good_moment",
            DebugEvent::JevRequest {
                utterance_id: None,
                purpose: "good_moment".into(),
                state: json!({"queued_update":{"from_agent":"alpha","message":"The build passes."}}),
                floor_id: Some("floor-7".into()),
            },
        ),
        (
            "call_boundary",
            DebugEvent::CallBoundary {
                phase: "started".into(),
                call_id: "call-1".into(),
                reason: None,
            },
        ),
        (
            "call_boundary_ended",
            DebugEvent::CallBoundary {
                phase: "ended".into(),
                call_id: "call-1".into(),
                reason: Some("page_closed".into()),
            },
        ),
        (
            "jev_response_good_moment",
            DebugEvent::JevResponse {
                utterance_id: None,
                purpose: "good_moment".into(),
                latency_ms: 1500,
                outcome: "timeout".into(),
                answers: json!({}),
                error: Some("Jev did not answer within 1500 ms".into()),
                floor_id: Some("floor-7".into()),
            },
        ),
        (
            "tool_end_error",
            DebugEvent::ToolEnd {
                agent: "alpha".into(),
                call_id: Some("call-4".into()),
                tool: "bash".into(),
                result: Some(json!({"content": [{"type": "text", "text": "exit status 1"}]})),
                error: Some("exit status 1".into()),
                turn_id: Some("turn-8".into()),
            },
        ),
        (
            "speech_undelivered",
            DebugEvent::Speech {
                agent: "alpha".into(),
                text: "The deploy finished.".into(),
                delivered: false,
                reason: Some("stale_generation".into()),
                floor_id: None,
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
        config: Some(owned.config),
    };
    let json: Value = serde_json::from_str(&snapshot.to_json(&owned.agents)).unwrap();
    assert_eq!(json, fixture.snapshot);
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

fn live_seq(outgoing: Option<Outgoing>) -> u64 {
    match outgoing {
        Some(Outgoing::Live(frame)) => frame.seq(),
        Some(Outgoing::Snapshot(snapshot)) => panic!("snapshot at {}", snapshot.last_seq),
        None => panic!("feed closed"),
    }
}

#[tokio::test]
async fn a_feed_skips_live_frames_its_snapshot_already_holds() {
    // A receiver subscribed before the snapshot was taken holds frames the
    // snapshot also has; each record must reach the client exactly once.
    let bus = DebugBus::new();
    let receiver = bus.subscribe_for_test();
    bus.publish(host_link(1));
    bus.publish(host_link(2));
    let snapshot = bus.snapshot();
    assert_eq!(snapshot.events.len(), 2);
    bus.publish(host_link(3));
    let mut feed = Feed {
        bus: bus.clone(),
        receiver,
        last_seq: snapshot.last_seq,
        last_resync: None,
    };
    assert_eq!(live_seq(within("feed", feed.next()).await), 3);
    bus.publish(host_link(4));
    assert_eq!(live_seq(within("feed", feed.next()).await), 4);
}

#[tokio::test]
async fn an_attached_feed_starts_exactly_after_its_snapshot() {
    let bus = DebugBus::new();
    bus.publish(host_link(1));
    let (mut feed, snapshot) = Feed::attach(bus.clone());
    assert_eq!(snapshot.last_seq, 1);
    bus.publish(host_link(2));
    assert_eq!(live_seq(within("feed", feed.next()).await), 2);
}

#[tokio::test]
async fn a_lagging_feed_resyncs_with_one_fresh_snapshot_and_no_stale_replay() {
    let bus = DebugBus::new();
    let (mut feed, _) = Feed::attach(bus.clone());
    let total = (LIVE_CAPACITY + 10) as u64;
    for n in 0..total as usize {
        bus.publish(host_link(n));
    }
    let Some(Outgoing::Snapshot(snapshot)) = within("feed", feed.next()).await else {
        panic!("expected a resync snapshot")
    };
    assert_eq!(snapshot.last_seq, total);
    assert_eq!(snapshot.events.len(), total as usize);
    bus.publish(host_link(0));
    assert_eq!(live_seq(within("feed", feed.next()).await), total + 1);
}

#[test]
fn the_log_layer_respects_the_filter_and_redacts_secret_fields() {
    let bus = DebugBus::new();
    {
        let _capture = capture_logs(&bus);
        tracing::info!(
            token = "abc",
            call_token = %"def",
            api_key = ?"ghi",
            Authorization = "Bearer jkl",
            password = "mno",
            client_secret = "pqr",
            jev_summary_token_budget = 300u64,
            elevenlabs_key_configured = true,
            project = "alpha",
            "kept"
        );
        tracing::debug!("below the filter");
        tracing::info!(target: "elsewhere", "outside the filter");
    }
    let snapshot = bus.snapshot();
    assert_eq!(snapshot.logs.len(), 1, "{:?}", snapshot.logs);
    let log = &snapshot.logs[0];
    assert_eq!((log.level.as_str(), log.message.as_str()), ("INFO", "kept"));
    assert!(log.target.starts_with("switchboard::"));
    for field in [
        "token",
        "call_token",
        "api_key",
        "Authorization",
        "password",
        "client_secret",
    ] {
        assert_eq!(log.fields[field], "[redacted]", "{field}");
    }
    assert_eq!(log.fields["jev_summary_token_budget"], 300);
    assert_eq!(log.fields["elevenlabs_key_configured"], true);
    assert_eq!(log.fields["project"], "alpha");
    let wire = LiveFrame::Log(log.clone()).to_json();
    for secret in ["abc", "def", "ghi", "jkl", "mno", "pqr"] {
        assert!(!wire.contains(secret), "{secret} leaked: {wire}");
    }
}

fn log_from(thread: &str) {
    tracing::info!(thread, "a line two threads log");
}

#[test]
fn a_capture_keeps_its_line_from_a_callsite_another_thread_reached_first() {
    let bus = DebugBus::new();
    {
        let _capture = capture_logs(&bus);
        std::thread::spawn(|| log_from("neighbour")).join().unwrap();
        log_from("capturing");
    }
    let threads: Vec<_> = bus
        .snapshot()
        .logs
        .iter()
        .map(|log| log.fields["thread"].clone())
        .collect();
    assert_eq!(threads, vec![json!("capturing")]);
}

#[test]
fn an_off_bus_records_nothing_until_it_is_enabled() {
    let bus = DebugBus::off();
    let (mut receiver, _) = bus.attach();
    assert_eq!(bus.publish(host_link(1)), 0);
    assert_eq!(
        bus.publish_log("INFO".into(), "t".into(), "m".into(), json!({})),
        0
    );
    {
        let _capture = capture_logs(&bus);
        tracing::info!("not copied");
    }
    let snapshot = bus.snapshot();
    assert_eq!(
        (
            snapshot.last_seq,
            snapshot.events.len(),
            snapshot.logs.len()
        ),
        (0, 0, 0)
    );
    assert!(snapshot.config.is_none());
    assert!(receiver.try_recv().is_err());

    let config = DebugConfig {
        jev_for_current_agent_lower: 0.1,
        jev_for_current_agent_upper: 0.9,
        jev_action_threshold: 0.5,
    };
    bus.enable(config.clone());
    assert_eq!(bus.publish(host_link(2)), 1);
    let snapshot = bus.snapshot();
    assert_eq!(snapshot.events.len(), 1);
    assert_eq!(snapshot.config, Some(config));
}

#[test]
fn a_ring_evicts_the_oldest_records_past_its_byte_budget() {
    let mut ring = Ring::new(10, 100);
    for n in 0..5 {
        ring.push(30, Arc::new(n));
    }
    // Three records of 30 fit in 100 bytes; the oldest went first.
    assert_eq!(ring.records(), [2, 3, 4].map(Arc::new).to_vec());
    assert_eq!(ring.bytes, 90);
    // A record over the whole budget is kept alone, and evicts the rest.
    ring.push(500, Arc::new(9));
    assert_eq!((ring.records(), ring.bytes), (vec![Arc::new(9)], 500));
    ring.push(1, Arc::new(10));
    assert_eq!((ring.records(), ring.bytes), (vec![Arc::new(10)], 1));
    let mut by_count = Ring::new(2, usize::MAX);
    for n in 0..3 {
        by_count.push(1, Arc::new(n));
    }
    assert_eq!(by_count.records(), [1, 2].map(Arc::new).to_vec());
}

#[tokio::test]
async fn a_feed_that_lags_twice_within_the_interval_is_closed() {
    let bus = DebugBus::new();
    let lag = |bus: &DebugBus| {
        for n in 0..LIVE_CAPACITY + 1 {
            bus.publish(host_link(n));
        }
    };
    let (mut feed, _) = Feed::attach(bus.clone());
    lag(&bus);
    assert!(matches!(
        within("feed", feed.next()).await,
        Some(Outgoing::Snapshot(_))
    ));
    // Behind again once the interval has passed: one more resync.
    feed.last_resync = Some(Instant::now() - RESYNC_INTERVAL - Duration::from_millis(1));
    lag(&bus);
    assert!(matches!(
        within("feed", feed.next()).await,
        Some(Outgoing::Snapshot(_))
    ));
    // Behind again within it: closed.
    lag(&bus);
    assert!(within("feed", feed.next()).await.is_none());
}

#[test]
fn the_publish_guard_is_restored_after_a_panic() {
    let bus = DebugBus::new();
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        bus.locked(|_| panic!("inside the publish lock"));
    }));
    assert!(panicked.is_err());
    assert!(!PUBLISHING.with(Cell::get));
}

#[test]
fn an_unclipped_record_is_sent_without_a_clipped_flag() {
    let bus = DebugBus::new();
    bus.publish(host_link(1));
    let snapshot = bus.snapshot();
    assert!(!snapshot.events[0].clipped);
    let frame: Value =
        serde_json::from_str(&LiveFrame::Event(snapshot.events[0].clone()).to_json()).unwrap();
    assert!(frame.get("clipped").is_none());
}

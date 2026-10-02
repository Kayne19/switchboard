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
                how: "quiet".into(),
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

#[test]
fn one_record_cannot_exceed_the_size_bounds() {
    let bus = DebugBus::new();
    let huge = "é".repeat(MAX_FIELD_BYTES); // two bytes per char
    bus.publish(DebugEvent::UtilityRequest {
        utterance_id: "u".into(),
        attempt: "first".into(),
        prompt: huge.clone(),
    });
    let wide: serde_json::Map<String, Value> = (0..1_000)
        .map(|n| (format!("k{n}"), Value::String(huge.clone())))
        .collect();
    bus.publish(DebugEvent::ToolEnd {
        agent: "alpha".into(),
        call_id: None,
        tool: "bash".into(),
        result: Some(json!({"items": vec![1; 1_000], "wide": wide})),
        error: None,
        turn_id: None,
    });
    bus.publish(host_link(1));
    bus.publish_log("INFO".into(), "t".into(), huge.clone(), json!({"f": huge}));
    let snapshot = bus.snapshot();
    let DebugEvent::UtilityRequest { prompt, .. } = &snapshot.events[0].event else {
        panic!("utility request")
    };
    assert!(snapshot.events[0].clipped);
    assert!(prompt.ends_with(CLIP_MARKER));
    assert!(prompt.len() <= MAX_FIELD_BYTES + CLIP_MARKER.len());
    assert!(snapshot.events[1].clipped);
    let size = serde_json::to_string(snapshot.events[1].as_ref())
        .unwrap()
        .len();
    assert!(
        size < MAX_RECORD_BYTES * 2,
        "tool result record is {size} bytes"
    );
    assert!(!snapshot.events[2].clipped);
    let frame: Value =
        serde_json::from_str(&LiveFrame::Event(snapshot.events[2].clone()).to_json()).unwrap();
    assert!(frame.get("clipped").is_none());
    assert!(snapshot.logs[0].clipped);
    assert!(snapshot.logs[0].message.ends_with(CLIP_MARKER));
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
    };
    assert_eq!(live_seq(feed.next().await), 3);
    bus.publish(host_link(4));
    assert_eq!(live_seq(feed.next().await), 4);
}

#[tokio::test]
async fn an_attached_feed_starts_exactly_after_its_snapshot() {
    let bus = DebugBus::new();
    bus.publish(host_link(1));
    let (mut feed, snapshot) = Feed::attach(bus.clone());
    assert_eq!(snapshot.last_seq, 1);
    bus.publish(host_link(2));
    assert_eq!(live_seq(feed.next().await), 2);
}

#[tokio::test]
async fn a_lagging_feed_resyncs_with_one_fresh_snapshot_and_no_stale_replay() {
    let bus = DebugBus::new();
    let (mut feed, _) = Feed::attach(bus.clone());
    let total = (LIVE_CAPACITY + 10) as u64;
    for n in 0..total as usize {
        bus.publish(host_link(n));
    }
    let Some(Outgoing::Snapshot(snapshot)) = feed.next().await else {
        panic!("expected a resync snapshot")
    };
    assert_eq!(snapshot.last_seq, total);
    assert_eq!(snapshot.events.len(), total as usize);
    bus.publish(host_link(0));
    assert_eq!(live_seq(feed.next().await), total + 1);
}

mod wire {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as Wire;

    async fn next_json(
        socket: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) -> Value {
        loop {
            let message = timeout(Duration::from_secs(5), socket.next())
                .await
                .expect("frame in time")
                .expect("open socket")
                .expect("frame");
            if let Wire::Text(text) = message {
                return serde_json::from_str(&text).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn the_debug_socket_sends_a_snapshot_then_live_frames_then_closes_on_shutdown() {
        let bus = DebugBus::new();
        bus.publish(host_link(1));
        bus.publish_log("INFO".into(), "t".into(), "before".into(), json!({}));
        let (shutdown, shutdown_rx) = watch::channel(false);
        let agents = || {
            vec![AgentState {
                project: "alpha".into(),
                state: "idle".into(),
                pending_request: None,
            }]
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = router(bus.clone(), agents, shutdown_rx);
        let server = tokio::spawn(async move { axum::serve(listener, app).await });

        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}/ws"))
            .await
            .unwrap();
        let snapshot = next_json(&mut socket).await;
        assert_eq!(snapshot["type"], "snapshot");
        assert_eq!(snapshot["last_seq"], 2);
        assert_eq!(snapshot["events"][0]["kind"], "host_link");
        assert_eq!(snapshot["logs"][0]["message"], "before");
        assert_eq!(snapshot["agents"][0]["project"], "alpha");

        bus.publish(host_link(3));
        bus.publish_log("INFO".into(), "t".into(), "after".into(), json!({}));
        let event = next_json(&mut socket).await;
        assert_eq!(
            (event["type"].clone(), event["seq"].clone()),
            (json!("event"), json!(3))
        );
        assert_eq!(event["host"], "host-3");
        let log = next_json(&mut socket).await;
        assert_eq!(
            (log["type"].clone(), log["seq"].clone()),
            (json!("log"), json!(4))
        );

        // Writes from the page are ignored; the socket is read-only.
        socket
            .send(Wire::Text("{\"type\":\"hangup\"}".into()))
            .await
            .unwrap();
        bus.publish(host_link(5));
        assert_eq!(next_json(&mut socket).await["seq"], 5);

        shutdown.send_replace(true);
        let closed = timeout(Duration::from_secs(5), async {
            loop {
                match socket.next().await {
                    Some(Ok(Wire::Close(_))) | None | Some(Err(_)) => return,
                    Some(Ok(_)) => {}
                }
            }
        })
        .await;
        assert!(closed.is_ok(), "the debug socket closes on shutdown");
        server.abort();
    }
}

#[test]
fn the_log_layer_respects_the_filter_and_redacts_secret_fields() {
    use tracing_subscriber::{layer::SubscriberExt, EnvFilter};
    let bus = DebugBus::new();
    let subscriber = tracing_subscriber::registry()
        .with(EnvFilter::new("switchboard=info"))
        .with(DebugLogLayer::new(bus.clone()));
    tracing::subscriber::with_default(subscriber, || {
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
    });
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
        assert_eq!(log.fields[field], REDACTED, "{field}");
    }
    assert_eq!(log.fields["jev_summary_token_budget"], 300);
    assert_eq!(log.fields["elevenlabs_key_configured"], true);
    assert_eq!(log.fields["project"], "alpha");
    let wire = LiveFrame::Log(log.clone()).to_json();
    for secret in ["abc", "def", "ghi", "jkl", "mno", "pqr"] {
        assert!(!wire.contains(secret), "{secret} leaked: {wire}");
    }
}

#[test]
fn credentials_are_scrubbed_from_text() {
    assert_eq!(
        scrub_text("API_KEY=abc123 and token: \"xyz.789\" ok"),
        "API_KEY=[redacted] and token: \"[redacted]\" ok"
    );
    assert_eq!(
        scrub_text("Authorization: Bearer eyJhbGci.payload.sig"),
        "Authorization: [redacted] [redacted]"
    );
    assert_eq!(scrub_text("Bearer abc.def end"), "Bearer [redacted] end");
    assert_eq!(
        scrub_text("use ghp_0123456789abcdefABCDEF now"),
        "use [redacted] now"
    );
    assert_eq!(scrub_text("max tokens: 500"), "max tokens: 500");
    assert_eq!(scrub_text("the key idea"), "the key idea");
}

#[test]
fn secret_names_match_whole_key_parts_only() {
    for name in [
        "token",
        "call_token",
        "api_key",
        "apiKey",
        "Authorization",
        "client_secret",
        "KEY",
        "x-api-keys",
    ] {
        assert!(secret_name(name), "{name}");
    }
    for name in ["keyboard", "monkey", "project", "path"] {
        assert!(!secret_name(name), "{name}");
    }
}

#[test]
fn published_events_are_scrubbed_before_they_are_kept() {
    let bus = DebugBus::new();
    bus.publish(DebugEvent::ToolStart {
        agent: "alpha".into(),
        call_id: None,
        tool: "bash".into(),
        args: Some(json!({
            "call_token": "t-1",
            "input_tokens": 12,
            "nested": [{"password": "p"}, "SECRET=s"],
            "path": "/srv/a"
        })),
        turn_id: None,
    });
    bus.publish(DebugEvent::AgentInput {
        agent: "alpha".into(),
        turn_id: None,
        text: "deploy with GITHUB_TOKEN=ghp_0123456789abcdefABCDEF".into(),
        source: "caller".into(),
        utterance_id: None,
    });
    let snapshot = bus.snapshot();
    let DebugEvent::ToolStart { args, .. } = &snapshot.events[0].event else {
        panic!("tool start")
    };
    assert_eq!(
        args.as_ref().unwrap(),
        &json!({
            "call_token": "[redacted]",
            "input_tokens": 12,
            "nested": [{"password": "[redacted]"}, "SECRET=[redacted]"],
            "path": "/srv/a"
        })
    );
    // Scrubbing alone does not mark a record clipped.
    assert!(!snapshot.events[0].clipped);
    let DebugEvent::AgentInput { text, .. } = &snapshot.events[1].event else {
        panic!("agent input")
    };
    assert_eq!(text, "deploy with GITHUB_TOKEN=[redacted]");
}

#[test]
fn private_key_blocks_are_redacted_whole() {
    let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nAAAAMwAAAAtzc2gtZWQyNTUxOQ\n-----END OPENSSH PRIVATE KEY-----";
    assert_eq!(
        scrub_text(&format!("$ cat id_ed25519\n{key}\n$ ")),
        "$ cat id_ed25519\n[redacted]\n$ "
    );
    for label in [
        "RSA PRIVATE KEY",
        "PRIVATE KEY",
        "EC PRIVATE KEY",
        "ENCRYPTED PRIVATE KEY",
    ] {
        let block = format!("-----BEGIN {label}-----\nMIIEow\n-----END {label}-----");
        assert_eq!(
            scrub_text(&format!("a {block} b")),
            "a [redacted] b",
            "{label}"
        );
    }
    // A block cut before its end is redacted to the end of the text.
    assert_eq!(
        scrub_text("key:\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC"),
        "key:\n[redacted]"
    );
    // A public certificate is not a secret.
    let cert = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    assert_eq!(scrub_text(cert), cert);
}

#[test]
fn credentials_with_a_known_shape_are_redacted() {
    let secrets = [
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        "AKIAIOSFODNN7EXAMPLE",
        "ASIAY34FZKBOKMUTVV7A",
        "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
        "hf_aBcDeFgHiJkLmNoPqRsTuVwXyZ01234567",
        "xoxb-1234567890-0987654321-AbCdEfGhIjKl",
        "xoxp-1234567890-0987654321-AbCdEfGhIjKl",
        "ghp_0123456789abcdefABCDEF0123456789ab",
        "gho_0123456789abcdefABCDEF0123456789ab",
        "ghu_0123456789abcdefABCDEF0123456789ab",
        "ghs_0123456789abcdefABCDEF0123456789ab",
        "ghr_0123456789abcdefABCDEF0123456789ab",
        "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
        "sk-proj-0123456789abcdefABCDEF",
        "sk-ant-api03-0123456789abcdef",
        concat!("glp", "at-0123456789abcdefABCD"),
        "npm_0123456789abcdefABCDEF0123456789ab",
        // No known prefix, but long and random: an opaque bearer token.
        "Zx8Qp2Lk9Vw3Rt7Ym4Nb6Hc1Jd5Fg0Ks2Pq9",
    ];
    for secret in secrets {
        assert_eq!(
            scrub_text(&format!("got {secret} back")),
            "got [redacted] back",
            "{secret}"
        );
    }
}

#[test]
fn ordinary_words_and_digests_are_kept() {
    for text in [
        "sk-learn is installed",
        "commit a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 landed",
        "id 550e8400-e29b-41d4-a716-446655440000",
        "handleDecisionForStateWithUtterance2 returned",
        "test_debug_published_events_are_scrubbed_before_they_are_kept",
        "AKIA is a prefix",
        "eyJhbGciOiJIUzI1NiJ9 alone",
        "the key idea",
    ] {
        assert_eq!(scrub_text(text), text);
    }
}

#[test]
fn a_secret_named_value_is_redacted_whatever_its_type() {
    let mut clip = Clip::new();
    let mut value = json!({
        "password": ["hunter2"],
        "client_secret": {"value": "s"},
        "pin_token": 987654321,
        "api_key": "k",
        "input_tokens": 12,
        "jev_summary_token_budget": 300,
        "key_configured": true,
        "token": null,
        "path": "/srv/a"
    });
    clip.json(&mut value);
    assert_eq!(
        value,
        json!({
            "password": "[redacted]",
            "client_secret": "[redacted]",
            "pin_token": "[redacted]",
            "api_key": "[redacted]",
            "input_tokens": 12,
            "jev_summary_token_budget": 300,
            "key_configured": true,
            "token": null,
            "path": "/srv/a"
        })
    );
}

#[test]
fn names_and_ids_are_scrubbed_too() {
    let bus = DebugBus::new();
    let secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
    bus.publish(DebugEvent::OperatorRouteTool {
        utterance_id: "u".into(),
        target: secret.into(),
        mode: "fresh".into(),
        action: "transfer".into(),
    });
    bus.publish(DebugEvent::Routed {
        utterance_id: "u".into(),
        to_agent: secret.into(),
        text_part: "t".into(),
        mode: "fresh".into(),
        via: "operator".into(),
    });
    bus.publish(DebugEvent::ModuleCall {
        agent: "alpha".into(),
        call_id: secret.into(),
        name: secret.into(),
        args: json!({}),
        turn_id: None,
    });
    bus.publish(DebugEvent::ToolEnd {
        agent: "alpha".into(),
        call_id: Some(secret.into()),
        tool: secret.into(),
        result: None,
        error: None,
        turn_id: Some(secret.into()),
    });
    for record in bus.snapshot().events {
        let wire = serde_json::to_string(record.as_ref()).unwrap();
        assert!(!wire.contains(secret), "leaked: {wire}");
    }
}

#[test]
fn names_ids_and_keys_are_cut_and_a_record_has_a_hard_size() {
    let bus = DebugBus::new();
    let long = "n".repeat(100_000);
    let mut args = serde_json::Map::new();
    args.insert("k".repeat(1 << 20), json!("v"));
    bus.publish(DebugEvent::ModuleCall {
        agent: long.clone(),
        call_id: long.clone(),
        name: long.clone(),
        args: Value::Object(args),
        turn_id: Some(long.clone()),
    });
    // Deep and wide JSON, every string at the field bound.
    let field = "x".repeat(MAX_FIELD_BYTES * 2);
    let mut deep = json!(field);
    for _ in 0..100 {
        deep = json!([deep.clone(), {"a": field, "b": [field, field]}]);
    }
    bus.publish(DebugEvent::ToolEnd {
        agent: "alpha".into(),
        call_id: None,
        tool: "bash".into(),
        result: Some(deep),
        error: Some(field.clone()),
        turn_id: None,
    });
    let snapshot = bus.snapshot();
    let DebugEvent::ModuleCall {
        call_id,
        name,
        args,
        ..
    } = &snapshot.events[0].event
    else {
        panic!("module call")
    };
    assert!(snapshot.events[0].clipped);
    assert!(call_id.len() <= MAX_NAME_BYTES + CLIP_MARKER.len());
    assert!(name.ends_with(CLIP_MARKER));
    let key = args.as_object().unwrap().keys().next().unwrap();
    assert!(
        key.len() <= MAX_NAME_BYTES + CLIP_MARKER.len(),
        "{}",
        key.len()
    );
    for record in &snapshot.events {
        let size = serde_json::to_string(record.as_ref()).unwrap().len();
        assert!(size < MAX_RECORD_BYTES * 2, "record is {size} bytes");
    }
}

#[test]
fn only_the_part_of_a_string_that_can_be_kept_is_scrubbed() {
    // A 16 MiB field costs what its kept prefix costs: the rest is never
    // scanned.
    let huge = "word ".repeat(16 << 20 >> 2);
    assert_eq!(
        scrub_window(&huge, MAX_FIELD_BYTES).len(),
        MAX_FIELD_BYTES + SCRUB_MARGIN
    );
    let mut text = huge;
    Clip::new().text(&mut text);
    assert!(text.len() <= MAX_FIELD_BYTES + CLIP_MARKER.len());
    // A credential that runs across the cut is still redacted up to it.
    let mut text = format!(
        "{}API_KEY={}",
        "a ".repeat((MAX_FIELD_BYTES - 10) / 2),
        "s".repeat(4 * MAX_FIELD_BYTES)
    );
    Clip::new().text(&mut text);
    assert!(!text.contains("sss"), "{}", &text[text.len() - 40..]);
}

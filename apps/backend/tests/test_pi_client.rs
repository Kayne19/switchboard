use super::*;

#[test]
fn builds_local_rpc_argv() {
    let args = local_argv(
        "pi",
        Some("anthropic/opus"),
        None,
        Some("catalog"),
        Some("/tmp/ext.ts"),
        &["--no-session".into()],
    )
    .unwrap();
    assert_eq!(&args[..3], ["pi", "--mode", "rpc"]);
    assert!(args.contains(&"--no-session".into()));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--system-prompt", "catalog"]));
}

#[test]
fn parses_sentinel_and_activity_detail() {
    assert_eq!(
        activity_detail(Some(&json!({"command":"  ls   -la  "}))),
        "ls -la"
    );
    assert_eq!(
        activity_detail(Some(&json!({"command":"x".repeat(100)}))).len(),
        83
    );
    let unicode = "é".repeat(100);
    let detail = activity_detail(Some(&json!({"command": unicode})));
    assert!(detail.chars().count() <= ACTIVITY_DETAIL_CHARS + 1);
}

#[test]
fn spoken_error_removes_diagnostics() {
    assert_eq!(
        spoken_error(Some(&json!(
            "OAuth failed url=https://example.test; details=secret"
        ))),
        "OAuth failed"
    );
    let unicode = spoken_error(Some(&json!("é".repeat(ERROR_DETAIL_CHARS + 10))));
    assert!(unicode.chars().count() <= ERROR_DETAIL_CHARS + 1);
    assert_eq!(spoken_error(None), "the model call failed");
}

#[tokio::test]
async fn limited_line_reader_caps_records_before_allocating_the_tail() {
    let mut reader = BufReader::with_capacity(3, &b"abcdef\nnext\n"[..]);
    assert_eq!(
        read_limited_line(&mut reader, 5).await.unwrap(),
        LimitedLine::TooLong
    );

    let mut exact = BufReader::with_capacity(2, &b"four\n"[..]);
    assert_eq!(
        read_limited_line(&mut exact, 5).await.unwrap(),
        LimitedLine::Line(b"four\n".to_vec())
    );
    assert_eq!(
        read_limited_line(&mut exact, 5).await.unwrap(),
        LimitedLine::Eof
    );

    let bounded = drain_bounded(&b"abcdefgh"[..], 5).await;
    assert_eq!(bounded.bytes, b"abcde");
    assert!(bounded.truncated);
}

#[tokio::test]
async fn steer_writes_into_the_running_process() {
    let script = "read first; read second; printf '%s\\n' '{\"type\":\"agent_settled\"}'";
    let session = Arc::new(
        PiSession::start(
            vec!["sh".into(), "-c".into(), script.into()],
            "test",
            "test-leg",
            None,
            None,
            Duration::from_secs(1),
            None,
        )
        .await
        .unwrap(),
    );
    let running = Arc::clone(&session);
    let prompt = tokio::spawn(async move { running.prompt("hello").await.unwrap() });
    for _ in 0..10 {
        if session.busy() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(session.busy());
    session.steer("also check docs").await.unwrap();
    assert!(!prompt.await.unwrap().failed);
    session.close().await;
}

#[tokio::test]
async fn process_prompt_collects_text_and_route_signal() {
    let script = "read line; printf '%s\n' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_end\",\"content\":\"Connecting.\"}}' '{\"type\":\"tool_execution_start\",\"toolName\":\"route\",\"args\":{\"target\":\"alpha\",\"mode\":\"fresh\"}}' '{\"type\":\"agent_settled\"}'";
    let session = PiSession::start(
        vec!["sh".into(), "-c".into(), script.into()],
        "test",
        "test-leg",
        None,
        None,
        Duration::from_secs(1),
        None,
    )
    .await
    .unwrap();
    let turn = session.prompt("hello").await.unwrap();
    assert_eq!(turn.text, "Connecting.");
    assert_eq!(turn.signals[0].name, ROUTE_TOOL);
    session.close().await;
}

#[tokio::test]
async fn first_text_delta_reports_agent_life_before_the_turn_settles() {
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = events.clone();
    let callback: ActivityCallback = Arc::new(move |activity| {
        let seen = seen.clone();
        Box::pin(async move {
            seen.lock().unwrap().push((activity.state, activity.tool));
        })
    });
    let script = "read line; printf '%s\\n' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"Hello\"}}' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_end\",\"content\":\"Hello\"}}' '{\"type\":\"agent_settled\"}'";
    let session = PiSession::start(
        vec!["sh".into(), "-c".into(), script.into()],
        "test",
        "test-leg",
        None,
        None,
        Duration::from_secs(1),
        Some(callback),
    )
    .await
    .unwrap();
    let turn = session.prompt("hello").await.unwrap();
    assert_eq!(turn.text, "Hello");
    assert_eq!(*events.lock().unwrap(), vec![("life".into(), "".into())]);
    session.close().await;
}

// A process that fails says why on stderr on its way out, and a drain task
// reads stderr while the turn reads stdout. A failure report must wait for
// the drain rather than read whatever it has reached, and must prefer what
// the process said to the broken pipe it left behind.

#[tokio::test]
async fn a_turn_whose_agent_exits_reports_what_it_said_after_its_output_closed() {
    // Output closes first, then the reason arrives: the order the drain can
    // lose on its own, fixed here so it always does.
    let script = "read line; exec 1>&-; sleep 0.3; echo 'pi: no API key for anthropic' >&2; exit 3";
    let session = PiSession::start(
        vec!["sh".into(), "-c".into(), script.into()],
        "test",
        "test-leg",
        None,
        None,
        Duration::from_secs(5),
        None,
    )
    .await
    .unwrap();
    let turn = session.prompt("hello").await.unwrap();
    assert!(turn.failed);
    assert_eq!(session.stderr_tail(5), "pi: no API key for anthropic");
    session.close().await;
}

#[tokio::test]
async fn a_prompt_the_agent_stopped_reading_reports_why_not_the_broken_pipe() {
    // The process stops reading, says why, and has not exited yet when the
    // prompt is written, so the write fails with a broken pipe.
    let script = "exec 0<&-; echo 'pi: unknown flag --mdoel' >&2; sleep 0.3; exit 2";
    let session = PiSession::start(
        vec!["sh".into(), "-c".into(), script.into()],
        "test",
        "test-leg",
        None,
        None,
        Duration::from_secs(5),
        None,
    )
    .await
    .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while session.stderr_tail(1).is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the process never wrote its error"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    match session.prompt("hello").await {
        Err(error) => assert_eq!(
            error.to_string(),
            "agent process is not running (pi: unknown flag --mdoel)"
        ),
        // A test on another thread that forks while this session is being
        // spawned holds a copy of the stdin pipe until it execs. Under load
        // that can outlast the wait above; then the write succeeds and the
        // failure arrives as the end of output instead, the other path the
        // reason has to survive.
        Ok(turn) => {
            assert!(turn.failed, "{turn:?}");
            assert_eq!(session.stderr_tail(5), "pi: unknown flag --mdoel");
        }
    }
    session.close().await;
}

#[tokio::test]
async fn broken_activity_callback_does_not_fail_the_turn() {
    let callback: ActivityCallback = Arc::new(|_| {
        Box::pin(async move {
            panic!("browser disappeared");
        })
    });
    let script = "read line; printf '%s\\n' '{\"type\":\"tool_execution_start\",\"toolName\":\"read\",\"args\":{\"path\":\"/tmp/x\"}}' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_end\",\"content\":\"done\"}}' '{\"type\":\"agent_settled\"}'";
    let session = PiSession::start(
        vec!["sh".into(), "-c".into(), script.into()],
        "test",
        "test-leg",
        None,
        None,
        Duration::from_secs(1),
        Some(callback),
    )
    .await
    .unwrap();
    let turn = session.prompt("hello").await.unwrap();
    assert_eq!(turn.text, "done");
    assert!(!turn.failed);
    session.close().await;
}

#[tokio::test]
async fn releasing_a_closed_taken_over_session_still_aborts_before_detaching() {
    let hosts = crate::hosts::Hosts::new(
        std::collections::HashMap::from([("scriptorium".to_owned(), "token".to_owned())]),
        crate::hosts::Heartbeat {
            interval: Duration::from_secs(60),
            missed_pong_limit: 3,
        },
    );
    let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut fake = crate::hosts::FakeHostAgent::new(Box::new(|_, _| vec![]));
    fake.on_command = Some(Box::new(move |name, _| {
        let _ = command_tx.send(name.to_owned());
        None
    }));
    let _log = fake.serve(hosts.connect_fake("scriptorium"));
    let inner = Arc::new(ProjectInner {
        hosts: hosts.clone(),
        host: "scriptorium".into(),
        session: "s1".into(),
        persistent_session_id: "saved-1".into(),
        instance_id: 1,
        label: "alpha".into(),
        provenance: "taken_over".into(),
        token: StdMutex::new("call-token".into()),
        turn_timeout: Duration::from_secs(1),
        on_activity: None,
        on_module: None,
        on_turn: None,
        on_closed: None,
        debug: None,
        turn_lock: Mutex::new(()),
        busy: AtomicBool::new(true),
        closed: AtomicBool::new(false),
        released: AtomicBool::new(false),
        brief: String::new(),
        brief_due: AtomicBool::new(false),
        turn: StdMutex::new(None),
        autonomous_turn: StdMutex::new(None),
        ignored_autonomous: StdMutex::new(None),
    });
    inner.mark_closed().await;
    ProjectSession { inner }.close();
    assert_eq!(command_rx.recv().await.as_deref(), Some("abort"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("detach"));
}

#[tokio::test]
async fn malformed_successful_takeover_is_detached() {
    let hosts = crate::hosts::Hosts::new(
        std::collections::HashMap::from([("scriptorium".to_owned(), "token".to_owned())]),
        crate::hosts::Heartbeat {
            interval: Duration::from_secs(60),
            missed_pong_limit: 3,
        },
    );
    let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut fake = crate::hosts::FakeHostAgent::new(Box::new(|_, _| vec![]));
    fake.on_command = Some(Box::new(move |name, _| {
        let _ = command_tx.send(name.to_owned());
        match name {
            "attach" => Some(Some(Ok(json!({})))),
            "detach" => Some(Some(Ok(json!({"detached": true})))),
            _ => None,
        }
    }));
    let _log = fake.serve(hosts.connect_fake("scriptorium"));
    let launch = ProjectLaunch {
        host: "scriptorium".into(),
        project: "alpha".into(),
        cwd: "/srv/alpha".into(),
        spec: "anthropic/current".into(),
        brief: String::new(),
        turn_timeout: Duration::from_secs(1),
        on_activity: None,
        on_module: None,
        on_turn: None,
        on_closed: None,
        debug: None,
    };
    let error = match ProjectSession::attach(&hosts, launch, "desk-alpha").await {
        Ok(_) => panic!("missing session handle is malformed success"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("did not name the new session"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("attach"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("detach"));
}

#[tokio::test]
async fn takeover_reply_cannot_make_release_kill_a_desk_session() {
    let hosts = crate::hosts::Hosts::new(
        std::collections::HashMap::from([("scriptorium".to_owned(), "token".to_owned())]),
        crate::hosts::Heartbeat {
            interval: Duration::from_secs(60),
            missed_pong_limit: 3,
        },
    );
    let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut fake = crate::hosts::FakeHostAgent::new(Box::new(|_, _| vec![]));
    fake.on_command = Some(Box::new(move |name, _| {
        let _ = command_tx.send(name.to_owned());
        if name == "attach" {
            return Some(Some(Ok(json!({
                "session":"desk-alpha", "session_id":"desk-saved", "project":"alpha",
                "cwd":"/srv/alpha", "provenance":"created", "busy":false,
                "turn_open":false, "model":"anthropic/current", "thinking":"medium",
                "call_mode":null, "last_text":null
            }))));
        }
        None
    }));
    let _log = fake.serve(hosts.connect_fake("scriptorium"));
    let launch = ProjectLaunch {
        host: "scriptorium".into(),
        project: "alpha".into(),
        cwd: "/srv/alpha".into(),
        spec: "anthropic/current".into(),
        brief: String::new(),
        turn_timeout: Duration::from_secs(1),
        on_activity: None,
        on_module: None,
        on_turn: None,
        on_closed: None,
        debug: None,
    };
    let (session, _) = ProjectSession::attach(&hosts, launch, "desk-alpha")
        .await
        .expect("valid attach reply");
    assert_eq!(session.inner.provenance, "taken_over");
    session.close();
    assert_eq!(command_rx.recv().await.as_deref(), Some("attach"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("abort"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("detach"));
}

fn debug_events(bus: &crate::debug::DebugBus) -> Vec<DebugEvent> {
    let crate::debug::DebugFrame::Snapshot { events, .. } = bus.snapshot(vec![]) else {
        panic!("snapshot");
    };
    events.iter().map(|record| record.event.clone()).collect()
}

#[tokio::test]
async fn operator_conversation_is_mirrored_to_the_debug_bus() {
    let script = "read line; printf '%s\\n' \
        '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"Hel\"}}' \
        '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"thinking_delta\",\"delta\":\"hidden\"}}' \
        '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"lo\"}}' \
        '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_end\",\"content\":\"Hello\"}}' \
        '{\"type\":\"tool_execution_start\",\"toolName\":\"route\",\"toolCallId\":\"c1\",\"args\":{\"target\":\"alpha\",\"api_key\":\"sk-live-123\"}}' \
        '{\"type\":\"tool_execution_end\",\"toolName\":\"route\",\"toolCallId\":\"c1\",\"isError\":true,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"no such project\"}]}}' \
        '{\"type\":\"agent_settled\"}'";
    let session = PiSession::start(
        vec!["sh".into(), "-c".into(), script.into()],
        "operator",
        "operator",
        None,
        None,
        Duration::from_secs(1),
        None,
    )
    .await
    .unwrap();
    let bus = crate::debug::DebugBus::new();
    session.observe(bus.clone());
    let turn = session
        .prompt_for("hi there", Some("clip-1"))
        .await
        .unwrap();
    assert_eq!(turn.text, "Hello");
    let turn_id = Some("operator-1".to_owned());
    assert_eq!(
        debug_events(&bus),
        vec![
            DebugEvent::AgentInput {
                agent: "operator".into(),
                turn_id: turn_id.clone(),
                text: "hi there".into(),
                source: "caller".into(),
                utterance_id: Some("clip-1".into()),
            },
            DebugEvent::AgentText {
                agent: "operator".into(),
                turn_id: turn_id.clone(),
                text: "Hello".into(),
                final_: false,
            },
            DebugEvent::ToolStart {
                agent: "operator".into(),
                call_id: Some("c1".into()),
                tool: "route".into(),
                args: Some(json!({"target": "alpha", "api_key": "[redacted]"})),
            },
            DebugEvent::ToolEnd {
                agent: "operator".into(),
                call_id: Some("c1".into()),
                tool: "route".into(),
                result: Some(json!({"content": [{"type": "text", "text": "no such project"}]})),
                error: Some("no such project".into()),
            },
            DebugEvent::AgentText {
                agent: "operator".into(),
                turn_id,
                text: "Hello".into(),
                final_: true,
            },
        ]
    );
    session.close().await;
}

#[tokio::test]
async fn utility_prompts_are_tagged_by_kind_and_numbered_per_process() {
    let script = "while read line; do printf '%s\\n' '{\"type\":\"agent_settled\"}'; done";
    let session = PiSession::start(
        vec!["sh".into(), "-c".into(), script.into()],
        "routing utility",
        "utility",
        None,
        None,
        Duration::from_secs(1),
        None,
    )
    .await
    .unwrap();
    let bus = crate::debug::DebugBus::new();
    session.observe(bus.clone());
    session.prompt("[JEV]\nwhere to?").await.unwrap();
    session
        .prompt("[FLOOR REWRITE]\nWork: alpha")
        .await
        .unwrap();
    let inputs: Vec<(Option<String>, String)> = debug_events(&bus)
        .into_iter()
        .filter_map(|event| match event {
            DebugEvent::AgentInput {
                agent,
                turn_id,
                source,
                utterance_id,
                ..
            } => {
                assert_eq!(agent, "utility");
                assert_eq!(utterance_id, None);
                Some((turn_id, source))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        inputs,
        vec![
            (Some("utility-1".into()), "routing_request".into()),
            (Some("utility-2".into()), "floor_rewrite".into()),
        ]
    );
    session.close().await;
}

#[tokio::test]
async fn an_unobserved_process_publishes_nothing_and_a_second_observe_is_ignored() {
    let script = "while read line; do printf '%s\\n' '{\"type\":\"agent_settled\"}'; done";
    let session = PiSession::start(
        vec!["sh".into(), "-c".into(), script.into()],
        "operator",
        "operator",
        None,
        None,
        Duration::from_secs(1),
        None,
    )
    .await
    .unwrap();
    session.prompt("before").await.unwrap();
    let first = crate::debug::DebugBus::new();
    let second = crate::debug::DebugBus::new();
    session.observe(first.clone());
    session.observe(second.clone());
    session.prompt("after").await.unwrap();
    assert_eq!(
        debug_events(&first).len(),
        1,
        "the input; an empty reply is not shown"
    );
    assert!(debug_events(&second).is_empty());
    session.close().await;
}

#[test]
fn streamed_text_goes_out_in_bounded_pieces() {
    let mut buffer = DeltaBuffer::default();
    assert_eq!(buffer.push("a"), None);
    assert_eq!(buffer.push(""), None);
    let piece = buffer.push(&"b".repeat(DELTA_FLUSH_BYTES)).unwrap();
    assert_eq!(piece.len(), DELTA_FLUSH_BYTES + 1);
    assert_eq!(buffer.take(), None);
    assert_eq!(buffer.push("c"), None);
    assert_eq!(buffer.take().as_deref(), Some("c"));
}

#[test]
fn tool_errors_and_prompt_sources_for_the_debug_page() {
    assert_eq!(tool_error_text(None), "the tool reported an error");
    assert_eq!(tool_error_text(Some(&json!("boom"))), "boom");
    assert_eq!(
        tool_error_text(Some(
            &json!({"content": [{"type": "text", "text": "x".repeat(600)}]})
        ))
        .chars()
        .count(),
        TOOL_ERROR_CHARS + 1
    );
    assert_eq!(
        local_prompt_source("operator", "[CALL STATE]\n..."),
        "caller"
    );
    assert_eq!(
        local_prompt_source("utility", "[FLOOR REWRITE]"),
        "floor_rewrite"
    );
    assert_eq!(
        local_prompt_source("utility", "anything"),
        "routing_request"
    );
}

fn debug_hosts() -> crate::hosts::Hosts {
    crate::hosts::Hosts::new(
        std::collections::HashMap::from([("scriptorium".to_owned(), "token".to_owned())]),
        crate::hosts::Heartbeat {
            interval: Duration::from_secs(60),
            missed_pong_limit: 3,
        },
    )
}

fn debug_launch(bus: &crate::debug::DebugBus, on_module: Option<ModuleCallback>) -> ProjectLaunch {
    ProjectLaunch {
        host: "scriptorium".into(),
        project: "alpha".into(),
        cwd: "/srv/alpha".into(),
        spec: "anthropic/current".into(),
        brief: "BRIEF".into(),
        turn_timeout: Duration::from_secs(5),
        on_activity: None,
        on_module,
        on_turn: None,
        on_closed: None,
        debug: Some(bus.clone()),
    }
}

#[tokio::test]
async fn project_conversation_is_mirrored_to_the_debug_bus() {
    use crate::hosts::Step;
    let hosts = debug_hosts();
    let mut fake = crate::hosts::FakeHostAgent::new(Box::new(|_, message| {
        if message.contains("second") {
            // An older host: tool events without args or results.
            return vec![
                Step::Event(json!({"kind": "tool_start", "tool": "read", "call_id": "t2"})),
                Step::Event(
                    json!({"kind": "tool_end", "tool": "read", "call_id": "t2", "error": false}),
                ),
            ];
        }
        vec![
            Step::Event(
                json!({"kind": "tool_start", "tool": "bash", "call_id": "t1", "args": {"command": "cargo test", "token": "abc"}}),
            ),
            Step::Event(
                json!({"kind": "tool_end", "tool": "bash", "call_id": "t1", "error": true, "result": {"content": [{"type": "text", "text": "1 failed"}]}}),
            ),
            Step::Event(json!({"kind": "text", "text": "Done.", "turn_id": "turn-1"})),
        ]
    }));
    fake.turn_ids = true;
    let _log = fake.serve(hosts.connect_fake("scriptorium"));
    let bus = crate::debug::DebugBus::new();
    let (session, _) = ProjectSession::create(&hosts, debug_launch(&bus, None))
        .await
        .unwrap();
    session.join_call("call-token", "", 1000).await.unwrap();
    let turn = session
        .prompt_as("first", "intro", Some("clip-9"))
        .await
        .unwrap();
    assert_eq!(turn.text, "Done.");
    session.prompt("second").await.unwrap();
    let agent = || "alpha".to_owned();
    assert_eq!(
        debug_events(&bus),
        vec![
            DebugEvent::AgentInput {
                agent: agent(),
                turn_id: None,
                text: "BRIEF".into(),
                source: "brief".into(),
                utterance_id: None,
            },
            DebugEvent::AgentInput {
                agent: agent(),
                turn_id: None,
                text: "first".into(),
                source: "intro".into(),
                utterance_id: Some("clip-9".into()),
            },
            DebugEvent::ToolStart {
                agent: agent(),
                call_id: Some("t1".into()),
                tool: "bash".into(),
                args: Some(json!({"command": "cargo test", "token": "[redacted]"})),
            },
            DebugEvent::ToolEnd {
                agent: agent(),
                call_id: Some("t1".into()),
                tool: "bash".into(),
                result: Some(json!({"content": [{"type": "text", "text": "1 failed"}]})),
                error: Some("1 failed".into()),
            },
            DebugEvent::AgentText {
                agent: agent(),
                turn_id: Some("turn-1".into()),
                text: "Done.".into(),
                final_: false,
            },
            DebugEvent::AgentText {
                agent: agent(),
                turn_id: Some("turn-1".into()),
                text: "Done.".into(),
                final_: true,
            },
            DebugEvent::AgentInput {
                agent: agent(),
                turn_id: None,
                text: "second".into(),
                source: "caller".into(),
                utterance_id: None,
            },
            DebugEvent::ToolStart {
                agent: agent(),
                call_id: Some("t2".into()),
                tool: "read".into(),
                args: None,
            },
            DebugEvent::ToolEnd {
                agent: agent(),
                call_id: Some("t2".into()),
                tool: "read".into(),
                result: None,
                error: None,
            },
        ]
    );
    session.close();
}

#[tokio::test]
async fn module_calls_and_their_answers_are_mirrored_without_the_token() {
    use crate::hosts::Step;
    let hosts = debug_hosts();
    let fake = crate::hosts::FakeHostAgent::new(Box::new(|_, _| {
        vec![
            Step::Call("speak", json!({"text": "The build passes."})),
            Step::CallWithToken("old-token".into(), "speak", json!({"text": "stale"})),
        ]
    }));
    let _log = fake.serve(hosts.connect_fake("scriptorium"));
    let bus = crate::debug::DebugBus::new();
    let on_module: ModuleCallback = Arc::new(|call: AgentCall| {
        Box::pin(async move {
            assert_eq!(call.call, "speak");
            json!({"status": "delivered", "reason": null})
        })
    });
    let (session, _) = ProjectSession::create(&hosts, debug_launch(&bus, Some(on_module)))
        .await
        .unwrap();
    session.join_call("call-token", "", 1000).await.unwrap();
    session.prompt("go").await.unwrap();
    let modules: Vec<DebugEvent> = debug_events(&bus)
        .into_iter()
        .filter(|event| {
            matches!(
                event,
                DebugEvent::ModuleCall { .. } | DebugEvent::ModuleResult { .. }
            )
        })
        .collect();
    assert_eq!(
        modules,
        vec![
            DebugEvent::ModuleCall {
                agent: "alpha".into(),
                call_id: "m1".into(),
                name: "speak".into(),
                args: json!({"text": "The build passes."}),
            },
            DebugEvent::ModuleResult {
                agent: "alpha".into(),
                call_id: "m1".into(),
                ok: true,
                detail: json!({"status": "delivered", "reason": null}),
            },
            DebugEvent::ModuleCall {
                agent: "alpha".into(),
                call_id: "m2".into(),
                name: "speak".into(),
                args: json!({"text": "stale"}),
            },
            DebugEvent::ModuleResult {
                agent: "alpha".into(),
                call_id: "m2".into(),
                ok: false,
                detail: json!({"status": "refused", "reason": "not_on_call"}),
            },
        ]
    );
    let serialized = serde_json::to_string(&modules).unwrap();
    assert!(!serialized.contains("call-token") && !serialized.contains("old-token"));
    session.close();
}

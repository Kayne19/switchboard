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

#[tokio::test]
async fn speak_requires_matching_successful_tool_end() {
    let script = "read line; printf '%s\\n' '{\"type\":\"tool_execution_start\",\"toolName\":\"speak\",\"toolCallId\":\"call-1\",\"args\":{\"text\":\"hello\"}}' '{\"type\":\"tool_execution_end\",\"toolName\":\"speak\",\"toolCallId\":\"call-other\",\"isError\":false}' '{\"type\":\"agent_settled\"}'";
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
    assert!(!turn.agent_spoke());
    session.close().await;
}

#[tokio::test]
async fn speak_tool_end_without_is_error_is_successful() {
    let script = "read line; printf '%s\\n' '{\"type\":\"tool_execution_start\",\"toolName\":\"speak\",\"toolCallId\":\"call-1\",\"args\":{\"text\":\"hello\"}}' '{\"type\":\"tool_execution_end\",\"toolName\":\"speak\",\"toolCallId\":\"call-1\"}' '{\"type\":\"agent_settled\"}'";
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
    assert!(turn.agent_spoke());
    session.close().await;
}

#[tokio::test]
async fn speak_tool_end_with_is_error_true_is_unsuccessful() {
    let script = "read line; printf '%s\\n' '{\"type\":\"tool_execution_start\",\"toolName\":\"speak\",\"toolCallId\":\"call-1\",\"args\":{\"text\":\"hello\"}}' '{\"type\":\"tool_execution_end\",\"toolName\":\"speak\",\"toolCallId\":\"call-1\",\"isError\":true}' '{\"type\":\"agent_settled\"}'";
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
    assert!(!turn.agent_spoke());
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
async fn releasing_a_taken_over_session_aborts_before_detaching() {
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
        label: "alpha".into(),
        provenance: "taken_over".into(),
        token: StdMutex::new("call-token".into()),
        turn_timeout: Duration::from_secs(1),
        on_activity: None,
        on_module: None,
        on_closed: None,
        turn_lock: Mutex::new(()),
        busy: AtomicBool::new(true),
        closed: AtomicBool::new(false),
        brief: String::new(),
        brief_due: AtomicBool::new(false),
        turn: StdMutex::new(None),
    });
    ProjectSession { inner }.close();
    assert_eq!(command_rx.recv().await.as_deref(), Some("abort"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("detach"));
}

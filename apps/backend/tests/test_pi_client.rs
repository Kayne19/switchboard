use super::*;
use crate::within;

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
    let bus = crate::debug::DebugBus::new();
    session.observe(bus.clone());
    let running = Arc::clone(&session);
    let prompt = tokio::spawn(async move { running.prompt("hello").await.unwrap() });
    for _ in 0..10 {
        if session.busy() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(session.busy());
    session
        .steer("also check docs", Some("clip-3"))
        .await
        .unwrap();
    assert!(!within("prompt", prompt).await.unwrap().failed);
    // The steered words name the caller line they carry.
    assert!(debug_events(&bus).iter().any(|event| matches!(
        event,
        DebugEvent::AgentInput { source, utterance_id: Some(id), .. }
            if source == "steer" && id == "clip-3"
    )));
    session.close().await;
}

#[tokio::test]
async fn a_cancelled_prompt_leaves_no_turn_for_the_next_prompt_to_read() {
    // The first prompt is answered late; every later one at once.
    let script = "read line; sleep 1; printf '%s\\n' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_end\",\"content\":\"first\"}}' '{\"type\":\"agent_settled\"}'; while read line; do printf '%s\\n' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_end\",\"content\":\"second\"}}' '{\"type\":\"agent_settled\"}'; done";
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
    // The floor rewrite's timeout, or a rescue aborting the turn task.
    assert!(
        tokio::time::timeout(Duration::from_millis(100), session.prompt("one"))
            .await
            .is_err()
    );
    assert!(
        !session.busy(),
        "a cancelled prompt must not leave the leg busy"
    );
    assert!(
        !session.alive().await,
        "a process left mid-turn must not be reused"
    );
    match session.prompt("two").await {
        Ok(turn) => panic!(
            "the next prompt read {:?} from the cancelled turn",
            turn.text
        ),
        Err(error) => assert!(error.to_string().contains("not running"), "{error}"),
    }
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

fn debug_events(bus: &crate::debug::DebugBus) -> Vec<DebugEvent> {
    bus.events_for_test()
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
                turn_id: turn_id.clone(),
            },
            DebugEvent::ToolEnd {
                agent: "operator".into(),
                call_id: Some("c1".into()),
                tool: "route".into(),
                result: Some(json!({"content": [{"type": "text", "text": "no such project"}]})),
                error: Some("no such project".into()),
                turn_id: turn_id.clone(),
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

// The local process's phases by event, as the operator and the routing
// utility see them through `busy()`, `alive()` and the next prompt: idle
// (not busy, alive), prompting (busy, alive) and gone (neither; the owner
// starts a fresh process). One row per (phase, event) pair a caller can
// reach. A turn that fails while prompting closes the process before the
// failure returns.

const SETTLE: &str = r#"{"type":"agent_settled"}"#;

fn text_end(content: &str) -> String {
    format!(
        r#"{{"type":"message_update","assistantMessageEvent":{{"type":"text_end","content":"{content}"}}}}"#
    )
}

/// A fake agent that answers every prompt with `answer` and settles.
fn answering(answer: &str) -> String {
    format!(
        "while read line; do printf '%s\\n' '{}' '{SETTLE}'; done",
        text_end(answer)
    )
}

async fn fake_agent(script: &str, turn_timeout: Duration) -> PiSession {
    PiSession::start(
        vec!["sh".into(), "-c".into(), script.into()],
        "test",
        "test-leg",
        None,
        None,
        turn_timeout,
        None,
    )
    .await
    .unwrap()
}

#[derive(Debug, PartialEq, Eq)]
enum Seen {
    Idle,
    Prompting,
    Gone,
}

async fn seen(session: &PiSession) -> Seen {
    match (session.busy(), session.alive().await) {
        (false, true) => Seen::Idle,
        (true, true) => Seen::Prompting,
        (false, false) => Seen::Gone,
        (true, false) => panic!("busy, and the process cannot take a prompt"),
    }
}

/// Starts a prompt in the background and waits until the process is
/// prompting.
async fn prompting(session: &PiSession) -> tokio::task::JoinHandle<Result<Turn, PiSessionError>> {
    let running = session.clone();
    let prompt = tokio::spawn(async move { running.prompt("first").await });
    within("the prompt to go out", async {
        while !session.busy() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    prompt
}

fn failed_with(result: Result<Turn, PiSessionError>, error: &str) {
    let turn = result.unwrap();
    assert!(turn.failed, "{turn:?}");
    assert_eq!(turn.error, error);
}

fn refused_with(result: Result<Turn, PiSessionError>, error: &str) {
    match result {
        Ok(turn) => panic!("a refused prompt was answered: {turn:?}"),
        Err(refused) => assert!(refused.to_string().contains(error), "{refused}"),
    }
}

#[tokio::test]
async fn idle_and_prompt_the_agent_settles_back_to_idle() {
    let session = fake_agent(&answering("hi"), Duration::from_secs(5)).await;
    assert_eq!(seen(&session).await, Seen::Idle);
    assert_eq!(session.prompt("one").await.unwrap().text, "hi");
    assert_eq!(seen(&session).await, Seen::Idle);
    assert_eq!(session.prompt("two").await.unwrap().text, "hi");
    session.close().await;
}

#[tokio::test]
async fn idle_and_steer_is_refused_and_stays_idle() {
    let session = fake_agent(&answering("hi"), Duration::from_secs(5)).await;
    let refused = session.steer("also", None).await.unwrap_err();
    assert_eq!(refused.to_string(), "agent turn is no longer running");
    assert_eq!(seen(&session).await, Seen::Idle);
    session.close().await;
}

#[tokio::test]
async fn idle_and_close_is_gone_and_refuses_prompt_steer_and_a_second_close() {
    let session = fake_agent(&answering("hi"), Duration::from_secs(5)).await;
    session.close().await;
    assert_eq!(seen(&session).await, Seen::Gone);
    refused_with(session.prompt("one").await, "agent process is not running");
    let refused = session.steer("also", None).await.unwrap_err();
    assert!(
        refused.to_string().contains("agent process is not running"),
        "{refused}"
    );
    session.close().await;
    assert_eq!(seen(&session).await, Seen::Gone);
}

/// A `close` that finds the process already `Closed` (another path entered
/// it and has not started its release yet: its `transition` and its first
/// lock are two steps another thread can run between) still returns only
/// once the process is gone.
#[tokio::test]
async fn closed_and_close_before_the_release_has_started_still_ends_the_process() {
    let session = fake_agent(&answering("hi"), Duration::from_secs(5)).await;
    // Enter `Closed` the way another path does, and hold its release back.
    assert_eq!(
        session.transition(ProcessEvent::Close),
        Some(Teardown::Release)
    );
    assert!(session.inner.child.lock().await.is_some());
    within("the close", session.close()).await;
    assert!(
        session.inner.child.lock().await.is_none(),
        "close returned while the process still ran"
    );
    assert!(session.inner.stdin.lock().await.is_none());
}

#[tokio::test]
async fn idle_and_the_agent_exits_on_its_own_is_gone_and_refuses_the_next_prompt() {
    let session = fake_agent("exit 0", Duration::from_secs(5)).await;
    within("the process to exit", async {
        while session.alive().await {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert_eq!(seen(&session).await, Seen::Gone);
    refused_with(session.prompt("one").await, "agent process is not running");
    session.close().await;
}

#[tokio::test]
async fn prompting_and_the_turn_deadline_passes_closes_before_the_failure_returns() {
    let session = fake_agent("read line; sleep 30", Duration::from_millis(200)).await;
    let prompt = prompting(&session).await;
    assert_eq!(seen(&session).await, Seen::Prompting);
    failed_with(
        within("the timed-out prompt", prompt).await.unwrap(),
        "the agent stopped responding",
    );
    assert_eq!(seen(&session).await, Seen::Gone);
    refused_with(session.prompt("two").await, "agent process is not running");
}

#[tokio::test]
async fn prompting_and_an_oversized_line_closes_before_the_failure_returns() {
    let size = STREAM_LIMIT + 1;
    let script = format!("read line; head -c {size} /dev/zero | tr '\\0' a; sleep 30");
    let session = fake_agent(&script, Duration::from_secs(5)).await;
    failed_with(
        within("the oversized prompt", session.prompt("one")).await,
        "the agent sent something too big to read",
    );
    assert_eq!(seen(&session).await, Seen::Gone);
}

#[tokio::test]
async fn prompting_and_too_much_text_closes_before_the_failure_returns() {
    // Two text ends that are each under the line limit and together over
    // the turn's text limit.
    let half = STREAM_LIMIT / 2 + 1;
    let line = format!(
        "printf '%s' '{{\"type\":\"message_update\",\"assistantMessageEvent\":{{\"type\":\"text_end\",\"content\":\"'; head -c {half} /dev/zero | tr '\\0' a; printf '%s\\n' '\"}}}}'"
    );
    let script = format!("read line; {line}; {line}; sleep 30");
    let session = fake_agent(&script, Duration::from_secs(5)).await;
    failed_with(
        within("the prompt with too much text", session.prompt("one")).await,
        "the agent produced too much text in one turn",
    );
    assert_eq!(seen(&session).await, Seen::Gone);
}

#[tokio::test]
async fn prompting_and_the_agent_exits_fails_the_turn_and_is_gone() {
    let session = fake_agent("read line; exit 0", Duration::from_secs(5)).await;
    let turn = within("the prompt", session.prompt("one")).await.unwrap();
    assert!(turn.failed, "{turn:?}");
    assert_eq!(seen(&session).await, Seen::Gone);
    refused_with(session.prompt("two").await, "agent process is not running");
    session.close().await;
}

#[tokio::test]
async fn prompting_and_the_agent_closes_its_output_but_runs_on_fails_the_turn_and_is_gone() {
    let session = fake_agent("read line; exec 1>&-; sleep 30", Duration::from_secs(5)).await;
    let turn = within("the prompt", session.prompt("one")).await.unwrap();
    assert!(turn.failed, "{turn:?}");
    // A process with no output left must not look idle: the next prompt
    // would go to it and fail the same way, and its owner would never
    // start a fresh one.
    assert_eq!(seen(&session).await, Seen::Gone);
    refused_with(session.prompt("two").await, "agent process is not running");
}

#[tokio::test]
async fn prompting_and_steer_is_written_into_the_turn() {
    let script = format!(
        "read first; read second; printf '%s\\n' '{}' '{SETTLE}'",
        text_end("steered")
    );
    let session = fake_agent(&script, Duration::from_secs(5)).await;
    let prompt = prompting(&session).await;
    session.steer("also", None).await.unwrap();
    let turn = within("the steered prompt", prompt).await.unwrap().unwrap();
    assert_eq!(turn.text, "steered");
    // This fake reads nothing more, so it exits once it has answered.
    session.close().await;
}

#[tokio::test]
async fn prompting_and_cancel_is_gone_and_the_next_prompt_is_refused() {
    let session = fake_agent("read line; sleep 30", Duration::from_secs(5)).await;
    let prompt = prompting(&session).await;
    prompt.abort();
    assert!(within("the aborted prompt", prompt)
        .await
        .unwrap_err()
        .is_cancelled());
    assert_eq!(seen(&session).await, Seen::Gone);
    refused_with(session.prompt("two").await, "agent process is not running");
    session.close().await;
}

#[tokio::test]
async fn prompting_and_close_ends_the_turn_failed_and_is_gone() {
    let session = fake_agent("read line; sleep 30", Duration::from_secs(5)).await;
    let prompt = prompting(&session).await;
    session.close().await;
    assert_eq!(seen(&session).await, Seen::Gone);
    let turn = within("the closed prompt", prompt).await.unwrap().unwrap();
    assert!(turn.failed, "{turn:?}");
    assert_eq!(seen(&session).await, Seen::Gone);
    refused_with(session.prompt("two").await, "agent process is not running");
}

#[test]
fn the_process_phase_table() {
    use ProcessEvent as Event;
    use ProcessState as State;
    let states = [
        State::Idle,
        State::Sending { turn: 1 },
        State::Prompting { turn: 1 },
        State::Abandoned,
        State::Closed,
    ];
    let mut events = vec![Event::Close];
    for turn in [1, 2] {
        events.extend([
            Event::Send { turn },
            Event::Unsent { turn },
            Event::Sent { turn },
            Event::Cancelled { turn },
        ]);
        for how in [TurnEnd::Settled, TurnEnd::Failed] {
            events.push(Event::Ended { turn, how });
        }
    }
    // Every row that moves the phase. Turn 2 is another prompt's event.
    let moves = [
        (
            State::Idle,
            Event::Send { turn: 1 },
            State::Sending { turn: 1 },
            None,
        ),
        (
            State::Idle,
            Event::Send { turn: 2 },
            State::Sending { turn: 2 },
            None,
        ),
        (
            State::Idle,
            Event::Close,
            State::Closed,
            Some(Teardown::Release),
        ),
        (
            State::Sending { turn: 1 },
            Event::Unsent { turn: 1 },
            State::Idle,
            None,
        ),
        (
            State::Sending { turn: 1 },
            Event::Sent { turn: 1 },
            State::Prompting { turn: 1 },
            None,
        ),
        (
            State::Sending { turn: 1 },
            Event::Cancelled { turn: 1 },
            State::Abandoned,
            Some(Teardown::CloseLater),
        ),
        (
            State::Sending { turn: 1 },
            Event::Close,
            State::Closed,
            Some(Teardown::Release),
        ),
        (
            State::Prompting { turn: 1 },
            Event::Ended {
                turn: 1,
                how: TurnEnd::Settled,
            },
            State::Idle,
            None,
        ),
        (
            State::Prompting { turn: 1 },
            Event::Ended {
                turn: 1,
                how: TurnEnd::Failed,
            },
            State::Closed,
            Some(Teardown::Release),
        ),
        (
            State::Prompting { turn: 1 },
            Event::Cancelled { turn: 1 },
            State::Abandoned,
            Some(Teardown::CloseLater),
        ),
        (
            State::Prompting { turn: 1 },
            Event::Close,
            State::Closed,
            Some(Teardown::Release),
        ),
        (
            State::Abandoned,
            Event::Close,
            State::Closed,
            Some(Teardown::Release),
        ),
    ];
    for state in states {
        for event in &events {
            let expected = moves
                .iter()
                .find(|(from, on, _, _)| *from == state && on == event)
                .map_or((state, None), |(_, _, to, teardown)| (*to, *teardown));
            assert_eq!(step(state, *event), expected, "{state:?} on {event:?}");
        }
    }
}

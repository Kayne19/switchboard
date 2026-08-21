use super::*;

#[cfg(unix)]
fn executable(root: &Path, name: &str, source: &str) -> std::path::PathBuf {
    let path = root.join(name);
    write_executable_script(&path, source);
    path
}

#[test]
fn ssh_options_injected_program_and_control_master_no() {
    let target = ValidatedSshTarget::new("user@remote.host").unwrap();
    let options = SshClientOptions::new("/usr/local/bin/custom-ssh", target)
        .with_control_path("/tmp/control.sock");

    let base_args = options.base_args();
    assert_eq!(options.ssh_program, "/usr/local/bin/custom-ssh");
    assert!(base_args.contains(&"ControlMaster=no".into()));
    assert!(base_args.contains(&"ControlPath=/tmp/control.sock".into()));

    let cat_argv = options.catalog_argv("pi");
    assert_eq!(cat_argv[0], "/usr/local/bin/custom-ssh");
    assert!(cat_argv.contains(&"ControlMaster=no".into()));

    let remote_args =
        options.remote_argv("/tmp", "pi", None, None, None, None, &[], &HashMap::new());
    assert_eq!(remote_args[0], "/usr/local/bin/custom-ssh");
    assert!(remote_args.contains(&"ControlMaster=no".into()));
}

#[test]
fn ssh_targets_are_validated_once_and_fail_closed() {
    assert!(ValidatedSshTarget::new("user@example.com").is_ok());
    for value in ["", "-oProxyCommand=x", "host name", "host;rm", "host\nname"] {
        assert!(
            ValidatedSshTarget::new(value).is_err(),
            "accepted {value:?}"
        );
        assert_eq!(
            remote_argv(
                value,
                "/tmp",
                "pi",
                None,
                None,
                None,
                None,
                &[],
                &HashMap::new()
            ),
            vec!["ssh-target-invalid"]
        );
    }
    assert_eq!(
        list_models_argv("pi", "host;rm"),
        vec!["ssh-target-invalid"]
    );
}

#[test]
fn quotes_shell_values_and_builds_remote_commands() {
    assert_eq!(shell_quote("a b; rm -rf /"), "'a b; rm -rf /'");
    let args = remote_argv(
        "host",
        "/tmp/a b; rm -rf /",
        "pi",
        None,
        None,
        None,
        None,
        &[],
        &HashMap::new(),
    );
    assert!(args.last().unwrap().contains("cd '/tmp/a b; rm -rf /'"));
    assert!(args.last().unwrap().contains("exec 'pi' '--mode' 'rpc'"));
}

#[test]
fn builds_local_rpc_argv() {
    let args = local_argv(
        "pi",
        Some("anthropic/opus"),
        None,
        Some("/tmp/ext.ts"),
        &["--no-session".into()],
    )
    .unwrap();
    assert_eq!(&args[..3], ["pi", "--mode", "rpc"]);
    assert!(args.contains(&"--no-session".into()));
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
async fn process_prompt_collects_text_signal_and_sentinel() {
    let script = "read line; printf '%s\\n' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_end\",\"content\":\"All done. [[SWITCHBOARD:RETURN]]\"}}' '{\"type\":\"agent_settled\"}'";
    let session = PiSession::start(
        vec!["sh".into(), "-c".into(), script.into()],
        "test",
        None,
        None,
        Duration::from_secs(1),
        None,
    )
    .await
    .unwrap();
    let turn = session.prompt("hello").await.unwrap();
    assert_eq!(turn.text, "All done.");
    assert_eq!(turn.signals[0].name, RETURN_TOOL);
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

#[cfg(unix)]
#[tokio::test]
async fn fake_ssh_executes_remote_rpc_command_with_callback_environment() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-fake-ssh-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let runtime = executable(
        &root,
        "fake pi",
        "read line\nprintf '%s\\n' \"{\\\"type\\\":\\\"message_update\\\",\\\"assistantMessageEvent\\\":{\\\"type\\\":\\\"text_end\\\",\\\"content\\\":\\\"$SWITCHBOARD_SESSION\\\"}}\" '{\"type\":\"agent_settled\"}'\n",
    );
    let ssh = executable(
        &root,
        "fake-ssh",
        "for arg in \"$@\"; do command=$arg; done\nexec sh -c \"$command\"\n",
    );
    let mut argv = remote_argv(
        "fake-host",
        &root.to_string_lossy(),
        &runtime.to_string_lossy(),
        None,
        None,
        None,
        Some("session-a"),
        &[],
        &HashMap::from([("SWITCHBOARD_SESSION".into(), "remote-test".into())]),
    );
    argv[0] = ssh.to_string_lossy().into_owned();
    let session = PiSession::start(
        argv,
        "remote-test",
        None,
        None,
        Duration::from_secs(1),
        None,
    )
    .await
    .unwrap();
    let turn = session.prompt("hello").await.unwrap();
    assert_eq!(turn.text, "remote-test");
    session.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

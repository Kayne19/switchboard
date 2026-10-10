use super::*;
use crate::within;

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
        ended_on_host: AtomicBool::new(false),
        brief: String::new(),
        brief_due: AtomicBool::new(false),
        turn: StdMutex::new(None),
        autonomous_turn: StdMutex::new(None),
        ignored_autonomous: StdMutex::new(None),
    });
    inner.mark_closed().await;
    ProjectSession { inner }.close();
    assert_eq!(
        within("command_rx", command_rx.recv()).await.as_deref(),
        Some("abort")
    );
    assert_eq!(
        within("command_rx", command_rx.recv()).await.as_deref(),
        Some("detach")
    );
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
    assert_eq!(
        within("command_rx", command_rx.recv()).await.as_deref(),
        Some("attach")
    );
    assert_eq!(
        within("command_rx", command_rx.recv()).await.as_deref(),
        Some("detach")
    );
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
    assert_eq!(
        within("command_rx", command_rx.recv()).await.as_deref(),
        Some("attach")
    );
    assert_eq!(
        within("command_rx", command_rx.recv()).await.as_deref(),
        Some("abort")
    );
    assert_eq!(
        within("command_rx", command_rx.recv()).await.as_deref(),
        Some("detach")
    );
}

fn debug_events(bus: &crate::debug::DebugBus) -> Vec<DebugEvent> {
    bus.events_for_test()
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
                json!({"kind": "tool_start", "tool": "bash", "call_id": "t1", "args": {"command": "cargo test", "token": "abc"}, "turn_id": "turn-1"}),
            ),
            Step::Event(
                json!({"kind": "tool_end", "tool": "bash", "call_id": "t1", "error": true, "result": {"content": [{"type": "text", "text": "1 failed"}]}, "turn_id": "turn-1"}),
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
                turn_id: Some("turn-1".into()),
            },
            DebugEvent::ToolEnd {
                agent: agent(),
                call_id: Some("t1".into()),
                tool: "bash".into(),
                result: Some(json!({"content": [{"type": "text", "text": "1 failed"}]})),
                error: Some("1 failed".into()),
                turn_id: Some("turn-1".into()),
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
                turn_id: None,
            },
            DebugEvent::ToolEnd {
                agent: agent(),
                call_id: Some("t2".into()),
                tool: "read".into(),
                result: None,
                error: None,
                turn_id: None,
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
                turn_id: None,
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
                turn_id: None,
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

/// The project session ends its turn on the `turn_end` that settles it, not
/// on the tail of an earlier, aborted turn that arrives first.
#[tokio::test]
async fn a_turn_ends_only_on_the_settled_turn_end() {
    let hosts = crate::hosts::Hosts::new(Default::default(), Default::default());
    let mut link = hosts.connect_fake("scriptorium");
    let creating = tokio::spawn({
        let hosts = hosts.clone();
        async move {
            ProjectSession::create(
                &hosts,
                ProjectLaunch {
                    host: "scriptorium".into(),
                    project: "alpha".into(),
                    cwd: "/srv/alpha".into(),
                    spec: String::new(),
                    brief: "BRIEF".into(),
                    turn_timeout: std::time::Duration::from_secs(10),
                    on_activity: None,
                    on_module: None,
                    on_turn: None,
                    on_closed: None,
                    debug: None,
                },
            )
            .await
        }
    });
    let reply = |link: &crate::hosts::FakeLink, command: &Value, result: Value| {
        link.send(json!({"type": "reply", "id": command["id"], "epoch": link.epoch, "ok": true, "result": result}));
    };
    let event = |link: &crate::hosts::FakeLink, cursor: u64, body: Value| {
        link.send(json!({"type": "event", "session": "s1", "cursor": format!("b:{cursor}"), "event": body}));
    };
    let create = within("link", link.recv()).await.unwrap();
    assert_eq!(create["name"], "create_session");
    reply(
        &link,
        &create,
        json!({"session": "s1", "thinking": "medium"}),
    );
    let (session, _) = within("creating", creating).await.unwrap().unwrap();

    let prompting = tokio::spawn({
        let session = session.clone();
        async move { session.prompt("hello").await }
    });
    let prompt = within("link", link.recv()).await.unwrap();
    assert_eq!(prompt["args"]["message"], "BRIEF\n\nhello");
    // The tail of an earlier, aborted turn arrives before the prompt is
    // answered; it is not this turn's.
    event(&link, 1, json!({"kind": "text", "text": "cut off"}));
    event(&link, 2, json!({"kind": "turn_end"}));
    reply(&link, &prompt, json!({"sent_as": "prompt"}));
    event(&link, 3, json!({"kind": "turn_start", "cause": "input"}));
    event(&link, 4, json!({"kind": "text", "text": "Done."}));
    event(
        &link,
        5,
        json!({"kind": "tool_end", "tool": "ipython", "call_id": "t1", "error": false}),
    );
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(!prompting.is_finished(), "the turn ended before it settled");
    assert!(session.busy());
    event(&link, 6, json!({"kind": "turn_end"}));
    let turn = within("prompting", prompting).await.unwrap().unwrap();
    assert_eq!(turn.text, "Done.");
    assert!(!turn.failed);
    assert!(!session.busy());
    session.close();
    let kill = within("link", link.recv()).await.unwrap();
    assert_eq!(
        (kill["name"].clone(), kill["args"].clone()),
        (json!("kill"), json!({"session": "s1"}))
    );
}

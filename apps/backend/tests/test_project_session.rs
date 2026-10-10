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
    let (subscription, _frames) = hosts.subscribe("scriptorium", "s1");
    let inner = Arc::new(ProjectInner {
        hosts: hosts.clone(),
        host: "scriptorium".into(),
        session: "s1".into(),
        persistent_session_id: "saved-1".into(),
        instance_id: 1,
        label: "alpha".into(),
        provenance: Provenance::TakenOver,
        token: StdMutex::new("call-token".into()),
        turn_timeout: Duration::from_secs(1),
        on_activity: None,
        on_module: None,
        on_turn: None,
        on_closed: None,
        debug: None,
        turn_lock: Mutex::new(()),
        busy: AtomicBool::new(true),
        lifecycle: StdMutex::new(Lifecycle::Open {
            _subscription: subscription,
        }),
        brief: String::new(),
        brief_due: AtomicBool::new(false),
        turn: StdMutex::new(None),
        autonomous_turn: StdMutex::new(None),
        ignored_autonomous: StdMutex::new(None),
    });
    inner.lose(LifecycleEvent::CommandFailed).await;
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
    assert_eq!(session.inner.provenance, Provenance::TakenOver);
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

/// How a project session came to the service, as the end-of-life table
/// below names it.
#[derive(Clone, Copy, Debug)]
enum Came {
    Created,
    TakenOver,
}

/// Where a session is in its end of life when a row's event arrives.
#[derive(Clone, Copy, Debug)]
enum EndPhase {
    /// In use.
    Open,
    /// A command to it failed.
    Unusable,
    /// The host reported it closed.
    EndedOnHost,
    /// Its owner closed it and its release went out.
    Released,
}

/// What happens to a session in a row of the end-of-life table.
#[derive(Clone, Copy, Debug)]
enum EndEvent {
    /// A command to it fails on the host.
    CommandFails,
    /// The host reports it closed (`session_closed`).
    HostEnds,
    /// Its owner closes it.
    OwnerCloses,
    /// Its last handle is dropped.
    LastHandleDrops,
}

/// One row of the end-of-life table: from `phase`, on `event`, the handle
/// is `alive` (unknown once dropped), the application has been told the
/// session closed `reports` times, the event sent `sent` to the host, and
/// a close (and drop) afterwards sends `then_close`.
struct EndRow {
    came: Came,
    phase: EndPhase,
    event: EndEvent,
    alive: Option<bool>,
    reports: usize,
    sent: &'static [&'static str],
    then_close: &'static [&'static str],
}

const KILL: &[&str] = &["kill"];
const DETACH: &[&str] = &["abort", "detach"];
const NONE: &[&str] = &[];

/// A row of the end-of-life table, in the table's column order.
fn row(
    came: Came,
    phase: EndPhase,
    event: EndEvent,
    alive: Option<bool>,
    reports: usize,
    sent: &'static [&'static str],
    then_close: &'static [&'static str],
) -> EndRow {
    EndRow {
        came,
        phase,
        event,
        alive,
        reports,
        sent,
        then_close,
    }
}

/// A project session's end of life (`docs/architecture.md`, "A project
/// session's end"), every phase against every event, for a session the
/// service created and one it took over from a desk. Columns: how it came,
/// the phase, the event; then alive, closed reports, sent by the event,
/// sent by a close afterwards.
fn end_table() -> Vec<EndRow> {
    use Came::*;
    use EndEvent::*;
    use EndPhase::*;
    let gone = None;
    vec![
        // Created: a release is a kill, owed until the host says the session is gone.
        row(Created, Open, CommandFails, Some(false), 1, NONE, KILL),
        row(Created, Open, HostEnds, Some(false), 1, NONE, NONE),
        row(Created, Open, OwnerCloses, Some(false), 0, KILL, NONE),
        row(Created, Open, LastHandleDrops, gone, 0, KILL, NONE),
        row(Created, Unusable, CommandFails, Some(false), 1, NONE, KILL),
        row(Created, Unusable, HostEnds, Some(false), 1, NONE, NONE),
        row(Created, Unusable, OwnerCloses, Some(false), 1, KILL, NONE),
        row(Created, Unusable, LastHandleDrops, gone, 1, KILL, NONE),
        row(
            Created,
            EndedOnHost,
            CommandFails,
            Some(false),
            1,
            NONE,
            NONE,
        ),
        row(Created, EndedOnHost, HostEnds, Some(false), 1, NONE, NONE),
        row(
            Created,
            EndedOnHost,
            OwnerCloses,
            Some(false),
            1,
            NONE,
            NONE,
        ),
        row(Created, EndedOnHost, LastHandleDrops, gone, 1, NONE, NONE),
        row(Created, Released, CommandFails, Some(false), 0, NONE, NONE),
        row(Created, Released, HostEnds, Some(false), 0, NONE, NONE),
        row(Created, Released, OwnerCloses, Some(false), 0, NONE, NONE),
        row(Created, Released, LastHandleDrops, gone, 0, NONE, NONE),
        // Taken over: a release is an abort then a detach, owed until it went out.
        row(TakenOver, Open, CommandFails, Some(false), 1, NONE, DETACH),
        row(TakenOver, Open, HostEnds, Some(false), 1, NONE, DETACH),
        row(TakenOver, Open, OwnerCloses, Some(false), 0, DETACH, NONE),
        row(TakenOver, Open, LastHandleDrops, gone, 0, DETACH, NONE),
        row(
            TakenOver,
            Unusable,
            CommandFails,
            Some(false),
            1,
            NONE,
            DETACH,
        ),
        row(TakenOver, Unusable, HostEnds, Some(false), 1, NONE, DETACH),
        row(
            TakenOver,
            Unusable,
            OwnerCloses,
            Some(false),
            1,
            DETACH,
            NONE,
        ),
        row(TakenOver, Unusable, LastHandleDrops, gone, 1, DETACH, NONE),
        row(
            TakenOver,
            EndedOnHost,
            CommandFails,
            Some(false),
            1,
            NONE,
            DETACH,
        ),
        row(
            TakenOver,
            EndedOnHost,
            HostEnds,
            Some(false),
            1,
            NONE,
            DETACH,
        ),
        row(
            TakenOver,
            EndedOnHost,
            OwnerCloses,
            Some(false),
            1,
            DETACH,
            NONE,
        ),
        row(
            TakenOver,
            EndedOnHost,
            LastHandleDrops,
            gone,
            1,
            DETACH,
            NONE,
        ),
        row(
            TakenOver,
            Released,
            CommandFails,
            Some(false),
            0,
            NONE,
            NONE,
        ),
        row(TakenOver, Released, HostEnds, Some(false), 0, NONE, NONE),
        row(TakenOver, Released, OwnerCloses, Some(false), 0, NONE, NONE),
        row(TakenOver, Released, LastHandleDrops, gone, 0, NONE, NONE),
    ]
}

/// A session for one row of the end-of-life table, on a fake host whose
/// `set_mode` always fails, with the release commands it is sent and the
/// application's session-closed reports counted.
struct EndRig {
    hosts: crate::hosts::Hosts,
    handle: &'static str,
    session: Option<ProjectSession>,
    commands: tokio::sync::mpsc::UnboundedReceiver<String>,
    reports: Arc<std::sync::atomic::AtomicUsize>,
}

impl EndRig {
    async fn new(came: Came) -> Self {
        let hosts = debug_hosts();
        let (command_tx, commands) = tokio::sync::mpsc::unbounded_channel();
        let mut fake = crate::hosts::FakeHostAgent::new(Box::new(|_, _| vec![]));
        fake.on_command = Some(Box::new(move |name, _| {
            let _ = command_tx.send(name.to_owned());
            (name == "set_mode").then(|| {
                Some(Err((
                    "daemon_error".to_owned(),
                    "refused for the test".to_owned(),
                )))
            })
        }));
        let _log = fake.serve(hosts.connect_fake("scriptorium"));
        let reports = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&reports);
        let on_closed: SessionClosedCallback = Arc::new(move |_, _, _| {
            counted.fetch_add(1, Ordering::AcqRel);
            Box::pin(async {}) as Pin<Box<dyn Future<Output = ()> + Send>>
        });
        let launch = ProjectLaunch {
            on_closed: Some(on_closed),
            ..debug_launch(&crate::debug::DebugBus::new(), None)
        };
        let (session, handle) = match came {
            Came::Created => (ProjectSession::create(&hosts, launch).await, "s1"),
            Came::TakenOver => (
                ProjectSession::attach(&hosts, launch, "desk-alpha").await,
                "desk-alpha",
            ),
        };
        let (session, _) = session.expect("the session opens");
        Self {
            hosts,
            handle,
            session: Some(session),
            commands,
            reports,
        }
    }

    fn session(&self) -> &ProjectSession {
        self.session.as_ref().expect("the handle is still held")
    }

    fn reports(&self) -> usize {
        self.reports.load(Ordering::Acquire)
    }

    /// The release commands (`kill`, `abort`, `detach`) sent since the last
    /// look: at least `expected` of them, then everything the host was sent
    /// before a marker command queued after them.
    async fn released(&mut self, expected: usize) -> Vec<String> {
        let mut sent = Vec::new();
        while sent.len() < expected {
            let name = within("a release command", self.commands.recv())
                .await
                .expect("the fake host is running");
            if matches!(name.as_str(), "kill" | "abort" | "detach") {
                sent.push(name);
            }
        }
        // A release is queued from a task spawned when it starts; the marker
        // is queued from one spawned after it, so it reaches the host last.
        let hosts = self.hosts.clone();
        let marker = tokio::spawn(async move {
            hosts
                .command("scriptorium", "marker", json!({}), Duration::from_secs(5))
                .await
        });
        within("the marker", marker)
            .await
            .expect("the marker task")
            .expect("the marker is answered");
        loop {
            let name = within("the marker command", self.commands.recv())
                .await
                .expect("the fake host is running");
            match name.as_str() {
                "marker" => return sent,
                "kill" | "abort" | "detach" => sent.push(name),
                _ => {}
            }
        }
    }

    /// Waits until the session's frame pump has stopped: it holds a weak
    /// reference to the session for as long as it runs.
    async fn pump_stopped(&self) {
        let inner = Arc::clone(&self.session().inner);
        within("the pump to stop", async move {
            while Arc::weak_count(&inner) > 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await;
    }

    async fn apply(&mut self, event: EndEvent) {
        match event {
            EndEvent::CommandFails => {
                let failed = self.session().set_mode("background").await;
                assert!(failed.is_err(), "set_mode fails on this host");
            }
            EndEvent::HostEnds => {
                self.hosts.send_fake(
                    "scriptorium",
                    json!({"type": "event", "session": self.handle, "cursor": "boot:900", "event": {"kind": "session_closed", "reason": "killed"}}),
                );
                // The host stops delivering the session's frames on its
                // `session_closed` (if it still did), so the pump has read it
                // once it has stopped.
                self.pump_stopped().await;
            }
            EndEvent::OwnerCloses => self.session().close(),
            EndEvent::LastHandleDrops => drop(self.session.take()),
        }
    }

    async fn reach(&mut self, phase: EndPhase, came: Came) {
        match phase {
            EndPhase::Open => {}
            EndPhase::Unusable => self.apply(EndEvent::CommandFails).await,
            EndPhase::EndedOnHost => self.apply(EndEvent::HostEnds).await,
            EndPhase::Released => {
                self.apply(EndEvent::OwnerCloses).await;
                let expected = match came {
                    Came::Created => KILL,
                    Came::TakenOver => DETACH,
                };
                assert_eq!(self.released(expected.len()).await, expected);
            }
        }
    }
}

#[tokio::test]
async fn a_project_session_ends_by_its_table() {
    for row in end_table() {
        let what = format!("{:?} {:?} on {:?}", row.came, row.phase, row.event);
        let mut rig = EndRig::new(row.came).await;
        rig.reach(row.phase, row.came).await;
        rig.apply(row.event).await;
        assert_eq!(
            rig.session.as_ref().map(ProjectSession::alive),
            row.alive,
            "{what}: alive"
        );
        assert_eq!(rig.reports(), row.reports, "{what}: closed reports");
        assert_eq!(rig.released(row.sent.len()).await, row.sent, "{what}: sent");
        if rig.session.is_some() {
            rig.apply(EndEvent::OwnerCloses).await;
            rig.apply(EndEvent::LastHandleDrops).await;
        }
        assert_eq!(
            rig.released(row.then_close.len()).await,
            row.then_close,
            "{what}: sent by a close afterwards"
        );
        assert_eq!(
            rig.reports(),
            row.reports,
            "{what}: closed reports at the end"
        );
    }
}

/// A session its host link took down reads no more of its frames. The host
/// agent keeps tracking the session through a link drop, so once the host
/// links again its frames, a replay say, still name it; a module call
/// carrying the token the closed handle had must be refused by the host
/// link, not answered by that handle.
#[tokio::test]
async fn a_session_whose_host_link_closed_reads_no_more_frames() {
    let hosts = debug_hosts();
    let fake = crate::hosts::FakeHostAgent::new(Box::new(|_, _| vec![]));
    let _log = fake.serve(hosts.connect_fake("scriptorium"));
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = Arc::clone(&calls);
    let on_module: ModuleCallback = Arc::new(move |_| {
        counted.fetch_add(1, Ordering::AcqRel);
        Box::pin(async { json!({"status": "delivered"}) })
            as Pin<Box<dyn Future<Output = Value> + Send>>
    });
    let launch = debug_launch(&crate::debug::DebugBus::new(), Some(on_module));
    let (session, _) = ProjectSession::create(&hosts, launch)
        .await
        .expect("the session opens");
    session
        .join_call("call-token", "", 1000)
        .await
        .expect("the session joins the call");

    hosts.disconnect_fake("scriptorium");
    within("the session to close", async {
        while session.alive() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await;
    let mut link = hosts.connect_fake("scriptorium");
    link.send(json!({
        "type": "module_call", "id": "m1", "session": "s1", "token": "call-token",
        "call": "speak", "args": {"text": "still here"},
    }));
    let reply = within("the module reply", link.recv())
        .await
        .expect("the link is up");

    assert_eq!(reply["type"], "module_reply", "{reply}");
    assert_eq!(reply["status"], "refused", "{reply}");
    assert_eq!(reply["reason"], "not_on_call", "{reply}");
    assert_eq!(
        calls.load(Ordering::Acquire),
        0,
        "the closed handle answered"
    );
}

use super::*;
use crate::hosts::{FakeHostAgent, Step};
use crate::pbx::{board_on, board_with, project, says, serve, transcript, two_model_catalog, HOST};
use crate::project_session::ProjectLaunch;
use crate::within;
use serde_json::json;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::time::Duration;

fn assert_background_registry_consistent(board: &Switchboard) {
    for (project, alive, _) in board.residents_for_test() {
        assert!(alive, "dead resident remains registered: {project}");
        assert!(board.coordinator().project_is_background(&project));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn direct_dial_reuses_a_background_resident_instead_of_creating_a_duplicate() {
    let mut board = board_on(
        vec![project("alpha", ""), project("beta", "")],
        &[],
        two_model_catalog(),
    );
    let log = serve(&board, Box::new(|_, _| says("ready")));
    assert_eq!(
        board.transfer_to(&transcript("alpha"), "alpha").await.route,
        "alpha"
    );
    board
        .start_background_part("beta", "beta work")
        .await
        .expect("background resident");
    let resident = board
        .background_agents
        .get("beta")
        .expect("beta resident")
        .clone();

    let reply = board.dial("beta", "").await;

    assert_eq!(reply.route, "beta");
    assert!(board
        .agent
        .as_ref()
        .is_some_and(|agent| agent.same_session(&resident)));
    assert_eq!(log.named("create_session").len(), 2, "dial must reuse beta");
    assert!(!board.background_agents.contains_key("beta"));
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn fresh_start_does_not_publish_idle_before_busy() {
    let mut board = board_with(vec![project("alpha", "")], false);
    let notices = Arc::new(StdMutex::new(Vec::<String>::new()));
    let notices_for_callback = notices.clone();
    board.set_agent_state_callback(Some(Arc::new(move |notice| {
        notices_for_callback
            .lock()
            .unwrap()
            .push(format!("{}:{}", notice.project, notice.state));
        Box::pin(async {})
    })));
    let _log = serve(&board, Box::new(|_, _| says("ready")));

    let reply = board.transfer_to(&transcript("start alpha"), "alpha").await;
    assert_eq!(reply.route, "alpha");
    assert_eq!(
        notices.lock().unwrap().first().map(String::as_str),
        Some("alpha:busy")
    );
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn background_prompt_transport_failure_evicts_the_resident_and_finishes() {
    let mut board = board_with(vec![project("alpha", "")], false);
    let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
    let finished_tx = Arc::new(StdMutex::new(Some(finished_tx)));
    let finished_for_callback = finished_tx.clone();
    board.set_agent_state_callback(Some(Arc::new(move |notice| {
        if notice.project == "alpha" && notice.state == AgentNotice::Finished {
            if let Some(tx) = finished_for_callback.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
        Box::pin(async {})
    })));
    let mut fake = FakeHostAgent::new(Box::new(|_, _| says("unused")));
    fake.on_command = Some(Box::new(|name, _| {
        (name == "prompt").then(|| Some(Err(("transport".into(), "host prompt failed".into()))))
    }));
    fake.serve(board.hosts().connect_fake(HOST));

    board
        .start_background_part("alpha", "background work")
        .await
        .expect("the resident launch itself succeeds");
    assert_background_registry_consistent(&board);
    within("finished_rx", finished_rx)
        .await
        .expect("failed prompt publishes finished");

    assert!(!board.background_agents.contains_key("alpha"));
    assert!(!board.coordinator.project_is_background("alpha"));
    board.shutdown().await;
}

#[tokio::test]
async fn dead_background_handle_is_evicted_after_registration_recheck() {
    let mut board = board_with(vec![project("alpha", "")], false);
    let fake = FakeHostAgent::new(Box::new(|_, _| vec![]));
    let _log = fake.serve(board.hosts().connect_fake(HOST));
    let launch = ProjectLaunch {
        host: HOST.into(),
        project: "alpha".into(),
        cwd: "/srv/alpha".into(),
        spec: "anthropic/current".into(),
        brief: String::new(),
        turn_timeout: Duration::from_secs(10),
        on_activity: None,
        on_module: None,
        on_turn: None,
        on_closed: None,
        debug: None,
    };
    let session = ProjectSession::create(&board.hosts(), launch)
        .await
        .unwrap()
        .0;
    // The fake dies synchronously after token registration and before map
    // insertion, exactly the window the helper must close.
    assert!(!board.register_background_session_with_fake_death("alpha".into(), session));
    assert!(!board.background_agents.contains_key("alpha"));
    assert!(!board.coordinator.project_is_background("alpha"));
    board.shutdown().await;
}

#[tokio::test]
async fn stale_host_loss_callback_after_resume_keeps_the_replacement_resident() {
    let mut board = board_with(vec![project("alpha", "")], false);
    let mut fake = FakeHostAgent::new(Box::new(|_, _| vec![Step::Hold]));
    fake.on_command = Some(Box::new(|name, args| match name {
        "create_session" => Some(Some(Ok(json!({
            "session": "s1",
            "session_id": "saved-alpha",
            "name": "sb-alpha-1",
            "project": "alpha",
            "cwd": "/srv/alpha",
            "provenance": "created",
            "model": "anthropic/current",
            "thinking": "medium"
        })))),
        "open_session" => Some(Some(Ok(json!({
            "session": "s2",
            "session_id": args["session_id"],
            "name": "sb-alpha-2",
            "project": "alpha",
            "cwd": "/srv/alpha",
            "provenance": "created",
            "model": "anthropic/current",
            "thinking": "medium"
        })))),
        _ => None,
    }));
    fake.serve(board.hosts().connect_fake(HOST));

    let launch = || ProjectLaunch {
        host: HOST.into(),
        project: "alpha".into(),
        cwd: "/srv/alpha".into(),
        spec: "anthropic/current".into(),
        brief: String::new(),
        turn_timeout: Duration::from_secs(10),
        on_activity: None,
        on_module: None,
        on_turn: None,
        on_closed: None,
        debug: None,
    };
    let old = ProjectSession::create(&board.hosts(), launch())
        .await
        .unwrap()
        .0;
    let replacement = ProjectSession::open(&board.hosts(), launch(), old.session_id())
        .await
        .unwrap()
        .0;
    assert_eq!(old.session_id(), replacement.session_id());
    assert_ne!(old.instance_id(), replacement.instance_id());

    assert!(board
        .background_agents
        .admit("alpha".into(), replacement.clone(), || {}));
    let callback = board.session_closed_callback();
    callback("alpha".into(), old.session_id().into(), old.instance_id()).await;

    let resident = board
        .background_agents
        .get("alpha")
        .expect("stale callback must not evict replacement");
    assert!(resident.same_session(&replacement));
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn host_loss_evicts_a_background_resident_without_a_later_action() {
    let mut board = board_with(vec![project("alpha", "")], false);
    let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
    let finished_tx = Arc::new(StdMutex::new(Some(finished_tx)));
    let finished_for_callback = finished_tx.clone();
    board.set_agent_state_callback(Some(Arc::new(move |notice| {
        if notice.project == "alpha" && notice.state == AgentNotice::Finished {
            if let Some(tx) = finished_for_callback.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
        Box::pin(async {})
    })));
    let fake = FakeHostAgent::new(Box::new(|_, _| vec![Step::Hold]));
    fake.serve(board.hosts().connect_fake(HOST));

    board
        .start_background_part("alpha", "background work")
        .await
        .expect("resident launch");
    assert_background_registry_consistent(&board);
    board.hosts().disconnect_fake(HOST);
    within("finished_rx", finished_rx)
        .await
        .expect("host loss publishes finished");

    assert!(!board.background_agents.contains_key("alpha"));
    assert!(!board.coordinator.project_is_background("alpha"));
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn stopped_background_prompt_cancels_without_a_late_idle_notice() {
    let mut board = board_on(vec![project("alpha", "")], &[], two_model_catalog());
    let entered = Arc::new(tokio::sync::Notify::new());
    let entered_for_prompt = entered.clone();
    let notices = Arc::new(StdMutex::new(Vec::<String>::new()));
    let notices_for_callback = notices.clone();
    board.set_agent_state_callback(Some(Arc::new(move |notice| {
        let notices = notices_for_callback.clone();
        Box::pin(async move {
            notices
                .lock()
                .unwrap()
                .push(format!("{}:{}", notice.project, notice.state));
        })
    })));
    let fake = FakeHostAgent::new(Box::new(move |_, _| {
        entered_for_prompt.notify_one();
        vec![Step::Hold]
    }));
    fake.serve(board.hosts().connect_fake(HOST));
    board
        .start_background_part("alpha", "background work")
        .await
        .expect("background resident");
    tokio::time::timeout(Duration::from_secs(1), entered.notified())
        .await
        .expect("background prompt started");
    let idle_before = notices
        .lock()
        .unwrap()
        .iter()
        .filter(|notice| *notice == "alpha:idle")
        .count();

    let reply = board.stop_project("alpha").await;

    assert!(reply.text.contains("Stopped alpha"));
    assert_eq!(
        notices.lock().unwrap().last().map(String::as_str),
        Some("alpha:finished")
    );
    let idle_after = notices
        .lock()
        .unwrap()
        .iter()
        .filter(|notice| *notice == "alpha:idle")
        .count();
    assert_eq!(
        idle_after, idle_before,
        "stop cannot receive a late idle notice"
    );
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn stopped_background_prompt_does_not_publish_idle_after_close() {
    let mut board = board_with(vec![project("alpha", ""), project("beta", "")], false);
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let mut started_tx = Some(started_tx);
    let _log = serve(
        &board,
        Box::new(move |session, _message| {
            if session == "s2" {
                if let Some(tx) = started_tx.take() {
                    let _ = tx.send(());
                }
                vec![Step::WaitFor("kill")]
            } else {
                says("handled")
            }
        }),
    );
    let (state_tx, mut state_rx) = tokio::sync::mpsc::unbounded_channel();
    let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
    let finished_tx = Arc::new(StdMutex::new(Some(finished_tx)));
    let finished_for_callback = finished_tx.clone();
    board.set_agent_state_callback(Some(Arc::new(move |notice| {
        if notice.project == "beta" && notice.state == AgentNotice::Finished {
            if let Some(tx) = finished_for_callback.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
        let _ = state_tx.send((notice.project, notice.state));
        Box::pin(async {})
    })));
    board.transfer_to(&transcript("alpha"), "alpha").await;
    board
        .start_background_part("beta", "long beta work")
        .await
        .unwrap();
    within("started_rx", started_rx)
        .await
        .expect("the background turn started");
    while state_rx.try_recv().is_ok() {}
    board.stop_project("beta").await;

    within("finished_rx", finished_rx)
        .await
        .expect("stop published finished");
    let mut late_idle = false;
    while let Ok((project, state)) = state_rx.try_recv() {
        late_idle |= project == "beta" && state == AgentNotice::Idle;
    }
    assert!(!late_idle, "a stopped prompt must not publish idle");
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_saved_resident_session_is_resumed_with_open_session() {
    let mut board = board_with(vec![project("alpha", "")], false);
    let mut fake = crate::hosts::FakeHostAgent::new(Box::new(|_, _| says("resumed")));
    fake.on_command = Some(Box::new(|name, args| match name {
        "list_sessions" => Some(Some(Ok(json!({"sessions":[{
            "session":"s-old", "session_id":"saved-alpha", "project":"alpha",
            "cwd":"/srv/alpha", "provenance":"created", "busy":false,
        }]})))),
        "open_session" => Some(Some(Ok(json!({
            "session":"s-old", "session_id":"saved-alpha", "project":"alpha",
            "cwd":args["cwd"], "provenance":"created", "busy":false,
            "turn_open":false, "thinking":"medium",
        })))),
        _ => None,
    }));
    let log = fake.serve(board.hosts().connect_fake(HOST));
    let reply = board
        .transfer_to(&transcript("resume alpha"), "alpha")
        .await;
    assert_eq!(reply.route, "alpha");
    assert_eq!(log.named("create_session").len(), 0);
    assert_eq!(
        log.named("open_session"),
        [json!({"session_id":"saved-alpha", "cwd":"/srv/alpha", "project":"alpha"})]
    );
    assert_eq!(board.agent.as_ref().unwrap().session_id(), "saved-alpha");
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn backgrounding_a_busy_foreground_sends_an_away_notice() {
    let mut board = board_with(vec![project("alpha", ""), project("beta", "")], false);
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let mut started_tx = Some(started_tx);
    let log = serve(
        &board,
        Box::new(move |session, message| {
            if session == "s1"
                && (message.trim() == "long work" || message.contains("\nlong work\n"))
            {
                if let Some(tx) = started_tx.take() {
                    let _ = tx.send(());
                }
                vec![Step::Hold]
            } else {
                says("handled")
            }
        }),
    );
    board.transfer_to(&transcript("alpha"), "alpha").await;
    let alpha = board.agent.clone().expect("alpha is foreground");
    let held = tokio::spawn({
        let alpha = alpha.clone();
        async move { alpha.prompt("long work").await }
    });
    within("started_rx", started_rx)
        .await
        .expect("the long turn started");
    let states = Arc::new(StdMutex::new(Vec::new()));
    let states_for_callback = Arc::clone(&states);
    board.set_agent_state_callback(Some(Arc::new(move |notice| {
        states_for_callback
            .lock()
            .unwrap()
            .push((notice.project, notice.state));
        Box::pin(async {})
    })));
    let reply = board.transfer_to(&transcript("beta"), "beta").await;
    assert_eq!(reply.route, "beta");
    assert!(states
        .lock()
        .unwrap()
        .iter()
        .any(|(project, state)| project == "alpha" && *state == AgentNotice::Busy));
    assert!(log
        .named("set_mode")
        .iter()
        .any(|args| args["mode"] == "background"));
    assert!(log.named("steer").iter().any(|args| args["message"]
        .as_str()
        .unwrap_or_default()
        .contains("The caller has moved on to other work")));
    let steer_calls = log.named("steer");
    let away = steer_calls
        .iter()
        .find_map(|args| args["message"].as_str())
        .unwrap_or_default();
    assert!(away.contains("request_to_speak in the words they should hear"));
    assert!(away.contains("cannot hear speak() now"));
    assert!(away.contains("your displays wait until they come back to you"));
    held.abort();
    let _ = held.await;
    board.shutdown().await;
}

/// What happens to a resident, in the residents table below.
#[derive(Clone, Copy, Debug)]
enum ResidentEvent {
    /// The caller stops it (`stop_project`).
    Stop,
    /// The caller is put through to it (`dial`): a promotion.
    Promote,
    /// The caller gives it more work (`start_background_part`).
    MoreWork,
    /// Its handle is closed without its host saying so, then the caller
    /// gives it more work: the dead resident is found and replaced.
    MoreWorkAfterDeath,
    /// Its handle is closed without its host saying so, then the caller is
    /// put through to it: the dead resident is found and a new leg made.
    DialAfterDeath,
    /// Its host reports this session closed.
    ClosedOnHost,
    /// Its host reports an older instance of the session closed.
    StaleClosedOnHost,
    /// The service shuts down, the call line first, as `app_state::shutdown`
    /// does.
    Shutdown,
}

/// What a row of the residents table checks after its event.
#[derive(Debug, PartialEq)]
struct ResidentAfter {
    /// The old session is still the project's resident.
    same_resident: bool,
    /// The project has a resident at all (the old one or a new one).
    resident: bool,
    /// The coordinator still lets the project's background token act.
    background: bool,
    /// The old session's handle is still open.
    alive: bool,
    /// The old session is the agent on the line.
    on_the_line: bool,
    /// What the projection was told about the project, after the event.
    notices: Vec<String>,
}

/// Puts `alpha` in the background with its first turn held (`busy`) or
/// settled (`idle`), and returns the board, its fake host's log, the
/// resident session and the notices recorder.
async fn board_with_a_resident(
    busy: bool,
) -> (
    Switchboard,
    crate::hosts::FakeLog,
    ProjectSession,
    Arc<StdMutex<Vec<String>>>,
) {
    let mut board = board_with(vec![project("alpha", "")], false);
    // A row that waits on a turn fails in seconds, not in ten minutes.
    board.set_project_turn_timeout_for_test(Duration::from_secs(5));
    let notices = Arc::new(StdMutex::new(Vec::<String>::new()));
    let (idle_tx, idle_rx) = tokio::sync::oneshot::channel::<()>();
    let idle_tx = Arc::new(StdMutex::new(Some(idle_tx)));
    let recorder = notices.clone();
    board.set_agent_state_callback(Some(Arc::new(move |notice| {
        let line = format!("{}:{}", notice.project, notice.state);
        if line == "alpha:idle" {
            if let Some(tx) = idle_tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
        recorder.lock().unwrap().push(line);
        Box::pin(async {})
    })));
    let mut first = true;
    let log = serve(
        &board,
        Box::new(move |_, _| {
            if std::mem::take(&mut first) && busy {
                vec![Step::Hold]
            } else {
                says("ready")
            }
        }),
    );
    board
        .start_background_part("alpha", "background work")
        .await
        .expect("alpha goes to the background");
    let resident = board
        .background_agents
        .get("alpha")
        .expect("alpha resident");
    if busy {
        within("the held turn to start", async {
            while !resident.busy() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
    } else {
        within("idle_rx", idle_rx)
            .await
            .expect("the settled resident is published idle");
    }
    notices.lock().unwrap().clear();
    (board, log, resident, notices)
}

async fn resident_after(
    busy: bool,
    event: ResidentEvent,
    notices_wanted: usize,
) -> (ResidentAfter, Switchboard) {
    let (mut board, _log, resident, notices) = board_with_a_resident(busy).await;
    match event {
        ResidentEvent::Stop => {
            let reply = board.stop_project("alpha").await;
            assert_eq!(reply.text, "Stopped alpha.");
        }
        ResidentEvent::Promote => {
            assert_eq!(board.dial("alpha", "").await.route, "alpha");
        }
        ResidentEvent::MoreWork => {
            let result = board.start_background_part("alpha", "more work").await;
            assert_eq!(result.is_ok(), !busy, "{result:?}");
        }
        ResidentEvent::MoreWorkAfterDeath => {
            resident.close();
            board
                .start_background_part("alpha", "more work")
                .await
                .expect("a new resident replaces the dead one");
        }
        ResidentEvent::DialAfterDeath => {
            resident.close();
            assert_eq!(board.dial("alpha", "").await.route, "alpha");
        }
        ResidentEvent::ClosedOnHost => {
            let callback = board.session_closed_callback();
            callback(
                "alpha".into(),
                resident.session_id().into(),
                resident.instance_id(),
            )
            .await;
        }
        ResidentEvent::StaleClosedOnHost => {
            let callback = board.session_closed_callback();
            callback(
                "alpha".into(),
                resident.session_id().into(),
                resident.instance_id() + 1000,
            )
            .await;
        }
        ResidentEvent::Shutdown => {
            assert!(board.coordinator().begin_shutdown());
            board.shutdown().await;
        }
    }
    // A notice the event's own tasks send late (a settled prompt's idle)
    // is waited for; one more than the row wants has a moment to show up.
    within("the row's notices", async {
        while notices.lock().unwrap().len() < notices_wanted {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    let current = board.background_agents.get("alpha");
    let after = ResidentAfter {
        same_resident: current
            .as_ref()
            .is_some_and(|current| current.same_session(&resident)),
        resident: current.is_some(),
        background: board.coordinator().project_is_background("alpha"),
        alive: resident.alive(),
        on_the_line: board
            .agent
            .as_ref()
            .is_some_and(|agent| agent.same_session(&resident)),
        notices: notices.lock().unwrap().clone(),
    };
    (after, board)
}

/// The residents table: every way a resident leaves (or stays), from a
/// resident whose turn is still running (`busy`) and one whose turn has
/// settled (`idle`), and what each leaves behind. Written against the
/// registry's behaviour before it held one entry per resident; the rows
/// are that behaviour.
///
/// Promoting a busy resident has no row: what it should do is #239's open
/// decision, and the fake host cannot answer a prompt to a busy session as
/// the real one does (a follow-up, not a turn of its own).
#[cfg(unix)]
#[tokio::test]
async fn a_resident_leaves_by_the_exits_of_its_table() {
    use ResidentEvent::*;
    let after = |same_resident: bool,
                 resident: bool,
                 background: bool,
                 alive: bool,
                 on_the_line: bool,
                 notices: &[&str]| ResidentAfter {
        same_resident,
        resident,
        background,
        alive,
        on_the_line,
        notices: notices.iter().map(|notice| (*notice).to_owned()).collect(),
    };
    let finished = ["alpha:finished"];
    let rows: Vec<(bool, ResidentEvent, ResidentAfter)> = vec![
        // (busy, event, after)
        (
            true,
            Stop,
            after(false, false, false, false, false, &finished),
        ),
        (
            false,
            Stop,
            after(false, false, false, false, false, &finished),
        ),
        (
            false,
            Promote,
            after(
                false,
                false,
                false,
                true,
                true,
                &["alpha:busy", "alpha:idle"],
            ),
        ),
        (true, MoreWork, after(true, true, true, true, false, &[])),
        (
            false,
            MoreWork,
            after(true, true, true, true, false, &["alpha:busy", "alpha:idle"]),
        ),
        (
            false,
            MoreWorkAfterDeath,
            after(
                false,
                true,
                true,
                false,
                false,
                &["alpha:finished", "alpha:busy", "alpha:idle"],
            ),
        ),
        (
            false,
            DialAfterDeath,
            after(
                false,
                false,
                false,
                false,
                false,
                &["alpha:finished", "alpha:busy", "alpha:idle"],
            ),
        ),
        (
            true,
            ClosedOnHost,
            after(false, false, false, true, false, &finished),
        ),
        (
            false,
            ClosedOnHost,
            after(false, false, false, true, false, &finished),
        ),
        (
            true,
            StaleClosedOnHost,
            after(true, true, true, true, false, &[]),
        ),
        (
            false,
            StaleClosedOnHost,
            after(true, true, true, true, false, &[]),
        ),
        (
            true,
            Shutdown,
            after(false, false, false, false, false, &[]),
        ),
        (
            false,
            Shutdown,
            after(false, false, false, false, false, &[]),
        ),
    ];
    for (busy, event, want) in rows {
        let (got, mut board) = resident_after(busy, event, want.notices.len()).await;
        assert_eq!(
            got,
            want,
            "a {} resident, then {event:?}",
            if busy { "busy" } else { "idle" }
        );
        board.shutdown().await;
    }
}

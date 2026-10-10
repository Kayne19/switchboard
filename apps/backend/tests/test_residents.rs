use super::*;
use crate::hosts::{FakeHostAgent, Step};
use crate::pbx::{board_on, board_with, project, says, serve, transcript, two_model_catalog, HOST};
use crate::pi_client::ProjectLaunch;
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
        board
            .transfer_ctx(&transcript("alpha"), "alpha", "", "")
            .await
            .route,
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

    let reply = board
        .transfer_ctx(&transcript("start alpha"), "alpha", "", "")
        .await;
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
        if notice.project == "alpha" && notice.state == "finished" {
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

    board
        .background_agents
        .insert("alpha".into(), replacement.clone());
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
        if notice.project == "alpha" && notice.state == "finished" {
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
        if notice.project == "beta" && notice.state == "finished" {
            if let Some(tx) = finished_for_callback.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
        let _ = state_tx.send((notice.project, notice.state));
        Box::pin(async {})
    })));
    board
        .transfer_ctx(&transcript("alpha"), "alpha", "", "")
        .await;
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
        late_idle |= project == "beta" && state == "idle";
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
        .transfer_ctx(&transcript("resume alpha"), "alpha", "", "")
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
    board
        .transfer_ctx(&transcript("alpha"), "alpha", "", "")
        .await;
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
    let reply = board
        .transfer_ctx(&transcript("beta"), "beta", "", "")
        .await;
    assert_eq!(reply.route, "beta");
    assert!(states
        .lock()
        .unwrap()
        .iter()
        .any(|(project, state)| project == "alpha" && state == "busy"));
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

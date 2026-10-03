use super::*;
use crate::hosts::Step;
use serde_json::{json, Value};
use std::sync::Mutex as StdMutex;

#[test]
fn status_exposes_project_ids() {
    let project = Project {
        id: "alpha".into(),
        description: "Alpha project".into(),
        aliases: vec!["a".into()],
        host: None,
        cwd: "/srv/alpha".into(),
        model: None,
        prepare: String::new(),
    };
    let board = board_with(vec![project], true);
    assert_eq!(board.coordinator.status().projects, ["alpha"]);
}

#[test]
fn state_starts_on_operator() {
    let board = board_with(vec![], true);
    assert_eq!(board.coordinator.route(), OPERATOR);
    assert_eq!(board.coordinator.status().route, OPERATOR);
    assert!(board.coordinator.status().models.is_empty());
}

#[test]
fn status_exposes_the_launch_catalog_for_the_current_project() {
    let project = Project {
        id: "alpha".into(),
        description: String::new(),
        aliases: vec![],
        host: None,
        cwd: String::new(),
        model: None,
        prepare: String::new(),
    };
    let board = board_with(vec![project.clone()], true);
    put_on(
        &board,
        &project.id,
        "anthropic/current:high",
        ModelCatalog {
            entries: vec![crate::models::CatalogEntry {
                provider: "anthropic".into(),
                model: "current".into(),
                thinks: true,
            }],
            available: true,
            diagnostic: None,
        },
    );
    assert_eq!(
        board.coordinator.status().models,
        [crate::protocol::ModelEntry {
            provider: "anthropic".into(),
            model: "current".into(),
            thinks: true,
        }]
    );
}

#[tokio::test]
async fn a_turn_ends_only_on_the_settled_turn_end() {
    let hosts = crate::hosts::Hosts::new(Default::default(), Default::default());
    let mut link = hosts.connect_fake(HOST);
    let creating = tokio::spawn({
        let hosts = hosts.clone();
        async move {
            ProjectSession::create(
                &hosts,
                ProjectLaunch {
                    host: HOST.into(),
                    project: "alpha".into(),
                    cwd: "/srv/alpha".into(),
                    spec: String::new(),
                    brief: "BRIEF".into(),
                    turn_timeout: Duration::from_secs(10),
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
    let create = link.recv().await.unwrap();
    assert_eq!(create["name"], "create_session");
    reply(
        &link,
        &create,
        json!({"session": "s1", "thinking": "medium"}),
    );
    let (session, _) = creating.await.unwrap().unwrap();

    let prompting = tokio::spawn({
        let session = session.clone();
        async move { session.prompt("hello").await }
    });
    let prompt = link.recv().await.unwrap();
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
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!prompting.is_finished(), "the turn ended before it settled");
    assert!(session.busy());
    event(&link, 6, json!({"kind": "turn_end"}));
    let turn = prompting.await.unwrap().unwrap();
    assert_eq!(turn.text, "Done.");
    assert!(!turn.failed);
    assert!(!session.busy());
    session.close();
    let kill = link.recv().await.unwrap();
    assert_eq!(
        (kill["name"].clone(), kill["args"].clone()),
        (json!("kill"), json!({"session": "s1"}))
    );
}

#[tokio::test]
async fn a_module_call_with_a_stale_call_token_is_refused() {
    let (mut board, log) = on_alpha(
        &[],
        Box::new(|_, message| {
            if message.contains("go back") {
                vec![
                    Step::CallWithToken("old-token".into(), "return_to_operator", json!({})),
                    Step::CallWithToken(String::new(), "speak", json!({"text": "hi"})),
                    Step::Event(json!({"kind": "text", "text": "Still here."})),
                ]
            } else {
                says("On it.")
            }
        }),
    )
    .await;

    let reply = board.handle("go back").await;

    assert_eq!(reply.route, "alpha", "a stale signal moved the caller");
    assert_eq!(reply.text, "Still here.");
    let replies = log.module_replies();
    assert_eq!(replies.len(), 2);
    for reply in replies {
        assert_eq!(
            (reply["status"].clone(), reply["reason"].clone()),
            (json!("refused"), json!("not_on_call"))
        );
    }
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_closed_agent_on_the_line_is_retired_to_the_operator() {
    let (mut board, _log) = on_alpha(&[], Box::new(|_, _| says("handled"))).await;
    let alpha = board.agent.clone().expect("alpha on the line");

    assert!(
        !board
            .retire_closed_foreground("alpha", alpha.session_id(), alpha.instance_id() + 1)
            .await,
        "another instance of the session is not the one on the line"
    );
    assert_eq!(board.coordinator.route(), "alpha");

    assert!(
        board
            .retire_closed_foreground("alpha", alpha.session_id(), alpha.instance_id())
            .await
    );
    assert_eq!(board.coordinator.route(), OPERATOR);
    assert!(board.agent.is_none());
    assert!(board
        .operator_note
        .as_deref()
        .is_some_and(|note| note.contains("alpha")));
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_closed_session_that_is_not_resident_is_reported_for_the_line() {
    let (mut board, _log) = on_alpha(&[], Box::new(|_, _| says("handled"))).await;
    let reported = Arc::new(StdMutex::new(Vec::<(String, String, u64)>::new()));
    let reported_for_callback = reported.clone();
    board.set_foreground_closed_callback(Some(Arc::new(move |project, session, instance| {
        reported_for_callback
            .lock()
            .unwrap()
            .push((project, session, instance));
        Box::pin(async {})
    })));
    let alpha = board.agent.clone().expect("alpha on the line");

    board.session_closed_callback()(
        "alpha".into(),
        alpha.session_id().into(),
        alpha.instance_id(),
    )
    .await;

    assert_eq!(
        reported.lock().unwrap().as_slice(),
        &[(
            "alpha".to_owned(),
            alpha.session_id().to_owned(),
            alpha.instance_id()
        )]
    );
    board.shutdown().await;
}

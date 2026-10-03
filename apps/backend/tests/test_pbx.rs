use super::*;
use crate::hosts::Step;
use serde_json::json;
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

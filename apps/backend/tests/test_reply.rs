use super::*;
use crate::hosts::Step;
use crate::pbx::{board_on, board_with, project, serve, transcript, two_model_catalog};
use serde_json::json;
use std::sync::{Arc, Mutex as StdMutex};

#[test]
fn project_written_replies_stay_silent_but_switchboard_errors_are_spoken() {
    let board = board_with(vec![], true);
    let reply = board.reply_with_turn(Turn {
        text: "Ready.".into(),
        signals: vec![],
        failed: false,
        error: String::new(),
    });
    assert_eq!(reply.text, "Ready.");
    assert!(reply.to_speak.is_empty());

    let failed =
        board.reply_transfer_error("The project did not answer.".into(), Some("failed".into()));
    assert_eq!(failed.to_speak, ["The project did not answer."]);
}

#[tokio::test]
async fn a_delivered_speak_keeps_the_written_turn_reply_silent() {
    let mut board = board_on(vec![project("alpha", "")], &[], two_model_catalog());
    let calls = Arc::new(StdMutex::new(Vec::new()));
    let seen = Arc::clone(&calls);
    board.set_module_callback(Some(Arc::new(move |call: crate::pi_client::AgentCall| {
        seen.lock()
            .unwrap()
            .push((call.call.clone(), call.token.clone(), call.args.clone()));
        Box::pin(async { json!({"status": "delivered", "reason": null}) })
    })));
    let log = serve(
        &board,
        Box::new(|_, _| {
            vec![
                Step::Call("speak", json!({"text": "Looking now."})),
                Step::Event(json!({"kind": "text", "text": "Written detail."})),
            ]
        }),
    );

    let reply = board
        .transfer_ctx(&transcript("look at alpha"), "alpha", "", "")
        .await;

    assert_eq!(reply.route, "alpha");
    assert_eq!(reply.text, "Written detail.");
    // The direct speak call already delivered its own audio. The settled
    // written reply remains transcript-only and must not repeat it.
    assert!(!reply.voiced, "the written reply was voiced: {reply:?}");
    assert!(
        reply.to_speak.is_empty(),
        "written reply was synthesized: {reply:?}"
    );
    let calls = calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "speak");
    assert_eq!(
        calls[0].1,
        log.named("join_call")[0]["token"].as_str().unwrap()
    );
    assert_eq!(log.module_replies()[0]["status"], "delivered");
    board.shutdown().await;
}

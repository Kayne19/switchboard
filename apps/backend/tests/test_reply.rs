use super::*;
use crate::hosts::Step;
use crate::pbx::{
    board_on, board_with, on_alpha, project, says, serve, transcript, two_model_catalog,
};
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

/// A rescue that lands while a continuing turn runs: the reply belongs to
/// the generation the turn was admitted at, which the rescue retired.
#[cfg(unix)]
#[tokio::test]
async fn a_continuing_turn_is_not_stamped_with_a_rescue_that_landed_during_it() {
    // Set once the caller is on alpha, so the intro runs undisturbed.
    let coordinator = Arc::new(StdMutex::new(None::<crate::lifecycle::Coordinator>));
    let rescuer = Arc::clone(&coordinator);
    let (mut board, _log) = on_alpha(
        &[],
        Box::new(move |_, _| {
            if let Some(coordinator) = rescuer.lock().unwrap().as_ref() {
                coordinator.begin_rescue("test");
            }
            says("answer")
        }),
    )
    .await;
    *coordinator.lock().unwrap() = Some(board.coordinator.clone());
    let admitted = board.coordinator.generation();
    let reply = board.handle("hi").await;
    assert_eq!(reply.text, "answer");
    assert_eq!(
        reply.delivery_generation.unwrap_or(admitted),
        admitted,
        "the reply took the rescue's generation"
    );
    board.shutdown().await;
}

/// A rescue that lands while a transfer's intro runs: the intro's reply
/// belongs to the leg the transfer staged, never to the line the rescue
/// left behind.
#[cfg(unix)]
#[tokio::test]
async fn a_transfer_reply_is_not_stamped_with_a_rescue_that_landed_during_its_intro() {
    let mut board = board_on(vec![project("alpha", "")], &[], two_model_catalog());
    let coordinator = board.coordinator.clone();
    let _log = serve(
        &board,
        Box::new(move |_, _| {
            coordinator.begin_rescue("test");
            says("Alpha here.")
        }),
    );
    let admitted = board.coordinator.generation();
    let reply = board
        .transfer_ctx(&transcript("put me through to alpha"), "alpha", "", "")
        .await;
    let rescued = board.coordinator.generation();
    assert_ne!(
        reply.delivery_generation.unwrap_or(admitted),
        rescued,
        "the intro's reply passes the rescue's generation check"
    );
    board.shutdown().await;
}

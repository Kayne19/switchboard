use super::*;
use crate::pbx::{
    board_on, board_with, decision, on_alpha, project, says, scratch_dir, serve, two_model_catalog,
};
use tokio::time::Duration;

#[test]
fn multi_target_utility_request_carries_only_jev_hint_and_caller_words() {
    let board = board_with(
        vec![
            project("grape-segmentation", "Grape"),
            project("switchboard", "Switchboard"),
        ],
        true,
    );
    let request = board.utility_routing_request(
        "grape answer and switchboard answer",
        &Decision {
            action: crate::router::Action::Continue,
            target: Some("grape-segmentation".into()),
            continue_or_fresh: None,
            confidence: 0.97,
            for_current_agent: 0.79,
            multi_target: true,
            unsure: false,
            confirm: false,
            reason: "two projects".into(),
        },
        false,
    );
    assert!(request.contains("several projects=true"));
    assert!(request.contains("action=continue"));
    assert!(request.contains("target=grape-segmentation"));
    assert!(request.contains("grape answer and switchboard answer"));
    // The rules and the catalog live once, in the utility's system prompt.
    assert!(!request.contains("Registered projects"), "{request}");
    assert!(!request.contains("Never invent"), "{request}");
    let retry = board.utility_routing_request(
        "grape answer and switchboard answer",
        &Decision {
            action: crate::router::Action::Continue,
            target: None,
            continue_or_fresh: None,
            confidence: 0.5,
            for_current_agent: 0.5,
            multi_target: true,
            unsure: true,
            confirm: false,
            reason: "two projects".into(),
        },
        true,
    );
    assert!(retry.contains("dispatch_parts"), "{retry}");
}

#[cfg(unix)]
#[tokio::test]
async fn utility_second_opinion_does_not_wait_on_the_conversational_turn_lock() {
    let root = scratch_dir("utility-turn-lock");
    let binary = fake_routing_process(
        &root,
        r#"{"type":"tool_execution_start","toolName":"second_opinion","args":{"target":"alpha","mode":"fresh","confident":true}}"#,
        None,
    );
    let mut board = board_on(
        vec![project("alpha", "Alpha project")],
        &[("SWITCHBOARD_PI_BINARY", &binary.to_string_lossy())],
        two_model_catalog(),
    );
    let _log = serve(&board, Box::new(|_, _| says("Alpha handled it.")));
    let operator = board.ensure_operator().await.expect("operator").clone();
    let held = tokio::spawn({
        let operator = operator.clone();
        async move { operator.prompt("hold the operator turn").await }
    });
    for _ in 0..100 {
        if operator.busy() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(
        operator.busy(),
        "the conversational process should be in flight"
    );
    let decision = Decision {
        action: crate::router::Action::General,
        target: None,
        continue_or_fresh: None,
        confidence: 0.4,
        for_current_agent: 0.4,
        multi_target: false,
        unsure: true,
        confirm: false,
        reason: "Jev was unsure".into(),
    };

    let reply = tokio::time::timeout(
        Duration::from_secs(2),
        board.handle_decision("inspect alpha", &decision),
    )
    .await
    .expect("utility routing is independent of the operator turn lock");

    assert_eq!(reply.route, "alpha");
    board.shutdown().await;
    held.abort();
    let _ = held.await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn the_routing_utility_request_carries_the_call_state() {
    let board = board_with(vec![project("alpha", "Alpha project")], false);
    let mut board = board;
    board.set_call_state("- alpha: waiting, in the background, has something to say".into());
    let request = board.utility_routing_request(
        "pull it up",
        &decision(crate::router::Action::Continue, Some("alpha"), None),
        false,
    );
    assert!(request.contains("[CALL STATE]"), "{request}");
    assert!(request.contains("has something to say"), "{request}");
    assert!(request.contains("pull it up"), "{request}");
}

/// The operator answers some lines while a project stays on the line. Its
/// (re)start must not take the session guard off that project: the guard is
/// what a steer and a page rescue reach.
#[cfg(unix)]
#[tokio::test]
async fn an_operator_started_while_a_project_is_on_the_line_leaves_the_guard_on_it() {
    let root = scratch_dir("operator-guard-start");
    let binary = fake_routing_process(
        &root,
        r#"{"type":"tool_execution_start","toolName":"second_opinion","args":{"confident":false}}"#,
        Some(
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Alpha is running."}}"#,
        ),
    );
    let (mut board, _log) = on_alpha(
        &[("SWITCHBOARD_PI_BINARY", &binary.to_string_lossy())],
        Box::new(|_, _| says("Alpha handled it.")),
    )
    .await;
    assert!(board.operator.is_none(), "no operator is running yet");

    let reply = board
        .handle_decision(
            "what's running?",
            &decision(crate::router::Action::Status, None, None),
        )
        .await;

    assert_eq!(reply.text, "Alpha is running.", "{reply:?}");
    assert!(board.operator.is_some(), "the operator answered");
    assert_eq!(board.coordinator.route(), "alpha");
    assert_eq!(
        guard_label(&board).await.as_deref(),
        Some("alpha"),
        "the project on the line keeps the session guard"
    );
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

/// A failed operator turn while a project is on the line drops the operator,
/// not the project's hold on the session guard.
#[cfg(unix)]
#[tokio::test]
async fn a_failed_operator_turn_while_a_project_is_on_the_line_leaves_the_guard_on_it() {
    let root = scratch_dir("operator-guard-recover");
    let binary = root.join("fake-failing-operator");
    crate::pi_client::write_executable_script(
        &binary,
        "while IFS= read -r _line; do exit 1; done\n",
    );
    let (mut board, _log) = on_alpha(
        &[("SWITCHBOARD_PI_BINARY", &binary.to_string_lossy())],
        Box::new(|_, _| says("Alpha handled it.")),
    )
    .await;

    let reply = board
        .handle_decision(
            "what's running?",
            &decision(crate::router::Action::Status, None, None),
        )
        .await;

    assert!(
        board.operator.is_none(),
        "the failed operator was dropped: {reply:?}"
    );
    assert_eq!(board.coordinator.route(), "alpha");
    assert_eq!(
        guard_label(&board).await.as_deref(),
        Some("alpha"),
        "the project on the line keeps the session guard"
    );
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
async fn guard_label(board: &Switchboard) -> Option<String> {
    board
        .session_control()
        .lock()
        .await
        .as_ref()
        .map(|session| session.label().to_owned())
}

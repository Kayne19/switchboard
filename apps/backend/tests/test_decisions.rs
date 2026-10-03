use super::*;
use crate::hosts::{FakeHostAgent, Step};
use crate::operator::{fake_operator, fake_routing_process};
use crate::pbx::{
    board_on, board_with, decision, on_alpha, project, prompts, says, scratch_dir, serve,
    transcript, two_model_catalog, HOST,
};
use crate::pi_client::LegSession;
use crate::router::ConversationMode;
use serde_json::Value;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::time::Duration;

#[cfg(unix)]
fn fake_routing_process_sequence(
    root: &std::path::Path,
    utility_events: &[&str],
    operator_event: &str,
) -> (std::path::PathBuf, std::path::PathBuf) {
    let path = root.join("fake-routing-process-sequence");
    let calls = root.join("utility-calls");
    let mut utility_branch = String::new();
    for (index, event) in utility_events.iter().enumerate() {
        let next = index + 1;
        let keyword = if index == 0 { "if" } else { "elif" };
        utility_branch.push_str(&format!(
            "{keyword} [ \"$count\" -eq {next} ]; then printf '%s\n' '{event}'\n",
        ));
    }
    let fallback = utility_events.last().copied().unwrap_or("");
    utility_branch.push_str(&format!(
        "else printf '%s\n' '{fallback}'\nfi
"
    ));
    let body = format!(
        r#"is_utility=0
for arg in "$@"; do
  if [ "$arg" = "--switchboard-utility" ]; then is_utility=1; fi
done
if [ "$is_utility" -eq 1 ]; then
  while IFS= read -r _line; do
    count=0
    if [ -f '{calls}' ]; then count=$(cat '{calls}'); fi
    count=$((count + 1))
    printf '%s' "$count" > '{calls}'
    {utility_branch}    printf '%s\n' '{{"type":"agent_settled"}}'
  done
else
  while IFS= read -r _line; do
    printf '%s\n' '{operator_event}'
    printf '%s\n' '{{"type":"agent_settled"}}'
  done
fi
"#,
        calls = calls.display(),
        utility_branch = utility_branch,
        operator_event = operator_event,
    );
    crate::pi_client::write_executable_script(&path, &body);
    (path, calls)
}

#[cfg(unix)]
#[tokio::test]
async fn unsure_jev_gets_a_utility_second_opinion_before_the_operator_asks() {
    let root = scratch_dir("utility-second-opinion");
    let binary = fake_routing_process(
        &root,
        r#"{"type":"tool_execution_start","toolName":"second_opinion","args":{"target":"alpha","mode":"fresh","confident":true}}"#,
        Some(
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"The operator should not ask."}}"#,
        ),
    );
    let mut board = board_on(
        vec![project("alpha", "Alpha project")],
        &[("SWITCHBOARD_PI_BINARY", &binary.to_string_lossy())],
        two_model_catalog(),
    );
    let log = serve(&board, Box::new(|_, _| says("Alpha handled it.")));
    let decision = Decision {
        action: crate::router::Action::General,
        target: None,
        continue_or_fresh: None,
        confidence: 0.5,
        for_current_agent: 0.5,
        multi_target: false,
        unsure: true,
        confirm: false,
        reason: "Jev was unsure".into(),
    };

    let reply = board.handle_decision("inspect alpha", &decision).await;

    assert_eq!(reply.route, "alpha");
    assert_eq!(reply.text, "Alpha handled it.");
    assert!(
        board.operator.is_none(),
        "the conversational operator was not asked"
    );
    assert!(prompts(&log)
        .iter()
        .any(|prompt| prompt.contains("inspect alpha")));
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn multi_target_jev_retries_a_single_utility_target_then_splits() {
    let root = scratch_dir("multi-target-retry");
    let (binary, calls) = fake_routing_process_sequence(
        &root,
        &[
            r#"{"type":"tool_execution_start","toolName":"second_opinion","args":{"target":"grape-segmentation","mode":"continue","confident":true}}"#,
            r#"{"type":"tool_execution_start","toolName":"dispatch_parts","args":{"parts":[{"agent":"grape-segmentation","text":"tell me the validation low on the 1-8th HRnet versus the 1-16th branch version"},{"agent":"switchboard","text":"tell me the latest commit on the switchboard project what that one was titled"}]}}"#,
        ],
        r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"The operator needs to clarify."}}"#,
    );
    let mut board = board_on(
        vec![
            project("grape-segmentation", "Grape project"),
            project("switchboard", "Switchboard project"),
        ],
        &[("SWITCHBOARD_PI_BINARY", &binary.to_string_lossy())],
        two_model_catalog(),
    );
    let (prompt_tx, mut prompt_rx) = tokio::sync::mpsc::unbounded_channel();
    let _log = serve(
        &board,
        Box::new(move |session, message| {
            let _ = prompt_tx.send((session.to_owned(), message.to_owned()));
            says("handled")
        }),
    );
    board
        .transfer_ctx(
            &transcript("connect grape-segmentation"),
            "grape-segmentation",
            "",
            "",
        )
        .await;

    let caller = "can you go ahead and tell me the validation low on the 1-8th HRnet versus the 1-16th branch version and then can you also tell me the latest commit on the switchboard project what that one was titled?";
    let reply = board
        .handle_decision(
            caller,
            &Decision {
                action: crate::router::Action::Continue,
                target: Some("grape-segmentation".into()),
                continue_or_fresh: Some(crate::router::ConversationMode::Continue),
                confidence: 0.97,
                for_current_agent: 0.79,
                multi_target: true,
                unsure: false,
                confirm: false,
                reason: "Jev found two projects".into(),
            },
        )
        .await;

    assert_eq!(reply.route, "grape-segmentation");
    assert_eq!(std::fs::read_to_string(&calls).unwrap(), "2");
    assert!(board.coordinator.project_is_background("switchboard"));
    let mut saw_grape = false;
    let mut saw_switchboard = false;
    while let Some((session, message)) = prompt_rx.recv().await {
        saw_grape |= session == "s1" && message.contains("validation low");
        saw_switchboard |= session == "s2" && message.contains("latest commit on the switchboard");
        if saw_grape && saw_switchboard {
            break;
        }
    }
    assert!(saw_grape, "foreground grape part was dispatched");
    assert!(
        saw_switchboard,
        "background switchboard part was dispatched"
    );
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn multi_target_jev_uses_a_first_utility_split_without_retry() {
    let root = scratch_dir("multi-target-first-split");
    let (binary, calls) = fake_routing_process_sequence(
        &root,
        &[
            r#"{"type":"tool_execution_start","toolName":"dispatch_parts","args":{"parts":[{"agent":"grape-segmentation","text":"grape work"},{"agent":"switchboard","text":"switchboard work"}]}}"#,
        ],
        r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Operator asked."}}"#,
    );
    let mut board = board_on(
        vec![
            project("grape-segmentation", "Grape"),
            project("switchboard", "Switchboard"),
        ],
        &[("SWITCHBOARD_PI_BINARY", &binary.to_string_lossy())],
        two_model_catalog(),
    );
    let (prompt_tx, mut prompt_rx) = tokio::sync::mpsc::unbounded_channel();
    let _log = serve(
        &board,
        Box::new(move |session, message| {
            let _ = prompt_tx.send((session.to_owned(), message.to_owned()));
            says("handled")
        }),
    );
    board
        .transfer_ctx(
            &transcript("connect grape-segmentation"),
            "grape-segmentation",
            "",
            "",
        )
        .await;
    let reply = board
        .handle_decision(
            "grape work and switchboard work",
            &Decision {
                action: crate::router::Action::Continue,
                target: Some("grape-segmentation".into()),
                continue_or_fresh: None,
                confidence: 1.0,
                for_current_agent: 1.0,
                multi_target: true,
                unsure: false,
                confirm: false,
                reason: "Jev found two projects".into(),
            },
        )
        .await;
    assert_eq!(reply.route, "grape-segmentation");
    assert_eq!(std::fs::read_to_string(&calls).unwrap(), "1");
    assert!(board.coordinator.project_is_background("switchboard"));
    let mut saw_switchboard = false;
    while let Some((session, message)) = prompt_rx.recv().await {
        saw_switchboard |= session == "s2" && message.contains("switchboard work");
        if saw_switchboard {
            break;
        }
    }
    assert!(saw_switchboard);
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn multi_target_jev_that_never_splits_is_handled_by_operator() {
    let root = scratch_dir("multi-target-no-split");
    let (binary, calls) = fake_routing_process_sequence(
        &root,
        &[
            r#"{"type":"tool_execution_start","toolName":"second_opinion","args":{"target":"grape-segmentation","mode":"continue","confident":true}}"#,
        ],
        r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Which project should handle that?"}}"#,
    );
    let mut board = board_on(
        vec![
            project("grape-segmentation", "Grape"),
            project("switchboard", "Switchboard"),
        ],
        &[("SWITCHBOARD_PI_BINARY", &binary.to_string_lossy())],
        two_model_catalog(),
    );
    let log = serve(&board, Box::new(|_, _| says("grape should not see this")));
    board
        .transfer_ctx(
            &transcript("connect grape-segmentation"),
            "grape-segmentation",
            "",
            "",
        )
        .await;
    let reply = board
        .handle_decision(
            "grape work and switchboard work",
            &Decision {
                action: crate::router::Action::Continue,
                target: Some("grape-segmentation".into()),
                continue_or_fresh: None,
                confidence: 1.0,
                for_current_agent: 1.0,
                multi_target: true,
                unsure: false,
                confirm: false,
                reason: "Jev found two projects".into(),
            },
        )
        .await;
    assert_eq!(std::fs::read_to_string(&calls).unwrap(), "2");
    assert_eq!(reply.text, "Which project should handle that?");
    assert!(!prompts(&log)
        .iter()
        .any(|prompt| prompt.contains("grape should not see this")));
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn utility_split_keeps_the_current_agent_foreground_even_without_jev_multi_target() {
    let root = scratch_dir("utility-split-foreground");
    let binary = fake_routing_process(
        &root,
        r#"{"type":"tool_execution_start","toolName":"dispatch_parts","args":{"parts":[{"agent":"alpha","text":"Check alpha logs"},{"agent":"beta","text":"Review beta build"}]}}"#,
        None,
    );
    let mut board = board_on(
        vec![
            project("alpha", "Alpha project"),
            project("beta", "Beta project"),
        ],
        &[("SWITCHBOARD_PI_BINARY", &binary.to_string_lossy())],
        two_model_catalog(),
    );
    let (prompt_tx, mut prompt_rx) = tokio::sync::mpsc::unbounded_channel();
    let log = serve(
        &board,
        Box::new(move |session, message| {
            let _ = prompt_tx.send((session.to_owned(), message.to_owned()));
            says("Alpha is ready.")
        }),
    );
    let connected = board
        .transfer_ctx(&transcript("connect alpha"), "alpha", "", "")
        .await;
    assert_eq!(connected.route, "alpha");
    let before = prompts(&log).len();
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

    let reply = board
        .handle_decision(
            "can you tell me the numbers of the latest ablation run from the grapes and then also tell me what the latest commit from the switchboard project is?",
            &decision,
        )
        .await;

    assert_eq!(reply.route, "alpha");
    let mut routed_prompts = prompts(&log);
    assert!(routed_prompts[before..]
        .iter()
        .any(|prompt| prompt.contains("Check alpha logs")));
    while let Some((_session, prompt)) = prompt_rx.recv().await {
        if prompt.contains("Review beta build") {
            break;
        }
    }
    routed_prompts = prompts(&log);
    assert!(routed_prompts
        .iter()
        .any(|prompt| prompt.contains("Review beta build")));
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn utility_operator_target_is_handled_by_the_operator_leg() {
    let root = scratch_dir("utility-operator-target");
    let binary = fake_routing_process(
        &root,
        r#"{"type":"tool_execution_start","toolName":"second_opinion","args":{"target":"operator","mode":"continue","confident":true}}"#,
        Some(
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Operator handled it."}}"#,
        ),
    );
    let mut board = board_on(
        vec![project("alpha", "Alpha project")],
        &[("SWITCHBOARD_PI_BINARY", &binary.to_string_lossy())],
        two_model_catalog(),
    );
    let _log = serve(&board, Box::new(|_, _| says("Alpha is ready.")));
    let connected = board
        .transfer_ctx(&transcript("connect alpha"), "alpha", "", "")
        .await;
    assert_eq!(connected.route, "alpha");
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

    let reply = board.handle_decision("go back", &decision).await;

    assert_eq!(reply.route, OPERATOR);
    assert_eq!(reply.text, "Operator handled it.");
    assert!(board.agent.is_none());
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn background_split_selects_foreground_and_hangup_keeps_residents() {
    let mut board = board_with(vec![project("alpha", ""), project("beta", "")], false);
    let (prompt_tx, mut prompt_rx) = tokio::sync::mpsc::unbounded_channel();
    let _log = serve(
        &board,
        Box::new(move |session, message| {
            let _ = prompt_tx.send((session.to_owned(), message.to_owned()));
            says("handled")
        }),
    );
    assert_eq!(
        board
            .transfer_ctx(&transcript("alpha"), "alpha", "", "")
            .await
            .route,
        "alpha"
    );
    let reply = board
        .dispatch_parts(
            "both",
            vec![
                crate::router::DispatchPart {
                    agent: "alpha".into(),
                    text: "alpha part".into(),
                },
                crate::router::DispatchPart {
                    agent: "beta".into(),
                    text: "beta part".into(),
                },
            ],
        )
        .await;
    assert_eq!(reply.route, "alpha");
    let mut saw_beta = false;
    while let Some((session, message)) = prompt_rx.recv().await {
        if session == "s2" && message.contains("beta part") {
            saw_beta = true;
            break;
        }
    }
    assert!(saw_beta, "the split's non-foreground part was dispatched");
    assert!(board.background_agents.contains_key("beta"));

    let promoted = board
        .route_project_part(
            "bring beta forward",
            "beta",
            crate::router::ConversationMode::Continue,
            None,
        )
        .await;
    assert_eq!(promoted.route, "beta");
    assert!(board.background_agents.contains_key("alpha"));
    let alpha = board.background_agents.get("alpha").unwrap().clone();
    assert!(alpha.alive(), "the former foreground is resident");

    assert_eq!(board.force_hangup().await.as_deref(), Some("beta"));
    assert!(alpha.alive(), "hangup drops only the foreground agent");
    assert!(board.background_agents.contains_key("alpha"));
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn idle_background_split_part_continues_without_a_new_session() {
    let mut board = board_with(vec![project("alpha", ""), project("beta", "")], false);
    let (prompt_tx, mut prompt_rx) = tokio::sync::mpsc::unbounded_channel();
    let log = serve(
        &board,
        Box::new(move |session, message| {
            let _ = prompt_tx.send((session.to_owned(), message.to_owned()));
            says("handled")
        }),
    );
    board
        .transfer_ctx(&transcript("alpha"), "alpha", "", "")
        .await;
    board
        .dispatch_parts(
            "first",
            vec![
                crate::router::DispatchPart {
                    agent: "alpha".into(),
                    text: "alpha one".into(),
                },
                crate::router::DispatchPart {
                    agent: "beta".into(),
                    text: "beta one".into(),
                },
            ],
        )
        .await;
    while let Some((session, message)) = prompt_rx.recv().await {
        if session == "s2" && message.contains("beta one") {
            break;
        }
    }
    let creates = log.named("create_session").len();
    board
        .dispatch_parts(
            "second",
            vec![
                crate::router::DispatchPart {
                    agent: "alpha".into(),
                    text: "alpha two".into(),
                },
                crate::router::DispatchPart {
                    agent: "beta".into(),
                    text: "beta two".into(),
                },
            ],
        )
        .await;
    let mut saw_second = false;
    while let Some((session, message)) = prompt_rx.recv().await {
        if session == "s2" && message.contains("beta two") {
            saw_second = true;
            break;
        }
    }
    assert!(saw_second, "idle background sessions receive a later part");
    assert_eq!(log.named("create_session").len(), creates);
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn promoting_a_background_resident_cancels_its_detached_prompt_before_foreground_work() {
    let mut board = board_on(
        vec![project("alpha", ""), project("beta", "")],
        &[],
        two_model_catalog(),
    );
    let entered = Arc::new(tokio::sync::Notify::new());
    let calls = Arc::new(StdMutex::new(0usize));
    let entered_for_prompt = entered.clone();
    let calls_for_prompt = calls.clone();
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
    let _log = serve(
        &board,
        Box::new(move |session, _| {
            if session == "s2" {
                let mut calls = calls_for_prompt.lock().unwrap();
                *calls += 1;
                if *calls == 1 {
                    entered_for_prompt.notify_one();
                    return vec![Step::Hold];
                }
            }
            says("ready")
        }),
    );
    board
        .transfer_ctx(&transcript("alpha"), "alpha", "", "")
        .await;
    board
        .start_background_part("beta", "background work")
        .await
        .expect("background resident");
    tokio::time::timeout(Duration::from_secs(1), entered.notified())
        .await
        .expect("background prompt started");
    let idle_before = notices
        .lock()
        .unwrap()
        .iter()
        .filter(|notice| *notice == "beta:idle")
        .count();

    let reply = board
        .route_project_part(
            "bring beta forward",
            "beta",
            crate::router::ConversationMode::Continue,
            None,
        )
        .await;

    assert_eq!(reply.route, "beta");
    let idle_notices = notices
        .lock()
        .unwrap()
        .iter()
        .filter(|notice| *notice == "beta:idle")
        .count();
    assert_eq!(
        idle_notices,
        idle_before + 1,
        "cancelled background work cannot announce idle later"
    );
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn foreground_continuation_publishes_busy_before_prompt() {
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
    board
        .transfer_ctx(&transcript("start alpha"), "alpha", "", "")
        .await;
    notices.lock().unwrap().clear();

    let reply = board.handle_agent_ctx(&transcript("continue work")).await;
    assert_eq!(reply.route, "alpha");
    let notices = notices.lock().unwrap().clone();
    assert_eq!(notices, ["alpha:busy"]);
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn failed_background_promotion_closes_the_resident_and_finishes_its_state() {
    let mut board = board_on(vec![project("alpha", "")], &[], two_model_catalog());
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
    let mut fake = FakeHostAgent::new(Box::new(|_, _| says("ready")));
    fake.on_command = Some(Box::new(|name, _| {
        (name == "set_mode").then(|| Some(Err(("mode_failed".into(), "cannot switch mode".into()))))
    }));
    fake.serve(board.hosts().connect_fake(HOST));
    board
        .start_background_part("alpha", "background work")
        .await
        .expect("background resident");
    let resident = board.background_agents.get("alpha").unwrap().clone();

    let reply = board
        .route_project_part(
            "bring alpha forward",
            "alpha",
            crate::router::ConversationMode::Continue,
            None,
        )
        .await;

    assert!(reply.error.is_some());
    assert!(!resident.alive());
    assert!(!board.background_agents.contains_key("alpha"));
    assert_eq!(
        notices.lock().unwrap().last().map(String::as_str),
        Some("alpha:finished")
    );
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn failed_background_promotion_adoption_rolls_back_the_candidate() {
    let mut board = board_with(vec![project("alpha", ""), project("beta", "")], false);
    let coordinator = board.coordinator();
    let _log = serve(
        &board,
        Box::new(move |_, message| {
            if message.contains("show me beta") {
                // The candidate is staged before the foreground prompt.
                // Simulate a competing lifecycle owner changing it before
                // the PBX adopts it, as the transfer test does.
                coordinator.set_candidate_token_for_test("not-the-promotion-token");
            }
            says("handled")
        }),
    );
    board
        .transfer_ctx(&transcript("alpha"), "alpha", "", "")
        .await;
    board
        .start_background_part("beta", "beta chart")
        .await
        .expect("beta resident");
    let resident = board.background_agents.get("beta").unwrap().clone();

    let reply = board
        .route_project_part(
            "show me beta",
            "beta",
            crate::router::ConversationMode::Continue,
            None,
        )
        .await;

    assert!(reply.error.is_some(), "adoption must fail: {reply:?}");
    assert!(!resident.alive());
    // A candidate left staged would hold the call in `Starting`, where the
    // coordinator refuses every later prompt.
    assert!(!board.coordinator.is_candidate());
    assert_eq!(board.coordinator.route(), "alpha");
    assert_eq!(
        board.agent.as_ref().map(|agent| agent.label().to_owned()),
        Some("alpha".to_owned())
    );
    assert_eq!(
        board
            .session_control()
            .lock()
            .await
            .as_ref()
            .map(|session| session.label().to_owned()),
        Some("alpha".to_owned()),
        "the leg the caller stayed on is back on the session guard"
    );
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_promoted_agent_holds_the_session_guard_during_its_foreground_turn() {
    let mut board = board_with(vec![project("alpha", ""), project("beta", "")], false);
    let control = board.session_control();
    let guard_during_turn = Arc::new(StdMutex::new(None::<String>));
    let guard_for_prompt = guard_during_turn.clone();
    let _log = serve(
        &board,
        Box::new(move |_, message| {
            if message.contains("show me beta") {
                // What a steer or a page rescue would reach right now. A
                // guard held across the prompt records nothing, and the
                // assertion below says so; a panic here would only hang
                // the prompt.
                let label = control
                    .try_lock()
                    .ok()
                    .and_then(|guard| guard.as_ref().map(|session| session.label().to_owned()));
                *guard_for_prompt.lock().unwrap() = label;
            }
            says("handled")
        }),
    );
    board
        .transfer_ctx(&transcript("alpha"), "alpha", "", "")
        .await;
    board
        .start_background_part("beta", "beta chart")
        .await
        .expect("beta resident");

    let reply = board
        .route_project_part(
            "show me beta",
            "beta",
            crate::router::ConversationMode::Continue,
            None,
        )
        .await;

    assert_eq!(reply.route, "beta", "{reply:?}");
    assert_eq!(
        guard_during_turn.lock().unwrap().as_deref(),
        Some("beta"),
        "the leg being promoted is the one steering and rescue must reach \
         (None: the guard was empty, or held across the prompt)"
    );
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_promotion_turn_gives_the_session_guard_back() {
    let mut board = board_with(vec![project("alpha", ""), project("beta", "")], false);
    let mut fake = FakeHostAgent::new(Box::new(|_, _| says("handled")));
    fake.on_command = Some(Box::new(|name, args| {
        (name == "prompt"
            && args["message"]
                .as_str()
                .is_some_and(|message| message.contains("show me beta")))
        .then(|| Some(Err(("prompt_failed".into(), "promotion failed".into()))))
    }));
    fake.serve(board.hosts().connect_fake(HOST));
    board
        .transfer_ctx(&transcript("alpha"), "alpha", "", "")
        .await;
    board
        .start_background_part("beta", "beta chart")
        .await
        .expect("beta resident");

    let reply = board
        .route_project_part(
            "show me beta",
            "beta",
            crate::router::ConversationMode::Continue,
            None,
        )
        .await;

    assert!(reply.error.is_some(), "the promotion must fail: {reply:?}");
    assert_eq!(board.coordinator.route(), "alpha");
    let guard = board.session_control();
    let guard = guard.lock().await;
    let held = guard.as_ref().expect("alpha is back on the guard");
    assert!(held.same_session(&LegSession::Project(
        board.agent.clone().expect("alpha is still on the line")
    )));
    drop(guard);
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_promotion_whose_turn_fails_without_detail_reports_the_fallback() {
    let mut board = board_with(vec![project("alpha", ""), project("beta", "")], false);
    let mut fake = FakeHostAgent::new(Box::new(|_, _| says("handled")));
    fake.on_command = Some(Box::new(|name, args| {
        (name == "prompt"
            && args["message"]
                .as_str()
                .is_some_and(|message| message.contains("show me beta")))
        .then(|| Some(Err(("prompt_failed".into(), String::new()))))
    }));
    fake.serve(board.hosts().connect_fake(HOST));
    board
        .transfer_ctx(&transcript("alpha"), "alpha", "", "")
        .await;
    board
        .start_background_part("beta", "beta chart")
        .await
        .expect("beta resident");

    let reply = board
        .route_project_part(
            "show me beta",
            "beta",
            crate::router::ConversationMode::Continue,
            None,
        )
        .await;

    assert_eq!(
        reply.error.as_deref(),
        Some("the agent never answered"),
        "{reply:?}"
    );
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_promotion_and_a_transfer_commit_their_steps_in_one_order() {
    let mut board = board_with(
        vec![
            project("alpha", ""),
            project("beta", ""),
            project("gamma", ""),
        ],
        false,
    );
    let events = Arc::new(StdMutex::new(Vec::<String>::new()));
    let notices = events.clone();
    board.set_agent_state_callback(Some(Arc::new(move |notice| {
        notices
            .lock()
            .unwrap()
            .push(format!("{}:{}", notice.project, notice.state));
        Box::pin(async {})
    })));
    let routes = events.clone();
    let control = board.session_control();
    let coordinator = board.coordinator();
    board.set_route_callback(Some(Arc::new(move || {
        // The route is announced last: the coordinator and the session
        // guard already name the new leg.
        let guard = control
            .try_lock()
            .expect("the guard is free when the route is announced")
            .as_ref()
            .map(|session| session.label().to_owned())
            .unwrap_or_default();
        routes
            .lock()
            .unwrap()
            .push(format!("route:{}:{guard}", coordinator.route()));
        Box::pin(async {})
    })));
    let _log = serve(&board, Box::new(|_, _| says("handled")));

    board
        .transfer_ctx(&transcript("alpha"), "alpha", "", "")
        .await;
    board
        .start_background_part("beta", "beta chart")
        .await
        .expect("beta resident");
    // Let the resident's own turn settle before recording.
    tokio::time::timeout(Duration::from_secs(5), async {
        while !events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event == "beta:idle")
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the resident's turn settles");
    events.lock().unwrap().clear();

    // A background promotion: alpha is shelved before beta settles.
    let reply = board
        .route_project_part(
            "show me beta",
            "beta",
            crate::router::ConversationMode::Continue,
            None,
        )
        .await;
    assert_eq!(reply.route, "beta", "{reply:?}");
    let promoted = std::mem::take(&mut *events.lock().unwrap());

    // A fresh transfer from a project: beta is shelved before gamma settles.
    let reply = board
        .transfer_ctx(&transcript("gamma"), "gamma", "", "")
        .await;
    assert_eq!(reply.route, "gamma", "{reply:?}");
    let transferred = std::mem::take(&mut *events.lock().unwrap());

    let committed = |from: &str, to: &str| {
        vec![
            format!("{to}:busy"),
            format!("{from}:idle"),
            format!("{to}:idle"),
            format!("route:{to}:{to}"),
        ]
    };
    assert_eq!(promoted, committed("alpha", "beta"));
    assert_eq!(transferred, committed("beta", "gamma"));
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_dead_background_resident_is_removed_before_a_later_split_part() {
    let mut board = board_with(vec![project("alpha", ""), project("beta", "")], false);
    let (prompt_tx, mut prompt_rx) = tokio::sync::mpsc::unbounded_channel();
    let log = serve(
        &board,
        Box::new(move |session, message| {
            let _ = prompt_tx.send((session.to_owned(), message.to_owned()));
            says("handled")
        }),
    );
    board
        .transfer_ctx(&transcript("alpha"), "alpha", "", "")
        .await;
    board
        .dispatch_parts(
            "first",
            vec![
                crate::router::DispatchPart {
                    agent: "alpha".into(),
                    text: "alpha one".into(),
                },
                crate::router::DispatchPart {
                    agent: "beta".into(),
                    text: "beta one".into(),
                },
            ],
        )
        .await;
    while let Some((session, message)) = prompt_rx.recv().await {
        if session == "s2" && message.contains("beta one") {
            break;
        }
    }
    let dead = board.background_agents.get("beta").unwrap().clone();
    let old_session_id = dead.session_id().to_owned();
    dead.close();
    assert!(!dead.alive());
    let creates = log.named("create_session").len();

    board
        .start_background_part("beta", "beta after host close")
        .await
        .expect("a dead resident is replaced by a fresh session");
    let mut saw_fresh_prompt = false;
    while let Some((session, message)) = prompt_rx.recv().await {
        if session == "s3" && message.contains("beta after host close") {
            saw_fresh_prompt = true;
            break;
        }
    }
    assert!(
        saw_fresh_prompt,
        "the replacement session received the split part"
    );
    assert_eq!(log.named("create_session").len(), creates + 1);
    assert_ne!(
        board.background_agents.get("beta").unwrap().session_id(),
        old_session_id
    );
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn busy_background_split_part_is_refused_and_fresh_brings_the_live_agent_forward() {
    let mut board = board_with(vec![project("alpha", ""), project("beta", "")], false);
    let (prompt_tx, mut prompt_rx) = tokio::sync::mpsc::unbounded_channel();
    let log = serve(
        &board,
        Box::new(move |session, message| {
            let _ = prompt_tx.send((session.to_owned(), message.to_owned()));
            if session == "s2" {
                vec![Step::Hold]
            } else {
                says("handled")
            }
        }),
    );
    board
        .transfer_ctx(&transcript("alpha"), "alpha", "", "")
        .await;
    board
        .dispatch_parts(
            "first",
            vec![
                crate::router::DispatchPart {
                    agent: "alpha".into(),
                    text: "alpha one".into(),
                },
                crate::router::DispatchPart {
                    agent: "beta".into(),
                    text: "beta busy".into(),
                },
            ],
        )
        .await;
    while let Some((session, message)) = prompt_rx.recv().await {
        if session == "s2" && message.contains("beta busy") {
            break;
        }
    }
    let creates = log.named("create_session").len();
    board
        .dispatch_parts(
            "second",
            vec![
                crate::router::DispatchPart {
                    agent: "alpha".into(),
                    text: "alpha two".into(),
                },
                crate::router::DispatchPart {
                    agent: "beta".into(),
                    text: "beta refused".into(),
                },
            ],
        )
        .await;
    assert_eq!(log.named("create_session").len(), creates);
    // Fresh for an agent already on this call brings it forward instead of
    // refusing or starting a second session: the caller's words reach beta.
    let forward = board.route_project_part(
        "fresh beta",
        "beta",
        crate::router::ConversationMode::Fresh,
        None,
    );
    tokio::pin!(forward);
    loop {
        tokio::select! {
            reply = &mut forward => {
                assert_eq!(reply.error, None);
                assert_eq!(reply.route, "beta");
                break;
            }
            Some((session, message)) = prompt_rx.recv() => {
                if message.contains("fresh beta") {
                    assert_eq!(session, "s2");
                    break;
                }
            }
        }
    }
    assert_eq!(log.named("create_session").len(), creates);
}

#[cfg(unix)]
#[tokio::test]
async fn stop_requires_confirmation_before_closing_a_project() {
    let (mut board, _log) = on_alpha(&[], Box::new(|_, _| says("handled"))).await;
    let stop = Decision {
        action: crate::router::Action::Stop,
        target: Some("alpha".into()),
        continue_or_fresh: None,
        confidence: 1.0,
        for_current_agent: 1.0,
        multi_target: false,
        unsure: false,
        confirm: true,
        reason: "stop requested".into(),
    };
    let ask = board.handle_decision("stop alpha", &stop).await;
    assert!(ask.text.contains("Say yes to confirm"));
    assert!(
        board.agent.is_some(),
        "confirmation does not stop the session"
    );
    let stopped = board
        .handle_decision("yes", &Decision::fallback("confirmation"))
        .await;
    assert_eq!(stopped.route, OPERATOR);
    assert!(board.agent.is_none());
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn the_operator_gets_the_call_state_once_per_utterance() {
    let root = scratch_dir("operator-call-state");
    let seen = root.join("operator-input");
    let binary = root.join("fake-operator");
    crate::pi_client::write_executable_script(
        &binary,
        &format!(
            r#"while IFS= read -r line; do
  printf '%s\n' "$line" >> '{seen}'
  printf '%s\n' '{{"type":"message_update","assistantMessageEvent":{{"type":"text_end","content":"Operator here."}}}}'
  printf '%s\n' '{{"type":"agent_settled"}}'
done
"#,
            seen = seen.display()
        ),
    );
    let mut board = board_on(
        vec![project("alpha", "Alpha project")],
        &[("SWITCHBOARD_PI_BINARY", &binary.to_string_lossy())],
        two_model_catalog(),
    );
    let general = decision(crate::router::Action::General, None, None);

    board.set_call_state("The caller is on: the front desk.\n- alpha: idle, in the background, has a display the caller has not seen".into());
    let first = board.handle_decision("what is ready?", &general).await;
    assert_eq!(first.text, "Operator here.");
    let second = board.handle_decision("thanks", &general).await;
    assert_eq!(second.text, "Operator here.");

    let input = std::fs::read_to_string(&seen).unwrap();
    let lines = input.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 2, "{input}");
    assert!(lines[0].contains("[CALL STATE]"), "{}", lines[0]);
    assert!(
        lines[0].contains("has a display the caller"),
        "{}",
        lines[0]
    );
    assert!(lines[0].contains("what is ready?"), "{}", lines[0]);
    // The state belongs to one utterance; a later turn without a fresh
    // state must not repeat stale facts.
    assert!(!lines[1].contains("[CALL STATE]"), "{}", lines[1]);
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn a_route_to_an_unregistered_project_keeps_the_caller_on_the_line() {
    let (mut board, log) = on_alpha(&[], Box::new(|_, _| says("handled"))).await;
    let creates = log.named("create_session").len();

    let reply = board
        .route_project_part(
            "show me",
            "ghost",
            crate::router::ConversationMode::Continue,
            None,
        )
        .await;

    assert_eq!(reply.route, "alpha");
    assert_eq!(reply.error.as_deref(), Some("unknown project \"ghost\""));
    assert_eq!(board.coordinator.route(), "alpha");
    assert_eq!(log.named("create_session").len(), creates);
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn go_to_project_with_fresh_brings_a_live_background_agent_forward() {
    let mut board = board_with(vec![project("alpha", ""), project("beta", "")], false);
    let (prompt_tx, mut prompt_rx) = tokio::sync::mpsc::unbounded_channel();
    let log = serve(
        &board,
        Box::new(move |session, message| {
            let _ = prompt_tx.send((session.to_owned(), message.to_owned()));
            says("handled")
        }),
    );
    board
        .transfer_ctx(&transcript("alpha"), "alpha", "", "")
        .await;
    board
        .dispatch_parts(
            "both",
            vec![
                crate::router::DispatchPart {
                    agent: "alpha".into(),
                    text: "alpha part".into(),
                },
                crate::router::DispatchPart {
                    agent: "beta".into(),
                    text: "beta chart".into(),
                },
            ],
        )
        .await;
    while let Some((_, message)) = prompt_rx.recv().await {
        if message.contains("beta chart") {
            break;
        }
    }
    let creates = log.named("create_session").len();

    let reply = board
        .handle_decision(
            "pull that beta thing up",
            &decision(
                crate::router::Action::GoToProject,
                Some("beta"),
                Some(crate::router::ConversationMode::Fresh),
            ),
        )
        .await;

    assert_eq!(reply.error, None, "{reply:?}");
    assert_eq!(reply.route, "beta");
    assert_eq!(log.named("create_session").len(), creates);
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_split_part_for_an_unregistered_project_is_dropped() {
    let (mut board, log) = on_alpha(&[], Box::new(|_, _| says("handled"))).await;
    let creates = log.named("create_session").len();

    let reply = board
        .dispatch_parts(
            "both",
            vec![
                crate::router::DispatchPart {
                    agent: "ghost".into(),
                    text: "ghost part".into(),
                },
                crate::router::DispatchPart {
                    agent: "alpha".into(),
                    text: "alpha part".into(),
                },
            ],
        )
        .await;

    assert_eq!(reply.route, "alpha");
    assert_eq!(log.named("create_session").len(), creates);
    assert!(!prompts(&log)
        .iter()
        .any(|prompt| prompt.contains("ghost part")));
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_move_to_the_background_closes_the_previous_agent() {
    let mut board = board_with(vec![project("alpha", ""), project("beta", "")], false);
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
    let mut fake = FakeHostAgent::new(Box::new(|_, _| says("handled")));
    fake.on_command = Some(Box::new(|name, args| {
        (name == "set_mode" && args.get("mode").and_then(Value::as_str) == Some("background"))
            .then(|| Some(Err(("mode_failed".into(), "cannot switch mode".into()))))
    }));
    fake.serve(board.hosts().connect_fake(HOST));
    board
        .transfer_ctx(&transcript("alpha"), "alpha", "", "")
        .await;
    let alpha = board.agent.clone().expect("alpha on the line");

    let reply = board
        .route_project_part(
            "beta please",
            "beta",
            crate::router::ConversationMode::Continue,
            None,
        )
        .await;

    assert_eq!(reply.route, "beta", "{reply:?}");
    assert!(!board.background_agents.contains_key("alpha"));
    assert!(!alpha.alive());
    assert!(notices
        .lock()
        .unwrap()
        .contains(&"alpha:finished".to_owned()));
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_promoted_agent_is_told_it_is_in_the_foreground() {
    let mut board = board_with(vec![project("alpha", ""), project("beta", "")], false);
    let (prompt_tx, mut prompt_rx) = tokio::sync::mpsc::unbounded_channel();
    let _log = serve(
        &board,
        Box::new(move |session, message| {
            let _ = prompt_tx.send((session.to_owned(), message.to_owned()));
            says("handled")
        }),
    );
    board
        .transfer_ctx(&transcript("alpha"), "alpha", "", "")
        .await;
    board
        .start_background_part("beta", "beta chart")
        .await
        .expect("beta resident");
    while let Some((_, message)) = prompt_rx.recv().await {
        if message.contains("beta chart") {
            break;
        }
    }

    let reply = board
        .route_project_part(
            "show me beta",
            "beta",
            crate::router::ConversationMode::Continue,
            None,
        )
        .await;

    assert_eq!(reply.route, "beta", "{reply:?}");
    let promoted = loop {
        let (_, message) = prompt_rx.recv().await.expect("promotion prompt");
        if message.contains("show me beta") {
            break message;
        }
    };
    assert!(
        promoted.contains("you are in the foreground now"),
        "{promoted}"
    );
    assert!(promoted.ends_with("show me beta"), "{promoted}");
    board.shutdown().await;
}

/// The debug events published so far, oldest first.
fn debug_events(board: &Switchboard) -> Vec<crate::debug::DebugEvent> {
    board.debug.events_for_test()
}

/// The routing trace of `board`: each hop as `kind:detail`.
fn route_trace(board: &Switchboard) -> Vec<String> {
    use crate::debug::DebugEvent;
    debug_events(board)
        .into_iter()
        .filter_map(|event| match event {
            DebugEvent::PbxBranch {
                utterance_id,
                branch,
                ..
            } => Some(format!("{utterance_id}:branch:{branch}")),
            DebugEvent::UtilityRequest {
                utterance_id,
                attempt,
                ..
            } => Some(format!("{utterance_id}:utility_request:{attempt}")),
            DebugEvent::UtilityDecision {
                utterance_id,
                attempt,
                decision,
                ..
            } => Some(format!(
                "{utterance_id}:utility_decision:{attempt}:{}",
                decision["kind"].as_str().unwrap()
            )),
            DebugEvent::OperatorHop {
                utterance_id,
                outcome,
                ..
            } => Some(format!("{utterance_id}:operator_hop:{outcome}")),
            DebugEvent::OperatorRouteTool {
                utterance_id,
                target,
                mode,
                action,
            } => Some(format!(
                "{utterance_id}:route_tool:{target}:{mode}:{action}"
            )),
            DebugEvent::Routed {
                utterance_id,
                to_agent,
                mode,
                via,
                ..
            } => Some(format!("{utterance_id}:routed:{to_agent}:{mode}:{via}")),
            _ => None,
        })
        .collect()
}

#[cfg(unix)]
#[tokio::test]
async fn an_unsure_utterance_traces_the_utility_second_opinion_to_its_destination() {
    let root = scratch_dir("trace-second-opinion");
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
    let mut unsure = decision(crate::router::Action::General, None, None);
    unsure.unsure = true;

    let reply = board.handle_decision("inspect alpha", &unsure).await;

    assert_eq!(reply.route, "alpha");
    assert_eq!(
        route_trace(&board),
        vec![
            "utterance:branch:utility",
            "utterance:utility_request:first",
            "utterance:utility_decision:first:second_opinion",
            "utterance:routed:alpha:fresh:utility",
        ]
    );
    let request = debug_events(&board)
        .into_iter()
        .find_map(|event| match event {
            crate::debug::DebugEvent::UtilityRequest { prompt, .. } => Some(prompt),
            _ => None,
        })
        .expect("utility request");
    assert!(request.contains("inspect alpha"), "{request}");
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn an_unregistered_utility_target_is_traced_as_refused_not_routed() {
    let root = scratch_dir("trace-refused-target");
    let binary = fake_routing_process(
        &root,
        r#"{"type":"tool_execution_start","toolName":"second_opinion","args":{"target":"nope","mode":"fresh","confident":true}}"#,
        None,
    );
    let mut board = board_on(
        vec![project("alpha", "Alpha project")],
        &[("SWITCHBOARD_PI_BINARY", &binary.to_string_lossy())],
        two_model_catalog(),
    );
    let mut unsure = decision(crate::router::Action::General, None, None);
    unsure.unsure = true;

    let reply = board.handle_decision("inspect nope", &unsure).await;

    assert_eq!(reply.route, OPERATOR);
    assert_eq!(
        route_trace(&board),
        vec![
            "utterance:branch:utility",
            "utterance:utility_request:first",
            "utterance:utility_decision:first:second_opinion",
            "utterance:branch:refused_unknown_target",
            "utterance:routed:operator:continue:pbx",
        ]
    );
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn a_split_retry_traces_both_attempts_and_fans_out_to_every_part() {
    let root = scratch_dir("trace-split-retry");
    let (binary, _calls) = fake_routing_process_sequence(
        &root,
        &[
            r#"{"type":"tool_execution_start","toolName":"second_opinion","args":{"target":"alpha","mode":"continue","confident":true}}"#,
            r#"{"type":"tool_execution_start","toolName":"dispatch_parts","args":{"parts":[{"agent":"alpha","text":"alpha work"},{"agent":"beta","text":"beta work"}]}}"#,
        ],
        r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Operator asked."}}"#,
    );
    let mut board = board_on(
        vec![project("alpha", "Alpha"), project("beta", "Beta")],
        &[("SWITCHBOARD_PI_BINARY", &binary.to_string_lossy())],
        two_model_catalog(),
    );
    let _log = serve(&board, Box::new(|_, _| says("on it")));
    let mut multi = decision(crate::router::Action::GoToProject, Some("alpha"), None);
    multi.multi_target = true;

    board
        .handle_decision("alpha work and beta work", &multi)
        .await;

    assert_eq!(
        route_trace(&board),
        vec![
            "utterance:branch:utility",
            "utterance:utility_request:first",
            "utterance:utility_decision:first:second_opinion",
            "utterance:utility_request:split_retry",
            "utterance:utility_decision:split_retry:dispatch_parts",
            "utterance:routed:alpha:continue:utility",
            "utterance:routed:beta:continue:utility",
        ]
    );
    // Both parts' prompts carry the utterance, the background one too, which
    // is sent from its own task after the decision has ended.
    let inputs = || {
        debug_events(&board)
            .into_iter()
            .filter_map(|event| match event {
                crate::debug::DebugEvent::AgentInput {
                    agent,
                    utterance_id,
                    ..
                } => Some((agent, utterance_id)),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while !inputs().iter().any(|(agent, _)| agent == "beta") {
        assert!(
            tokio::time::Instant::now() < deadline,
            "no beta input: {:?}",
            inputs()
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    for agent in ["alpha", "beta"] {
        assert!(
            inputs()
                .iter()
                .any(|(name, id)| name == agent && id.as_deref() == Some("utterance")),
            "{agent}: {:?}",
            inputs()
        );
    }
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn the_operator_route_tool_is_traced_as_its_own_hop() {
    let root = scratch_dir("trace-operator-route");
    let operator = fake_operator(&root);
    let mut board = board_on(
        vec![project("alpha", "Alpha")],
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
        two_model_catalog(),
    );
    let _log = serve(&board, Box::new(|_, _| says("Alpha here.")));

    let reply = board
        .handle_decision(
            "get me alpha",
            &decision(crate::router::Action::General, None, None),
        )
        .await;

    assert_eq!(reply.route, "alpha");
    assert_eq!(
        route_trace(&board),
        vec![
            "utterance:branch:operator",
            "utterance:operator_hop:route_tool",
            "utterance:route_tool:alpha:fresh:transfer",
            "utterance:routed:alpha:fresh:operator",
        ]
    );
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn jev_branches_are_traced_and_work_outside_a_decision_is_not() {
    let mut board = board_on(vec![project("alpha", "Alpha")], &[], two_model_catalog());
    let _log = serve(&board, Box::new(|_, _| says("Alpha here.")));
    // A direct transfer is not a caller utterance: nothing is traced.
    board
        .transfer_ctx(&transcript("connect alpha"), "alpha", "", "")
        .await;
    assert!(route_trace(&board).is_empty());

    board
        .handle_decision(
            "keep going",
            &decision(crate::router::Action::Continue, None, None),
        )
        .await;
    board
        .handle_decision(
            "stop alpha",
            &decision(crate::router::Action::Stop, Some("alpha"), None),
        )
        .await;
    board
        .handle_decision("yes", &decision(crate::router::Action::General, None, None))
        .await;
    board
        .handle_decision(
            "back to alpha",
            &decision(
                crate::router::Action::GoToProject,
                Some("alpha"),
                Some(ConversationMode::Fresh),
            ),
        )
        .await;

    assert_eq!(
        route_trace(&board),
        vec![
            "utterance:branch:continue_current",
            "utterance:routed:alpha:continue:jev",
            "utterance:branch:stop_asked",
            "utterance:routed:operator:continue:pbx",
            "utterance:branch:stop_confirmed",
            "utterance:routed:operator:continue:pbx",
            "utterance:branch:go_to_project",
            "utterance:routed:alpha:fresh:jev",
        ]
    );
    board.shutdown().await;
}

#[tokio::test]
async fn a_cancelled_decision_leaves_no_utterance_behind() {
    let board = board_on(vec![], &[], two_model_catalog());
    {
        let _scope = UtteranceScope::enter(&board.decisions.trace_utterance, "clip-9");
        assert_eq!(board.current_utterance().as_deref(), Some("clip-9"));
    }
    assert_eq!(board.current_utterance(), None);
}

#[cfg(unix)]
#[tokio::test]
async fn an_operator_answer_ends_the_trace_at_the_operator() {
    let root = scratch_dir("trace-operator-answer");
    let binary = fake_routing_process(
        &root,
        r#"{"type":"tool_execution_start","toolName":"second_opinion","args":{"target":"operator","mode":"continue","confident":true}}"#,
        Some(
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Operator here."}}"#,
        ),
    );
    let mut board = board_on(
        vec![project("alpha", "Alpha")],
        &[("SWITCHBOARD_PI_BINARY", &binary.to_string_lossy())],
        two_model_catalog(),
    );
    let reply = board
        .handle_decision(
            "what time is it",
            &decision(crate::router::Action::General, None, None),
        )
        .await;
    assert_eq!(reply.text, "Operator here.");
    // The utility can name the operator too; the operator's answer is still
    // the one destination.
    let mut unsure = decision(crate::router::Action::General, None, None);
    unsure.unsure = true;
    board.handle_decision("and the date", &unsure).await;

    assert_eq!(
        route_trace(&board),
        vec![
            "utterance:branch:operator",
            "utterance:operator_hop:answered",
            "utterance:routed:operator:continue:operator",
            "utterance:branch:utility",
            "utterance:utility_request:first",
            "utterance:utility_decision:first:second_opinion",
            "utterance:operator_hop:answered",
            "utterance:routed:operator:continue:operator",
        ]
    );
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

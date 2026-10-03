use super::*;
use crate::hosts::{FakeHostAgent, Step};
use crate::router::{Action, ConversationMode};
use serde_json::{json, Value};
use std::sync::Mutex as StdMutex;

/// An operator stand-in: its first prompt puts the caller through to alpha
/// (with `intent` "inspect it"), later ones answer "Operator has you again.",
/// or "NOTE_DELIVERED" when the prompt carries "work complete".
#[cfg(unix)]
fn fake_operator(root: &std::path::Path) -> std::path::PathBuf {
    let operator = root.join("fake-operator");
    crate::pi_client::write_executable_script(
        &operator,
        r##"count=0
while IFS= read -r line; do
count=$((count + 1))
if [ "$count" -eq 1 ]; then
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Connecting now."}}'
    printf '%s\n' '{"type":"tool_execution_start","toolName":"route","args":{"target":"alpha","mode":"fresh"}}'
else
    case "$line" in
        *"work complete"*) printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"NOTE_DELIVERED"}}' ;;
        *) printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Operator has you again."}}' ;;
    esac
fi
printf '%s\n' '{"type":"agent_settled"}'
done
"##,
    );
    operator
}

/// A local pi stand-in that emits one structured utility verdict. Its
/// non-utility branch is configurable so tests can hold the conversational
/// operator's turn lock without involving a real process.
#[cfg(unix)]
fn fake_routing_process(
    root: &std::path::Path,
    utility_event: &str,
    operator_event: Option<&str>,
) -> std::path::PathBuf {
    let path = root.join("fake-routing-process");
    let operator_branch = operator_event.map_or_else(
        || "while IFS= read -r _line; do sleep 60; done".to_owned(),
        |event| {
            format!(
                "while IFS= read -r _line; do printf '%s\n' '{event}'; printf '%s\n' '{{\"type\":\"agent_settled\"}}'; done"
            )
        },
    );
    let body = format!(
        r#"is_utility=0
for arg in "$@"; do
  if [ "$arg" = "--switchboard-utility" ]; then is_utility=1; fi
done
if [ "$is_utility" -eq 1 ]; then
  while IFS= read -r _line; do
    printf '%s\n' '{utility_event}'
    printf '%s\n' '{{"type":"agent_settled"}}'
  done
else
  {operator_branch}
fi
"#,
        utility_event = utility_event,
        operator_branch = operator_branch,
    );
    crate::pi_client::write_executable_script(&path, &body);
    path
}

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

/// A model or thinking change as the switchboard makes one: decided without
/// the PBX lock, then run if it goes ahead.
async fn redialed(board: &mut Switchboard, decided: Redial) -> Reply {
    match decided {
        Redial::Answered(reply) => reply,
        Redial::Planned(plan) => board
            .redial(*plan)
            .await
            .expect("the leg the redial was planned for is still on the line"),
    }
}

fn assert_background_registry_consistent(board: &Switchboard) {
    for (project, alive, _) in board.residents_for_test() {
        assert!(alive, "dead resident remains registered: {project}");
        assert!(board.coordinator().project_is_background(&project));
    }
}

fn read_lines(path: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

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

#[test]
fn transfer_model_requests_obey_the_swap_gate_and_pin_defaults() {
    let project = Project {
        id: "alpha".into(),
        description: String::new(),
        aliases: vec![],
        host: None,
        cwd: String::new(),
        model: Some("anthropic/default".into()),
        prepare: String::new(),
    };
    let unlisted = ModelCatalog::unavailable("listing failed");

    let disabled = board_with(vec![project.clone()], false);
    assert_eq!(
        disabled.select_transfer_model(&project, &unlisted, "other/requested", "high"),
        Ok("anthropic/default:medium".into())
    );

    let enabled = board_with(vec![project.clone()], true);
    assert_eq!(
        enabled.select_transfer_model(&project, &unlisted, "", ""),
        Ok("anthropic/default:medium".into())
    );
    assert_eq!(
        enabled.select_transfer_model(&project, &unlisted, "other/requested:high", ""),
        Ok("other/requested:high".into())
    );
}

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
async fn model_swap_refuses_unknown_catalog_model_without_replacing_live_spec() {
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
        two_model_catalog(),
    );

    let Redial::Answered(reply) = board.planner.model_change("anthropic/missing").await else {
        panic!("a model the catalog does not resolve is refused before anything is torn down");
    };

    assert!(reply.error.is_some());
    assert_eq!(board.coordinator.status().model, "anthropic/current:high");
}

#[test]
fn transfer_model_selection_honors_thinking_without_model() {
    let project = Project {
        id: "alpha".into(),
        description: String::new(),
        aliases: vec![],
        host: None,
        cwd: String::new(),
        model: Some("anthropic/current".into()),
        prepare: String::new(),
    };
    let board = board_with(vec![project.clone()], true);
    assert_eq!(
        board.select_transfer_model(&project, &two_model_catalog(), "", "high"),
        Ok("anthropic/current:high".into())
    );
}

#[tokio::test]
async fn transfer_ctx_ambiguous_project_returns_candidate_options() {
    let p1 = Project {
        id: "proj-a".into(),
        description: String::new(),
        aliases: vec!["shared".into()],
        host: None,
        cwd: String::new(),
        model: None,
        prepare: String::new(),
    };
    let p2 = Project {
        id: "proj-b".into(),
        description: String::new(),
        aliases: vec!["shared".into()],
        host: None,
        cwd: String::new(),
        model: None,
        prepare: String::new(),
    };

    let mut board = board_with(vec![p1, p2], true);
    let ctx = TransferContext {
        exact_caller_transcript: "transfer to shared".into(),
        derived_intent: String::new(),
    };

    let reply = board.transfer_ctx(&ctx, "shared", "", "").await;
    assert!(reply
        .to_speak
        .iter()
        .any(|s| s.contains("Which project did you mean by shared? It could be proj-a, proj-b.")));
    assert!(board
        .operator_note
        .as_deref()
        .unwrap_or("")
        .contains("Couldn't tell which project \"shared\" meant: proj-a, proj-b."));
}

#[tokio::test]
async fn jev_transfer_omits_the_internal_reason_from_the_intro_prompt() {
    let mut board = board_on(
        vec![project("alpha", "test project")],
        &[],
        two_model_catalog(),
    );
    let log = serve(&board, Box::new(|_, _| says("Alpha is ready.")));
    let decision = Decision {
        action: crate::router::Action::GoToProject,
        target: Some("alpha".into()),
        continue_or_fresh: None,
        confidence: 1.0,
        for_current_agent: 0.0,
        multi_target: false,
        unsure: false,
        confirm: false,
        reason: "internal Jev reason must not become caller intent".into(),
    };

    let reply = board.handle_decision("put me through", &decision).await;
    assert_eq!(reply.route, "alpha");
    let prompt = prompts(&log).into_iter().next().expect("intro prompt");
    assert!(prompt.contains("put me through"), "{prompt}");
    assert!(!prompt.contains("[WHAT THEY SEEM TO WANT]"), "{prompt}");
    assert!(!prompt.contains("internal Jev reason"), "{prompt}");
    board.shutdown().await;
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

#[test]
fn the_operator_and_the_utility_get_the_same_voice_block_and_persona() {
    let board = board_on(
        vec![project("alpha", "Alpha project")],
        &[("SWITCHBOARD_PERSONA", "Gruff and short.")],
        two_model_catalog(),
    );
    let operator = board.operator_prompt_suffix();
    let utility = board.utility_system_prompt();
    for prompt in [&operator, &utility] {
        assert_eq!(
            prompt.matches("[HOW YOU TALK ON THE CALL]").count(),
            1,
            "{prompt}"
        );
        assert!(prompt.contains("Character:\nGruff and short."), "{prompt}");
        assert!(prompt.contains("- alpha - Alpha project"), "{prompt}");
    }
}

#[tokio::test]
async fn a_takeover_of_an_unknown_project_names_the_ones_there_are() {
    let mut board = board_with(vec![project("alpha", ""), project("beta", "")], false);
    let reply = board.take_over("take over gamma", "gamma", Ok(None)).await;
    assert_eq!(
        reply.to_speak,
        ["I don't have a project called gamma. The ones I have are alpha, beta."]
    );
}

#[test]
fn an_empty_persona_leaves_the_character_out() {
    let board = board_with(vec![project("alpha", "Alpha project")], false);
    let operator = board.operator_prompt_suffix();
    assert!(
        operator.contains("[HOW YOU TALK ON THE CALL]"),
        "{operator}"
    );
    assert!(!operator.contains("Character:"), "{operator}");
}

#[test]
fn the_utility_system_prompt_holds_the_rules_and_the_catalog_once() {
    let board = board_with(
        vec![
            project("grape-segmentation", "Grape"),
            project("switchboard", "Switchboard"),
        ],
        true,
    );
    let prompt = board.utility_system_prompt();
    assert!(prompt.contains("[ROUTING REQUEST]"), "{prompt}");
    assert!(prompt.contains("[FLOOR REWRITE]"), "{prompt}");
    assert!(prompt.contains("dispatch_parts"), "{prompt}");
    assert!(
        prompt.contains("Never say something is on screen"),
        "{prompt}"
    );
    assert!(
        prompt.contains("say it is ready when they want it"),
        "{prompt}"
    );
    assert!(prompt.contains("- grape-segmentation - Grape"), "{prompt}");
    assert!(prompt.contains("- switchboard - Switchboard"), "{prompt}");
    assert_eq!(prompt.matches("Registered projects").count(), 1, "{prompt}");
    // Voice block, then catalog: the same order the operator gets.
    assert!(
        prompt.find("[HOW YOU TALK ON THE CALL]") < prompt.find("Registered projects"),
        "{prompt}"
    );
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

#[test]
fn unicode_payload_preserved_in_transfer_context_and_intro_prompt() {
    let unicode_text = "Caller voice text with Unicode: 🌐 🚀 日本語, emoji, and quote \"hello\".";
    let context = TransferContext {
        exact_caller_transcript: unicode_text.to_owned(),
        derived_intent: "intent with 日本語".to_owned(),
    };
    let project = Project {
        id: "alpha".into(),
        description: "Alpha project".into(),
        aliases: vec![],
        host: None,
        cwd: "/srv/alpha".into(),
        model: None,
        prepare: String::new(),
    };
    let intro = build_intro_prompt(&context, &project, None);
    assert!(intro.contains(unicode_text));
    assert!(intro.contains("intent with 日本語"));
    assert!(!intro.contains("Bytes:"), "{intro}");
    assert!(
        intro.contains("[PROJECT]\nalpha - Alpha project"),
        "{intro}"
    );
}

#[test]
fn an_intro_from_the_page_says_to_wait_for_the_callers_words() {
    let project = Project {
        id: "alpha".into(),
        description: String::new(),
        aliases: vec![],
        host: None,
        cwd: "/srv/alpha".into(),
        model: None,
        prepare: String::new(),
    };
    let intro = build_intro_prompt(&TransferContext::default(), &project, None);
    assert!(intro.contains("[CALLER REQUEST]\n(none yet:"), "{intro}");
    assert!(intro.contains("Say nothing now."), "{intro}");
    assert!(!intro.contains("[STARTUP CHECK]"), "{intro}");
}

#[test]
fn model_fallback_preserves_qualified_and_rejects_bare_when_catalog_unavailable() {
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
    let unlisted = ModelCatalog::unavailable("listing failed");

    assert_eq!(
        board.select_transfer_model(&project, &unlisted, "anthropic/claude-3-5-sonnet", "high"),
        Ok("anthropic/claude-3-5-sonnet:high".into())
    );
    let bare = board.select_transfer_model(&project, &unlisted, "claude-3-5-sonnet", "high");
    assert!(bare.unwrap_err().contains("listing failed"));
}

#[cfg(unix)]
#[tokio::test]
async fn a_transfer_and_a_return_act_on_a_session_over_the_host_link() {
    let root = scratch_dir("transfer-return");
    let operator = fake_operator(&root);
    let mut board = board_on(
        vec![project("alpha", "test project")],
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
        two_model_catalog(),
    );
    let log = serve(
        &board,
        Box::new(|_, message| {
            if message.contains("we are done") {
                vec![
                    Step::Event(json!({"kind": "text", "text": "Alpha finished."})),
                    Step::Call("return_to_operator", json!({"summary": "work complete"})),
                ]
            } else {
                says("Alpha is ready.")
            }
        }),
    );
    // What the route callback finds when it is told the line has settled.
    let statuses = Arc::new(StdMutex::new(Vec::new()));
    let statuses_for_callback = Arc::clone(&statuses);
    let coordinator = board.coordinator();
    board.set_route_callback(Some(Arc::new(move || {
        let statuses = Arc::clone(&statuses_for_callback);
        let status = coordinator.status();
        Box::pin(async move {
            statuses.lock().unwrap().push(status);
        })
    })));

    let connected = board.handle("put me through").await;
    assert_eq!(connected.route, "alpha");
    assert_eq!(connected.text, "Alpha is ready.");
    assert_eq!(board.coordinator.route(), "alpha");
    // A resident session in the project's folder, on the call under a token
    // of its own.
    assert_eq!(
        log.named("create_session"),
        [json!({"project": "alpha", "config": {
            "cwd": "/srv/alpha", "provider": "anthropic", "model": "current", "thinking": "medium",
        }})]
    );
    let join = &log.named("join_call")[0];
    assert_eq!(join["session"], "s1");
    assert_eq!(join["speech_deadline_ms"], 25_000);
    assert_eq!(
        join["token"].as_str(),
        Some(board.coordinator.current_identity().token.as_str())
    );
    let announced = statuses.lock().unwrap().last().cloned().unwrap();
    assert_eq!(announced.route, "alpha");
    assert_eq!(announced.models.len(), 2);

    let returned = board.handle("we are done").await;
    // A host that still has the removed module receives a refusal. It cannot
    // move the caller or kill the live project leg.
    assert_eq!(returned.route, "alpha");
    assert!(returned.text.contains("Alpha finished."), "{returned:?}");
    assert_eq!(board.coordinator.route(), "alpha");
    assert!(board.agent.is_some());
    assert_eq!(log.named("kill").len(), 0);
    assert_eq!(
        log.module_replies()
            .iter()
            .map(|reply| reply["status"].clone())
            .collect::<Vec<_>>(),
        [json!("refused")]
    );
    assert_eq!(log.module_replies()[0]["reason"], "removed");
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn an_agent_to_agent_transfer_ends_the_old_session_after_the_new_one_is_up() {
    let root = scratch_dir("agent-to-agent");
    let operator = fake_operator(&root);
    let mut board = board_on(
        vec![
            project("alpha", "Alpha project"),
            project("beta", "Beta project"),
        ],
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
        two_model_catalog(),
    );
    let log = serve(
        &board,
        Box::new(|session, message| match (session, message) {
            ("s1", message) if message.contains("hand off") => vec![
                Step::Event(json!({"kind": "text", "text": "Alpha transferring to Beta."})),
                Step::Call(
                    "transfer_to_project",
                    json!({"project": "beta", "intent": "continue work"}),
                ),
            ],
            ("s1", _) => says("Alpha response."),
            _ => says("Beta response."),
        }),
    );

    let r1 = board.handle("connect me to alpha").await;
    assert_eq!(
        (r1.route.as_str(), r1.text.as_str()),
        ("alpha", "Alpha response.")
    );

    let r2 = board.handle("please hand off to beta").await;
    assert_eq!(r2.route, "alpha");
    assert_eq!(r2.text, "Alpha transferring to Beta.");
    assert!(r2.to_speak.is_empty());
    // The stale host's transfer signal is refused, so beta is never started.
    assert_eq!(log.named("create_session").len(), 1);
    assert!(log.named("kill").is_empty());
    assert_eq!(
        log.module_replies()
            .iter()
            .map(|reply| reply["status"].clone())
            .collect::<Vec<_>>(),
        [json!("refused")]
    );
    assert_eq!(log.module_replies()[0]["reason"], "removed");
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_transfer_to_a_host_that_is_not_connected_is_refused_with_the_reason() {
    let mut board = board_with(vec![project("alpha", "")], true);

    let reply = board
        .transfer_ctx(&transcript("look at alpha"), "alpha", "", "")
        .await;

    assert_eq!(reply.route, OPERATOR);
    // The reason is screen text; the caller hears plain words.
    assert_eq!(reply.to_speak, ["I couldn't open alpha."]);
    assert!(
        reply.text.contains("its host scriptorium is not connected"),
        "{}",
        reply.text
    );
    assert!(!board.coordinator.is_candidate());
    assert!(board
        .operator_note
        .as_deref()
        .unwrap()
        .starts_with("Couldn't open alpha:"));
}

#[tokio::test]
async fn a_transfer_resolves_a_bare_model_against_the_launch_catalog() {
    let mut board = board_with(vec![project("alpha", "")], true);
    let log = serve(&board, Box::new(|_, _| says("Ready.")));

    let reply = board
        .transfer_ctx(&transcript("connect me"), "alpha", "current", "high")
        .await;

    assert!(reply.error.is_none(), "transfer failed: {:?}", reply.error);
    assert_eq!(board.coordinator.status().model, "anthropic/current:high");
    assert_eq!(
        log.named("create_session")[0]["config"],
        json!({"cwd": "/srv/alpha", "provider": "anthropic", "model": "current", "thinking": "high"})
    );
    assert!(
        log.named("list_models").is_empty(),
        "the catalog came from prewarm"
    );
    board.shutdown().await;
}

#[tokio::test]
async fn the_voice_brief_rides_on_the_first_prompt_and_again_after_a_compaction() {
    let (mut board, log) = on_alpha(
        &[],
        Box::new(|_, message| {
            if message.contains("compact now") {
                vec![
                    Step::Event(
                        json!({"kind": "compaction", "phase": "start", "reason": "threshold"}),
                    ),
                    Step::Event(
                        json!({"kind": "compaction", "phase": "end", "reason": "threshold"}),
                    ),
                    Step::Event(json!({"kind": "text", "text": "Compacted."})),
                ]
            } else {
                says("On it.")
            }
        }),
    )
    .await;
    board.handle("compact now").await;
    board.handle("next line").await;
    board.handle("and another").await;

    let prompts = prompts(&log);
    // One prompt per line and nothing else: the brief is never a message of
    // its own.
    assert_eq!(prompts.len(), 4, "{prompts:#?}");
    let briefed: Vec<bool> = prompts
        .iter()
        .map(|prompt| prompt.starts_with("[SWITCHBOARD VOICE BRIEF]"))
        .collect();
    assert_eq!(briefed, [true, false, true, false], "{prompts:#?}");
    assert!(prompts[0].contains("[PROJECT]"));
    assert!(
        prompts[2].ends_with("[END OF VOICE BRIEF]\n\nnext line"),
        "{}",
        prompts[2]
    );
    assert_eq!(prompts[3], "and another");
    // No brief through the configuration: the project's own system prompt
    // stays.
    assert!(log.named("create_session")[0]["config"]
        .get("appendSystemPrompt")
        .is_none());
    board.shutdown().await;
}

#[test]
fn the_voice_brief_carries_the_voice_the_module_and_the_ways_of_working() {
    let board = board_on(
        vec![project("alpha", "Alpha project"), project("beta", "")],
        &[("SWITCHBOARD_PERSONA", "Gruff and short.")],
        two_model_catalog(),
    );
    let brief = board.agent_brief(&project("alpha", ""));
    assert!(brief.starts_with("[SWITCHBOARD VOICE BRIEF]"), "{brief}");
    assert!(brief.ends_with("[END OF VOICE BRIEF]"), "{brief}");
    for taught in [
        "working in the alpha project",
        "[HOW YOU TALK ON THE CALL]",
        "Character:\nGruff and short.",
        "switchboard.speak(text)",
        "switchboard.request_to_speak(message, reason)",
        "Not a teaser",
        "switchboard.display(",
        "SKILL.md",
        "switchboard.view()",
        "never say something is on screen",
        "cheap to undo",
        "subagents",
        "compact yourself",
        "search your own conversation log",
        "you have no tools for them",
    ] {
        assert!(brief.contains(taught), "{taught} missing from {brief}");
    }
    // Moving the caller is the switchboard's job: the brief lists no other
    // projects and offers no way back to a front desk.
    assert!(!brief.contains("beta"), "{brief}");
    assert!(!brief.contains("return to the operator"), "{brief}");
    assert!(!brief.contains("set_model"), "{brief}");
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

#[tokio::test]
async fn a_model_change_keeps_the_session_and_switches_it_live() {
    let (mut board, log) = on_alpha(&[], Box::new(|_, _| says("On it."))).await;
    let live = board.agent.clone().expect("alpha is on the line");
    let before = board.coordinator.current_identity();

    let decided = board.planner.model_change("anthropic/next").await;
    let reply = redialed(&mut board, decided).await;

    assert_eq!(reply.error, None, "{reply:?}");
    assert_eq!(reply.text, "Now on next on anthropic, thinking medium.");
    assert_eq!(board.coordinator.status().model, "anthropic/next:medium");
    assert!(board
        .agent
        .as_ref()
        .is_some_and(|agent| agent.same_session(&live)));
    assert!(live.alive());
    assert_eq!(
        log.named("create_session").len(),
        1,
        "a new session was made"
    );
    assert!(log.named("kill").is_empty(), "the session was ended");
    assert_eq!(
        log.named("set_model"),
        [json!({"session": "s1", "provider": "anthropic", "model": "next"})]
    );
    assert_eq!(
        log.named("set_thinking"),
        [json!({"session": "s1", "level": "medium"})]
    );
    // The changed leg is a new leg: a new identity, and the session is on
    // the call under its token.
    let after = board.coordinator.current_identity();
    assert!(after.generation > before.generation);
    let joins = log.named("join_call");
    assert_eq!(joins.len(), 2);
    assert_eq!(joins[1]["token"].as_str(), Some(after.token.as_str()));
    assert_eq!(reply.delivery_generation, Some(after.generation));
    // No turn was started for the change, and the brief is not sent again.
    assert_eq!(prompts(&log).len(), 1);
    let next = board.handle("carry on").await;
    assert_eq!(
        (next.route.as_str(), next.text.as_str()),
        ("alpha", "On it.")
    );
    assert_eq!(prompts(&log)[1], "carry on");
    board.shutdown().await;
}

/// Records every agent-state notice as `project:state`, the way the page
/// would see them.
fn record_agent_states(board: &mut Switchboard) -> Arc<StdMutex<Vec<String>>> {
    let notices = Arc::new(StdMutex::new(Vec::new()));
    let recorded = Arc::clone(&notices);
    board.set_agent_state_callback(Some(Arc::new(move |notice| {
        recorded
            .lock()
            .unwrap()
            .push(format!("{}:{}", notice.project, notice.state));
        Box::pin(async {})
    })));
    notices
}

#[cfg(unix)]
#[tokio::test]
async fn a_fresh_model_change_whose_prompt_fails_announces_finished_once() {
    let mut board = board_on(vec![project("alpha", "")], &[], two_model_catalog());
    let mut fake = FakeHostAgent::new(Box::new(|_, _| says("On it.")));
    // Only the switched session's first prompt fails; the transfer's intro
    // before it goes through.
    fake.on_command = Some(Box::new(|name, args| {
        (name == "prompt"
            && args["message"]
                .as_str()
                .is_some_and(|message| message.contains("This session now runs on")))
        .then(|| Some(Err(("transport".into(), "host prompt failed".into()))))
    }));
    let _log = fake.serve(board.hosts().connect_fake(HOST));
    let reply = board
        .transfer_ctx(&transcript("look at alpha"), "alpha", "", "")
        .await;
    assert_eq!(reply.route, "alpha", "{reply:?}");
    let notices = record_agent_states(&mut board);

    // A fresh-context change ends the old session before the new one is
    // prompted. When the new one fails, the old leg is gone too, and the
    // page must hear so exactly once; before, it heard nothing and kept a
    // state for a leg that no longer existed.
    let decided = board
        .planner
        .plan("anthropic/next", "", "do the thing", false)
        .await;
    let reply = redialed(&mut board, decided).await;

    assert!(reply.error.is_some(), "{reply:?}");
    let notices = notices.lock().unwrap().clone();
    assert_eq!(
        notices
            .iter()
            .filter(|notice| *notice == "alpha:finished")
            .count(),
        1,
        "{notices:?}"
    );
    assert_eq!(board.coordinator.route(), OPERATOR);
    assert!(!board.coordinator.is_candidate());
    assert!(board.agent.is_none());
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_kept_model_change_whose_adoption_fails_announces_finished_once() {
    let mut board = board_on(vec![project("alpha", "")], &[], two_model_catalog());
    let coordinator = board.coordinator();
    let _log = serve(
        &board,
        Box::new(move |_, message| {
            if message.contains("This session now runs on") {
                // A competing lifecycle owner moves the candidate before the
                // PBX adopts it, as the promotion test does.
                coordinator.set_candidate_token_for_test("not-the-swap-token");
            }
            says("On it.")
        }),
    );
    let reply = board
        .transfer_ctx(&transcript("look at alpha"), "alpha", "", "")
        .await;
    assert_eq!(reply.route, "alpha", "{reply:?}");
    let notices = record_agent_states(&mut board);

    // The kept session is still the switchboard's agent when adoption fails,
    // so dropping it announces `finished`; the arm must not announce it a
    // second time itself.
    let decided = board
        .planner
        .plan("anthropic/next", "", "do the thing", true)
        .await;
    let reply = redialed(&mut board, decided).await;

    assert!(reply.error.is_some(), "{reply:?}");
    let notices = notices.lock().unwrap().clone();
    assert_eq!(
        notices
            .iter()
            .filter(|notice| *notice == "alpha:finished")
            .count(),
        1,
        "{notices:?}"
    );
    assert_eq!(board.coordinator.route(), OPERATOR);
    assert!(!board.coordinator.is_candidate());
    board.shutdown().await;
}

#[tokio::test]
async fn a_thinking_change_keeps_the_session_and_takes_the_level_the_host_reports() {
    let (mut board, log) = on_alpha(&[], Box::new(|_, _| says("On it."))).await;
    let live = board.agent.clone().unwrap();

    let decided = board.planner.thinking_change("high").await;
    let reply = redialed(&mut board, decided).await;

    assert_eq!(reply.error, None, "{reply:?}");
    assert!(board
        .agent
        .as_ref()
        .is_some_and(|agent| agent.same_session(&live)));
    assert!(log.named("set_model").is_empty());
    assert_eq!(
        log.named("set_thinking"),
        [json!({"session": "s1", "level": "high"})]
    );
    let status = board.coordinator.status();
    assert_eq!(status.model, "anthropic/current:high");
    assert_eq!(
        (status.thinking.as_str(), status.thinking_confirmed),
        ("high", true)
    );
    board.shutdown().await;
}

#[tokio::test]
async fn a_fresh_start_ends_the_session_and_makes_a_new_one() {
    let (mut board, log) = on_alpha(&[], Box::new(|_, _| says("Fresh here."))).await;
    let old = board.agent.clone().unwrap();

    let decided = board
        .planner
        .plan("anthropic/next", "", "look at the parser", false)
        .await;
    let reply = redialed(&mut board, decided).await;

    assert_eq!(reply.error, None, "{reply:?}");
    assert_eq!(reply.text, "Fresh here.");
    assert!(!old.alive());
    let new = board.agent.clone().unwrap();
    assert!(!new.same_session(&old));
    assert_eq!(log.named("create_session").len(), 2);
    assert!(log.named("set_model").is_empty());
    // The old session ends before the new one is made: one per project.
    until_named(&log, "kill").await;
    let names = log.names();
    let killed = names.iter().position(|name| name == "kill").unwrap();
    let created = names
        .iter()
        .rposition(|name| name == "create_session")
        .unwrap();
    assert!(killed < created, "{names:?}");
    assert_eq!(log.named("kill"), [json!({"session": "s1"})]);
    assert_eq!(board.coordinator.status().model, "anthropic/next:medium");
    // The request goes on as the new session's first prompt, brief first.
    let prompts = prompts(&log);
    assert_eq!(prompts.len(), 2);
    assert!(prompts[1].starts_with("[SWITCHBOARD VOICE BRIEF]"));
    assert!(prompts[1].contains("Their request: look at the parser."));
    board.shutdown().await;
}

#[tokio::test]
async fn the_agents_own_set_model_is_decided_by_the_pickers_checks() {
    for swaps in ["0", "1"] {
        let (mut board, log) = on_alpha(
            &[("SWITCHBOARD_MODEL_SWAPS", swaps)],
            Box::new(|_, message| {
                if message.contains("use next") {
                    vec![
                        Step::Event(json!({"kind": "text", "text": "Switching."})),
                        Step::Call(
                            "set_model",
                            json!({"model": "anthropic/next", "keep_context": true}),
                        ),
                    ]
                } else {
                    says("On it.")
                }
            }),
        )
        .await;
        let live = board.agent.clone().expect("alpha is on the line");

        let reply = board.handle("use next").await;

        assert_eq!(reply.route, "alpha", "{reply:?}");
        assert!(board
            .agent
            .as_ref()
            .is_some_and(|agent| agent.same_session(&live)));
        assert!(live.alive());
        let _ = swaps;
        assert_eq!(reply.text, "Switching.");
        assert!(log.named("set_model").is_empty());
        assert_eq!(board.coordinator.status().model, "anthropic/current:medium");
        board.shutdown().await;
    }
}

#[tokio::test]
async fn a_redial_whose_leg_has_moved_since_it_was_planned_is_refused() {
    let (mut board, log) = on_alpha(&[], Box::new(|_, _| says("On it."))).await;
    let live = board.agent.clone().expect("alpha is on the line");

    // A rescue that was not made for this redial retires the leg it was
    // planned for.
    let Redial::Planned(plan) = board.planner.model_change("anthropic/next").await else {
        panic!("a swap to a listed model goes ahead");
    };
    let rescued = board.coordinator.begin_rescue("hangup");
    assert_eq!(
        board.redial(*plan).await.unwrap_err(),
        LifecycleError::StaleLeg
    );
    assert_eq!(board.coordinator.current_identity(), rescued);
    assert!(!board.coordinator.is_candidate());
    assert_eq!(board.coordinator.status().model, "anthropic/current:medium");
    assert!(board
        .agent
        .as_ref()
        .is_some_and(|agent| agent.same_session(&live)));
    assert!(live.alive());
    board.coordinator.settle();

    // The caller went back to the operator, which keeps the generation.
    let Redial::Planned(plan) = board.planner.model_change("anthropic/next").await else {
        panic!("a swap to a listed model goes ahead");
    };
    board.force_hangup().await;
    let generation = board.coordinator.generation();
    assert_eq!(
        board.redial(*plan).await.unwrap_err(),
        LifecycleError::StaleLeg
    );
    assert_eq!(board.coordinator.route(), OPERATOR);
    assert_eq!(board.coordinator.generation(), generation);
    assert!(board.agent.is_none(), "a leg was launched for nobody");
    assert!(log.named("set_model").is_empty());

    // The rescue made for it hands the plan on to the leg that rescue left.
    let reply = board
        .transfer_ctx(&transcript("look at alpha"), "alpha", "", "")
        .await;
    assert_eq!(reply.route, "alpha", "{reply:?}");
    let Redial::Planned(plan) = board.planner.model_change("anthropic/next").await else {
        panic!("a swap to a listed model goes ahead");
    };
    let rescued = board
        .coordinator
        .begin_rescue_of(plan.leg(), "redial")
        .expect("the leg is still on the line");
    let reply = board.redial(plan.rescued(rescued)).await.unwrap();
    assert_eq!(reply.error, None, "{reply:?}");
    assert_eq!(board.coordinator.status().model, "anthropic/next:medium");
    board.shutdown().await;
}

#[tokio::test]
async fn a_redial_that_cannot_reach_the_host_refuses_and_keeps_the_live_leg() {
    let mut board = board_on(vec![project("alpha", "")], &[], two_model_catalog());
    let log = serve(&board, Box::new(|_, _| says("On it.")));
    let reply = board
        .transfer_ctx(&transcript("look at alpha"), "alpha", "", "")
        .await;
    assert_eq!(reply.route, "alpha", "{reply:?}");
    let leg = board.coordinator.project_leg().unwrap();

    board.hosts().disconnect_fake(HOST);
    let Redial::Answered(reply) = board.planner.plan("anthropic/next", "", "", true).await else {
        panic!("a host that is not connected is refused before anything is touched");
    };

    assert!(reply.error.unwrap().contains("not connected"));
    assert_eq!(board.coordinator.project_leg(), Some(leg));
    assert!(board.agent.as_ref().is_some_and(ProjectSession::alive));
    assert!(log.named("set_model").is_empty());
    board.shutdown().await;
}

#[tokio::test]
async fn an_unavailable_catalog_admits_a_qualified_model_and_refuses_a_bare_one() {
    for (agent_model, admitted) in [("anthropic/current", true), ("current", false)] {
        let mut alpha = project("alpha", "");
        alpha.model = None;
        let config = crate::Config::for_tests(&[("SWITCHBOARD_AGENT_MODEL", agent_model)]);
        let registry = Registry::new(vec![alpha]);
        let prewarm = crate::prewarm::Prewarm::settled(&config, &registry, two_model_catalog());
        prewarm.settle_catalog(
            HOST,
            crate::prewarm::CatalogState::Unavailable {
                reason: "listing timed out".into(),
            },
        );
        let mut board = Switchboard::new(&config, registry, Arc::new(prewarm));
        serve(&board, Box::new(|_, _| says("On it.")));

        let reply = board
            .transfer_ctx(&transcript("look at alpha"), "alpha", "", "")
            .await;

        if admitted {
            assert_eq!(reply.route, "alpha", "{reply:?}");
            assert_eq!(board.coordinator.status().model, "anthropic/current:medium");
        } else {
            assert_eq!(reply.route, OPERATOR, "{reply:?}");
            let error = reply.error.unwrap_or_default();
            assert!(error.contains("bare model"), "{error}");
        }
        board.shutdown().await;
    }
}

#[tokio::test]
async fn the_route_follows_adoption_while_the_intro_turn_is_still_running() {
    use crate::lifecycle::ActivityDisposition;
    use crate::pi_client::Activity;

    let mut board = board_with(vec![project("alpha", "")], true);
    serve(
        &board,
        Box::new(|_, _| {
            vec![
                Step::Event(json!({"kind": "tool_start", "tool": "ipython", "call_id": "t1"})),
                Step::WaitFor("steer"),
                Step::Event(json!({"kind": "text", "text": "Alpha here."})),
            ]
        }),
    );
    // Promotion as the application does it: the candidate's own sign of life
    // adopts it. Each adoption is reported on a channel.
    let coordinator = board.coordinator();
    let (adopted_tx, mut adopted) = tokio::sync::mpsc::unbounded_channel();
    let promoting = coordinator.clone();
    board.set_activity_callback(Some(Arc::new(move |activity: Activity| {
        let coordinator = promoting.clone();
        let adopted = adopted_tx.clone();
        Box::pin(async move {
            if coordinator.classify_activity(&activity.leg) == ActivityDisposition::Promote {
                let _ = adopted.send(coordinator.adopt_candidate(&activity.leg));
            }
        })
    })));
    let control = board.session_control();
    let board = Arc::new(Mutex::new(board));
    let turn_board = Arc::clone(&board);
    let turn = tokio::spawn(async move {
        turn_board
            .lock()
            .await
            .transfer_ctx(&transcript("put me through"), "alpha", "", "")
            .await
    });

    adopted
        .recv()
        .await
        .expect("the incoming leg shows life")
        .expect("and is adopted");
    // The intro turn has not ended, yet the line already names alpha: what
    // the PBX reads, replies with, or hangs up from here on is alpha.
    assert_eq!(coordinator.route(), "alpha");
    let status = coordinator.status();
    assert_eq!(
        (status.route.as_str(), status.label.as_str()),
        ("alpha", "alpha")
    );
    assert_eq!(status.model, "anthropic/current:medium");
    assert_eq!(status.models.len(), 2);

    control
        .lock()
        .await
        .as_ref()
        .expect("the incoming leg is the live session")
        .steer("go on", None)
        .await
        .unwrap();
    let reply = turn.await.unwrap();

    assert_eq!(reply.route, "alpha");
    assert_eq!(reply.text, "Alpha here.");
    assert_eq!(coordinator.route(), "alpha");
    board.lock().await.shutdown().await;
}

// ---------------------------------------------------------------------------
// A transfer that cannot bring its leg up, and a hangup (#56). A failed
// transfer leaves the caller on the operator with a note saying why and rolls
// the candidate back; a hangup drops whatever leg is live. The operator here
// is a real process, so these check what it is told on its next turn rather
// than only the note waiting for it.

/// An operator that answers every prompt and appends each one to a log, so a
/// test can read what the switchboard told it.
#[cfg(unix)]
fn logging_operator(root: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let operator = root.join("fake-operator");
    let log = root.join("operator.log");
    crate::pi_client::write_executable_script(
        &operator,
        &format!(
            r#"while IFS= read -r line; do
  printf '%s\n' "$line" >> '{log}'
  printf '%s\n' '{{"type":"message_update","assistantMessageEvent":{{"type":"text_end","content":"Operator here."}}}}'
  printf '%s\n' '{{"type":"agent_settled"}}'
done
"#,
            log = log.display()
        ),
    );
    (operator, log)
}

/// The messages the operator was prompted with, oldest first.
fn operator_prompts(log: &std::path::Path) -> Vec<String> {
    read_lines(log)
        .iter()
        .map(|line| {
            let command: serde_json::Value = serde_json::from_str(line).unwrap();
            command["message"].as_str().unwrap().to_owned()
        })
        .collect()
}

/// A switchboard on `project` whose coordinator records its candidate
/// notices the way `AppState` relays them to the browser.
fn coordinated_board(
    project: Project,
    settings: &[(&str, &str)],
) -> (
    Switchboard,
    Coordinator,
    Arc<StdMutex<Vec<crate::lifecycle::CandidateNotice>>>,
) {
    let board = board_on(vec![project], settings, two_model_catalog());
    let mut coordinator = board.coordinator();
    let notices = Arc::new(StdMutex::new(Vec::new()));
    let recorded = Arc::clone(&notices);
    coordinator.set_candidate_callback(Arc::new(move |notice| {
        recorded.lock().unwrap().push(notice.clone());
    }));
    (board, coordinator, notices)
}

/// Everything a failed transfer must leave as it found it: the caller on the
/// operator's live session, no candidate, the generation where it was, and a
/// note for the operator that starts with `why`.
async fn assert_back_on_the_operator(
    board: &Switchboard,
    coordinator: &Coordinator,
    notices: &StdMutex<Vec<crate::lifecycle::CandidateNotice>>,
    generation: u64,
    why: &str,
) {
    assert_eq!(coordinator.route(), OPERATOR);
    assert!(board.agent.is_none() && coordinator.project_leg().is_none());
    let operator = board.operator.as_ref().expect("the operator keeps running");
    assert!(operator.alive().await);
    let operator = LegSession::Operator(operator.clone());
    assert!(
        board
            .active_session
            .lock()
            .await
            .as_ref()
            .is_some_and(|active| active.same_session(&operator)),
        "the operator must be the live session again, so a steer or a rescue reaches it"
    );

    assert!(!coordinator.is_candidate());
    assert_eq!(coordinator.candidate_identity(), None);
    assert_eq!(coordinator.generation(), generation);
    assert_eq!(coordinator.status().route, OPERATOR);
    assert_eq!(
        notices
            .lock()
            .unwrap()
            .iter()
            .map(|notice| notice.ended)
            .collect::<Vec<_>>(),
        [None, Some(crate::protocol::CandidateEnd::RolledBack)],
        "the browser is told the candidate began and that it ended"
    );

    let note = board.operator_note.as_deref().unwrap_or_default();
    assert!(
        note.starts_with(why),
        "{note:?} does not start with {why:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_transfer_whose_session_cannot_start_leaves_the_caller_on_the_operator_with_the_reason() {
    let root = scratch_dir("transfer-no-session");
    let (operator, operator_log) = logging_operator(&root);
    let (mut board, coordinator, notices) = coordinated_board(
        project("alpha", ""),
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
    );
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("never")));
    host.on_command = Some(Box::new(|name, _| {
        (name == "create_session").then(|| {
            Some(Err((
                "daemon_error".to_owned(),
                "cwd /srv/alpha does not exist".to_owned(),
            )))
        })
    }));
    host.serve(board.hosts().connect_fake(HOST));
    board.handle("hello").await;
    let generation = coordinator.generation();

    let reply = board
        .transfer_ctx(&transcript("put me through to alpha"), "alpha", "", "")
        .await;

    let error = reply.error.clone().expect("the transfer failed");
    assert_eq!(
        error,
        "could not start a session: cwd /srv/alpha does not exist"
    );
    assert_eq!(reply.route, OPERATOR);
    assert_eq!(reply.to_speak, ["I couldn't open alpha."]);
    assert!(reply.text.contains(&error), "{}", reply.text);
    assert_back_on_the_operator(
        &board,
        &coordinator,
        &notices,
        generation,
        &format!("Couldn't open alpha: {}.", error.trim_end_matches('.')),
    )
    .await;

    board.handle("what happened?").await;
    assert_eq!(
        operator_prompts(&operator_log).last().unwrap(),
        &format!(
            "[switchboard] Couldn't open alpha: {}.\n\nwhat happened?",
            error.trim_end_matches('.')
        )
    );
    assert_eq!(board.operator_note, None, "the note is delivered once");
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn an_intro_that_never_settles_is_dropped_at_the_turn_deadline() {
    let root = scratch_dir("transfer-silent");
    let (operator, operator_log) = logging_operator(&root);
    let (mut board, coordinator, notices) = coordinated_board(
        project("alpha", ""),
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
    );
    let log = serve(&board, Box::new(|_, _| vec![Step::Hold]));
    // The intro never settles, so the only thing that ends the transfer is
    // the deadline. Reaching it is the outcome under test, not a wait for
    // something else, so it can be short.
    board.project_turn_timeout = Duration::from_millis(200);
    board.handle("hello").await;
    let generation = coordinator.generation();

    let reply = board
        .transfer_ctx(&transcript("put me through to alpha"), "alpha", "", "")
        .await;

    assert_eq!(reply.error.as_deref(), Some("the agent stopped responding"));
    assert_eq!(reply.route, OPERATOR);
    assert_eq!(reply.to_speak, ["I couldn't open alpha."]);
    assert_back_on_the_operator(
        &board,
        &coordinator,
        &notices,
        generation,
        "Couldn't open alpha: the agent stopped responding.",
    )
    .await;
    // The silent session is not left running on its host.
    until_named(&log, "kill").await;
    until_named(&log, "abort").await;

    board.handle("what happened?").await;
    assert_eq!(
        operator_prompts(&operator_log).last().unwrap(),
        "[switchboard] Couldn't open alpha: the agent stopped responding.\n\nwhat happened?"
    );
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn hanging_up_an_operator_with_nothing_running_does_nothing() {
    let mut board = board_with(vec![], true);
    assert_eq!(board.force_hangup().await, None);
    assert_eq!(board.coordinator.route(), OPERATOR);
    assert_eq!(board.operator_note, None);
}

#[cfg(unix)]
#[tokio::test]
async fn hanging_up_the_operator_discards_its_process_and_the_next_turn_starts_another() {
    // The operator stays the route; a wedged operator process is simply
    // replaced on the next utterance.
    let root = scratch_dir("hangup-operator");
    let (operator, _) = logging_operator(&root);
    let mut board = board_on(
        vec![],
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
        two_model_catalog(),
    );
    board.handle("hello").await;
    let first = board.operator.clone().expect("the operator started");

    assert_eq!(board.force_hangup().await.as_deref(), Some(OPERATOR));

    assert!(!first.alive().await);
    assert!(board.operator.is_none());
    assert!(board.active_session.lock().await.is_none());
    assert_eq!(board.coordinator.route(), OPERATOR);
    assert_eq!(board.operator_note, None);
    let reply = board.handle("are you there?").await;
    assert_eq!(reply.text, "Operator here.");
    assert!(
        reply.voiced,
        "the operator reply should be voiced: {reply:?}"
    );
    let second = board.operator.as_ref().expect("a fresh operator");
    assert!(!second.same_session(&first));
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn hanging_up_a_project_leg_returns_the_caller_to_the_operator_and_tells_it_why() {
    let root = scratch_dir("hangup-project");
    let (operator, operator_log) = logging_operator(&root);
    let mut board = board_on(
        vec![project("alpha", "")],
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
        two_model_catalog(),
    );
    let log = serve(&board, Box::new(|_, _| says("On it.")));
    // The route the coordinator names each time the line is announced.
    let routes = Arc::new(StdMutex::new(Vec::new()));
    let announced = Arc::clone(&routes);
    let coordinator = board.coordinator();
    board.set_route_callback(Some(Arc::new(move || {
        announced.lock().unwrap().push(coordinator.route());
        Box::pin(async {})
    })));
    board.handle("hello").await;
    let reply = board
        .transfer_ctx(&transcript("put me through to alpha"), "alpha", "", "")
        .await;
    assert_eq!(reply.route, "alpha", "{reply:?}");
    let agent = board.agent.clone().expect("the project leg is live");

    assert_eq!(board.force_hangup().await.as_deref(), Some("alpha"));

    assert!(!agent.alive(), "the project leg was left running");
    assert_eq!(until_named(&log, "kill").await, [json!({"session": "s1"})]);
    assert_eq!(board.coordinator.route(), OPERATOR);
    assert!(board.agent.is_none() && board.coordinator.project_leg().is_none());
    let operator_session =
        LegSession::Operator(board.operator.clone().expect("the operator keeps running"));
    assert!(board
        .active_session
        .lock()
        .await
        .as_ref()
        .is_some_and(|active| active.same_session(&operator_session)));
    assert_eq!(*routes.lock().unwrap(), ["alpha", OPERATOR]);

    board.handle("I'm back").await;
    assert_eq!(
        operator_prompts(&operator_log).last().unwrap(),
        "[switchboard] The caller hung up alpha from the page.\n\nI'm back"
    );
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn at_most_one_session_per_project_stays_up() {
    let (mut board, log) = on_alpha(&[], Box::new(|_, _| says("On it."))).await;
    // Put through to alpha again from alpha: the old session ends.
    let reply = board
        .transfer_ctx(&transcript("again"), "alpha", "", "")
        .await;
    assert_eq!(reply.route, "alpha");
    assert_eq!(log.named("create_session").len(), 2);
    assert_eq!(until_named(&log, "kill").await, [json!({"session": "s1"})]);
    let names = log.names();
    let killed = names.iter().position(|name| name == "kill").unwrap();
    let created = names
        .iter()
        .rposition(|name| name == "create_session")
        .unwrap();
    assert!(
        killed < created,
        "two alpha sessions were up at once: {names:?}"
    );
    // Service shutdown ends the one left.
    board.shutdown().await;
    for _ in 0..500 {
        if log.named("kill").len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(
        log.named("kill"),
        [json!({"session": "s1"}), json!({"session": "s2"})]
    );
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
    finished_rx.await.expect("failed prompt publishes finished");

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
    finished_rx.await.expect("host loss publishes finished");

    assert!(!board.background_agents.contains_key("alpha"));
    assert!(!board.coordinator.project_is_background("alpha"));
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn failed_transfer_adoption_returns_to_the_operator_and_cleans_up() {
    let mut board = board_with(vec![project("alpha", "")], false);
    let coordinator = board.coordinator();
    board.set_agent_state_callback(Some(Arc::new(move |notice| {
        if notice.project == "alpha" && notice.state == "busy" {
            // The candidate is staged before its intro prompt. Simulate a
            // competing lifecycle owner changing it before PBX adoption.
            coordinator.set_candidate_token_for_test("not-the-transfer-token");
        }
        Box::pin(async {})
    })));
    let log = serve(&board, Box::new(|_, _| says("ready")));

    let reply = board
        .transfer_ctx(&transcript("put me through"), "alpha", "", "")
        .await;

    assert!(reply.error.is_some(), "adoption must fail: {reply:?}");
    assert_eq!(reply.route, OPERATOR);
    assert!(board.agent.is_none());
    assert!(!board.coordinator.is_candidate());
    assert!(!board
        .coordinator
        .status()
        .route
        .eq_ignore_ascii_case("alpha"));
    assert_eq!(until_named(&log, "kill").await.len(), 1);
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn failed_transfer_intro_publishes_finished_instead_of_stuck_busy() {
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
    let mut fake = FakeHostAgent::new(Box::new(|_, _| says("never")));
    fake.on_command = Some(Box::new(|name, _| {
        (name == "prompt").then(|| Some(Err(("prompt_failed".into(), "intro failed".into()))))
    }));
    fake.serve(board.hosts().connect_fake(HOST));

    let reply = board
        .transfer_ctx(&transcript("put me through"), "alpha", "", "")
        .await;

    assert!(reply.error.is_some());
    assert!(board.agent.is_none());
    assert_eq!(
        notices.lock().unwrap().last().map(String::as_str),
        Some("alpha:finished")
    );
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
    started_rx.await.expect("the background turn started");
    while state_rx.try_recv().is_ok() {}
    board.stop_project("beta").await;

    finished_rx.await.expect("stop published finished");
    let mut late_idle = false;
    while let Ok((project, state)) = state_rx.try_recv() {
        late_idle |= project == "beta" && state == "idle";
    }
    assert!(!late_idle, "a stopped prompt must not publish idle");
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
    started_rx.await.expect("the long turn started");
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

#[cfg(unix)]
#[tokio::test]
async fn a_stopped_project_starts_fresh_after_close() {
    let (mut board, log) = on_alpha(&[], Box::new(|_, _| says("handled"))).await;
    let first = board.agent.as_ref().unwrap().session_id().to_owned();
    board.pending_stop = Some("alpha".into());
    let stopped = board
        .handle_decision("yes", &Decision::fallback("confirm"))
        .await;
    assert_eq!(stopped.route, OPERATOR);
    let resumed = board
        .transfer_ctx(&transcript("fresh alpha"), "alpha", "", "")
        .await;
    assert_eq!(resumed.route, "alpha");
    assert_ne!(board.agent.as_ref().unwrap().session_id(), first);
    assert_eq!(log.named("create_session").len(), 2);
    board.shutdown().await;
}

#[tokio::test]
async fn desk_session_hosts_are_listed_concurrently() {
    let alpha = project("alpha", "Alpha");
    let mut beta = project("beta", "Beta");
    beta.host = Some("other".into());
    let board = board_with(vec![alpha.clone(), beta.clone()], false);
    let other_started = Arc::new(tokio::sync::Notify::new());
    let other_started_for_host = other_started.clone();
    let mut blocked = FakeHostAgent::new(Box::new(|_, _| vec![]));
    blocked.on_command = Some(Box::new(|name, _| {
        if name == "list_sessions" {
            return Some(None);
        }
        None
    }));
    let mut fast = FakeHostAgent::new(Box::new(|_, _| vec![]));
    fast.on_command = Some(Box::new(move |name, _| {
        if name == "list_sessions" {
            other_started_for_host.notify_one();
            return Some(Some(Ok(json!({"sessions": []}))));
        }
        None
    }));
    let hosts = board.hosts();
    blocked.serve(hosts.connect_fake(HOST));
    fast.serve(hosts.connect_fake("other"));
    let query = tokio::spawn(Switchboard::live_desk_sessions_from(
        hosts.clone(),
        Arc::clone(&board.registry),
    ));
    tokio::time::timeout(Duration::from_secs(1), other_started.notified())
        .await
        .expect("the second host was queried while the first was pending");
    hosts.disconnect_fake(HOST);
    let sessions = query.await.expect("desk listing completes after host loss");
    assert!(sessions.is_empty());
}

#[tokio::test]
async fn takeover_lists_only_registered_foreign_desk_sessions() {
    let board = board_with(vec![project("alpha", "Alpha")], false);
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("desk")));
    host.on_command = Some(Box::new(|name, _| {
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [
                {"session":"desk-alpha","session_id":"desk-saved","cwd":"/srv/alpha","provenance":null,"busy":false},
                {"session":"other","session_id":"other-saved","cwd":"/srv/other","provenance":null,"busy":false},
                {"session":"service","session_id":"service-saved","cwd":"/srv/alpha","provenance":"created","busy":false}
            ]}))));
        }
        None
    }));
    let _log = host.serve(board.hosts().connect_fake(HOST));
    let sessions = board.live_desk_sessions().await;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].project, "alpha");
    assert_eq!(sessions[0].state, "idle");
    assert_eq!(sessions[0].provenance, "taken_over");
}

#[tokio::test]
async fn takeover_attaches_and_voice_briefs_then_hangup_detaches_without_kill() {
    let mut board = board_with(vec![project("alpha", "Alpha")], false);
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("Desk answered")));
    let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
    host.on_command = Some(Box::new(move |name, args| {
        let _ = command_tx.send(name.to_owned());
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [
                {"session":"desk-alpha","session_id":"desk-saved","cwd":"/srv/alpha","provenance":null,"busy":false,"model":"anthropic/current","thinking":"high"}
            ]}))));
        }
        if name == "attach" {
            return Some(Some(Ok(json!({
                "session":"desk-alpha","session_id":"desk-saved","name":"notes","project":"alpha","cwd":"/srv/alpha","provenance":"taken_over","busy":false,"turn_open":false,"model":"anthropic/current","thinking":"high","call_mode":null,"last_text":null
            }))));
        }
        let _ = args;
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    let decision = Decision {
        action: Action::TakeOver,
        target: Some("alpha".into()),
        continue_or_fresh: Some(ConversationMode::Continue),
        confidence: 1.0,
        for_current_agent: 0.0,
        multi_target: false,
        unsure: false,
        confirm: false,
        reason: "test".into(),
    };
    let reply = board.handle_decision("take over alpha", &decision).await;
    assert_eq!(reply.route, "alpha");
    assert_eq!(reply.text, "Desk answered");
    let prompt = log.named("prompt");
    assert_eq!(prompt.len(), 1);
    assert!(prompt[0]["message"]
        .as_str()
        .unwrap()
        .contains("[SWITCHBOARD VOICE BRIEF]"));
    assert!(log.names().contains(&"attach".into()));
    for expected in ["list_sessions", "attach", "join_call", "prompt"] {
        assert_eq!(command_rx.recv().await.as_deref(), Some(expected));
    }
    board.force_hangup().await;
    assert_eq!(command_rx.recv().await.as_deref(), Some("abort"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("detach"));
    assert!(!log.names().contains(&"kill".into()));
}

#[tokio::test]
async fn takeover_backgrounds_an_existing_service_foreground_agent() {
    let mut board = board_with(
        vec![project("alpha", "Alpha"), project("beta", "Beta")],
        false,
    );
    let list_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let list_calls_for_host = list_calls.clone();
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("handled")));
    host.on_command = Some(Box::new(move |name, args| {
        if name == "list_sessions" {
            if list_calls_for_host.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                return Some(Some(Ok(json!({"sessions": []}))));
            }
            return Some(Some(Ok(json!({"sessions": [{
                "session":"desk-beta", "session_id":"desk-beta-saved", "cwd":"/srv/beta",
                "provenance":null, "busy":false, "model":"anthropic/current", "thinking":"medium"
            }]}))));
        }
        if name == "attach" {
            return Some(Some(Ok(json!({
                "session":"desk-beta", "session_id":"desk-beta-saved", "name":"notes",
                "project":"beta", "cwd":args["cwd"], "provenance":"taken_over", "busy":false,
                "turn_open":false, "model":"anthropic/current", "thinking":"medium"
            }))));
        }
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    board
        .transfer_ctx(&transcript("alpha"), "alpha", "", "")
        .await;
    let alpha = board.agent.clone().expect("alpha is foreground");
    let reply = board
        .handle_decision(
            "take over beta",
            &Decision {
                action: Action::TakeOver,
                target: Some("beta".into()),
                continue_or_fresh: Some(ConversationMode::Continue),
                confidence: 1.0,
                for_current_agent: 0.0,
                multi_target: false,
                unsure: false,
                confirm: false,
                reason: "test".into(),
            },
        )
        .await;
    assert_eq!(reply.route, "beta");
    assert!(alpha.alive(), "the service-created foreground is resident");
    assert!(board
        .residents_for_test()
        .iter()
        .any(|(project, alive, _)| project == "alpha" && *alive));
    assert!(log
        .named("set_mode")
        .iter()
        .any(|args| args["mode"] == "background"));
    board.shutdown().await;
}

#[tokio::test]
async fn takeover_join_error_releases_the_taken_over_session_without_kill() {
    let mut board = board_with(vec![project("alpha", "Alpha")], false);
    let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("unused")));
    host.on_command = Some(Box::new(move |name, args| {
        let _ = command_tx.send(name.to_owned());
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [{
                "session":"desk-alpha", "session_id":"desk-saved", "cwd":"/srv/alpha",
                "provenance":null, "busy":false
            }]}))));
        }
        if name == "attach" {
            return Some(Some(Ok(json!({
                "session":"desk-alpha", "session_id":"desk-saved", "project":"alpha",
                "cwd":args["cwd"], "provenance":"taken_over", "busy":false,
                "turn_open":false, "model":"anthropic/current", "thinking":"medium"
            }))));
        }
        if name == "join_call" {
            return Some(Some(Err(("failed".into(), "join failed".into()))));
        }
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    let reply = board
        .handle_decision(
            "take over alpha",
            &Decision {
                action: Action::TakeOver,
                target: Some("alpha".into()),
                continue_or_fresh: None,
                confidence: 1.0,
                for_current_agent: 0.0,
                multi_target: false,
                unsure: false,
                confirm: false,
                reason: "test".into(),
            },
        )
        .await;
    assert_eq!(reply.route, OPERATOR);
    assert!(reply.text.contains("join failed"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("list_sessions"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("attach"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("join_call"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("abort"));
    assert_eq!(command_rx.recv().await.as_deref(), Some("detach"));
    assert!(!log.names().contains(&"kill".into()));
    board.shutdown().await;
}

#[tokio::test]
async fn takeover_link_drop_during_attach_rolls_back_without_kill() {
    let mut board = board_with(vec![project("alpha", "Alpha")], false);
    let hosts = board.hosts();
    let disconnect = hosts.clone();
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("unused")));
    host.on_command = Some(Box::new(move |name, args| {
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [{
                "session":"desk-alpha", "session_id":"desk-saved", "cwd":"/srv/alpha",
                "provenance":null, "busy":false
            }]}))));
        }
        if name == "attach" {
            disconnect.disconnect_fake(HOST);
            return Some(None);
        }
        let _ = args;
        None
    }));
    let log = host.serve(hosts.connect_fake(HOST));
    let reply = board
        .handle_decision(
            "take over alpha",
            &Decision {
                action: Action::TakeOver,
                target: Some("alpha".into()),
                continue_or_fresh: None,
                confidence: 1.0,
                for_current_agent: 0.0,
                multi_target: false,
                unsure: false,
                confirm: false,
                reason: "test".into(),
            },
        )
        .await;
    assert_eq!(reply.route, OPERATOR);
    assert!(!log.names().contains(&"kill".into()));
    board.shutdown().await;
}

#[tokio::test]
async fn leaving_a_taken_over_leg_by_transfer_detaches_without_kill() {
    let mut board = board_with(
        vec![project("alpha", "Alpha"), project("beta", "Beta")],
        false,
    );
    let (detached_tx, detached_rx) = tokio::sync::oneshot::channel();
    let detached_tx = Arc::new(StdMutex::new(Some(detached_tx)));
    let detached_for_host = detached_tx.clone();
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("handled")));
    host.on_command = Some(Box::new(move |name, args| {
        if name == "detach" {
            if let Some(tx) = detached_for_host.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [{
                "session":"desk-alpha", "session_id":"desk-saved", "cwd":"/srv/alpha",
                "provenance":null, "busy":false, "model":"anthropic/current", "thinking":"medium"
            }]}))));
        }
        if name == "attach" {
            return Some(Some(Ok(json!({
                "session":"desk-alpha", "session_id":"desk-saved", "project":"alpha",
                "cwd":args["cwd"], "provenance":"taken_over", "busy":false,
                "turn_open":false, "model":"anthropic/current", "thinking":"medium"
            }))));
        }
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    board
        .handle_decision(
            "take over alpha",
            &Decision {
                action: Action::TakeOver,
                target: Some("alpha".into()),
                continue_or_fresh: None,
                confidence: 1.0,
                for_current_agent: 0.0,
                multi_target: false,
                unsure: false,
                confirm: false,
                reason: "test".into(),
            },
        )
        .await;
    let reply = board
        .transfer_ctx(&transcript("beta"), "beta", "", "")
        .await;
    assert_eq!(reply.route, "beta");
    tokio::time::timeout(Duration::from_secs(1), detached_rx)
        .await
        .expect("taken-over transfer sends detach")
        .expect("detach notification");
    assert!(
        log.named("kill").is_empty(),
        "leaving a desk session never kills it"
    );
    board.shutdown().await;
}

#[tokio::test]
async fn stopping_a_taken_over_leg_detaches_without_kill() {
    let mut board = board_with(vec![project("alpha", "Alpha")], false);
    let (detached_tx, detached_rx) = tokio::sync::oneshot::channel();
    let detached_tx = Arc::new(StdMutex::new(Some(detached_tx)));
    let detached_for_host = detached_tx.clone();
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("handled")));
    host.on_command = Some(Box::new(move |name, args| {
        if name == "detach" {
            if let Some(tx) = detached_for_host.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [{
                "session":"desk-alpha", "session_id":"desk-saved", "cwd":"/srv/alpha",
                "provenance":null, "busy":false
            }]}))));
        }
        if name == "attach" {
            return Some(Some(Ok(json!({
                "session":"desk-alpha", "session_id":"desk-saved", "project":"alpha",
                "cwd":args["cwd"], "provenance":"taken_over", "busy":false,
                "turn_open":false, "model":"anthropic/current", "thinking":"medium"
            }))));
        }
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    let decision = Decision {
        action: Action::TakeOver,
        target: Some("alpha".into()),
        continue_or_fresh: None,
        confidence: 1.0,
        for_current_agent: 0.0,
        multi_target: false,
        unsure: false,
        confirm: false,
        reason: "test".into(),
    };
    board.handle_decision("take over alpha", &decision).await;
    let ask = board
        .handle_decision(
            "stop alpha",
            &Decision {
                action: Action::Stop,
                target: Some("alpha".into()),
                continue_or_fresh: None,
                confidence: 1.0,
                for_current_agent: 0.0,
                multi_target: false,
                unsure: false,
                confirm: false,
                reason: "voice stop".into(),
            },
        )
        .await;
    assert!(ask.text.contains("Say yes to confirm"));
    let stopped = board
        .handle_decision("yes", &Decision::fallback("confirmation"))
        .await;
    assert_eq!(stopped.route, OPERATOR);
    tokio::time::timeout(Duration::from_secs(1), detached_rx)
        .await
        .expect("stopping a taken-over leg sends detach")
        .expect("detach notification");
    assert!(
        log.named("kill").is_empty(),
        "stopping a desk session never kills it"
    );
    board.shutdown().await;
}

#[tokio::test]
async fn takeover_refuses_a_live_service_created_agent_before_attach() {
    let mut board = board_with(vec![project("alpha", "Alpha")], false);
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("unused")));
    host.on_command = Some(Box::new(|name, _| {
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [
                {"session":"service-alpha","session_id":"service-saved","cwd":"/srv/alpha","project":"alpha","provenance":"created","busy":false}
            ]}))));
        }
        if name == "attach" {
            panic!("takeover must not attach a service-created session");
        }
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    let decision = Decision {
        action: Action::TakeOver,
        target: Some("alpha".into()),
        continue_or_fresh: None,
        confidence: 1.0,
        for_current_agent: 0.0,
        multi_target: false,
        unsure: false,
        confirm: false,
        reason: "test".into(),
    };
    let reply = board.handle_decision("take over alpha", &decision).await;
    assert_eq!(reply.route, OPERATOR);
    assert!(reply.text.contains("service-created"));
    assert!(!log.names().contains(&"attach".into()));
    assert!(!board.coordinator.is_candidate());
}

#[tokio::test]
async fn failed_takeover_from_project_restores_foreground_for_steering() {
    let mut board = board_with(
        vec![project("alpha", "Alpha"), project("beta", "Beta")],
        false,
    );
    let list_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let list_calls_for_host = list_calls.clone();
    let prompt_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let prompt_calls_for_host = prompt_calls.clone();
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("Alpha stayed on the line")));
    host.on_command = Some(Box::new(move |name, args| {
        if name == "list_sessions" {
            if list_calls_for_host.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                return Some(Some(Ok(json!({"sessions": []}))));
            }
            return Some(Some(Ok(json!({"sessions": [{
                "session":"desk-beta", "session_id":"desk-beta-saved", "cwd":"/srv/beta",
                "provenance":null, "busy":false, "model":"anthropic/current", "thinking":"medium"
            }]}))));
        }
        if name == "attach" {
            return Some(Some(Ok(json!({
                "session":"desk-beta", "session_id":"desk-beta-saved", "project":"beta",
                "cwd":args["cwd"], "provenance":"taken_over", "busy":false,
                "turn_open":false, "model":"anthropic/current", "thinking":"medium"
            }))));
        }
        if name == "prompt"
            && prompt_calls_for_host.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1
        {
            return Some(Some(Err((
                "failed".into(),
                "takeover prompt failed".into(),
            ))));
        }
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    board
        .transfer_ctx(&transcript("connect alpha"), "alpha", "", "")
        .await;
    assert_eq!(board.coordinator.route(), "alpha");

    let reply = board
        .handle_decision(
            "take over beta",
            &Decision {
                action: Action::TakeOver,
                target: Some("beta".into()),
                continue_or_fresh: None,
                confidence: 1.0,
                for_current_agent: 0.0,
                multi_target: false,
                unsure: false,
                confirm: false,
                reason: "test".into(),
            },
        )
        .await;
    assert_eq!(reply.route, "alpha");
    assert_eq!(board.route_label(), "alpha");
    assert_eq!(
        board
            .session_control()
            .lock()
            .await
            .as_ref()
            .map(LegSession::label),
        Some("alpha")
    );

    let continued = board
        .handle_decision(
            "continue alpha",
            &Decision {
                action: Action::Continue,
                target: None,
                continue_or_fresh: None,
                confidence: 1.0,
                for_current_agent: 1.0,
                multi_target: false,
                unsure: false,
                confirm: false,
                reason: "test".into(),
            },
        )
        .await;
    assert_eq!(continued.route, "alpha");
    assert_eq!(continued.text, "Alpha stayed on the line");
    let prompt_messages = prompts(&log);
    assert_eq!(prompt_messages.len(), 3);
    assert!(prompt_messages[2].contains("continue alpha"));
    board.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn failed_takeover_from_operator_restores_operator_session() {
    let root = scratch_dir("takeover-operator-turn-failure");
    let operator = fake_operator(&root);
    let mut board = board_on(
        vec![project("alpha", "Alpha")],
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
        two_model_catalog(),
    );
    board.ensure_operator().await.expect("operator starts");
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("unused")));
    host.on_command = Some(Box::new(|name, args| {
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [{
                "session":"desk-alpha", "session_id":"desk-saved", "cwd":"/srv/alpha",
                "provenance":null, "busy":false, "model":"anthropic/current", "thinking":"medium"
            }]}))));
        }
        if name == "attach" {
            return Some(Some(Ok(json!({
                "session":"desk-alpha", "session_id":"desk-saved", "project":"alpha",
                "cwd":args["cwd"], "provenance":"taken_over", "busy":false,
                "turn_open":false, "model":"anthropic/current", "thinking":"medium"
            }))));
        }
        if name == "prompt" {
            return Some(Some(Err((
                "failed".into(),
                "operator takeover prompt failed".into(),
            ))));
        }
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    let reply = board
        .handle_decision(
            "take over alpha",
            &Decision {
                action: Action::TakeOver,
                target: Some("alpha".into()),
                continue_or_fresh: None,
                confidence: 1.0,
                for_current_agent: 0.0,
                multi_target: false,
                unsure: false,
                confirm: false,
                reason: "test".into(),
            },
        )
        .await;
    assert_eq!(reply.route, OPERATOR);
    assert!(reply.text.contains("operator takeover prompt failed"));
    assert_eq!(
        board
            .session_control()
            .lock()
            .await
            .as_ref()
            .map(LegSession::label),
        Some("operator")
    );
    assert!(!log.names().contains(&"kill".into()));
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn takeover_attach_failure_rolls_back_without_killing_the_desk_session() {
    let root = scratch_dir("takeover-operator-rollback");
    let operator = fake_operator(&root);
    let mut board = board_on(
        vec![project("alpha", "Alpha")],
        &[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())],
        two_model_catalog(),
    );
    board.ensure_operator().await.expect("operator starts");
    assert_eq!(
        board
            .session_control()
            .lock()
            .await
            .as_ref()
            .map(LegSession::label),
        Some("operator")
    );
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("unused")));
    host.on_command = Some(Box::new(|name, _| {
        if name == "list_sessions" {
            return Some(Some(Ok(json!({"sessions": [
                {"session":"desk-alpha","session_id":"desk-saved","cwd":"/srv/alpha","provenance":null,"busy":false}
            ]}))));
        }
        if name == "attach" {
            return Some(Some(Err(("failed".into(), "desk disappeared".into()))));
        }
        None
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    let decision = Decision {
        action: Action::TakeOver,
        target: Some("alpha".into()),
        continue_or_fresh: None,
        confidence: 1.0,
        for_current_agent: 0.0,
        multi_target: false,
        unsure: false,
        confirm: false,
        reason: "test".into(),
    };
    let reply = board.handle_decision("take over alpha", &decision).await;
    assert_eq!(reply.route, OPERATOR);
    assert!(reply.text.contains("desk disappeared"));
    assert!(!board.coordinator.is_candidate());
    assert!(!log.names().contains(&"kill".into()));
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn host_loss_closes_a_taken_over_session_without_killing_the_desk_process() {
    let board = board_with(vec![project("alpha", "Alpha")], false);
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
    let closed_tx = Arc::new(StdMutex::new(Some(closed_tx)));
    let callback_tx = closed_tx.clone();
    let host = FakeHostAgent::new(Box::new(|_, _| vec![]));
    let log = host.serve(board.hosts().connect_fake(HOST));
    let launch = ProjectLaunch {
        host: HOST.into(),
        project: "alpha".into(),
        cwd: "/srv/alpha".into(),
        spec: "anthropic/current".into(),
        brief: String::new(),
        turn_timeout: Duration::from_secs(1),
        on_activity: None,
        on_module: None,
        on_turn: None,
        on_closed: Some(Arc::new(move |_, _, _| {
            let callback_tx = callback_tx.clone();
            Box::pin(async move {
                if let Some(tx) = callback_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            })
        })),
        debug: None,
    };
    let (session, _) = ProjectSession::attach(&board.hosts(), launch, "desk-alpha")
        .await
        .unwrap();
    session.join_call("desk-call", "Jev", 1_000).await.unwrap();
    board.hosts().disconnect_fake(HOST);
    closed_rx
        .await
        .expect("host loss closes the taken-over session");
    assert!(!session.alive());
    session.close();
    assert!(!log.names().contains(&"kill".into()));
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
        let _scope = UtteranceScope::enter(&board.trace_utterance, "clip-9");
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

use super::*;
use crate::hosts::Step;
use crate::pbx::{
    board_on, board_with, on_alpha, project, prompts, says, serve, two_model_catalog,
};
use crate::router::Decision;
use serde_json::json;

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

#[test]
fn the_operator_and_the_utility_get_the_same_voice_block_and_persona() {
    let board = board_on(
        vec![project("alpha", "Alpha project")],
        &[("SWITCHBOARD_PERSONA", "Gruff and short.")],
        two_model_catalog(),
    );
    let operator = board.operator_prompt_suffix();
    let utility = utility_system_prompt(&board.persona, &board.registry);
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
    let prompt = utility_system_prompt(&board.persona, &board.registry);
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

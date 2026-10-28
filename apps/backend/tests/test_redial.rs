use super::*;
use crate::hosts::{FakeHostAgent, Step};
use crate::pbx::{
    board_on, board_with, on_alpha, project, prompts, put_on, says, serve, transcript,
    two_model_catalog, until_named, HOST,
};
use serde_json::json;
use std::sync::{Arc, Mutex as StdMutex};

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

/// A board on alpha whose host answers `command` with the error `code`,
/// and the host's log.
async fn on_alpha_refusing(
    command: &'static str,
    code: &'static str,
) -> (Switchboard, crate::hosts::FakeLog) {
    let mut board = board_on(vec![project("alpha", "")], &[], two_model_catalog());
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("On it.")));
    host.on_command = Some(Box::new(move |name, _| {
        (name == command).then(|| Some(Err((code.to_owned(), format!("{code} for the test")))))
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    let reply = board
        .transfer_to(&transcript("look at alpha"), "alpha")
        .await;
    assert_eq!(reply.route, "alpha", "{reply:?}");
    (board, log)
}

/// Runs a redial the way a page control does: its rescue retires the leg
/// first, and the redial runs on the leg the rescue left (#263).
async fn redialed_after_its_rescue(board: &mut Switchboard, decided: Redial) -> Reply {
    let Redial::Planned(plan) = decided else {
        panic!("the change goes ahead");
    };
    let (leg, _rescue) = board
        .coordinator
        .begin_rescue_of(plan.leg(), "redial")
        .expect("the leg is on the line");
    board
        .redial(plan.rescued(leg))
        .await
        .expect("the leg the redial was planned for is still on the line")
}

/// A command the host refuses fails only that command (#423, #327): a
/// model the daemon refuses leaves the session usable on its old model, the
/// caller on it, and the session on the call under the token of the leg on
/// the line.
#[tokio::test]
async fn a_model_the_daemon_refuses_leaves_the_leg_on_its_old_model() {
    for code in ["daemon_error", "refused", "unsupported"] {
        let (mut board, log) = on_alpha_refusing("set_model", code).await;
        let live = board.agent.clone().expect("alpha is on the line");

        let decided = board.planner.model_change("anthropic/next").await;
        let reply = redialed_after_its_rescue(&mut board, decided).await;

        assert!(reply.error.is_some(), "{code}: {reply:?}");
        assert!(live.alive(), "{code}: the session was ended");
        assert!(
            board
                .agent
                .as_ref()
                .is_some_and(|agent| agent.same_session(&live)),
            "{code}: the caller left the session"
        );
        assert_eq!(board.coordinator.route(), "alpha", "{code}");
        assert_eq!(
            board.coordinator.status().model,
            "anthropic/current:medium",
            "{code}"
        );
        assert!(
            log.named("kill").is_empty(),
            "{code}: the session was killed"
        );
        let joins = log.named("join_call");
        assert_eq!(
            joins.last().and_then(|join| join["token"].as_str()),
            Some(board.coordinator.current_identity().token.as_str()),
            "{code}: the session is not on the call under the line's token"
        );
        board.shutdown().await;
    }
}

/// A thinking level the daemon refuses changes nothing either: the caller
/// stays on the leg as it was.
#[tokio::test]
async fn a_thinking_level_the_daemon_refuses_leaves_the_leg_as_it_was() {
    let (mut board, log) = on_alpha_refusing("set_thinking", "daemon_error").await;
    let live = board.agent.clone().expect("alpha is on the line");

    let decided = board.planner.thinking_change("high").await;
    let reply = redialed_after_its_rescue(&mut board, decided).await;

    assert!(reply.error.is_some(), "{reply:?}");
    assert!(live.alive());
    assert_eq!(board.coordinator.route(), "alpha");
    assert_eq!(board.coordinator.status().model, "anthropic/current:medium");
    assert!(log.named("kill").is_empty(), "the session was killed");
    board.shutdown().await;
}

/// A level the host refuses after the model changed does not end the leg
/// (#423): the leg goes on to the new model at the level the model came up
/// at, and the caller hears which.
#[tokio::test]
async fn a_level_refused_after_the_model_changed_keeps_the_new_model() {
    let (mut board, log) = on_alpha_refusing("set_thinking", "daemon_error").await;
    let live = board.agent.clone().expect("alpha is on the line");

    let decided = board.planner.model_change("anthropic/next").await;
    let reply = redialed_after_its_rescue(&mut board, decided).await;

    assert!(reply.error.is_some(), "{reply:?}");
    assert_eq!(
        reply.text,
        "Now on next on anthropic, but it would not take thinking medium, so it runs at medium."
    );
    assert_eq!(board.coordinator.route(), "alpha");
    assert!(live.alive());
    assert!(board
        .agent
        .as_ref()
        .is_some_and(|agent| agent.same_session(&live)));
    assert_eq!(board.coordinator.status().model, "anthropic/next:medium");
    assert!(log.named("kill").is_empty(), "the session was killed");
    assert_eq!(
        log.named("join_call")
            .last()
            .and_then(|join| join["token"].as_str()),
        Some(board.coordinator.current_identity().token.as_str())
    );
    board.shutdown().await;
}

/// A command that fails on the link, not by the host's answer, ends the
/// leg: the service still ends the session it created, so it does not run
/// on with the caller's conversation and block a desk takeover (#291).
#[tokio::test]
async fn a_model_change_the_link_fails_still_ends_the_session_on_its_host() {
    let (mut board, log) = on_alpha_refusing("set_model", "stale_epoch").await;
    let live = board.agent.clone().expect("alpha is on the line");

    let decided = board.planner.model_change("anthropic/next").await;
    let reply = redialed(&mut board, decided).await;

    assert!(reply.error.is_some(), "{reply:?}");
    assert!(!live.alive());
    assert_eq!(until_named(&log, "kill").await, [json!({"session": "s1"})]);
    board.shutdown().await;
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
async fn a_kept_model_change_whose_adoption_fails_announces_finished_once() {
    let mut board = board_on(vec![project("alpha", "")], &[], two_model_catalog());
    let coordinator = board.coordinator();
    let mut fake = FakeHostAgent::new(Box::new(|_, _| says("On it.")));
    fake.on_command = Some(Box::new(move |name, _| {
        if name == "set_model" {
            // A competing lifecycle owner moves the candidate before the
            // PBX adopts it, as the promotion test does.
            coordinator.set_candidate_token_for_test("not-the-swap-token");
        }
        None
    }));
    let _log = fake.serve(board.hosts().connect_fake(HOST));
    let reply = board
        .transfer_to(&transcript("look at alpha"), "alpha")
        .await;
    assert_eq!(reply.route, "alpha", "{reply:?}");
    let notices = record_agent_states(&mut board);

    // The kept session is still the switchboard's agent when adoption fails,
    // so dropping it announces `finished`; the arm must not announce it a
    // second time itself.
    let decided = board.planner.model_change("anthropic/next").await;
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

/// A project agent cannot change its own model: the call is refused,
/// whatever the swap setting, and the live leg is untouched. Only the page's
/// pickers redial.
#[tokio::test]
async fn the_agents_own_set_model_is_refused_and_changes_nothing() {
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
    assert_eq!(&board.coordinator.current_identity(), rescued.identity());
    assert!(!board.coordinator.is_candidate());
    assert_eq!(board.coordinator.status().model, "anthropic/current:medium");
    assert!(board
        .agent
        .as_ref()
        .is_some_and(|agent| agent.same_session(&live)));
    assert!(live.alive());
    board.coordinator.settle(rescued);

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
        .transfer_to(&transcript("look at alpha"), "alpha")
        .await;
    assert_eq!(reply.route, "alpha", "{reply:?}");
    let Redial::Planned(plan) = board.planner.model_change("anthropic/next").await else {
        panic!("a swap to a listed model goes ahead");
    };
    let (rescued, _rescue) = board
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
        .transfer_to(&transcript("look at alpha"), "alpha")
        .await;
    assert_eq!(reply.route, "alpha", "{reply:?}");
    let leg = board.coordinator.project_leg().unwrap();

    board.hosts().disconnect_fake(HOST);
    let Redial::Answered(reply) = board.planner.model_change("anthropic/next").await else {
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
            .transfer_to(&transcript("look at alpha"), "alpha")
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

/// The coordinator names alpha while the PBX still holds beta: the state an
/// adopted transfer to alpha left when its task was cancelled before it
/// committed. A redial planned on alpha must not switch beta's session and
/// put it on the line as alpha (#236).
#[tokio::test]
async fn a_redial_never_switches_another_projects_session() {
    let mut board = board_on(
        vec![project("alpha", ""), project("beta", "")],
        &[],
        two_model_catalog(),
    );
    let log = serve(&board, Box::new(|_, _| says("On it.")));
    let reply = board.transfer_to(&transcript("look at beta"), "beta").await;
    assert_eq!(reply.route, "beta", "{reply:?}");
    let beta = board.agent.clone().expect("beta is on the line");
    put_on(&board, "alpha", "anthropic/current", two_model_catalog());

    let Redial::Planned(plan) = board.planner.model_change("anthropic/next").await else {
        panic!("a swap to a listed model goes ahead");
    };
    let reply = board.redial(*plan).await.unwrap();

    assert!(reply.error.is_some(), "{reply:?}");
    assert!(log.named("set_model").is_empty(), "{:?}", log.names());
    assert!(
        !(board.coordinator.route() == "alpha"
            && board
                .agent
                .as_ref()
                .is_some_and(|agent| agent.same_session(&beta))),
        "beta's session is on the line as alpha"
    );
    board.shutdown().await;
}

/// A model change is refused while the leg on the line is still coming up:
/// adopted on its first sign of life, its intro not yet over.
#[tokio::test]
async fn a_model_change_waits_for_the_leg_to_finish_coming_up() {
    let (board, log) = on_alpha(&[], Box::new(|_, _| says("On it."))).await;
    board
        .coordinator
        .begin_candidate(
            CandidateLeg::new(
                "alpha",
                "alpha",
                "next-session",
                "next-leg",
                "anthropic/current",
                "",
            )
            .with_catalog(two_model_catalog()),
        )
        .unwrap();
    board.coordinator.adopt_candidate("next-leg").unwrap();

    let decided = board.planner.model_change("anthropic/next").await;

    let Redial::Answered(reply) = decided else {
        panic!("a leg still coming up is not redialed");
    };
    assert!(reply.error.is_some(), "{reply:?}");
    assert!(log.named("set_model").is_empty());
    let mut board = board;
    board.shutdown().await;
}

/// d6-coverage: a model change the host refuses keeps the leg only if the
/// kept session can rejoin the call under the line's token. When the host
/// refuses that `join_call` too, the leg is lost cleanly: the caller is back
/// on the operator, told why, and the session is ended on its host.
#[tokio::test]
async fn a_refused_change_whose_session_cannot_rejoin_the_call_loses_the_leg() {
    let mut board = board_on(vec![project("alpha", "")], &[], two_model_catalog());
    let mut host = FakeHostAgent::new(Box::new(|_, _| says("On it.")));
    let mut refused_model = false;
    host.on_command = Some(Box::new(move |name, _| match name {
        "set_model" => {
            refused_model = true;
            Some(Some(Err(("refused".into(), "refused for the test".into()))))
        }
        "join_call" if refused_model => Some(Some(Err((
            "daemon_error".into(),
            "join refused for the test".into(),
        )))),
        _ => None,
    }));
    let log = host.serve(board.hosts().connect_fake(HOST));
    let reply = board
        .transfer_to(&transcript("look at alpha"), "alpha")
        .await;
    assert_eq!(reply.route, "alpha", "{reply:?}");
    let live = board.agent.clone().expect("alpha is on the line");

    let decided = board.planner.model_change("anthropic/next").await;
    let reply = redialed_after_its_rescue(&mut board, decided).await;

    assert_eq!(reply.route, OPERATOR, "{reply:?}");
    assert!(reply.error.is_some(), "{reply:?}");
    assert_eq!(board.coordinator.route(), OPERATOR);
    assert!(board.agent.is_none(), "the PBX still holds the lost leg");
    assert_eq!(
        crate::pbx::until_named(&log, "kill").await,
        [serde_json::json!({"session": "s1"})]
    );
    assert!(!live.alive());
    board.shutdown().await;
}

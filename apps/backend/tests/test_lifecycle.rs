use super::*;
use crate::models::{CatalogEntry, ModelCatalog};
use std::sync::Arc;
use std::thread;

fn coordinator() -> Coordinator {
    Coordinator::new(StatusConfig::default(), "medium")
}

fn phase(coordinator: &Coordinator) -> Phase {
    coordinator.linearize(|state| state.phase)
}

fn coordinator_with_notices() -> (Coordinator, Arc<std::sync::Mutex<Vec<CandidateNotice>>>) {
    let notices = Arc::new(std::sync::Mutex::new(Vec::<CandidateNotice>::new()));
    let recorded = notices.clone();
    let mut coordinator = coordinator();
    coordinator.set_candidate_callback(Arc::new(move |notice| {
        recorded.lock().unwrap().push(notice.clone());
    }));
    (coordinator, notices)
}

fn alpha_candidate() -> CandidateLeg {
    CandidateLeg::new(
        "alpha",
        "alpha",
        "pi-session",
        "cand",
        "anthropic/opus",
        "medium",
    )
}

#[test]
fn candidate_notices_track_startup_adopt_rollback_and_rescue() {
    let (coordinator, notices) = coordinator_with_notices();
    coordinator.begin_candidate(alpha_candidate()).unwrap();
    assert_eq!(
        *notices.lock().unwrap(),
        vec![CandidateNotice {
            route: "alpha".into(),
            generation: 0,
            active: true,
        }]
    );
    // A rescue abandons the in-flight startup and must clear the notice.
    coordinator.begin_rescue("page rescue");
    assert_eq!(
        *notices.lock().unwrap(),
        vec![
            CandidateNotice {
                route: "alpha".into(),
                generation: 0,
                active: true,
            },
            CandidateNotice {
                route: "operator".into(),
                generation: 1,
                active: false,
            },
        ]
    );
    assert!(coordinator.candidate_identity().is_none());

    let (coordinator, notices) = coordinator_with_notices();
    coordinator.begin_candidate(alpha_candidate()).unwrap();
    coordinator.adopt_candidate("cand").unwrap();
    assert_eq!(
        *notices.lock().unwrap(),
        vec![
            CandidateNotice {
                route: "alpha".into(),
                generation: 0,
                active: true
            },
            CandidateNotice {
                route: "alpha".into(),
                generation: 1,
                active: false
            },
        ]
    );

    let (coordinator, notices) = coordinator_with_notices();
    coordinator.begin_candidate(alpha_candidate()).unwrap();
    assert!(coordinator.rollback_startup("startup failed"));
    assert_eq!(
        *notices.lock().unwrap(),
        vec![
            CandidateNotice {
                route: "alpha".into(),
                generation: 0,
                active: true
            },
            CandidateNotice {
                route: "operator".into(),
                generation: 0,
                active: false,
            },
        ]
    );
}

#[test]
fn prompt_and_steer_share_one_operation_identity() {
    let coordinator = coordinator();
    let leg = coordinator.current_identity();
    let operation = coordinator.begin_prompt(&leg).unwrap();
    assert_eq!(coordinator.attach_steer(&leg).unwrap(), operation);
    assert_eq!(coordinator.accept_side_effect(&leg.token), Ok(()));
    assert!(coordinator.finish_operation(&operation));
    assert!(!coordinator.finish_operation(&operation));
}

#[test]
fn stale_generation_and_concurrent_prompt_are_rejected() {
    let coordinator = coordinator();
    let old = coordinator.current_identity();
    let operation = coordinator.begin_prompt(&old).unwrap();
    assert_eq!(
        coordinator.begin_prompt(&old),
        Err(LifecycleError::OperationActive)
    );
    let current = coordinator.begin_rescue("page rescue");
    assert_eq!(current.generation, old.generation + 1);
    assert!(!coordinator.finish_operation(&operation));
    assert_eq!(
        coordinator.begin_prompt(&old),
        Err(LifecycleError::StaleLeg)
    );
}

#[test]
fn startup_thinking_is_private_until_candidate_adoption() {
    let coordinator = coordinator();
    let candidate = CandidateLeg::new(
        "alpha",
        "alpha",
        "pi-session",
        "candidate",
        "anthropic/opus",
        "medium",
    );
    coordinator.begin_candidate(candidate).unwrap();
    assert!(coordinator
        .accept_thinking_callback("candidate", "not-a-level")
        .is_err());
    assert_eq!(coordinator.status().thinking, "");
    assert_eq!(
        coordinator.accept_thinking_callback("candidate", "high"),
        Ok(false)
    );
    assert_eq!(coordinator.status().route, "operator");
    let identity = coordinator.adopt_candidate("candidate").unwrap();
    assert_eq!(identity.generation, 1);
    assert_eq!(coordinator.status().route, "alpha");
    assert_eq!(coordinator.status().thinking, "high");
}

#[test]
fn rescue_reopens_only_once_the_call_settles() {
    let coordinator = coordinator();
    let old = coordinator.current_identity();
    coordinator.begin_rescue("page rescue");
    assert_eq!(
        coordinator.begin_prompt(&coordinator.current_identity()),
        Err(LifecycleError::WrongPhase)
    );
    coordinator.settle();
    let operation = coordinator
        .begin_prompt(&coordinator.current_identity())
        .unwrap();
    assert_eq!(operation.leg.generation, old.generation + 1);
}

#[test]
fn invalid_startup_thinking_is_rejected() {
    let coordinator = coordinator();
    let candidate = CandidateLeg::new("alpha", "alpha", "session", "candidate", "model", "medium");
    coordinator.begin_candidate(candidate).unwrap();
    assert_eq!(
        coordinator.accept_thinking_callback("candidate", "invalid_level"),
        Err(LifecycleError::WrongPhase)
    );
    coordinator.adopt_candidate("candidate").unwrap();
    assert_eq!(coordinator.status().thinking, "medium");
}

#[test]
fn candidate_failure_rolls_back_private_state_and_side_effects_are_rejected() {
    let coordinator = coordinator();
    coordinator
        .begin_candidate(CandidateLeg::new(
            "alpha",
            "alpha",
            "session",
            "candidate",
            "model",
            "medium",
        ))
        .unwrap();
    assert_eq!(
        coordinator.accept_side_effect("candidate"),
        Err(LifecycleError::CandidateSideEffect)
    );
    assert_eq!(
        coordinator.accept_thinking_callback("candidate", "high"),
        Ok(false)
    );
    assert!(coordinator.rollback_startup("intro failed"));
    assert_eq!(coordinator.status().route, "operator");
    assert!(coordinator.candidate_identity().is_none());
    assert!(!coordinator.is_candidate());
}

#[test]
fn callbacks_require_the_current_leg_token_and_stale_work_is_rejected() {
    let coordinator = coordinator();
    assert_eq!(
        coordinator.accept_thinking_callback("wrong", "high"),
        Err(LifecycleError::StaleLeg)
    );
    let candidate = CandidateLeg::new("alpha", "alpha", "session", "candidate", "model", "medium");
    coordinator.begin_candidate(candidate).unwrap();
    assert_eq!(
        coordinator.accept_thinking_callback("old", "high"),
        Err(LifecycleError::StaleLeg)
    );
    coordinator.adopt_candidate("candidate").unwrap();
    assert!(coordinator.accept_side_effect("candidate").is_ok());
    assert_eq!(
        coordinator.accept_side_effect("candidate-old"),
        Err(LifecycleError::StaleLeg)
    );
    assert!(coordinator.finish_intro());
    assert_eq!(
        coordinator.accept_side_effect("candidate"),
        Err(LifecycleError::StaleLeg)
    );
    let operation = coordinator
        .begin_prompt(&coordinator.current_identity())
        .unwrap();
    assert!(coordinator.accept_side_effect("candidate").is_ok());
    coordinator.finish_operation(&operation);
    assert_eq!(
        coordinator.accept_thinking_callback("candidate", "high"),
        Ok(true)
    );
    assert_eq!(
        coordinator.accept_thinking_callback("candidate-old", "high"),
        Err(LifecycleError::StaleLeg)
    );
}

#[test]
fn the_launch_catalog_is_shown_once_its_leg_is_adopted() {
    let catalog = ModelCatalog {
        entries: vec![CatalogEntry {
            provider: "anthropic".into(),
            model: "opus".into(),
            thinks: true,
        }],
        available: true,
        diagnostic: None,
    };
    let coordinator = coordinator();
    coordinator
        .begin_candidate(
            CandidateLeg::new(
                "alpha",
                "alpha",
                "session",
                "token",
                "anthropic/opus",
                "medium",
            )
            .with_catalog(catalog),
        )
        .unwrap();
    coordinator.adopt_candidate("token").unwrap();
    assert_eq!(coordinator.status().models[0].model, "opus");
}

#[test]
fn status_read_does_not_wait_for_lifecycle_linearization() {
    let coordinator = Arc::new(coordinator());
    let held = Arc::clone(&coordinator);
    let entered = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    let entered_thread = Arc::clone(&entered);
    let release_thread = Arc::clone(&release);
    let worker = thread::spawn(move || {
        held.linearize(|_| {
            entered_thread.wait();
            release_thread.wait();
        });
    });
    entered.wait();
    assert_eq!(coordinator.status().route, "operator");
    release.wait();
    worker.join().unwrap();
}

#[test]
fn idle_time_is_measured_from_the_last_turn_boundary() {
    let coordinator = coordinator();
    coordinator
        .begin_candidate(CandidateLeg::new(
            "alpha", "alpha", "session", "token", "model", "medium",
        ))
        .unwrap();
    coordinator.adopt_candidate("token").unwrap();
    coordinator.finish_intro();
    let idle = std::time::Duration::from_millis(40);

    // A turn that outlasts the idle timeout has not left the caller silent:
    // silence starts when it ends.
    let operation = coordinator
        .begin_prompt(&coordinator.current_identity())
        .unwrap();
    std::thread::sleep(idle * 2);
    coordinator.finish_operation(&operation);
    assert_eq!(coordinator.return_if_idle(idle), None);

    // A steer is the caller speaking.
    let operation = coordinator
        .begin_prompt(&coordinator.current_identity())
        .unwrap();
    std::thread::sleep(idle * 2);
    coordinator
        .attach_steer(&coordinator.current_identity())
        .unwrap();
    coordinator.finish_operation(&operation);
    std::thread::sleep(idle / 2);
    assert_eq!(coordinator.return_if_idle(idle), None);

    std::thread::sleep(idle * 2);
    assert!(coordinator.return_if_idle(idle).is_some());
}

fn alpha_catalog() -> ModelCatalog {
    ModelCatalog {
        entries: vec![CatalogEntry {
            provider: "anthropic".into(),
            model: "opus".into(),
            thinks: true,
        }],
        available: true,
        diagnostic: None,
    }
}

/// Puts the call on alpha the way a transfer does: a candidate, adopted, its
/// intro finished.
fn on_alpha(coordinator: &Coordinator) {
    coordinator
        .begin_candidate(alpha_candidate().with_catalog(alpha_catalog()))
        .unwrap();
    coordinator.adopt_candidate("cand").unwrap();
    assert!(coordinator.finish_intro());
}

/// Asserts nothing of the project leg is left on the call.
fn assert_on_the_operator(coordinator: &Coordinator) {
    assert_eq!(coordinator.route(), "operator");
    assert_eq!(coordinator.project_leg(), None);
    assert_eq!(
        coordinator.linearize(|state| (state.model.clone(), state.persistent_session_id.clone())),
        (String::new(), String::new())
    );
    let status = coordinator.status();
    assert_eq!(
        (status.route.as_str(), status.label.as_str()),
        ("operator", "Operator")
    );
    assert!(status.models.is_empty());
    assert!(status.models_available);
    assert!(!status.thinking_confirmed);
}

#[test]
fn return_to_operator_clears_the_leg_from_every_phase() {
    // At rest on a project: the agent handed back, or the page connected.
    let call = coordinator();
    on_alpha(&call);
    let generation = call.generation();
    assert_eq!(phase(&call), Phase::Active);
    call.return_to_operator();
    assert_eq!(phase(&call), Phase::Operator);
    assert_on_the_operator(&call);
    // The generation is the leg's, not the route's: a return keeps it.
    assert_eq!(call.generation(), generation);

    // Quiescing: a page rescue, then the hangup that follows it.
    let call = coordinator();
    on_alpha(&call);
    call.begin_rescue("page rescue");
    assert_eq!(phase(&call), Phase::Quiescing);
    call.return_to_operator();
    assert_eq!(phase(&call), Phase::Operator);
    assert_on_the_operator(&call);

    // Mid-turn: the operator is being told why the caller came back, and the
    // turn settles the phase when it ends.
    let call = coordinator();
    on_alpha(&call);
    let operation = call.begin_prompt(&call.current_identity()).unwrap();
    call.return_to_operator();
    assert_eq!(phase(&call), Phase::TurnRunning);
    assert_on_the_operator(&call);
    assert!(call.finish_operation(&operation));
    assert_eq!(phase(&call), Phase::Operator);

    // Already on the operator: nothing to clear.
    let call = coordinator();
    call.return_to_operator();
    assert_eq!(phase(&call), Phase::Operator);
    assert_on_the_operator(&call);

    // A staged candidate is not on the line yet, and stays staged.
    let call = coordinator();
    call.begin_candidate(alpha_candidate()).unwrap();
    call.return_to_operator();
    assert_eq!(phase(&call), Phase::Starting);
    assert!(call.candidate_identity().is_some());

    // Shutting down stays shutting down.
    let call = coordinator();
    on_alpha(&call);
    call.begin_shutdown();
    call.return_to_operator();
    assert_eq!(phase(&call), Phase::Shutdown);
    assert_on_the_operator(&call);
}

#[test]
fn settle_brings_a_rescued_call_to_rest_even_when_the_control_is_refused() {
    // A redial rescues the live leg, then the PBX refuses it: the leg is still
    // named, and the call must not stay quiescing, refusing every callback
    // and steer, until something else happens to publish a status.
    let call = coordinator();
    on_alpha(&call);
    call.begin_rescue("model change");
    let current = call.current_identity();
    assert_eq!(call.begin_prompt(&current), Err(LifecycleError::WrongPhase));
    let status = call.settle();
    assert_eq!(status.route, "alpha");
    assert_eq!(status, call.status());
    assert_eq!(phase(&call), Phase::Active);
    assert!(call.begin_prompt(&current).is_ok());

    // On the operator it comes to rest on the operator.
    let call = coordinator();
    call.begin_rescue("hangup with nothing on the line");
    assert_eq!(call.settle().route, "operator");
    assert_eq!(phase(&call), Phase::Operator);

    // A call that is not quiescing is left as it is.
    let call = coordinator();
    let operation = call.begin_prompt(&call.current_identity()).unwrap();
    call.settle();
    assert_eq!(phase(&call), Phase::TurnRunning);
    assert!(call.finish_operation(&operation));
}

#[test]
fn the_status_is_built_from_the_coordinators_own_state() {
    let coordinator = Coordinator::new(
        StatusConfig {
            operator_model: "provider/operator-model:low".into(),
            model_swaps: true,
            projects: vec!["alpha".into(), "beta".into()],
        },
        "medium",
    );
    let levels: Vec<String> = THINKING_LEVELS
        .iter()
        .map(|level| (*level).into())
        .collect();
    let operator = Status {
        route: "operator".into(),
        label: "Operator".into(),
        model: "provider/operator-model:low".into(),
        model_name: "provider/operator-model".into(),
        thinking: "low".into(),
        thinking_requested: "low".into(),
        thinking_confirmed: false,
        thinking_default: "medium".into(),
        levels: levels.clone(),
        models: Vec::new(),
        models_available: true,
        models_diagnostic: None,
        model_swaps: true,
        projects: vec!["alpha".into(), "beta".into()],
    };
    assert_eq!(coordinator.status(), operator);

    // A starting leg is private: the page still shows the operator.
    coordinator
        .begin_candidate(
            CandidateLeg::new(
                "alpha",
                "alpha",
                "session",
                "alpha-leg",
                "anthropic/opus:high",
                "high",
            )
            .with_catalog(alpha_catalog()),
        )
        .unwrap();
    assert_eq!(coordinator.status(), operator);

    // On the project: its model, the level it was asked for, and the catalog
    // it launched with.
    coordinator.adopt_candidate("alpha-leg").unwrap();
    coordinator.finish_intro();
    let project = Status {
        route: "alpha".into(),
        label: "alpha".into(),
        model: "anthropic/opus:high".into(),
        model_name: "anthropic/opus".into(),
        thinking: "high".into(),
        thinking_requested: "high".into(),
        thinking_confirmed: false,
        thinking_default: "medium".into(),
        levels,
        models: vec![ModelEntry {
            provider: "anthropic".into(),
            model: "opus".into(),
            thinks: true,
        }],
        models_available: true,
        models_diagnostic: None,
        model_swaps: true,
        projects: vec!["alpha".into(), "beta".into()],
    };
    assert_eq!(coordinator.status(), project);

    // The leg reports the level it actually runs at.
    assert_eq!(
        coordinator.accept_thinking_callback("alpha-leg", "medium"),
        Ok(true)
    );
    let confirmed = Status {
        thinking: "medium".into(),
        thinking_confirmed: true,
        ..project
    };
    assert_eq!(coordinator.status(), confirmed);

    // Rescued: the leg stays named until the caller is put back.
    coordinator.begin_rescue("page rescue");
    assert_eq!(coordinator.status(), confirmed);

    coordinator.return_to_operator();
    assert_eq!(coordinator.status(), operator);

    coordinator.set_thinking_default("xhigh");
    assert_eq!(coordinator.status().thinking_default, "xhigh");
    assert_eq!(coordinator.thinking_default(), "xhigh");
}

#[test]
fn activity_is_classified_by_the_leg_it_came_from() {
    use ActivityDisposition::{Discard, Promote, Publish};
    let call = coordinator();
    // On the operator: the operator's process is the leg on the line.
    assert_eq!(call.classify_activity("operator"), Publish);
    assert_eq!(call.classify_activity("stray"), Discard);

    // A candidate is starting. Only its own activity promotes it; the
    // operator is still on the line, and nothing else is.
    call.begin_candidate(alpha_candidate()).unwrap();
    assert_eq!(call.classify_activity("cand"), Promote);
    assert_eq!(call.classify_activity("operator"), Publish);
    assert_eq!(call.classify_activity("stray"), Discard);
    assert_eq!(
        call.adopt_candidate("stray"),
        Err(LifecycleError::CandidateTokenMismatch)
    );
    assert!(call.candidate_identity().is_some());

    // Adopted: the new leg is current, and the operator it replaced is not.
    call.adopt_candidate("cand").unwrap();
    assert_eq!(call.classify_activity("cand"), Publish);
    assert_eq!(call.classify_activity("operator"), Discard);
    assert_eq!(
        call.adopt_candidate("cand"),
        Err(LifecycleError::NoCandidate)
    );

    // Rescued: whatever the retired leg reports before it is reaped is stale,
    // and stays stale once the call settles on a new generation.
    call.begin_rescue("page rescue");
    assert_eq!(call.classify_activity("cand"), Discard);
    call.settle();
    assert_eq!(call.classify_activity("cand"), Discard);

    // Back on the operator.
    call.return_to_operator();
    assert_eq!(call.classify_activity("operator"), Publish);
    assert_eq!(call.classify_activity("cand"), Discard);

    // A candidate a rescue abandoned never promotes.
    call.begin_candidate(CandidateLeg::new(
        "beta", "beta", "session", "beta-leg", "model", "medium",
    ))
    .unwrap();
    call.begin_rescue("hangup mid-startup");
    assert_eq!(call.classify_activity("beta-leg"), Discard);
}

#[test]
fn the_project_leg_is_read_in_one_piece() {
    let call = coordinator();
    assert_eq!(call.project_leg(), None);

    // A starting leg is not on the line yet.
    call.begin_candidate(alpha_candidate()).unwrap();
    assert_eq!(call.project_leg(), None);

    call.adopt_candidate("cand").unwrap();
    assert_eq!(
        call.project_leg(),
        Some(ProjectLeg {
            project: "alpha".into(),
            identity: LegIdentity::new("cand", 1),
            model: "anthropic/opus".into(),
            persistent_session_id: "pi-session".into(),
        })
    );

    call.return_to_operator();
    assert_eq!(call.project_leg(), None);
}

#[test]
fn a_rescue_of_a_named_leg_happens_only_while_that_leg_is_on_the_line() {
    // Still on the line: rescued like any other rescue, and the same project,
    // model, and session come back under the new identity.
    let call = coordinator();
    on_alpha(&call);
    let leg = call.project_leg().unwrap();
    let rescued = call.begin_rescue_of(&leg, "redial").unwrap();
    assert_eq!(rescued.identity, call.current_identity());
    assert_eq!(rescued.identity.generation, leg.identity.generation + 1);
    assert_eq!(
        ProjectLeg {
            identity: leg.identity.clone(),
            ..rescued.clone()
        },
        leg
    );
    assert_eq!(phase(&call), Phase::Quiescing);
    assert_eq!(call.project_leg(), Some(rescued.clone()));
    // The leg as it was read before the rescue is gone.
    assert_eq!(call.begin_rescue_of(&leg, "redial"), None);

    // Every way the leg is left refuses the rescue and changes nothing.
    let refused = |call: &Coordinator, leg: &ProjectLeg| {
        let generation = call.generation();
        let before = phase(call);
        assert_eq!(call.begin_rescue_of(leg, "redial"), None);
        assert_eq!(call.generation(), generation);
        assert_eq!(phase(call), before);
    };
    // Returned to the operator, which keeps the generation.
    let call = coordinator();
    on_alpha(&call);
    let leg = call.project_leg().unwrap();
    call.return_to_operator();
    refused(&call, &leg);
    // Rescued by something else.
    let call = coordinator();
    on_alpha(&call);
    let leg = call.project_leg().unwrap();
    call.begin_rescue("hangup");
    call.settle();
    refused(&call, &leg);
    // Replaced by another leg.
    let call = coordinator();
    on_alpha(&call);
    let leg = call.project_leg().unwrap();
    call.begin_candidate(CandidateLeg::new(
        "alpha",
        "alpha",
        "pi-session",
        "next",
        "anthropic/opus",
        "medium",
    ))
    .unwrap();
    call.adopt_candidate("next").unwrap();
    call.finish_intro();
    refused(&call, &leg);
    // Shutting down.
    let call = coordinator();
    on_alpha(&call);
    call.begin_shutdown();
    let leg = call.project_leg().unwrap();
    refused(&call, &leg);
}

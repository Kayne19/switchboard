use super::*;
use crate::models::{CatalogEntry, ModelCatalog};
use crate::protocol::{CandidateEnd, ModelEntry};
use futures_util::FutureExt;
use std::sync::Arc;
use std::thread;

fn coordinator() -> Coordinator {
    Coordinator::new(StatusConfig::default(), "medium")
}

/// The phase the call is in, as the tests name it.
fn phase(coordinator: &Coordinator) -> &'static str {
    coordinator.linearize(|state| match &state.line {
        Line::Open { leg, turn } | Line::Adopted { leg, turn, .. } => match turn {
            Some(_) => "turn running",
            None if leg.launch.is_none() => "operator",
            None => "active",
        },
        Line::Starting { .. } => "starting",
        Line::Quiescing { .. } => "quiescing",
        Line::Shutdown { .. } => "shutdown",
    })
}

/// The turn open on the line, if any.
fn open_turn(coordinator: &Coordinator) -> Option<OperationIdentity> {
    coordinator.linearize(|state| state.line.turn().cloned())
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
            ended: None,
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
                ended: None,
            },
            // The rescue retires the candidate's generation (1) as well
            // as the line's (0).
            CandidateNotice {
                route: "alpha".into(),
                generation: 2,
                ended: Some(CandidateEnd::Rescued),
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
                ended: None,
            },
            CandidateNotice {
                route: "alpha".into(),
                generation: 1,
                ended: Some(CandidateEnd::Adopted),
            },
        ]
    );

    let (coordinator, notices) = coordinator_with_notices();
    let startup = coordinator.begin_candidate(alpha_candidate()).unwrap();
    assert!(coordinator.rollback_startup(startup.generation, "startup failed"));
    assert_eq!(
        *notices.lock().unwrap(),
        vec![
            CandidateNotice {
                route: "alpha".into(),
                generation: 0,
                ended: None,
            },
            CandidateNotice {
                route: "alpha".into(),
                generation: 0,
                ended: Some(CandidateEnd::RolledBack),
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
    assert_eq!(
        coordinator.accept_side_effect(&leg.token, None, None),
        Ok(())
    );
    assert!(coordinator.finish_operation(&operation));
    assert!(!coordinator.finish_operation(&operation));
}

#[test]
fn autonomous_operations_require_turn_authority_and_reject_stale_calls() {
    let coordinator = coordinator();
    coordinator.begin_candidate(alpha_candidate()).unwrap();
    coordinator.adopt_candidate("cand").unwrap();
    let intro = open_turn(&coordinator).expect("candidate intro");
    assert!(coordinator.finish_operation(&intro));
    let leg = coordinator.current_identity();
    let operation = coordinator.begin_autonomous(&leg, "turn-7").unwrap();
    assert_eq!(
        coordinator.accept_side_effect("cand", None, Some("autonomous")),
        Err(LifecycleError::StaleLeg)
    );
    assert_eq!(
        coordinator.accept_side_effect("cand", Some("turn-old"), Some("autonomous")),
        Err(LifecycleError::StaleLeg)
    );
    assert_eq!(
        coordinator.accept_side_effect("cand", Some("turn-7"), Some("autonomous")),
        Ok(())
    );
    assert!(coordinator.finish_operation(&operation));
}

#[test]
fn a_caller_turn_the_host_settled_closes_before_its_prompt_returns() {
    let coordinator = coordinator();
    coordinator.begin_candidate(alpha_candidate()).unwrap();
    coordinator.adopt_candidate("cand").unwrap();
    // The intro is the new leg's startup; only `finish_intro` ends it.
    coordinator.bind_turn("cand", "turn-0").unwrap();
    assert!(!coordinator.settle_turn("cand", "turn-0"));
    assert!(coordinator.finish_intro());
    let leg = coordinator.current_identity();
    let caller = coordinator.begin_prompt(&leg).unwrap();
    // Before the host names the caller's turn, no settle report owns it.
    assert!(!coordinator.settle_turn("cand", "turn-1"));
    coordinator.bind_turn("cand", "turn-1").unwrap();
    assert!(!coordinator.settle_turn("other", "turn-1"));
    assert!(!coordinator.settle_turn("cand", "turn-0"));
    assert!(coordinator.begin_autonomous(&leg, "turn-2").is_err());

    assert!(coordinator.settle_turn("cand", "turn-1"));

    // The run the host started right behind it is admitted, and the prompt's
    // own close, when it returns, leaves that run alone.
    let woken = coordinator.begin_autonomous(&leg, "turn-2").unwrap();
    assert!(!coordinator.finish_operation(&caller));
    assert_eq!(coordinator.attach_steer(&leg).unwrap(), woken);
    assert!(coordinator.finish_operation(&woken));
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
    assert_eq!(current.generation(), old.generation + 1);
    assert!(!coordinator.finish_operation(&operation));
    assert_eq!(
        coordinator.begin_prompt(&old),
        Err(LifecycleError::StaleLeg)
    );
}

#[test]
fn a_rescue_at_a_generation_the_call_has_left_rescues_nothing() {
    // A page control rescues only the leg the page saw when the caller acted
    // (#263); the check and the rescue are one step under the state lock.
    let (coordinator, notices) = coordinator_with_notices();
    coordinator.begin_candidate(alpha_candidate()).unwrap();
    let held = coordinator.generation();
    let moved = coordinator.begin_rescue("transfer");
    // Past the abandoned candidate's generation too (#280).
    assert!(moved.generation() > held, "{moved:?} after {held}");
    let told = notices.lock().unwrap().len();

    assert!(coordinator.begin_rescue_at(held, "page connect").is_none());
    assert_eq!(
        &coordinator.current_identity(),
        moved.identity(),
        "nothing was rescued"
    );
    assert_eq!(notices.lock().unwrap().len(), told, "nothing was announced");

    let rescued = coordinator
        .begin_rescue_at(moved.generation(), "page connect")
        .expect("the generation the call is at is rescued");
    assert_eq!(rescued.generation(), moved.generation() + 1);
    assert_eq!(phase(&coordinator), "quiescing");
}

#[test]
fn stale_generation_cannot_settle_a_lifecycle_projection() {
    let coordinator = coordinator();
    let called = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let called_in_operation = called.clone();
    assert!(coordinator
        .with_generation(99, || {
            called_in_operation.store(true, std::sync::atomic::Ordering::Release);
        })
        .is_none());
    assert!(!called.load(std::sync::atomic::Ordering::Acquire));

    let old_generation = coordinator.generation();
    coordinator.begin_rescue("replace the leg");
    assert!(coordinator
        .with_generation(old_generation, || {
            called.store(true, std::sync::atomic::Ordering::Release);
        })
        .is_none());
    assert!(!called.load(std::sync::atomic::Ordering::Acquire));
}

#[test]
fn no_prompt_begins_while_a_page_started_leg_is_starting() {
    // A page control starts a leg with no turn running. A prompt begun then
    // would take the call out of `Starting` with the candidate still staged,
    // and the leg would never be adopted.
    let coordinator = coordinator();
    coordinator.begin_rescue("page connect");
    coordinator.begin_candidate(alpha_candidate()).unwrap();
    assert_eq!(
        coordinator.begin_prompt(&coordinator.current_identity()),
        Err(LifecycleError::CandidateActive)
    );
    assert!(coordinator.is_candidate());
    let adopted = coordinator.adopt_candidate("cand").unwrap();
    assert_eq!(coordinator.current_identity(), adopted);
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
    let rescued = coordinator.begin_rescue("page rescue");
    assert_eq!(
        coordinator.begin_prompt(&coordinator.current_identity()),
        Err(LifecycleError::WrongPhase)
    );
    coordinator.settle(rescued);
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
    let startup = coordinator
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
        coordinator.accept_side_effect("candidate", None, None),
        Err(LifecycleError::CandidateSideEffect)
    );
    assert_eq!(
        coordinator.accept_thinking_callback("candidate", "high"),
        Ok(false)
    );
    assert!(coordinator.rollback_startup(startup.generation, "intro failed"));
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
    assert!(coordinator
        .accept_side_effect("candidate", None, None)
        .is_ok());
    assert_eq!(
        coordinator.accept_side_effect("candidate-old", None, None),
        Err(LifecycleError::StaleLeg)
    );
    assert!(coordinator.finish_intro());
    assert_eq!(
        coordinator.accept_side_effect("candidate", None, None),
        Err(LifecycleError::StaleLeg)
    );
    let operation = coordinator
        .begin_prompt(&coordinator.current_identity())
        .unwrap();
    assert!(coordinator
        .accept_side_effect("candidate", None, None)
        .is_ok());
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
    assert!(coordinator.linearize(|state| state.line.leg().launch.is_none()));
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
    assert_eq!(phase(&call), "active");
    call.return_to_operator();
    assert_eq!(phase(&call), "operator");
    assert_on_the_operator(&call);
    // The generation is the leg's, not the route's: a return keeps it.
    assert_eq!(call.generation(), generation);

    // Quiescing: a page rescue, then the hangup that follows it.
    let call = coordinator();
    on_alpha(&call);
    call.begin_rescue("page rescue");
    assert_eq!(phase(&call), "quiescing");
    call.return_to_operator();
    assert_eq!(phase(&call), "operator");
    assert_on_the_operator(&call);

    // Mid-turn: the operator is being told why the caller came back, and the
    // turn settles the phase when it ends.
    let call = coordinator();
    on_alpha(&call);
    let operation = call.begin_prompt(&call.current_identity()).unwrap();
    call.return_to_operator();
    assert_eq!(phase(&call), "turn running");
    assert_on_the_operator(&call);
    assert!(call.finish_operation(&operation));
    assert_eq!(phase(&call), "operator");

    // Already on the operator: nothing to clear.
    let call = coordinator();
    call.return_to_operator();
    assert_eq!(phase(&call), "operator");
    assert_on_the_operator(&call);

    // A staged candidate is not on the line yet, and stays staged.
    let call = coordinator();
    call.begin_candidate(alpha_candidate()).unwrap();
    call.return_to_operator();
    assert_eq!(phase(&call), "starting");
    assert!(call.candidate_identity().is_some());

    // Shutting down stays shutting down.
    let call = coordinator();
    on_alpha(&call);
    call.begin_shutdown();
    call.return_to_operator();
    assert_eq!(phase(&call), "shutdown");
    assert_on_the_operator(&call);
}

#[test]
fn the_adoption_is_on_the_line_until_the_leg_is_replaced() {
    let call = coordinator();
    assert_eq!(call.generation_and_adoption(), (0, None));
    on_alpha(&call);
    assert_eq!(call.generation_and_adoption(), (1, Some("alpha".into())));
    // A hangup while on alpha: the rescue, then the return. Neither leaves
    // the adoption on the line, although the return keeps the generation.
    call.begin_rescue("hangup");
    assert_eq!(call.generation_and_adoption(), (2, None));

    let call = coordinator();
    on_alpha(&call);
    call.return_to_operator();
    assert_eq!(call.generation_and_adoption(), (1, None));

    // A candidate rescued while it starts was never adopted, and the rescue
    // retires its generation (1) too.
    let call = coordinator();
    call.begin_candidate(alpha_candidate()).unwrap();
    call.begin_rescue("hangup");
    assert_eq!(call.generation_and_adoption(), (2, None));
}

// Issue #77: a return to the operator kept the project leg's identity, so a
// callback carrying that leg's token was taken as the operator's own.
#[test]
fn a_return_to_the_operator_retires_the_project_legs_token() {
    let call = coordinator();
    on_alpha(&call);
    let project = call.current_identity();
    assert_eq!(project.token, "cand");

    // Mid-turn, as when the agent hands the caller back: the operator is
    // being told why, and the project's process may still be on its way out.
    let operation = call.begin_prompt(&project).unwrap();
    call.return_to_operator();
    let operator = call.current_identity();
    assert_eq!(operator, LegIdentity::new("operator", project.generation));
    assert_eq!(
        call.accept_side_effect("cand", None, None),
        Err(LifecycleError::StaleLeg),
        "the project leg's token no longer speaks for the line"
    );
    assert_eq!(
        call.accept_thinking_callback("cand", "high"),
        Err(LifecycleError::StaleLeg)
    );
    assert_eq!(call.accept_side_effect("", None, None), Ok(()));
    assert_eq!(call.accept_side_effect("operator", None, None), Ok(()));
    // The turn that brought the caller back still ends as its own.
    assert!(call.finish_operation(&operation));

    // At rest, and after the operator itself is rescued, the project's token
    // stays refused.
    let rescued = call.begin_rescue("page rescue");
    call.settle(rescued);
    assert_eq!(
        call.accept_side_effect("cand", None, None),
        Err(LifecycleError::StaleLeg)
    );
    assert_eq!(call.accept_side_effect("", None, None), Ok(()));
}

#[test]
fn settle_brings_a_rescued_call_to_rest_even_when_the_control_is_refused() {
    // A redial rescues the live leg, then the PBX refuses it: the leg is still
    // named, and the call must not stay quiescing, refusing every callback
    // and steer, until something else happens to publish a status.
    let call = coordinator();
    on_alpha(&call);
    let rescued = call.begin_rescue("model change");
    let current = call.current_identity();
    assert_eq!(call.begin_prompt(&current), Err(LifecycleError::WrongPhase));
    assert!(call.settle(rescued));
    assert_eq!(call.status().route, "alpha");
    assert_eq!(phase(&call), "active");
    assert!(call.begin_prompt(&current).is_ok());

    // On the operator it comes to rest on the operator.
    let call = coordinator();
    let rescued = call.begin_rescue("hangup with nothing on the line");
    assert!(call.settle(rescued));
    assert_eq!(call.status().route, "operator");
    assert_eq!(phase(&call), "operator");

    // A call that is not quiescing is left as it is.
    let call = coordinator();
    let operation = call.begin_prompt(&call.current_identity()).unwrap();
    assert!(call.settle_at(call.generation()));
    assert_eq!(phase(&call), "turn running");
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
    let rescued = call.begin_rescue("page rescue");
    assert_eq!(call.classify_activity("cand"), Discard);
    call.settle(rescued);
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
    let (rescued, _rescue) = call.begin_rescue_of(&leg, "redial").unwrap();
    assert_eq!(rescued.identity, call.current_identity());
    assert_eq!(rescued.identity.generation, leg.identity.generation + 1);
    assert_eq!(
        ProjectLeg {
            identity: leg.identity.clone(),
            ..rescued.clone()
        },
        leg
    );
    assert_eq!(phase(&call), "quiescing");
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
    let rescued = call.begin_rescue("hangup");
    call.settle(rescued);
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

#[test]
fn a_caller_operation_bound_to_a_host_turn_still_finishes() {
    // The worker keeps the operation it began; the host then reports the
    // caller turn's id, which `bind_turn` stamps onto the live operation.
    // Finishing with the worker's copy must still close it, or every later
    // prompt waits forever behind an operation nobody owns.
    let coordinator = coordinator();
    coordinator.begin_candidate(alpha_candidate()).unwrap();
    coordinator.adopt_candidate("cand").unwrap();
    let intro = open_turn(&coordinator).expect("candidate intro");
    assert!(coordinator.finish_operation(&intro));
    let leg = coordinator.current_identity();
    let operation = coordinator.begin_prompt(&leg).unwrap();
    assert_eq!(coordinator.bind_turn("cand", "turn-1"), Ok(()));
    assert!(coordinator.finish_operation(&operation));
    assert_eq!(phase(&coordinator), "active");
    assert!(coordinator.begin_prompt(&leg).is_ok());
}

/// A transfer's candidate is adopted on its first sign of life, but its
/// startup ends only when its intro does. A rescue in between cancels the
/// work that would commit or roll it back, so the startup ends with the
/// rescue: nothing is left for a late rollback to restore (#236).
#[test]
fn a_rescue_during_an_adopted_legs_intro_ends_its_startup() {
    let call = coordinator();
    on_alpha(&call);
    let startup = call
        .begin_candidate(CandidateLeg::new(
            "beta",
            "beta",
            "beta-session",
            "beta-leg",
            "anthropic/sonnet",
            "medium",
        ))
        .unwrap();
    call.adopt_candidate("beta-leg").unwrap();
    assert_eq!(call.route(), "beta");

    let rescued = call.begin_rescue("page rescue");
    let identity = rescued.identity().clone();
    call.settle(rescued);

    assert!(!call.finish_intro());
    assert!(!call.rollback_startup(startup.generation, "late"));
    assert_eq!(call.route(), "beta");
    assert_eq!(call.current_identity(), identity);
}

/// A rescue for a redial is refused while a startup is in flight: the leg
/// the coordinator names is not yet the PBX's.
#[test]
fn a_redial_rescue_waits_for_the_startup_to_commit() {
    let call = coordinator();
    on_alpha(&call);
    call.begin_candidate(CandidateLeg::new(
        "beta",
        "beta",
        "beta-session",
        "beta-leg",
        "anthropic/sonnet",
        "medium",
    ))
    .unwrap();
    call.adopt_candidate("beta-leg").unwrap();
    let beta = call.project_leg().unwrap();
    let generation = call.generation();

    assert_eq!(call.begin_rescue_of(&beta, "redial"), None);
    assert_eq!(call.generation(), generation);
    assert_eq!(call.route(), "beta");

    assert!(call.finish_intro());
    assert!(call.begin_rescue_of(&beta, "redial").is_some());
}

/// Shutdown is final. It used to leave a staged candidate and the startup's
/// rollback in place, so a transfer still finishing as the service shut down
/// could adopt its leg or roll back to the old one, and either moved the call
/// out of `Shutdown`: turns and module calls were admitted again while the
/// processes were being reaped.
#[test]
fn a_shutdown_ends_the_startup_in_flight_and_nothing_reopens_the_call() {
    // A candidate staged: abandoned as a rescue abandons it.
    let (call, notices) = coordinator_with_notices();
    on_alpha(&call);
    let startup = call.begin_candidate(beta_candidate()).unwrap();
    notices.lock().unwrap().clear();
    assert!(call.begin_shutdown());
    assert!(!call.startup_in_flight());
    assert_eq!(call.candidate_identity(), None);
    // Past the candidate's generation (2) as well as the line's (1).
    assert_eq!(call.generation(), 3);
    assert_eq!(
        *notices.lock().unwrap(),
        vec![CandidateNotice {
            route: "beta".into(),
            generation: 3,
            ended: Some(CandidateEnd::Rescued),
        }]
    );
    assert_eq!(
        call.adopt_candidate("beta-leg"),
        Err(LifecycleError::NoCandidate)
    );
    assert!(!call.rollback_startup(startup.generation, "startup failed"));
    assert_eq!(phase(&call), "shutdown");

    // A candidate adopted, its intro not finished: nothing to roll back to.
    let call = coordinator();
    on_alpha(&call);
    let startup = call.begin_candidate(beta_candidate()).unwrap();
    call.adopt_candidate("beta-leg").unwrap();
    assert!(call.begin_shutdown());
    assert!(!call.startup_in_flight());
    assert!(!call.rollback_startup(startup.generation, "intro failed"));
    assert!(!call.finish_intro());
    assert_eq!(phase(&call), "shutdown");
    assert_eq!(
        call.begin_prompt(&call.current_identity()),
        Err(LifecycleError::Shutdown)
    );
}

/// Every candidate notice is sent under the state lock, so the browser hears
/// of a candidate's end before anything a later transition announces. A
/// rescue's clear used to be sent after the lock was released: a `/connect`
/// right behind a hangup could stage its candidate and announce it in that
/// gap, and the browser then took the late clear (same route) as the end of
/// the new candidate.
#[test]
fn every_candidate_notice_is_sent_under_the_state_lock() {
    let mut call = coordinator();
    let shared = Arc::clone(&call.state);
    let sent = Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = Arc::clone(&sent);
    call.set_candidate_callback(Arc::new(move |notice| {
        let locked = shared.try_lock().is_err();
        recorded.lock().unwrap().push((notice.ended, locked));
    }));
    call.begin_candidate(alpha_candidate()).unwrap();
    call.adopt_candidate("cand").unwrap();
    let startup = call.begin_candidate(beta_candidate()).unwrap();
    assert!(call.rollback_startup(startup.generation, "startup failed"));
    call.begin_candidate(beta_candidate()).unwrap();
    call.begin_rescue("hangup");
    assert_eq!(
        *sent.lock().unwrap(),
        vec![
            (None, true),
            (Some(CandidateEnd::Adopted), true),
            (None, true),
            (Some(CandidateEnd::RolledBack), true),
            (None, true),
            (Some(CandidateEnd::Rescued), true),
        ]
    );
}

/// A rollback restores the leg the adoption replaced as it was when it was
/// replaced. It used to restore it as it was when the candidate was staged,
/// so what changed on the line while the candidate started came undone: the
/// level the leg confirmed in that window, or the caller's return to the
/// operator, after which the rollback put the project they had left back on
/// the line.
#[test]
fn a_rollback_restores_the_leg_as_the_adoption_found_it() {
    let call = coordinator();
    on_alpha(&call);
    let startup = call.begin_candidate(beta_candidate()).unwrap();
    assert_eq!(call.accept_thinking_callback("cand", "high"), Ok(true));
    call.adopt_candidate("beta-leg").unwrap();
    assert!(call.rollback_startup(startup.generation, "intro failed"));
    let status = call.status();
    assert_eq!(
        (
            status.route.as_str(),
            status.thinking.as_str(),
            status.thinking_confirmed
        ),
        ("alpha", "high", true)
    );

    let call = coordinator();
    on_alpha(&call);
    let startup = call.begin_candidate(beta_candidate()).unwrap();
    call.return_to_operator();
    call.adopt_candidate("beta-leg").unwrap();
    assert!(call.rollback_startup(startup.generation, "intro failed"));
    assert_on_the_operator(&call);
    assert_eq!(call.current_identity(), LegIdentity::new("operator", 2));
}

/// A queued caller turn waits on `operation_changed` while a candidate is
/// staged or a turn is open (`admit_turn`), and is let through only when it
/// is woken. A rollback ends the startup and closes the intro's turn, and a
/// shutdown closes any turn, but neither woke the waiters: the queued turn
/// slept until some unrelated transition happened to wake it.
#[test]
fn a_turn_waiting_on_the_line_is_woken_when_a_startup_or_the_call_ends() {
    let woken = |call: &Coordinator, transition: &dyn Fn(&Coordinator)| {
        let notify = call.operation_changed();
        let mut waiting = std::pin::pin!(notify.notified());
        waiting.as_mut().enable();
        transition(call);
        waiting.now_or_never().is_some()
    };
    // Behind a staged candidate.
    let call = coordinator();
    let startup = call.begin_candidate(alpha_candidate()).unwrap();
    assert!(woken(&call, &|call| assert!(
        call.rollback_startup(startup.generation, "startup failed")
    )));
    // Behind an adopted candidate's intro.
    let call = coordinator();
    let startup = call.begin_candidate(alpha_candidate()).unwrap();
    call.adopt_candidate("cand").unwrap();
    assert!(woken(&call, &|call| assert!(
        call.rollback_startup(startup.generation, "intro failed")
    )));
    // Behind a turn, when the call shuts down.
    let call = coordinator();
    call.begin_prompt(&call.current_identity()).unwrap();
    assert!(woken(&call, &|call| assert!(call.begin_shutdown())));
}

/// The phase a call comes to rest in follows from the leg on the line and
/// the turn open on it. Two exits set it by hand and got it wrong:
///
/// - A transfer that failed before adoption left the caller's turn that ran
///   it open but put the call at rest, so on the operator that turn refused
///   a steer (`WrongPhase`) that it took on a project.
/// - An intro that finished after the caller was returned to the operator
///   put the call in `Active` on the operator, where a self-woken turn could
///   open an operation on the operator's leg.
#[test]
fn the_phase_at_rest_follows_from_the_line_and_its_turn() {
    let call = coordinator();
    let caller = call.begin_prompt(&call.current_identity()).unwrap();
    let startup = call.begin_candidate(alpha_candidate()).unwrap();
    assert!(call.rollback_startup(startup.generation, "startup failed"));
    assert_eq!(phase(&call), "turn running");
    assert_eq!(
        call.attach_steer(&call.current_identity()),
        Ok(caller.clone())
    );
    assert!(call.finish_operation(&caller));
    assert_eq!(phase(&call), "operator");

    let call = coordinator();
    call.begin_candidate(alpha_candidate()).unwrap();
    call.adopt_candidate("cand").unwrap();
    call.return_to_operator();
    assert!(call.finish_intro());
    assert_eq!(phase(&call), "operator");
    assert_eq!(
        call.begin_autonomous(&call.current_identity(), "turn-1"),
        Err(LifecycleError::WrongPhase)
    );
}

// The call line, phase by event. Each phase is reached the way a call reaches
// it, from a fresh coordinator, and is then given one event. A row reads:
//
//   phase | event => what the event returned | the line after it
//
// where the line is the phase, the route and the leg's token@generation, the
// turn open on it (`-`, the phase's own `turn`, or a `new turn`), `startup`
// while a candidate is staged or adopted and not yet committed, the route a
// reconnecting page is told was adopted, the status's thinking (`*` once the
// leg confirmed it), and the candidate notices the event sent.

type Notices = Arc<std::sync::Mutex<Vec<CandidateNotice>>>;

fn beta_candidate() -> CandidateLeg {
    CandidateLeg::new(
        "beta",
        "beta",
        "beta-session",
        "beta-leg",
        "anthropic/sonnet",
        "low",
    )
}

/// A phase of the call line: the coordinator in it, its notices, and the
/// turn open in it, if any.
struct TablePhase {
    call: Coordinator,
    notices: Notices,
    turn: Option<OperationIdentity>,
}

const TABLE_PHASES: [&str; 12] = [
    "operator",
    "operator turn",
    "project",
    "project turn",
    "self-woken turn",
    "starting",
    "starting in a turn",
    "adopted",
    "adopted at rest",
    "quiescing",
    "shutdown",
    "shutdown starting",
];

fn table_phase(name: &str) -> TablePhase {
    let (call, notices) = coordinator_with_notices();
    let on_alpha = |call: &Coordinator| on_alpha(call);
    let prompt = |call: &Coordinator| Some(call.begin_prompt(&call.current_identity()).unwrap());
    let turn = match name {
        "operator" => None,
        "operator turn" => prompt(&call),
        "project" => {
            on_alpha(&call);
            None
        }
        "project turn" => {
            on_alpha(&call);
            prompt(&call)
        }
        "self-woken turn" => {
            on_alpha(&call);
            Some(
                call.begin_autonomous(&call.current_identity(), "turn-a")
                    .unwrap(),
            )
        }
        "starting" => {
            on_alpha(&call);
            call.begin_candidate(beta_candidate()).unwrap();
            None
        }
        "starting in a turn" | "adopted" | "adopted at rest" => {
            let turn = prompt(&call);
            call.begin_candidate(alpha_candidate().with_catalog(alpha_catalog()))
                .unwrap();
            if name == "starting in a turn" {
                turn
            } else {
                call.adopt_candidate("cand").unwrap();
                let intro = open_turn(&call);
                if name == "adopted at rest" {
                    assert!(call.finish_operation(intro.as_ref().unwrap()));
                    None
                } else {
                    intro
                }
            }
        }
        "quiescing" => {
            on_alpha(&call);
            call.begin_rescue("page rescue");
            None
        }
        "shutdown" => {
            on_alpha(&call);
            call.begin_shutdown();
            None
        }
        "shutdown starting" => {
            on_alpha(&call);
            call.begin_candidate(beta_candidate()).unwrap();
            call.begin_shutdown();
            None
        }
        other => panic!("no phase {other}"),
    };
    notices.lock().unwrap().clear();
    TablePhase {
        call,
        notices,
        turn,
    }
}

type TableEvent = fn(&TablePhase) -> String;

fn shown<T>(result: Result<T, LifecycleError>, ok: impl FnOnce(T) -> String) -> String {
    match result {
        Ok(value) => ok(value),
        Err(error) => format!("{error:?}"),
    }
}

fn turn_shown(phase: &TablePhase, turn: &OperationIdentity) -> String {
    if phase.turn.as_ref().is_some_and(|own| own.id == turn.id) {
        "turn".into()
    } else {
        "new turn".into()
    }
}

/// The token the candidate staged in the phase was started with, if any.
fn candidate_token(phase: &TablePhase) -> String {
    phase
        .call
        .candidate_identity()
        .map_or_else(|| "nobody".into(), |identity| identity.token)
}

const TABLE_EVENTS: [(&str, TableEvent); 21] = [
    ("begin_prompt", |phase| {
        let call = &phase.call;
        shown(call.begin_prompt(&call.current_identity()), |turn| {
            turn_shown(phase, &turn)
        })
    }),
    ("begin_autonomous", |phase| {
        let call = &phase.call;
        shown(
            call.begin_autonomous(&call.current_identity(), "turn-b"),
            |turn| turn_shown(phase, &turn),
        )
    }),
    ("bind_turn", |phase| {
        let call = &phase.call;
        shown(
            call.bind_turn(&call.current_identity().token, "turn-x"),
            |()| "bound".into(),
        )
    }),
    ("settle_turn", |phase| {
        let call = &phase.call;
        call.settle_turn(&call.current_identity().token, "turn-a")
            .to_string()
    }),
    ("finish_operation", |phase| {
        let stray = OperationIdentity {
            id: 0,
            leg: phase.call.current_identity(),
            turn_id: None,
        };
        phase
            .call
            .finish_operation(phase.turn.as_ref().unwrap_or(&stray))
            .to_string()
    }),
    ("attach_steer", |phase| {
        let call = &phase.call;
        shown(call.attach_steer(&call.current_identity()), |turn| {
            turn_shown(phase, &turn)
        })
    }),
    ("begin_rescue", |phase| {
        let rescued = phase.call.begin_rescue("rescue");
        let leg = rescued.identity();
        format!("{}@{}", leg.token, leg.generation)
    }),
    ("begin_rescue_of", |phase| {
        let call = &phase.call;
        let leg = call.project_leg().unwrap_or(ProjectLeg {
            project: "alpha".into(),
            identity: call.current_identity(),
            model: "anthropic/opus".into(),
            persistent_session_id: "pi-session".into(),
        });
        call.begin_rescue_of(&leg, "redial").map_or_else(
            || "None".into(),
            |(leg, _)| format!("{}@{}", leg.identity.token, leg.identity.generation),
        )
    }),
    // A settle at the generation the call is at: the rescue that left it
    // there, or a reply delivered at it.
    ("settle", |phase| {
        let call = &phase.call;
        call.settle_at(call.generation());
        call.status().route
    }),
    // A settle that names another rescue's generation ends nothing.
    ("settle another rescue", |phase| {
        let call = &phase.call;
        call.settle_at(call.generation() + 1).to_string()
    }),
    ("return_to_operator", |phase| {
        phase.call.return_to_operator();
        "()".into()
    }),
    ("begin_candidate", |phase| {
        let candidate = CandidateLeg::new(
            "gamma",
            "gamma",
            "gamma-session",
            "gamma-leg",
            "anthropic/haiku",
            "medium",
        );
        shown(phase.call.begin_candidate(candidate), |leg| {
            format!("{}@{}", leg.token, leg.generation)
        })
    }),
    ("thinking from the line", |phase| {
        let call = &phase.call;
        shown(
            call.accept_thinking_callback(&call.current_identity().token, "high"),
            |line| line.to_string(),
        )
    }),
    ("thinking from the candidate", |phase| {
        shown(
            phase
                .call
                .accept_thinking_callback(&candidate_token(phase), "high"),
            |line| line.to_string(),
        )
    }),
    ("adopt_candidate", |phase| {
        shown(phase.call.adopt_candidate(&candidate_token(phase)), |leg| {
            format!("{}@{}", leg.token, leg.generation)
        })
    }),
    ("finish_intro", |phase| {
        phase.call.finish_intro().to_string()
    }),
    ("rollback_startup", |phase| {
        // The startup in flight: the staged candidate, or the adopted leg.
        let call = &phase.call;
        let startup = call
            .candidate_identity()
            .unwrap_or_else(|| call.current_identity());
        call.rollback_startup(startup.generation, "failed")
            .to_string()
    }),
    ("begin_shutdown", |phase| {
        phase.call.begin_shutdown().to_string()
    }),
    ("accept_side_effect", |phase| {
        let call = &phase.call;
        shown(
            call.accept_side_effect(&call.current_identity().token, None, None),
            |()| "accepted".into(),
        )
    }),
    ("activity from the line", |phase| {
        let call = &phase.call;
        let leg = if call.route() == "operator" {
            "operator".to_owned()
        } else {
            call.current_identity().token
        };
        format!("{:?}", call.classify_activity(&leg))
    }),
    ("activity from the candidate", |phase| {
        format!(
            "{:?}",
            phase.call.classify_activity(&candidate_token(phase))
        )
    }),
];

/// The line after an event: see the comment above `TablePhase`.
fn line_shown(cell: &TablePhase) -> String {
    let call = &cell.call;
    let leg = call.current_identity();
    let turn = match open_turn(call) {
        None => "-".to_owned(),
        Some(turn) => turn_shown(cell, &turn),
    };
    let startup = if call.startup_in_flight() {
        " startup"
    } else {
        ""
    };
    let adopted = call
        .generation_and_adoption()
        .1
        .map(|route| format!(" adopted:{route}"))
        .unwrap_or_default();
    let status = call.status();
    let confirmed = if status.thinking_confirmed { "*" } else { "" };
    let notices: Vec<String> = cell
        .notices
        .lock()
        .unwrap()
        .iter()
        .map(|notice| {
            let ended = notice
                .ended
                .map_or_else(|| "staged".to_owned(), |ended| format!("{ended:?}"));
            format!("{}@{} {ended}", notice.route, notice.generation)
        })
        .collect();
    format!(
        "{} {} {}@{} {turn}{startup}{adopted} thinking:{}{confirmed} [{}]",
        phase(call),
        call.route(),
        leg.token,
        leg.generation,
        status.thinking,
        notices.join(", ")
    )
}

#[test]
fn the_call_line_phase_by_event() {
    let mut rows = Vec::new();
    for name in TABLE_PHASES {
        for (event, run) in TABLE_EVENTS {
            let phase = table_phase(name);
            let returned = run(&phase);
            rows.push(format!(
                "{name} | {event} => {returned} | {}",
                line_shown(&phase)
            ));
        }
    }
    let expected: Vec<&str> = CALL_LINE_TABLE.trim().lines().map(str::trim).collect();
    if rows != expected {
        eprintln!("{}", rows.join("\n"));
    }
    assert_eq!(rows, expected);
}

const CALL_LINE_TABLE: &str = "
operator | begin_prompt => new turn | turn running operator operator@0 new turn thinking: []
operator | begin_autonomous => WrongPhase | operator operator operator@0 - thinking: []
operator | bind_turn => StaleLeg | operator operator operator@0 - thinking: []
operator | settle_turn => false | operator operator operator@0 - thinking: []
operator | finish_operation => false | operator operator operator@0 - thinking: []
operator | attach_steer => NoActiveOperation | operator operator operator@0 - thinking: []
operator | begin_rescue => operator-rescue-1@1 | quiescing operator operator-rescue-1@1 - thinking: []
operator | begin_rescue_of => None | operator operator operator@0 - thinking: []
operator | settle => operator | operator operator operator@0 - thinking: []
operator | settle another rescue => false | operator operator operator@0 - thinking: []
operator | return_to_operator => () | operator operator operator@0 - thinking: []
operator | begin_candidate => gamma-leg@1 | starting operator operator@0 - startup thinking: [gamma@0 staged]
operator | thinking from the line => true | operator operator operator@0 - thinking:high* []
operator | thinking from the candidate => StaleLeg | operator operator operator@0 - thinking: []
operator | adopt_candidate => NoCandidate | operator operator operator@0 - thinking: []
operator | finish_intro => false | operator operator operator@0 - thinking: []
operator | rollback_startup => false | operator operator operator@0 - thinking: []
operator | begin_shutdown => true | shutdown operator operator-shutdown-1@1 - thinking: []
operator | accept_side_effect => accepted | operator operator operator@0 - thinking: []
operator | activity from the line => Publish | operator operator operator@0 - thinking: []
operator | activity from the candidate => Discard | operator operator operator@0 - thinking: []
operator turn | begin_prompt => OperationActive | turn running operator operator@0 turn thinking: []
operator turn | begin_autonomous => WrongPhase | turn running operator operator@0 turn thinking: []
operator turn | bind_turn => bound | turn running operator operator@0 turn thinking: []
operator turn | settle_turn => false | turn running operator operator@0 turn thinking: []
operator turn | finish_operation => true | operator operator operator@0 - thinking: []
operator turn | attach_steer => turn | turn running operator operator@0 turn thinking: []
operator turn | begin_rescue => operator-rescue-1@1 | quiescing operator operator-rescue-1@1 - thinking: []
operator turn | begin_rescue_of => None | turn running operator operator@0 turn thinking: []
operator turn | settle => operator | turn running operator operator@0 turn thinking: []
operator turn | settle another rescue => false | turn running operator operator@0 turn thinking: []
operator turn | return_to_operator => () | turn running operator operator@0 turn thinking: []
operator turn | begin_candidate => gamma-leg@1 | starting operator operator@0 turn startup thinking: [gamma@0 staged]
operator turn | thinking from the line => true | turn running operator operator@0 turn thinking:high* []
operator turn | thinking from the candidate => StaleLeg | turn running operator operator@0 turn thinking: []
operator turn | adopt_candidate => NoCandidate | turn running operator operator@0 turn thinking: []
operator turn | finish_intro => false | turn running operator operator@0 turn thinking: []
operator turn | rollback_startup => false | turn running operator operator@0 turn thinking: []
operator turn | begin_shutdown => true | shutdown operator operator-shutdown-1@1 - thinking: []
operator turn | accept_side_effect => accepted | turn running operator operator@0 turn thinking: []
operator turn | activity from the line => Publish | turn running operator operator@0 turn thinking: []
operator turn | activity from the candidate => Discard | turn running operator operator@0 turn thinking: []
project | begin_prompt => new turn | turn running alpha cand@1 new turn adopted:alpha thinking:medium []
project | begin_autonomous => new turn | turn running alpha cand@1 new turn adopted:alpha thinking:medium []
project | bind_turn => StaleLeg | active alpha cand@1 - adopted:alpha thinking:medium []
project | settle_turn => false | active alpha cand@1 - adopted:alpha thinking:medium []
project | finish_operation => false | active alpha cand@1 - adopted:alpha thinking:medium []
project | attach_steer => NoActiveOperation | active alpha cand@1 - adopted:alpha thinking:medium []
project | begin_rescue => cand-rescue-2@2 | quiescing alpha cand-rescue-2@2 - thinking:medium []
project | begin_rescue_of => cand-rescue-2@2 | quiescing alpha cand-rescue-2@2 - thinking:medium []
project | settle => alpha | active alpha cand@1 - adopted:alpha thinking:medium []
project | settle another rescue => false | active alpha cand@1 - adopted:alpha thinking:medium []
project | return_to_operator => () | operator operator operator@1 - thinking: []
project | begin_candidate => gamma-leg@2 | starting alpha cand@1 - startup adopted:alpha thinking:medium [gamma@1 staged]
project | thinking from the line => true | active alpha cand@1 - adopted:alpha thinking:high* []
project | thinking from the candidate => StaleLeg | active alpha cand@1 - adopted:alpha thinking:medium []
project | adopt_candidate => NoCandidate | active alpha cand@1 - adopted:alpha thinking:medium []
project | finish_intro => false | active alpha cand@1 - adopted:alpha thinking:medium []
project | rollback_startup => false | active alpha cand@1 - adopted:alpha thinking:medium []
project | begin_shutdown => true | shutdown alpha cand-shutdown-2@2 - thinking:medium []
project | accept_side_effect => StaleLeg | active alpha cand@1 - adopted:alpha thinking:medium []
project | activity from the line => Publish | active alpha cand@1 - adopted:alpha thinking:medium []
project | activity from the candidate => Discard | active alpha cand@1 - adopted:alpha thinking:medium []
project turn | begin_prompt => OperationActive | turn running alpha cand@1 turn adopted:alpha thinking:medium []
project turn | begin_autonomous => WrongPhase | turn running alpha cand@1 turn adopted:alpha thinking:medium []
project turn | bind_turn => bound | turn running alpha cand@1 turn adopted:alpha thinking:medium []
project turn | settle_turn => false | turn running alpha cand@1 turn adopted:alpha thinking:medium []
project turn | finish_operation => true | active alpha cand@1 - adopted:alpha thinking:medium []
project turn | attach_steer => turn | turn running alpha cand@1 turn adopted:alpha thinking:medium []
project turn | begin_rescue => cand-rescue-2@2 | quiescing alpha cand-rescue-2@2 - thinking:medium []
project turn | begin_rescue_of => cand-rescue-2@2 | quiescing alpha cand-rescue-2@2 - thinking:medium []
project turn | settle => alpha | turn running alpha cand@1 turn adopted:alpha thinking:medium []
project turn | settle another rescue => false | turn running alpha cand@1 turn adopted:alpha thinking:medium []
project turn | return_to_operator => () | turn running operator operator@1 turn thinking: []
project turn | begin_candidate => gamma-leg@2 | starting alpha cand@1 turn startup adopted:alpha thinking:medium [gamma@1 staged]
project turn | thinking from the line => true | turn running alpha cand@1 turn adopted:alpha thinking:high* []
project turn | thinking from the candidate => StaleLeg | turn running alpha cand@1 turn adopted:alpha thinking:medium []
project turn | adopt_candidate => NoCandidate | turn running alpha cand@1 turn adopted:alpha thinking:medium []
project turn | finish_intro => false | turn running alpha cand@1 turn adopted:alpha thinking:medium []
project turn | rollback_startup => false | turn running alpha cand@1 turn adopted:alpha thinking:medium []
project turn | begin_shutdown => true | shutdown alpha cand-shutdown-2@2 - thinking:medium []
project turn | accept_side_effect => accepted | turn running alpha cand@1 turn adopted:alpha thinking:medium []
project turn | activity from the line => Publish | turn running alpha cand@1 turn adopted:alpha thinking:medium []
project turn | activity from the candidate => Discard | turn running alpha cand@1 turn adopted:alpha thinking:medium []
self-woken turn | begin_prompt => OperationActive | turn running alpha cand@1 turn adopted:alpha thinking:medium []
self-woken turn | begin_autonomous => WrongPhase | turn running alpha cand@1 turn adopted:alpha thinking:medium []
self-woken turn | bind_turn => StaleLeg | turn running alpha cand@1 turn adopted:alpha thinking:medium []
self-woken turn | settle_turn => true | active alpha cand@1 - adopted:alpha thinking:medium []
self-woken turn | finish_operation => true | active alpha cand@1 - adopted:alpha thinking:medium []
self-woken turn | attach_steer => turn | turn running alpha cand@1 turn adopted:alpha thinking:medium []
self-woken turn | begin_rescue => cand-rescue-2@2 | quiescing alpha cand-rescue-2@2 - thinking:medium []
self-woken turn | begin_rescue_of => cand-rescue-2@2 | quiescing alpha cand-rescue-2@2 - thinking:medium []
self-woken turn | settle => alpha | turn running alpha cand@1 turn adopted:alpha thinking:medium []
self-woken turn | settle another rescue => false | turn running alpha cand@1 turn adopted:alpha thinking:medium []
self-woken turn | return_to_operator => () | turn running operator operator@1 turn thinking: []
self-woken turn | begin_candidate => gamma-leg@2 | starting alpha cand@1 turn startup adopted:alpha thinking:medium [gamma@1 staged]
self-woken turn | thinking from the line => true | turn running alpha cand@1 turn adopted:alpha thinking:high* []
self-woken turn | thinking from the candidate => StaleLeg | turn running alpha cand@1 turn adopted:alpha thinking:medium []
self-woken turn | adopt_candidate => NoCandidate | turn running alpha cand@1 turn adopted:alpha thinking:medium []
self-woken turn | finish_intro => false | turn running alpha cand@1 turn adopted:alpha thinking:medium []
self-woken turn | rollback_startup => false | turn running alpha cand@1 turn adopted:alpha thinking:medium []
self-woken turn | begin_shutdown => true | shutdown alpha cand-shutdown-2@2 - thinking:medium []
self-woken turn | accept_side_effect => StaleLeg | turn running alpha cand@1 turn adopted:alpha thinking:medium []
self-woken turn | activity from the line => Publish | turn running alpha cand@1 turn adopted:alpha thinking:medium []
self-woken turn | activity from the candidate => Discard | turn running alpha cand@1 turn adopted:alpha thinking:medium []
starting | begin_prompt => CandidateActive | starting alpha cand@1 - startup adopted:alpha thinking:medium []
starting | begin_autonomous => CandidateActive | starting alpha cand@1 - startup adopted:alpha thinking:medium []
starting | bind_turn => StaleLeg | starting alpha cand@1 - startup adopted:alpha thinking:medium []
starting | settle_turn => false | starting alpha cand@1 - startup adopted:alpha thinking:medium []
starting | finish_operation => false | starting alpha cand@1 - startup adopted:alpha thinking:medium []
starting | attach_steer => WrongPhase | starting alpha cand@1 - startup adopted:alpha thinking:medium []
starting | begin_rescue => cand-rescue-3@3 | quiescing alpha cand-rescue-3@3 - thinking:medium [beta@3 Rescued]
starting | begin_rescue_of => None | starting alpha cand@1 - startup adopted:alpha thinking:medium []
starting | settle => alpha | starting alpha cand@1 - startup adopted:alpha thinking:medium []
starting | settle another rescue => false | starting alpha cand@1 - startup adopted:alpha thinking:medium []
starting | return_to_operator => () | starting operator operator@1 - startup thinking: []
starting | begin_candidate => CandidateActive | starting alpha cand@1 - startup adopted:alpha thinking:medium []
starting | thinking from the line => true | starting alpha cand@1 - startup adopted:alpha thinking:high* []
starting | thinking from the candidate => false | starting alpha cand@1 - startup adopted:alpha thinking:medium []
starting | adopt_candidate => beta-leg@2 | turn running beta beta-leg@2 new turn startup adopted:beta thinking:low [beta@2 Adopted]
starting | finish_intro => false | starting alpha cand@1 - startup adopted:alpha thinking:medium []
starting | rollback_startup => true | active alpha cand@1 - adopted:alpha thinking:medium [beta@1 RolledBack]
starting | begin_shutdown => true | shutdown alpha cand-shutdown-3@3 - thinking:medium [beta@3 Rescued]
starting | accept_side_effect => CandidateSideEffect | starting alpha cand@1 - startup adopted:alpha thinking:medium []
starting | activity from the line => Publish | starting alpha cand@1 - startup adopted:alpha thinking:medium []
starting | activity from the candidate => Promote | starting alpha cand@1 - startup adopted:alpha thinking:medium []
starting in a turn | begin_prompt => OperationActive | starting operator operator@0 turn startup thinking: []
starting in a turn | begin_autonomous => CandidateActive | starting operator operator@0 turn startup thinking: []
starting in a turn | bind_turn => bound | starting operator operator@0 turn startup thinking: []
starting in a turn | settle_turn => false | starting operator operator@0 turn startup thinking: []
starting in a turn | finish_operation => true | starting operator operator@0 - startup thinking: []
starting in a turn | attach_steer => WrongPhase | starting operator operator@0 turn startup thinking: []
starting in a turn | begin_rescue => operator-rescue-2@2 | quiescing operator operator-rescue-2@2 - thinking: [alpha@2 Rescued]
starting in a turn | begin_rescue_of => None | starting operator operator@0 turn startup thinking: []
starting in a turn | settle => operator | starting operator operator@0 turn startup thinking: []
starting in a turn | settle another rescue => false | starting operator operator@0 turn startup thinking: []
starting in a turn | return_to_operator => () | starting operator operator@0 turn startup thinking: []
starting in a turn | begin_candidate => CandidateActive | starting operator operator@0 turn startup thinking: []
starting in a turn | thinking from the line => true | starting operator operator@0 turn startup thinking:high* []
starting in a turn | thinking from the candidate => false | starting operator operator@0 turn startup thinking: []
starting in a turn | adopt_candidate => cand@1 | turn running alpha cand@1 new turn startup adopted:alpha thinking:medium [alpha@1 Adopted]
starting in a turn | finish_intro => false | starting operator operator@0 turn startup thinking: []
starting in a turn | rollback_startup => true | turn running operator operator@0 turn thinking: [alpha@0 RolledBack]
starting in a turn | begin_shutdown => true | shutdown operator operator-shutdown-2@2 - thinking: [alpha@2 Rescued]
starting in a turn | accept_side_effect => CandidateSideEffect | starting operator operator@0 turn startup thinking: []
starting in a turn | activity from the line => Publish | starting operator operator@0 turn startup thinking: []
starting in a turn | activity from the candidate => Promote | starting operator operator@0 turn startup thinking: []
adopted | begin_prompt => OperationActive | turn running alpha cand@1 turn startup adopted:alpha thinking:medium []
adopted | begin_autonomous => WrongPhase | turn running alpha cand@1 turn startup adopted:alpha thinking:medium []
adopted | bind_turn => bound | turn running alpha cand@1 turn startup adopted:alpha thinking:medium []
adopted | settle_turn => false | turn running alpha cand@1 turn startup adopted:alpha thinking:medium []
adopted | finish_operation => true | active alpha cand@1 - startup adopted:alpha thinking:medium []
adopted | attach_steer => turn | turn running alpha cand@1 turn startup adopted:alpha thinking:medium []
adopted | begin_rescue => cand-rescue-2@2 | quiescing alpha cand-rescue-2@2 - thinking:medium []
adopted | begin_rescue_of => None | turn running alpha cand@1 turn startup adopted:alpha thinking:medium []
adopted | settle => alpha | turn running alpha cand@1 turn startup adopted:alpha thinking:medium []
adopted | settle another rescue => false | turn running alpha cand@1 turn startup adopted:alpha thinking:medium []
adopted | return_to_operator => () | turn running operator operator@1 turn startup thinking: []
adopted | begin_candidate => gamma-leg@2 | starting alpha cand@1 turn startup adopted:alpha thinking:medium [gamma@1 staged]
adopted | thinking from the line => true | turn running alpha cand@1 turn startup adopted:alpha thinking:high* []
adopted | thinking from the candidate => StaleLeg | turn running alpha cand@1 turn startup adopted:alpha thinking:medium []
adopted | adopt_candidate => NoCandidate | turn running alpha cand@1 turn startup adopted:alpha thinking:medium []
adopted | finish_intro => true | active alpha cand@1 - adopted:alpha thinking:medium []
adopted | rollback_startup => true | operator operator operator@1 - thinking: [alpha@1 RolledBack]
adopted | begin_shutdown => true | shutdown alpha cand-shutdown-2@2 - thinking:medium []
adopted | accept_side_effect => accepted | turn running alpha cand@1 turn startup adopted:alpha thinking:medium []
adopted | activity from the line => Publish | turn running alpha cand@1 turn startup adopted:alpha thinking:medium []
adopted | activity from the candidate => Discard | turn running alpha cand@1 turn startup adopted:alpha thinking:medium []
adopted at rest | begin_prompt => new turn | turn running alpha cand@1 new turn startup adopted:alpha thinking:medium []
adopted at rest | begin_autonomous => new turn | turn running alpha cand@1 new turn startup adopted:alpha thinking:medium []
adopted at rest | bind_turn => StaleLeg | active alpha cand@1 - startup adopted:alpha thinking:medium []
adopted at rest | settle_turn => false | active alpha cand@1 - startup adopted:alpha thinking:medium []
adopted at rest | finish_operation => false | active alpha cand@1 - startup adopted:alpha thinking:medium []
adopted at rest | attach_steer => NoActiveOperation | active alpha cand@1 - startup adopted:alpha thinking:medium []
adopted at rest | begin_rescue => cand-rescue-2@2 | quiescing alpha cand-rescue-2@2 - thinking:medium []
adopted at rest | begin_rescue_of => None | active alpha cand@1 - startup adopted:alpha thinking:medium []
adopted at rest | settle => alpha | active alpha cand@1 - startup adopted:alpha thinking:medium []
adopted at rest | settle another rescue => false | active alpha cand@1 - startup adopted:alpha thinking:medium []
adopted at rest | return_to_operator => () | operator operator operator@1 - startup thinking: []
adopted at rest | begin_candidate => gamma-leg@2 | starting alpha cand@1 - startup adopted:alpha thinking:medium [gamma@1 staged]
adopted at rest | thinking from the line => true | active alpha cand@1 - startup adopted:alpha thinking:high* []
adopted at rest | thinking from the candidate => StaleLeg | active alpha cand@1 - startup adopted:alpha thinking:medium []
adopted at rest | adopt_candidate => NoCandidate | active alpha cand@1 - startup adopted:alpha thinking:medium []
adopted at rest | finish_intro => false | active alpha cand@1 - startup adopted:alpha thinking:medium []
adopted at rest | rollback_startup => true | operator operator operator@1 - thinking: [alpha@1 RolledBack]
adopted at rest | begin_shutdown => true | shutdown alpha cand-shutdown-2@2 - thinking:medium []
adopted at rest | accept_side_effect => StaleLeg | active alpha cand@1 - startup adopted:alpha thinking:medium []
adopted at rest | activity from the line => Publish | active alpha cand@1 - startup adopted:alpha thinking:medium []
adopted at rest | activity from the candidate => Discard | active alpha cand@1 - startup adopted:alpha thinking:medium []
quiescing | begin_prompt => WrongPhase | quiescing alpha cand-rescue-2@2 - thinking:medium []
quiescing | begin_autonomous => WrongPhase | quiescing alpha cand-rescue-2@2 - thinking:medium []
quiescing | bind_turn => StaleLeg | quiescing alpha cand-rescue-2@2 - thinking:medium []
quiescing | settle_turn => false | quiescing alpha cand-rescue-2@2 - thinking:medium []
quiescing | finish_operation => false | quiescing alpha cand-rescue-2@2 - thinking:medium []
quiescing | attach_steer => WrongPhase | quiescing alpha cand-rescue-2@2 - thinking:medium []
quiescing | begin_rescue => cand-rescue-2-rescue-3@3 | quiescing alpha cand-rescue-2-rescue-3@3 - thinking:medium []
quiescing | begin_rescue_of => cand-rescue-2-rescue-3@3 | quiescing alpha cand-rescue-2-rescue-3@3 - thinking:medium []
quiescing | settle => alpha | active alpha cand-rescue-2@2 - thinking:medium []
quiescing | settle another rescue => false | quiescing alpha cand-rescue-2@2 - thinking:medium []
quiescing | return_to_operator => () | operator operator operator@2 - thinking: []
quiescing | begin_candidate => gamma-leg@3 | starting alpha cand-rescue-2@2 - startup thinking:medium [gamma@2 staged]
quiescing | thinking from the line => StaleLeg | quiescing alpha cand-rescue-2@2 - thinking:medium []
quiescing | thinking from the candidate => StaleLeg | quiescing alpha cand-rescue-2@2 - thinking:medium []
quiescing | adopt_candidate => NoCandidate | quiescing alpha cand-rescue-2@2 - thinking:medium []
quiescing | finish_intro => false | quiescing alpha cand-rescue-2@2 - thinking:medium []
quiescing | rollback_startup => false | quiescing alpha cand-rescue-2@2 - thinking:medium []
quiescing | begin_shutdown => true | shutdown alpha cand-rescue-2-shutdown-3@3 - thinking:medium []
quiescing | accept_side_effect => StaleLeg | quiescing alpha cand-rescue-2@2 - thinking:medium []
quiescing | activity from the line => Discard | quiescing alpha cand-rescue-2@2 - thinking:medium []
quiescing | activity from the candidate => Discard | quiescing alpha cand-rescue-2@2 - thinking:medium []
shutdown | begin_prompt => Shutdown | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | begin_autonomous => WrongPhase | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | bind_turn => StaleLeg | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | settle_turn => false | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | finish_operation => false | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | attach_steer => WrongPhase | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | begin_rescue => cand-shutdown-2-rescue-3@3 | shutdown alpha cand-shutdown-2-rescue-3@3 - thinking:medium []
shutdown | begin_rescue_of => None | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | settle => alpha | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | settle another rescue => false | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | return_to_operator => () | shutdown operator operator@2 - thinking: []
shutdown | begin_candidate => Shutdown | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | thinking from the line => StaleLeg | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | thinking from the candidate => StaleLeg | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | adopt_candidate => NoCandidate | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | finish_intro => false | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | rollback_startup => false | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | begin_shutdown => false | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | accept_side_effect => StaleLeg | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | activity from the line => Discard | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown | activity from the candidate => Discard | shutdown alpha cand-shutdown-2@2 - thinking:medium []
shutdown starting | begin_prompt => Shutdown | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | begin_autonomous => WrongPhase | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | bind_turn => StaleLeg | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | settle_turn => false | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | finish_operation => false | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | attach_steer => WrongPhase | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | begin_rescue => cand-shutdown-3-rescue-4@4 | shutdown alpha cand-shutdown-3-rescue-4@4 - thinking:medium []
shutdown starting | begin_rescue_of => None | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | settle => alpha | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | settle another rescue => false | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | return_to_operator => () | shutdown operator operator@3 - thinking: []
shutdown starting | begin_candidate => Shutdown | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | thinking from the line => StaleLeg | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | thinking from the candidate => StaleLeg | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | adopt_candidate => NoCandidate | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | finish_intro => false | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | rollback_startup => false | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | begin_shutdown => false | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | accept_side_effect => StaleLeg | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | activity from the line => Discard | shutdown alpha cand-shutdown-3@3 - thinking:medium []
shutdown starting | activity from the candidate => Discard | shutdown alpha cand-shutdown-3@3 - thinking:medium []
";

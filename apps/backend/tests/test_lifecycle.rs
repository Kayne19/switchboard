use super::*;
use crate::models::{CatalogEntry, ModelCatalog};
use std::sync::Arc;
use std::thread;

fn coordinator() -> Coordinator {
    Coordinator::new(json!({
        "type": "status",
        "route": "operator",
        "models": [],
        "models_available": true
    }))
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
    coordinator.adopt_candidate().unwrap();
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
    assert!(coordinator.accept_callback(&leg, &operation));
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
        .accept_startup_thinking("candidate", "not-a-level")
        .is_err());
    assert_eq!(coordinator.status_json()["thinking"], "");
    coordinator
        .accept_startup_thinking("candidate", "high")
        .unwrap();
    assert_eq!(coordinator.status_json()["route"], "operator");
    let identity = coordinator.adopt_candidate().unwrap();
    assert_eq!(identity.generation, 1);
    assert_eq!(coordinator.status_json()["route"], "alpha");
    assert_eq!(coordinator.status_json()["thinking"], "high");
}

#[test]
fn rescue_reopens_only_after_a_new_status_projection() {
    let coordinator = coordinator();
    let old = coordinator.current_identity();
    coordinator.begin_rescue("page rescue");
    assert_eq!(
        coordinator.begin_prompt(&coordinator.current_identity()),
        Err(LifecycleError::WrongPhase)
    );
    coordinator.publish_status(json!({"type":"status", "route":"operator"}));
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
        coordinator.accept_startup_thinking("candidate", "invalid_level"),
        Err(LifecycleError::WrongPhase)
    );
    coordinator.adopt_candidate().unwrap();
    assert_eq!(coordinator.status_json()["thinking"], "medium");
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
        coordinator.reject_candidate_side_effect(),
        Err(LifecycleError::CandidateSideEffect)
    );
    assert_eq!(
        coordinator.accept_thinking_callback("candidate", "high"),
        Ok(false)
    );
    assert!(coordinator.rollback_candidate("intro failed"));
    assert_eq!(coordinator.status_json()["route"], "operator");
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
    coordinator.adopt_candidate().unwrap();
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
fn catalog_publication_matches_adoption_generation() {
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
    coordinator.adopt_candidate().unwrap();
    let status = coordinator.status_snapshot();
    assert!(status.is_catalog_current());
    assert_eq!(status.json()["models"][0]["model"], "opus");
}

#[test]
fn populated_status_keeps_picker_catalog_when_lifecycle_cache_is_empty() {
    let coordinator = coordinator();
    coordinator.publish_status(json!({
        "type": "status",
        "route": "alpha",
        "models": [{"provider": "openai", "model": "gpt-5.6", "thinks": true}],
        "models_available": true
    }));
    assert_eq!(coordinator.status_json()["models"][0]["model"], "gpt-5.6");
    assert_eq!(coordinator.status_json()["models_available"], true);
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
    assert_eq!(coordinator.status_json()["route"], "operator");
    release.wait();
    worker.join().unwrap();
}

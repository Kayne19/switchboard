use super::*;
use crate::jev::JevResponse;
use crate::registry::{Project, Registry};
use serde_json::json;
use std::sync::Arc;

fn router(lower: f64, upper: f64, action: f64) -> Router {
    let registry = Arc::new(Registry::new(vec![Project {
        id: "atlas".into(),
        description: "planning project".into(),
        aliases: vec!["plan".into()],
        host: Some("fake".into()),
        cwd: "/tmp".into(),
        model: None,
        prepare: String::new(),
    }]));
    let coordinator = Coordinator::new(
        crate::lifecycle::StatusConfig {
            projects: vec!["atlas".into()],
            ..Default::default()
        },
        "medium",
    );
    let client = crate::jev::JevClient::new(
        "http://127.0.0.1:1",
        "/nonexistent/typesafe-api-key",
        std::time::Duration::from_millis(10),
    )
    .expect("client");
    Router::new(client, registry, coordinator, 8_000, lower, upper, action)
}

fn project_router(lower: f64, upper: f64, action: f64) -> Router {
    let registry = Arc::new(Registry::new(vec![Project {
        id: "atlas".into(),
        description: "planning project".into(),
        aliases: vec!["plan".into()],
        host: Some("fake".into()),
        cwd: "/tmp".into(),
        model: None,
        prepare: String::new(),
    }]));
    let coordinator = Coordinator::new(
        crate::lifecycle::StatusConfig {
            projects: vec!["atlas".into()],
            ..Default::default()
        },
        "medium",
    );
    coordinator
        .begin_candidate(crate::lifecycle::CandidateLeg::new(
            "atlas",
            "atlas",
            "session",
            "atlas-token",
            "provider/model",
            "medium",
        ))
        .expect("candidate");
    coordinator
        .adopt_candidate("atlas-token")
        .expect("project candidate");
    let client = crate::jev::JevClient::new(
        "http://127.0.0.1:1",
        "/nonexistent/typesafe-api-key",
        std::time::Duration::from_millis(10),
    )
    .expect("client");
    Router::new(client, registry, coordinator, 8_000, lower, upper, action)
}

fn answers(action: &str, confidence: f64, for_current_agent: f64) -> JevResponse {
    let mut map = std::collections::BTreeMap::new();
    map.insert(
        "action".into(),
        crate::jev::JevAnswer {
            answer_type: Some("choice".into()),
            choice: Some(action.into()),
            probabilities: Some([(action.into(), confidence)].into_iter().collect()),
            confidence: Some(confidence),
            noul: None,
        },
    );
    map.insert(
        "for_current_agent".into(),
        crate::jev::JevAnswer {
            answer_type: Some("noul".into()),
            choice: None,
            probabilities: None,
            confidence: None,
            noul: Some(for_current_agent),
        },
    );
    for (name, choice) in [("target", "none"), ("continue_or_fresh", "not_applicable")] {
        map.insert(
            name.into(),
            crate::jev::JevAnswer {
                answer_type: Some("choice".into()),
                choice: Some(choice.into()),
                probabilities: Some([(choice.into(), 1.0)].into_iter().collect()),
                confidence: Some(1.0),
                noul: None,
            },
        );
    }
    map.insert(
        "multi_target".into(),
        crate::jev::JevAnswer {
            answer_type: Some("noul".into()),
            choice: None,
            probabilities: None,
            confidence: None,
            noul: Some(0.0),
        },
    );
    JevResponse {
        model: Some("jev-1.13.0".into()),
        answers: map,
        usage: None,
    }
}

#[test]
fn question_set_has_fixed_actions_and_named_summary_fields() {
    let router = router(0.3, 0.7, 0.6);
    let summary = CallSummary::new(
        "atlas",
        [(
            "atlas".into(),
            AgentSummary {
                state: "busy".into(),
                model: "provider/model".into(),
                thinking: "medium".into(),
                task: "task".into(),
                pending_request_to_speak: false,
            },
        )]
        .into_iter()
        .collect(),
        vec![],
        vec![ConversationTurn {
            speaker: "caller".into(),
            text: "old".into(),
        }],
        json!({"view": "auto"}),
        "hello",
        vec![RegisteredProject {
            id: "atlas".into(),
            description: "planning project".into(),
            aliases: vec!["plan".into()],
        }],
    );
    let request = router.build_request(&summary);
    assert_eq!(request.questions.len(), 5);
    assert_eq!(request.questions["action"].criteria.len(), 10);
    let state = request.state.as_object().expect("state object");
    for name in [
        "caller_is_talking_to",
        "agents",
        "live_desk_sessions",
        "recent_conversation",
        "screen",
        "caller_just_said",
        "registered_projects",
    ] {
        assert!(state.contains_key(name), "missing {name}");
    }
}

#[test]
fn summary_drops_oldest_turns_first() {
    let router = router(0.3, 0.7, 0.6);
    let summary = CallSummary::new(
        "operator",
        BTreeMap::new(),
        vec![],
        (0..100)
            .map(|index| ConversationTurn {
                speaker: "caller".into(),
                text: format!("turn-{index}-{}", "x".repeat(1000)),
            })
            .collect(),
        json!({"view": "auto"}),
        "last",
        vec![],
    );
    let state = router.build_request(&summary).state;
    let turns = state["recent_conversation"].as_array().expect("turns");
    assert!(turns.len() < 100);
    assert!(turns.last().expect("last")["text"]
        .as_str()
        .is_some_and(|text| text.starts_with("turn-99-")));
}

#[test]
fn threshold_edges_and_stop_confirmation_match_policy() {
    let router = router(0.3, 0.7, 0.6);
    let decision = router
        .map_response(answers("stop", 0.6, 0.3))
        .expect("decision");
    assert_eq!(decision.action, Action::Stop);
    assert!(decision.confirm);
    assert!(!decision.unsure);
    let unsure = router
        .map_response(answers("continue", 0.59, 0.31))
        .expect("decision");
    assert!(unsure.unsure);
    let low = router
        .map_response(answers("continue", 0.6, 0.3))
        .expect("decision");
    assert!(!low.unsure);
}

#[test]
fn current_agent_threshold_edges_are_exact_on_a_project_route() {
    let router = project_router(0.3, 0.7, 0.6);

    let upper = router
        .map_response(answers("general", 0.9, 0.7))
        .expect("upper threshold");
    assert_eq!(upper.action, Action::Continue);
    assert!(!upper.unsure);

    for confidence in [0.69, 0.31] {
        let unsure = router
            .map_response(answers("general", 0.9, confidence))
            .expect("unsure band");
        assert!(unsure.unsure, "for_current_agent={confidence}");
        assert!(unsure.reason.contains("action_conf=0.900"));
        assert!(unsure
            .reason
            .contains(&format!("for_current_agent={confidence:.3}")));
    }

    let lower = router
        .map_response(answers("general", 0.9, 0.3))
        .expect("lower threshold");
    assert_eq!(lower.action, Action::General);
    assert!(!lower.unsure);

    let below_action_threshold = router
        .map_response(answers("general", 0.59, 0.3))
        .expect("action threshold");
    assert!(below_action_threshold.unsure);
}

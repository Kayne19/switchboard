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
                display_ready: false,
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

#[test]
fn utility_signals_accept_second_opinions_and_split_parts() {
    let opinion = crate::pi_client::Signal {
        name: "second_opinion".into(),
        args: serde_json::from_value(json!({
            "target": "atlas",
            "mode": "continue",
            "confident": true,
        }))
        .unwrap(),
    };
    assert_eq!(
        utility_decision(&[opinion]),
        Some(UtilityDecision::SecondOpinion {
            target: Some("atlas".into()),
            mode: ConversationMode::Continue,
            confident: true,
        })
    );
    let split = crate::pi_client::Signal {
        name: "dispatch_parts".into(),
        args: serde_json::from_value(json!({
            "parts": [
                {"agent": "atlas", "text": "Check the plan"},
                {"project": "beta", "text": "Review the build"},
            ],
        }))
        .unwrap(),
    };
    assert_eq!(
        utility_decision(&[split]),
        Some(UtilityDecision::DispatchParts(vec![
            DispatchPart {
                agent: "atlas".into(),
                text: "Check the plan".into()
            },
            DispatchPart {
                agent: "beta".into(),
                text: "Review the build".into()
            },
        ]))
    );
}

#[test]
fn utility_route_regression_becomes_single_target_second_opinion() {
    let route = crate::pi_client::Signal {
        name: "route".into(),
        args: serde_json::from_value(json!({
            "target": "atlas",
            "mode": "continue",
        }))
        .unwrap(),
    };
    assert_eq!(
        utility_decision(&[route]),
        Some(UtilityDecision::SecondOpinion {
            target: Some("atlas".into()),
            mode: ConversationMode::Continue,
            confident: true,
        })
    );
}

fn summary_on(current: &str) -> CallSummary {
    let mut agents = BTreeMap::new();
    agents.insert(
        current.to_owned(),
        AgentSummary {
            state: "busy".into(),
            model: String::new(),
            thinking: String::new(),
            task: "draw the Jev diagram".into(),
            pending_request_to_speak: false,
            display_ready: false,
        },
    );
    CallSummary::new(
        current,
        agents,
        vec![],
        vec![
            ConversationTurn {
                speaker: "caller".into(),
                text: "show me the chart and the commit".into(),
            },
            ConversationTurn {
                speaker: "grape".into(),
                text: "The chart is ready to show.".into(),
            },
        ],
        json!({}),
        "pull it up",
        vec![],
    )
}

#[test]
fn background_agents_join_the_summary_with_their_live_state() {
    let mut summary = summary_on("switchboard");
    summary.merge_live_agents(&[
        LiveAgent {
            project: "switchboard".into(),
            state: "idle".into(),
            pending_request: false,
            display_ready: false,
        },
        LiveAgent {
            project: "grape".into(),
            state: "idle".into(),
            pending_request: false,
            display_ready: true,
        },
        LiveAgent {
            project: "old".into(),
            state: "finished".into(),
            pending_request: false,
            display_ready: false,
        },
    ]);

    assert_eq!(summary.agents["switchboard"].state, "idle");
    assert_eq!(summary.agents["switchboard"].task, "draw the Jev diagram");
    assert!(summary.agents["grape"].display_ready);
    assert!(!summary.agents.contains_key("old"));
    assert_eq!(summary.single_waiting_agent().as_deref(), Some("grape"));
    let state = serde_json::to_value(&summary).unwrap();
    assert_eq!(state["agents"]["grape"]["display_ready"], json!(true));
    assert!(state["agents"]["switchboard"]
        .get("display_ready")
        .is_none());
}

#[test]
fn several_waiting_agents_do_not_pick_one() {
    let mut summary = summary_on("switchboard");
    summary.merge_live_agents(&[
        LiveAgent {
            project: "grape".into(),
            state: "waiting".into(),
            pending_request: true,
            display_ready: false,
        },
        LiveAgent {
            project: "homelab".into(),
            state: "idle".into(),
            pending_request: false,
            display_ready: true,
        },
    ]);
    assert_eq!(summary.single_waiting_agent(), None);
}

#[test]
fn the_llm_call_state_names_foreground_background_and_ready_work() {
    let mut summary = summary_on("switchboard");
    summary.merge_live_agents(&[LiveAgent {
        project: "grape".into(),
        state: "idle".into(),
        pending_request: false,
        display_ready: true,
    }]);
    let text = summary.render_for_llm();
    assert!(text.contains("The caller is on: switchboard."), "{text}");
    assert!(
        text.contains("- grape: idle, in the background, has a display the caller has not seen"),
        "{text}"
    );
    assert!(
        text.contains("- switchboard: busy, in front; last asked: \"draw the Jev diagram\""),
        "{text}"
    );
    assert!(
        text.contains("grape: The chart is ready to show."),
        "{text}"
    );
}

#[test]
fn the_queued_update_is_its_own_field() {
    let mut summary = summary_on("switchboard");
    let without = serde_json::to_value(&summary).unwrap();
    assert!(without.get("queued_update").is_none());
    summary.queued_update = Some(QueuedUpdate {
        from_agent: "grape".into(),
        message: "The chart is ready.".into(),
    });
    let with = serde_json::to_value(&summary).unwrap();
    assert_eq!(with["caller_just_said"], json!("pull it up"));
    assert_eq!(with["queued_update"]["from_agent"], json!("grape"));
}

#[test]
fn an_omitted_mode_continues_and_an_omitted_confidence_is_not_confident() {
    let opinion = crate::pi_client::Signal {
        name: "second_opinion".into(),
        args: serde_json::from_value(json!({"target": "atlas"})).unwrap(),
    };
    assert_eq!(
        utility_decision(&[opinion]),
        Some(UtilityDecision::SecondOpinion {
            target: Some("atlas".into()),
            mode: ConversationMode::Continue,
            confident: false,
        })
    );
}

#[test]
fn every_threshold_rule_is_named_with_its_numbers() {
    let on_operator = router(0.3, 0.7, 0.6);
    let on_project = project_router(0.3, 0.7, 0.6);
    let rule = |router: &Router, action: &str, confidence: f64, current: f64| {
        router
            .map_response_with_rule(&answers(action, confidence, current))
            .expect("decision")
    };

    let (_, stop) = rule(&on_operator, "stop", 0.9, 0.0);
    assert_eq!(stop.as_str(), "stop_confirms");
    let (_, confident) = rule(&on_operator, "general", 0.9, 0.0);
    assert_eq!(confident.as_str(), "jev_action");
    let (below, rule_below) = rule(&on_operator, "general", 0.5, 0.0);
    assert_eq!(rule_below.as_str(), "action_below_threshold");
    assert!(
        below.reason.contains("action_conf=0.500 < threshold 0.600"),
        "{}",
        below.reason
    );
    let (stayed, rule_stayed) = rule(&on_project, "general", 0.9, 0.8);
    assert_eq!(rule_stayed.as_str(), "stayed_with_current");
    assert!(
        stayed
            .reason
            .contains("for_current_agent=0.800 >= upper 0.700"),
        "{}",
        stayed.reason
    );
    let (unsure, rule_unsure) = rule(&on_project, "general", 0.9, 0.5);
    assert_eq!(rule_unsure.as_str(), "current_agent_unsure");
    assert!(
        unsure
            .reason
            .contains("between lower 0.300 and upper 0.700"),
        "{}",
        unsure.reason
    );
}

#[tokio::test]
async fn a_routing_call_keeps_the_raw_answers_and_its_latency() {
    let raw = answers("general", 0.9, 0.0);
    let response = raw.clone();
    let client = crate::jev::JevClient::new(
        "http://unused.invalid/v1/systemone",
        "/nonexistent/typesafe-api-key",
        std::time::Duration::from_secs(1),
    )
    .expect("client")
    .with_test_responder(move |_| {
        let response = response.clone();
        async move { Ok(response) }
    });
    let router = Router::new(
        client,
        Arc::new(Registry::new(vec![])),
        Coordinator::new(crate::lifecycle::StatusConfig::default(), "medium"),
        8_000,
        0.3,
        0.7,
        0.6,
    );
    let summary = summary_on("operator");
    let trace = router.route_request(router.build_request(&summary)).await;
    assert_eq!(trace.response, Some(raw));
    let (decision, rule) = trace.result.expect("decision");
    assert_eq!(decision.action, Action::General);
    assert_eq!(rule, RouteRule::JevAction);
    assert_eq!(
        crate::router::jev_outcome(trace.response.as_ref(), None),
        "ok"
    );

    let gate = router
        .good_moment(router.good_moment_request(&summary))
        .await;
    // The canned routing answers carry no good_moment answer.
    assert!(gate.response.is_some());
    let error = gate.result.expect_err("missing good_moment");
    assert_eq!(
        crate::router::jev_outcome(gate.response.as_ref(), Some(&error)),
        "invalid"
    );
}

#[test]
fn utility_decisions_render_for_the_debug_page() {
    let opinion = UtilityDecision::SecondOpinion {
        target: Some("atlas".into()),
        mode: ConversationMode::Fresh,
        confident: true,
    };
    assert_eq!(
        opinion.debug_value(),
        json!({"kind":"second_opinion","target":"atlas","mode":"fresh","confident":true})
    );
    let split = UtilityDecision::DispatchParts(vec![DispatchPart {
        agent: "atlas".into(),
        text: "plan it".into(),
    }]);
    assert_eq!(
        split.debug_value(),
        json!({"kind":"dispatch_parts","parts":[{"project":"atlas","text":"plan it"}]})
    );
}

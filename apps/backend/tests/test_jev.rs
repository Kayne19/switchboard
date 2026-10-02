use super::*;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

#[test]
fn request_serializes_system_one_shape_without_a_key_field() {
    let request = JevRequest {
        model: "jev-latest".into(),
        state: serde_json::json!({"caller_just_said": "hello"}),
        questions: [(
            "action".into(),
            Question::new(
                "choice",
                "Choose an action",
                [("continue", "continue the call")],
            ),
        )]
        .into_iter()
        .collect::<BTreeMap<_, _>>(),
    };
    let value = serde_json::to_value(request).expect("request JSON");
    assert_eq!(value["model"], "jev-latest");
    assert_eq!(value["questions"]["action"]["type"], "choice");
    assert!(value.get("key").is_none());
}

#[tokio::test]
async fn missing_key_fails_closed_without_network_access() {
    let client = JevClient::new(
        "http://127.0.0.1:1",
        "/nonexistent/typesafe-api-key",
        std::time::Duration::from_millis(10),
    )
    .expect("client");
    let result = client.decide(serde_json::json!({}), BTreeMap::new()).await;
    assert!(matches!(result, Err(JevError::KeyFile(_))));
}

#[tokio::test]
async fn in_process_responder_returns_typed_answers_without_network() {
    let client = JevClient::new(
        "http://unused.invalid/v1/systemone",
        "/nonexistent/typesafe-api-key",
        std::time::Duration::from_secs(1),
    )
    .expect("client")
    .with_test_responder(|_request| async {
        Ok(serde_json::from_value(serde_json::json!({
            "model": "jev-test",
            "answers": {
                "action": {"type":"choice","choice":"continue","probabilities":{"continue":1.0},"confidence":1.0},
                "for_current_agent": {"type":"noul","noul":1.0},
                "target": {"type":"choice","choice":"none","probabilities":{"none":1.0},"confidence":1.0},
                "continue_or_fresh": {"type":"choice","choice":"not_applicable","probabilities":{"not_applicable":1.0},"confidence":1.0},
                "multi_target": {"type":"noul","noul":0.0}
            }
        })).expect("fixture response"))
    });
    let response = client
        .decide(
            serde_json::json!({"caller_just_said":"hello"}),
            BTreeMap::new(),
        )
        .await
        .expect("Jev response");
    assert_eq!(
        response.answers["action"].choice.as_deref(),
        Some("continue")
    );
}

#[derive(Clone, Copy)]
enum FailureResponse {
    Timeout,
    ServerError,
    BadJson,
}

async fn route_failure(response_kind: FailureResponse) -> crate::router::Decision {
    let client = JevClient::new(
        "http://unused.invalid/v1/systemone",
        "/nonexistent/typesafe-api-key",
        Duration::from_millis(20),
    )
    .expect("client")
    .with_test_responder(move |_request| async move {
        match response_kind {
            FailureResponse::Timeout => {
                std::future::pending::<Result<crate::jev::JevResponse, JevError>>().await
            }
            FailureResponse::ServerError => Err(JevError::Http {
                status: 500,
                body: "jev is unavailable".into(),
            }),
            FailureResponse::BadJson => Err(JevError::Response("not json".into())),
        }
    });
    let registry = Arc::new(crate::registry::Registry::new(vec![]));
    let coordinator =
        crate::lifecycle::Coordinator::new(crate::lifecycle::StatusConfig::default(), "medium");
    let router = crate::router::Router::new(client, registry, coordinator, 8_000, 0.3, 0.7, 0.6);
    let summary = crate::router::CallSummary::new(
        "operator",
        BTreeMap::new(),
        vec![],
        vec![],
        serde_json::json!({}),
        "hello",
        vec![],
    );
    let error = router.route(&summary).await.expect_err("Jev failure");
    router.fallback(&error)
}

#[tokio::test]
async fn timeout_falls_back_to_an_unsure_operator_decision() {
    let decision = route_failure(FailureResponse::Timeout).await;
    assert!(decision.unsure);
    assert_eq!(decision.action, crate::router::Action::General);
}

#[tokio::test]
async fn server_error_falls_back_to_an_unsure_operator_decision() {
    let decision = route_failure(FailureResponse::ServerError).await;
    assert!(decision.unsure);
    assert_eq!(decision.action, crate::router::Action::General);
}

#[tokio::test]
async fn malformed_response_falls_back_to_an_unsure_operator_decision() {
    let decision = route_failure(FailureResponse::BadJson).await;
    assert!(decision.unsure);
    assert_eq!(decision.action, crate::router::Action::General);
}

#[tokio::test]
async fn a_timeout_is_told_apart_from_other_failures() {
    let decision_error = |kind| async move {
        let client = JevClient::new(
            "http://unused.invalid/v1/systemone",
            "/nonexistent/typesafe-api-key",
            Duration::from_millis(20),
        )
        .expect("client")
        .with_test_responder(move |_request| async move {
            match kind {
                FailureResponse::Timeout => {
                    std::future::pending::<Result<crate::jev::JevResponse, JevError>>().await
                }
                _ => Err(JevError::Http {
                    status: 500,
                    body: "jev is unavailable".into(),
                }),
            }
        });
        client
            .decide(serde_json::json!({}), BTreeMap::new())
            .await
            .expect_err("failure")
    };
    let timeout = decision_error(FailureResponse::Timeout).await;
    assert!(timeout.is_timeout());
    assert_eq!(crate::router::jev_outcome(None, Some(&timeout)), "timeout");
    let server = decision_error(FailureResponse::ServerError).await;
    assert!(!server.is_timeout());
    assert_eq!(crate::router::jev_outcome(None, Some(&server)), "error");
}

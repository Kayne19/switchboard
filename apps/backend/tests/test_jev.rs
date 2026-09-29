use super::*;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
async fn fake_server_returns_typed_answers_without_real_network() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let endpoint = format!(
        "http://{}/v1/systemone",
        listener.local_addr().expect("address")
    );
    let key_path =
        std::env::temp_dir().join(format!("switchboard-jev-test-{}", std::process::id()));
    std::fs::write(&key_path, "fixture-key").expect("fixture key file");
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("request");
        let mut request = vec![0_u8; 8192];
        let _ = tokio::io::AsyncReadExt::read(&mut stream, &mut request).await;
        let body = r#"{"model":"jev-test","answers":{"action":{"type":"choice","choice":"continue","probabilities":{"continue":1.0},"confidence":1.0},"for_current_agent":{"type":"noul","noul":1.0},"target":{"type":"choice","choice":"none","probabilities":{"none":1.0},"confidence":1.0},"continue_or_fresh":{"type":"choice","choice":"not_applicable","probabilities":{"not_applicable":1.0},"confidence":1.0},"multi_target":{"type":"noul","noul":0.0}}}"#;
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
        tokio::io::AsyncWriteExt::write_all(&mut stream, response.as_bytes())
            .await
            .expect("response");
    });
    let client =
        JevClient::new(&endpoint, &key_path, std::time::Duration::from_secs(1)).expect("client");
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
    server.await.expect("server task");
    let _ = std::fs::remove_file(key_path);
}

#[derive(Clone, Copy)]
enum FailureResponse {
    Timeout,
    ServerError,
    BadJson,
}

async fn route_failure(response_kind: FailureResponse) -> crate::router::Decision {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let endpoint = format!(
        "http://{}/v1/systemone",
        listener.local_addr().expect("address")
    );
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let key_path = std::env::temp_dir().join(format!(
        "switchboard-jev-fallback-{}-{nonce}",
        std::process::id()
    ));
    std::fs::write(&key_path, "fixture-key").expect("fixture key file");
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("request");
        if matches!(response_kind, FailureResponse::Timeout) {
            tokio::time::sleep(Duration::from_millis(100)).await;
            return;
        }
        let body = match response_kind {
            FailureResponse::ServerError => "jev is unavailable",
            FailureResponse::BadJson => "not json",
            FailureResponse::Timeout => unreachable!(),
        };
        let status = if matches!(response_kind, FailureResponse::ServerError) {
            "500 Internal Server Error"
        } else {
            "200 OK"
        };
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        tokio::io::AsyncWriteExt::write_all(&mut stream, response.as_bytes())
            .await
            .expect("response");
    });
    let client = JevClient::new(&endpoint, &key_path, Duration::from_millis(20)).expect("client");
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
    let fallback = router.fallback(&error);
    server.await.expect("server task");
    let _ = std::fs::remove_file(key_path);
    fallback
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

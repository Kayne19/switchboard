use super::*;
use std::collections::BTreeMap;

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

use super::*;
use crate::pbx::OPERATOR;
use crate::registry::Registry;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use std::collections::HashMap;
use tokio::sync::oneshot;
use tokio::time::{timeout, Duration};
use tower::ServiceExt;

fn state() -> AppState {
    state_with_stt(None)
}

fn state_with_stt(stt: Option<String>) -> AppState {
    state_with_stream(stt, None)
}

fn state_with_stream(stt: Option<String>, stream: Option<String>) -> AppState {
    let board = Switchboard::new(
        Registry::new(vec![]),
        "pi".into(),
        None,
        "".into(),
        None,
        None,
        None,
        "medium".into(),
        ".cache".into(),
        true,
        "".into(),
        "".into(),
        "".into(),
        "".into(),
        HashMap::new(),
    );
    AppState::new_with_stream(
        board,
        TranscriptLog::new(10),
        Speaker::from_values(
            100,
            &HashMap::from([("ELEVENLABS_API_KEY".into(), "test-key".into())]),
        ),
        SttAdapter::from_command(stt),
        SttStreamAdapter::from_command(stream),
    )
}

async fn next_delivery(connection: &mut DeliveryConnection) -> Value {
    let Some(DeliveryFrame::Message(Message::Text(text))) = connection.receiver.recv().await else {
        panic!("expected a websocket response");
    };
    serde_json::from_str(&text).unwrap()
}

async fn request_json(
    state: &AppState,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    let body = match body {
        Some(value) => {
            request = request.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let response = state
        .clone()
        .router(None)
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap();
    (status, value)
}

#[tokio::test]
async fn http_contract_exposes_status_health_and_page_controls() {
    let state = state();
    let (code, status) = request_json(&state, Method::GET, "/status", None).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(status["type"], "status");
    assert_eq!(status["route"], OPERATOR);
    assert_eq!(
        status["levels"],
        serde_json::json!(crate::models::THINKING_LEVELS)
    );

    let (code, health) = request_json(&state, Method::GET, "/healthz", None).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(health["status"], "ok");
    assert_eq!(health["stt_adapter"], "sidecar");
    assert_eq!(health["stt_configured"], false);

    let (code, connected) = request_json(
        &state,
        Method::POST,
        "/connect",
        Some(json!({"project":"operator"})),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(connected, json!({"route":"operator", "error":null}));

    let (code, thinking) = request_json(
        &state,
        Method::POST,
        "/thinking",
        Some(json!({"level":"high"})),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(thinking, json!({"thinking":"", "error":null}));
    assert_eq!(
        state.0.switchboard.lock().await.status()["thinking_default"],
        "high"
    );

    let (code, model) = request_json(
        &state,
        Method::POST,
        "/model",
        Some(json!({"model":"anthropic/next"})),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(model["model"], "");
    assert!(model["error"].as_str().unwrap().contains("project leg"));

    let (code, leg) = request_json(
        &state,
        Method::POST,
        "/leg-state",
        Some(json!({"thinking":"high"})),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(leg, json!({"accepted":false}));
}

#[tokio::test]
async fn browser_screen_state_is_available_to_the_agent_view_tool() {
    let state = state();
    let connection = state.0.delivery.register();
    let mut pending_header = None;
    let mut pending_chunk = None;
    handle_text_frame(
        &state,
        connection.epoch,
        &mut pending_header,
        &mut pending_chunk,
        &json!({
            "type": "screen_state",
            "view": "comms",
            "has_visual": true,
            "visual_kind": "diff",
            "title": "Authentication changes",
            "stale": false,
        })
        .to_string(),
    )
    .await
    .unwrap();

    let (code, response) =
        request_json(&state, Method::POST, "/view", Some(json!({"target":""}))).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(response["screen"]["view"], "comms");
    assert_eq!(response["screen"]["visual_kind"], "diff");
    assert_eq!(response["screen"]["title"], "Authentication changes");
}

#[tokio::test]
async fn diagram_contract_is_live_and_replayed() {
    let state = state();
    let mut events = state.0.events.subscribe();
    let payload = json!({
        "source":"flowchart TD; A-->B",
        "title":"Path",
        "notes":"One hop"
    });
    let (code, response) =
        request_json(&state, Method::POST, "/diagram", Some(payload.clone())).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        response,
        json!({"delivered":false, "reason":"no browser connected"})
    );
    let Event::Json(event) = events.recv().await.unwrap() else {
        panic!("diagram should be a JSON event")
    };
    assert_eq!(
        event,
        json!({"type":"diagram", "source":"flowchart TD; A-->B", "title":"Path", "notes":"One hop"})
    );
    assert_eq!(*state.0.last_diagram.lock().await, Some(event));
}

#[tokio::test]
async fn visual_plan_payload_validates_and_replays() {
    let state = state();
    let mut events = state.0.events.subscribe();
    let payload = json!({
        "kind": "plan",
        "items": [
            {"label": "Inspect code", "state": "done", "detail": "1 file"},
            {"label": "Write tests", "state": "active", "detail": "apps/backend/src/api.rs"},
            {"label": "Verify build", "state": "todo", "detail": ""},
            {"label": "Deploy stage", "state": "blocked", "detail": "waiting"}
        ],
        "title": "Implementation Plan",
        "notes": "Step 2 of 4"
    });
    let (code, response) =
        request_json(&state, Method::POST, "/diagram", Some(payload.clone())).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        response,
        json!({"delivered":false, "reason":"no browser connected"})
    );
    let Event::Json(event) = events.recv().await.unwrap() else {
        panic!("plan visual should be a JSON event")
    };
    let expected_event = json!({
        "type": "diagram",
        "kind": "plan",
        "items": [
            {"label": "Inspect code", "state": "done", "detail": "1 file"},
            {"label": "Write tests", "state": "active", "detail": "apps/backend/src/api.rs"},
            {"label": "Verify build", "state": "todo", "detail": ""},
            {"label": "Deploy stage", "state": "blocked", "detail": "waiting"}
        ],
        "title": "Implementation Plan",
        "notes": "Step 2 of 4"
    });
    assert_eq!(event, expected_event);
    assert_eq!(*state.0.last_diagram.lock().await, Some(expected_event));
}

#[tokio::test]
async fn visual_plan_omitted_state_defaults_to_todo() {
    let state = state();
    let mut events = state.0.events.subscribe();
    let payload = json!({
        "kind": "plan",
        "items": [
            {"label": "Step without state"}
        ]
    });
    let (code, _) = request_json(&state, Method::POST, "/diagram", Some(payload)).await;
    assert_eq!(code, StatusCode::OK);
    let Event::Json(event) = events.recv().await.unwrap() else {
        panic!("expected json event")
    };
    assert_eq!(event["items"][0]["state"], "todo");
}

#[tokio::test]
async fn visual_whitespace_kind_defaults_to_mermaid() {
    let state = state();
    let payload = json!({
        "kind": "   ",
        "source": "flowchart TD; A-->B"
    });
    let (code, _) = request_json(&state, Method::POST, "/diagram", Some(payload)).await;
    assert_eq!(code, StatusCode::OK);
}

#[tokio::test]
async fn visual_mermaid_validation_enforces_semantic_classes() {
    let state = state();

    // 1. classDef line reject
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "source": "flowchart TD\nclassDef hot fill:#2a0d1a\nA:::hot"
        })),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert_eq!(res["delivered"], false);
    let detail = res["detail"].as_str().unwrap();
    assert!(
        detail.contains("active")
            && detail.contains("done")
            && detail.contains("blocked")
            && detail.contains("muted")
    );

    // 2. %%{init line reject
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "source": "%%{init: {'theme': 'dark'}}%%\nflowchart TD\nA"
        })),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert_eq!(res["delivered"], false);
    let detail = res["detail"].as_str().unwrap();
    assert!(
        detail.contains("active")
            && detail.contains("done")
            && detail.contains("blocked")
            && detail.contains("muted")
    );

    // 3. :::glow reject (unknown class name)
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "source": "flowchart TD\nA:::glow"
        })),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert_eq!(res["delivered"], false);
    let detail = res["detail"].as_str().unwrap();
    assert!(
        detail.contains("active")
            && detail.contains("done")
            && detail.contains("blocked")
            && detail.contains("muted")
    );

    // 4. two :::active reject
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "source": "flowchart TD\nA:::active\nB:::active"
        })),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert_eq!(res["delivered"], false);
    let detail = res["detail"].as_str().unwrap();
    assert!(
        detail.contains("active")
            && detail.contains("done")
            && detail.contains("blocked")
            && detail.contains("muted")
    );

    // 5. Clean source accept (one active, other legal classes)
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "source": "flowchart TD\nA:::active --> B:::done\nB --> C:::blocked\nC --> D:::muted"
        })),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(res["delivered"], false);
}

#[tokio::test]
async fn visual_rejects_oversized_plan() {
    let state = state();

    // 41 items
    let items: Vec<_> = (0..41)
        .map(|i| json!({"label": format!("Item {i}"), "state": "todo"}))
        .collect();
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({"kind": "plan", "items": items})),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert_eq!(res["delivered"], false);
    assert!(res["detail"].as_str().unwrap().contains("40"));

    // Label > 200 bytes
    let long_label = "a".repeat(201);
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({"kind": "plan", "items": [{"label": long_label, "state": "todo"}]})),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert_eq!(res["delivered"], false);
    assert!(res["detail"].as_str().unwrap().contains("200"));

    // Detail > 300 bytes
    let long_detail = "b".repeat(301);
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({"kind": "plan", "items": [{"label": "Step", "detail": long_detail, "state": "todo"}]})),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert_eq!(res["delivered"], false);
    assert!(res["detail"].as_str().unwrap().contains("300"));

    // Two active items in plan
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({"kind": "plan", "items": [{"label": "Step 1", "state": "active"}, {"label": "Step 2", "state": "active"}]})),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert_eq!(res["delivered"], false);
    assert!(res["detail"].as_str().unwrap().contains("active"));
}

#[tokio::test]
async fn visual_validation_field_limits_and_preservation() {
    let state = state();

    // 1. First establish a valid diagram in state
    let valid_payload = json!({
        "source": "flowchart TD; A-->B",
        "title": "Initial",
        "notes": "Valid"
    });
    let (code, _) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(valid_payload.clone()),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    let initial_diagram = state.0.last_diagram.lock().await.clone();
    assert!(initial_diagram.is_some());

    // 2. Empty plan items reject
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({"kind": "plan", "items": []})),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(res["detail"]
        .as_str()
        .unwrap()
        .contains("requires at least 1 item"));

    // 3. Plan item empty label reject
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({"kind": "plan", "items": [{"label": "", "state": "todo"}]})),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(res["detail"]
        .as_str()
        .unwrap()
        .contains("label must not be empty"));

    // 4. Plan item invalid state reject
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({"kind": "plan", "items": [{"label": "Step", "state": "invalid_state"}]})),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(res["detail"]
        .as_str()
        .unwrap()
        .contains("invalid plan item state"));

    // 5. Oversized mermaid source reject (> 20,000 bytes)
    let huge_mermaid = "flowchart TD\nA-->B; ".repeat(1500);
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({"source": huge_mermaid})),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(res["detail"].as_str().unwrap().contains("20000"));

    // 6. Title > 200 bytes reject
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({"source": "flowchart TD; A", "title": "a".repeat(201)})),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(res["detail"].as_str().unwrap().contains("200"));

    // 7. Notes > 300 bytes reject
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({"source": "flowchart TD; A", "notes": "b".repeat(301)})),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(res["detail"].as_str().unwrap().contains("300"));

    // 8. Non-ASCII Mermaid input should validate or reject safely without panicking
    let (code, _) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({"source": "flowchart TD\n  A[中文abc] --> B"})),
    )
    .await;
    assert_eq!(code, StatusCode::OK);

    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({"source": "flowchart TD\n  click 中文"})),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(res["detail"]
        .as_str()
        .unwrap()
        .contains("prohibited click directive"));

    // 9. Assert that after all failed validations, last_diagram was preserved
    let last = state.0.last_diagram.lock().await.clone().unwrap();
    assert_eq!(
        last["source"].as_str().unwrap(),
        "flowchart TD\n  A[中文abc] --> B"
    );
}

#[tokio::test]
async fn visual_backward_frames_format() {
    let state = state();

    // 1. Absent kind defaults to 4-key Mermaid broadcast format
    let (code, _) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({"source": "flowchart TD; X-->Y", "title": "Mermaid1", "notes": "notes1"})),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    let diagram1 = state.0.last_diagram.lock().await.clone().unwrap();
    let obj1 = diagram1.as_object().unwrap();
    assert_eq!(obj1.len(), 4);
    assert_eq!(obj1.get("type").unwrap(), "diagram");
    assert_eq!(obj1.get("source").unwrap(), "flowchart TD; X-->Y");
    assert_eq!(obj1.get("title").unwrap(), "Mermaid1");
    assert_eq!(obj1.get("notes").unwrap(), "notes1");
    assert!(!obj1.contains_key("kind"));
    assert!(!obj1.contains_key("items"));

    // 2. Explicit kind: "mermaid" also outputs 4-key frame
    let (code, _) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({"kind": "mermaid", "source": "flowchart TD; X-->Y", "title": "Mermaid2", "notes": "notes2"})),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    let diagram2 = state.0.last_diagram.lock().await.clone().unwrap();
    let obj2 = diagram2.as_object().unwrap();
    assert_eq!(obj2.len(), 4);
    assert!(!obj2.contains_key("kind"));

    // 3. Explicit kind: "plan" outputs 5-key Plan frame
    let (code, _) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "kind": "plan",
            "items": [{"label": "Task", "state": "active"}],
            "title": "PlanTitle",
            "notes": "PlanNotes"
        })),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    let diagram3 = state.0.last_diagram.lock().await.clone().unwrap();
    let obj3 = diagram3.as_object().unwrap();
    assert_eq!(obj3.len(), 5);
    assert_eq!(obj3.get("type").unwrap(), "diagram");
    assert_eq!(obj3.get("kind").unwrap(), "plan");
    assert_eq!(obj3.get("title").unwrap(), "PlanTitle");
    assert_eq!(obj3.get("notes").unwrap(), "PlanNotes");
    assert!(obj3.contains_key("items"));

    // 4. Explicit kind: "timeline" outputs 5-key Timeline frame
    let (code, _) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "kind": "timeline",
            "items": [{"label": "Step 1", "state": "done", "ms": 1200}],
            "title": "TimelineTitle",
            "notes": "TimelineNotes"
        })),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    let diagram4 = state.0.last_diagram.lock().await.clone().unwrap();
    let obj4 = diagram4.as_object().unwrap();
    assert_eq!(obj4.len(), 5);
    assert_eq!(obj4.get("type").unwrap(), "diagram");
    assert_eq!(obj4.get("kind").unwrap(), "timeline");
    assert_eq!(obj4.get("title").unwrap(), "TimelineTitle");
    assert_eq!(obj4.get("notes").unwrap(), "TimelineNotes");
    assert!(obj4.contains_key("items"));

    // 5. Explicit kind: "diff" outputs 5-key Diff frame
    let (code, _) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "kind": "diff",
            "source": "@@ -1,2 +1,2 @@\n-old\n+new",
            "title": "DiffTitle",
            "notes": "DiffNotes"
        })),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    let diagram5 = state.0.last_diagram.lock().await.clone().unwrap();
    let obj5 = diagram5.as_object().unwrap();
    assert_eq!(obj5.len(), 5);
    assert_eq!(obj5.get("type").unwrap(), "diagram");
    assert_eq!(obj5.get("kind").unwrap(), "diff");
    assert_eq!(obj5.get("source").unwrap(), "@@ -1,2 +1,2 @@\n-old\n+new");
    assert_eq!(obj5.get("title").unwrap(), "DiffTitle");
    assert_eq!(obj5.get("notes").unwrap(), "DiffNotes");
}

#[tokio::test]
async fn visual_timeline_and_diff_validation() {
    let state = state();

    // 1. Timeline item ms bound reject (> 86400000)
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "kind": "timeline",
            "items": [{"label": "Step 1", "ms": 86400001}]
        })),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(res["detail"].as_str().unwrap().contains("86400000"));

    // 2. Plan item with ms reject
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "kind": "plan",
            "items": [{"label": "Step 1", "ms": 100}]
        })),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(res["detail"]
        .as_str()
        .unwrap()
        .contains("ms is only valid on a timeline"));

    // 3. Diff source empty reject
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "kind": "diff",
            "source": "   "
        })),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(res["detail"]
        .as_str()
        .unwrap()
        .contains("diff source must not be empty"));

    // 4. Diff line limit reject (> 600 lines)
    let many_lines = (0..601)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "kind": "diff",
            "source": format!("@@ -1,601 +1,601 @@\n{many_lines}")
        })),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(res["detail"].as_str().unwrap().contains("600 lines"));

    // 5. Diff missing @@ hunk header reject
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "kind": "diff",
            "source": "--- a/file\n+++ b/file\n+line"
        })),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(res["detail"].as_str().unwrap().contains("@@ hunk header"));

    // 6. Prohibited click directive in mermaid reject
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "source": "flowchart TD\nA-->B\nclick A callAlert"
        })),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(res["detail"]
        .as_str()
        .unwrap()
        .contains("prohibited click directive"));
}

#[tokio::test]
async fn visual_rejects_oversized_body() {
    let state = state();
    let huge_source = "a".repeat(65 * 1024);
    let request = Request::builder()
        .method(Method::POST)
        .uri("/diagram")
        .header("content-type", "application/json")
        .body(Body::from(json!({"source": huge_source}).to_string()))
        .unwrap();
    let response = state.clone().router(None).oneshot(request).await.unwrap();
    assert!(
        response.status() == StatusCode::PAYLOAD_TOO_LARGE
            || response.status() == StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn visual_boundary_limits_and_case_insensitivity() {
    let state = state();

    // 1. Title exactly 200 bytes & notes exactly 300 bytes accepted
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "source": "flowchart TD; A-->B",
            "title": "a".repeat(200),
            "notes": "b".repeat(300)
        })),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(res["delivered"], false);

    // 2. Timeline ms exactly 86,400,000 accepted
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "kind": "timeline",
            "items": [{"label": "Step 1", "ms": 86_400_000}]
        })),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(res["delivered"], false);

    // 3. Diff source with exactly 600 lines accepted
    let diff_600 = format!(
        "@@ -1,600 +1,600 @@\n{}",
        (0..599)
            .map(|i| format!("+line {i}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "kind": "diff",
            "source": diff_600
        })),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(res["delivered"], false);

    // 4. Mixed-case prohibited Mermaid directives rejected
    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "source": "flowchart TD\nA-->B\nCLICK A callAlert"
        })),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(res["detail"].as_str().unwrap().contains("click"));

    let (code, res) = request_json(
        &state,
        Method::POST,
        "/diagram",
        Some(json!({
            "source": "flowchart TD\nCLASSDEF hot fill:#fff\nA:::hot"
        })),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(res["detail"].as_str().unwrap().contains("legal classes"));
}

#[tokio::test]
async fn delivery_registration_captures_live_events_for_snapshot_barrier() {
    let delivery = DeliveryState::new();
    let mut connection = delivery.register();
    delivery.publish(Event::Json(json!({"type":"status"})));
    let Some(DeliveryFrame::Event {
        sequence,
        event: Event::Json(value),
    }) = connection.receiver.recv().await
    else {
        panic!("registered connection should receive live event");
    };
    assert_eq!(sequence, 0);
    assert_eq!(value["type"], "status");
    delivery.retire(connection.epoch);
    assert!(!delivery.connected());
}

#[test]
fn audio_queue_emits_reserved_sequences_in_order_and_drops_on_clear() {
    let mut queue = AudioQueue::new();
    let first = queue.reserve(3);
    let second = queue.reserve(3);
    assert!(queue.start(second, 3).is_empty());
    assert!(queue.append(second, 3, vec![2]).is_empty());
    assert!(queue.finish(second, 3).is_empty());
    assert!(matches!(
        queue.start(first, 3).as_slice(),
        [Event::AudioStart { sequence: 0, .. }]
    ));
    assert!(matches!(
        queue.append(first, 3, vec![1]).as_slice(),
        [Event::AudioChunk { sequence: 0, .. }]
    ));
    let events = queue.finish(first, 3);
    assert!(matches!(
        events.as_slice(),
        [
            Event::AudioDone { sequence: 0, .. },
            Event::AudioStart { sequence: 1, .. },
            Event::AudioChunk { sequence: 1, .. },
            Event::AudioDone { sequence: 1, .. }
        ]
    ));
    let stale = queue.reserve(3);
    queue.clear();
    assert!(queue.finish(stale, 3).is_empty());
}

#[tokio::test]
async fn final_response_barrier_is_emitted_once_after_a_settled_turn() {
    let state = state();
    let mut events = state.0.events.subscribe();
    let generation = state.0.coordinator.generation();
    let reply = crate::pbx::Reply {
        text: "Final answer".into(),
        route: OPERATOR.into(),
        route_label: "Operator".into(),
        error: None,
        to_speak: Vec::new(),
        delivery_generation: None,
    };

    assert!(
        deliver_turn_if_current(&state, &reply, current_status(&state), generation, "clip-1",)
            .await
    );
    let mut barriers = Vec::new();
    while let Ok(Event::Json(value)) = events.try_recv() {
        if value["type"] == "final_response_audio_closed" {
            barriers.push(value);
        }
    }
    assert_eq!(barriers.len(), 1);
    assert_eq!(
        barriers[0],
        json!({
            "type": "final_response_audio_closed",
            "response_id": "clip-1",
            "generation": generation,
            "success": true,
        })
    );
}

#[tokio::test]
async fn stale_final_response_does_not_emit_a_barrier() {
    let state = state();
    let mut events = state.0.events.subscribe();
    let generation = state.0.coordinator.generation();
    state.0.coordinator.begin_rescue("test rescue");
    let reply = crate::pbx::Reply {
        text: "stale".into(),
        route: OPERATOR.into(),
        route_label: "Operator".into(),
        error: None,
        to_speak: Vec::new(),
        delivery_generation: None,
    };

    assert!(
        !deliver_turn_if_current(
            &state,
            &reply,
            current_status(&state),
            generation,
            "stale-clip",
        )
        .await
    );
    assert!(matches!(
        events.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
}

#[test]
fn audio_queue_barrier_waits_for_reserved_audio_before_it() {
    let mut queue = AudioQueue::new();
    let audio = queue.reserve(1);
    let marker = queue.reserve(1);
    assert!(queue
        .barrier(marker, 1, json!({"type":"barrier"}))
        .is_empty());
    assert!(matches!(
        queue.start(audio, 1).as_slice(),
        [Event::AudioStart { sequence: 0, .. }]
    ));
    let events = queue.finish(audio, 1);
    assert!(matches!(
        events.as_slice(),
        [
            Event::AudioDone { sequence: 0, .. },
            Event::Json(value)
        ] if value["type"] == "barrier"
    ));
}

#[test]
fn audio_queue_cancellation_releases_following_audio() {
    let mut queue = AudioQueue::new();
    let first = queue.reserve(1);
    let second = queue.reserve(1);
    assert!(matches!(
        queue.cancel(first, 1).as_slice(),
        [
            Event::AudioStart { sequence: 0, .. },
            Event::AudioDone { sequence: 0, .. }
        ]
    ));
    assert!(matches!(
        queue.start(second, 1).as_slice(),
        [Event::AudioStart { sequence: 1, .. }]
    ));
    assert!(matches!(
        queue.append(second, 1, vec![7]).as_slice(),
        [Event::AudioChunk { sequence: 1, .. }]
    ));
    let events = queue.finish(second, 1);
    assert!(matches!(
        events.as_slice(),
        [Event::AudioDone { sequence: 1, .. }]
    ));
}

#[tokio::test]
async fn streaming_clip_rejects_duplicate_chunks_and_repeats_end_cancel_safely() {
    let state = state_with_stream(None, Some("true".into()));
    let mut connection = state.0.delivery.register();
    let epoch = connection.epoch;
    let mut pending_header = None;
    let mut pending_chunk = None;

    handle_text_frame(
        &state,
        epoch,
        &mut pending_header,
        &mut pending_chunk,
        r#"{"type":"stt_start","clip_id":"clip","generation":1,"mime":"audio/webm;codecs=opus"}"#,
    )
    .await
    .unwrap();
    assert_eq!(next_delivery(&mut connection).await["type"], "accepted");

    handle_text_frame(
        &state,
        epoch,
        &mut pending_header,
        &mut pending_chunk,
        r#"{"type":"stt_chunk","clip_id":"clip","generation":1,"sequence":0}"#,
    )
    .await
    .unwrap();
    handle_audio_frame(
        &state,
        epoch,
        &mut pending_header,
        &mut pending_chunk,
        b"first".to_vec(),
    )
    .await
    .unwrap();
    handle_text_frame(
        &state,
        epoch,
        &mut pending_header,
        &mut pending_chunk,
        r#"{"type":"stt_chunk","clip_id":"clip","generation":1,"sequence":0}"#,
    )
    .await
    .unwrap();
    handle_audio_frame(
        &state,
        epoch,
        &mut pending_header,
        &mut pending_chunk,
        b"duplicate".to_vec(),
    )
    .await
    .unwrap();
    assert_eq!(next_delivery(&mut connection).await["type"], "error");

    for _ in 0..2 {
        handle_text_frame(
            &state,
            epoch,
            &mut pending_header,
            &mut pending_chunk,
            r#"{"type":"stt_end","clip_id":"clip","generation":1}"#,
        )
        .await
        .unwrap();
    }
    for _ in 0..2 {
        handle_text_frame(
            &state,
            epoch,
            &mut pending_header,
            &mut pending_chunk,
            r#"{"type":"stt_cancel","clip_id":"clip","generation":1}"#,
        )
        .await
        .unwrap();
    }
    assert_eq!(
        state.0.stream_clips.lock().await.get("clip"),
        Some(&StreamClipState::Cancelled)
    );
}

#[tokio::test]
async fn speak_rejects_blank_text_without_logging_it() {
    let state = state();
    let (code, body) =
        request_json(&state, Method::POST, "/speak", Some(json!({"text":"   "}))).await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({"detail":"text must not be empty"}));
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
}

async fn hold_turn_lock(state: &AppState, signal: Option<oneshot::Sender<()>>) {
    let guard = state.0.switchboard.lock().await;
    if let Some(tx) = signal {
        let _ = tx.send(());
    }
    futures_util::future::poll_fn(move |_cx| {
        let _keep = &guard;
        std::task::Poll::Pending::<()>
    })
    .await;
}

#[tokio::test]
async fn agent_callbacks_do_not_wait_for_the_turn_lock() {
    let state = state();
    let _events = state.0.events.subscribe();
    let (locked_tx, locked_rx) = oneshot::channel();
    let turn_state = state.clone();
    let turn = tokio::spawn(async move {
        hold_turn_lock(&turn_state, Some(locked_tx)).await;
    });
    locked_rx.await.unwrap();

    let (code, spoken) = timeout(
        Duration::from_secs(1),
        request_json(
            &state,
            Method::POST,
            "/speak",
            Some(json!({"text":"Still working."})),
        ),
    )
    .await
    .expect("speak must stay live during an agent turn");
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        spoken,
        json!({"delivered":false, "reason":"no browser connected", "detail":"no browser connected"})
    );

    let (code, leg) = timeout(
        Duration::from_secs(1),
        request_json(
            &state,
            Method::POST,
            "/leg-state",
            Some(json!({"thinking":"high"})),
        ),
    )
    .await
    .expect("leg-state must stay live during session startup");
    assert_eq!(code, StatusCode::OK);
    assert_eq!(leg, json!({"accepted":false}));

    let (code, status) = timeout(
        Duration::from_secs(1),
        request_json(&state, Method::GET, "/status", None),
    )
    .await
    .expect("status must stay live during an agent turn");
    assert_eq!(code, StatusCode::OK);
    assert_eq!(status["route"], OPERATOR);

    let (code, health) = timeout(
        Duration::from_secs(1),
        request_json(&state, Method::GET, "/healthz", None),
    )
    .await
    .expect("health must stay live during an agent turn");
    assert_eq!(code, StatusCode::OK);
    assert_eq!(health["status"], "ok");

    turn.abort();
    assert!(turn.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn page_rescue_aborts_work_before_waiting_for_the_pbx_lock() {
    let state = state();
    let session = PiSession::start(
        vec!["sh".into(), "-c".into(), "sleep 60".into()],
        OPERATOR,
        None,
        None,
        Duration::from_secs(60),
        None,
    )
    .await
    .unwrap();
    *state.0.active_session.lock().await = Some(session.clone());

    let (locked_tx, locked_rx) = oneshot::channel();
    let turn_state = state.clone();
    let turn = tokio::spawn(async move {
        hold_turn_lock(&turn_state, Some(locked_tx)).await;
    });
    let abort = turn.abort_handle();
    state
        .0
        .active_operations
        .lock()
        .await
        .insert(abort.id(), abort);
    locked_rx.await.unwrap();

    let interrupted = timeout(Duration::from_secs(1), interrupt_active_turn(&state))
        .await
        .expect("rescue should not wait for the wedged turn");
    assert_eq!(interrupted.as_deref(), Some(OPERATOR));
    assert!(turn.await.unwrap_err().is_cancelled());
    assert!(!session.alive().await);
    assert!(timeout(Duration::from_secs(1), state.0.switchboard.lock())
        .await
        .is_ok());
}

#[tokio::test]
async fn speak_reports_failure_and_does_not_log_transcript_when_delivery_fails() {
    let state = state();
    let (code, spoken) = request_json(
        &state,
        Method::POST,
        "/speak",
        Some(json!({"text":"Hello world."})),
    )
    .await;
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(spoken["delivered"], false);
    assert_eq!(spoken["reason"], "no browser connected");
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
}

#[tokio::test]
async fn generation_mismatch_prevents_turn_spawn() {
    let state = state();
    let current = state.0.coordinator.generation();
    state.0.coordinator.begin_rescue("test bump");
    let result = spawn_registered_operation(&state, current, async move { 42 }).await;
    assert!(result.is_none());
}

#[tokio::test]
async fn newer_page_control_supersedes_setup_before_a_session_exists() {
    let state = state();
    let first_state = state.clone();
    let (first, first_id, _) = spawn_active_operation(&state, async move {
        hold_turn_lock(&first_state, None).await;
    })
    .await
    .unwrap();

    let second_state = state.clone();
    let (second, second_id, _generation) = spawn_replacing_operation(&state, async move {
        let _held_second = second_state.0.switchboard.lock().await;
        7
    })
    .await
    .unwrap();

    assert!(first.await.unwrap_err().is_cancelled());
    clear_active_operation(&state, first_id).await;
    assert_eq!(
        timeout(Duration::from_secs(1), second)
            .await
            .unwrap()
            .unwrap(),
        7
    );
    clear_active_operation(&state, second_id).await;
    assert!(state.0.active_operations.lock().await.is_empty());
}

#[tokio::test]
async fn superseded_reply_is_not_logged_or_broadcast() {
    let state = state();
    let mut events = state.0.events.subscribe();
    let generation = state.0.coordinator.generation();
    state.0.coordinator.begin_rescue("test rescue");
    let reply = crate::pbx::Reply {
        text: "stale result".into(),
        route: OPERATOR.into(),
        route_label: "Operator".into(),
        error: None,
        to_speak: Vec::new(),
        delivery_generation: None,
    };

    assert!(
        !deliver_page_reply_if_current(&state, &reply, current_status(&state), generation).await
    );
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
    assert!(matches!(
        events.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn queued_turn_from_before_page_rescue_never_reaches_the_new_leg() {
    let state = state();
    let mut events = state.0.events.subscribe();
    let old_generation = state.0.coordinator.generation();
    state.0.coordinator.begin_rescue("test rescue");
    state.0.queued_turns.store(1, Ordering::Release);
    let worker_state = state.clone();
    let worker = tokio::spawn(async move { process_turns(worker_state).await });
    state
        .0
        .turns
        .send(("old-clip".into(), "stale words".into(), old_generation))
        .await
        .unwrap();
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }

    assert!(!state.0.turn_in_flight.load(Ordering::Acquire));
    assert!(state.0.active_operations.lock().await.is_empty());
    let stale = events
        .try_recv()
        .expect("stale queued turn is acknowledged");
    assert!(matches!(stale, Event::Json(ref value) if value["code"] == "stale_epoch"));
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
}

#[test]
fn clip_headers_carry_an_optional_capture_epoch() {
    let header = |value: Value| parse_clip_header(value.as_object().unwrap());

    assert_eq!(
        header(json!({"type":"clip", "id":"a", "mime":"audio/webm", "generation":3})),
        Some(("a".into(), "audio/webm".into(), Some(3)))
    );
    // A browser that predates the epoch still works; the clip is stamped on
    // arrival instead, which is what every client used to do.
    assert_eq!(
        header(json!({"type":"clip", "id":"a", "mime":"audio/webm"})),
        Some(("a".into(), "audio/webm".into(), None))
    );
    // Anything that is not a plain count is ignored rather than trusted.
    assert_eq!(
        header(json!({"type":"clip", "id":"a", "generation":-1})),
        Some(("a".into(), String::new(), None))
    );
    assert_eq!(
        header(json!({"type":"clip", "id":"a", "generation":"7"})),
        Some(("a".into(), String::new(), None))
    );

    assert_eq!(header(json!({"type":"clip", "id":""})), None);
    assert_eq!(
        header(json!({"type":"clip", "id":"x".repeat(129)})),
        None,
        "an oversized id is still refused"
    );
    let long_mime = header(json!({"type":"clip", "id":"a", "mime":"m".repeat(400)}));
    assert_eq!(long_mime.unwrap().1.chars().count(), 100);
}

#[tokio::test]
async fn clip_accepted_before_a_page_rescue_is_dropped_after_transcription() {
    let state = state_with_stt(Some("printf 'stale words'".into()));
    let mut events = state.0.events.subscribe();
    state
        .0
        .clips
        .send(Clip {
            id: "old-clip".into(),
            audio: vec![0],
            _mime: "audio/webm".into(),
            generation: state.0.coordinator.generation(),
        })
        .await
        .unwrap();
    // The transfer lands while the clip is still inside the sidecar.
    state.0.coordinator.begin_rescue("test rescue");
    let worker_state = state.clone();
    let worker = tokio::spawn(async move { process_clips(worker_state).await });

    // The worker may finish transcription, but stale history and live
    // transcript events must be suppressed before either side effect.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
    let stale = events.try_recv().expect("stale clip is acknowledged");
    assert!(matches!(stale, Event::Json(ref value) if value["code"] == "stale_epoch"));
    assert_eq!(state.0.queued_turns.load(Ordering::Acquire), 0);
    let mut turns = state.0.turn_rx.lock().await.take().unwrap();
    assert!(matches!(
        turns.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn shutdown_notifies_upgraded_connections_before_reaping_the_pbx() {
    let state = state();
    let mut shutdown_notice = state.0.shutdown.subscribe();
    timeout(Duration::from_secs(1), shutdown(&state))
        .await
        .expect("shutdown should finish without a live leg");
    timeout(Duration::from_secs(1), shutdown_notice.changed())
        .await
        .expect("websocket shutdown notice should be immediate")
        .unwrap();
    assert!(*shutdown_notice.borrow());
}

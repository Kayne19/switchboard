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
    let config = crate::Config::for_tests(&[]);
    let registry = Registry::new(vec![]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("no projects are registered"),
    );
    let board = Switchboard::new(&config, registry, std::sync::Arc::new(prewarm));
    state_on_with_stream(board, stt, stream)
}

/// The application around `board`, with no speech-to-text configured.
fn state_on(board: Switchboard) -> AppState {
    state_on_with_stream(board, None, None)
}

fn state_on_with_stream(
    board: Switchboard,
    stt: Option<String>,
    stream: Option<String>,
) -> AppState {
    AppState::new(
        board,
        TranscriptLog::new(10),
        Speaker::from_values(
            100,
            std::time::Duration::from_millis(25_000),
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

async fn post_display_in_task(
    state: &AppState,
    body: Value,
) -> tokio::task::JoinHandle<(StatusCode, Value)> {
    let state = state.clone();
    tokio::spawn(async move { request_json(&state, Method::POST, "/display", Some(body)).await })
}

fn diagram_show() -> Value {
    json!({"action":{"op":"show","id":"d1","type":"diagram","data":{
        "mode":"graph","nodes":[{"id":"a","label":"A"}],"edges":[]}}})
}

#[tokio::test]
async fn healthz_reports_the_commit_the_binary_was_stamped_with() {
    // A deploy is checked with one request, so the stamp build.rs chose has to
    // reach /healthz verbatim, beside the fields existing consumers read.
    let (code, health) = request_json(&state(), Method::GET, "/healthz", None).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(health["git"], env!("SWITCHBOARD_GIT_SHA"));
    assert_eq!(health["git"], crate::GIT_SHA);
    assert!(!crate::GIT_SHA.is_empty());
    assert_eq!(health["status"], "ok");
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
    assert_eq!(state.0.coordinator.status().thinking_default, "high");

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
            "visual_kind": "document",
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
    assert_eq!(response["screen"]["has_visual"], false);
    assert_eq!(response["screen"]["visual_kind"], Value::Null);
    assert_eq!(response["screen"]["confirmed"], true);
}

#[tokio::test]
async fn view_reports_requested_diagram_as_unconfirmed_until_the_browser_acks() {
    let state = state();
    let (mut connection, _s, _w) = state.register_connection().await;
    let epoch = connection.epoch;

    let handle = post_display_in_task(&state, diagram_show()).await;
    let DeliveryFrame::Event { sequence, .. } = connection.receiver.recv().await.unwrap() else {
        panic!("expected a display event")
    };

    // Before the ack, view says diagram-but-not-confirmed.
    let (_c, before) =
        request_json(&state, Method::POST, "/view", Some(json!({"target":""}))).await;
    let screen = before.get("screen").unwrap();
    assert_eq!(
        screen.get("visual_kind").and_then(Value::as_str),
        Some("diagram")
    );
    assert_eq!(
        screen.get("confirmed").and_then(Value::as_bool),
        Some(false)
    );

    // After the ack, confirmed flips true.
    handle_text_frame(
        &state,
        epoch,
        &mut None,
        &mut None,
        &json!({"type":"screen_state","view":"auto","has_visual":true,
               "visual_kind":"diagram","applied_seq":sequence})
        .to_string(),
    )
    .await
    .unwrap();
    let _ = timeout(Duration::from_secs(2), handle)
        .await
        .unwrap()
        .unwrap();

    let (_c, after) = request_json(&state, Method::POST, "/view", Some(json!({"target":""}))).await;
    assert_eq!(
        after
            .get("screen")
            .unwrap()
            .get("confirmed")
            .and_then(Value::as_bool),
        Some(true)
    );
}

#[tokio::test]
async fn view_reports_first_non_ambient_object_when_nothing_is_focused_or_primary() {
    // Mirrors sceneModel.ts's buildCompositionModel: with no focus and no
    // explicit role:"primary", the composition primary is the FIRST
    // non-ambient object shown, not the most recently shown one. Before this
    // fix, DisplayProjection::summary() picked order.last() here, which
    // would report "document" (the second object) instead of "diagram"
    // (the first).
    let state = state();
    let (code, _) = request_json(
        &state,
        Method::POST,
        "/display",
        Some(json!({
            "token": "operator",
            "action": {
                "op": "show",
                "id": "first",
                "type": "diagram",
                "data": {
                    "title": "diagram-title",
                    "mode": "graph",
                    "nodes": [{"id": "n1", "label": "N1"}],
                    "edges": []
                }
            }
        })),
    )
    .await;
    assert_eq!(code, StatusCode::OK);

    let (code, _) = request_json(
        &state,
        Method::POST,
        "/display",
        Some(json!({
            "token": "operator",
            "action": {
                "op": "show",
                "id": "second",
                "type": "document",
                "data": {"subject": "document-title", "paragraphs": ["p1"]}
            }
        })),
    )
    .await;
    assert_eq!(code, StatusCode::OK);

    let (code, response) =
        request_json(&state, Method::POST, "/view", Some(json!({"target":""}))).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(response["screen"]["visual_kind"], "diagram");
    assert_eq!(response["screen"]["title"], "diagram-title");
}

#[tokio::test]
async fn view_reports_the_object_with_role_primary_even_when_shown_first() {
    // role:"primary" outranks a later, non-ambient object even though
    // nothing is focused -- matching sceneModel.ts's explicit-primary-wins
    // rule. This is the case that discriminates the fix from the old
    // order.last() logic: the primary object is shown FIRST here, so a
    // last-wins rule would (wrongly) report the second, non-primary object.
    let state = state();
    let (code, _) = request_json(
        &state,
        Method::POST,
        "/display",
        Some(json!({
            "token": "operator",
            "action": {
                "op": "show",
                "id": "first",
                "type": "document",
                "role": "primary",
                "data": {"subject": "document-title", "paragraphs": ["p1"]}
            }
        })),
    )
    .await;
    assert_eq!(code, StatusCode::OK);

    let (code, _) = request_json(
        &state,
        Method::POST,
        "/display",
        Some(json!({
            "token": "operator",
            "action": {
                "op": "show",
                "id": "second",
                "type": "diagram",
                "data": {
                    "title": "diagram-title",
                    "mode": "graph",
                    "nodes": [{"id": "n1", "label": "N1"}],
                    "edges": []
                }
            }
        })),
    )
    .await;
    assert_eq!(code, StatusCode::OK);

    let (code, response) =
        request_json(&state, Method::POST, "/view", Some(json!({"target":""}))).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(response["screen"]["visual_kind"], "document");
    assert_eq!(response["screen"]["title"], "document-title");
}

#[test]
fn a_later_primary_claim_takes_the_role_and_demotes_the_earlier_one() {
    // Mirrors the reducer in apps/frontend/src/controller/reducer.ts: only
    // the latest object shown with role:"primary" keeps it, and the one it
    // displaced stays on stage as secondary -- including in the snapshot a
    // reconnecting browser replays.
    let mut projection = DisplayProjection::default();
    let show = |id: &str, object_type: &str, role: Option<&str>| {
        let mut action = json!({"op":"show", "id":id, "type":object_type, "data":{"title":id}});
        if let Some(role) = role {
            action["role"] = json!(role);
        }
        action
    };

    projection.apply(&show("a", "diagram", Some("primary")), 1);
    projection.apply(&show("b", "code", Some("primary")), 2);
    let (_, kind, title, order) = projection.summary();
    assert_eq!(kind.as_deref(), Some("code"));
    assert_eq!(title.as_deref(), Some("b"));
    assert_eq!(order, vec!["a", "b"]);
    let replay = projection.snapshot_actions();
    assert_eq!(replay[0]["role"], "secondary");
    assert_eq!(replay[1]["role"], "primary");

    // An update that names no role leaves the primary where it is.
    projection.apply(&show("a", "diagram", None), 3);
    assert_eq!(projection.summary().1.as_deref(), Some("code"));

    // Re-claiming the role takes it back.
    projection.apply(&show("a", "diagram", Some("primary")), 4);
    assert_eq!(projection.summary().1.as_deref(), Some("diagram"));
    assert_eq!(projection.objects["b"].role.as_deref(), Some("secondary"));
}

#[test]
fn primary_metric_cluster_semantics_and_stable_claim_order() {
    // Primary metric cluster semantics (#38):
    // Metrics claiming primary join each other in a cluster.
    // A non-metric claim demotes all primary metrics.
    // A metric claim while a non-metric holds primary demotes the non-metric.
    // Removing one metric leaves the rest primary.
    // Cluster order is stable by claim order.
    let mut projection = DisplayProjection::default();
    let show_metric = |id: &str, label: &str, role: Option<&str>| {
        let mut action =
            json!({"op":"show", "id":id, "type":"metric", "data":{"label":label, "value":"10"}});
        if let Some(role) = role {
            action["role"] = json!(role);
        }
        action
    };
    let show_other = |id: &str, obj_type: &str, role: Option<&str>| {
        let mut action = json!({"op":"show", "id":id, "type":obj_type, "data":{"title":id}});
        if let Some(role) = role {
            action["role"] = json!(role);
        }
        action
    };

    // 1. Metric A claims primary
    projection.apply(&show_metric("m1", "CPU", Some("primary")), 1);
    assert_eq!(projection.objects["m1"].role.as_deref(), Some("primary"));

    // 2. Metric B claims primary -> joins metric A
    projection.apply(&show_metric("m2", "MEM", Some("primary")), 2);
    assert_eq!(projection.objects["m1"].role.as_deref(), Some("primary"));
    assert_eq!(projection.objects["m2"].role.as_deref(), Some("primary"));

    let (_, kind, title, _) = projection.summary();
    assert_eq!(kind.as_deref(), Some("metric"));
    assert_eq!(title.as_deref(), Some("CPU"));

    let replay = projection.snapshot_actions();
    assert_eq!(replay[0]["role"], "primary");
    assert_eq!(replay[1]["role"], "primary");

    // 3. Updating Metric A data preserves its leading position in claim order
    projection.apply(&show_metric("m1", "CPU", Some("primary")), 3);
    assert_eq!(projection.summary().2.as_deref(), Some("CPU"));

    // 4. Non-metric claims primary -> demotes all primary metrics
    projection.apply(&show_other("diag", "diagram", Some("primary")), 4);
    assert_eq!(projection.objects["diag"].role.as_deref(), Some("primary"));
    assert_eq!(projection.objects["m1"].role.as_deref(), Some("secondary"));
    assert_eq!(projection.objects["m2"].role.as_deref(), Some("secondary"));
    assert_eq!(projection.summary().1.as_deref(), Some("diagram"));

    // 5. Metric claim demotes non-metric primary
    projection.apply(&show_metric("m1", "CPU", Some("primary")), 5);
    assert_eq!(projection.objects["m1"].role.as_deref(), Some("primary"));
    assert_eq!(
        projection.objects["diag"].role.as_deref(),
        Some("secondary")
    );
    assert_eq!(projection.summary().1.as_deref(), Some("metric"));

    // 6. Metric B re-claims primary -> joins M1 at the end
    projection.apply(&show_metric("m2", "MEM", Some("primary")), 6);
    assert_eq!(projection.objects["m1"].role.as_deref(), Some("primary"));
    assert_eq!(projection.objects["m2"].role.as_deref(), Some("primary"));

    // 7. Removing one metric leaves the other primary
    projection.apply(&json!({"op":"hide", "id":"m1"}), 7);
    assert!(!projection.objects.contains_key("m1"));
    assert_eq!(projection.objects["m2"].role.as_deref(), Some("primary"));
    assert_eq!(projection.summary().2.as_deref(), Some("MEM"));
}

/// Each replayed show as `(id, role)`.
fn replay_shape(replay: &[Value]) -> Vec<(&str, Option<&str>)> {
    replay
        .iter()
        .map(|action| {
            (
                action["id"].as_str().unwrap_or_default(),
                action.get("role").and_then(Value::as_str),
            )
        })
        .collect()
}

#[test]
fn snapshot_actions_emits_primary_metrics_in_claim_order_even_if_created_earlier() {
    let mut projection = DisplayProjection::default();
    let show_metric = |id: &str, label: &str, role: Option<&str>| {
        let mut action =
            json!({"op":"show", "id":id, "type":"metric", "data":{"label":label, "value":"10"}});
        if let Some(role) = role {
            action["role"] = json!(role);
        }
        action
    };

    // Show m-sec as secondary, show m-prim as primary, then re-show m-sec claiming primary
    projection.apply(&show_metric("m-sec", "SECONDARY", Some("secondary")), 1);
    projection.apply(&show_metric("m-prim", "PRIMARY", Some("primary")), 2);
    projection.apply(&show_metric("m-sec", "SECONDARY", Some("primary")), 3);

    // Every object is replayed in show order, so a reconnecting browser
    // rebuilds the same agentOrder; m-sec claims the role only after m-prim,
    // so it rebuilds the same cluster order too. The browser test
    // `replaying the backend snapshot rebuilds show order and cluster order`
    // applies exactly this sequence.
    let replay = projection.snapshot_actions();
    assert_eq!(
        replay_shape(&replay),
        vec![
            ("m-sec", None),
            ("m-prim", Some("primary")),
            ("m-sec", Some("primary"))
        ]
    );

    let mut replayed = DisplayProjection::default();
    for (sequence, action) in replay.iter().enumerate() {
        replayed.apply(action, sequence as u64 + 1);
    }
    assert_eq!(replayed.order, projection.order);
    assert_eq!(replayed.snapshot_actions(), replay);
    assert_eq!(replayed.summary(), projection.summary());
}

#[test]
fn snapshot_replay_keeps_show_order_when_claim_order_differs() {
    // A cluster re-claimed in the opposite order to its show order: the
    // replay must not swap the metrics' positions, or a later demotion would
    // lay the rail out differently after a reconnect.
    let mut projection = DisplayProjection::default();
    let show = |id: &str, object_type: &str, role: Option<&str>| {
        let mut action =
            json!({"op":"show", "id":id, "type":object_type, "data":{"label":id, "value":"1"}});
        if let Some(role) = role {
            action["role"] = json!(role);
        }
        action
    };
    projection.apply(&show("m1", "metric", Some("primary")), 1);
    projection.apply(&show("m2", "metric", Some("primary")), 2);
    projection.apply(&show("diag", "diagram", Some("primary")), 3);
    projection.apply(&show("m2", "metric", Some("primary")), 4);
    projection.apply(&show("m1", "metric", Some("primary")), 5);
    assert_eq!(projection.summary().2.as_deref(), Some("m2"));

    // The browser test `replaying the backend snapshot rebuilds show order
    // and cluster order` applies exactly this sequence.
    let replay = projection.snapshot_actions();
    assert_eq!(
        replay_shape(&replay),
        vec![
            ("m1", None),
            ("m2", Some("primary")),
            ("diag", Some("secondary")),
            ("m1", Some("primary")),
        ]
    );
    let mut replayed = DisplayProjection::default();
    for (sequence, action) in replay.iter().enumerate() {
        replayed.apply(action, sequence as u64 + 1);
    }
    assert_eq!(replayed.order, vec!["m1", "m2", "diag"]);
    assert_eq!(replayed.summary(), projection.summary());

    // The same later demotion leaves both projections alike.
    let chart = show("chart", "chart", Some("primary"));
    projection.apply(&chart, 6);
    replayed.apply(&chart, 99);
    assert_eq!(replayed.snapshot_actions(), projection.snapshot_actions());
}

#[test]
fn the_primary_metric_cap_matches_the_browser_reducer() {
    // The browser applies the same cluster rule with its own constant; if
    // the two caps differ, /view and the page disagree on which metrics hold
    // the primary viewport.
    let reducer = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/apps/frontend/src/controller/reducer.ts"
    ))
    .expect("read the browser reducer");
    let declared = reducer.lines().find_map(|line| {
        line.trim()
            .strip_prefix("export const MAX_PRIMARY_METRICS = ")
            .and_then(|rest| rest.trim_end_matches(';').parse::<usize>().ok())
    });
    assert_eq!(declared, Some(MAX_PRIMARY_METRICS));
}

#[test]
fn primary_metric_cluster_is_capped_and_the_earliest_claim_gives_way() {
    let mut projection = DisplayProjection::default();
    let show_metric = |id: &str| json!({"op":"show", "id":id, "type":"metric", "role":"primary", "data":{"label":id, "value":"1"}});
    for n in 0..MAX_PRIMARY_METRICS {
        projection.apply(&show_metric(&format!("m{n}")), n as u64 + 1);
    }
    let primaries = |projection: &DisplayProjection| {
        let mut ids: Vec<String> = projection
            .order
            .iter()
            .filter(|id| projection.objects[*id].role.as_deref() == Some("primary"))
            .cloned()
            .collect();
        ids.sort();
        ids
    };
    assert_eq!(primaries(&projection).len(), MAX_PRIMARY_METRICS);

    // Updating a member of a full cluster evicts nobody.
    projection.apply(&show_metric("m3"), 20);
    assert_eq!(primaries(&projection).len(), MAX_PRIMARY_METRICS);
    assert_eq!(projection.objects["m0"].role.as_deref(), Some("primary"));

    // One more claimant demotes the earliest claim, m0, which stays on stage.
    projection.apply(&show_metric("extra"), 21);
    assert_eq!(primaries(&projection).len(), MAX_PRIMARY_METRICS);
    assert_eq!(projection.objects["m0"].role.as_deref(), Some("secondary"));
    assert_eq!(projection.objects["extra"].role.as_deref(), Some("primary"));
    assert_eq!(projection.summary().2.as_deref(), Some("m1"));
}

#[test]
fn a_primary_that_changes_type_reclaims_the_role_under_its_new_type() {
    let mut projection = DisplayProjection::default();
    let show = |id: &str, object_type: &str, role: Option<&str>| {
        let mut action =
            json!({"op":"show", "id":id, "type":object_type, "data":{"title":id, "label":id}});
        if let Some(role) = role {
            action["role"] = json!(role);
        }
        action
    };
    projection.apply(&show("m1", "metric", Some("primary")), 1);
    projection.apply(&show("m2", "metric", Some("primary")), 2);
    // m1 becomes a chart without naming a role: it keeps primary, and a
    // chart never shares the viewport with the metric cluster.
    projection.apply(&show("m1", "chart", None), 3);
    assert_eq!(projection.objects["m1"].role.as_deref(), Some("primary"));
    assert_eq!(projection.objects["m2"].role.as_deref(), Some("secondary"));
    let (_, kind, title, _) = projection.summary();
    assert_eq!(kind.as_deref(), Some("chart"));
    assert_eq!(title.as_deref(), Some("m1"));
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
        [Event::AudioChunk { audio }] if audio == &[1]
    ));
    let events = queue.finish(first, 3);
    assert!(matches!(
        events.as_slice(),
        [
            Event::AudioDone { sequence: 0, .. },
            Event::AudioStart { sequence: 1, .. },
            Event::AudioChunk { audio },
            Event::AudioDone { sequence: 1, .. }
        ] if audio == &[2]
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

    assert!(deliver_turn_if_current(&state, &reply, generation, "clip-1",).await);
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

    assert!(!deliver_turn_if_current(&state, &reply, generation, "stale-clip").await);
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
        [Event::AudioChunk { audio }] if audio == &[7]
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

    assert!(!deliver_page_reply_if_current(&state, &reply, generation).await);
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

async fn next_event_of(events: &mut broadcast::Receiver<Event>, event_type: &str) -> Value {
    timeout(Duration::from_secs(1), async {
        loop {
            if let Ok(Event::Json(value)) = events.recv().await {
                if value["type"] == event_type {
                    return value;
                }
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no {event_type} event"))
}

#[tokio::test]
async fn typed_turn_is_logged_echoed_and_queued_like_a_transcript() {
    let state = state();
    let mut events = state.0.events.subscribe();
    let connection = state.0.delivery.register();
    let generation = state.0.coordinator.generation();
    let frame = json!({"type":"typed_turn", "id":"typed-1", "generation":generation, "text":"  deploy it  "});
    handle_text_frame(
        &state,
        connection.epoch,
        &mut None,
        &mut None,
        &frame.to_string(),
    )
    .await
    .unwrap();

    let echo = next_event_of(&mut events, "transcript").await;
    assert_eq!(echo["id"], "typed-1");
    assert_eq!(echo["text"], "deploy it");
    let entries = state.0.transcript_log.lock().await.entries();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].text, "deploy it");
    assert_eq!(entries[0].role, CALLER);
    assert_eq!(entries[0].id.as_deref(), Some("typed-1"));
    let mut turns = state.0.turn_rx.lock().await.take().unwrap();
    let (id, text, turn_generation) = turns.try_recv().expect("typed turn is queued");
    assert_eq!(
        (id.as_str(), text.as_str(), turn_generation),
        ("typed-1", "deploy it", generation)
    );
}

#[tokio::test]
async fn typed_turn_from_a_retired_epoch_is_dropped() {
    let state = state();
    let mut events = state.0.events.subscribe();
    let connection = state.0.delivery.register();
    let old_generation = state.0.coordinator.generation();
    state.0.coordinator.begin_rescue("test rescue");
    let frame = json!({"type":"typed_turn", "id":"typed-old", "generation":old_generation, "text":"stale words"});
    handle_text_frame(
        &state,
        connection.epoch,
        &mut None,
        &mut None,
        &frame.to_string(),
    )
    .await
    .unwrap();

    let stale = next_event_of(&mut events, "error").await;
    assert_eq!(stale["code"], "stale_epoch");
    assert_eq!(stale["id"], "typed-old");
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
}

#[tokio::test]
async fn malformed_typed_turns_are_refused_on_the_connection() {
    let state = state();
    let mut connection = state.0.delivery.register();
    let epoch = connection.epoch;
    let generation = state.0.coordinator.generation();
    for frame in [
        json!({"type":"typed_turn", "id":"t", "generation":generation, "text":"   "}),
        json!({"type":"typed_turn", "id":"t", "generation":generation, "text":"x".repeat(MAX_TYPED_TURN_CHARS + 1)}),
        json!({"type":"typed_turn", "id":"", "generation":generation, "text":"hi"}),
        json!({"type":"typed_turn", "id":"t", "text":"hi"}),
    ] {
        handle_text_frame(&state, epoch, &mut None, &mut None, &frame.to_string())
            .await
            .unwrap();
        let reply = next_delivery(&mut connection).await;
        assert_eq!(reply["type"], "error", "{frame}");
    }
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
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

#[tokio::test]
async fn display_protocol_validation_and_composition() {
    let state = state();
    let mut events = state.0.events.subscribe();

    // 1. Conformance check against canonical fixtures
    let fixtures_str = std::fs::read_to_string("apps/frontend/tests/fixtures/display-actions.json")
        .expect("canonical display-actions.json fixtures must load");
    let fixtures: Value = serde_json::from_str(&fixtures_str).unwrap();

    for case in fixtures["valid"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let action = &case["action"];
        let expected = &case["normalized"];
        let validated = crate::visual_protocol::validate_action(action)
            .unwrap_or_else(|e| panic!("valid case '{name}' failed validation: {e}"));
        assert_eq!(
            &validated, expected,
            "normalized mismatch for valid case '{name}'"
        );
    }

    // 2. Composed scene HTTP intake and replay
    let show = json!({
        "token": "operator",
        "action": {
            "op": "show",
            "id": "main",
            "type": "diagram",
            "role": "primary",
            "data": {
                "mode": "graph",
                "nodes": [{"id": "n1", "label": "Start"}],
                "edges": []
            }
        }
    });
    let (code, _) = request_json(&state, Method::POST, "/display", Some(show)).await;
    assert_eq!(code, StatusCode::OK);
    let Event::Json(event) = events.recv().await.unwrap() else {
        panic!("expected event")
    };
    assert_eq!(event["type"], "display");
    assert_eq!(event["action"]["id"], "main");
    assert_eq!(*state.0.last_display.lock().await, Some(event));
    for (id, role) in [("compare", "compare"), ("secondary", "secondary")] {
        let (code, _) = request_json(
            &state,
            Method::POST,
            "/display",
            Some(json!({
                "token": "operator",
                "action": {
                    "op": "show",
                    "id": id,
                    "type": "metric",
                    "role": role,
                    "data": {"label": id, "value": "1"}
                }
            })),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert!(matches!(events.recv().await.unwrap(), Event::Json(_)));
    }
    let (code, _) = request_json(
        &state,
        Method::POST,
        "/display",
        Some(json!({
            "token": "operator",
            "action": {
                "op": "say",
                "text": "point",
                "target": "main",
                "at": {"x": 2.0, "series": "a"}
            }
        })),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert!(matches!(events.recv().await.unwrap(), Event::Json(_)));
}

#[tokio::test]
async fn display_protocol_rejects_invalid_actions() {
    let state = state();

    let fixtures_str = std::fs::read_to_string("apps/frontend/tests/fixtures/display-actions.json")
        .expect("canonical display-actions.json fixtures must load");
    let fixtures: Value = serde_json::from_str(&fixtures_str).unwrap();

    for case in fixtures["invalid"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let action = &case["action"];
        let result = crate::visual_protocol::validate_action(action);
        assert!(
            result.is_err(),
            "invalid case '{name}' should have been rejected by validate_action"
        );

        let (code, _) = request_json(
            &state,
            Method::POST,
            "/display",
            Some(json!({"token": "operator", "action": action.clone()})),
        )
        .await;
        assert_eq!(
            code,
            StatusCode::BAD_REQUEST,
            "HTTP /display should reject invalid case '{name}'"
        );
    }

    let oversized =
        json!({"token": "operator", "action": {"op": "say", "text": "x".repeat(50_001)}});
    assert_eq!(
        request_json(&state, Method::POST, "/display", Some(oversized))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn display_projection_hide_clears_focus() {
    let state = state();
    let mut events = state.0.events.subscribe();

    // 1. Show primary chart
    let show_chart = json!({
        "token": "operator",
        "action": {
            "op": "show",
            "id": "chart-1",
            "type": "chart",
            "role": "primary",
            "data": {
                "title": "Latency",
                "series": [{"name": "p95", "values": [10.0, 20.0, 30.0]}]
            }
        }
    });
    let (code, _) = request_json(&state, Method::POST, "/display", Some(show_chart)).await;
    assert_eq!(code, StatusCode::OK);
    let _ = events.recv().await.unwrap();

    // 2. Show secondary document
    let show_doc = json!({
        "token": "operator",
        "action": {
            "op": "show",
            "id": "doc-1",
            "type": "document",
            "role": "secondary",
            "data": {
                "subject": "Release Notes",
                "paragraphs": ["Initial release."]
            }
        }
    });
    let (code, _) = request_json(&state, Method::POST, "/display", Some(show_doc)).await;
    assert_eq!(code, StatusCode::OK);
    let _ = events.recv().await.unwrap();

    // 3. Focus chart-1
    let focus_chart = json!({
        "token": "operator",
        "action": {
            "op": "focus",
            "id": "chart-1"
        }
    });
    let (code, _) = request_json(&state, Method::POST, "/display", Some(focus_chart)).await;
    assert_eq!(code, StatusCode::OK);
    let _ = events.recv().await.unwrap();

    // 4. Say targeting chart-1
    let say_chart = json!({
        "token": "operator",
        "action": {
            "op": "say",
            "text": "Notice the p95 spike here.",
            "target": "chart-1",
            "at": {"x": 20.0}
        }
    });
    let (code, _) = request_json(&state, Method::POST, "/display", Some(say_chart)).await;
    assert_eq!(code, StatusCode::OK);
    let _ = events.recv().await.unwrap();

    // Verify projection state under gate
    {
        let gate = state.0.display_gate.lock().await;
        assert_eq!(gate.projection.order, vec!["chart-1", "doc-1"]);
        assert_eq!(gate.projection.focus_id.as_deref(), Some("chart-1"));
        assert!(gate.projection.speech.is_some());
        assert_eq!(
            gate.projection.speech.as_ref().unwrap().target.as_deref(),
            Some("chart-1")
        );
    }

    // 5. Hide chart-1 -> must remove chart-1, clear focus, and clear speech targeting chart-1
    let hide_chart = json!({
        "token": "operator",
        "action": {
            "op": "hide",
            "id": "chart-1"
        }
    });
    let (code, _) = request_json(&state, Method::POST, "/display", Some(hide_chart)).await;
    assert_eq!(code, StatusCode::OK);
    let _ = events.recv().await.unwrap();

    {
        let gate = state.0.display_gate.lock().await;
        assert_eq!(gate.projection.order, vec!["doc-1"]);
        assert!(!gate.projection.objects.contains_key("chart-1"));
        assert!(gate.projection.objects.contains_key("doc-1"));
        assert_eq!(
            gate.projection.focus_id, None,
            "hide must clear focus when focused object is hidden"
        );
        assert!(
            gate.projection.speech.is_none(),
            "hide must clear speech targeting the hidden object"
        );

        let snapshot = gate.projection.snapshot_actions();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0]["id"], "doc-1");
    }

    // 6. Idempotent hide: hiding chart-1 again does not fail or alter projection
    let hide_again = json!({
        "token": "operator",
        "action": {
            "op": "hide",
            "id": "chart-1"
        }
    });
    let (code, _) = request_json(&state, Method::POST, "/display", Some(hide_again)).await;
    assert_eq!(code, StatusCode::OK);
    {
        let gate = state.0.display_gate.lock().await;
        assert_eq!(gate.projection.order, vec!["doc-1"]);
    }

    // 7. General say without target: hiding doc-1 should NOT clear speech that is not targeted at doc-1
    let general_say = json!({
        "token": "operator",
        "action": {
            "op": "say",
            "text": "General announcement.",
            "target": null,
            "at": null
        }
    });
    let (code, _) = request_json(&state, Method::POST, "/display", Some(general_say)).await;
    assert_eq!(code, StatusCode::OK);

    let hide_doc = json!({
        "token": "operator",
        "action": {
            "op": "hide",
            "id": "doc-1"
        }
    });
    let (code, _) = request_json(&state, Method::POST, "/display", Some(hide_doc)).await;
    assert_eq!(code, StatusCode::OK);

    {
        let gate = state.0.display_gate.lock().await;
        assert!(gate.projection.objects.is_empty());
        assert!(
            gate.projection.speech.is_some(),
            "non-targeted speech must be preserved when an object is hidden"
        );
        assert_eq!(
            gate.projection.speech.as_ref().unwrap().text,
            "General announcement."
        );
    }
}

#[tokio::test]
async fn display_projection_generation_race() {
    let state = state();

    // Initial operator leg: token is "operator", generation is 0.
    let valid_display = json!({
        "token": "operator",
        "action": {
            "op": "show",
            "id": "chart-init",
            "type": "metric",
            "role": "primary",
            "data": {"label": "cpu", "value": "10%"}
        }
    });
    let (code, _) = request_json(&state, Method::POST, "/display", Some(valid_display)).await;
    assert_eq!(code, StatusCode::OK);

    let valid_view = json!({
        "token": "operator",
        "target": "visual",
        "reason": "inspect"
    });
    let (code, _) = request_json(&state, Method::POST, "/view", Some(valid_view)).await;
    assert_eq!(code, StatusCode::OK);

    // Now rescue occurs: bumps generation and rotates leg token!
    let next_leg = state.0.coordinator.begin_rescue("operator rescue");
    assert_eq!(next_leg.generation, 1);
    assert_ne!(next_leg.token, "operator");

    // Stale token from earlier generation must be rejected with 409 CONFLICT!
    let stale_display = json!({
        "token": "operator",
        "action": {
            "op": "show",
            "id": "chart-stale",
            "type": "metric",
            "role": "primary",
            "data": {"label": "cpu", "value": "99%"}
        }
    });
    let (code, resp) = request_json(&state, Method::POST, "/display", Some(stale_display)).await;
    assert_eq!(code, StatusCode::CONFLICT);
    assert_eq!(resp["code"], "invalid_leg");

    // Verify stale display DID NOT mutate projection
    {
        let gate = state.0.display_gate.lock().await;
        assert!(!gate.projection.objects.contains_key("chart-stale"));
    }

    // Stale token on /view must also be rejected with 409 CONFLICT!
    let stale_view = json!({
        "token": "operator",
        "target": "theater",
        "reason": "late"
    });
    let (code, resp) = request_json(&state, Method::POST, "/view", Some(stale_view)).await;
    assert_eq!(code, StatusCode::CONFLICT);
    assert_eq!(resp["code"], "invalid_leg");

    // Settle back onto the operator so new calls can proceed with the rotated
    // token.
    state.0.coordinator.settle();
    let current_token = state.0.coordinator.current_identity().token;

    let fresh_display = json!({
        "token": current_token,
        "action": {
            "op": "show",
            "id": "chart-fresh",
            "type": "metric",
            "role": "primary",
            "data": {"label": "cpu", "value": "25%"}
        }
    });
    let (code, _) = request_json(&state, Method::POST, "/display", Some(fresh_display)).await;
    assert_eq!(code, StatusCode::OK);
}

#[tokio::test]
async fn display_reports_rendered_only_after_the_browser_confirms() {
    let state = state();
    let (mut connection, _snapshot, _wm) = state.register_connection().await;
    let epoch = connection.epoch;

    let handle = post_display_in_task(&state, diagram_show()).await;

    // The delivered display frame carries a seq the browser will echo.
    let DeliveryFrame::Event { sequence, .. } = connection.receiver.recv().await.unwrap() else {
        panic!("expected a display event")
    };

    // Browser confirms it rendered up to `sequence`.
    handle_text_frame(
        &state,
        epoch,
        &mut None,
        &mut None,
        &json!({"type":"screen_state","view":"auto","has_visual":true,
               "visual_kind":"diagram","applied_seq":sequence})
        .to_string(),
    )
    .await
    .unwrap();

    let (code, body) = timeout(Duration::from_secs(2), handle)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(code, StatusCode::OK);
    assert_eq!(body.get("rendered").and_then(Value::as_bool), Some(true));
}

#[tokio::test]
async fn display_reports_unconfirmed_when_the_browser_stays_silent() {
    let state = state();
    let (connection, _s, _w) = state.register_connection().await;
    let _ = connection.receiver; // keep the connection alive, never ack
    let (code, body) = request_json(&state, Method::POST, "/display", Some(diagram_show())).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(body.get("delivered").and_then(Value::as_bool), Some(true));
    assert_eq!(body.get("rendered").and_then(Value::as_bool), Some(false));
}

#[tokio::test]
async fn display_reports_rejection_from_the_browser() {
    let state = state();
    let (mut connection, _s, _w) = state.register_connection().await;
    let epoch = connection.epoch;
    let handle = post_display_in_task(&state, diagram_show()).await;
    let DeliveryFrame::Event { sequence, .. } = connection.receiver.recv().await.unwrap() else {
        panic!("expected a display event")
    };
    handle_text_frame(
        &state,
        epoch,
        &mut None,
        &mut None,
        &json!({"type":"screen_state","view":"auto","has_visual":false,
               "rejected":{"seq":sequence,"reason":"unsupported node shape"}})
        .to_string(),
    )
    .await
    .unwrap();
    let (_code, body) = timeout(Duration::from_secs(2), handle)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(body.get("rejected").and_then(Value::as_bool), Some(true));
    assert_eq!(
        body.get("reason").and_then(Value::as_str),
        Some("unsupported node shape")
    );
}

#[tokio::test]
async fn display_projection_snapshot_watermark() {
    let state = state();

    // 1. Post two display actions to set up projection state
    for id in ["obj-1", "obj-2"] {
        let (code, _) = request_json(
            &state,
            Method::POST,
            "/display",
            Some(json!({
                "token": "operator",
                "action": {
                    "op": "show",
                    "id": id,
                    "type": "metric",
                    "role": "primary",
                    "data": {"label": id, "value": "100"}
                }
            })),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
    }

    // 2. Connect a WebSocket client
    let (mut connection, snapshot_actions, watermark) = state.register_connection().await;

    // Snapshot contains obj-1 and obj-2
    assert_eq!(snapshot_actions.len(), 2);
    assert_eq!(snapshot_actions[0]["id"], "obj-1");
    assert_eq!(snapshot_actions[1]["id"], "obj-2");

    // 3. Publish a fresh display action with sequence > watermark. A browser
    // is connected, so /display now waits for a render confirmation; ack it
    // promptly from the connection so this test does not stall.
    let epoch = connection.epoch;
    let handle = post_display_in_task(
        &state,
        json!({
            "token": "operator",
            "action": {
                "op": "show",
                "id": "obj-3",
                "type": "metric",
                "role": "secondary",
                "data": {"label": "obj-3", "value": "300"}
            }
        }),
    )
    .await;

    // In delivery connection receiver:
    // The fresh event obj-3 is queued in connection.receiver with sequence > watermark
    let frame = connection.receiver.recv().await.unwrap();
    let sequence = match frame {
        DeliveryFrame::Event { sequence, event } => {
            assert!(sequence > watermark);
            let Event::Json(val) = event else {
                panic!("expected json event")
            };
            assert_eq!(val["type"], "display");
            assert_eq!(val["action"]["id"], "obj-3");
            sequence
        }
        _ => panic!("expected event frame"),
    };

    handle_text_frame(
        &state,
        epoch,
        &mut None,
        &mut None,
        &json!({"type":"screen_state","view":"auto","has_visual":true,
               "visual_kind":"metric","applied_seq":sequence})
        .to_string(),
    )
    .await
    .unwrap();

    let (code, _) = timeout(Duration::from_secs(2), handle)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(code, StatusCode::OK);
}

#[tokio::test]
async fn display_projection_route_reset() {
    let state = state();

    // Populate projection with objects, focus, speech
    let show = json!({
        "token": "operator",
        "action": {
            "op": "show",
            "id": "scene-obj",
            "type": "metric",
            "role": "primary",
            "data": {"label": "v", "value": "1"}
        }
    });
    let (code, _) = request_json(&state, Method::POST, "/display", Some(show)).await;
    assert_eq!(code, StatusCode::OK);

    let focus = json!({
        "token": "operator",
        "action": {"op": "focus", "id": "scene-obj"}
    });
    let (code, _) = request_json(&state, Method::POST, "/display", Some(focus)).await;
    assert_eq!(code, StatusCode::OK);

    // Check that projection is populated
    {
        let gate = state.0.display_gate.lock().await;
        assert_eq!(gate.projection.order.len(), 1);
        assert_eq!(gate.projection.focus_id.as_deref(), Some("scene-obj"));
    }

    // Trigger route reset by invoking announce_route on switchboard
    state.0.switchboard.lock().await.announce_route().await;

    // Verify projection is empty and snapshot returns empty
    {
        let gate = state.0.display_gate.lock().await;
        assert!(gate.projection.objects.is_empty());
        assert!(gate.projection.order.is_empty());
        assert_eq!(gate.projection.focus_id, None);
        assert!(gate.projection.speech.is_none());
        assert_eq!(gate.screen_state["stale"], true);
        assert!(gate.projection.snapshot_actions().is_empty());
    }
}

// A transfer is announced twice: when the incoming agent first shows life or
// acts (candidate promotion), and when the PBX settles the transfer after the
// intro turn (the route callback). Only the first may reset the caller's
// screen. The second used to reset it again, wiping whatever the new agent had
// already drawn and cutting off its first words (issue #22).

fn begin_alpha_candidate(state: &AppState, token: &str) {
    state
        .0
        .coordinator
        .begin_candidate(crate::lifecycle::CandidateLeg::new(
            "alpha",
            "alpha",
            "pi-session",
            token,
            "anthropic/opus",
            "medium",
        ))
        .unwrap();
}

/// A delivery frame as the browser would read it; display frames carry the
/// sequence the socket writer stamps on them.
fn frame_json(frame: DeliveryFrame) -> Option<Value> {
    match frame {
        DeliveryFrame::Event { sequence, event } => match stamp_display_seq(event, sequence) {
            Event::Json(value) => Some(value),
            _ => None,
        },
        DeliveryFrame::Message(Message::Text(text)) => Some(serde_json::from_str(&text).unwrap()),
        DeliveryFrame::Message(_) => None,
    }
}

/// Receives frames up to and including the first of type `until`.
async fn frames_until(connection: &mut DeliveryConnection, until: &str) -> Vec<Value> {
    let mut frames = Vec::new();
    loop {
        let frame = timeout(Duration::from_secs(2), connection.receiver.recv())
            .await
            .expect("a frame before the deadline")
            .expect("an open connection");
        let Some(value) = frame_json(frame) else {
            continue;
        };
        let done = value["type"] == until;
        frames.push(value);
        if done {
            return frames;
        }
    }
}

/// Every frame already waiting on the connection.
fn queued_frames(connection: &mut DeliveryConnection) -> Vec<Value> {
    std::iter::from_fn(|| connection.receiver.try_recv().ok())
        .filter_map(frame_json)
        .collect()
}

fn types_of(frames: &[Value]) -> Vec<&str> {
    frames
        .iter()
        .filter_map(|frame| frame["type"].as_str())
        .collect()
}

/// The PBX finishing a transfer to the leg the coordinator already holds.
async fn settle_transfer(state: &AppState) {
    state.0.leg_announcer.announce_route().await;
}

#[tokio::test]
async fn a_first_display_from_the_incoming_leg_survives_the_transfer_settling() {
    let state = state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    begin_alpha_candidate(&state, "alpha-leg");

    // The incoming agent's first act is a drawing, which promotes its leg.
    let mut show = diagram_show();
    show["token"] = json!("alpha-leg");
    let handle = post_display_in_task(&state, show).await;
    let frames = frames_until(&mut connection, "display").await;
    assert_eq!(
        types_of(&frames),
        [
            "candidate",
            "candidate_cleared",
            "epoch",
            "status",
            "display"
        ]
    );
    let generation = frames[2]["generation"].as_u64().unwrap();
    assert_eq!(generation, 1);

    handle_text_frame(
        &state,
        connection.epoch,
        &mut None,
        &mut None,
        &json!({"type":"screen_state","view":"auto","has_visual":true,
               "visual_kind":"diagram","generation":generation,
               "applied_seq":frames[4]["seq"]})
        .to_string(),
    )
    .await
    .unwrap();
    let (_code, body) = timeout(Duration::from_secs(2), handle)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(body["rendered"], true);
    assert_eq!(
        types_of(&queued_frames(&mut connection)),
        ["screen_state_ack"]
    );

    // The intro turn ends and the PBX settles on the leg already on screen.
    settle_transfer(&state).await;

    assert_eq!(
        types_of(&queued_frames(&mut connection)),
        ["status"],
        "settling an announced leg must not reset the screen again"
    );
    assert!(state
        .0
        .display_gate
        .lock()
        .await
        .projection
        .objects
        .contains_key("d1"));
    let (_code, view) = request_json(
        &state,
        Method::POST,
        "/view",
        Some(json!({"token":"alpha-leg"})),
    )
    .await;
    assert_eq!(view["screen"]["has_visual"], true);
    assert_eq!(view["screen"]["confirmed"], true);
}

#[tokio::test]
async fn the_incoming_legs_first_words_are_not_cut_off_by_the_transfer_settling() {
    let state = state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    begin_alpha_candidate(&state, "alpha-leg");

    // The agent's first streamed text is the sign of life that promotes it,
    // and it may already be speaking when the intro turn ends.
    assert!(state.0.leg_announcer.promote_candidate("alpha-leg").await);
    assert_eq!(
        types_of(&queued_frames(&mut connection)),
        ["candidate", "candidate_cleared", "epoch", "status"]
    );

    // A second epoch would make the browser drop that speech and the words on
    // screen with it.
    settle_transfer(&state).await;
    assert_eq!(types_of(&queued_frames(&mut connection)), ["status"]);
}

#[tokio::test]
async fn returning_to_the_operator_still_clears_the_project_scene() {
    let state = state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    begin_alpha_candidate(&state, "alpha-leg");
    let mut show = diagram_show();
    show["token"] = json!("alpha-leg");
    let handle = post_display_in_task(&state, show).await;
    frames_until(&mut connection, "display").await;
    handle.abort();
    settle_transfer(&state).await;
    queued_frames(&mut connection);

    // Handing back keeps the generation and changes the route. Hanging up the
    // project leg is the shortest way there.
    assert_eq!(
        state.0.switchboard.lock().await.force_hangup().await,
        Some("alpha".to_owned())
    );

    let returned = queued_frames(&mut connection);
    assert_eq!(types_of(&returned), ["epoch", "status"]);
    assert_eq!(returned[0]["generation"], 1);
    assert_eq!(returned[1]["route"], OPERATOR);
    assert!(state
        .0
        .display_gate
        .lock()
        .await
        .projection
        .objects
        .is_empty());
}

#[tokio::test]
async fn display_projection_screen_state_retirement() {
    let state = state();
    let (conn1, _, _) = state.register_connection().await;
    let epoch1 = conn1.epoch;

    let mut pending_header = None;
    let mut pending_chunk = None;

    let current_gen = state.0.coordinator.generation();

    // 1. Connection 1 sends valid screen_state report
    handle_text_frame(
        &state,
        epoch1,
        &mut pending_header,
        &mut pending_chunk,
        &json!({
            "type": "screen_state",
            "view": "visual",
            "pinned": false,
            "has_visual": true,
            "visual_kind": "chart",
            "object_ids": ["chart-1"],
            "title": "CPU Metrics",
            "stale": false,
            "generation": current_gen,
        })
        .to_string(),
    )
    .await
    .unwrap();

    // Verify view tool sees the active report
    let (code, resp) = request_json(
        &state,
        Method::POST,
        "/view",
        Some(json!({"token": "operator", "target": ""})),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(resp["screen"]["view"], "visual");
    assert_eq!(resp["screen"]["visual_kind"], Value::Null);
    assert_eq!(resp["screen"]["stale"], false);

    // 2. Connection 1 is retired (browser disconnects)
    state.retire_connection(epoch1).await;
    let (code, resp) = request_json(
        &state,
        Method::POST,
        "/view",
        Some(json!({"token": "operator", "target": ""})),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        resp["screen"]["connected"], false,
        "retiring the only connection must report the browser as disconnected"
    );
    assert_eq!(
        resp["screen"]["stale"], false,
        "nothing was ever displayed, so an empty stage stays trivially confirmed"
    );

    // 4. Late report from retired connection 1 must be ignored!
    handle_text_frame(
        &state,
        epoch1,
        &mut pending_header,
        &mut pending_chunk,
        &json!({
            "type": "screen_state",
            "view": "theater",
            "pinned": true,
            "has_visual": true,
            "visual_kind": "diagram",
            "object_ids": ["diag-1"],
            "title": "Late Report",
            "stale": false,
            "generation": current_gen,
        })
        .to_string(),
    )
    .await
    .unwrap();

    // Verify late report was ignored
    let (_, resp) = request_json(
        &state,
        Method::POST,
        "/view",
        Some(json!({"token": "operator", "target": ""})),
    )
    .await;
    assert_eq!(
        resp["screen"]["view"], "visual",
        "report from retired epoch must be ignored"
    );
    assert_eq!(resp["screen"]["connected"], false);

    // 5. Connect connection 2 (epoch 2)
    let (conn2, _, _) = state.register_connection().await;
    let epoch2 = conn2.epoch;

    // Report with stale generation must be ignored!
    handle_text_frame(
        &state,
        epoch2,
        &mut pending_header,
        &mut pending_chunk,
        &json!({
            "type": "screen_state",
            "view": "theater",
            "pinned": false,
            "has_visual": true,
            "visual_kind": "chart",
            "object_ids": ["chart-2"],
            "title": "Stale Gen Report",
            "stale": false,
            "generation": 999,
        })
        .to_string(),
    )
    .await
    .unwrap();

    let (_, resp) = request_json(
        &state,
        Method::POST,
        "/view",
        Some(json!({"token": "operator", "target": ""})),
    )
    .await;
    assert_eq!(
        resp["screen"]["view"], "visual",
        "report with stale generation must be ignored"
    );

    // Report with current generation from active connection 2 succeeds
    handle_text_frame(
        &state,
        epoch2,
        &mut pending_header,
        &mut pending_chunk,
        &json!({
            "type": "screen_state",
            "view": "theater",
            "pinned": false,
            "has_visual": true,
            "visual_kind": "chart",
            "object_ids": ["chart-2"],
            "title": "Fresh Report",
            "stale": false,
            "generation": current_gen,
        })
        .to_string(),
    )
    .await
    .unwrap();

    let (_, resp) = request_json(
        &state,
        Method::POST,
        "/view",
        Some(json!({"token": "operator", "target": ""})),
    )
    .await;
    assert_eq!(resp["screen"]["view"], "theater");
    // Title is projection-derived, not echoed from the browser's report: no
    // display action was posted, so there is nothing to title.
    assert_eq!(resp["screen"]["title"], "");
    assert_eq!(resp["screen"]["stale"], false);
}

#[tokio::test]
async fn display_frames_carry_the_delivery_sequence() {
    let action = json!({"type":"display","action":{"op":"clear"}});
    let stamped = stamp_display_seq(Event::Json(action), 7);
    let Event::Json(value) = stamped else {
        panic!("expected json event")
    };
    assert_eq!(value.get("seq").and_then(Value::as_u64), Some(7));
    assert_eq!(value.get("type").and_then(Value::as_str), Some("display"));

    // Non-display events are untouched.
    let other = stamp_display_seq(Event::Json(json!({"type":"epoch","generation":3})), 9);
    let Event::Json(value) = other else {
        panic!("expected json event")
    };
    assert!(value.get("seq").is_none());
}

fn operator_reply() -> crate::pbx::Reply {
    crate::pbx::Reply {
        text: String::new(),
        route: OPERATOR.into(),
        route_label: "Operator".into(),
        error: None,
        to_speak: Vec::new(),
        delivery_generation: None,
    }
}

async fn refusal_of(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn a_page_control_whose_leg_is_rescued_mid_operation_is_refused_as_superseded() {
    let state = state();
    let rescuer = state.clone();
    let controlled = run_page_control(&state, "model change", RunningWork::Keep, async move {
        rescuer.0.coordinator.begin_rescue("page rescue");
        operator_reply()
    })
    .await;

    let Err(refused) = controlled else {
        panic!("a reply from a rescued leg must not be delivered");
    };
    assert_eq!(
        refusal_of(refused).await,
        (
            StatusCode::CONFLICT,
            json!({"detail":"model change was superseded"})
        )
    );
    assert!(state.0.active_operations.lock().await.is_empty());
}

#[tokio::test]
async fn a_page_control_that_fails_is_refused_as_a_server_error() {
    let state = state();
    let controlled = run_page_control(
        &state,
        "connection attempt",
        RunningWork::Cancel,
        async move {
            panic!("the PBX operation failed");
        },
    )
    .await;

    let Err(refused) = controlled else {
        panic!("a failed operation has no reply to deliver");
    };
    let (status, body) = refusal_of(refused).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(body["detail"]
        .as_str()
        .unwrap()
        .starts_with("connection attempt failed:"));
    assert!(state.0.active_operations.lock().await.is_empty());
    // The control rescued the call before it failed; it still settles it.
    let coordinator = &state.0.coordinator;
    assert!(coordinator
        .begin_prompt(&coordinator.current_identity())
        .is_ok());
}

/// RPC activity as the pi process started for `leg` reports it.
fn activity_from(leg: &str, state: &str) -> Activity {
    Activity {
        state: state.into(),
        tool: if state == "life" { "" } else { "bash" }.into(),
        detail: String::new(),
        label: "alpha".into(),
        leg: leg.into(),
    }
}

#[tokio::test]
async fn activity_from_a_leg_retired_by_a_rescue_is_not_published() {
    let state = state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    begin_alpha_candidate(&state, "alpha-leg");
    assert!(state.0.leg_announcer.promote_candidate("alpha-leg").await);
    queued_frames(&mut connection);

    state
        .0
        .leg_announcer
        .on_activity(activity_from("alpha-leg", "start"))
        .await;
    assert_eq!(types_of(&queued_frames(&mut connection)), ["activity"]);

    // The rescue retires the leg before its process is reaped, and a tool
    // call it reports in that window must not reach the page.
    state.0.coordinator.begin_rescue("page rescue");
    state
        .0
        .leg_announcer
        .on_activity(activity_from("alpha-leg", "end"))
        .await;
    assert!(queued_frames(&mut connection).is_empty());
    state.0.coordinator.settle();
    state
        .0
        .leg_announcer
        .on_activity(activity_from("alpha-leg", "start"))
        .await;
    assert!(queued_frames(&mut connection).is_empty());
}

#[tokio::test]
async fn activity_from_a_process_that_is_not_the_candidate_does_not_promote_it() {
    let state = state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    begin_alpha_candidate(&state, "alpha-leg");
    assert_eq!(types_of(&queued_frames(&mut connection)), ["candidate"]);

    // Neither the operator nor a stray process is the incoming leg, whatever
    // it reports.
    for leg in [OPERATOR, "beta-leg"] {
        state
            .0
            .leg_announcer
            .on_activity(activity_from(leg, "life"))
            .await;
    }
    assert_eq!(
        state
            .0
            .coordinator
            .candidate_identity()
            .map(|leg| leg.token),
        Some("alpha-leg".to_owned())
    );
    assert_eq!(state.0.coordinator.route(), OPERATOR);
    assert!(queued_frames(&mut connection).is_empty());

    // The operator is still on the line: its own tool calls are shown, and
    // they promote nothing.
    state
        .0
        .leg_announcer
        .on_activity(activity_from(OPERATOR, "start"))
        .await;
    assert_eq!(types_of(&queued_frames(&mut connection)), ["activity"]);
    assert!(state.0.coordinator.candidate_identity().is_some());

    // The candidate's own first sign of life adopts it.
    state
        .0
        .leg_announcer
        .on_activity(activity_from("alpha-leg", "life"))
        .await;
    assert_eq!(
        types_of(&queued_frames(&mut connection)),
        ["candidate_cleared", "epoch", "status"]
    );
    assert_eq!(state.0.coordinator.route(), "alpha");
}

/// The last line the transcript kept, with the route it was kept under.
async fn last_transcript_line(state: &AppState) -> Option<(String, String)> {
    state
        .0
        .transcript_log
        .lock()
        .await
        .entries()
        .pop()
        .map(|entry| (entry.text, entry.route))
}

#[tokio::test]
async fn a_hangup_with_nothing_on_the_line_settles_the_call() {
    let state = state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;

    let (code, body) = request_json(&state, Method::POST, "/hangup", None).await;

    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        body,
        json!({"hungup":false, "reason":"already on the operator"})
    );
    // The rescue moved the epoch; the call then settled and said so.
    assert_eq!(
        types_of(&queued_frames(&mut connection)),
        ["epoch", "status"]
    );
    assert_eq!(last_transcript_line(&state).await, None);
    // Settled, not quiescing: the operator's callbacks and turns are taken.
    let coordinator = &state.0.coordinator;
    assert_eq!(coordinator.accept_side_effect(""), Ok(()));
    assert!(coordinator
        .begin_prompt(&coordinator.current_identity())
        .is_ok());
}

#[tokio::test]
async fn hanging_up_on_the_operator_says_it_was_cut_off() {
    let state = state();
    let operator = PiSession::start(
        vec!["sh".into(), "-c".into(), "sleep 60".into()],
        OPERATOR,
        OPERATOR,
        None,
        None,
        Duration::from_secs(60),
        None,
    )
    .await
    .unwrap();
    *state.0.active_session.lock().await = Some(operator.clone());

    let (code, body) = request_json(&state, Method::POST, "/hangup", None).await;

    assert_eq!(code, StatusCode::OK);
    assert_eq!(body, json!({"hungup":true, "left":OPERATOR}));
    assert!(!operator.alive().await);
    assert!(state.0.active_session.lock().await.is_none());
    assert_eq!(
        last_transcript_line(&state).await,
        Some((
            "You cut the operator off. It starts fresh when you speak again.".to_owned(),
            OPERATOR.to_owned()
        ))
    );
}

#[test]
fn a_hangup_names_what_the_caller_hung_up_on() {
    let owned = |text: &str| Some(text.to_owned());
    // A project leg, however the rescue found it.
    assert_eq!(
        hangup_outcome(owned("alpha"), owned("alpha")),
        Some((
            "alpha".to_owned(),
            "You hung up the line to alpha. You're back with the operator.".to_owned()
        ))
    );
    // A leg still starting from the operator: the rescue closed it and
    // abandoned the candidate, and the PBX found the operator on the route.
    assert_eq!(
        hangup_outcome(owned(OPERATOR), owned("beta")),
        Some((
            "beta".to_owned(),
            "You hung up on beta before it picked up. You're back with the operator.".to_owned()
        ))
    );
    assert_eq!(
        hangup_outcome(None, owned("beta")).map(|(left, _)| left),
        owned("beta")
    );
    // The operator itself.
    for (dropped, closed) in [
        (owned(OPERATOR), owned(OPERATOR)),
        (owned(OPERATOR), None),
        (None, owned(OPERATOR)),
    ] {
        assert_eq!(
            hangup_outcome(dropped, closed),
            Some((
                OPERATOR.to_owned(),
                "You cut the operator off. It starts fresh when you speak again.".to_owned()
            ))
        );
    }
    assert_eq!(hangup_outcome(None, None), None);
}

/// A pi stand-in: the operator puts every caller through to alpha, and
/// alpha's intro turn shows life, then waits for a steer before it ends. The
/// steer is the test's gate on the intro.
#[cfg(unix)]
fn runtime_with_a_gated_intro(root: &std::path::Path) -> std::path::PathBuf {
    let runtime = root.join("fake-pi");
    crate::pi_client::write_executable_script(
        &runtime,
        r##"operator=0
for arg in "$@"; do
if [ "$arg" = "--no-builtin-tools" ]; then operator=1; fi
done
while IFS= read -r line; do
if [ "$operator" -eq 1 ]; then
    printf '%s\n' '{"type":"tool_execution_start","toolName":"transfer_to_project","args":{"project":"alpha","intent":"look"}}'
else
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Alpha here."}}'
    IFS= read -r release
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Alpha here."}}'
fi
printf '%s\n' '{"type":"agent_settled"}'
done
"##,
    );
    runtime
}

#[cfg(unix)]
#[tokio::test]
async fn a_hangup_mid_intro_after_adoption_drops_the_incoming_leg_by_name() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-mid-intro-hangup-{}",
        crate::pbx::uuid_like()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let runtime = runtime_with_a_gated_intro(&root);
    let alpha: crate::registry::Project = serde_json::from_value(json!({
        "id": "alpha",
        "cwd": root.to_string_lossy(),
        "runtime": runtime.to_string_lossy(),
        "model": "anthropic/current",
        "stage_extension": false,
    }))
    .unwrap();
    let config = crate::Config::for_tests(&[("SWITCHBOARD_PI_BINARY", &runtime.to_string_lossy())]);
    let registry = Registry::new(vec![alpha]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("no catalog in this test"),
    );
    let state = state_on(Switchboard::new(
        &config,
        registry,
        std::sync::Arc::new(prewarm),
    ));
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;

    // The operator puts the caller through, as a turn the rescue can cancel.
    let turn_state = state.clone();
    let (turn, _id, _generation) = spawn_active_operation(&state, async move {
        let mut board = turn_state.0.switchboard.lock().await;
        board.handle("put me through to alpha").await
    })
    .await
    .unwrap();
    // Alpha's first sign of life adopts it while its intro is still running.
    frames_until(&mut connection, "status").await;
    assert_eq!(state.0.coordinator.route(), "alpha");
    let incoming = state
        .0
        .active_session
        .lock()
        .await
        .clone()
        .expect("the incoming leg is the live session during its intro");
    assert_eq!(incoming.label(), "alpha");

    let (code, body) = request_json(&state, Method::POST, "/hangup", None).await;

    assert_eq!(code, StatusCode::OK);
    assert_eq!(body, json!({"hungup":true, "left":"alpha"}));
    assert!(turn.await.unwrap_err().is_cancelled());
    assert!(!incoming.alive().await);
    // The operator was never the one hung up on: its process is the live
    // session again, still running.
    let operator = state
        .0
        .active_session
        .lock()
        .await
        .clone()
        .expect("the operator is the live session again");
    assert_eq!(operator.label(), OPERATOR);
    assert!(operator.alive().await);
    assert_eq!(state.0.coordinator.route(), OPERATOR);
    assert_eq!(
        last_transcript_line(&state).await,
        Some((
            "You hung up the line to alpha. You're back with the operator.".to_owned(),
            OPERATOR.to_owned()
        ))
    );
    let frames = queued_frames(&mut connection);
    let last_status = frames
        .iter()
        .rfind(|frame| frame["type"] == "status")
        .expect("the return is published");
    assert_eq!(last_status["route"], OPERATOR);
    let coordinator = &state.0.coordinator;
    assert!(coordinator
        .begin_prompt(&coordinator.current_identity())
        .is_ok());

    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

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
    assert_eq!(response["screen"]["visual_kind"], "document");
    assert_eq!(response["screen"]["title"], "Authentication changes");
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

    // Un-quiesce route back to operator so new calls can proceed with rotated token
    state
        .0
        .coordinator
        .publish_status(json!({"type": "status", "route": "operator"}));
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
    assert_eq!(resp["screen"]["visual_kind"], "chart");
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
        resp["screen"]["stale"], true,
        "retiring active connection must mark screen report stale"
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
    assert_eq!(resp["screen"]["stale"], true);

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
    assert_eq!(resp["screen"]["title"], "Fresh Report");
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

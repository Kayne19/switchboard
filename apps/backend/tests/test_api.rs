use super::*;
use crate::audio::TestTtsGate;
use crate::delivery::DELIVERY_QUEUE;
use crate::hosts::{FakeHostAgent, FakeLog, Step};
use crate::pbx::OPERATOR;
use crate::pi_client::PiSession;
use crate::registry::{Project, Registry};
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use tokio::sync::oneshot;
use tokio::time::{timeout, Duration};
use tower::ServiceExt;

fn state() -> AppState {
    state_with_stt(None)
}

fn state_with_stt(stt: Option<String>) -> AppState {
    state_with_stream(stt, None)
}

fn state_with_jev(client: crate::jev::JevClient, registry: Registry) -> AppState {
    let config = crate::Config::for_tests(&[("SWITCHBOARD_PI_BINARY", "/bin/sh")]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("test catalog"),
    );
    let board = Switchboard::new_with_jev(&config, registry, std::sync::Arc::new(prewarm), client);
    state_on(board)
}

fn fake_jev_client() -> (
    crate::jev::JevClient,
    std::sync::Arc<std::sync::atomic::AtomicUsize>,
    std::sync::Arc<tokio::sync::Notify>,
) {
    let requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let responded = std::sync::Arc::new(tokio::sync::Notify::new());
    let count = requests.clone();
    let notice = responded.clone();
    let client = crate::jev::JevClient::new(
        "http://unused.invalid/v1/systemone",
        "/nonexistent/typesafe-api-key",
        Duration::from_secs(1),
    )
    .expect("client")
    .with_test_responder(move |request| {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        notice.notify_one();
        async move {
            let answers = if request.questions.contains_key("good_moment") {
                serde_json::json!({
                    "good_moment": {"type":"choice","choice":"yes","probabilities":{"yes":1.0},"confidence":1.0}
                })
            } else {
                serde_json::json!({
                    "action": {"type":"choice","choice":"continue","probabilities":{"continue":1.0},"confidence":1.0},
                    "for_current_agent": {"type":"noul","noul":0.0},
                    "target": {"type":"choice","choice":"none","probabilities":{"none":1.0},"confidence":1.0},
                    "continue_or_fresh": {"type":"choice","choice":"not_applicable","probabilities":{"not_applicable":1.0},"confidence":1.0},
                    "multi_target": {"type":"noul","noul":0.0}
                })
            };
            Ok(serde_json::from_value(serde_json::json!({"model":"jev-test","answers":answers}))
                .expect("fixture response"))
        }
    });
    (client, requests, responded)
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
    let state = state_on_with_stream(board, None, None);
    // Most API tests exercise direct delivery rather than the production
    // bootstrap. Keep the one worker lifecycle in the shared setup helper.
    if tokio::runtime::Handle::try_current().is_ok() {
        start_speech_worker_for_test(&state);
    }
    state
}

fn state_on_with_stream(
    board: Switchboard,
    stt: Option<String>,
    stream: Option<String>,
) -> AppState {
    AppState::new(
        board,
        TranscriptLog::new(10),
        Speaker::offline(100, std::time::Duration::from_millis(25_000)),
        SttAdapter::from_command(stt),
        SttStreamAdapter::from_command(stream),
    )
}

#[test]
fn continuity_commit_is_scoped_to_generation_epoch_and_model() {
    let state = state();
    let generation = state.0.coordinator.generation();
    let model = state.0.coordinator.status().model;
    let initial = state.0.continuity_snapshot();

    assert!(state
        .0
        .mark_continuity_pending(generation, &model, "first line".into()));
    let pending = state.0.continuity_snapshot();
    assert_eq!(pending.pending_text.as_deref(), Some("first line"));
    assert!(!state.0.commit_continuity(
        generation,
        &model,
        initial.epoch + 1,
        Some("late".into()),
        "late line".into(),
    ));
    assert!(state.0.commit_continuity(
        generation,
        &model,
        pending.epoch,
        Some("request-1".into()),
        "first line".into(),
    ));
    let committed = state.0.continuity_snapshot();
    assert_eq!(committed.last_request_id.as_deref(), Some("request-1"));
    assert_eq!(committed.last_text.as_deref(), Some("first line"));
    assert!(committed.pending_text.is_none());

    state.0.clear_continuity_for(generation + 1, "next-model");
    let cleared = state.0.continuity_snapshot();
    assert!(cleared.epoch > committed.epoch);
    assert_eq!(cleared.generation, generation + 1);
    assert_eq!(cleared.model, "next-model");
    assert!(cleared.last_request_id.is_none());
    assert!(cleared.last_text.is_none());
}

#[test]
fn continuity_early_handoff_uses_pending_text_and_keeps_newer_drain() {
    let state = state();
    let generation = state.0.coordinator.generation();
    let model = state.0.coordinator.status().model;
    let epoch = state.0.continuity_snapshot().epoch;

    assert!(state
        .0
        .mark_continuity_pending_ordered(generation, &model, 10, "first line".into()));
    assert!(state
        .0
        .mark_continuity_pending_ordered(generation, &model, 11, "second line".into()));
    let (continuity, _) = continuity_for_request(
        &state,
        ContinuationScope::ContinueCurrentTurn,
        generation,
        &model,
    );
    assert_eq!(
        continuity,
        TtsContinuity::PreviousText("second line".into())
    );
    assert!(!state.0.clear_pending_continuity_if_matching(
        generation,
        &model,
        epoch,
        Some(10),
        "first line",
    ));
    assert!(state.0.clear_pending_continuity_if_matching(
        generation,
        &model,
        epoch,
        Some(11),
        "second line",
    ));
    // Restore the newer pending clip for the reverse-order drain assertion.
    assert!(state
        .0
        .mark_continuity_pending_ordered(generation, &model, 11, "second line".into()));

    // The newer body can finish first. Its sequence wins, and the older body
    // must not overwrite the request id/text that the next line will use.
    assert!(state.0.commit_continuity_ordered(
        generation,
        &model,
        epoch,
        11,
        Some("second-id".into()),
        "second line".into(),
    ));
    assert!(!state.0.commit_continuity_ordered(
        generation,
        &model,
        epoch,
        10,
        Some("first-id".into()),
        "first line".into(),
    ));
    let committed = state.0.continuity_snapshot();
    assert_eq!(committed.last_request_id.as_deref(), Some("second-id"));
    assert_eq!(committed.last_text.as_deref(), Some("second line"));
}

#[tokio::test]
async fn continuity_lifecycle_hooks_clear_caller_rescue_and_leg_boundaries() {
    let state = state();
    let generation = state.0.coordinator.generation();
    let model = state.0.coordinator.status().model;

    // The real final-transcript route clears before it dispatches the caller
    // turn, so a later worker cannot inherit the previous clip.
    state
        .0
        .mark_continuity_pending(generation, &model, "before caller".into());
    route_final_transcript(&state, "caller-boundary", generation, "hello".into()).await;
    assert!(state.0.continuity_snapshot().last_text.is_none());
    assert!(state.0.continuity_snapshot().pending_text.is_none());

    state.0.mark_continuity_pending(
        state.0.coordinator.generation(),
        &model,
        "before rescue".into(),
    );
    cancel_active_operations(&state).await;
    assert!(state.0.continuity_snapshot().last_text.is_none());
    assert!(state.0.continuity_snapshot().pending_text.is_none());

    let next_generation = state.0.coordinator.generation() + 1;
    state.0.mark_continuity_pending(
        state.0.coordinator.generation(),
        &model,
        "before leg".into(),
    );
    let mut gate = state.0.display_gate.lock().await;
    state
        .0
        .leg_announcer
        .begin_scene(
            &mut gate,
            crate::display::SceneLeg {
                route: "next-project".into(),
                generation: next_generation,
            },
        )
        .await;
    let cleared = state.0.continuity_snapshot();
    assert!(cleared.last_text.is_none());
    assert!(cleared.pending_text.is_none());
}

#[tokio::test]
async fn speech_worker_stitches_same_group_and_resets_unrelated_group() {
    let config = crate::Config::for_tests(&[]);
    let registry = Registry::new(vec![]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("no projects are registered"),
    );
    let state = AppState::new(
        Switchboard::new(&config, registry, std::sync::Arc::new(prewarm)),
        TranscriptLog::new(10),
        Speaker::test_success(100, Duration::from_millis(25_000)),
        SttAdapter::from_command(None),
        SttStreamAdapter::from_command(None),
    );
    let (_connection, _, _) = state.register_connection().await;
    start_speech_worker_for_test(&state);
    let generation = state.0.coordinator.generation();
    let group = state.0.new_speech_group();

    queue_speech(
        &state,
        SpeechAdmission {
            text: "first line".into(),
            route: OPERATOR.into(),
            generation,
            deadline: std::time::Instant::now() + Duration::from_secs(1),
            scope: ContinuationScope::FreshTurn,
            group,
            log_spoken: false,
        },
    )
    .await
    .expect("first line should be spoken");
    let first = state.0.continuity_snapshot();
    assert_eq!(first.last_text.as_deref(), Some("first line"));
    assert!(first.last_request_id.is_some());

    queue_speech(
        &state,
        SpeechAdmission {
            text: "second line".into(),
            route: OPERATOR.into(),
            generation,
            deadline: std::time::Instant::now() + Duration::from_secs(1),
            scope: ContinuationScope::ContinueCurrentTurn,
            group,
            log_spoken: false,
        },
    )
    .await
    .expect("same-group continuation should be spoken");
    assert_eq!(
        state.0.continuity_snapshot().last_text.as_deref(),
        Some("second line")
    );

    let unrelated = state.0.new_speech_group();
    queue_speech(
        &state,
        SpeechAdmission {
            text: "fresh line".into(),
            route: OPERATOR.into(),
            generation,
            deadline: std::time::Instant::now() + Duration::from_secs(1),
            scope: ContinuationScope::ContinueCurrentTurn,
            group: unrelated,
            log_spoken: false,
        },
    )
    .await
    .expect("unrelated line should start fresh");
    assert_eq!(
        state.0.continuity_snapshot().last_text.as_deref(),
        Some("fresh line")
    );
}

async fn next_delivery(connection: &mut DeliveryConnection) -> Value {
    let Some(DeliveryFrame::Message(Message::Text(text))) = connection.receiver.recv().await else {
        panic!("expected a websocket response");
    };
    serde_json::from_str(&text).unwrap()
}

fn start_speech_worker_for_test(state: &AppState) {
    ensure_speech_worker(state);
}

async fn request_json(
    state: &AppState,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    // Delivery tests call the router without the production worker bootstrap.
    // Start only the shared speech worker here so settled replies use the same
    // ordered path as production without a second lifecycle implementation.
    start_speech_worker_for_test(state);
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

/// A project session's module call, as the host link delivers it and the
/// application answers it: `path` names the call the way the agent callback
/// routes once did, and a `token` in `body` is the call token it carries.
async fn agent_call_json(state: &AppState, path: &str, body: Value) -> (StatusCode, Value) {
    start_speech_worker_for_test(state);
    let mut args = body;
    let token = args
        .as_object_mut()
        .and_then(|args| args.remove("token"))
        .and_then(|token| token.as_str().map(str::to_owned))
        .unwrap_or_default();
    let call = AgentCall {
        call: path.trim_start_matches('/').to_owned(),
        token,
        turn_id: None,
        cause: None,
        args,
    };
    let response = agent_call(state, &call).await;
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn post_display_in_task(
    state: &AppState,
    body: Value,
) -> tokio::task::JoinHandle<(StatusCode, Value)> {
    let state = state.clone();
    tokio::spawn(async move { agent_call_json(&state, "/display", body).await })
}

fn diagram_show() -> Value {
    json!({"action":{"op":"show","id":"d1","type":"diagram","data":{
        "mode":"graph","nodes":[{"id":"a","label":"A"}],"edges":[]}}})
}

#[tokio::test]
async fn speech_worker_duplicate_text_failure_keeps_newer_pending_drain() {
    let config = crate::Config::for_tests(&[]);
    let registry = Registry::new(vec![]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("no projects are registered"),
    );
    let gate = TestTtsGate::new();
    gate.fail_first();
    let state = AppState::new(
        Switchboard::new(&config, registry, std::sync::Arc::new(prewarm)),
        TranscriptLog::new(10),
        Speaker::test_gated(100, Duration::from_millis(25_000), gate.clone()),
        SttAdapter::from_command(None),
        SttStreamAdapter::from_command(None),
    );
    let (_connection, _, _) = state.register_connection().await;
    start_speech_worker_for_test(&state);
    let generation = state.0.coordinator.generation();
    let group = state.0.new_speech_group();
    let admission = |scope| SpeechAdmission {
        text: "same line".into(),
        route: OPERATOR.into(),
        generation,
        deadline: std::time::Instant::now() + Duration::from_secs(1),
        scope,
        group,
        log_spoken: false,
    };
    let first = tokio::spawn({
        let state = state.clone();
        let admission = admission(ContinuationScope::FreshTurn);
        async move { queue_speech(&state, admission).await }
    });
    timeout(Duration::from_secs(1), gate.wait_started())
        .await
        .expect("first gated drain started");
    let second = tokio::spawn({
        let state = state.clone();
        let admission = admission(ContinuationScope::ContinueCurrentTurn);
        async move { queue_speech(&state, admission).await }
    });
    timeout(Duration::from_secs(1), gate.wait_started())
        .await
        .expect("second gated drain started");

    let pending = state.0.continuity_snapshot();
    assert_eq!(pending.pending_text.as_deref(), Some("same line"));
    assert!(pending.pending_sequence.is_some());
    gate.release();
    gate.release();
    assert!(first.await.unwrap().is_err());
    assert!(second.await.unwrap().is_ok());
    let settled = state.0.continuity_snapshot();
    assert_eq!(settled.last_text.as_deref(), Some("same line"));
    assert!(settled.pending_text.is_none());
    assert!(settled.pending_sequence.is_none());
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
async fn healthz_reports_only_what_the_service_knows() {
    // "whisper_model" and "stt_adapter" were constants kept from the Python
    // response ("sidecar", on every deploy); they described nothing. Every
    // field left is state this process holds.
    let (code, health) = request_json(&state(), Method::GET, "/healthz", None).await;
    assert_eq!(code, StatusCode::OK);
    let fields = health
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        fields,
        std::collections::BTreeSet::from([
            "status",
            "git",
            "stt_configured",
            "stt_stream_configured",
            "elevenlabs_configured",
            "route",
            "model",
            "thinking",
            "model_swaps",
            "projects",
            "hosts",
        ])
    );
    assert_eq!(health["stt_configured"], false);
    assert_eq!(health["stt_stream_configured"], false);
    assert_eq!(health["elevenlabs_configured"], true);

    let configured = state_with_stream(Some("true".into()), Some("true".into()));
    let (_, health) = request_json(&configured, Method::GET, "/healthz", None).await;
    assert_eq!(health["stt_configured"], true);
    assert_eq!(health["stt_stream_configured"], true);
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

    let (code, response) = agent_call_json(&state, "/view", json!({"target":""})).await;
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
    let (_c, before) = agent_call_json(&state, "/view", json!({"target":""})).await;
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

    let (_c, after) = agent_call_json(&state, "/view", json!({"target":""})).await;
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
    let (code, _) = agent_call_json(
        &state,
        "/display",
        json!({
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
        }),
    )
    .await;
    assert_eq!(code, StatusCode::OK);

    let (code, _) = agent_call_json(
        &state,
        "/display",
        json!({
            "token": "operator",
            "action": {
                "op": "show",
                "id": "second",
                "type": "document",
                "data": {"subject": "document-title", "paragraphs": ["p1"]}
            }
        }),
    )
    .await;
    assert_eq!(code, StatusCode::OK);

    let (code, response) = agent_call_json(&state, "/view", json!({"target":""})).await;
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
    let (code, _) = agent_call_json(
        &state,
        "/display",
        json!({
            "token": "operator",
            "action": {
                "op": "show",
                "id": "first",
                "type": "document",
                "role": "primary",
                "data": {"subject": "document-title", "paragraphs": ["p1"]}
            }
        }),
    )
    .await;
    assert_eq!(code, StatusCode::OK);

    let (code, _) = agent_call_json(
        &state,
        "/display",
        json!({
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
        }),
    )
    .await;
    assert_eq!(code, StatusCode::OK);

    let (code, response) = agent_call_json(&state, "/view", json!({"target":""})).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(response["screen"]["visual_kind"], "document");
    assert_eq!(response["screen"]["title"], "document-title");
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
        voiced: false,
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
        voiced: false,
        delivery_generation: None,
    };

    assert!(!deliver_turn_if_current(&state, &reply, generation, "stale-clip").await);
    assert!(matches!(
        events.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
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
async fn a_body_the_handler_cannot_read_gets_axums_own_answer() {
    // Controls and callbacks take axum's rejection so they can log it; the
    // page or agent that sent the body must still get the answer axum gives.
    async fn send(path: &str, content_type: Option<&str>, body: Vec<u8>) -> (StatusCode, String) {
        let mut request = Request::builder().method(Method::POST).uri(path);
        if let Some(content_type) = content_type {
            request = request.header("content-type", content_type);
        }
        let response = state()
            .router(None)
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }
    let json = Some("application/json");

    let (code, _) = send("/connect", json, b"{not json".to_vec()).await;
    assert_eq!(code, StatusCode::BAD_REQUEST);

    let (code, _) = send("/connect", None, br#"{"project":"alpha"}"#.to_vec()).await;
    assert_eq!(code, StatusCode::UNSUPPORTED_MEDIA_TYPE);
}

#[tokio::test]
async fn no_agent_callback_is_served_over_http() {
    // Project agents reach the service only through their host agent's link.
    for path in ["/speak", "/display", "/view", "/leg-state"] {
        let response = state()
            .router(None)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn a_view_call_with_an_unknown_field_is_refused_with_the_reason() {
    let (code, body) =
        agent_call_json(&state(), "/view", json!({"target":"","colour":"red"})).await;
    assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        body["detail"].as_str().unwrap().contains("colour"),
        "{body}"
    );
    let reply = module_call(
        &state(),
        AgentCall {
            call: "view".into(),
            token: String::new(),
            turn_id: None,
            cause: None,
            args: json!({"colour":"red"}),
        },
    )
    .await;
    assert_eq!(reply["status"], "refused");
    assert!(
        reply["reason"].as_str().unwrap().contains("colour"),
        "{reply}"
    );
}

#[tokio::test]
async fn speak_rejects_blank_text_without_logging_it() {
    let state = state();
    let (code, body) = agent_call_json(&state, "/speak", json!({"text":"   "})).await;
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
        agent_call_json(&state, "/speak", json!({"text":"Still working."})),
    )
    .await
    .expect("speak must stay live during an agent turn");
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        spoken,
        json!({"delivered":false, "reason":"no browser connected", "detail":"no browser connected"})
    );

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
    *state.0.active_session.lock().await = Some(LegSession::Operator(session.clone()));

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
    let (code, spoken) = agent_call_json(&state, "/speak", json!({"text":"Hello world."})).await;
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
        voiced: false,
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

/// Test-only lifecycle oracle. It checks the projections together rather
/// than asserting a single event, so every failure path can use the same
/// consistency contract.
async fn assert_lifecycle_consistent(state: &AppState) {
    let agents = state.0.projection.states.lock().unwrap().clone();
    let displays = state.0.projection.displays.lock().unwrap().clone();
    let route = state.0.coordinator.route();
    let board = state.0.switchboard.lock().await;
    for agent in &agents {
        if agent.state == "busy" {
            let in_flight = if agent.project == route {
                board.foreground_busy_for_test(&agent.project)
            } else {
                board
                    .residents_for_test()
                    .into_iter()
                    .find(|(project, _, _)| project == &agent.project)
                    .is_some_and(|(_, alive, busy)| alive && busy)
            };
            assert!(in_flight, "busy agent has no in-flight turn: {:?}", agent);
        }
        assert_eq!(
            agent.pending_request.is_some(),
            agent.state == "waiting",
            "waiting state and request must agree: {:?}",
            agent
        );
    }
    for project in displays.keys() {
        let resident = board
            .residents_for_test()
            .into_iter()
            .find(|(name, _, _)| name == project)
            .expect("held display belongs to a resident");
        assert!(resident.1, "held display belongs to a dead resident");
    }
    if route != OPERATOR {
        let foreground = agents.iter().find(|agent| agent.project == route);
        assert!(foreground.is_none_or(|agent| agent.pending_request.is_none()));
        assert!(!displays.contains_key(&route));
    }
    for (project, alive, _) in board.residents_for_test() {
        assert!(alive, "dead resident remains in registry: {project}");
        assert!(board.coordinator().project_is_background(&project));
    }
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
async fn a_non_steered_continue_uses_one_jev_decision_for_one_utterance() {
    let (client, requests, _responded) = fake_jev_client();
    let state = state_with_jev(client, Registry::new(vec![]));
    let mut events = state.0.events.subscribe();
    let generation = state.0.coordinator.generation();

    dispatch_routed_transcript(&state, "once", generation, "hello".into()).await;
    assert!(state.0.routed_decisions.lock().await.contains_key("once"));

    let worker = tokio::spawn(process_turns(state.clone()));
    let thinking = next_event_of(&mut events, "thinking").await;
    assert_eq!(thinking["type"], "thinking");
    assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst), 1);

    worker.abort();
    let _ = worker.await;
    // The Jev responder is in-process and needs no teardown.
}

#[tokio::test]
async fn a_stale_queued_turn_removes_its_retained_jev_decision() {
    let state = state();
    let mut events = state.0.events.subscribe();
    state
        .0
        .routed_decisions
        .lock()
        .await
        .insert("stale".into(), Decision::fallback("test").into());
    let old_generation = state.0.coordinator.generation();
    state.0.coordinator.begin_rescue("test rescue");
    state.0.queued_turns.store(1, Ordering::Release);
    let worker = tokio::spawn(process_turns(state.clone()));
    state
        .0
        .turns
        .send(("stale".into(), "old words".into(), old_generation))
        .await
        .expect("queued turn");

    let stale = next_event_of(&mut events, "error").await;
    assert_eq!(stale["id"], "stale");
    assert_eq!(stale["code"], "stale_epoch");
    assert!(!state.0.routed_decisions.lock().await.contains_key("stale"));

    worker.abort();
    let _ = worker.await;
}

#[tokio::test]
async fn steer_rechecks_generation_under_the_active_session_guard() {
    let (client, _requests, responded) = fake_jev_client();
    let state = state_with_jev(client, Registry::new(vec![]));
    let mut events = state.0.events.subscribe();
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
    .expect("session");
    let prompt = {
        let session = session.clone();
        tokio::spawn(async move { session.prompt("hold this turn").await })
    };
    timeout(Duration::from_secs(1), async {
        while !session.busy() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("session is busy");
    *state.0.active_session.lock().await = Some(LegSession::Operator(session.clone()));
    let active_guard = state.0.active_session.lock().await;
    let generation = state.0.coordinator.generation();
    state
        .0
        .coordinator
        .begin_prompt(&state.0.coordinator.current_identity())
        .expect("active operation");

    let dispatch_state = state.clone();
    let dispatch = tokio::spawn(async move {
        dispatch_routed_transcript(
            &dispatch_state,
            "steer-stale",
            generation,
            "hello again".into(),
        )
        .await;
    });
    responded.notified().await;
    state.0.coordinator.begin_rescue("test rescue");
    drop(active_guard);
    dispatch.await.expect("dispatch");

    let stale = next_event_of(&mut events, "error").await;
    assert_eq!(stale["id"], "steer-stale");
    assert_eq!(state.0.queued_turns.load(Ordering::Acquire), 0);

    prompt.abort();
    let _ = prompt.await;
    session.close().await;
    // The Jev responder is in-process and needs no teardown.
}

#[tokio::test]
async fn an_utterance_steers_a_turn_that_holds_the_pbx_lock() {
    // The turn worker holds the PBX lock for a whole prompt. Routing must not
    // wait on it, or the utterance is routed only after the turn ends and is
    // queued instead of steered.
    let (client, _requests, _responded) = fake_jev_client();
    let state = state_with_jev(client, Registry::new(vec![]));
    let mut events = state.0.events.subscribe();
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
    .expect("session");
    let prompt = {
        let session = session.clone();
        tokio::spawn(async move { session.prompt("hold this turn").await })
    };
    timeout(Duration::from_secs(1), async {
        while !session.busy() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("session is busy");
    *state.0.active_session.lock().await = Some(LegSession::Operator(session.clone()));
    let generation = state.0.coordinator.generation();
    state
        .0
        .coordinator
        .begin_prompt(&state.0.coordinator.current_identity())
        .expect("active operation");
    let board = state.0.switchboard.lock().await;

    timeout(
        Duration::from_secs(5),
        dispatch_routed_transcript(&state, "steer-busy", generation, "also this".into()),
    )
    .await
    .expect("routing does not wait on the PBX lock");

    let queued = next_event_of(&mut events, "queued").await;
    assert_eq!(queued["id"], "steer-busy");
    assert_eq!(queued["steered"], true);
    assert_eq!(state.0.queued_turns.load(Ordering::Acquire), 0);

    drop(board);
    prompt.abort();
    let _ = prompt.await;
    session.close().await;
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
            connection: tracing::Span::none(),
        })
        .await
        .unwrap();
    // The transfer lands while the clip is still inside the sidecar.
    state.0.coordinator.begin_rescue("test rescue");
    let worker_state = state.clone();
    let worker = tokio::spawn(async move { process_clips(worker_state).await });

    // The worker may finish transcription, but stale history and live
    // transcript events must be suppressed before either side effect.
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
    let stale = next_event_of(&mut events, "error").await;
    assert_eq!(stale["code"], "stale_epoch");
    assert_eq!(state.0.queued_turns.load(Ordering::Acquire), 0);
    let mut turns = state.0.turn_rx.lock().await.take().unwrap();
    assert!(matches!(
        turns.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
}

// Speech already on the wire while a transfer's leg is starting (issue #58).
//
// An agent-initiated transfer moves the generation when the incoming leg is
// adopted, not when it starts. A clip the caller recorded while the page said
// "Connecting to alpha…", and that went out before the adoption epoch reached
// the browser, carries the old generation. These tests pin down what happens
// to it for each order in which adoption and the clip's own stages can land:
// it is never steered into the starting leg and never delivered to the new
// one, and every path ends in an ID-bearing `stale_epoch` error that the
// browser shows the caller. The one exception is a startup that is rolled
// back: the generation never moves, so a queued clip goes to the leg the
// caller stayed on.

const HEARD_WHILE_CONNECTING: &str = "cat >/dev/null; printf 'and check the logs'";

/// Uploads a complete clip the way the browser does, stamped with the epoch it
/// held when recording started, and returns the frames up to its `accepted`.
async fn upload_clip(
    state: &AppState,
    connection: &mut DeliveryConnection,
    id: &str,
    generation: u64,
) -> Vec<Value> {
    let mut header = None;
    let clip = json!({"type":"clip", "id":id, "mime":"audio/webm", "generation":generation});
    handle_text_frame(
        state,
        connection.epoch,
        &mut header,
        &mut None,
        &clip.to_string(),
    )
    .await
    .unwrap();
    handle_audio_frame(
        state,
        connection.epoch,
        &mut header,
        &mut None,
        b"speech".to_vec(),
    )
    .await
    .unwrap();
    let frames = frames_until(connection, "accepted").await;
    assert_eq!(frames.last().unwrap()["id"], id);
    frames
}

fn assert_dropped_with_notice(frame: &Value, id: &str) {
    assert_eq!(frame["type"], "error", "{frame}");
    assert_eq!(frame["code"], "stale_epoch", "{frame}");
    assert_eq!(frame["id"], id, "{frame}");
    assert!(
        frame["message"]
            .as_str()
            .is_some_and(|text| !text.is_empty()),
        "the caller is told in words: {frame}"
    );
}

/// Asserts the clip never became a turn: nothing waits in the turn queue.
async fn assert_never_queued(state: &AppState) {
    assert_eq!(state.0.queued_turns.load(Ordering::Acquire), 0);
    let mut turns = state.0.turn_rx.lock().await.take().unwrap();
    assert!(matches!(
        turns.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
}

/// A leg in the middle of a turn that does not settle, as the incoming agent
/// is while it answers its intro prompt. It is made the active session, which
/// is where the PBX puts a leg it has started but not yet adopted.
async fn leg_busy_with_its_intro(
    state: &AppState,
) -> (
    PiSession,
    JoinHandle<Result<crate::pi_client::Turn, crate::pi_client::PiSessionError>>,
) {
    let session = PiSession::start(
        vec!["sh".into(), "-c".into(), "cat >/dev/null".into()],
        "alpha",
        "alpha-leg",
        None,
        None,
        Duration::from_secs(60),
        None,
    )
    .await
    .unwrap();
    *state.0.active_session.lock().await = Some(LegSession::Operator(session.clone()));
    let prompting = session.clone();
    let intro = tokio::spawn(async move { prompting.prompt("intro").await });
    timeout(Duration::from_secs(10), async {
        while !session.busy() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the intro turn starts");
    (session, intro)
}

/// A speech-to-text sidecar that holds each clip until the test releases it,
/// so a transfer can be landed while the clip is inside it.
///
/// Both FIFOs are held open read-write by the test, so neither end ever waits
/// for the other to open or sees an early end of file: the sidecar reports
/// that it has the clip by writing a byte, and waits for one before answering.
#[cfg(unix)]
struct GatedStt {
    dir: std::path::PathBuf,
    entered: tokio::net::unix::pipe::Receiver,
    release: tokio::net::unix::pipe::Sender,
}

#[cfg(unix)]
impl GatedStt {
    /// The gate, and the sidecar command that answers `transcript` through it.
    fn new(transcript: &str) -> (Self, String) {
        use std::os::unix::ffi::OsStrExt;
        let dir = std::env::temp_dir().join(format!(
            "switchboard-gated-stt-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let entered = dir.join("entered");
        let release = dir.join("release");
        for fifo in [&entered, &release] {
            let path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
            // SAFETY: `path` is a NUL-terminated string that outlives the call.
            let made = unsafe { libc::mkfifo(path.as_ptr(), 0o600) };
            assert_eq!(made, 0, "mkfifo {}", fifo.display());
        }
        let options = || {
            let mut options = tokio::net::unix::pipe::OpenOptions::new();
            options.read_write(true);
            options
        };
        let gate = Self {
            entered: options().open_receiver(&entered).unwrap(),
            release: options().open_sender(&release).unwrap(),
            dir,
        };
        let command = format!(
            "cat >/dev/null; printf x > '{}'; head -c 1 '{}' >/dev/null; printf '%s' '{transcript}'",
            entered.display(),
            release.display(),
        );
        (gate, command)
    }

    /// Returns once the sidecar holds a clip.
    async fn entered(&mut self) {
        use tokio::io::AsyncReadExt;
        let mut byte = [0u8; 1];
        timeout(Duration::from_secs(10), self.entered.read_exact(&mut byte))
            .await
            .expect("the sidecar takes the clip")
            .unwrap();
    }

    /// Lets the sidecar answer.
    async fn release(&mut self) {
        use tokio::io::AsyncWriteExt;
        self.release.write_all(b"x").await.unwrap();
    }
}

#[cfg(unix)]
impl Drop for GatedStt {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
async fn speech_queued_while_a_leg_starts_is_dropped_with_notice_once_the_leg_is_adopted() {
    let state = state_with_stt(Some(HEARD_WHILE_CONNECTING.into()));
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    let old = state.0.coordinator.generation();
    // The operator turn that asked for the transfer stays in flight until the
    // incoming leg's intro turn ends, and that leg is busy with the intro.
    state.0.turn_in_flight.store(true, Ordering::Release);
    begin_alpha_candidate(&state, "alpha-leg");
    let (intro_leg, intro) = leg_busy_with_its_intro(&state).await;

    upload_clip(&state, &mut connection, "while-connecting", old).await;
    let clip_worker = tokio::spawn(process_clips(state.clone()));

    // Transcribed before adoption: echoed, logged, and queued behind the
    // transfer. It is not steered, although a busy leg is live: a leg that
    // has not been adopted takes no input from the caller.
    let frames = frames_until(&mut connection, "queued").await;
    assert_eq!(types_of(&frames), ["transcript", "queued"]);
    assert_eq!(frames[0]["text"], "and check the logs");
    assert_eq!(frames[1]["id"], "while-connecting");
    assert_eq!(frames[1]["steered"], false);
    assert_eq!(state.0.transcript_log.lock().await.entries().len(), 1);

    // The incoming agent shows life, and its leg is adopted.
    assert!(state.0.leg_announcer.promote_candidate("alpha-leg").await);
    assert_eq!(state.0.coordinator.generation(), old + 1);

    // The intro turn ends and the turn worker reaches the queued clip: it
    // carries the old generation, so it is dropped, and the browser is told.
    state.0.turn_in_flight.store(false, Ordering::Release);
    let turn_worker = tokio::spawn(process_turns(state.clone()));
    let frames = frames_until(&mut connection, "error").await;
    assert_eq!(
        types_of(&frames),
        ["candidate_cleared", "epoch", "status", "error"]
    );
    assert_eq!(frames[1]["generation"], old + 1);
    assert_dropped_with_notice(&frames[3], "while-connecting");
    assert!(!state.0.turn_in_flight.load(Ordering::Acquire));
    assert!(state.0.active_operations.lock().await.is_empty());

    clip_worker.abort();
    turn_worker.abort();
    intro_leg.close().await;
    intro.abort();
}

#[tokio::test]
async fn speech_transcribed_before_adoption_but_acted_on_after_is_dropped_with_notice() {
    let state = state_with_stt(Some(HEARD_WHILE_CONNECTING.into()));
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    let old = state.0.coordinator.generation();
    begin_alpha_candidate(&state, "alpha-leg");
    upload_clip(&state, &mut connection, "while-connecting", old).await;

    // Hold the guard the steer-or-queue decision takes, so the adoption lands
    // after the transcript and before that decision.
    let session_guard = state.0.active_session.lock().await;
    let clip_worker = tokio::spawn(process_clips(state.clone()));
    let frames = frames_until(&mut connection, "transcript").await;
    assert_eq!(types_of(&frames), ["transcript"]);
    assert_eq!(frames[0]["id"], "while-connecting");
    assert!(state.0.leg_announcer.promote_candidate("alpha-leg").await);
    drop(session_guard);

    let frames = frames_until(&mut connection, "error").await;
    assert_eq!(
        types_of(&frames),
        ["candidate_cleared", "epoch", "status", "error"]
    );
    assert_dropped_with_notice(&frames[3], "while-connecting");
    assert_never_queued(&state).await;
    // The words stay in the conversation: they were logged before the leg
    // changed, and only acting on them is refused.
    assert_eq!(state.0.transcript_log.lock().await.entries().len(), 1);

    clip_worker.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn speech_inside_the_sidecar_when_the_leg_is_adopted_is_dropped_with_notice() {
    let (mut stt, command) = GatedStt::new("and check the logs");
    let state = state_with_stt(Some(command));
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    let old = state.0.coordinator.generation();
    begin_alpha_candidate(&state, "alpha-leg");
    upload_clip(&state, &mut connection, "while-connecting", old).await;
    let clip_worker = tokio::spawn(process_clips(state.clone()));

    stt.entered().await;
    assert!(state.0.leg_announcer.promote_candidate("alpha-leg").await);
    stt.release().await;

    // The transcript comes back after adoption: dropped before it is logged,
    // echoed, steered, or queued.
    let frames = frames_until(&mut connection, "error").await;
    assert_eq!(
        types_of(&frames),
        ["candidate_cleared", "epoch", "status", "error"]
    );
    assert_dropped_with_notice(&frames[3], "while-connecting");
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
    assert_never_queued(&state).await;

    clip_worker.abort();
}

#[tokio::test]
async fn speech_arriving_after_adoption_under_the_old_stamp_is_dropped_with_notice() {
    let state = state_with_stt(Some(HEARD_WHILE_CONNECTING.into()));
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    let old = state.0.coordinator.generation();
    begin_alpha_candidate(&state, "alpha-leg");
    assert!(state.0.leg_announcer.promote_candidate("alpha-leg").await);

    // The browser sent it before the new epoch reached it.
    let frames = upload_clip(&state, &mut connection, "while-connecting", old).await;
    assert_eq!(
        types_of(&frames),
        [
            "candidate",
            "candidate_cleared",
            "epoch",
            "status",
            "accepted"
        ]
    );
    let clip_worker = tokio::spawn(process_clips(state.clone()));
    let frames = frames_until(&mut connection, "error").await;
    assert_eq!(types_of(&frames), ["error"]);
    assert_dropped_with_notice(&frames[0], "while-connecting");
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
    assert_never_queued(&state).await;

    clip_worker.abort();
}

#[tokio::test]
async fn a_clip_keeps_the_first_stamp_the_server_saw_for_its_id() {
    // Why the browser cannot move a clip it has already sent onto a new leg:
    // a retransmission under the same id is taken as the clip the server
    // already has, stamp included, and is not transcribed again.
    let state = state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    upload_clip(&state, &mut connection, "sent-once", 3).await;
    upload_clip(&state, &mut connection, "sent-once", 4).await;

    let mut clips = state.0.clip_rx.lock().await.take().unwrap();
    let taken = clips.try_recv().expect("the first upload is taken");
    assert_eq!((taken.id.as_str(), taken.generation), ("sent-once", 3));
    assert!(matches!(
        clips.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
}

// A leg started from the page -- a connection or a redial -- differs from an
// agent's transfer in one way that matters here: no turn is running, so the
// turn worker is free while the leg starts. The page control holds the PBX
// lock from its rescue until the leg is adopted or rolled back, and the turn
// worker has to wait for that outcome before it checks a queued clip's stamp.
// It used to check at once, pass, and begin the turn's prompt, which took the
// call out of the starting phase: the leg was then never adopted, and the
// caller's words ran on it once the lock came free.

/// Starts a leg the way a page control does and keeps the PBX lock, then
/// queues a transcribed clip stamped with the epoch the browser was told
/// about, and waits until the turn worker has taken it.
async fn queue_a_clip_while_a_page_control_starts_a_leg(
    state: &AppState,
    id: &str,
) -> (JoinHandle<()>, JoinHandle<()>) {
    let (locked_tx, locked_rx) = oneshot::channel();
    let control_state = state.clone();
    let control = tokio::spawn(async move {
        hold_turn_lock(&control_state, Some(locked_tx)).await;
    });
    locked_rx.await.unwrap();
    cancel_active_operations(state).await;
    begin_alpha_candidate(state, "alpha-leg");

    state.0.queued_turns.store(1, Ordering::Release);
    state
        .0
        .turns
        .send((
            id.into(),
            "and check the logs".into(),
            state.0.coordinator.generation(),
        ))
        .await
        .unwrap();
    let turn_worker = tokio::spawn(process_turns(state.clone()));
    timeout(Duration::from_secs(10), async {
        while state.0.queued_turns.load(Ordering::Acquire) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the turn worker takes the clip");
    (control, turn_worker)
}

#[tokio::test]
async fn speech_queued_while_a_page_control_starts_a_leg_is_dropped_with_notice_on_adoption() {
    let state = state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    let (control, turn_worker) =
        queue_a_clip_while_a_page_control_starts_a_leg(&state, "while-connecting").await;

    assert!(
        state.0.coordinator.is_candidate(),
        "a turn must not begin while a leg is starting"
    );
    assert!(!state.0.turn_in_flight.load(Ordering::Acquire));
    assert_eq!(
        types_of(&queued_frames(&mut connection)),
        ["epoch", "candidate"]
    );

    // The incoming agent shows life, its leg is adopted, and the control ends.
    assert!(state.0.leg_announcer.promote_candidate("alpha-leg").await);
    control.abort();

    let frames = frames_until(&mut connection, "error").await;
    assert_eq!(
        types_of(&frames),
        ["candidate_cleared", "epoch", "status", "error"]
    );
    assert_dropped_with_notice(&frames[3], "while-connecting");
    assert!(!state.0.turn_in_flight.load(Ordering::Acquire));
    assert!(state.0.active_operations.lock().await.is_empty());
    turn_worker.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn speech_queued_while_a_page_control_starts_a_leg_stays_with_the_leg_after_a_rollback() {
    // The generation does not move when a startup is rolled back, so the clip
    // is still addressed to the leg the caller never left, and goes there.
    let root = std::env::temp_dir().join(format!(
        "switchboard-rollback-operator-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let operator = root.join("fake-pi");
    crate::pi_client::write_executable_script(
        &operator,
        r##"while IFS= read -r line; do
printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Operator heard you."}}'
printf '%s\n' '{"type":"agent_settled"}'
done
"##,
    );
    let config =
        crate::Config::for_tests(&[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())]);
    let registry = Registry::new(vec![]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("no projects are registered"),
    );
    // No speech key: the reply is not synthesized, so nothing leaves the box.
    let state = AppState::new(
        Switchboard::new(&config, registry, std::sync::Arc::new(prewarm)),
        TranscriptLog::new(10),
        Speaker::from_values(
            100,
            std::time::Duration::from_millis(25_000),
            &HashMap::new(),
        ),
        SttAdapter::from_command(None),
        SttStreamAdapter::from_command(None),
    );
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    let (control, turn_worker) =
        queue_a_clip_while_a_page_control_starts_a_leg(&state, "while-connecting").await;
    assert!(state.0.coordinator.is_candidate());

    assert!(state.0.coordinator.rollback_startup("startup failed"));
    control.abort();

    let frames = frames_until(&mut connection, "reply").await;
    assert_eq!(
        types_of(&frames),
        [
            "epoch",
            "candidate",
            "candidate_cleared",
            "thinking",
            "reply"
        ]
    );
    assert_eq!(frames[3]["route"], OPERATOR);
    assert_eq!(frames[4]["text"], "Operator heard you.");
    assert_eq!(frames[4]["route"], OPERATOR);

    turn_worker.abort();
    state.0.switchboard.lock().await.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn a_turn_dropped_by_a_rescue_before_it_is_registered_is_dropped_with_notice() {
    let state = state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    // Hold the registry a turn joins when it is spawned, so a rescue can land
    // after the turn passed its stamp check and before it is registered.
    let registry = state.0.active_operations.lock().await;
    state.0.queued_turns.store(1, Ordering::Release);
    state
        .0
        .turns
        .send((
            "just-dispatched".into(),
            "and check the logs".into(),
            state.0.coordinator.generation(),
        ))
        .await
        .unwrap();
    let turn_worker = tokio::spawn(process_turns(state.clone()));
    assert_eq!(
        types_of(&frames_until(&mut connection, "thinking").await),
        ["thinking"]
    );

    state.0.coordinator.begin_rescue("test rescue");
    drop(registry);

    let frames = frames_until(&mut connection, "error").await;
    assert_eq!(types_of(&frames), ["error"]);
    assert_dropped_with_notice(&frames[0], "just-dispatched");
    assert!(!state.0.turn_in_flight.load(Ordering::Acquire));
    turn_worker.abort();
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
    let (code, _) = agent_call_json(&state, "/display", show).await;
    assert_eq!(code, StatusCode::OK);
    let Event::Json(event) = events.recv().await.unwrap() else {
        panic!("expected event")
    };
    assert_eq!(event["type"], "display");
    assert_eq!(event["action"]["id"], "main");
    assert_eq!(*state.0.last_display.lock().await, Some(event));
    for (id, role) in [("compare", "compare"), ("secondary", "secondary")] {
        let (code, _) = agent_call_json(
            &state,
            "/display",
            json!({
                "token": "operator",
                "action": {
                    "op": "show",
                    "id": id,
                    "type": "metric",
                    "role": role,
                    "data": {"label": id, "value": "1"}
                }
            }),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert!(matches!(events.recv().await.unwrap(), Event::Json(_)));
    }
    let (code, _) = agent_call_json(
        &state,
        "/display",
        json!({
            "token": "operator",
            "action": {
                "op": "say",
                "text": "point",
                "target": "main",
                "at": {"x": 2.0, "series": "a"}
            }
        }),
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

        let (code, _) = agent_call_json(
            &state,
            "/display",
            json!({"token": "operator", "action": action.clone()}),
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
        agent_call_json(&state, "/display", oversized).await.0,
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
    let (code, _) = agent_call_json(&state, "/display", show_chart).await;
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
    let (code, _) = agent_call_json(&state, "/display", show_doc).await;
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
    let (code, _) = agent_call_json(&state, "/display", focus_chart).await;
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
    let (code, _) = agent_call_json(&state, "/display", say_chart).await;
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
    let (code, _) = agent_call_json(&state, "/display", hide_chart).await;
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
    let (code, _) = agent_call_json(&state, "/display", hide_again).await;
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
    let (code, _) = agent_call_json(&state, "/display", general_say).await;
    assert_eq!(code, StatusCode::OK);

    let hide_doc = json!({
        "token": "operator",
        "action": {
            "op": "hide",
            "id": "doc-1"
        }
    });
    let (code, _) = agent_call_json(&state, "/display", hide_doc).await;
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
    let (code, _) = agent_call_json(&state, "/display", valid_display).await;
    assert_eq!(code, StatusCode::OK);

    let valid_view = json!({
        "token": "operator",
        "target": "visual",
        "reason": "inspect"
    });
    let (code, _) = agent_call_json(&state, "/view", valid_view).await;
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
    let (code, resp) = agent_call_json(&state, "/display", stale_display).await;
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
    let (code, resp) = agent_call_json(&state, "/view", stale_view).await;
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
    let (code, _) = agent_call_json(&state, "/display", fresh_display).await;
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
    assert!(
        body.get("held").is_none(),
        "foreground result must stay unchanged"
    );
}

#[tokio::test]
async fn display_reports_unconfirmed_when_the_browser_stays_silent() {
    let state = state();
    let (connection, _s, _w) = state.register_connection().await;
    let _ = connection.receiver; // keep the connection alive, never ack
    let (code, body) = agent_call_json(&state, "/display", diagram_show()).await;
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
        let (code, _) = agent_call_json(
            &state,
            "/display",
            json!({
                "token": "operator",
                "action": {
                    "op": "show",
                    "id": id,
                    "type": "metric",
                    "role": "primary",
                    "data": {"label": id, "value": "100"}
                }
            }),
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
    let (code, _) = agent_call_json(&state, "/display", show).await;
    assert_eq!(code, StatusCode::OK);

    let focus = json!({
        "token": "operator",
        "action": {"op": "focus", "id": "scene-obj"}
    });
    let (code, _) = agent_call_json(&state, "/display", focus).await;
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

fn assert_serial_audio(frames: &[Value]) {
    let mut active = false;
    for frame in frames {
        match frame["type"].as_str() {
            Some("audio_start") => {
                assert!(!active, "a second speaker started before the first ended");
                active = true;
            }
            Some("audio_done") => {
                assert!(active, "audio ended without a speaker start");
                active = false;
            }
            _ => {}
        }
    }
    assert!(
        !active,
        "speech was still active at the end of the delivery batch"
    );
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
    let (_code, view) = agent_call_json(&state, "/view", json!({"token":"alpha-leg"})).await;
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
    let (code, resp) =
        agent_call_json(&state, "/view", json!({"token": "operator", "target": ""})).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(resp["screen"]["view"], "visual");
    assert_eq!(resp["screen"]["visual_kind"], Value::Null);
    assert_eq!(resp["screen"]["stale"], false);

    // 2. Connection 1 is retired (browser disconnects)
    state.retire_connection(epoch1).await;
    let (code, resp) =
        agent_call_json(&state, "/view", json!({"token": "operator", "target": ""})).await;
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
    let (_, resp) =
        agent_call_json(&state, "/view", json!({"token": "operator", "target": ""})).await;
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

    let (_, resp) =
        agent_call_json(&state, "/view", json!({"token": "operator", "target": ""})).await;
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

    let (_, resp) =
        agent_call_json(&state, "/view", json!({"token": "operator", "target": ""})).await;
    assert_eq!(resp["screen"]["view"], "theater");
    // Title is projection-derived, not echoed from the browser's report: no
    // display action was posted, so there is nothing to title.
    assert_eq!(resp["screen"]["title"], "");
    assert_eq!(resp["screen"]["stale"], false);
}

fn operator_reply() -> crate::pbx::Reply {
    crate::pbx::Reply {
        text: String::new(),
        route: OPERATOR.into(),
        route_label: "Operator".into(),
        error: None,
        to_speak: Vec::new(),
        voiced: false,
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
    let controlled = run_page_control(&state, "connection attempt", async move {
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
            json!({"detail":"connection attempt was superseded"})
        )
    );
    assert!(state.0.active_operations.lock().await.is_empty());
}

#[tokio::test]
async fn a_page_control_that_fails_is_refused_as_a_server_error() {
    let state = state();
    let controlled = run_page_control(&state, "connection attempt", async move {
        panic!("the PBX operation failed");
    })
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

/// An operator stand-in that puts every caller through to alpha.
#[cfg(unix)]
fn runtime_with_a_gated_intro(root: &std::path::Path) -> std::path::PathBuf {
    let runtime = root.join("fake-pi");
    crate::pi_client::write_executable_script(
        &runtime,
        r##"while IFS= read -r line; do
printf '%s\n' '{"type":"tool_execution_start","toolName":"route","args":{"target":"alpha","mode":"fresh"}}'
printf '%s\n' '{"type":"agent_settled"}'
done
"##,
    );
    runtime
}

/// Waits until the fake host agent has been sent a `name` command.
async fn until_named(log: &FakeLog, name: &str) {
    for _ in 0..500 {
        if !log.named(name).is_empty() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the host agent was never sent {name}: {:?}", log.names());
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
        "host": "scriptorium",
        "cwd": root.to_string_lossy(),
        "model": "anthropic/current",
    }))
    .unwrap();
    let config = crate::Config::for_tests(&[("SWITCHBOARD_PI_BINARY", &runtime.to_string_lossy())]);
    let registry = Registry::new(vec![alpha]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("no catalog in this test"),
    );
    // alpha's intro shows life and never settles.
    let host = FakeHostAgent::new(Box::new(|_, _| {
        vec![
            Step::Event(json!({"kind":"text","text":"Alpha here."})),
            Step::Hold,
        ]
    }))
    .serve(prewarm.hosts().connect_fake("scriptorium"));
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
    until_named(&host, "kill").await;
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

// ---------------------------------------------------------------------------
// #56: the WebSocket handler over a real socket, and POST /hangup on the
// operator and on a project leg. The router is served on a loopback port the
// way `main` serves it, and a tungstenite client stands in for the browser.

type Browser =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type Wire = tokio_tungstenite::tungstenite::Message;

/// The router listening on 127.0.0.1; stops accepting when dropped.
struct Served {
    address: std::net::SocketAddr,
    server: tokio::task::JoinHandle<()>,
}

impl Served {
    async fn start(state: &AppState) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = state.clone().router(None);
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self { address, server }
    }

    async fn connect(&self) -> Browser {
        let (browser, _) = tokio_tungstenite::connect_async(format!("ws://{}/ws", self.address))
            .await
            .unwrap();
        browser
    }
}

impl Drop for Served {
    fn drop(&mut self) {
        self.server.abort();
    }
}

/// The next frame the browser reads, failing the test if none arrives.
async fn next_wire(browser: &mut Browser) -> Wire {
    timeout(Duration::from_secs(5), browser.next())
        .await
        .expect("a frame before the deadline")
        .expect("an open socket")
        .expect("a readable frame")
}

async fn next_json(browser: &mut Browser) -> Value {
    match next_wire(browser).await {
        Wire::Text(text) => serde_json::from_str(text.as_str()).unwrap(),
        other => panic!("expected a text frame, got {other:?}"),
    }
}

/// Frames up to and including the first of type `until`.
async fn json_until(browser: &mut Browser, until: &str) -> Vec<Value> {
    let mut frames = Vec::new();
    loop {
        let frame = next_json(browser).await;
        let done = frame["type"] == until;
        frames.push(frame);
        if done {
            return frames;
        }
    }
}

async fn send_json_frame(browser: &mut Browser, value: Value) {
    browser.send(Wire::text(value.to_string())).await.unwrap();
}

/// Sends a heartbeat and expects its answer, which is how these tests show
/// the connection is still up after something it refused.
async fn assert_still_answering(browser: &mut Browser, nonce: &str) {
    send_json_frame(browser, json!({"type":"ping", "nonce":nonce})).await;
    assert_eq!(
        next_json(browser).await,
        json!({"type":"pong", "nonce":nonce, "time":null})
    );
}

/// Waits for `condition`, failing the test if it never holds.
async fn wait_until(condition: impl Fn() -> bool) {
    timeout(Duration::from_secs(5), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("the condition never held");
}

#[tokio::test]
async fn a_connection_gets_epoch_status_history_and_scene_before_any_live_event() {
    let state = state();
    // Something in every part of the snapshot: an epoch that has moved, a
    // transcript, and an object on stage.
    state.0.coordinator.begin_rescue("an earlier rescue");
    state.0.coordinator.settle();
    let generation = state.0.coordinator.generation();
    state
        .0
        .transcript_log
        .lock()
        .await
        .add_with_id(CALLER, "put me through", OPERATOR, None);
    let mut show = diagram_show();
    show["token"] = json!(state.0.coordinator.current_identity().token);
    let (code, _) = agent_call_json(&state, "/display", show).await;
    assert_eq!(code, StatusCode::OK);
    let watermark = state.0.display_gate.lock().await.watermark;

    // Hold the transcript so the connection is registered but cannot finish
    // reading its snapshot, and publish a live event in that window.
    let served = Served::start(&state).await;
    let transcript = state.0.transcript_log.lock().await;
    let mut browser = served.connect().await;
    wait_until(|| state.0.delivery.connected()).await;
    assert!(emit(&state, Event::Json(json!({"type":"probe"}))));
    drop(transcript);

    let frames = json_until(&mut browser, "probe").await;
    assert_eq!(
        types_of(&frames),
        ["epoch", "status", "history", "display", "probe"]
    );
    assert_eq!(frames[0]["generation"], generation);
    assert_eq!(frames[1]["route"], OPERATOR);
    assert_eq!(frames[2]["entries"][0]["text"], "put me through");
    assert_eq!(frames[3]["action"]["id"], "d1");
    assert_eq!(
        frames[3]["seq"], watermark,
        "a replayed display carries the watermark, so the live stream's older displays are skipped"
    );
}

#[tokio::test]
async fn the_socket_answers_both_kinds_of_ping() {
    let state = state();
    let served = Served::start(&state).await;
    let mut browser = served.connect().await;
    json_until(&mut browser, "history").await;

    // The browser's heartbeat is a JSON frame, echoed with its fields.
    send_json_frame(
        &mut browser,
        json!({"type":"ping", "nonce":"beat-1", "time":1_700_000_000_000_u64}),
    )
    .await;
    assert_eq!(
        next_json(&mut browser).await,
        json!({"type":"pong", "nonce":"beat-1", "time":1_700_000_000_000_u64})
    );

    // A protocol ping, as a proxy might send. The WebSocket library queues
    // its own pong and the handler sends one too, so one or two arrive
    // depending on whether the second replaces the first before it is
    // flushed; what matters is that it is answered with the same payload.
    browser
        .send(Wire::Ping(b"are you there".to_vec().into()))
        .await
        .unwrap();
    send_json_frame(&mut browser, json!({"type":"ping", "nonce":"after"})).await;
    let mut pongs = Vec::new();
    loop {
        match next_wire(&mut browser).await {
            Wire::Pong(payload) => pongs.push(payload.to_vec()),
            Wire::Text(text) => {
                let frame: Value = serde_json::from_str(text.as_str()).unwrap();
                assert_eq!(frame["nonce"], "after", "{frame}");
                break;
            }
            other => panic!("unexpected frame {other:?}"),
        }
    }
    assert!(!pongs.is_empty(), "the protocol ping went unanswered");
    assert!(
        pongs.iter().all(|pong| pong == b"are you there"),
        "{pongs:?}"
    );
}

#[tokio::test]
async fn frames_the_socket_cannot_act_on_are_refused_without_hanging_up() {
    let state = state();
    let served = Served::start(&state).await;
    let mut browser = served.connect().await;
    json_until(&mut browser, "history").await;
    let error = |message: &str| json!({"type":"error", "message":message});

    browser.send(Wire::text("not json")).await.unwrap();
    assert_eq!(next_json(&mut browser).await, error("Invalid JSON frame."));
    browser.send(Wire::text("[1, 2]")).await.unwrap();
    assert_eq!(
        next_json(&mut browser).await,
        error("Invalid command shape.")
    );
    send_json_frame(&mut browser, json!({"type":"dance"})).await;
    assert_eq!(
        next_json(&mut browser).await,
        error("Unknown websocket command.")
    );
    send_json_frame(&mut browser, json!({"id":"no-type"})).await;
    assert_eq!(
        next_json(&mut browser).await,
        error("Unknown websocket command.")
    );
    assert_still_answering(&mut browser, "after-bad-commands").await;

    // Audio is only taken after the header that names it. A header that is
    // refused names nothing, so the audio after it is refused as well.
    browser.send(Wire::binary(vec![1, 2, 3])).await.unwrap();
    let headerless = error("Audio arrived without a clip header.");
    assert_eq!(next_json(&mut browser).await, headerless);
    send_json_frame(&mut browser, json!({"type":"clip", "id":""})).await;
    assert_eq!(next_json(&mut browser).await, error("Invalid clip id."));
    browser.send(Wire::binary(vec![1, 2, 3])).await.unwrap();
    assert_eq!(next_json(&mut browser).await, headerless);
    assert_still_answering(&mut browser, "after-bad-audio").await;
    assert!(state.0.accepted_clips.lock().await.0.is_empty());
}

#[tokio::test]
async fn a_clip_is_its_header_and_the_audio_frame_after_it() {
    let state = state();
    let served = Served::start(&state).await;
    let mut browser = served.connect().await;
    json_until(&mut browser, "history").await;
    let generation = state.0.coordinator.generation();
    let header =
        json!({"type":"clip", "id":"clip-1", "mime":"audio/webm", "generation":generation});

    send_json_frame(&mut browser, header.clone()).await;
    browser.send(Wire::binary(vec![4, 5, 6])).await.unwrap();
    assert_eq!(
        next_json(&mut browser).await,
        json!({"type":"accepted", "id":"clip-1"})
    );
    let mut clips = state.0.clip_rx.lock().await.take().unwrap();
    let clip = clips.try_recv().expect("the clip reached the clip worker");
    assert_eq!(
        (clip.id.as_str(), clip.audio.as_slice(), clip.generation),
        ("clip-1", &[4_u8, 5, 6][..], generation)
    );

    // The header is used up by the frame it named.
    browser.send(Wire::binary(vec![7])).await.unwrap();
    assert_eq!(
        next_json(&mut browser).await,
        json!({"type":"error", "message":"Audio arrived without a clip header."})
    );

    // A reconnecting browser resends what it has not seen acknowledged; the
    // same id is acknowledged again but not transcribed twice.
    send_json_frame(&mut browser, header).await;
    browser.send(Wire::binary(vec![4, 5, 6])).await.unwrap();
    assert_eq!(
        next_json(&mut browser).await,
        json!({"type":"accepted", "id":"clip-1"})
    );
    assert!(matches!(
        clips.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn a_connection_that_falls_a_queue_behind_is_dropped_and_a_reconnect_is_whole_again() {
    // Each connection has a bounded queue. A browser that stops draining it
    // is retired rather than waited on, so it cannot stall the call; it
    // loses the events past the bound and recovers them by reconnecting,
    // which delivers a fresh snapshot.
    let state = state();
    state
        .0
        .transcript_log
        .lock()
        .await
        .add_with_id(CALLER, "still here", OPERATOR, None);
    let served = Served::start(&state).await;

    // Holding the transcript keeps the connection's writer on its snapshot,
    // so nothing leaves its queue.
    let transcript = state.0.transcript_log.lock().await;
    let mut lagging = served.connect().await;
    wait_until(|| state.0.delivery.connected()).await;
    for n in 0..DELIVERY_QUEUE {
        assert!(
            emit(&state, Event::Json(json!({"type":"probe", "n":n}))),
            "{n}"
        );
    }
    assert!(
        !emit(
            &state,
            Event::Json(json!({"type":"probe", "n":DELIVERY_QUEUE}))
        ),
        "one past the bound is not delivered"
    );
    assert!(
        !state.0.delivery.connected(),
        "the lagging socket is retired"
    );
    drop(transcript);

    // It still gets its snapshot and what it had queued, then the socket
    // closes.
    let frames = json_until(&mut lagging, "history").await;
    assert_eq!(types_of(&frames), ["epoch", "status", "history"]);
    for n in 0..DELIVERY_QUEUE {
        assert_eq!(next_json(&mut lagging).await["n"], n);
    }
    let end = timeout(Duration::from_secs(5), lagging.next())
        .await
        .expect("the retired socket closes");
    assert!(
        matches!(end, None | Some(Err(_)) | Some(Ok(Wire::Close(_)))),
        "{end:?}"
    );

    let mut browser = served.connect().await;
    let frames = json_until(&mut browser, "history").await;
    assert_eq!(types_of(&frames), ["epoch", "status", "history"]);
    assert_eq!(frames[2]["entries"][0]["text"], "still here");
    assert!(emit(
        &state,
        Event::Json(json!({"type":"probe", "n":"live"}))
    ));
    assert_eq!(next_json(&mut browser).await["n"], "live");
}

#[cfg(unix)]
fn scratch_root(label: &str) -> std::path::PathBuf {
    let root =
        std::env::temp_dir().join(format!("switchboard-{label}-{}", crate::pbx::uuid_like()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// A pi stand-in that answers every prompt with `reply`.
#[cfg(unix)]
fn failing_agent(root: &std::path::Path) -> std::path::PathBuf {
    let path = root.join("failing-pi");
    crate::pi_client::write_executable_script(&path, "exit 1");
    path
}

#[cfg(unix)]
fn answering_agent(root: &std::path::Path, name: &str, reply: &str) -> std::path::PathBuf {
    let path = root.join(name);
    crate::pi_client::write_executable_script(
        &path,
        &format!(
            r#"while IFS= read -r line; do
  printf '%s\n' '{{"type":"message_update","assistantMessageEvent":{{"type":"text_end","content":"{reply}"}}}}'
  printf '%s\n' '{{"type":"agent_settled"}}'
done
"#
        ),
    );
    path
}

#[cfg(unix)]
#[tokio::test]
async fn both_routing_authorities_down_emit_a_page_error_without_audio() {
    let root = scratch_root("routing-unavailable");
    let binary = failing_agent(&root);
    let config = crate::Config::for_tests(&[("SWITCHBOARD_PI_BINARY", &binary.to_string_lossy())]);
    let registry = Registry::new(vec![]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("no projects are registered"),
    );
    let state = state_on(Switchboard::new(
        &config,
        registry,
        std::sync::Arc::new(prewarm),
    ));
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    let generation = state.0.coordinator.generation();
    state.0.routed_decisions.lock().await.insert(
        "down".into(),
        crate::router::Decision::fallback("Jev unavailable: test").into(),
    );
    state.0.queued_turns.store(1, Ordering::Release);
    let worker = tokio::spawn(process_turns(state.clone()));
    state
        .0
        .turns
        .send(("down".into(), "hello".into(), generation))
        .await
        .unwrap();

    let frames = frames_until(&mut connection, "routing_unavailable").await;

    assert!(types_of(&frames).contains(&"routing_unavailable"));
    assert!(!types_of(&frames).contains(&"reply"));
    assert!(!types_of(&frames).contains(&"final_response_audio_closed"));
    assert_eq!(
        frames.last().expect("routing error")["message"],
        "Routing is unavailable. Please try again."
    );
    worker.abort();
    let _ = worker.await;
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

/// An app whose operator is a pi stand-in under `root`, and whose one
/// project, alpha, runs on host scriptorium, where a fake host agent answers
/// every prompt "Alpha here.".
#[cfg(unix)]
fn state_with_agents(root: &std::path::Path) -> AppState {
    state_with_agents_speaker(
        root,
        Speaker::offline(100, std::time::Duration::from_millis(25_000)),
    )
}

fn state_with_agents_speaker(root: &std::path::Path, speaker: Speaker) -> AppState {
    state_with_agents_options(root, speaker, false)
}

fn state_with_agents_spoken_speaker(root: &std::path::Path, speaker: Speaker) -> AppState {
    state_with_agents_options(root, speaker, true)
}

fn state_with_agents_options(
    root: &std::path::Path,
    speaker: Speaker,
    speaks_during_turn: bool,
) -> AppState {
    let operator = answering_agent(root, "fake-operator", "Operator here.");
    let config =
        crate::Config::for_tests(&[("SWITCHBOARD_PI_BINARY", &operator.to_string_lossy())]);
    let registry = Registry::new(vec![serde_json::from_value(json!({
        "id": "alpha",
        "host": "scriptorium",
        "cwd": root.to_string_lossy(),
        "model": "anthropic/current",
    }))
    .unwrap()]);
    let catalog = crate::models::ModelCatalog {
        entries: vec![crate::models::CatalogEntry {
            provider: "anthropic".into(),
            model: "current".into(),
            thinks: true,
        }],
        available: true,
        diagnostic: None,
    };
    let prewarm = crate::prewarm::Prewarm::settled(&config, &registry, catalog);
    FakeHostAgent::new(Box::new(move |_, _| {
        let mut steps = Vec::new();
        if speaks_during_turn {
            steps.push(Step::Call("speak", json!({"text":"Foreground answer"})));
        }
        steps.push(Step::Event(json!({"kind":"text","text":"Alpha here."})));
        steps
    }))
    .serve(prewarm.hosts().connect_fake("scriptorium"));
    let state = AppState::new(
        Switchboard::new(&config, registry, std::sync::Arc::new(prewarm)),
        TranscriptLog::new(10),
        speaker,
        SttAdapter::from_command(None),
        SttStreamAdapter::from_command(None),
    );
    if tokio::runtime::Handle::try_current().is_ok() {
        start_speech_worker_for_test(&state);
    }
    state
}

#[tokio::test]
async fn a_slow_desk_host_does_not_hold_the_pbx_lock_during_routing_summary() {
    let (client, _, _) = fake_jev_client();
    let registry = Registry::new(vec![serde_json::from_value(json!({
        "id": "alpha",
        "host": "scriptorium",
        "cwd": "/srv/alpha",
    }))
    .unwrap()]);
    let state = state_with_jev(client, registry);
    let host = state.0.switchboard.lock().await.hosts();
    let listed = std::sync::Arc::new(tokio::sync::Notify::new());
    let listed_for_host = listed.clone();
    let mut fake = FakeHostAgent::new(Box::new(|_, _| vec![]));
    fake.on_command = Some(Box::new(move |name, _| {
        if name == "list_sessions" {
            listed_for_host.notify_one();
            return Some(None);
        }
        None
    }));
    fake.serve(host.connect_fake("scriptorium"));

    let routing_state = state.clone();
    let routing =
        tokio::spawn(
            async move { route_transcript(&routing_state, "caller asks about alpha").await },
        );
    timeout(Duration::from_secs(1), listed.notified())
        .await
        .expect("the routing summary queried the host");
    let guard = timeout(Duration::from_secs(1), state.0.switchboard.lock())
        .await
        .expect("a slow host query does not hold the PBX lock");
    drop(guard);
    host.disconnect_fake("scriptorium");
    let _ = routing
        .await
        .expect("routing completed after the host link closed");
    state.0.switchboard.lock().await.shutdown().await;
}

#[tokio::test]
async fn takeover_desk_listing_does_not_hold_the_pbx_lock() {
    let (client, _, _) = fake_jev_client();
    let registry = Registry::new(vec![serde_json::from_value(json!({
        "id": "alpha",
        "host": "scriptorium",
        "cwd": "/srv/alpha",
    }))
    .unwrap()]);
    let state = state_with_jev(client, registry);
    let host = state.0.switchboard.lock().await.hosts();
    let listed = std::sync::Arc::new(tokio::sync::Notify::new());
    let listed_for_host = listed.clone();
    let mut fake = FakeHostAgent::new(Box::new(|_, _| vec![]));
    fake.on_command = Some(Box::new(move |name, _| {
        if name == "list_sessions" {
            listed_for_host.notify_one();
            return Some(None);
        }
        None
    }));
    fake.serve(host.connect_fake("scriptorium"));

    state.0.routed_decisions.lock().await.insert(
        "takeover-lock".into(),
        crate::router::Decision {
            action: crate::router::Action::TakeOver,
            target: Some("alpha".into()),
            continue_or_fresh: None,
            confidence: 1.0,
            for_current_agent: 0.0,
            multi_target: false,
            unsure: false,
            confirm: false,
            reason: "test".into(),
        }
        .into(),
    );
    let generation = state.0.coordinator.generation();
    state.0.queued_turns.store(1, Ordering::Release);
    let worker = tokio::spawn(process_turns(state.clone()));
    state
        .0
        .turns
        .send(("takeover-lock".into(), "take over alpha".into(), generation))
        .await
        .unwrap();

    timeout(Duration::from_secs(1), listed.notified())
        .await
        .expect("takeover queried the host");
    let guard = timeout(Duration::from_secs(1), state.0.switchboard.lock())
        .await
        .expect("a slow takeover listing does not hold the PBX lock");
    drop(guard);
    host.disconnect_fake("scriptorium");
    worker.abort();
    let _ = worker.await;
    state.0.switchboard.lock().await.shutdown().await;
}

#[tokio::test]
async fn floor_good_moment_gate_does_not_query_desk_hosts() {
    let (client, _, jev_called) = fake_jev_client();
    let config = crate::Config::for_tests(&[
        ("SWITCHBOARD_PI_BINARY", "/bin/sh"),
        ("SWITCHBOARD_FLOOR_QUIET_THRESHOLD_MS", "1"),
    ]);
    let registry = Registry::new(vec![serde_json::from_value(json!({
        "id": "alpha",
        "host": "scriptorium",
        "cwd": "/srv/alpha",
    }))
    .unwrap()]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("test catalog"),
    );
    let state = state_on(Switchboard::new_with_jev(
        &config,
        registry,
        std::sync::Arc::new(prewarm),
        client,
    ));
    let host = state.0.switchboard.lock().await.hosts();
    let listed = std::sync::Arc::new(tokio::sync::Notify::new());
    let listed_for_host = listed.clone();
    let mut fake = FakeHostAgent::new(Box::new(|_, _| vec![]));
    fake.on_command = Some(Box::new(move |name, _| {
        if name == "list_sessions" {
            listed_for_host.notify_one();
            return Some(None);
        }
        None
    }));
    fake.serve(host.connect_fake("scriptorium"));
    let (_connection, _, _) = state.register_connection().await;
    state
        .0
        .coordinator
        .register_background("alpha", "alpha-token");
    state
        .0
        .floor
        .enqueue(crate::floor::FloorRequest {
            project: "alpha".into(),
            token: "alpha-token".into(),
            generation: state.0.coordinator.generation(),
            context: "caller: previous line".into(),
            message: "alpha finished".into(),
            reason: "finished".into(),
            held_display: false,
        })
        .await;
    state.0.floor.force_quiet_for_test().await;
    spawn_floor_worker(state.clone());

    timeout(Duration::from_secs(1), jev_called.notified())
        .await
        .expect("floor gate asked Jev about the good moment");
    assert!(
        timeout(Duration::from_millis(100), listed.notified())
            .await
            .is_err(),
        "floor admission does not discover desk sessions"
    );
    host.disconnect_fake("scriptorium");
}

#[tokio::test]
async fn hanging_up_with_nothing_on_the_line_says_so() {
    let state = state();
    let (mut connection, _, _) = state.register_connection().await;
    let before = state.0.coordinator.generation();

    let (code, body) = request_json(&state, Method::POST, "/hangup", None).await;

    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        body,
        json!({"hungup":false, "reason":"already on the operator"})
    );
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
    // It is still a rescue: the epoch moves, so speech recorded before the
    // press is not acted on. And like every page control it settles the call
    // on its way out, so the call is not left quiescing.
    let frames = queued_frames(&mut connection);
    assert_eq!(types_of(&frames), ["epoch", "status"]);
    assert_eq!(frames[0]["generation"], before + 1);
    assert_eq!(frames[1]["route"], OPERATOR);
    // Settled: the operator's callbacks and turns are taken again.
    let coordinator = &state.0.coordinator;
    assert_eq!(coordinator.accept_side_effect("", None, None), Ok(()));
    assert!(coordinator
        .begin_prompt(&coordinator.current_identity())
        .is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn hanging_up_the_operator_from_the_page_discards_its_process() {
    let root = scratch_root("api-hangup-operator");
    let state = state_with_agents(&root);
    let (mut connection, _, _) = state.register_connection().await;
    state.0.switchboard.lock().await.handle("hello").await;
    let operator = state
        .0
        .active_session
        .lock()
        .await
        .clone()
        .expect("the operator is live");
    queued_frames(&mut connection);
    let before = state.0.coordinator.generation();

    let (code, body) = request_json(&state, Method::POST, "/hangup", None).await;

    assert_eq!(code, StatusCode::OK);
    assert_eq!(body, json!({"hungup":true, "left":"operator"}));
    assert!(!operator.alive().await);
    assert!(state.0.active_session.lock().await.is_none());
    let frames = queued_frames(&mut connection);
    assert_eq!(types_of(&frames), ["epoch", "spoken", "status"]);
    assert_eq!(frames[0]["generation"], before + 1);
    assert_eq!(
        frames[1]["entry"]["text"],
        "You cut the operator off. It starts fresh when you speak again."
    );
    assert_eq!(frames[2]["route"], OPERATOR);

    // The operator is the home base: the next utterance starts a new one.
    let reply = state.0.switchboard.lock().await.handle("hello again").await;
    assert_eq!(reply.text, "Operator here.");
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn hanging_up_a_project_leg_from_the_page_does_not_wait_for_its_turn() {
    let root = scratch_root("api-hangup-project");
    let state = state_with_agents(&root);
    {
        let mut board = state.0.switchboard.lock().await;
        board.handle("hello").await;
        let context = crate::pbx::TransferContext {
            exact_caller_transcript: "put me through to alpha".into(),
            ..Default::default()
        };
        let reply = board.transfer_ctx(&context, "alpha", "", "").await;
        assert_eq!(reply.route, "alpha", "{reply:?}");
    }
    let project = state
        .0
        .active_session
        .lock()
        .await
        .clone()
        .expect("alpha is live");
    assert_eq!(project.label(), "alpha");

    // A turn that will never settle holds the PBX lock.
    let (locked_tx, locked_rx) = oneshot::channel();
    let turn_state = state.clone();
    let (wedged, _, _) = spawn_active_operation(&state, async move {
        hold_turn_lock(&turn_state, Some(locked_tx)).await;
    })
    .await
    .unwrap();
    locked_rx.await.unwrap();
    let (mut connection, _, _) = state.register_connection().await;
    let before = state.0.coordinator.generation();

    let (code, body) = timeout(
        Duration::from_secs(5),
        request_json(&state, Method::POST, "/hangup", None),
    )
    .await
    .expect("a hangup must not wait for the turn it rescues the caller from");

    assert_eq!(code, StatusCode::OK);
    assert_eq!(body, json!({"hungup":true, "left":"alpha"}));
    assert!(wedged.await.unwrap_err().is_cancelled());
    assert!(!project.alive().await, "alpha was left running");
    assert_eq!(state.0.coordinator.route(), OPERATOR);
    assert_eq!(current_status(&state).route, OPERATOR);
    let active = state.0.active_session.lock().await.clone();
    assert_eq!(active.as_ref().map(LegSession::label), Some(OPERATOR));
    assert!(active.unwrap().alive().await, "the operator keeps running");

    let frames = queued_frames(&mut connection);
    assert_eq!(frames[0]["type"], "epoch", "{frames:#?}");
    for epoch in frames.iter().filter(|frame| frame["type"] == "epoch") {
        assert_eq!(epoch["generation"], before + 1, "{frames:#?}");
    }
    let spoken = frames
        .iter()
        .find(|frame| frame["type"] == "spoken")
        .expect("the hangup is written into the transcript");
    assert_eq!(
        spoken["entry"]["text"],
        "You hung up the line to alpha. You're back with the operator."
    );
    assert_eq!(spoken["entry"]["route"], OPERATOR);
    let last = frames.last().unwrap();
    assert_eq!(
        (&last["type"], &last["route"]),
        (&json!("status"), &json!(OPERATOR))
    );
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

// ---------------------------------------------------------------------------
// The model and thinking pickers decide a redial before they touch the live
// leg (#63). A refusal leaves the leg running and the caller's next turn
// reaches it; only a redial that goes ahead cancels running work.

fn catalog_of(models: &[&str]) -> crate::models::ModelCatalog {
    crate::models::ModelCatalog {
        entries: models
            .iter()
            .map(|model| crate::models::CatalogEntry {
                provider: "anthropic".into(),
                model: (*model).into(),
                thinks: true,
            })
            .collect(),
        available: true,
        diagnostic: None,
    }
}

/// A call the page has put through to alpha, whose session runs on host
/// scriptorium behind a fake host agent that answers every prompt "On it.".
#[cfg(unix)]
struct AlphaCall {
    state: AppState,
    prewarm: Arc<crate::prewarm::Prewarm>,
    project: crate::registry::Project,
    /// alpha's session, as the page put the caller through to it.
    live: LegSession,
    /// What alpha's host agent was sent.
    host: FakeLog,
}

#[cfg(unix)]
async fn call_on_alpha(settings: &[(&str, &str)]) -> AlphaCall {
    let config = crate::Config::for_tests(settings);
    let project: crate::registry::Project = serde_json::from_value(json!({
        "id": "alpha",
        "host": "scriptorium",
        "cwd": "/srv/alpha",
        "model": "anthropic/current",
    }))
    .unwrap();
    let registry = Registry::new(vec![project.clone()]);
    let prewarm = Arc::new(crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        catalog_of(&["current", "next"]),
    ));
    let host = FakeHostAgent::new(Box::new(|_, _| {
        vec![Step::Event(json!({"kind":"text","text":"On it."}))]
    }))
    .serve(prewarm.hosts().connect_fake("scriptorium"));
    let state = state_on(Switchboard::new(&config, registry, Arc::clone(&prewarm)));
    let (code, connected) = request_json(
        &state,
        Method::POST,
        "/connect",
        Some(json!({"project":"alpha"})),
    )
    .await;
    assert_eq!(
        (code, connected),
        (StatusCode::OK, json!({"route":"alpha", "error":null}))
    );
    assert_eq!(
        state.0.coordinator.status().model,
        "anthropic/current:medium"
    );
    let live = state
        .0
        .active_session
        .lock()
        .await
        .clone()
        .expect("alpha is the live session");
    assert_eq!(live.label(), "alpha");
    AlphaCall {
        state,
        prewarm,
        project,
        live,
        host,
    }
}

#[cfg(unix)]
impl AlphaCall {
    /// Posts a picker request the switchboard refuses and checks that it left
    /// the live leg alone: nothing rescued (the generation stays put and no
    /// epoch is sent), alpha's session still running, and the refusal told to
    /// the caller the way any page reply is. Returns the answer's `error`.
    async fn refused(&self, path: &str, body: Value, told: &str) -> Value {
        let state = &self.state;
        let generation = state.0.coordinator.generation();
        let before = state.0.coordinator.status();
        let (mut connection, _snapshot, _watermark) = state.register_connection().await;

        let (code, answer) = request_json(state, Method::POST, path, Some(body.clone())).await;

        assert_eq!(code, StatusCode::OK, "{path} {body}: {answer}");
        assert!(
            self.live.alive().await,
            "{path} {body} closed the live leg: {answer}"
        );
        assert_eq!(
            state.0.coordinator.generation(),
            generation,
            "{path} {body} rescued the call"
        );
        let after = state.0.coordinator.status();
        assert_eq!(
            (after.route.as_str(), after.model.as_str()),
            (before.route.as_str(), before.model.as_str())
        );
        let frames = queued_frames(&mut connection);
        assert!(!types_of(&frames).contains(&"epoch"), "{frames:#?}");
        let spoken = frames
            .iter()
            .find(|frame| frame["type"] == "spoken")
            .expect("the refusal is told to the caller");
        assert!(
            spoken["entry"]["text"].as_str().unwrap().contains(told),
            "{spoken}"
        );
        assert_eq!(spoken["entry"]["route"], "alpha");
        answer["error"].clone()
    }

    /// The caller's next turn reaches alpha's live session, which was never
    /// replaced or changed.
    async fn assert_next_turn_reaches_alpha(&self) {
        let reply = self
            .state
            .0
            .switchboard
            .lock()
            .await
            .handle("are you still there?")
            .await;
        assert_eq!(
            (
                reply.route.as_str(),
                reply.text.as_str(),
                reply.error.as_deref()
            ),
            ("alpha", "On it.", None)
        );
        assert!(self.live.alive().await);
        assert_eq!(
            self.host.named("create_session").len(),
            1,
            "alpha was replaced"
        );
        assert!(self.host.named("set_model").is_empty());
        assert!(self.host.named("set_thinking").is_empty());
    }

    async fn hang_up(self) {
        self.state.0.switchboard.lock().await.shutdown().await;
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_picker_asking_for_what_is_running_leaves_its_leg_running() {
    let call = call_on_alpha(&[]).await;

    for (path, body) in [
        ("/model", json!({"model":"anthropic/current"})),
        ("/thinking", json!({"level":"medium"})),
    ] {
        let error = call
            .refused(
                path,
                body,
                "Already on current on anthropic, thinking medium.",
            )
            .await;
        assert_eq!(error, Value::Null);
    }

    call.assert_next_turn_reaches_alpha().await;
    call.hang_up().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_picker_the_catalog_does_not_resolve_leaves_its_leg_running() {
    let call = call_on_alpha(&[]).await;

    let error = call
        .refused(
            "/model",
            json!({"model":"openai/missing"}),
            "I couldn't change the model.",
        )
        .await;
    assert!(error.is_string(), "{error}");
    // A refreshed catalog that no longer lists alpha's model: the thinking
    // picker keeps the model, and it no longer resolves.
    call.prewarm.settle_catalog(
        "scriptorium",
        crate::prewarm::CatalogState::Ready {
            snapshot: crate::models::ModelCatalog {
                entries: vec![crate::models::CatalogEntry {
                    provider: "openai".into(),
                    model: "next".into(),
                    thinks: true,
                }],
                available: true,
                diagnostic: None,
            },
            degraded_reason: None,
        },
    );
    let error = call
        .refused(
            "/thinking",
            json!({"level":"high"}),
            "I couldn't change the model.",
        )
        .await;
    assert!(error.is_string(), "{error}");

    call.assert_next_turn_reaches_alpha().await;
    call.hang_up().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_picker_on_a_host_prewarm_cannot_vouch_for_leaves_its_leg_running() {
    let call = call_on_alpha(&[]).await;
    call.prewarm.settle_prepare(
        &call.project,
        crate::prewarm::PrepareState::InfrastructureFailed {
            reason: "the prepare runner is gone".into(),
        },
    );

    for (path, body) in [
        ("/model", json!({"model":"anthropic/next"})),
        ("/thinking", json!({"level":"high"})),
    ] {
        let error = call
            .refused(path, body, "I couldn't change the model.")
            .await;
        assert!(
            error
                .as_str()
                .is_some_and(|error| error.contains("prepare infrastructure failed")),
            "{error}"
        );
    }

    call.assert_next_turn_reaches_alpha().await;
    call.hang_up().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_picker_with_swaps_turned_off_leaves_its_leg_running() {
    let call = call_on_alpha(&[("SWITCHBOARD_MODEL_SWAPS", "0")]).await;

    for (path, body) in [
        ("/model", json!({"model":"anthropic/next"})),
        ("/thinking", json!({"level":"high"})),
    ] {
        let error = call
            .refused(path, body, "Model changes are turned off.")
            .await;
        assert_eq!(error, Value::Null);
    }

    call.assert_next_turn_reaches_alpha().await;
    call.hang_up().await;
}

#[tokio::test]
async fn a_picker_on_the_operator_answers_without_touching_its_turn() {
    let config = crate::Config::for_tests(&[]);
    let registry = Registry::new(vec![]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("no projects are registered"),
    );
    let state = state_on(Switchboard::new(&config, registry, Arc::new(prewarm)));
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
    *state.0.active_session.lock().await = Some(LegSession::Operator(operator.clone()));
    // The operator's turn holds the PBX lock and does not let go.
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
    let generation = state.0.coordinator.generation();

    for (path, body, told, error) in [
        (
            "/model",
            json!({"model":"anthropic/next"}),
            "I can only change the model while we're on a project.",
            json!("Model changes are only available on a project leg."),
        ),
        (
            "/thinking",
            json!({"level":"high"}),
            "Thinking is set to high for the next project I open.",
            Value::Null,
        ),
    ] {
        let (code, answer) = timeout(
            Duration::from_secs(1),
            request_json(&state, Method::POST, path, Some(body)),
        )
        .await
        .expect("a picker on the operator must not wait for the operator's turn");
        assert_eq!(code, StatusCode::OK);
        assert_eq!(answer["error"], error);
        assert_eq!(
            last_transcript_line(&state).await,
            Some((told.to_owned(), OPERATOR.to_owned()))
        );
    }

    assert!(!turn.is_finished(), "the operator's turn was cancelled");
    assert!(operator.alive().await);
    assert_eq!(state.0.coordinator.generation(), generation);
    assert_eq!(state.0.coordinator.status().thinking_default, "high");
    turn.abort();
    operator.close().await;
}

/// Holds the PBX lock the way a wedged turn on alpha would, registered so a
/// rescue can cancel it.
#[cfg(unix)]
async fn wedge_a_turn(state: &AppState) -> JoinHandle<()> {
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
    turn
}

#[cfg(unix)]
#[tokio::test]
async fn a_picker_model_change_cancels_a_wedged_turn_and_keeps_the_session() {
    let call = call_on_alpha(&[]).await;
    let state = &call.state;
    let turn = wedge_a_turn(state).await;
    let generation = state.0.coordinator.generation();

    let (code, answer) = timeout(
        Duration::from_secs(5),
        request_json(
            state,
            Method::POST,
            "/model",
            Some(json!({"model":"anthropic/next"})),
        ),
    )
    .await
    .expect("a model change must not wait for the turn it interrupts");

    assert_eq!(
        (code, answer),
        (
            StatusCode::OK,
            json!({"model":"anthropic/next", "error":null})
        )
    );
    assert!(turn.await.unwrap_err().is_cancelled());
    // The same session, changed in place: its turn was aborted, not ended.
    let swapped = state
        .0
        .active_session
        .lock()
        .await
        .clone()
        .expect("alpha is live");
    assert!(swapped.same_session(&call.live));
    assert!(call.live.alive().await);
    until_named(&call.host, "abort").await;
    assert_eq!(
        call.host.named("set_model"),
        [json!({"session":"s1", "provider":"anthropic", "model":"next"})]
    );
    assert_eq!(
        call.host.named("set_thinking"),
        [json!({"session":"s1", "level":"medium"})]
    );
    assert!(call.host.named("kill").is_empty());
    assert_eq!(call.host.named("create_session").len(), 1);
    // A new call token for the changed leg.
    let joins = call.host.named("join_call");
    assert_eq!(joins.len(), 2);
    assert_ne!(joins[0]["token"], joins[1]["token"]);
    assert_eq!(state.0.coordinator.status().model, "anthropic/next:medium");
    assert!(state.0.coordinator.generation() > generation);
    let reply = state.0.switchboard.lock().await.handle("go on").await;
    assert_eq!(
        (reply.route.as_str(), reply.text.as_str()),
        ("alpha", "On it.")
    );
    call.hang_up().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_picker_redial_decided_for_a_leg_the_caller_has_left_cancels_nothing() {
    let call = call_on_alpha(&[]).await;
    let state = &call.state;
    // Prewarm is refreshing alpha's catalog, so the decision waits on it.
    call.prewarm
        .settle_catalog("scriptorium", crate::prewarm::CatalogState::Pending);
    let request_state = state.clone();
    let request = tokio::spawn(async move {
        request_json(
            &request_state,
            Method::POST,
            "/model",
            Some(json!({"model":"anthropic/next"})),
        )
        .await
    });
    // The decision has read alpha's leg and waits for the catalog.
    let mut polls = 0;
    while call.prewarm.catalog_waiters("scriptorium") == 0 {
        polls += 1;
        assert!(polls < 10_000, "the decision never asked for a launch plan");
        tokio::task::yield_now().await;
    }
    // Meanwhile the caller leaves alpha. A return to the operator keeps the
    // generation, so any rescue from here on would show.
    let left = state.0.switchboard.lock().await.force_hangup().await;
    assert_eq!(left.as_deref(), Some("alpha"));
    let generation = state.0.coordinator.generation();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    call.prewarm.settle_catalog(
        "scriptorium",
        crate::prewarm::CatalogState::Ready {
            snapshot: catalog_of(&["current", "next"]),
            degraded_reason: None,
        },
    );

    let (code, answer) = request.await.unwrap();

    assert_eq!(
        (code, answer),
        (
            StatusCode::CONFLICT,
            json!({"detail":"model change was superseded"})
        )
    );
    assert_eq!(state.0.coordinator.generation(), generation);
    assert!(queued_frames(&mut connection).is_empty());
    assert_eq!(state.0.coordinator.route(), OPERATOR);
    assert_eq!(call.host.named("create_session").len(), 1);
    assert!(call.host.named("set_model").is_empty());
    call.hang_up().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_picker_redial_whose_leg_is_left_after_its_rescue_is_refused() {
    let call = call_on_alpha(&[]).await;
    let state = &call.state;
    // alpha's turn holds the PBX lock and does not let go; the redial's
    // rescue cancels it.
    let turn = wedge_a_turn(state).await;
    // Queued behind that turn for the PBX lock, and not an operation a rescue
    // cancels: something that moves the caller before the redial gets the
    // lock. Here it hangs up. Its lock request is queued by the time the
    // signal is received.
    let (queued_tx, queued_rx) = oneshot::channel();
    let mover_state = state.clone();
    let mover = tokio::spawn(async move {
        let board = mover_state.0.switchboard.lock();
        let _ = queued_tx.send(());
        board.await.force_hangup().await
    });
    queued_rx.await.unwrap();

    let (code, answer) = timeout(
        Duration::from_secs(5),
        request_json(
            state,
            Method::POST,
            "/model",
            Some(json!({"model":"anthropic/next"})),
        ),
    )
    .await
    .expect("the redial must not wait for the turn it replaces");

    assert_eq!(
        (code, answer),
        (
            StatusCode::CONFLICT,
            json!({"detail":"model change was superseded"})
        )
    );
    assert!(turn.await.unwrap_err().is_cancelled());
    assert_eq!(mover.await.unwrap().as_deref(), Some("alpha"));
    assert_eq!(state.0.coordinator.route(), OPERATOR);
    assert!(call.host.named("set_model").is_empty());
    until_named(&call.host, "kill").await;
    // The redial's rescue is settled on its way out.
    let coordinator = &state.0.coordinator;
    assert!(coordinator
        .begin_prompt(&coordinator.current_identity())
        .is_ok());
    call.hang_up().await;
}

/// Sends clip `id` again as the browser's outbox does after a reconnect: the
/// same id, bytes, and stamp.
async fn resend_clip(state: &AppState, connection: &DeliveryConnection, id: &str, generation: u64) {
    let mut header = None;
    let clip = json!({"type":"clip", "id":id, "mime":"audio/webm", "generation":generation});
    handle_text_frame(
        state,
        connection.epoch,
        &mut header,
        &mut None,
        &clip.to_string(),
    )
    .await
    .unwrap();
    handle_audio_frame(
        state,
        connection.epoch,
        &mut header,
        &mut None,
        b"speech".to_vec(),
    )
    .await
    .unwrap();
}

/// Waits for the verdict on clip `id` to be emitted, whether or not a
/// connection is there to receive it.
async fn verdict_emitted(events: &mut broadcast::Receiver<Event>, id: &str) -> Value {
    loop {
        let event = timeout(Duration::from_secs(2), events.recv())
            .await
            .expect("a verdict before the deadline")
            .expect("the event stream stays open");
        if let Event::Json(value) = event {
            if value["id"] == id && matches!(value["type"].as_str(), Some("transcript" | "error")) {
                return value;
            }
        }
    }
}

// Issue #71: a verdict that lands while the tab is disconnected went nowhere,
// and the resend after the reconnect was taken as a duplicate and never
// answered.
#[tokio::test]
async fn a_clip_resent_after_its_verdict_was_missed_is_answered_with_it() {
    let state = state_with_stt(Some(HEARD_WHILE_CONNECTING.into()));
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    let generation = state.0.coordinator.generation();
    upload_clip(&state, &mut connection, "missed", generation).await;

    // The tab drops before the clip is transcribed.
    state.0.delivery.retire(connection.epoch);
    let mut events = state.0.events.subscribe();
    let clip_worker = tokio::spawn(process_clips(state.clone()));
    let verdict = verdict_emitted(&mut events, "missed").await;
    assert_eq!(verdict["type"], "transcript");

    // The tab is back and sends the clip it never heard about.
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    resend_clip(&state, &connection, "missed", generation).await;
    let frames = frames_until(&mut connection, "transcript").await;
    assert_eq!(
        types_of(&frames),
        ["transcript"],
        "answered, not accepted again"
    );
    assert_eq!(frames[0], verdict);
    // Answered from memory: the clip is not transcribed or queued twice.
    assert_eq!(state.0.queued_turns.load(Ordering::Acquire), 1);
    assert_eq!(state.0.transcript_log.lock().await.entries().len(), 1);

    clip_worker.abort();
}

#[tokio::test]
async fn a_stale_clip_resent_after_a_reconnect_is_told_it_was_dropped() {
    let state = state_with_stt(Some(HEARD_WHILE_CONNECTING.into()));
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    let old = state.0.coordinator.generation();
    upload_clip(&state, &mut connection, "stale", old).await;
    state.0.delivery.retire(connection.epoch);
    // The leg changes while the tab is away, so the clip is dropped.
    state.0.coordinator.begin_rescue("page rescue");
    let mut events = state.0.events.subscribe();
    let clip_worker = tokio::spawn(process_clips(state.clone()));
    verdict_emitted(&mut events, "stale").await;

    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    resend_clip(&state, &connection, "stale", old).await;
    let frames = frames_until(&mut connection, "error").await;
    assert_eq!(types_of(&frames), ["error"]);
    assert_dropped_with_notice(&frames[0], "stale");
    assert_never_queued(&state).await;

    clip_worker.abort();
}

#[test]
fn clip_verdicts_are_bounded_and_keep_the_latest_word() {
    let mut verdicts = ClipVerdicts::default();
    verdicts.record("first", ServerMessage::error_for("first", "one"));
    verdicts.record("first", ServerMessage::error_for("first", "two"));
    assert_eq!(
        verdicts.get("first"),
        Some(ServerMessage::error_for("first", "two"))
    );
    for index in 0..REMEMBERED_CLIP_VERDICTS {
        verdicts.record(&format!("clip-{index}"), ServerMessage::error("x"));
    }
    assert_eq!(
        verdicts.get("first"),
        None,
        "the oldest verdict is forgotten"
    );
    assert!(verdicts.get("clip-0").is_some());
    assert_eq!(verdicts.by_id.len(), REMEMBERED_CLIP_VERDICTS);
    assert_eq!(verdicts.oldest_first.len(), REMEMBERED_CLIP_VERDICTS);
}

// Issue #70: the browser carries speech recorded while a leg was connecting
// to the next epoch only when that leg was adopted, so the clear notice must
// say which way the candidate ended.
#[tokio::test]
async fn the_candidate_clear_notice_says_how_the_candidate_ended() {
    let state = state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    begin_alpha_candidate(&state, "alpha-leg");
    let frames = frames_until(&mut connection, "candidate").await;
    assert_eq!(frames.last().unwrap()["route"], "alpha");

    // A hangup while connecting: the clear notice comes first, then the epoch.
    cancel_active_operations(&state).await;
    let frames = frames_until(&mut connection, "epoch").await;
    assert_eq!(types_of(&frames), ["candidate_cleared", "epoch"]);
    assert_eq!(frames[0]["reason"], "rescued");
    assert_eq!(
        frames[0]["route"], "alpha",
        "it names the leg that was starting"
    );

    begin_alpha_candidate(&state, "alpha-leg-2");
    frames_until(&mut connection, "candidate").await;
    assert!(state.0.leg_announcer.promote_candidate("alpha-leg-2").await);
    let frames = frames_until(&mut connection, "epoch").await;
    assert_eq!(types_of(&frames), ["candidate_cleared", "epoch"]);
    assert_eq!(frames[0]["reason"], "adopted");
    assert_eq!(frames[0]["route"], "alpha");
    assert_eq!(frames[0]["generation"], frames[1]["generation"]);
}

fn snapshot_types(messages: &[ServerMessage]) -> Vec<String> {
    messages
        .iter()
        .map(|message| message.to_value()["type"].as_str().unwrap().to_owned())
        .collect()
}

// Issue #70, for a tab that was away: it misses the live clear notice, so the
// snapshot has to say whether the epoch it announces is an adoption's.
#[tokio::test]
async fn a_snapshot_names_the_adoption_only_while_the_adopted_leg_is_on_the_line() {
    let state = state();
    assert_eq!(
        snapshot_types(&snapshot_messages(&state).await),
        ["epoch", "status", "history"]
    );

    begin_alpha_candidate(&state, "alpha-leg");
    assert!(state.0.leg_announcer.promote_candidate("alpha-leg").await);
    let generation = state.0.coordinator.generation();
    let snapshot = snapshot_messages(&state).await;
    assert_eq!(
        snapshot_types(&snapshot),
        ["candidate_cleared", "epoch", "status", "history"]
    );
    assert_eq!(
        snapshot[0],
        ServerMessage::CandidateCleared {
            route: "alpha".into(),
            generation,
            reason: CandidateEnd::Adopted,
        }
    );
    assert_eq!(snapshot[1], ServerMessage::Epoch { generation });

    // The caller hangs up: the epoch moves, and it is not an adoption's.
    cancel_active_operations(&state).await;
    assert_eq!(
        snapshot_types(&snapshot_messages(&state).await),
        ["epoch", "status", "history"]
    );
}

#[tokio::test]
async fn module_calls_are_answered_by_the_callback_logic_with_a_reply_status() {
    let state = state();
    // Nothing is connected to hear it.
    let speak = module_call(
        &state,
        AgentCall {
            call: "speak".into(),
            token: String::new(),
            turn_id: None,
            cause: None,
            args: json!({"text": "Hello."}),
        },
    )
    .await;
    assert_eq!(
        (speak["status"].clone(), speak["reason"].clone()),
        (json!("refused"), json!("no browser connected"))
    );
    // A display the scene takes with no browser to show it is accepted.
    let display = module_call(
        &state,
        AgentCall {
            call: "display".into(),
            token: String::new(),
            turn_id: None,
            cause: None,
            args: diagram_show(),
        },
    )
    .await;
    assert_eq!(display["status"], "accepted", "{display}");
    // An invalid action is refused with the validator's reason.
    let invalid = module_call(
        &state,
        AgentCall {
            call: "display".into(),
            token: String::new(),
            turn_id: None,
            cause: None,
            args: json!({"action": {"op": "show", "id": "x", "type": "bogus", "data": {}}}),
        },
    )
    .await;
    assert_eq!(invalid["status"], "refused");
    assert!(invalid["reason"]
        .as_str()
        .is_some_and(|reason| !reason.is_empty()));
    // The view reports the screen state as the module reads it.
    let view = module_call(
        &state,
        AgentCall {
            call: "view".into(),
            token: String::new(),
            turn_id: None,
            cause: None,
            args: json!({}),
        },
    )
    .await;
    assert_eq!(view["status"], "delivered");
    assert_eq!(view["result"]["screen"]["has_visual"], true);
    assert_eq!(view["result"]["screen"]["connected"], false);
}

#[tokio::test]
async fn a_module_call_carrying_a_retired_token_is_refused() {
    let state = state();
    begin_alpha_candidate(&state, "alpha-leg");
    assert!(state.0.leg_announcer.promote_candidate("alpha-leg").await);
    let stale = module_call(
        &state,
        AgentCall {
            call: "display".into(),
            token: "an-earlier-leg".into(),
            turn_id: None,
            cause: None,
            args: diagram_show(),
        },
    )
    .await;
    assert_eq!(stale["status"], "refused", "{stale}");
    assert!(stale["reason"]
        .as_str()
        .unwrap()
        .contains("no longer on the call"));
    assert!(state
        .0
        .display_gate
        .lock()
        .await
        .projection
        .snapshot_actions()
        .is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn floor_pbx_api_flow_gates_rewrites_announces_and_plays_in_order() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-floor-{}-{}",
        std::process::id(),
        crate::pbx::uuid_like()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let utility = root.join("fake-utility");
    crate::pi_client::write_executable_script(
        &utility,
        r##"rewrite_count=0
while IFS= read -r line; do
case "$line" in
  *"FLOOR REWRITE"*)
    rewrite_count=$((rewrite_count + 1))
    if [ "$rewrite_count" -eq 1 ]; then
      printf '%s\n' '{"type":"tool_execution_start","toolName":"rewrite","args":{"text":"the ablation numbers are ready"}}'
    else
      printf '%s\n' '{"type":"tool_execution_start","toolName":"rewrite","args":{"text":"   "}}'
    fi
    ;;
  *)
    printf '%s\n' '{"type":"tool_execution_start","toolName":"dispatch_parts","args":{"parts":[{"agent":"grapes","text":"the latest ablation numbers are ready"},{"agent":"switchboard","text":"answer the caller"}]}}'
    ;;
esac
printf '%s\n' '{"type":"agent_settled"}'
done
"##,
    );
    let foreground_release = std::sync::Arc::new(tokio::sync::Notify::new());
    let gate_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let gate_wait = foreground_release.clone();
    let gate_count = gate_calls.clone();
    let jev = crate::jev::JevClient::new(
        "http://unused.invalid/v1/systemone",
        "/nonexistent/typesafe-api-key",
        Duration::from_secs(1),
    )
    .expect("client")
    .with_test_responder(move |request| {
        let gate_wait = gate_wait.clone();
        let gate_count = gate_count.clone();
        async move {
            if request.questions.contains_key("good_moment")
                && gate_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0
            {
                gate_wait.notified().await;
            }
            let answers = if request.questions.contains_key("good_moment") {
                serde_json::json!({
                    "good_moment": {"type":"choice","choice":"yes","probabilities":{"yes":1.0},"confidence":1.0}
                })
            } else {
                serde_json::json!({
                    "action": {"type":"choice","choice":"general","probabilities":{"general":1.0},"confidence":1.0},
                    "for_current_agent": {"type":"noul","noul":0.0},
                    "target": {"type":"choice","choice":"none","probabilities":{"none":1.0},"confidence":1.0},
                    "continue_or_fresh": {"type":"choice","choice":"not_applicable","probabilities":{"not_applicable":1.0},"confidence":1.0},
                    "multi_target": {"type":"noul","noul":1.0}
                })
            };
            Ok(serde_json::from_value(serde_json::json!({"model":"jev-test","answers":answers}))
                .expect("fixture response"))
        }
    });
    let config = crate::Config::for_tests(&[
        ("SWITCHBOARD_PI_BINARY", &utility.to_string_lossy()),
        ("SWITCHBOARD_FLOOR_QUIET_THRESHOLD_MS", "1"),
    ]);
    let project = |id: &str, description: &str| Project {
        id: id.into(),
        description: description.into(),
        aliases: vec![],
        host: Some("test-host".into()),
        cwd: format!("/srv/{id}"),
        model: Some("anthropic/current".into()),
        prepare: String::new(),
    };
    let registry = Registry::new(vec![
        project("grapes", "ablation runs"),
        project("switchboard", "the voice front door"),
    ]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog {
            entries: vec![crate::models::CatalogEntry {
                provider: "anthropic".into(),
                model: "current".into(),
                thinks: true,
            }],
            available: true,
            diagnostic: None,
        },
    );
    let board = Switchboard::new_with_jev(&config, registry, std::sync::Arc::new(prewarm), jev);
    let state = AppState::new(
        board,
        TranscriptLog::new(10),
        Speaker::test_success(100, Duration::from_millis(25_000)),
        SttAdapter::from_command(None),
        SttStreamAdapter::from_command(None),
    );
    let _host_log = FakeHostAgent::new(Box::new(|session, _message| {
        if session == "s2" {
            vec![
                Step::Call(
                    "request_to_speak",
                    json!({"message":"the latest ablation numbers are ready", "reason":"finished"}),
                ),
                Step::Call(
                    "request_to_speak",
                    json!({"message":"the latest ablation numbers are ready again", "reason":"finished"}),
                ),
                Step::Event(json!({"kind":"text","text":"background finished"})),
            ]
        } else {
            vec![
                Step::Call("speak", json!({"text":"Foreground answer"})),
                Step::Event(json!({"kind":"text","text":"foreground answered"})),
            ]
        }
    }))
    .serve(state.0.hosts.connect_fake("test-host"));
    let (mut connection, _, _) = state.register_connection().await;
    spawn_workers(state.clone());
    let foreground_reply = state
        .0
        .switchboard
        .lock()
        .await
        .transfer_ctx(
            &crate::pbx::TransferContext {
                exact_caller_transcript: "start on switchboard".into(),
                ..Default::default()
            },
            "switchboard",
            "",
            "",
        )
        .await;
    assert_eq!(foreground_reply.route, "switchboard");
    let initial_frames = frames_until(&mut connection, "spoken").await;
    assert_serial_audio(&initial_frames);
    assert_eq!(
        initial_frames
            .iter()
            .find(|frame| frame["type"] == "spoken")
            .expect("foreground speech")["entry"]["text"],
        "Foreground answer"
    );
    assert_lifecycle_consistent(&state).await;

    let generation = state.0.coordinator.generation();
    route_final_transcript(
        &state,
        "multi-target",
        generation,
        "can you tell me the numbers of the latest ablation run from the grapes and then also tell me what the latest commit from the switchboard project is?".into(),
    )
    .await;
    assert_lifecycle_consistent(&state).await;

    let foreground_frames = frames_until(&mut connection, "spoken").await;
    assert_serial_audio(&foreground_frames);
    assert_eq!(
        foreground_frames
            .iter()
            .find(|frame| frame["type"] == "spoken")
            .expect("foreground answer")["entry"]["text"],
        "Foreground answer"
    );
    // Do not let Jev release the floor until the foreground audio has settled.
    foreground_release.notify_one();
    assert_lifecycle_consistent(&state).await;

    let first_background = frames_until(&mut connection, "spoken").await;
    assert_serial_audio(&first_background);
    assert_eq!(
        first_background
            .iter()
            .find(|frame| frame["type"] == "spoken")
            .expect("rewritten background speech")["entry"]["text"],
        "the ablation numbers are ready"
    );
    assert_lifecycle_consistent(&state).await;
    let second_background = frames_until(&mut connection, "spoken").await;
    assert_serial_audio(&second_background);
    assert_eq!(
        second_background
            .iter()
            .find(|frame| frame["type"] == "spoken")
            .expect("original background speech")["entry"]["text"],
        "the latest ablation numbers are ready again"
    );
    assert_lifecycle_consistent(&state).await;
    assert!(state
        .0
        .projection
        .snapshot()
        .iter()
        .find(|agent| agent.project == "grapes")
        .is_some_and(|agent| agent.pending_request.is_none()));
    let _ = state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn floor_rewrite_does_not_hold_the_pbx_lock_across_utility_wait() {
    let root = std::env::temp_dir().join(format!(
        "switchboard-floor-lock-{}-{}",
        std::process::id(),
        crate::pbx::uuid_like()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let utility = root.join("fake-utility");
    let script = r##"while IFS= read -r line; do
case "$line" in
  *"FLOOR REWRITE"*) read -r ignored ;;
  *) printf '%s\n' '{{"type":"agent_settled"}}' ;;
esac
done
"##;
    crate::pi_client::write_executable_script(&utility, script);
    let jev = crate::jev::JevClient::new(
        "http://unused.invalid/v1/systemone",
        "/nonexistent/typesafe-api-key",
        Duration::from_secs(1),
    )
    .expect("client")
    .with_test_responder(|request| async move {
        let answers = if request.questions.contains_key("good_moment") {
            serde_json::json!({
                "good_moment": {"type":"choice","choice":"yes","probabilities":{"yes":1.0},"confidence":1.0}
            })
        } else {
            serde_json::json!({
                "action": {"type":"choice","choice":"general","probabilities":{"general":1.0},"confidence":1.0},
                "for_current_agent": {"type":"noul","noul":0.0},
                "target": {"type":"choice","choice":"none","probabilities":{"none":1.0},"confidence":1.0},
                "continue_or_fresh": {"type":"choice","choice":"not_applicable","probabilities":{"not_applicable":1.0},"confidence":1.0},
                "multi_target": {"type":"noul","noul":0.0}
            })
        };
        Ok(serde_json::from_value(serde_json::json!({"model":"jev-test","answers":answers}))
            .expect("fixture response"))
    });
    let config = crate::Config::for_tests(&[
        ("SWITCHBOARD_PI_BINARY", &utility.to_string_lossy()),
        ("SWITCHBOARD_FLOOR_QUIET_THRESHOLD_MS", "1"),
    ]);
    let registry = Registry::new(vec![]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("test catalog"),
    );
    let state = state_on(Switchboard::new_with_jev(
        &config,
        registry,
        std::sync::Arc::new(prewarm),
        jev,
    ));
    let (_connection, _, _) = state.register_connection().await;
    state
        .0
        .coordinator
        .register_background("grapes", "grapes-token");
    state
        .0
        .projection
        .hold_display("grapes".into(), json!({"op":"show","id":"doc"}));
    let rewrite_started = std::sync::Arc::new(tokio::sync::Notify::new());
    let rewrite_notice = rewrite_started.clone();
    let rewrite_prompt = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let rewrite_prompt_seen = rewrite_prompt.clone();
    crate::pi_client::set_prompt_hook_for_test(Some(std::sync::Arc::new(move |message| {
        if message.contains("[FLOOR REWRITE]") {
            *rewrite_prompt_seen.lock().unwrap() = message.to_owned();
            rewrite_notice.notify_one();
        }
    })));
    spawn_workers(state.clone());
    state.0.floor.force_quiet_for_test().await;
    let accepted = request_to_speak(
        state.clone(),
        "grapes-token",
        json!({"message":"the update is ready", "reason":"finished"}),
    )
    .await;
    assert_eq!(accepted.status(), StatusCode::OK);
    timeout(Duration::from_secs(1), rewrite_started.notified())
        .await
        .expect("rewrite reached the utility");
    let prompt = rewrite_prompt.lock().unwrap().clone();
    assert!(prompt.contains("Display held: yes"), "{prompt}");
    // The rules for a held display live in the utility's system prompt; the
    // request carries only the data.
    assert!(!prompt.contains("on screen"), "{prompt}");
    crate::pi_client::set_prompt_hook_for_test(None);

    // The foreground turn path can acquire the PBX lock while the utility is
    // still waiting. This is the caller-audible-delay regression guard.
    let mut board = timeout(Duration::from_millis(100), state.0.switchboard.lock())
        .await
        .expect("rewrite must not hold the PBX lock");
    let summary = board.call_summary(&[], json!({}), "caller turn");
    assert_eq!(summary.caller_just_said, "caller turn");
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn stale_floor_request_is_dropped_before_audio_reservation() {
    let state = state();
    let (_connection, _, _) = state.register_connection().await;
    state
        .0
        .coordinator
        .register_background("grapes", "grapes-token");
    let generation = state.0.coordinator.generation();
    state.0.coordinator.begin_rescue("new foreground leg");
    let outcome = release_floor(
        &state,
        FloorRequest {
            project: "grapes".into(),
            token: "grapes-token".into(),
            generation,
            context: "caller: previous line".into(),
            message: "stale update".into(),
            reason: "finished".into(),
            held_display: false,
        },
        "stale update".into(),
        false,
    )
    .await;
    assert_eq!(outcome, ReleaseOutcome::Drop);
}

#[tokio::test]
async fn background_speak_is_refused_and_latest_display_is_released_on_promotion() {
    let state = state();
    let (mut connection, _, _) = state.register_connection().await;
    state
        .0
        .coordinator
        .register_background("alpha", "background-token");
    assert_lifecycle_consistent(&state).await;
    let (code, spoken) = agent_call_json(
        &state,
        "/speak",
        json!({"token":"background-token", "text":"not now"}),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(spoken["delivered"], false);
    assert_eq!(spoken["reason"], "caller_away");

    let action = diagram_show();
    let (code, held) = agent_call_json(
        &state,
        "/display",
        json!({"token":"background-token", "action":action["action"].clone()}),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(held["accepted"], true);
    assert_eq!(held["held"], true);
    assert_eq!(held["reason"], "caller_away");
    assert!(held["detail"]
        .as_str()
        .unwrap()
        .contains("not on screen yet"));
    assert!(state
        .0
        .projection
        .displays
        .lock()
        .unwrap()
        .contains_key("alpha"));

    begin_alpha_candidate(&state, "foreground-token");
    assert!(
        state
            .0
            .leg_announcer
            .promote_candidate("foreground-token")
            .await
    );
    assert_lifecycle_consistent(&state).await;
    let frames = queued_frames(&mut connection);
    assert!(frames
        .iter()
        .any(|frame| frame["type"] == "display" && frame["action"]["id"] == "d1"));
    assert!(!state
        .0
        .projection
        .displays
        .lock()
        .unwrap()
        .contains_key("alpha"));
}

#[tokio::test]
async fn stopping_a_background_agent_discards_its_held_display() {
    let state = state();
    state
        .0
        .coordinator
        .register_background("alpha", "background-token");
    assert_lifecycle_consistent(&state).await;
    let held = module_call(
        &state,
        AgentCall {
            call: "display".into(),
            token: "background-token".into(),
            turn_id: None,
            cause: None,
            args: diagram_show(),
        },
    )
    .await;
    assert_eq!(held["status"], "accepted");
    assert!(state
        .0
        .projection
        .displays
        .lock()
        .unwrap()
        .contains_key("alpha"));

    update_agent_state(
        &state,
        AgentStateNotice {
            project: "alpha".into(),
            state: "finished".into(),
        },
    )
    .await;
    assert!(!state
        .0
        .projection
        .displays
        .lock()
        .unwrap()
        .contains_key("alpha"));
    assert_lifecycle_consistent(&state).await;
}

#[tokio::test]
async fn failed_promotion_finished_notice_clears_the_held_display_projection() {
    let state = state();
    state
        .0
        .coordinator
        .register_background("alpha", "background-token");
    assert_lifecycle_consistent(&state).await;
    let held = module_call(
        &state,
        AgentCall {
            call: "display".into(),
            token: "background-token".into(),
            turn_id: None,
            cause: None,
            args: diagram_show(),
        },
    )
    .await;
    assert_eq!(held["status"], "accepted");

    // This is the projection side of a failed promotion: PBX's terminal
    // `finished` owner notice must release the resident's held scene.
    update_agent_state(
        &state,
        AgentStateNotice {
            project: "alpha".into(),
            state: "finished".into(),
        },
    )
    .await;
    assert!(state
        .0
        .projection
        .displays
        .lock()
        .unwrap()
        .get("alpha")
        .is_none());
    assert_lifecycle_consistent(&state).await;
}

#[tokio::test]
async fn background_request_and_display_owner_rejects_after_promotion_removes_token() {
    let state = state();
    state
        .0
        .coordinator
        .register_background("alpha", "background-token");
    let agents = state
        .0
        .coordinator
        .with_background("background-token", |project| {
            state.0.projection.waiting(
                project.to_owned(),
                AgentRequest {
                    message: "ready".into(),
                    reason: "finished".into(),
                },
            )
        });
    assert!(agents.is_some());
    state.0.coordinator.remove_background("background-token");
    assert!(state
        .0
        .coordinator
        .with_background("background-token", |_| ())
        .is_none());
    assert_lifecycle_consistent(&state).await;
}

#[tokio::test]
async fn an_idle_notice_does_not_clear_a_background_speak_request() {
    let state = state();
    state
        .0
        .coordinator
        .register_background("alpha", "background-token");
    let response = request_to_speak(
        state.clone(),
        "background-token",
        json!({"message":"I finished", "reason":"finished"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_lifecycle_consistent(&state).await;

    update_agent_state(
        &state,
        AgentStateNotice {
            project: "alpha".into(),
            state: "idle".into(),
        },
    )
    .await;
    assert_lifecycle_consistent(&state).await;

    let agents = state.0.projection.states.lock().unwrap();
    let agent = agents
        .iter()
        .find(|agent| agent.project == "alpha")
        .unwrap();
    assert_eq!(agent.state, "waiting");
    assert_eq!(
        agent.pending_request.as_ref().unwrap().message,
        "I finished"
    );
}

#[cfg(unix)]
async fn foreground_alpha_turn(state: &AppState) -> (String, u64) {
    let mut board = state.0.switchboard.lock().await;
    let reply = board
        .transfer_ctx(
            &crate::pbx::TransferContext {
                exact_caller_transcript: "put me through to alpha".into(),
                ..Default::default()
            },
            "alpha",
            "",
            "",
        )
        .await;
    assert_eq!(reply.route, "alpha");
    drop(board);
    let token = state.0.coordinator.current_identity().token;
    let instance = state
        .0
        .active_session
        .lock()
        .await
        .as_ref()
        .expect("foreground project session")
        .instance_id();
    (token, instance)
}

#[cfg(unix)]
fn autonomous_turn(token: String, instance_id: u64, turn_id: Option<&str>) -> ProjectTurn {
    ProjectTurn {
        instance_id,
        token,
        turn_id: turn_id.map(str::to_owned),
        cause: "autonomous".into(),
        ended: false,
        text: String::new(),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn caller_turn_waits_behind_an_autonomous_project_turn() {
    let root = scratch_root("autonomous-waits");
    let state = state_with_agents(&root);
    let (token, instance_id) = foreground_alpha_turn(&state).await;
    handle_project_turn(
        &state,
        autonomous_turn(token.clone(), instance_id, Some("auto-1")),
    )
    .await;
    let mut events = state.0.events.subscribe();
    while events.try_recv().is_ok() {}
    let generation = state.0.coordinator.generation();
    state.0.routed_decisions.lock().await.insert(
        "caller-waits".into(),
        crate::router::Decision {
            action: crate::router::Action::Continue,
            target: Some("alpha".into()),
            continue_or_fresh: Some(crate::router::ConversationMode::Continue),
            confidence: 1.0,
            for_current_agent: 1.0,
            multi_target: false,
            unsure: false,
            confirm: false,
            reason: "test".into(),
        }
        .into(),
    );
    state.0.queued_turns.store(1, Ordering::Release);
    let worker = tokio::spawn(process_turns(state.clone()));
    state
        .0
        .turns
        .send(("caller-waits".into(), "continue alpha".into(), generation))
        .await
        .unwrap();
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert!(!state.0.turn_in_flight.load(Ordering::Acquire));
    assert!(state
        .0
        .autonomous_operations
        .lock()
        .await
        .contains_key(&instance_id));
    assert!(
        events.try_recv().is_err(),
        "caller turn started before autonomous end"
    );

    handle_project_turn(
        &state,
        ProjectTurn {
            instance_id,
            token,
            turn_id: Some("auto-1".into()),
            cause: "autonomous".into(),
            ended: true,
            text: String::new(),
        },
    )
    .await;
    assert!(next_event_of(&mut events, "thinking").await["type"] == "thinking");
    worker.abort();
    let _ = worker.await;
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn autonomous_turn_loses_to_caller_operation_and_its_side_effects_are_refused() {
    let root = scratch_root("autonomous-loses");
    let state = state_with_agents(&root);
    let (token, instance_id) = foreground_alpha_turn(&state).await;
    let operation = state
        .0
        .coordinator
        .begin_prompt(&state.0.coordinator.current_identity())
        .unwrap();
    handle_project_turn(
        &state,
        autonomous_turn(token.clone(), instance_id, Some("auto-loses")),
    )
    .await;
    let speak = module_call(
        &state,
        AgentCall {
            call: "speak".into(),
            token: token.clone(),
            turn_id: Some("auto-loses".into()),
            cause: Some("autonomous".into()),
            args: json!({"text":"must not speak"}),
        },
    )
    .await;
    assert_eq!(speak["status"], "refused");
    assert!(speak["reason"]
        .as_str()
        .unwrap()
        .contains("no switchboard turn"));
    let display = module_call(
        &state,
        AgentCall {
            call: "display".into(),
            token: token.clone(),
            turn_id: Some("auto-loses".into()),
            cause: Some("autonomous".into()),
            args: diagram_show(),
        },
    )
    .await;
    assert_eq!(display["status"], "refused");
    assert!(display["reason"]
        .as_str()
        .unwrap()
        .contains("no switchboard turn"));
    assert!(state
        .0
        .coordinator
        .accept_side_effect(&token, None, None)
        .is_ok());
    assert!(state.0.coordinator.finish_operation(&operation));
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn delayed_old_autonomous_call_is_refused_after_a_new_caller_operation() {
    let root = scratch_root("autonomous-stale-call");
    let state = state_with_agents(&root);
    let (token, instance_id) = foreground_alpha_turn(&state).await;
    handle_project_turn(
        &state,
        autonomous_turn(token.clone(), instance_id, Some("auto-old")),
    )
    .await;
    handle_project_turn(
        &state,
        ProjectTurn {
            instance_id,
            token: token.clone(),
            turn_id: Some("auto-old".into()),
            cause: "autonomous".into(),
            ended: true,
            text: String::new(),
        },
    )
    .await;
    let operation = state
        .0
        .coordinator
        .begin_prompt(&state.0.coordinator.current_identity())
        .unwrap();
    let stale = module_call(
        &state,
        AgentCall {
            call: "speak".into(),
            token,
            turn_id: Some("auto-old".into()),
            cause: Some("autonomous".into()),
            args: json!({"text":"late"}),
        },
    )
    .await;
    assert_eq!(stale["status"], "refused");
    assert!(stale["reason"]
        .as_str()
        .unwrap()
        .contains("no switchboard turn"));
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
    assert!(state.0.coordinator.finish_operation(&operation));
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn old_host_self_wake_is_refused_but_legacy_caller_calls_still_work() {
    let root = scratch_root("autonomous-legacy-host");
    let state = state_with_agents(&root);
    let (token, instance_id) = foreground_alpha_turn(&state).await;
    handle_project_turn(&state, autonomous_turn(token.clone(), instance_id, None)).await;
    let operation = state
        .0
        .coordinator
        .begin_prompt(&state.0.coordinator.current_identity())
        .unwrap();
    let stale = module_call(
        &state,
        AgentCall {
            call: "speak".into(),
            token: token.clone(),
            turn_id: None,
            cause: Some("autonomous".into()),
            args: json!({"text":"legacy self wake"}),
        },
    )
    .await;
    assert_eq!(stale["status"], "refused");
    assert!(stale["reason"]
        .as_str()
        .unwrap()
        .contains("no switchboard turn"));
    let legacy_display = module_call(
        &state,
        AgentCall {
            call: "display".into(),
            token,
            turn_id: None,
            cause: None,
            args: diagram_show(),
        },
    )
    .await;
    assert_eq!(legacy_display["status"], "accepted");
    assert!(state.0.coordinator.finish_operation(&operation));
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn process_turns_settlement_preserves_a_waiting_request() {
    let root = scratch_root("process-turn-waiting");
    let state = state_with_agents(&root);
    {
        let mut board = state.0.switchboard.lock().await;
        let reply = board
            .transfer_ctx(
                &crate::pbx::TransferContext {
                    exact_caller_transcript: "put me through to alpha".into(),
                    ..Default::default()
                },
                "alpha",
                "",
                "",
            )
            .await;
        assert_eq!(reply.route, "alpha");
    }
    assert_lifecycle_consistent(&state).await;
    state
        .0
        .coordinator
        .register_background("alpha", "waiting-token");
    let request = request_to_speak(
        state.clone(),
        "waiting-token",
        json!({"message":"alpha is ready", "reason":"finished"}),
    )
    .await;
    assert_eq!(request.status(), StatusCode::OK);

    let mut events = state.0.events.subscribe();
    let id = "settled-waiting";
    let generation = state.0.coordinator.generation();
    state.0.routed_decisions.lock().await.insert(
        id.into(),
        crate::router::Decision {
            action: crate::router::Action::Continue,
            target: Some("alpha".into()),
            continue_or_fresh: Some(crate::router::ConversationMode::Continue),
            confidence: 1.0,
            for_current_agent: 1.0,
            multi_target: false,
            unsure: false,
            confirm: false,
            reason: "test".into(),
        }
        .into(),
    );
    state.0.queued_turns.store(1, Ordering::Release);
    let worker = tokio::spawn(process_turns(state.clone()));
    state
        .0
        .turns
        .send((id.into(), "continue alpha".into(), generation))
        .await
        .unwrap();

    // The continuing foreground turn announces busy before it settles. Read
    // through that transition to the owner-published waiting state.
    loop {
        let event = next_event_of(&mut events, "agents_state").await;
        if event["agents"]
            .as_array()
            .is_some_and(|agents| agents.iter().any(|agent| agent["state"] == "waiting"))
        {
            break;
        }
    }
    let agent = state
        .0
        .projection
        .states
        .lock()
        .unwrap()
        .iter()
        .find(|agent| agent.project == "alpha")
        .cloned()
        .expect("waiting agent state");
    assert_eq!(agent.state, "waiting");
    assert_eq!(
        agent
            .pending_request
            .as_ref()
            .map(|request| request.message.as_str()),
        Some("alpha is ready")
    );

    worker.abort();
    let _ = worker.await;
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn process_turns_settles_foreground_idle_once() {
    let root = scratch_root("process-turn-idle-once");
    let gate = TestTtsGate::new();
    let state = state_with_agents_spoken_speaker(
        &root,
        Speaker::test_gated(100, Duration::from_millis(25_000), gate.clone()),
    );
    {
        let mut board = state.0.switchboard.lock().await;
        let reply = board
            .transfer_ctx(
                &crate::pbx::TransferContext {
                    exact_caller_transcript: "put me through to alpha".into(),
                    ..Default::default()
                },
                "alpha",
                "",
                "",
            )
            .await;
        assert_eq!(reply.route, "alpha");
    }
    let (_connection, _, _) = state.register_connection().await;
    let mut events = state.0.events.subscribe();
    while events.try_recv().is_ok() {}
    let id = "settled-idle-once";
    let generation = state.0.coordinator.generation();
    state.0.routed_decisions.lock().await.insert(
        id.into(),
        crate::router::Decision {
            action: crate::router::Action::Continue,
            target: Some("alpha".into()),
            continue_or_fresh: Some(crate::router::ConversationMode::Continue),
            confidence: 1.0,
            for_current_agent: 1.0,
            multi_target: false,
            unsure: false,
            confirm: false,
            reason: "test".into(),
        }
        .into(),
    );
    state.0.queued_turns.store(1, Ordering::Release);
    let worker = tokio::spawn(process_turns(state.clone()));
    state
        .0
        .turns
        .send((id.into(), "continue alpha".into(), generation))
        .await
        .unwrap();
    timeout(Duration::from_secs(1), gate.wait_started())
        .await
        .expect("speech worker reached the gated drain");
    gate.release();
    let busy = next_event_of(&mut events, "agents_state").await;
    assert!(busy["agents"].as_array().is_some_and(|agents| {
        agents
            .iter()
            .any(|agent| agent["project"] == "alpha" && agent["state"] == "busy")
    }));
    timeout(Duration::from_secs(1), async {
        while state.0.turn_in_flight.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("foreground turn settled");

    let idle_events: Vec<Value> = std::iter::from_fn(|| events.try_recv().ok())
        .filter_map(|event| match event {
            Event::Json(value)
                if value["type"] == "agents_state"
                    && value["agents"].as_array().is_some_and(|agents| {
                        agents
                            .iter()
                            .any(|agent| agent["project"] == "alpha" && agent["state"] == "idle")
                    }) =>
            {
                Some(value)
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        idle_events.len(),
        1,
        "idle must settle through one owner: {idle_events:#?}"
    );

    assert!(state.0.active_speech_group().is_none());
    assert_eq!(
        *state
            .0
            .foreground_audio_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        Some(generation)
    );
    let next_generation = generation + 1;
    let mut scene_gate = state.0.display_gate.lock().await;
    state
        .0
        .leg_announcer
        .begin_scene(
            &mut scene_gate,
            crate::display::SceneLeg {
                route: "next-project".into(),
                generation: next_generation,
            },
        )
        .await;
    drop(scene_gate);
    assert!(state
        .0
        .foreground_audio_generation
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_none());

    worker.abort();
    let _ = worker.await;
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn agents_state_publishes_idle_after_turn_and_finished_after_hangup() {
    let root = scratch_root("agents-state-lifecycle");
    let state = state_with_agents(&root);
    let mut events = state.0.events.subscribe();
    let context = crate::pbx::TransferContext {
        exact_caller_transcript: "put me through to alpha".into(),
        ..Default::default()
    };
    let reply = state
        .0
        .switchboard
        .lock()
        .await
        .transfer_ctx(&context, "alpha", "", "")
        .await;
    assert_eq!(reply.route, "alpha");
    assert_lifecycle_consistent(&state).await;
    let agents = state.0.projection.states.lock().unwrap().clone();
    assert_eq!(
        agents
            .iter()
            .find(|agent| agent.project == "alpha")
            .map(|agent| agent.state.as_str()),
        Some("idle")
    );
    let lifecycle_events: Vec<Value> = std::iter::from_fn(|| events.try_recv().ok())
        .filter_map(|event| match event {
            Event::Json(value) if value["type"] == "agents_state" => Some(value),
            _ => None,
        })
        .collect();
    assert!(lifecycle_events
        .iter()
        .any(|event| event["agents"][0]["state"] == "busy"));
    assert!(lifecycle_events
        .iter()
        .any(|event| event["agents"][0]["state"] == "idle"));

    state.0.switchboard.lock().await.force_hangup().await;
    assert_lifecycle_consistent(&state).await;
    assert_eq!(
        state.0.projection.states.lock().unwrap()[0].state,
        "finished"
    );
    assert!(std::iter::from_fn(|| events.try_recv().ok()).any(|event| {
        matches!(event, Event::Json(value) if value["type"] == "agents_state" && value["agents"][0]["state"] == "finished")
    }));
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn floor_rewrite_context_names_who_spoke() {
    let entries = vec![
        crate::history::TranscriptEntry {
            role: crate::history::CALLER.into(),
            text: "show me the chart".into(),
            route: "switchboard".into(),
            ts: 1.0,
            id: None,
            voiced: false,
        },
        crate::history::TranscriptEntry {
            role: crate::history::AGENT.into(),
            text: "Here is the diagram.".into(),
            route: "switchboard".into(),
            ts: 2.0,
            id: None,
            voiced: true,
        },
        crate::history::TranscriptEntry {
            role: crate::history::AGENT.into(),
            text: "The chart is ready.".into(),
            route: "grape".into(),
            ts: 3.0,
            id: None,
            voiced: true,
        },
    ];
    assert_eq!(
        recent_floor_context(&entries),
        "caller: show me the chart\nswitchboard: Here is the diagram.\ngrape: The chart is ready."
    );
}

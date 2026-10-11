use super::*;
use crate::api::request_json;
use crate::app_state::AppState;
use crate::app_state::{
    assert_lifecycle_consistent, begin_alpha_candidate, hold_turn_lock, state, update_agent_state,
};
use crate::browser::{handle_text_frame, queued_frames};
use crate::delivery::{DeliveryFrame, Event};
use crate::pbx::{AgentStateNotice, OPERATOR};
use crate::project_session::AgentCall;
use crate::protocol::AgentRequest;
use crate::speech::AUDIO_SLOTS;
use crate::within;
use axum::http::{Method, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::sync::oneshot;
use tokio::time::{timeout, Duration};

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
            "generation": state.0.coordinator.generation(),
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
    let DeliveryFrame::Event { sequence, .. } =
        within("connection.receiver", connection.receiver.recv())
            .await
            .unwrap()
    else {
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
               "visual_kind":"diagram","applied_seq":sequence,
               "generation":state.0.coordinator.generation()})
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

// A refused reason or view target is worded as the display validators word
// a refused name, and as the skill module raises it before sending: the
// field and every name it takes, in the skill's order.
#[tokio::test]
async fn a_refused_reason_or_target_lists_the_names_it_takes() {
    let state = state();
    for args in [
        json!({"message": "Done"}),
        json!({"message": "Done", "reason": "later"}),
        json!({"message": "Done", "reason": null}),
    ] {
        let response = request_to_speak(state.clone(), "background-token", args).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(
            body,
            json!({"detail": "invalid reason: expected one of finished, needs_decision, problem"})
        );
    }
    let (code, body) = agent_call_json(&state, "/view", json!({"target": "screen"})).await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        json!({"delivered": false, "detail": "invalid target: expected one of visual, comms, system, theater, auto"})
    );
}

// A background agent's request is shown on the debug page as it is on the
// caller's: the projection's every change goes to both.
#[tokio::test]
async fn a_request_to_speak_reaches_the_debug_bus() {
    let state = state();
    state
        .0
        .coordinator
        .register_background("alpha", "alpha-token");
    let response = request_to_speak(
        state.clone(),
        "alpha-token",
        json!({"message": "the update is ready", "reason": "finished"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    crate::app_state::until_debug(&state, |event| {
        matches!(
            event,
            crate::debug::DebugEvent::AgentsState { agents }
                if agents.iter().any(|agent| agent.project == "alpha" && agent.state == "waiting")
        )
    })
    .await;
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

#[tokio::test]
async fn agent_callbacks_do_not_wait_for_the_turn_lock() {
    let state = state();
    let _events = state.0.events.subscribe();
    let (locked_tx, locked_rx) = oneshot::channel();
    let turn_state = state.clone();
    let turn = tokio::spawn(async move {
        hold_turn_lock(&turn_state, Some(locked_tx)).await;
    });
    within("locked_rx", locked_rx).await.unwrap();

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
async fn speak_reports_failure_and_does_not_log_transcript_when_delivery_fails() {
    let state = state();
    let (code, spoken) = agent_call_json(&state, "/speak", json!({"text":"Hello world."})).await;
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(spoken["delivered"], false);
    assert_eq!(spoken["reason"], "no browser connected");
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
}

// The skill prints these refusals to the agent word for word, so each
// module call's refusal is pinned whole: the status, the code and the detail.
#[tokio::test]
async fn a_module_call_from_a_leg_off_the_call_is_refused_with_its_exact_words() {
    let state = state();
    state.0.coordinator.begin_rescue("operator rescue");
    let view = json!({"target":"theater"});
    for (call, args) in [
        ("speak", json!({"text":"Hello."})),
        ("display", diagram_show()),
        ("view", view),
    ] {
        assert_eq!(
            module_call_json(&state, call, "operator", None, args.clone()).await,
            invalid_leg(LEG_GONE),
            "{call} from a retired leg"
        );
        for cause in ["autonomous", "unknown"] {
            assert_eq!(
                module_call_json(&state, call, "operator", Some(cause), args.clone()).await,
                invalid_leg(SELF_WOKEN),
                "{call} self-woken ({cause}) with no turn"
            );
        }
        assert_eq!(
            module_call_json(&state, call, "operator", Some("caller"), args).await,
            invalid_leg(LEG_GONE),
            "{call} from a retired leg in a caller's turn"
        );
    }
}

#[tokio::test]
async fn a_module_call_while_a_transfer_is_starting_is_refused_with_its_exact_words() {
    let state = state();
    begin_alpha_candidate(&state, "alpha-token");
    for (call, args, detail) in [
        (
            "speak",
            json!({"text":"Hello."}),
            "the line is not live until this transfer completes: do not retry from this turn; the caller can see your written reply on screen",
        ),
        (
            "display",
            diagram_show(),
            "the caller's screen is not live until this transfer completes: draw it again on your next turn",
        ),
        (
            "view",
            json!({"target":"theater"}),
            "the caller's screen is not live until this transfer completes: switch view again on your next turn",
        ),
    ] {
        assert_eq!(
            module_call_json(&state, call, "operator", None, args).await,
            invalid_leg(detail),
            "{call} while alpha is starting"
        );
    }
}

// An agent's speak does not wait for room in the speech worker's queue: a
// full queue is answered at once as busy.
#[tokio::test]
async fn speak_is_refused_as_busy_when_the_speech_queue_is_full() {
    // Every place in the queue is reserved and never sent, so the worker
    // has nothing to drain and every place stays taken.
    let state = state();
    let (_connection, _snapshot, _watermark) = state.register_connection().await;
    let _taken: Vec<_> = std::iter::from_fn(|| state.0.speech.try_reserve().ok()).collect();
    let answer = timeout(
        Duration::from_secs(1),
        module_call_json(&state, "speak", "operator", None, json!({"text":"Hello."})),
    )
    .await
    .expect("a full speech queue is answered, not waited on");
    assert_eq!(
        answer,
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"delivered":false, "reason":"speech worker is unavailable or busy", "detail":"speech worker is unavailable or busy"})
        )
    );
}

// A speak that finds no audio slot is answered as undelivered, the way it
// was before the speech worker existed: there is no browser to play it to.
#[tokio::test]
async fn speak_with_no_audio_slot_is_answered_as_undelivered() {
    let state = state();
    let (_connection, _snapshot, _watermark) = state.register_connection().await;
    let generation = state.0.coordinator.generation();
    {
        let mut audio = state.0.audio.lock().await;
        while audio.slots.len() < AUDIO_SLOTS {
            audio.reserve(generation);
        }
    }
    assert_eq!(
        module_call_json(&state, "speak", "operator", None, json!({"text":"Hello."})).await,
        (
            StatusCode::OK,
            json!({"delivered":false, "reason":"no browser connected", "detail":"no browser connected"})
        )
    );
}

#[tokio::test]
async fn speak_that_fails_to_synthesize_is_answered_with_the_workers_reason() {
    // Every synthesis fails in-process (`Speaker::offline`).
    let state = state();
    let (_connection, _snapshot, _watermark) = state.register_connection().await;
    let (code, body) =
        module_call_json(&state, "speak", "operator", None, json!({"text":"Hello."})).await;
    assert_eq!(code, StatusCode::BAD_GATEWAY);
    assert_eq!(body["delivered"], false);
    assert!(body["detail"]
        .as_str()
        .is_some_and(|detail| !detail.is_empty()));
    assert_eq!(body["reason"], body["detail"]);
}

#[tokio::test]
async fn display_protocol_validation_and_composition() {
    let state = state();
    let mut events = state.0.events.subscribe();

    // What `validate_action` makes of each action is the shared corpus's to
    // pin (`agrees_with_the_shared_validator_corpus`). A composed scene
    // arrives through display calls and is replayed.
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
    let Event::Json(event) = within("events", events.recv()).await.unwrap() else {
        panic!("expected event")
    };
    assert_eq!(event["type"], "display");
    assert_eq!(event["action"]["id"], "main");
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
        assert!(matches!(
            within("events", events.recv()).await.unwrap(),
            Event::Json(_)
        ));
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
    assert!(matches!(
        within("events", events.recv()).await.unwrap(),
        Event::Json(_)
    ));
}

// A refused action comes back to the agent with the validator's error,
// word for word (docs/display-tool.md): every action the shared corpus says
// both validators refuse is refused by a display call with its exact error.
#[tokio::test]
async fn display_protocol_rejects_invalid_actions() {
    let state = state();
    let mut failures = Vec::new();
    for case in crate::visual_protocol::validator_corpus() {
        let Some(error) = case["error"].as_str() else {
            continue;
        };
        let name = case["name"].as_str().unwrap();
        let (code, body) = agent_call_json(
            &state,
            "/display",
            json!({"token": "operator", "action": case["action"].clone()}),
        )
        .await;
        let wanted = json!({"delivered": false, "detail": error});
        if code != StatusCode::BAD_REQUEST || body != wanted {
            failures.push(format!("{name}: {code} {body}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));

    let oversized =
        json!({"token": "operator", "action": {"op": "say", "text": "x".repeat(50_001)}});
    assert_eq!(
        agent_call_json(&state, "/display", oversized).await.0,
        StatusCode::BAD_REQUEST
    );
}

// The stage is bounded (`MAX_STAGE_OBJECTS`, `MAX_STAGE_IMAGES`): a show
// that would add past either bound is refused in words the agent can act
// on, and nothing reaches the screen; an update in place and a hide are
// always taken, so the agent can make room.
#[tokio::test]
async fn display_refuses_a_show_past_the_stage_bound_and_takes_updates_and_hides() {
    use crate::display::{MAX_STAGE_IMAGES, MAX_STAGE_OBJECTS};
    let state = state();
    let call = |action: Value| {
        let state = state.clone();
        async move {
            agent_call_json(
                &state,
                "/display",
                json!({"token": "operator", "action": action}),
            )
            .await
        }
    };
    let metric = |id: &str| json!({"op": "show", "id": id, "type": "metric", "data": {"label": id, "value": "1"}});
    let image = |id: &str| json!({"op": "show", "id": id, "type": "image", "data": {"format": "png", "bytes": "iVBORw0KGgoAAAAA", "alt": id}});
    let on_stage = || {
        let state = state.clone();
        async move { state.0.display_gate.lock().await.projection().objects.len() }
    };

    for n in 0..MAX_STAGE_IMAGES {
        assert_eq!(call(image(&format!("img{n}"))).await.0, StatusCode::OK);
    }
    let images_full = json!({"delivered": false, "detail": format!("the stage holds {MAX_STAGE_IMAGES} images, the most it takes: hide one, or update one by its id")});
    assert_eq!(
        call(image("one-more")).await,
        (StatusCode::BAD_REQUEST, images_full.clone())
    );
    // An object that would become an image is one more image too.
    assert_eq!(call(metric("m0")).await.0, StatusCode::OK);
    assert_eq!(
        call(image("m0")).await,
        (StatusCode::BAD_REQUEST, images_full)
    );
    // An image updated in place is not one more.
    assert_eq!(call(image("img0")).await.0, StatusCode::OK);

    for n in on_stage().await..MAX_STAGE_OBJECTS {
        assert_eq!(call(metric(&format!("m{n}"))).await.0, StatusCode::OK);
    }
    assert_eq!(on_stage().await, MAX_STAGE_OBJECTS);
    let mut events = state.0.events.subscribe();
    let (code, body) = call(metric("one-too-many")).await;
    assert_eq!(
        (code, body),
        (
            StatusCode::BAD_REQUEST,
            json!({"delivered": false, "detail": format!("the stage holds {MAX_STAGE_OBJECTS} objects, the most it takes: hide one, or update one by its id")})
        )
    );
    assert!(
        events.try_recv().is_err(),
        "a refused show never reaches the screen"
    );
    assert_eq!(on_stage().await, MAX_STAGE_OBJECTS);

    // An update in place is taken on a full stage, and a hide makes room.
    assert_eq!(call(metric("m5")).await.0, StatusCode::OK);
    assert_eq!(
        call(json!({"op": "hide", "id": "img1"})).await.0,
        StatusCode::OK
    );
    assert_eq!(call(metric("one-too-many")).await.0, StatusCode::OK);
    assert_eq!(on_stage().await, MAX_STAGE_OBJECTS);
    // And the hidden image left room for an image.
    assert_eq!(
        call(json!({"op": "hide", "id": "m5"})).await.0,
        StatusCode::OK
    );
    assert_eq!(call(image("img-new")).await.0, StatusCode::OK);
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
    let _ = within("events", events.recv()).await.unwrap();

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
    let _ = within("events", events.recv()).await.unwrap();

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
    let _ = within("events", events.recv()).await.unwrap();

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
    let _ = within("events", events.recv()).await.unwrap();

    // Verify projection state under gate
    {
        let gate = state.0.display_gate.lock().await;
        assert_eq!(gate.projection().order, vec!["chart-1", "doc-1"]);
        assert_eq!(gate.projection().focus_id.as_deref(), Some("chart-1"));
        assert!(gate.projection().speech.is_some());
        assert_eq!(
            gate.projection().speech.as_ref().unwrap().target.as_deref(),
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
    let _ = within("events", events.recv()).await.unwrap();

    {
        let gate = state.0.display_gate.lock().await;
        assert_eq!(gate.projection().order, vec!["doc-1"]);
        assert!(!gate.projection().objects.contains_key("chart-1"));
        assert!(gate.projection().objects.contains_key("doc-1"));
        assert_eq!(
            gate.projection().focus_id,
            None,
            "hide must clear focus when focused object is hidden"
        );
        assert!(
            gate.projection().speech.is_none(),
            "hide must clear speech targeting the hidden object"
        );

        let snapshot = gate.projection().snapshot_actions();
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
        assert_eq!(gate.projection().order, vec!["doc-1"]);
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
        assert!(gate.projection().objects.is_empty());
        assert!(
            gate.projection().speech.is_some(),
            "non-targeted speech must be preserved when an object is hidden"
        );
        assert_eq!(
            gate.projection().speech.as_ref().unwrap().text,
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
    let rescued = state.0.coordinator.begin_rescue("operator rescue");
    assert_eq!(rescued.generation(), 1);
    assert_ne!(rescued.identity().token, "operator");

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
        assert!(!gate.projection().objects.contains_key("chart-stale"));
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
    state.0.coordinator.settle(rescued);
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
    let DeliveryFrame::Event { sequence, .. } =
        within("connection.receiver", connection.receiver.recv())
            .await
            .unwrap()
    else {
        panic!("expected a display event")
    };

    // Browser confirms it rendered up to `sequence`.
    handle_text_frame(
        &state,
        epoch,
        &mut None,
        &mut None,
        &json!({"type":"screen_state","view":"auto","has_visual":true,
               "visual_kind":"diagram","applied_seq":sequence,
               "generation":state.0.coordinator.generation()})
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
    let DeliveryFrame::Event { sequence, .. } =
        within("connection.receiver", connection.receiver.recv())
            .await
            .unwrap()
    else {
        panic!("expected a display event")
    };
    handle_text_frame(
        &state,
        epoch,
        &mut None,
        &mut None,
        &json!({"type":"screen_state","view":"auto","has_visual":false,
               "rejected":{"seq":sequence,"reason":"unsupported node shape"},
               "generation":state.0.coordinator.generation()})
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

/// The page sends a rejection once. A later report without one, here the
/// confirmation of the next action, must not hide it from the call still
/// waiting on the rejected `seq` (#255).
#[tokio::test]
async fn display_reports_a_rejection_that_a_later_report_followed() {
    let state = state();
    let (mut connection, _s, _w) = state.register_connection().await;
    let epoch = connection.epoch;
    let handle = post_display_in_task(&state, diagram_show()).await;
    let DeliveryFrame::Event { sequence, .. } =
        within("connection.receiver", connection.receiver.recv())
            .await
            .unwrap()
    else {
        panic!("expected a display event")
    };
    let generation = state.0.coordinator.generation();
    for report in [
        json!({"type":"screen_state","view":"auto","has_visual":false,"generation":generation,
               "rejected":{"seq":sequence,"reason":"unknown field in chart data: zeta"}}),
        json!({"type":"screen_state","view":"auto","has_visual":true,"generation":generation,
               "visual_kind":"metric","applied_seq":sequence + 1}),
    ] {
        handle_text_frame(&state, epoch, &mut None, &mut None, &report.to_string())
            .await
            .unwrap();
    }
    let (_code, body) = timeout(Duration::from_secs(2), handle)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(body["rejected"], true, "{body}");
    assert_eq!(body["rendered"], false, "{body}");
    assert_eq!(
        body["reason"], "unknown field in chart data: zeta",
        "{body}"
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
        .projection()
        .snapshot_actions()
        .is_empty());
}

#[tokio::test]
async fn background_view_reports_but_does_not_change_the_screen() {
    let state = state();
    let (mut connection, _, _) = state.register_connection().await;
    state
        .0
        .coordinator
        .register_background("alpha", "background-token");

    // The caller's screen is not a background agent's to steer; #135.
    let (code, refused) = agent_call_json(
        &state,
        "/view",
        json!({"token":"background-token", "target":"theater"}),
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(refused["delivered"], false);
    assert_eq!(refused["reason"], "caller_away");
    assert!(refused["detail"]
        .as_str()
        .unwrap()
        .contains("not yours to change"));
    assert!(
        connection.receiver.try_recv().is_err(),
        "no view message reached the page"
    );

    // Asking what the caller sees still works from the background.
    let (code, reported) =
        agent_call_json(&state, "/view", json!({"token":"background-token"})).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(reported["delivered"], true);
    assert!(reported["screen"].is_object());
}

#[tokio::test]
async fn a_background_refusal_reaches_the_module_as_its_bare_reason() {
    // The module and SKILL.md branch on `caller_away`; the sentence that
    // explains it stays in the result (#234).
    let state = state();
    let (_connection, _, _) = state.register_connection().await;
    state
        .0
        .coordinator
        .register_background("alpha", "background-token");
    for (call, args, explained) in [
        ("view", json!({"target": "theater"}), "not yours to change"),
        ("speak", json!({"text": "Done."}), "request_to_speak"),
    ] {
        let reply = module_call(
            &state,
            AgentCall {
                call: call.into(),
                token: "background-token".into(),
                turn_id: None,
                cause: None,
                args,
            },
        )
        .await;
        assert_eq!(reply["status"], "refused", "{call}: {reply}");
        assert_eq!(reply["reason"], "caller_away", "{call}: {reply}");
        assert!(
            reply["result"]["detail"]
                .as_str()
                .is_some_and(|detail| detail.contains(explained)),
            "{call}: {reply}"
        );
    }
}

#[tokio::test]
async fn background_speak_is_refused_and_held_display_is_released_on_promotion() {
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
    assert!(state.0.projection.has_held_display("alpha"));

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
    assert!(!state.0.projection.has_held_display("alpha"));
}

/// A background agent composes a scene in several calls. Every one is held,
/// and the caller who brings it forward sees the whole scene, not only the
/// last call (#254).
#[tokio::test]
async fn every_background_display_is_held_and_replayed_on_promotion() {
    let state = state();
    let (mut connection, _, _) = state.register_connection().await;
    state
        .0
        .coordinator
        .register_background("alpha", "background-token");
    let note = json!({"op":"show","id":"n1","type":"note","data":{
        "segments":[{"text":"this edge is new"}],"anchor":{"target":"d1"}}});
    let metric = json!({"op":"show","id":"m1","type":"metric","data":{
        "label":"latency","value":"12 ms"}});
    for action in [diagram_show()["action"].clone(), note, metric] {
        let (code, held) = agent_call_json(
            &state,
            "/display",
            json!({"token":"background-token", "action":action}),
        )
        .await;
        assert_eq!(code, StatusCode::OK, "{held}");
        assert_eq!(held["held"], true, "{held}");
    }

    begin_alpha_candidate(&state, "foreground-token");
    assert!(
        state
            .0
            .leg_announcer
            .promote_candidate("foreground-token")
            .await
    );
    assert_lifecycle_consistent(&state).await;
    let shown: Vec<String> = queued_frames(&mut connection)
        .iter()
        .filter(|frame| frame["type"] == "display")
        .filter_map(|frame| frame["action"]["id"].as_str().map(String::from))
        .collect();
    assert_eq!(
        shown,
        ["d1", "n1", "m1"],
        "the page is sent every held object"
    );
    let staged: Vec<String> = state
        .0
        .display_gate
        .lock()
        .await
        .projection()
        .snapshot_actions()
        .iter()
        .filter_map(|action| action["id"].as_str().map(String::from))
        .collect();
    assert_eq!(
        staged,
        ["d1", "n1", "m1"],
        "the stage holds every held object"
    );
}

/// A held show is held to the stage caps it will meet on promotion, and is
/// refused when it is sent, not dropped later (#254).
#[tokio::test]
async fn a_background_display_past_the_stage_caps_is_refused_at_once() {
    let state = state();
    state
        .0
        .coordinator
        .register_background("alpha", "background-token");
    let note =
        |id: String| json!({"op":"show","id":id,"type":"note","data":{"segments":[{"text":"x"}]}});
    for index in 0..crate::display::MAX_STAGE_OBJECTS {
        let (code, held) = agent_call_json(
            &state,
            "/display",
            json!({"token":"background-token", "action":note(format!("n{index}"))}),
        )
        .await;
        assert_eq!(code, StatusCode::OK, "{held}");
    }
    let (code, refused) = agent_call_json(
        &state,
        "/display",
        json!({"token":"background-token", "action":note("one-too-many".into())}),
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST, "{refused}");
    assert_eq!(refused["delivered"], false);
    assert!(
        refused["detail"].as_str().unwrap().contains("hide one"),
        "{refused}"
    );
    // An update in place still fits.
    let (code, held) = agent_call_json(
        &state,
        "/display",
        json!({"token":"background-token", "action":note("n0".into())}),
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{held}");
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

    let agents = state.0.projection.snapshot();
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

/// A module call with the host-turn fields a project session's call carries.
async fn module_call_json(
    state: &AppState,
    call: &str,
    token: &str,
    cause: Option<&str>,
    args: Value,
) -> (StatusCode, Value) {
    start_speech_worker_for_test(state);
    let call = AgentCall {
        call: call.to_owned(),
        token: token.to_owned(),
        turn_id: None,
        cause: cause.map(str::to_owned),
        args,
    };
    let response = agent_call(state, &call).await;
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

fn invalid_leg(detail: &str) -> (StatusCode, Value) {
    (
        StatusCode::CONFLICT,
        json!({"delivered":false, "code":"invalid_leg", "detail":detail}),
    )
}

const LEG_GONE: &str =
    "this leg is no longer on the call: stop retrying, nothing you send reaches the caller";

const SELF_WOKEN: &str = "no switchboard turn is running for this leg; this self-woken call has no delivery authority, so put the result in the written reply instead";

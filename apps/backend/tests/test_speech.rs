use super::*;
use crate::api::{
    agent_call_json, assert_lifecycle_consistent, cancel_active_operations, debug_events,
    frame_json, frames_until, request_to_speak, route_final_transcript, spawn_workers, state,
    state_on, until_debug, AppState,
};
use crate::audio::{Speaker, SttAdapter, SttStreamAdapter, TestTtsGate, TtsContinuity};
use crate::delivery::{DeliveryConnection, DeliveryFrame, Event};
use crate::floor::{FloorRequest, ReleaseOutcome};
use crate::history::TranscriptLog;
use crate::hosts::{FakeHostAgent, Step};
use crate::jev::fake_jev_client;
use crate::pbx::{Switchboard, OPERATOR};
use crate::registry::{Project, Registry};
use axum::http::StatusCode;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio::time::{timeout, Duration};

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
        None,
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
        None,
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
        None,
    )
    .await
    .expect("unrelated line should start fresh");
    assert_eq!(
        state.0.continuity_snapshot().last_text.as_deref(),
        Some("fresh line")
    );
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
        async move { queue_speech(&state, admission, None).await }
    });
    timeout(Duration::from_secs(1), gate.wait_started())
        .await
        .expect("first gated drain started");
    let second = tokio::spawn({
        let state = state.clone();
        let admission = admission(ContinuationScope::ContinueCurrentTurn);
        async move { queue_speech(&state, admission, None).await }
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

// A line on the wire names the audio utterance that voices it, so the page
// can show it when that utterance starts to play rather than when the line
// arrives (#112).

#[tokio::test]
async fn each_spoken_line_names_the_utterance_that_voices_it() {
    let state = speaking_state();
    let (mut connection, _, _) = state.register_connection().await;

    for text in ["First line.", "Second line."] {
        let (code, _) = agent_call_json(&state, "/speak", json!({"text": text})).await;
        assert_eq!(code, StatusCode::OK);
    }

    let mut frames = wire_frames_until(&mut connection, "spoken").await;
    frames.extend(wire_frames_until(&mut connection, "spoken").await);
    let starts = audio_starts(&frames);
    assert_eq!(starts.len(), 2, "{frames:#?}");
    let spoken: Vec<(&Value, &Value)> = frames
        .iter()
        .filter(|frame| frame["type"] == "spoken")
        .map(|frame| (&frame["entry"]["text"], &frame["sequence"]))
        .collect();
    assert_eq!(
        spoken,
        [
            (&json!("First line."), &json!(starts[0])),
            (&json!("Second line."), &json!(starts[1])),
        ]
    );
}

#[tokio::test]
async fn a_voiced_reply_names_the_utterance_its_speech_starts_with() {
    let state = speaking_state();
    let (mut connection, _, _) = state.register_connection().await;
    let generation = state.0.coordinator.generation();
    let reply = voiced_reply("First part. Second part.", &["First part.", "Second part."]);

    assert!(deliver_turn_if_current(&state, &reply, generation, "clip-1").await);

    let frames = wire_frames_until(&mut connection, "final_response_audio_closed").await;
    let starts = audio_starts(&frames);
    assert_eq!(starts.len(), 2, "{frames:#?}");
    let reply = frames
        .iter()
        .find(|frame| frame["type"] == "reply")
        .expect("the reply is announced");
    assert_eq!(reply["sequence"], starts[0], "{frames:#?}");
    // The announcement comes before the audio it names.
    let position = |kind: &str| frames.iter().position(|frame| frame["type"] == kind);
    assert!(position("reply") < position("audio_start"), "{frames:#?}");
}

#[tokio::test]
async fn a_voiced_page_reply_names_the_utterance_its_speech_starts_with() {
    let state = speaking_state();
    let (mut connection, _, _) = state.register_connection().await;
    let generation = state.0.coordinator.generation();
    let reply = voiced_reply("Putting you through.", &["Putting you through."]);

    assert!(deliver_page_reply_if_current(&state, &reply, generation).await);

    let frames = wire_frames_until(&mut connection, "audio_done").await;
    let spoken = frames
        .iter()
        .find(|frame| frame["type"] == "spoken")
        .expect("the reply is told to the caller");
    assert_eq!(
        spoken["sequence"],
        json!(audio_starts(&frames)[0]),
        "{frames:#?}"
    );
}

#[tokio::test]
async fn a_reply_with_nothing_to_say_aloud_names_no_utterance() {
    let state = speaking_state();
    let (mut connection, _, _) = state.register_connection().await;
    let generation = state.0.coordinator.generation();
    let reply = voiced_reply("   ", &["   "]);

    assert!(deliver_turn_if_current(&state, &reply, generation, "clip-1").await);

    let frames = wire_frames_until(&mut connection, "final_response_audio_closed").await;
    let reply = frames
        .iter()
        .find(|frame| frame["type"] == "reply")
        .unwrap();
    assert!(reply.get("sequence").is_none(), "{reply}");
    assert!(audio_starts(&frames).is_empty(), "{frames:#?}");
}

#[tokio::test]
async fn a_reply_superseded_after_its_utterance_was_reserved_leaves_no_slot_open() {
    let state = speaking_state();
    let generation = state.0.coordinator.generation();
    let reply = voiced_reply("Too late.", &["Too late."]);
    // Hold the delivery gate so the rescue lands after the reservation.
    let gate = state.0.operation_transition.lock().await;
    let delivery = tokio::spawn({
        let state = state.clone();
        async move { deliver_turn_if_current(&state, &reply, generation, "clip-1").await }
    });
    timeout(Duration::from_secs(1), async {
        while state.0.audio.lock().await.slots.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the reply reserves its first utterance before the gate");
    state.0.coordinator.begin_rescue("test rescue");
    drop(gate);

    assert!(!delivery.await.unwrap());
    assert!(
        state.0.audio.lock().await.slots.is_empty(),
        "a reserved slot left open holds back every later utterance"
    );
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
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
            floor_id: 0,
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
    // The gate's Jev call is traced under the floor message, not an utterance.
    let response = until_debug(&state, |event| {
        matches!(event, crate::debug::DebugEvent::JevResponse { purpose, .. } if purpose == "good_moment")
    })
    .await;
    assert!(matches!(
        response,
        crate::debug::DebugEvent::JevResponse { utterance_id: None, floor_id: Some(ref id), .. }
            if id == "floor-1"
    ));
    assert!(debug_events(&state).iter().any(|event| matches!(
        event,
        crate::debug::DebugEvent::JevRequest { purpose, floor_id: Some(id), utterance_id: None, .. }
            if purpose == "good_moment" && id == "floor-1"
    )));
    host.disconnect_fake("scriptorium");
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
    spawn_workers(state.clone());
    state.0.floor.force_quiet_for_test().await;
    let accepted = request_to_speak(
        state.clone(),
        "grapes-token",
        json!({"message":"the update is ready", "reason":"finished"}),
    )
    .await;
    assert_eq!(accepted.status(), StatusCode::OK);
    // The rewrite is watched on this test's own debug bus: the utility leg
    // publishes its prompt once the utility has it, and the utility then
    // waits. A process-global hook saw every test's utility, and a parallel
    // test's rewrite used to land here in this one's place (#126).
    let crate::debug::DebugEvent::AgentInput { text: prompt, .. } = until_debug(&state, |event| {
        matches!(
            event,
            crate::debug::DebugEvent::AgentInput { agent, source, .. }
                if agent == "utility" && source == "floor_rewrite"
        )
    })
    .await
    else {
        unreachable!("until_debug returns the event it matched");
    };
    assert!(prompt.contains("Display held: yes"), "{prompt}");
    // The rules for a held display live in the utility's system prompt; the
    // request carries only the data.
    assert!(!prompt.contains("on screen"), "{prompt}");

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
            floor_id: 0,
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
async fn a_stale_reply_is_traced_as_speech_not_delivered() {
    let state = state();
    let generation = state.0.coordinator.generation();
    state.0.coordinator.begin_rescue("test rescue");
    let reply = crate::pbx::Reply {
        text: "Old news.".into(),
        to_speak: vec!["Old news.".into()],
        route: OPERATOR.into(),
        route_label: OPERATOR.into(),
        error: None,
        voiced: true,
        delivery_generation: None,
    };

    assert!(!deliver_turn_if_current(&state, &reply, generation, "r-1").await);

    assert_eq!(
        debug_events(&state).pop(),
        Some(crate::debug::DebugEvent::Speech {
            agent: OPERATOR.into(),
            text: "Old news.".into(),
            delivered: false,
            reason: Some("stale_generation".into()),
            floor_id: None,
        })
    );
}

/// A call whose speech synthesis succeeds, with its speech worker running.
fn speaking_state() -> AppState {
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
    start_speech_worker_for_test(&state);
    state
}

fn voiced_reply(text: &str, to_speak: &[&str]) -> crate::pbx::Reply {
    crate::pbx::Reply {
        text: text.into(),
        route: OPERATOR.into(),
        route_label: "Operator".into(),
        error: None,
        to_speak: to_speak.iter().map(|line| (*line).to_owned()).collect(),
        voiced: !to_speak.is_empty(),
        delivery_generation: None,
    }
}

/// Frames up to and including the first of type `until`, as the browser
/// reads them, audio markers included.
async fn wire_frames_until(connection: &mut DeliveryConnection, until: &str) -> Vec<Value> {
    let mut frames = Vec::new();
    loop {
        let frame = timeout(Duration::from_secs(2), connection.receiver.recv())
            .await
            .expect("a frame before the deadline")
            .expect("an open connection");
        let value = match frame {
            DeliveryFrame::Event {
                event: Event::AudioStart { sequence, .. },
                ..
            } => json!({"type": "audio_start", "sequence": sequence}),
            DeliveryFrame::Event {
                event: Event::AudioDone { sequence, .. },
                ..
            } => json!({"type": "audio_done", "sequence": sequence}),
            frame => match frame_json(frame) {
                Some(value) => value,
                None => continue,
            },
        };
        let done = value["type"] == until;
        frames.push(value);
        if done {
            return frames;
        }
    }
}

/// The sequences of the utterances that started, in order.
fn audio_starts(frames: &[Value]) -> Vec<u64> {
    frames
        .iter()
        .filter(|frame| frame["type"] == "audio_start")
        .map(|frame| frame["sequence"].as_u64().unwrap())
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

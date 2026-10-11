use super::*;
use crate::app_state::{assert_lifecycle_consistent, debug_events, state, state_on, until_debug};
use crate::app_state::{spawn_workers, AppState};
use crate::audio::{Speaker, SttAdapter, SttStreamAdapter};
use crate::browser::frames_until;
use crate::caller_input::route_final_transcript;
use crate::delivery::DeliveryConnection;
use crate::floor::{FloorRequest, ReleaseOutcome};
use crate::history::TranscriptLog;
use crate::hosts::{FakeHostAgent, Step};
use crate::jev::fake_jev_client;
use crate::module_calls::request_to_speak;
use crate::pbx::Switchboard;
use crate::registry::{Project, Registry};
use axum::http::StatusCode;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};

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

/// A floor test's state, with alpha in the background and its update queued
/// on a quiet line. The utility is `/bin/sh`, which cannot rewrite anything.
async fn floor_update_queued_on_a_quiet_line(
    client: crate::jev::JevClient,
) -> (AppState, DeliveryConnection) {
    floor_update_queued_with_utility(client, "/bin/sh").await
}

/// The same, with `utility` as the `pi` binary.
async fn floor_update_queued_with_utility(
    client: crate::jev::JevClient,
    utility: &str,
) -> (AppState, DeliveryConnection) {
    let config = crate::Config::for_tests(&[
        ("SWITCHBOARD_PI_BINARY", utility),
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
        client,
    ));
    let (connection, _, _) = state.register_connection().await;
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
    (state, connection)
}

#[tokio::test]
async fn floor_good_moment_gate_does_not_wait_for_the_pbx_lock() {
    let (client, _, jev_called) = fake_jev_client();
    let (state, _connection) = floor_update_queued_on_a_quiet_line(client).await;
    // A foreground turn holds the PBX lock for its whole prompt.
    let _turn = state.0.switchboard.lock().await;
    spawn_floor_worker(state.clone());

    timeout(Duration::from_secs(1), jev_called.notified())
        .await
        .expect("the floor gate asks Jev while a foreground turn runs");
}

/// The utility has its own lock, so a foreground turn holding the PBX lock
/// for its whole prompt does not keep a background update from being
/// rewritten (#386). Before, the rewrite waited for the PBX lock until its
/// timeout and the update was spoken as the agent wrote it.
#[cfg(unix)]
#[tokio::test]
async fn floor_rewrite_reaches_the_utility_while_a_turn_holds_the_pbx_lock() {
    let root = crate::pbx::scratch_dir("floor-rewrite-unlocked");
    let utility = root.join("fake-utility");
    crate::pi_client::write_executable_script(
        &utility,
        r##"while IFS= read -r line; do
printf '%s\n' '{"type":"tool_execution_start","toolName":"rewrite","args":{"text":"alpha is done"}}'
printf '%s\n' '{"type":"agent_settled"}'
done
"##,
    );
    let (client, _, _) = fake_jev_client();
    let (state, _connection) =
        floor_update_queued_with_utility(client, &utility.to_string_lossy()).await;
    let turn = state.0.switchboard.lock().await;
    spawn_floor_worker(state.clone());

    let rewrite = timeout(
        crate::floor::REWRITE_TIMEOUT / 2,
        until_debug(&state, |event| {
            matches!(event, crate::debug::DebugEvent::FloorRewrite { .. })
        }),
    )
    .await
    .expect("the floor rewrite does not wait for the PBX lock");
    assert!(matches!(
        rewrite,
        crate::debug::DebugEvent::FloorRewrite { ref rewritten, .. } if rewritten == "alpha is done"
    ));
    drop(turn);
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
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
                // unbounded: the fake holds the gate until the test opens it.
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
        .transfer_to(
            &crate::pbx::TransferContext {
                exact_caller_transcript: "start on switchboard".into(),
                ..Default::default()
            },
            "switchboard",
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
        .hold_display(
            "grapes".into(),
            &json!({"op":"show","id":"doc","type":"note","data":{"segments":[{"text":"ready"}]}}),
        )
        .unwrap();
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
    let summary = board
        .routing_view()
        .call_summary(&[], json!({}), "caller turn");
    assert_eq!(summary.caller_just_said, "caller turn");
    board.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

/// A route rescue makes a queued request stale even though its agent is
/// still in the background. The floor drops it before it asks the utility
/// for words: its liveness check is the same one the release makes, and it
/// checks the generation.
#[tokio::test]
async fn a_request_a_rescue_made_stale_is_dropped_before_the_rewrite() {
    let (client, _, _) = fake_jev_client();
    let (state, _connection) = floor_update_queued_on_a_quiet_line(client).await;
    state.0.coordinator.begin_rescue("new foreground leg");
    spawn_floor_worker(state.clone());

    let left = until_debug(&state, |event| {
        matches!(event, crate::debug::DebugEvent::FloorReleased { .. })
    })
    .await;
    assert!(matches!(
        left,
        crate::debug::DebugEvent::FloorReleased { ref how, .. } if how == "dropped_agent_gone"
    ));
    assert!(
        !debug_events(&state)
            .iter()
            .any(|event| matches!(event, crate::debug::DebugEvent::FloorRewrite { .. })),
        "a stale request is not rewritten"
    );
}

/// An agent that asks to speak again while its first request is on its way
/// out stays waiting once the first is spoken: the floor still holds the
/// newer request, and the page and Jev see what the floor holds (#388).
#[tokio::test]
async fn an_agent_whose_newer_request_still_waits_stays_waiting_after_its_first_is_spoken() {
    let gate_open = std::sync::Arc::new(tokio::sync::Notify::new());
    let gates = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let jev = crate::jev::JevClient::new(
        "http://unused.invalid/v1/systemone",
        "/nonexistent/typesafe-api-key",
        Duration::from_secs(1),
    )
    .expect("client")
    .with_test_responder({
        let gate_open = gate_open.clone();
        let gates = gates.clone();
        move |_request| {
            let gate_open = gate_open.clone();
            let first = gates.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0;
            async move {
                if !first {
                    // unbounded: the second request's gate waits until the test opens it.
                    gate_open.notified().await;
                }
                Ok(serde_json::from_value(json!({"model": "jev-test", "answers": {
                    "good_moment": {"type":"choice","choice":"yes","probabilities":{"yes":1.0},"confidence":1.0}
                }}))
                .expect("fixture response"))
            }
        }
    });
    let config = crate::Config::for_tests(&[
        ("SWITCHBOARD_PI_BINARY", "/bin/sh"),
        ("SWITCHBOARD_FLOOR_QUIET_THRESHOLD_MS", "1"),
    ]);
    let registry = Registry::new(vec![]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("test catalog"),
    );
    let state = AppState::new(
        Switchboard::new_with_jev(&config, registry, std::sync::Arc::new(prewarm), jev),
        TranscriptLog::new(10),
        Speaker::test_success(100, Duration::from_millis(25_000)),
        SttAdapter::from_command(None),
        SttStreamAdapter::from_command(None),
    );
    crate::speech::start_speech_worker_for_test(&state);
    let (_connection, _, _) = state.register_connection().await;
    state
        .0
        .coordinator
        .register_background("alpha", "alpha-token");
    for message in ["first update", "second update"] {
        let accepted = request_to_speak(
            state.clone(),
            "alpha-token",
            json!({"message": message, "reason": "finished"}),
        )
        .await;
        assert_eq!(accepted.status(), StatusCode::OK);
    }
    spawn_floor_worker(state.clone());

    let first = until_debug(&state, |event| {
        matches!(event, crate::debug::DebugEvent::FloorReleased { floor_id: Some(id), .. } if id == "floor-1")
    })
    .await;
    assert!(matches!(
        first,
        crate::debug::DebugEvent::FloorReleased { ref how, .. } if how == "gate_yes"
    ));
    let alpha = state
        .0
        .projection
        .snapshot()
        .into_iter()
        .find(|agent| agent.project == "alpha")
        .expect("alpha is on the page");
    assert_eq!(alpha.state, "waiting");
    assert_eq!(
        alpha
            .pending_request
            .map(|request| request.message)
            .as_deref(),
        Some("second update")
    );
    gate_open.notify_one();
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
    )
    .await;
    assert_eq!(outcome, ReleaseOutcome::Drop);
}

/// A release that waits for its place in the worker's queue speaks under the
/// generation current once it has it. A leg change during the wait is then
/// its own staleness check's to drop at once, not a superseded reservation
/// to retry and leave at the head of the floor's queue (#136).
#[tokio::test]
async fn a_floor_release_that_waited_for_its_place_drops_a_leg_change_at_once() {
    let state = state();
    let (_connection, _, _) = state.register_connection().await;
    state
        .0
        .coordinator
        .register_background("grapes", "grapes-token");
    let generation = state.0.coordinator.generation();
    // Every place in the worker's queue is taken, so the release must wait.
    let taken: Vec<_> = std::iter::from_fn(|| state.0.speech.try_reserve().ok()).collect();
    assert!(!taken.is_empty());
    let release_state = state.clone();
    let release = tokio::spawn(async move {
        release_floor(
            &release_state,
            FloorRequest {
                floor_id: 0,
                project: "grapes".into(),
                token: "grapes-token".into(),
                generation,
                context: "caller: previous line".into(),
                message: "late update".into(),
                reason: "finished".into(),
                held_display: false,
            },
            "late update".into(),
        )
        .await
    });
    tokio::task::yield_now().await;
    assert!(!release.is_finished(), "the release waits for a place");
    // The leg changes while it waits; then the queue has room.
    state.0.coordinator.begin_rescue("new foreground leg");
    drop(taken);
    let outcome = tokio::time::timeout(Duration::from_secs(5), release)
        .await
        .expect("the release settles once it has its place")
        .unwrap();
    assert_eq!(outcome, ReleaseOutcome::Drop);
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

use super::*;
use crate::api::request_json;
use crate::app_state::AppState;
use crate::app_state::{
    begin_alpha_candidate, catalog_of, debug_events, hold_turn_lock, scratch_root, state, state_on,
    state_with_agents, until_debug,
};
use crate::audio::{Speaker, SttAdapter, SttStreamAdapter};
use crate::browser::{frames_until, queued_frames, types_of};
use crate::caller_input::assert_dropped_with_notice;
use crate::history::TranscriptLog;
use crate::hosts::{FakeHostAgent, FakeLog, Step};
use crate::pbx::{Switchboard, OPERATOR};
use crate::pi_client::{LegSession, PiSession};
use crate::registry::Registry;
use crate::turns::alpha_caller_turn_in_flight;
use crate::within;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};

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
    within("locked_rx", locked_rx).await.unwrap();

    let interrupted = timeout(Duration::from_secs(1), cancel_active_operations(&state))
        .await
        .expect("rescue should not wait for the wedged turn");
    assert_eq!(interrupted.as_deref(), Some(OPERATOR));
    assert!(within("turn", turn).await.unwrap_err().is_cancelled());
    assert!(!session.alive().await);
    assert!(timeout(Duration::from_secs(1), state.0.switchboard.lock())
        .await
        .is_ok());
}

#[tokio::test]
async fn newer_page_control_supersedes_setup_before_a_session_exists() {
    let state = state();
    let first_state = state.clone();
    let (first, first_id) =
        spawn_registered_operation(&state, state.0.coordinator.generation(), async move {
            hold_turn_lock(&first_state, None).await;
        })
        .await
        .unwrap();

    let second_state = state.clone();
    let Ok((rescued, _closed)) = admitted(&state).rescue().await else {
        panic!("the call is still at the generation the control was admitted at");
    };
    let second = tokio::spawn(async move {
        rescued
            .run(async move {
                let _held_second = second_state.0.switchboard.lock().await;
                7
            })
            .await
            .map(|(_, output)| output)
    });

    assert!(within("first", first).await.unwrap_err().is_cancelled());
    clear_active_operation(&state, first_id).await;
    assert_eq!(
        timeout(Duration::from_secs(1), second)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        7
    );
    assert!(state.0.active_operations.lock().await.is_empty());
}

// #263: a control acts at the generation its own rescue left. A newer
// control (a second tab, a hangup pressed during a slow /connect) that
// rescues while this one is still releasing the old leg owns the call, and
// this one must not register on the generation that rescue made.
#[tokio::test]
async fn a_control_overtaken_during_its_rescue_registers_nothing() {
    let state = state();
    let generation = state.0.coordinator.generation();
    // The rescue stops after it moved the generation, while it waits to close
    // the live session.
    let session = state.0.active_session.lock().await;
    let control = admitted(&state);
    let control = tokio::spawn(async move {
        run_page_control(control, async { operator_reply() })
            .await
            .err()
    });
    timeout(Duration::from_secs(5), async {
        while state.0.coordinator.generation() == generation {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("the control's rescue moves the generation");
    state.0.coordinator.begin_rescue("a newer control");
    drop(session);

    let refused = timeout(Duration::from_secs(5), control)
        .await
        .unwrap()
        .unwrap()
        .expect("it ran on the newer control's generation");
    assert_eq!(
        refusal_of(refused).await,
        (
            StatusCode::CONFLICT,
            json!({"detail":"connection attempt was cancelled"})
        )
    );
    assert!(state.0.active_operations.lock().await.is_empty());
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
    assert!(!state.0.turns.in_flight_for_test());
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
    assert!(!state.0.turns.in_flight_for_test());
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
        Speaker::new(
            100,
            std::time::Duration::from_millis(25_000),
            crate::Config::for_tests(&[]).tts,
        ),
        SttAdapter::from_command(None),
        SttStreamAdapter::from_command(None),
    );
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    let (control, turn_worker) =
        queue_a_clip_while_a_page_control_starts_a_leg(&state, "while-connecting").await;
    assert!(state.0.coordinator.is_candidate());

    let startup = state.0.coordinator.candidate_identity().unwrap();
    assert!(state
        .0
        .coordinator
        .rollback_startup(startup.generation, "startup failed"));
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
async fn a_page_control_whose_leg_is_rescued_mid_operation_is_refused_as_superseded() {
    let state = state();
    let rescuer = state.clone();
    let controlled = run_page_control(admitted(&state), async move {
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
    let controlled = run_page_control(admitted(&state), async move {
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
    let (turn, _id) =
        spawn_registered_operation(&state, state.0.coordinator.generation(), async move {
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

    let (code, body) = request_json(
        &state,
        Method::POST,
        "/hangup",
        Some(at_generation(&state, json!({}))),
    )
    .await;

    assert_eq!(code, StatusCode::OK);
    assert_eq!(body, json!({"hungup":true, "left":"alpha"}));
    assert!(within("turn", turn).await.unwrap_err().is_cancelled());
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

#[tokio::test]
async fn hanging_up_with_nothing_on_the_line_says_so() {
    let state = state();
    let (mut connection, _, _) = state.register_connection().await;
    let before = state.0.coordinator.generation();

    let (code, body) = request_json(
        &state,
        Method::POST,
        "/hangup",
        Some(at_generation(&state, json!({}))),
    )
    .await;

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

    let (code, body) = request_json(
        &state,
        Method::POST,
        "/hangup",
        Some(at_generation(&state, json!({}))),
    )
    .await;

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
        let reply = board.transfer_to(&context, "alpha").await;
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
    let (wedged, _) =
        spawn_registered_operation(&state, state.0.coordinator.generation(), async move {
            hold_turn_lock(&turn_state, Some(locked_tx)).await;
        })
        .await
        .unwrap();
    within("locked_rx", locked_rx).await.unwrap();
    let (mut connection, _, _) = state.register_connection().await;
    let before = state.0.coordinator.generation();

    let (code, body) = timeout(
        Duration::from_secs(5),
        request_json(
            &state,
            Method::POST,
            "/hangup",
            Some(at_generation(&state, json!({}))),
        ),
    )
    .await
    .expect("a hangup must not wait for the turn it rescues the caller from");

    assert_eq!(code, StatusCode::OK);
    assert_eq!(body, json!({"hungup":true, "left":"alpha"}));
    assert!(within("wedged", wedged).await.unwrap_err().is_cancelled());
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
    within("locked_rx", locked_rx).await.unwrap();
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
            request_json(
                &state,
                Method::POST,
                path,
                Some(at_generation(&state, body)),
            ),
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

// #263: a page control acts on the leg the page saw when the caller acted. It
// carries that generation; one the call has moved on from is refused (a
// picker) or ignored (a hangup), and one with none is refused outright. It is
// never defaulted to the current generation: that is how a queued request or
// a stale tab acted on a leg the caller never chose.

#[cfg(unix)]
#[tokio::test]
async fn a_page_control_for_a_generation_the_call_has_left_changes_nothing() {
    let call = call_on_alpha(&[]).await;
    let state = &call.state;
    let generation = state.0.coordinator.generation();
    let stale = generation - 1;
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;

    for (path, body, detail) in [
        (
            "/model",
            json!({"model":"anthropic/next", "generation":stale}),
            "model change was refused",
        ),
        (
            "/thinking",
            json!({"level":"high", "generation":stale}),
            "thinking change was refused",
        ),
        (
            "/connect",
            json!({"project":"operator", "generation":stale}),
            "connection attempt was refused",
        ),
        ("/hangup", json!({"generation":stale}), "hangup was ignored"),
    ] {
        let (code, answer) = request_json(state, Method::POST, path, Some(body)).await;
        assert_eq!(code, StatusCode::CONFLICT, "{path}: {answer}");
        assert_eq!(
            answer,
            json!({"detail": format!(
                "{detail}: the line moved on (the page held generation {stale}, the call is at {generation})"
            )}),
        );
    }

    assert_eq!(
        state.0.coordinator.generation(),
        generation,
        "nothing was rescued"
    );
    assert!(call.live.alive().await);
    let status = state.0.coordinator.status();
    assert_eq!(
        (status.route.as_str(), status.model.as_str()),
        ("alpha", "anthropic/current:medium")
    );
    assert!(!types_of(&queued_frames(&mut connection)).contains(&"epoch"));
    call.assert_next_turn_reaches_alpha().await;
    call.hang_up().await;
}

// #263: a hangup acts on the PBX only while the call is still at the
// generation its own rescue left. A newer control that rescued since (a
// /connect pressed right after it, a second tab) owns the call; the hangup
// that came before it must not drop the leg that control dials.
#[cfg(unix)]
#[tokio::test]
async fn a_hangup_overtaken_before_it_reaches_the_pbx_drops_nothing() {
    let call = call_on_alpha(&[]).await;
    let state = &call.state;
    let generation = state.0.coordinator.generation();
    // The hangup's rescue goes through; the PBX is busy, so its drop waits.
    let board = state.0.switchboard.lock().await;
    let request_state = state.clone();
    let hangup = tokio::spawn(async move {
        request_json(
            &request_state,
            Method::POST,
            "/hangup",
            Some(json!({"generation": generation})),
        )
        .await
    });
    timeout(Duration::from_secs(5), async {
        while state.0.coordinator.generation() == generation {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("the hangup's rescue moves the generation");
    state.0.coordinator.begin_rescue("a newer control");
    drop(board);

    let (code, answer) = timeout(Duration::from_secs(5), hangup)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (code, answer),
        (
            StatusCode::CONFLICT,
            json!({"detail": "hangup was superseded"})
        )
    );
    assert_ne!(
        last_transcript_line(state).await,
        Some((
            "You hung up the line to alpha. You're back with the operator.".to_owned(),
            "alpha".to_owned()
        )),
        "the hangup dropped the leg the newer control owns"
    );
    let still_held = state.0.switchboard.lock().await.force_hangup().await;
    assert_eq!(
        still_held.as_deref(),
        Some("alpha"),
        "the PBX still holds the leg the hangup left to the newer control"
    );
    call.hang_up().await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_page_control_without_a_generation_changes_nothing() {
    let call = call_on_alpha(&[]).await;
    let state = &call.state;
    let generation = state.0.coordinator.generation();

    for (path, body, detail) in [
        (
            "/model",
            json!({"model":"anthropic/next"}),
            "model change was refused",
        ),
        (
            "/thinking",
            json!({"level":"high"}),
            "thinking change was refused",
        ),
        (
            "/connect",
            json!({"project":"operator"}),
            "connection attempt was refused",
        ),
        ("/hangup", json!({}), "hangup was ignored"),
    ] {
        let (code, answer) = request_json(state, Method::POST, path, Some(body)).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{path}: {answer}");
        assert_eq!(
            answer,
            json!({"detail": format!("{detail}: it carries no generation")}),
        );
    }

    assert_eq!(state.0.coordinator.generation(), generation);
    assert!(call.live.alive().await);
    call.assert_next_turn_reaches_alpha().await;
    call.hang_up().await;
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
            Some(at_generation(state, json!({"model":"anthropic/next"}))),
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
    assert!(within("turn", turn).await.unwrap_err().is_cancelled());
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
            Some(at_generation(
                &request_state,
                json!({"model":"anthropic/next"}),
            )),
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

    let (code, answer) = within("request", request).await.unwrap();

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
        // unbounded: inside the spawned mover; the test bounds `mover` itself.
        board.await.force_hangup().await
    });
    within("queued_rx", queued_rx).await.unwrap();

    let (code, answer) = timeout(
        Duration::from_secs(5),
        request_json(
            state,
            Method::POST,
            "/model",
            Some(at_generation(state, json!({"model":"anthropic/next"}))),
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
    assert!(within("turn", turn).await.unwrap_err().is_cancelled());
    assert_eq!(
        within("mover", mover).await.unwrap().as_deref(),
        Some("alpha")
    );
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

#[cfg(unix)]
#[tokio::test]
async fn a_turn_cancelled_by_a_rescue_ends_its_trace() {
    let root = scratch_root("trace-cancelled-turn");
    let (state, _host, _token, _instance_id, worker) = alpha_caller_turn_in_flight(&root).await;

    cancel_active_operations(&state).await;

    let ended = until_debug(&state, |event| {
        matches!(event, crate::debug::DebugEvent::PbxBranch { utterance_id, branch, .. }
            if utterance_id == "caller-held" && branch == "dropped_stale")
    })
    .await;
    let crate::debug::DebugEvent::PbxBranch { reason, .. } = ended else {
        unreachable!()
    };
    assert!(reason.contains("cancelled the turn"), "{reason}");
    worker.abort();
    let _ = worker.await;
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_rescue_and_the_call_boundaries_are_traced() {
    use crate::debug::DebugEvent;
    let state = state();
    let (connection, _, _) = state.register_connection().await;
    cancel_active_operations(&state).await;
    let generation = state.0.coordinator.generation();
    state.retire_connection(connection.epoch).await;

    let events: Vec<_> = debug_events(&state)
        .into_iter()
        .filter(|event| {
            matches!(
                event,
                DebugEvent::CallBoundary { .. } | DebugEvent::Rescue { .. }
            )
        })
        .collect();
    assert_eq!(
        events,
        vec![
            DebugEvent::CallBoundary {
                phase: "started".into(),
                call_id: "call-1".into(),
                reason: None,
            },
            DebugEvent::Rescue {
                generation,
                reason: "operation interrupted".into(),
                leg: None,
            },
            DebugEvent::CallBoundary {
                phase: "ended".into(),
                call_id: "call-1".into(),
                reason: Some("page_closed".into()),
            },
        ]
    );
}

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
    within("locked_rx", locked_rx).await.unwrap();
    cancel_active_operations(state).await;
    begin_alpha_candidate(state, "alpha-leg");

    state
        .0
        .turns
        .enqueue_for_test((
            id.into(),
            "and check the logs".into(),
            state.0.coordinator.generation(),
        ))
        .await
        .unwrap();
    let turn_worker = tokio::spawn(process_turns(state.clone()));
    timeout(Duration::from_secs(10), async {
        while state.0.turns.queued_for_test() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the turn worker takes the clip");
    (control, turn_worker)
}

/// A `/connect` admitted at the generation the call is at, as the page
/// sends it.
fn admitted(state: &AppState) -> Admitted {
    PageControl::admit(
        state,
        "connection attempt",
        StaleOutcome::Refused,
        Some(state.0.coordinator.generation()),
    )
    .unwrap_or_else(|_| panic!("the page holds the generation the call is at"))
}

fn operator_reply() -> crate::reply::Reply {
    crate::reply::Reply {
        text: String::new(),
        route: OPERATOR.into(),
        route_label: "Operator".into(),
        error: None,
        to_speak: Vec::new(),
        voiced: false,
        delivery_generation: None,
    }
}

/// A page control's body as the page sends it: what it asks for, at the
/// generation the page holds, which is the call's current one (#263).
fn at_generation(state: &AppState, mut body: Value) -> Value {
    body["generation"] = json!(state.0.coordinator.generation());
    body
}

async fn refusal_of(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
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
        Some(at_generation(&state, json!({"project":"alpha"}))),
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

        let body = at_generation(state, body);
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
    within("locked_rx", locked_rx).await.unwrap();
    turn
}

// ---------------------------------------------------------------------------
// The page control table (#369). A page control is a fixed sequence with
// failure exits: admitted at the generation the page held, rescued (a
// redial decides first), its operation run at the rescue's generation, the
// PBX acted on, the reply delivered, and the call settled. Each row drives
// one control through one exit over HTTP, on a call put through to alpha,
// and records the answer and the line it leaves: how far the generation
// moved (`+1` is the control's own rescue, `+2` a newer one on top), whether
// the call is still quiescing or has settled, and the route.

const PAGE_CONTROL_ROWS: [&str; 24] = [
    "connect | admitted | no generation",
    "connect | admitted | the line moved on",
    "connect | rescued | the dial is delivered",
    "connect | rescued | a newer rescue lands while it releases the leg",
    "connect | running | a newer rescue cancels the dial",
    "connect | delivering | a newer rescue supersedes the reply",
    "hangup | admitted | no generation",
    "hangup | admitted | the line moved on",
    "hangup | rescued | the leg is dropped",
    "hangup | rescued | a newer rescue lands while it releases the leg",
    "hangup | at the pbx | a newer rescue lands before the check",
    "hangup | at the pbx | a newer rescue lands after the drop",
    "model | admitted | no generation",
    "model | admitted | the line moved on",
    "model | deciding | answered without a redial",
    "model | deciding | a rescue cancels the decision",
    "model | deciding | the caller leaves before the rescue",
    "model | rescued | the redial is delivered",
    "model | rescued | a newer rescue lands while it releases the leg",
    "model | running | a newer rescue cancels the redial",
    "model | running | the caller leaves before the pbx",
    "thinking | admitted | no generation",
    "thinking | deciding | answered without a redial",
    "thinking | rescued | the redial is delivered",
];

#[cfg(unix)]
#[tokio::test]
async fn every_page_control_exit_leaves_the_line_as_the_table_says() {
    let mut rows = Vec::new();
    for row in PAGE_CONTROL_ROWS {
        let call = call_on_alpha(&[]).await;
        let before = call.state.0.coordinator.generation();
        let (code, answer) = drive_page_control(&call, row).await;
        let body = serde_json::to_string(&answer).unwrap();
        rows.push(format!(
            "{row} => {} {body} | {}",
            code.as_u16(),
            line_after(&call.state, before)
        ));
        call.hang_up().await;
    }
    let expected: Vec<&str> = PAGE_CONTROL_TABLE.trim().lines().map(str::trim).collect();
    if rows != expected {
        eprintln!("{}", rows.join("\n"));
    }
    assert_eq!(rows, expected);
}

const PAGE_CONTROL_TABLE: &str = r#"
connect | admitted | no generation => 400 {"detail":"connection attempt was refused: it carries no generation"} | +0 settled alpha
connect | admitted | the line moved on => 409 {"detail":"connection attempt was refused: the line moved on (the page held generation 1, the call is at 2)"} | +0 settled alpha
connect | rescued | the dial is delivered => 200 {"error":null,"route":"operator"} | +1 settled operator
connect | rescued | a newer rescue lands while it releases the leg => 409 {"detail":"connection attempt was cancelled"} | +2 quiescing alpha
connect | running | a newer rescue cancels the dial => 409 {"detail":"connection attempt was cancelled"} | +2 quiescing alpha
connect | delivering | a newer rescue supersedes the reply => 409 {"detail":"connection attempt was superseded"} | +2 settled operator
hangup | admitted | no generation => 400 {"detail":"hangup was ignored: it carries no generation"} | +0 settled alpha
hangup | admitted | the line moved on => 409 {"detail":"hangup was ignored: the line moved on (the page held generation 1, the call is at 2)"} | +0 settled alpha
hangup | rescued | the leg is dropped => 200 {"hungup":true,"left":"alpha"} | +1 settled operator
hangup | rescued | a newer rescue lands while it releases the leg => 409 {"detail":"hangup was superseded"} | +2 quiescing alpha
hangup | at the pbx | a newer rescue lands before the check => 409 {"detail":"hangup was superseded"} | +2 quiescing alpha
hangup | at the pbx | a newer rescue lands after the drop => 200 {"hungup":true,"left":"alpha"} | +2 quiescing operator
model | admitted | no generation => 400 {"detail":"model change was refused: it carries no generation"} | +0 settled alpha
model | admitted | the line moved on => 409 {"detail":"model change was refused: the line moved on (the page held generation 1, the call is at 2)"} | +0 settled alpha
model | deciding | answered without a redial => 200 {"error":null,"model":"anthropic/current"} | +0 settled alpha
model | deciding | a rescue cancels the decision => 409 {"detail":"model change was cancelled"} | +1 quiescing alpha
model | deciding | the caller leaves before the rescue => 409 {"detail":"model change was superseded"} | +0 settled operator
model | rescued | the redial is delivered => 200 {"error":null,"model":"anthropic/next"} | +2 settled alpha
model | rescued | a newer rescue lands while it releases the leg => 409 {"detail":"model change was cancelled"} | +2 quiescing alpha
model | running | a newer rescue cancels the redial => 409 {"detail":"model change was cancelled"} | +2 quiescing alpha
model | running | the caller leaves before the pbx => 409 {"detail":"model change was superseded"} | +1 settled operator
thinking | admitted | no generation => 400 {"detail":"thinking change was refused: it carries no generation"} | +0 settled alpha
thinking | deciding | answered without a redial => 200 {"error":null,"thinking":"medium"} | +0 settled alpha
thinking | rescued | the redial is delivered => 200 {"error":null,"thinking":"high"} | +2 settled alpha
"#;

/// Drives one row of `PAGE_CONTROL_ROWS` on `call` and returns the answer.
#[cfg(unix)]
async fn drive_page_control(call: &AlphaCall, row: &str) -> (StatusCode, Value) {
    let state = &call.state;
    let generation = state.0.coordinator.generation();
    let (control, phase, event) = {
        let mut parts = row.split(" | ");
        (
            parts.next().unwrap(),
            parts.next().unwrap(),
            parts.next().unwrap(),
        )
    };
    let (path, body) = match control {
        "connect" => ("/connect", json!({"project": "operator"})),
        "hangup" => ("/hangup", json!({})),
        "model" => ("/model", json!({"model": "anthropic/next"})),
        "thinking" => ("/thinking", json!({"level": "high"})),
        other => panic!("no control {other}"),
    };
    let at = |mut body: Value| {
        body["generation"] = json!(generation);
        body
    };
    match (phase, event) {
        ("admitted", "no generation") => request_json(state, Method::POST, path, Some(body)).await,
        ("admitted", "the line moved on") => {
            let mut body = at(body);
            body["generation"] = json!(generation - 1);
            request_json(state, Method::POST, path, Some(body)).await
        }
        ("deciding", "answered without a redial") => {
            let body = match control {
                "model" => json!({"model": "anthropic/current"}),
                _ => json!({"level": "medium"}),
            };
            request_json(state, Method::POST, path, Some(at(body))).await
        }
        ("deciding", "a rescue cancels the decision") => {
            call.prewarm
                .settle_catalog("scriptorium", crate::prewarm::CatalogState::Pending);
            let request = post(state, path, at(body));
            until(|| call.prewarm.catalog_waiters("scriptorium") > 0).await;
            cancel_active_operations(state).await;
            within("request", request).await.unwrap()
        }
        ("deciding", "the caller leaves before the rescue") => {
            call.prewarm
                .settle_catalog("scriptorium", crate::prewarm::CatalogState::Pending);
            let request = post(state, path, at(body));
            until(|| call.prewarm.catalog_waiters("scriptorium") > 0).await;
            state.0.switchboard.lock().await.force_hangup().await;
            call.prewarm.settle_catalog(
                "scriptorium",
                crate::prewarm::CatalogState::Ready {
                    snapshot: catalog_of(&["current", "next"]),
                    degraded_reason: None,
                },
            );
            within("request", request).await.unwrap()
        }
        ("rescued", "a newer rescue lands while it releases the leg") => {
            // The control's rescue stops after it moved the generation, while
            // it waits to take the live session off the guard.
            let guard = state.0.active_session.lock().await;
            let request = post(state, path, at(body));
            until(|| state.0.coordinator.generation() != generation).await;
            state.0.coordinator.begin_rescue("a newer control");
            drop(guard);
            within("request", request).await.unwrap()
        }
        ("rescued", _) => request_json(state, Method::POST, path, Some(at(body))).await,
        ("running", "a newer rescue cancels the dial" | "a newer rescue cancels the redial") => {
            // The operation is registered at the control's rescue and waits
            // for the PBX, which the test holds.
            let board = state.0.switchboard.lock().await;
            let request = post(state, path, at(body));
            until_registered(state, generation).await;
            cancel_active_operations(state).await;
            drop(board);
            within("request", request).await.unwrap()
        }
        ("running", "the caller leaves before the pbx") => {
            // A turn holds the PBX; something queued behind it for the lock,
            // and not an operation a rescue cancels, moves the caller first.
            let turn = wedge_a_turn(state).await;
            let (queued_tx, queued_rx) = oneshot::channel();
            let mover_state = state.clone();
            let mover = tokio::spawn(async move {
                let board = mover_state.0.switchboard.lock();
                let _ = queued_tx.send(());
                // unbounded: inside the spawned mover; the row bounds `mover` itself.
                board.await.force_hangup().await
            });
            within("queued_rx", queued_rx).await.unwrap();
            let answer = request_json(state, Method::POST, path, Some(at(body))).await;
            assert!(within("turn", turn).await.unwrap_err().is_cancelled());
            within("mover", mover).await.unwrap();
            answer
        }
        ("delivering", "a newer rescue supersedes the reply") => {
            // The dial waits for the PBX; a newer rescue that cancels nothing
            // lands before it returns, so its reply is for a retired leg.
            let board = state.0.switchboard.lock().await;
            let request = post(state, path, at(body));
            until_registered(state, generation).await;
            state.0.coordinator.begin_rescue("a newer control");
            drop(board);
            within("request", request).await.unwrap()
        }
        ("at the pbx", "a newer rescue lands before the check") => {
            let board = state.0.switchboard.lock().await;
            let request = post(state, path, at(body));
            until(|| state.0.coordinator.generation() != generation).await;
            state.0.coordinator.begin_rescue("a newer control");
            drop(board);
            within("request", request).await.unwrap()
        }
        ("at the pbx", "a newer rescue lands after the drop") => {
            // The hangup has dropped alpha and waits to write its line into
            // the transcript, which the test holds.
            let transcript = state.0.transcript_log.lock().await;
            let request = post(state, path, at(body));
            until(|| state.0.coordinator.route() == OPERATOR).await;
            state.0.coordinator.begin_rescue("a newer control");
            drop(transcript);
            within("request", request).await.unwrap()
        }
        _ => panic!("no row {row}"),
    }
}

/// Posts a page control on its own task.
fn post(state: &AppState, path: &str, body: Value) -> JoinHandle<(StatusCode, Value)> {
    let state = state.clone();
    let path = path.to_owned();
    tokio::spawn(async move { request_json(&state, Method::POST, &path, Some(body)).await })
}

/// Waits, bounded, until `ready` holds.
async fn until(ready: impl Fn() -> bool) {
    timeout(Duration::from_secs(5), async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("the control reached the step the row waits for");
}

/// Waits, bounded, until a control admitted at `generation` has rescued
/// and registered its operation.
async fn until_registered(state: &AppState, generation: u64) {
    timeout(Duration::from_secs(5), async {
        while state.0.coordinator.generation() == generation
            || state.0.active_operations.lock().await.is_empty()
        {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("the control registered its operation");
}

/// The line a control left: how far the generation moved from `before`,
/// whether the call still quiesces (its activity is discarded) or has
/// settled, and the route.
fn line_after(state: &AppState, before: u64) -> String {
    let coordinator = &state.0.coordinator;
    let route = coordinator.route();
    let leg = if route == OPERATOR {
        OPERATOR.to_owned()
    } else {
        coordinator.current_identity().token
    };
    let line = match coordinator.classify_activity(&leg) {
        crate::lifecycle::ActivityDisposition::Discard => "quiescing",
        _ => "settled",
    };
    format!("+{} {line} {route}", coordinator.generation() - before)
}

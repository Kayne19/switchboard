use super::*;
use crate::app_state::AppState;
use crate::app_state::{
    assert_lifecycle_consistent, debug_events, next_event_of, scratch_root, state, state_on,
    state_with_agents, state_with_agents_options, until_debug,
};
use crate::audio::{Speaker, TestTtsGate};
use crate::browser::{frames_until, types_of};
use crate::caller_input::assert_dropped_with_notice;
use crate::delivery::Event;
use crate::hosts::{FakeHostAgent, Step};
use crate::jev::fake_jev_client;
use crate::module_calls::{diagram_show, module_call, request_to_speak};
use crate::pbx::{Switchboard, OPERATOR};
use crate::pi_client::{AgentCall, LegSession, PiSession, ProjectTurn};
use crate::registry::Registry;
use crate::router::Decision;
use crate::within;
use axum::http::StatusCode;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tokio::time::{timeout, Duration};

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
        .sender
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

#[tokio::test]
async fn a_non_steered_continue_uses_one_jev_decision_for_one_utterance() {
    let (client, requests, _responded) = fake_jev_client();
    let state = state_with_jev(client, Registry::new(vec![]));
    let mut events = state.0.events.subscribe();
    let generation = state.0.coordinator.generation();

    dispatch_routed_transcript(&state, "once", generation, "hello".into()).await;
    assert!(state
        .0
        .turns
        .routed_decisions
        .lock()
        .await
        .contains_key("once"));

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
        .turns
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
        .sender
        .send(("stale".into(), "old words".into(), old_generation))
        .await
        .expect("queued turn");

    let stale = next_event_of(&mut events, "error").await;
    assert_eq!(stale["id"], "stale");
    assert_eq!(stale["code"], "stale_epoch");
    assert!(!state
        .0
        .turns
        .routed_decisions
        .lock()
        .await
        .contains_key("stale"));

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
    within("responded", responded.notified()).await;
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
        .sender
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
    state.0.turns.routed_decisions.lock().await.insert(
        "down".into(),
        crate::router::Decision::fallback("Jev unavailable: test").into(),
    );
    state.0.queued_turns.store(1, Ordering::Release);
    let worker = tokio::spawn(process_turns(state.clone()));
    state
        .0
        .turns
        .sender
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
    let routing = tokio::spawn(async move {
        route_transcript(&routing_state, "clip-1", "caller asks about alpha").await
    });
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

    state.0.turns.routed_decisions.lock().await.insert(
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
        .sender
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

#[cfg(unix)]
#[tokio::test]
async fn a_caller_message_steers_an_autonomous_project_turn() {
    let root = scratch_root("autonomous-steer");
    let (state, host) = state_with_agents_and_jev(
        &root,
        FakeHostAgent::new(Box::new(|_, _| {
            vec![Step::Event(json!({"kind":"text","text":"Alpha here."}))]
        })),
    );
    let (_token, instance_id) = foreground_alpha_turn(&state).await;
    // A child agent exits and the session starts a run on its own.
    alpha_host_event(
        &state,
        json!({"kind":"turn_start","cause":"autonomous","turn_id":"auto-steer"}),
    );
    until_autonomous(&state, instance_id).await;
    let mut events = state.0.events.subscribe();
    let generation = state.0.coordinator.generation();

    dispatch_routed_transcript(
        &state,
        "steer-auto",
        generation,
        "what branch are you on?".into(),
    )
    .await;

    let queued = next_event_of(&mut events, "queued").await;
    assert_eq!(queued["id"], "steer-auto");
    assert_eq!(
        queued["steered"], true,
        "the message was queued, not steered"
    );
    assert_eq!(state.0.queued_turns.load(Ordering::Acquire), 0);
    assert_eq!(
        host.named("steer")
            .iter()
            .map(|args| args["message"].as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>(),
        vec!["what branch are you on?".to_owned()]
    );
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn a_turn_resumed_after_an_external_abort_can_speak() {
    let root = scratch_root("autonomous-after-abort");
    let (state, _host, token, instance_id, worker) = alpha_caller_turn_in_flight(&root).await;

    caller_turn_settles_into_a_self_woken_one(&state, "auto-resumed");

    until_autonomous(&state, instance_id).await;
    let display = module_call(
        &state,
        AgentCall {
            call: "display".into(),
            token: token.clone(),
            turn_id: Some("auto-resumed".into()),
            cause: Some("autonomous".into()),
            args: diagram_show(),
        },
    )
    .await;
    assert_eq!(display["status"], "accepted", "{display}");
    worker.abort();
    let _ = worker.await;
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn a_self_woken_start_before_the_caller_turn_settles_stays_the_callers() {
    let root = scratch_root("autonomous-before-caller-settles");
    let (state, _host, token, instance_id, worker) = alpha_caller_turn_in_flight(&root).await;

    // No settle report for the caller's turn came first, so this start
    // cannot be a run behind it: the caller's operation keeps the leg.
    alpha_host_event(
        &state,
        json!({"kind":"turn_start","cause":"autonomous","turn_id":"auto-early"}),
    );
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert!(!state
        .0
        .turns
        .autonomous_operations
        .lock()
        .await
        .contains_key(&instance_id));
    assert!(state
        .0
        .coordinator
        .accept_side_effect(&token, Some("auto-early"), Some("autonomous"))
        .is_err());
    assert!(state
        .0
        .coordinator
        .accept_side_effect(&token, Some("turn-2"), Some("input"))
        .is_ok());
    assert!(state.0.turn_in_flight.load(Ordering::Acquire));

    // The caller's turn still ends as its own.
    alpha_host_event(&state, json!({"kind":"turn_end","turn_id":"turn-2"}));
    timeout(Duration::from_secs(1), async {
        while state.0.turn_in_flight.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("the caller turn settled");
    worker.abort();
    let _ = worker.await;
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn a_caller_message_steers_a_turn_woken_as_the_caller_turn_settles() {
    let root = scratch_root("autonomous-steer-after-caller");
    let (state, host, _token, _instance_id, worker) = alpha_caller_turn_in_flight(&root).await;

    caller_turn_settles_into_a_self_woken_one(&state, "auto-woken");

    // The caller's turn is over on both sides; only the woken one runs.
    timeout(Duration::from_secs(1), async {
        while state.0.turn_in_flight.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("the caller turn settled");
    let mut events = state.0.events.subscribe();
    let generation = state.0.coordinator.generation();
    dispatch_routed_transcript(
        &state,
        "steer-woken",
        generation,
        "what branch are you on?".into(),
    )
    .await;
    assert_eq!(
        host.named("steer")
            .iter()
            .map(|args| args["message"].as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>(),
        vec!["what branch are you on?".to_owned()],
        "the message was queued behind the woken turn, not steered into it"
    );
    let queued = next_event_of(&mut events, "queued").await;
    assert_eq!(queued["id"], "steer-woken");
    assert_eq!(queued["steered"], true);
    worker.abort();
    let _ = worker.await;
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
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
    state.0.turns.routed_decisions.lock().await.insert(
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
        .sender
        .send(("caller-waits".into(), "continue alpha".into(), generation))
        .await
        .unwrap();
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert!(!state.0.turn_in_flight.load(Ordering::Acquire));
    assert!(state
        .0
        .turns
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
    state.0.turns.routed_decisions.lock().await.insert(
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
        .sender
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
    state.0.turns.routed_decisions.lock().await.insert(
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
        .sender
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

#[tokio::test]
async fn a_routed_utterance_is_traced_from_jev_to_its_turn() {
    use crate::debug::DebugEvent;
    let (client, _requests, _responded) = fake_jev_client();
    let state = state_with_jev(client, Registry::new(vec![]));
    let generation = state.0.coordinator.generation();

    dispatch_routed_transcript(&state, "clip-7", generation, "hello".into()).await;

    let events = debug_events(&state);
    assert!(matches!(
        &events[0],
        DebugEvent::CallerUtterance { utterance_id, text, .. } if utterance_id == "clip-7" && text == "hello"
    ));
    assert!(matches!(
        &events[1],
        DebugEvent::JevRequest { utterance_id: Some(id), purpose, state, floor_id: None }
            if id == "clip-7" && purpose == "route" && state["caller_just_said"] == "hello"
    ));
    let DebugEvent::JevResponse {
        utterance_id,
        purpose,
        outcome,
        answers,
        error,
        ..
    } = &events[2]
    else {
        panic!("jev_response: {:?}", events[2]);
    };
    assert_eq!(
        (utterance_id.as_deref(), purpose.as_str(), outcome.as_str()),
        (Some("clip-7"), "route", "ok")
    );
    assert_eq!(answers["action"]["choice"], "continue");
    assert_eq!(answers["action"]["probabilities"]["continue"], 1.0);
    assert!(error.is_none());
    let DebugEvent::RouteDecision {
        utterance_id,
        rule,
        reason,
        action,
        target,
        mode,
        decided_by,
    } = &events[3]
    else {
        panic!("route_decision: {:?}", events[3]);
    };
    assert_eq!(utterance_id, "clip-7");
    assert_eq!(rule, "jev_action");
    assert!(
        reason.contains("action_conf=1.000 >= threshold 0.600"),
        "{reason}"
    );
    assert_eq!(
        (action.as_str(), target, mode.as_str(), decided_by.as_str()),
        ("continue", &None, "not_applicable", "jev")
    );

    // The queued turn starts and ends under the same utterance, and the PBX
    // records the branch it took.
    let worker = tokio::spawn(process_turns(state.clone()));
    let started = until_debug(&state, |event| {
        matches!(event, DebugEvent::TurnStart { .. })
    })
    .await;
    assert_eq!(
        started,
        DebugEvent::TurnStart {
            agent: OPERATOR.into(),
            turn_id: "clip-7".into(),
            generation,
            utterance_id: Some("clip-7".into()),
        }
    );
    let branch = until_debug(&state, |event| {
        matches!(event, DebugEvent::PbxBranch { .. })
    })
    .await;
    assert!(matches!(
        branch,
        DebugEvent::PbxBranch { ref utterance_id, ref branch, .. }
            if utterance_id == "clip-7" && branch == "operator"
    ));
    until_debug(&state, |event| {
        matches!(event, DebugEvent::TurnEnd { turn_id, utterance_id: Some(id), .. } if turn_id == "clip-7" && id == "clip-7")
    })
    .await;
    worker.abort();
    let _ = worker.await;
}

#[tokio::test]
async fn an_unavailable_jev_is_traced_as_the_fallback_rule() {
    use crate::debug::DebugEvent;
    let client = crate::jev::JevClient::new(
        "http://unused.invalid/v1/systemone",
        "/nonexistent/typesafe-api-key",
        Duration::from_secs(1),
    )
    .expect("client")
    .with_test_responder(|_| async {
        Err(crate::jev::JevError::Http {
            status: 503,
            body: "down".into(),
        })
    });
    let state = state_with_jev(client, Registry::new(vec![]));

    route_transcript(&state, "clip-8", "hello").await;

    let events = debug_events(&state);
    assert!(matches!(
        &events[1],
        DebugEvent::JevResponse { outcome, error: Some(error), answers, .. }
            if outcome == "error" && error.contains("503") && *answers == json!({})
    ));
    assert!(matches!(
        &events[2],
        DebugEvent::RouteDecision { rule, decided_by, reason, .. }
            if rule == "jev_unavailable" && decided_by == "fallback" && reason.contains("Jev unavailable")
    ));
}

#[tokio::test]
async fn a_stale_routed_utterance_ends_its_trace() {
    let (client, _requests, _responded) = fake_jev_client();
    let state = state_with_jev(client, Registry::new(vec![]));
    let stamped = state.0.coordinator.generation();
    state.0.coordinator.begin_rescue("test rescue");

    dispatch_routed_transcript(&state, "clip-9", stamped, "hello".into()).await;

    let last = debug_events(&state).pop().expect("events");
    assert!(
        matches!(
        last,
        crate::debug::DebugEvent::PbxBranch { ref utterance_id, ref branch, ref reason }
            if utterance_id == "clip-9" && branch == "dropped_stale" && reason.contains(&format!("stamped generation {stamped}"))
        ),
        "{last:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn an_autonomous_project_turn_is_traced_with_its_host_turn_id() {
    use crate::debug::DebugEvent;
    let root = scratch_root("autonomous-traced");
    let state = state_with_agents(&root);
    let (token, instance_id) = foreground_alpha_turn(&state).await;
    let generation = state.0.coordinator.generation();
    handle_project_turn(
        &state,
        autonomous_turn(token.clone(), instance_id, Some("auto-7")),
    )
    .await;
    handle_project_turn(
        &state,
        ProjectTurn {
            ended: true,
            ..autonomous_turn(token, instance_id, Some("auto-7"))
        },
    )
    .await;

    let turns: Vec<_> = debug_events(&state)
        .into_iter()
        .filter(|event| {
            matches!(
                event,
                DebugEvent::TurnStart { .. } | DebugEvent::TurnEnd { .. }
            )
        })
        .collect();
    assert_eq!(
        turns,
        vec![
            DebugEvent::TurnStart {
                agent: "alpha".into(),
                turn_id: "auto-7".into(),
                generation,
                utterance_id: None,
            },
            DebugEvent::TurnEnd {
                agent: "alpha".into(),
                turn_id: "auto-7".into(),
                generation,
                utterance_id: None,
            },
        ]
    );
    state.0.switchboard.lock().await.shutdown().await;
    let _ = std::fs::remove_dir_all(root);
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

/// A pi stand-in that answers every prompt with `reply`.
#[cfg(unix)]
fn failing_agent(root: &std::path::Path) -> std::path::PathBuf {
    let path = root.join("failing-pi");
    crate::pi_client::write_executable_script(&path, "exit 1");
    path
}

fn state_with_agents_spoken_speaker(root: &std::path::Path, speaker: Speaker) -> AppState {
    state_with_agents_options(root, speaker, true)
}

/// Sends a session event from alpha's host agent on its own, as the host
/// does when the daemon starts or settles a run no command caused.
#[cfg(unix)]
fn alpha_host_event(state: &AppState, event: Value) {
    state.0.hosts.send_fake(
        "scriptorium",
        json!({"type": "event", "session": "s1", "cursor": "external", "event": event}),
    );
}

/// Waits until the API has opened an autonomous operation for `instance_id`.
#[cfg(unix)]
async fn until_autonomous(state: &AppState, instance_id: u64) {
    timeout(Duration::from_secs(1), async {
        while !state
            .0
            .turns
            .autonomous_operations
            .lock()
            .await
            .contains_key(&instance_id)
        {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("the autonomous turn was admitted");
}

/// The host settles the caller's turn and, at once, opens one nobody caused:
/// the run the caller resumed in the TUI after aborting it (#109), or the
/// wake a child agent's exit queued behind the caller's turn (#107). Both
/// frames reach the session before the service has seen the prompt return.
#[cfg(unix)]
fn caller_turn_settles_into_a_self_woken_one(state: &AppState, turn_id: &str) {
    alpha_host_event(state, json!({"kind":"turn_end","turn_id":"turn-2"}));
    alpha_host_event(
        state,
        json!({"kind":"turn_start","cause":"autonomous","turn_id":turn_id}),
    );
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

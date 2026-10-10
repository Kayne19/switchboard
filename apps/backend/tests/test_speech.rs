use super::*;
use crate::app_state::{debug_events, state, AppState};
use crate::audio::{Speaker, SttAdapter, SttStreamAdapter, TestTtsGate, TtsContinuity};
use crate::browser::frame_json;
use crate::caller_input::route_final_transcript;
use crate::delivery::{DeliveryConnection, DeliveryFrame, Event};
use crate::history::TranscriptLog;
use crate::module_calls::agent_call_json;
use crate::page_controls::cancel_active_operations;
use crate::pbx::{Switchboard, OPERATOR};
use crate::registry::Registry;
use crate::within;
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
    assert!(within("first", first).await.unwrap().is_err());
    assert!(within("second", second).await.unwrap().is_ok());
    let settled = state.0.continuity_snapshot();
    assert_eq!(settled.last_text.as_deref(), Some("same line"));
    assert!(settled.pending_text.is_none());
    assert!(settled.pending_sequence.is_none());
}

/// A rescue (hang up, a model change, a new connection) stops the speech it
/// retires on purpose. The agent that asked for it learns it was not spoken,
/// but the caller's page shows no error for it.
#[tokio::test]
async fn speech_a_rescue_stops_is_not_shown_to_the_caller_as_an_error() {
    let config = crate::Config::for_tests(&[]);
    let registry = Registry::new(vec![]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("no projects are registered"),
    );
    let gate = TestTtsGate::new();
    let state = AppState::new(
        Switchboard::new(&config, registry, std::sync::Arc::new(prewarm)),
        TranscriptLog::new(10),
        Speaker::test_gated(100, Duration::from_millis(25_000), gate.clone()),
        SttAdapter::from_command(None),
        SttStreamAdapter::from_command(None),
    );
    let (_connection, _, _) = state.register_connection().await;
    start_speech_worker_for_test(&state);
    let mut events = state.0.events.subscribe();
    let generation = state.0.coordinator.generation();
    let group = state.0.new_speech_group();
    let admission = |text: &str, scope| SpeechAdmission {
        text: text.into(),
        route: OPERATOR.into(),
        generation,
        deadline: std::time::Instant::now() + Duration::from_secs(1),
        scope,
        group,
        log_spoken: false,
    };
    let speaking = tokio::spawn({
        let state = state.clone();
        let admission = admission("The first sentence.", ContinuationScope::FreshTurn);
        async move { queue_speech(&state, admission, None).await }
    });
    timeout(Duration::from_secs(1), gate.wait_started())
        .await
        .expect("the speech started");

    cancel_active_operations(&state).await;
    gate.release();
    // The reply's next sentence, queued under the generation the rescue
    // retired.
    let queued = queue_speech(
        &state,
        admission(
            "The second sentence.",
            ContinuationScope::ContinueCurrentTurn,
        ),
        None,
    )
    .await;

    assert!(
        within("speaking", speaking).await.unwrap().is_err(),
        "cancelled speech reports that it was not spoken"
    );
    assert!(
        queued.is_err(),
        "superseded speech reports that it was not spoken"
    );
    while let Ok(event) = events.try_recv() {
        if let Event::Json(value) = event {
            assert_ne!(
                value["type"], "error",
                "a rescue's cancellation reached the page as an error: {value}"
            );
        }
    }
}

/// What happens to a speech request on its way through the worker, for the
/// completion table below.
#[derive(Clone, Copy, Debug)]
enum SpeechEvent {
    /// A rescue retires the generation after the request's place was
    /// reserved, before the worker admits it.
    RetiredBeforeAdmission,
    /// The provider refuses the request when it is admitted.
    ProviderRefuses,
    /// A rescue retires the generation and aborts the drain.
    RescueDuringDrain,
    /// The generation moves on while the body drains; nothing is aborted.
    RetiredDuringDrain,
    /// The provider's body fails partway.
    BodyFails,
    /// The body drains to its end with a browser connected.
    BodyDrained,
    /// The body drains to its end with no browser connected.
    BodyDrainedNoBrowser,
}

/// What a speech request's completion did, as seen from outside the worker.
#[derive(Debug, PartialEq, Eq)]
struct SpeechCompletion {
    /// What the requester (`speak`, a reply, a floor release) was answered.
    answer: Result<(), String>,
    /// The caller's page was sent an `error`.
    page_error: bool,
    /// The line was written to the spoken transcript and sent as `spoken`.
    spoken_line: bool,
    /// The request's audio slot is still open, holding back later audio.
    slot_left_open: bool,
    /// The request's text is still pending continuity for the next request.
    pending_text_left: bool,
}

/// Runs one speech request through the real worker to `event` and reports
/// what its completion did.
async fn complete_one_request(event: SpeechEvent, log_spoken: bool) -> SpeechCompletion {
    let config = crate::Config::for_tests(&[]);
    let registry = Registry::new(vec![]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("no projects are registered"),
    );
    let gate = TestTtsGate::new();
    let deadline = Duration::from_millis(25_000);
    let speaker = match event {
        SpeechEvent::ProviderRefuses => Speaker::offline(100, deadline),
        SpeechEvent::RetiredBeforeAdmission
        | SpeechEvent::BodyDrained
        | SpeechEvent::BodyDrainedNoBrowser => Speaker::test_success(100, deadline),
        SpeechEvent::RescueDuringDrain
        | SpeechEvent::RetiredDuringDrain
        | SpeechEvent::BodyFails => Speaker::test_gated(100, deadline, gate.clone()),
    };
    if matches!(event, SpeechEvent::BodyFails) {
        gate.fail_first();
    }
    let state = AppState::new(
        Switchboard::new(&config, registry, std::sync::Arc::new(prewarm)),
        TranscriptLog::new(10),
        speaker,
        SttAdapter::from_command(None),
        SttStreamAdapter::from_command(None),
    );
    let _connection = match event {
        SpeechEvent::BodyDrainedNoBrowser => None,
        _ => Some(state.register_connection().await),
    };
    start_speech_worker_for_test(&state);
    let mut events = state.0.events.subscribe();
    let generation = state.0.coordinator.generation();
    let admission = SpeechAdmission {
        text: "One line.".into(),
        route: OPERATOR.into(),
        generation,
        deadline: std::time::Instant::now() + Duration::from_secs(1),
        scope: ContinuationScope::FreshTurn,
        group: state.0.new_speech_group(),
        log_spoken,
    };
    let reserved = reserve_speech(
        &state,
        SpeakUnder::Generation(generation),
        WhenQueueFull::Wait,
    )
    .await
    .unwrap_or_else(|failure| panic!("the request gets a place: {failure}"));
    if matches!(event, SpeechEvent::RetiredBeforeAdmission) {
        state.0.coordinator.begin_rescue("test rescue");
    }
    // `send_speech` borrows the place it is given, so the request is sent
    // from this task while the event is driven beside it.
    let drive = async {
        match event {
            SpeechEvent::RescueDuringDrain
            | SpeechEvent::RetiredDuringDrain
            | SpeechEvent::BodyFails => {
                timeout(Duration::from_secs(1), gate.wait_started())
                    .await
                    .expect("the drain started");
                match event {
                    SpeechEvent::RescueDuringDrain => {
                        cancel_active_operations(&state).await;
                    }
                    SpeechEvent::RetiredDuringDrain => {
                        state.0.coordinator.begin_rescue("test rescue");
                    }
                    _ => {}
                }
                gate.release();
            }
            _ => {}
        }
    };
    let (answer, ()) = within(
        "the request's answer",
        futures_util::future::join(send_speech(&state, admission, reserved), drive),
    )
    .await;
    // Whatever the completion does after it answers happens before the
    // completion task next yields.
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    let mut page_error = false;
    let mut spoken_line = false;
    while let Ok(event) = events.try_recv() {
        if let Event::Json(value) = event {
            page_error |= value["type"] == "error";
            spoken_line |= value["type"] == "spoken";
        }
    }
    let slot_left_open = !state.0.audio.lock().await.slots.is_empty();
    SpeechCompletion {
        answer: answer.map_err(|failure| failure.to_string()),
        page_error,
        spoken_line,
        slot_left_open,
        pending_text_left: state.0.continuity_snapshot().pending_text.is_some(),
    }
}

/// The speech request's phase × event table (#385): every way the worker
/// can end a request, and what its one completion does. A rescue's ends
/// are answered as not spoken and kept off the page (#247); a provider
/// failure at the current generation is shown; every end closes the
/// request's audio slot and leaves none of its text pending.
#[tokio::test]
async fn every_end_of_a_speech_request_completes_it_once() {
    struct Row {
        phase: &'static str,
        event: SpeechEvent,
        log_spoken: bool,
        answer: Result<(), &'static str>,
        page_error: bool,
        spoken_line: bool,
    }
    let superseded = "speech generation was superseded";
    let rows = [
        Row {
            phase: "queued",
            event: SpeechEvent::RetiredBeforeAdmission,
            log_spoken: true,
            answer: Err(superseded),
            page_error: false,
            spoken_line: false,
        },
        Row {
            phase: "admitting",
            event: SpeechEvent::ProviderRefuses,
            log_spoken: true,
            answer: Err("tests do not reach ElevenLabs"),
            page_error: true,
            spoken_line: false,
        },
        Row {
            phase: "draining",
            event: SpeechEvent::RescueDuringDrain,
            log_spoken: true,
            answer: Err("speech was cancelled"),
            page_error: false,
            spoken_line: false,
        },
        Row {
            phase: "draining",
            event: SpeechEvent::RetiredDuringDrain,
            log_spoken: true,
            answer: Err(superseded),
            page_error: false,
            spoken_line: false,
        },
        Row {
            phase: "draining",
            event: SpeechEvent::BodyFails,
            log_spoken: true,
            answer: Err("gated test failure"),
            page_error: true,
            spoken_line: false,
        },
        Row {
            phase: "draining",
            event: SpeechEvent::BodyDrained,
            log_spoken: true,
            answer: Ok(()),
            page_error: false,
            spoken_line: true,
        },
        Row {
            phase: "draining",
            event: SpeechEvent::BodyDrained,
            log_spoken: false,
            answer: Ok(()),
            page_error: false,
            spoken_line: false,
        },
        Row {
            phase: "draining",
            event: SpeechEvent::BodyDrainedNoBrowser,
            log_spoken: true,
            answer: Err("no browser connected or the writer rejected audio"),
            page_error: false,
            spoken_line: false,
        },
    ];
    for row in rows {
        let observed = complete_one_request(row.event, row.log_spoken).await;
        assert_eq!(
            observed,
            SpeechCompletion {
                answer: row.answer.map_err(str::to_owned),
                page_error: row.page_error,
                spoken_line: row.spoken_line,
                slot_left_open: false,
                pending_text_left: false,
            },
            "{} x {:?} (log_spoken: {})",
            row.phase,
            row.event,
            row.log_spoken,
        );
    }
}

#[tokio::test]
async fn final_response_barrier_is_emitted_once_after_a_settled_turn() {
    let state = state();
    let mut events = state.0.events.subscribe();
    let generation = state.0.coordinator.generation();
    let reply = crate::reply::Reply {
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
    let reply = crate::reply::Reply {
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

// `SWITCHBOARD_HISTORY_LIMIT=0` keeps no line for a reload; it does not stop
// a line reaching the live page (#293).
#[tokio::test]
async fn a_log_that_keeps_nothing_still_sends_every_spoken_line() {
    let state = speaking_state_keeping(0);
    let (mut connection, _, _) = state.register_connection().await;

    let (code, _) = agent_call_json(&state, "/speak", json!({"text": "From the agent."})).await;
    assert_eq!(code, StatusCode::OK);
    let frames = wire_frames_until(&mut connection, "spoken").await;
    let spoken = frames.last().expect("a spoken frame");
    assert_eq!(spoken["entry"]["text"], "From the agent.", "{frames:#?}");

    let generation = state.0.coordinator.generation();
    let reply = voiced_reply("Putting you through.", &["Putting you through."]);
    assert!(deliver_page_reply_if_current(&state, &reply, generation).await);
    let frames = wire_frames_until(&mut connection, "spoken").await;
    let spoken = frames.last().expect("a spoken frame");
    assert_eq!(
        spoken["entry"]["text"], "Putting you through.",
        "{frames:#?}"
    );

    assert!(state.0.transcript_log.lock().await.entries().is_empty());
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

    assert!(!within("delivery", delivery).await.unwrap());
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
    let reply = crate::reply::Reply {
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
async fn a_stale_reply_is_traced_as_speech_not_delivered() {
    let state = state();
    let generation = state.0.coordinator.generation();
    state.0.coordinator.begin_rescue("test rescue");
    let reply = crate::reply::Reply {
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
    speaking_state_keeping(10)
}

/// `speaking_state`, its transcript log keeping `limit` entries.
fn speaking_state_keeping(limit: usize) -> AppState {
    let config = crate::Config::for_tests(&[]);
    let registry = Registry::new(vec![]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("no projects are registered"),
    );
    let state = AppState::new(
        Switchboard::new(&config, registry, std::sync::Arc::new(prewarm)),
        TranscriptLog::new(limit),
        Speaker::test_success(100, Duration::from_millis(25_000)),
        SttAdapter::from_command(None),
        SttStreamAdapter::from_command(None),
    );
    start_speech_worker_for_test(&state);
    state
}

fn voiced_reply(text: &str, to_speak: &[&str]) -> crate::reply::Reply {
    crate::reply::Reply {
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

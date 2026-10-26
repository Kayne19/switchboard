use super::*;
use crate::app_state::{begin_alpha_candidate, debug_events, state, AppState};
use crate::audio::{Speaker, SttAdapter, SttStreamAdapter, TestTtsGate, TtsContinuity};
use crate::browser::frame_json;
use crate::browser::PageFeed;
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
    timeout(Duration::from_secs(1), gate.wait_until_read())
        .await
        .expect("first gated drain started");
    let second = tokio::spawn({
        let state = state.clone();
        let admission = admission(ContinuationScope::ContinueCurrentTurn);
        async move { queue_speech(&state, admission, None).await }
    });
    timeout(Duration::from_secs(1), gate.wait_until_read())
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
    let mut events = PageFeed::open(&state);
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
    timeout(Duration::from_secs(1), gate.wait_until_read())
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

/// What the page was sent of each utterance's audio, in order: `start`,
/// `chunk` and `done`, each start and done with its sequence and generation.
fn audio_sent(connection: &mut DeliveryConnection) -> Vec<String> {
    std::iter::from_fn(|| connection.receiver.try_recv().ok())
        .filter_map(|frame| match frame {
            DeliveryFrame::Event { event, .. } => match event {
                Event::AudioStart {
                    generation,
                    sequence,
                    ..
                } => Some(format!("start {sequence} (leg {generation})")),
                Event::AudioChunk { .. } => Some("chunk".to_owned()),
                Event::AudioDone {
                    generation,
                    sequence,
                } => Some(format!("done {sequence} (leg {generation})")),
                Event::Json(_) => None,
            },
            DeliveryFrame::Message(_) => None,
        })
        .collect()
}

/// Kayne's decision on #437 (2026-10-11): at a hand-off (a transfer's
/// adoption), what the old leg is already saying finishes, and the new
/// leg's speech plays after it. It is not cut off.
#[tokio::test]
async fn the_new_legs_speech_waits_for_what_the_old_leg_is_already_saying() {
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
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    start_speech_worker_for_test(&state);
    let admission = |text: &str, generation: u64| SpeechAdmission {
        text: text.into(),
        route: OPERATOR.into(),
        generation,
        deadline: std::time::Instant::now() + Duration::from_secs(5),
        scope: ContinuationScope::FreshTurn,
        group: state.0.new_speech_group(),
        log_spoken: false,
    };
    let old = state.0.coordinator.generation();
    let saying = async {
        let reserved = reserve_speech(&state, SpeakUnder::Generation(old), WhenQueueFull::Wait)
            .await
            .unwrap_or_else(|failure| panic!("the request gets a place: {failure}"));
        send_speech(&state, admission("Putting you through.", old), reserved).await
    };
    let handed_off = async {
        within("the old leg's speech starts", gate.wait_until_read()).await;
        begin_alpha_candidate(&state, "alpha-leg");
        state
            .0
            .coordinator
            .adopt_candidate("alpha-leg")
            .expect("the candidate is adopted");
        let new = state.0.coordinator.generation();
        let reserved = reserve_speech(&state, SpeakUnder::Generation(new), WhenQueueFull::Wait)
            .await
            .unwrap_or_else(|failure| panic!("the request gets a place: {failure}"));
        gate.release();
        let intro = send_speech(&state, admission("Alpha here.", new), reserved);
        let released = async {
            within("the new leg's speech starts", gate.wait_until_read()).await;
            gate.release();
        };
        (futures_util::future::join(intro, released).await.0, new)
    };
    let (said, (intro, new)) = within(
        "both utterances",
        futures_util::future::join(saying, handed_off),
    )
    .await;

    let answer = |sent: Result<Played, SpeechFailure>| sent.map_err(|failure| failure.to_string());
    assert_eq!(
        answer(said),
        Ok(Played::Whole),
        "the old leg's utterance was cut off"
    );
    assert_eq!(answer(intro), Ok(Played::Whole));
    assert_eq!(
        audio_sent(&mut connection),
        [
            format!("start 0 (leg {old})"),
            "chunk".to_owned(),
            format!("done 0 (leg {old})"),
            format!("start 1 (leg {new})"),
            "chunk".to_owned(),
            format!("done 1 (leg {new})"),
        ]
    );
}

/// What happens to a speech request on its way through the worker, for the
/// completion table below.
#[derive(Clone, Copy, Debug)]
enum SpeechEvent {
    /// A rescue retires the generation after the request's place was
    /// reserved, before the worker admits it.
    RetiredBeforeAdmission,
    /// The call adopts a new leg after the request's place was reserved,
    /// before the worker admits it: nothing new is said under the leg the
    /// call has left.
    HandedOffBeforeAdmission,
    /// The provider refuses the request when it is admitted.
    ProviderRefuses,
    /// A rescue retires the generation and aborts the drain.
    RescueDuringDrain,
    /// The call adopts a new leg while the body drains (a hand-off, as a
    /// transfer's adoption is): nothing is aborted, and the utterance
    /// already streaming finishes before the new leg's speech (#437).
    HandedOffDuringDrain,
    /// The same, for an utterance queued behind another one's audio, so
    /// none of its own has reached the page yet: it is not said, as nothing
    /// new from the old leg is after a hand-off (#437).
    HandedOffBeforeHeard,
    /// The same, for an utterance whose start went out when the audio ahead
    /// of it closed: the page has some of it, so it finishes (#424, #526).
    HandedOffAfterItsStartWentOut,
    /// The same, but the audio ahead closes after the hand-off, so this
    /// utterance's start goes out under a leg the page has left.
    HandedOffBeforeItsStartWentOut,
    /// The body drains to its end behind another utterance's open audio,
    /// and the call adopts a new leg before that audio closes.
    HandedOffWhileHeld,
    /// The same, and the audio ahead closes right after the hand-off.
    HandedOffWhileHeldThenAheadCloses,
    /// The provider's body fails partway.
    BodyFails,
    /// The speech deadline cuts the body after its first audio went out.
    CutByDeadline,
    /// The same, with no browser connected.
    CutByDeadlineNoBrowser,
    /// The body drains to its end with a browser connected.
    BodyDrained,
    /// The body drains to its end with no browser connected.
    BodyDrainedNoBrowser,
}

/// What a speech request's completion did, as seen from outside the worker.
#[derive(Debug, PartialEq, Eq)]
struct SpeechCompletion {
    /// What the requester (`speak`, a reply, a floor release) was answered.
    answer: Result<Played, String>,
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
        SpeechEvent::CutByDeadline | SpeechEvent::CutByDeadlineNoBrowser => {
            Speaker::test_cut_by_deadline(100, deadline)
        }
        SpeechEvent::RetiredBeforeAdmission
        | SpeechEvent::HandedOffBeforeAdmission
        | SpeechEvent::BodyDrained
        | SpeechEvent::BodyDrainedNoBrowser => Speaker::test_success(100, deadline),
        SpeechEvent::RescueDuringDrain
        | SpeechEvent::HandedOffDuringDrain
        | SpeechEvent::HandedOffBeforeHeard
        | SpeechEvent::HandedOffAfterItsStartWentOut
        | SpeechEvent::HandedOffBeforeItsStartWentOut
        | SpeechEvent::HandedOffWhileHeld
        | SpeechEvent::HandedOffWhileHeldThenAheadCloses
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
    // The page, when there is one: what it is sent is what the row reads.
    let mut page = match event {
        SpeechEvent::BodyDrainedNoBrowser | SpeechEvent::CutByDeadlineNoBrowser => None,
        _ => Some(state.register_connection().await.0),
    };
    start_speech_worker_for_test(&state);
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
    // Another utterance's audio holds the page ahead of this one's.
    let ahead = if matches!(
        event,
        SpeechEvent::HandedOffBeforeHeard
            | SpeechEvent::HandedOffAfterItsStartWentOut
            | SpeechEvent::HandedOffBeforeItsStartWentOut
            | SpeechEvent::HandedOffWhileHeld
            | SpeechEvent::HandedOffWhileHeldThenAheadCloses
    ) {
        Some(state.0.audio.lock().await.reserve(generation))
    } else {
        None
    };
    let reserved = reserve_speech(
        &state,
        SpeakUnder::Generation(generation),
        WhenQueueFull::Wait,
    )
    .await
    .unwrap_or_else(|failure| panic!("the request gets a place: {failure}"));
    let hand_off = || {
        begin_alpha_candidate(&state, "alpha-leg");
        state
            .0
            .coordinator
            .adopt_candidate("alpha-leg")
            .expect("the candidate is adopted");
    };
    if matches!(event, SpeechEvent::RetiredBeforeAdmission) {
        state.0.coordinator.begin_rescue("test rescue");
    }
    if matches!(event, SpeechEvent::HandedOffBeforeAdmission) {
        hand_off();
    }
    // `send_speech` borrows the place it is given, so the request is sent
    // from this task while the event is driven beside it.
    let drive = async {
        match event {
            SpeechEvent::RescueDuringDrain
            | SpeechEvent::HandedOffDuringDrain
            | SpeechEvent::HandedOffBeforeHeard
            | SpeechEvent::HandedOffAfterItsStartWentOut
            | SpeechEvent::HandedOffBeforeItsStartWentOut
            | SpeechEvent::HandedOffWhileHeld
            | SpeechEvent::HandedOffWhileHeldThenAheadCloses
            | SpeechEvent::BodyFails => {
                timeout(Duration::from_secs(1), gate.wait_until_read())
                    .await
                    .expect("the drain started");
                match event {
                    SpeechEvent::RescueDuringDrain => {
                        cancel_active_operations(&state).await;
                        gate.release();
                    }
                    SpeechEvent::HandedOffDuringDrain | SpeechEvent::HandedOffBeforeHeard => {
                        hand_off();
                        gate.release();
                    }
                    SpeechEvent::HandedOffAfterItsStartWentOut => {
                        let ahead = ahead.expect("an utterance holds the page");
                        finish_audio(&state, ahead, generation).await;
                        hand_off();
                        gate.release();
                    }
                    SpeechEvent::HandedOffBeforeItsStartWentOut => {
                        let ahead = ahead.expect("an utterance holds the page");
                        hand_off();
                        finish_audio(&state, ahead, generation).await;
                        gate.release();
                    }
                    SpeechEvent::HandedOffWhileHeld => {
                        gate.release();
                        body_read_to_its_end(&state, "One line.").await;
                        hand_off();
                    }
                    SpeechEvent::HandedOffWhileHeldThenAheadCloses => {
                        let ahead = ahead.expect("an utterance holds the page");
                        gate.release();
                        body_read_to_its_end(&state, "One line.").await;
                        hand_off();
                        finish_audio(&state, ahead, generation).await;
                    }
                    _ => gate.release(),
                }
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
    if let Some(ahead) = ahead {
        finish_audio(&state, ahead, generation).await;
    }
    let sent = page
        .as_mut()
        .map(crate::browser::queued_frames)
        .unwrap_or_default();
    let page_error = sent.iter().any(|frame| frame["type"] == "error");
    let spoken_line = sent.iter().any(|frame| frame["type"] == "spoken");
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
        answer: Result<Played, &'static str>,
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
            phase: "queued",
            event: SpeechEvent::HandedOffBeforeAdmission,
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
            event: SpeechEvent::HandedOffDuringDrain,
            log_spoken: true,
            answer: Ok(Played::Whole),
            page_error: false,
            spoken_line: true,
        },
        Row {
            phase: "draining",
            event: SpeechEvent::HandedOffBeforeHeard,
            log_spoken: true,
            answer: Err(superseded),
            page_error: false,
            spoken_line: false,
        },
        Row {
            phase: "draining",
            event: SpeechEvent::HandedOffAfterItsStartWentOut,
            log_spoken: true,
            answer: Ok(Played::Whole),
            page_error: false,
            spoken_line: true,
        },
        Row {
            phase: "draining",
            event: SpeechEvent::HandedOffBeforeItsStartWentOut,
            log_spoken: true,
            answer: Err(superseded),
            page_error: false,
            spoken_line: false,
        },
        Row {
            phase: "draining",
            event: SpeechEvent::HandedOffWhileHeld,
            log_spoken: true,
            answer: Err(superseded),
            page_error: false,
            spoken_line: false,
        },
        Row {
            phase: "draining",
            event: SpeechEvent::HandedOffWhileHeldThenAheadCloses,
            log_spoken: true,
            answer: Err(superseded),
            page_error: false,
            spoken_line: false,
        },
        Row {
            phase: "draining",
            event: SpeechEvent::CutByDeadline,
            log_spoken: true,
            answer: Ok(Played::CutShort),
            page_error: false,
            spoken_line: true,
        },
        Row {
            phase: "draining",
            event: SpeechEvent::CutByDeadlineNoBrowser,
            log_spoken: true,
            answer: Err("speech deadline expired"),
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
            answer: Ok(Played::Whole),
            page_error: false,
            spoken_line: true,
        },
        Row {
            phase: "draining",
            event: SpeechEvent::BodyDrained,
            log_spoken: false,
            answer: Ok(Played::Whole),
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
    let mut events = PageFeed::open(&state);
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
    let mut events = PageFeed::open(&state);
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
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
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

    assert!(deliver_page_reply_if_current(&state, &reply, generation, Quiet::End).await);

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
    assert!(deliver_page_reply_if_current(&state, &reply, generation, Quiet::End).await);
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
    let mut events = PageFeed::open(&state);
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

    assert!(!deliver_page_reply_if_current(&state, &reply, generation, Quiet::End).await);
    assert!(state.0.transcript_log.lock().await.entries().is_empty());
    assert!(matches!(
        events.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
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

async fn body_read_to_its_end(state: &AppState, text: &str) {
    within("the body is read to its end", async {
        while state.0.continuity_snapshot().last_text.as_deref() != Some(text) {
            tokio::task::yield_now().await;
        }
    })
    .await;
}

#[tokio::test]
async fn speech_held_behind_an_open_slot_is_answered_as_spoken() {
    let state = speaking_state();
    let (mut connection, _snapshot, _watermark) = state.register_connection().await;
    let generation = state.0.coordinator.generation();
    let ahead = state.0.audio.lock().await.reserve(generation);
    let reserved = reserve_speech(
        &state,
        SpeakUnder::Generation(generation),
        WhenQueueFull::Wait,
    )
    .await
    .unwrap_or_else(|failure| panic!("the request gets a place: {failure}"));
    let later = reserved.sequence;
    let admission = SpeechAdmission {
        text: "The later line.".into(),
        route: OPERATOR.into(),
        generation,
        deadline: std::time::Instant::now() + Duration::from_secs(5),
        scope: ContinuationScope::FreshTurn,
        group: state.0.new_speech_group(),
        log_spoken: false,
    };
    let earlier_ends = async {
        body_read_to_its_end(&state, "The later line.").await;
        finish_audio(&state, ahead, generation).await;
    };
    let (answer, ()) = within(
        "the later line's answer",
        futures_util::future::join(send_speech(&state, admission, reserved), earlier_ends),
    )
    .await;
    let sent = audio_sent(&mut connection);
    assert_eq!(
        sent,
        [
            format!("start {ahead} (leg {generation})"),
            format!("done {ahead} (leg {generation})"),
            format!("start {later} (leg {generation})"),
            "chunk".to_owned(),
            format!("done {later} (leg {generation})"),
        ],
        "the later line's audio reached the page behind the earlier one"
    );
    assert_eq!(
        answer.map_err(|failure| failure.to_string()),
        Ok(Played::Whole),
        "the later line played, but its requester was told it was not delivered"
    );
}

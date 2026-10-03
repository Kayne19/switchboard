use super::*;
use crate::api::{
    begin_alpha_candidate, next_event_of, state, state_with_stream, state_with_stt, AppState,
};
use crate::browser::{frames_until, handle_text_frame, next_delivery, types_of};
use crate::delivery::{DeliveryConnection, Event};
use crate::pi_client::{LegSession, PiSession};
use crate::protocol::ServerMessage;
use crate::turns::process_turns;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};

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

#[test]
fn clip_headers_carry_an_optional_capture_epoch() {
    let header = |value: Value| match crate::protocol::ClientMessage::parse(&value.to_string()) {
        Ok(crate::protocol::ClientMessage::Clip {
            id,
            mime,
            generation,
        }) => parse_clip_header(id, mime, generation),
        other => panic!("{value} is not a clip header: {other:?}"),
    };

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

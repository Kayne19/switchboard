//! What the caller says, from the browser's frame to a logged transcript:
//! complete clips and the clip worker's transcription, streamed clips and
//! their results, typed turns, and the verdict each clip is settled with.
use crate::app_state::emit_message;
use crate::app_state::AppState;
use crate::audio::StreamResult;
use crate::browser::send_message;
use crate::history::CALLER;
use crate::protocol::{ErrorCode, ServerMessage};
use crate::turns::dispatch_routed_transcript;
#[cfg(test)]
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use tokio::sync::{mpsc, Mutex};
use tracing::Instrument;

/// How many settled clips `ClipVerdicts` remembers; the same bound as the
/// accepted-clip window, so a clip the server still recognizes as a
/// duplicate is one it can still answer.
const REMEMBERED_CLIP_VERDICTS: usize = 512;

/// The message that settled each recent clip: its transcript, or the error
/// that ended it.
///
/// A verdict goes to whichever connection is registered when it is known. If
/// the tab is down at that moment it is lost, and the browser, still holding
/// the clip, sends it again after the reconnect. The server keeps the first
/// stamp it saw for a clip id, so without this the resend would be taken as
/// the clip it already has and never answered (#71). With it, the resend is
/// answered with the verdict instead.
#[derive(Default)]
pub(crate) struct ClipVerdicts {
    by_id: HashMap<String, ServerMessage>,
    oldest_first: VecDeque<String>,
}

impl ClipVerdicts {
    /// Records `verdict` as the last word on `id`, replacing an earlier one:
    /// a transcript can be followed by a `stale_epoch` from turn dispatch.
    fn record(&mut self, id: &str, verdict: ServerMessage) {
        if self.by_id.insert(id.to_owned(), verdict).is_none() {
            self.oldest_first.push_back(id.to_owned());
            while self.oldest_first.len() > REMEMBERED_CLIP_VERDICTS {
                if let Some(old) = self.oldest_first.pop_front() {
                    self.by_id.remove(&old);
                }
            }
        }
    }

    fn get(&self, id: &str) -> Option<ServerMessage> {
        self.by_id.get(id).cloned()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StreamClipState {
    Open {
        generation: u64,
        next_sequence: u64,
        connection: u64,
    },
    Ended {
        generation: u64,
        connection: u64,
    },
    Cancelled,
    Abandoned,
    Finalized,
}

#[derive(Debug)]
pub struct Clip {
    pub(crate) id: String,
    pub(crate) audio: Vec<u8>,
    _mime: String,
    // Stamped when the clip is accepted, not when its transcript comes back.
    // Transcription is a sidecar round trip, and a page transfer can land
    // inside it; without this the reply epoch would be read after the rescue
    // and pre-rescue speech would count as current.
    pub(crate) generation: u64,
    /// The browser connection it arrived on, so its transcription logs there
    /// too although the clip worker serves every connection.
    connection: tracing::Span,
}

/// Sends the message that settles clip `id` and remembers it, so a resend
/// of the clip after a reconnect is answered (`replay_clip_verdict`).
/// Recorded before it is sent: a resend that races it either finds the
/// verdict or is registered in time to receive it.
pub(crate) fn emit_clip_verdict(state: &AppState, id: &str, verdict: ServerMessage) -> bool {
    state
        .0
        .clips
        .verdicts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .record(id, verdict.clone());
    emit_message(state, verdict)
}
/// Answers a clip the server has already settled with the verdict it was
/// sent, on the connection that sent it again. `None` when the clip is not
/// settled (or long forgotten), and the caller handles it as it arrived.
async fn replay_clip_verdict(state: &AppState, epoch: u64, id: &str) -> Option<Result<(), ()>> {
    let verdict = state
        .0
        .clips
        .verdicts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(id)?;
    tracing::info!(clip = %id, "answering a resent clip with its verdict");
    Some(send_message(state, epoch, verdict).await)
}
pub(crate) async fn process_stream_results(state: AppState) {
    let Some(mut results) = state.0.stt_stream.take_results().await else {
        return;
    };
    while let Some(result) = results.recv().await {
        match result {
            StreamResult::Partial(partial) => {
                // Only the final result is shown and acted on. The page has no
                // place for a caller line that is still being recognized.
                tracing::debug!(
                    clip = %partial.clip_id,
                    generation = partial.generation,
                    sequence = partial.sequence,
                    chars = partial.text.chars().count(),
                    "streaming STT partial"
                );
            }
            StreamResult::Final(final_result) => {
                let claim = {
                    let mut clips = state.0.clips.streams.lock().await;
                    match clips.get(&final_result.clip_id).copied() {
                        Some(StreamClipState::Ended { generation, .. })
                            if generation == final_result.generation =>
                        {
                            clips.insert(final_result.clip_id.clone(), StreamClipState::Finalized);
                            true
                        }
                        _ => false,
                    }
                };
                if claim {
                    route_final_transcript(
                        &state,
                        &final_result.clip_id,
                        final_result.generation,
                        final_result.text,
                    )
                    .await;
                }
            }
            StreamResult::WorkerError(error) => {
                tracing::error!(%error, "streaming STT worker failed");
                let abandoned = {
                    let mut clips = state.0.clips.streams.lock().await;
                    let mut abandoned = Vec::new();
                    for (id, clip) in clips.iter_mut() {
                        match *clip {
                            StreamClipState::Open { connection, .. }
                            | StreamClipState::Ended { connection, .. } => {
                                *clip = StreamClipState::Abandoned;
                                abandoned.push((id.clone(), connection));
                            }
                            _ => {}
                        }
                    }
                    abandoned
                };
                for (id, connection) in abandoned {
                    let _ = send_message(
                        &state,
                        connection,
                        ServerMessage::Abandoned {
                            id,
                            reason: "stream worker unavailable".into(),
                        },
                    )
                    .await;
                }
            }
        }
    }
}

/// A clip's final transcript, from every path that makes one (a complete
/// clip, a streamed clip, a typed turn), up to a logged line on its way to
/// routing. Empty words are answered "say it again"; words stamped before
/// the line changed are refused as stale before they are logged; the rest
/// are logged, echoed to the page, and routed.
pub(crate) async fn route_final_transcript(
    state: &AppState,
    id: &str,
    generation: u64,
    transcript: String,
) {
    if transcript.trim().is_empty() {
        emit_clip_verdict(
            state,
            id,
            ServerMessage::error_for(id, "I didn't catch that — say it again."),
        );
        return;
    }
    state.0.clear_continuity_if_current(generation);
    state.0.floor.caller_spoke().await;
    let _transition = state.0.operation_transition.lock().await;
    if generation != state.0.coordinator.generation() {
        tracing::info!(clip = %id, "discarding stale transcript before persistence");
        emit_stale_clip(state, id);
        return;
    }
    let route = state.0.coordinator.route();
    state.0.transcript_log.lock().await.add_with_id(
        CALLER,
        &transcript,
        route,
        Some(id.to_owned()),
    );
    drop(_transition);
    emit_transcript_verdict(state, id, &transcript);
    dispatch_routed_transcript(state, id, generation, transcript).await;
}

/// Routes a typed turn off the WebSocket reader, in the order turns were
/// typed. Routing asks Jev and can take seconds, and a later line can come
/// back first, so each typed turn waits until the one typed before it is
/// queued or steered (#248). The reader only starts the task: it waits on
/// `operation_transition`, which a transfer can hold for seconds, and the
/// reader must keep answering pings meanwhile.
pub(crate) fn route_typed_turn(state: &AppState, id: String, generation: u64, text: String) {
    let mut tail = state
        .0
        .clips
        .typed_tail
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let ahead = tail.take();
    let routing = state.clone();
    *tail = Some(tokio::spawn(
        async move {
            if let Some(ahead) = ahead {
                // A turn ahead that failed has still left the line.
                let _ = ahead.await;
            }
            route_final_transcript(&routing, &id, generation, text).await;
        }
        .in_current_span(),
    ));
}

fn emit_transcript_verdict(state: &AppState, id: &str, transcript: &str) {
    emit_clip_verdict(
        state,
        id,
        ServerMessage::Transcript {
            id: id.to_owned(),
            text: transcript.to_owned(),
        },
    );
}

/// Caller audio clips and the state only this module reads: the clip channel
/// to the transcription worker, the receiver that worker takes once, the ids
/// already accepted (so a retransmit is answered, not transcribed twice), the
/// last word sent on each recent clip, every streaming clip's state, and the
/// newest typed turn still being routed (`route_typed_turn`).
/// `AppInner` holds one so the fields are the caller-input module's own.
pub(crate) struct ClipState {
    sender: mpsc::Sender<Clip>,
    receiver: Mutex<Option<mpsc::Receiver<Clip>>>,
    accepted: Mutex<(HashSet<String>, VecDeque<String>)>,
    verdicts: std::sync::Mutex<ClipVerdicts>,
    streams: Mutex<HashMap<String, StreamClipState>>,
    typed_tail: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl ClipState {
    pub(crate) fn new() -> Self {
        // Audio frames may be up to the WebSocket limit. A small bounded queue
        // prevents a stalled decoder from retaining roughly a gigabyte of
        // accepted clips while still leaving ample room for one caller's
        // retransmit/burst behavior.
        let (sender, receiver) = mpsc::channel(8);
        Self {
            sender,
            receiver: Mutex::new(Some(receiver)),
            accepted: Mutex::new((HashSet::new(), VecDeque::new())),
            verdicts: std::sync::Mutex::new(ClipVerdicts::default()),
            streams: Mutex::new(HashMap::new()),
            typed_tail: std::sync::Mutex::new(None),
        }
    }

    /// The clip worker's end of the channel, for a test that stands in for
    /// the worker.
    #[cfg(test)]
    pub(crate) async fn take_receiver(&self) -> mpsc::Receiver<Clip> {
        self.receiver
            .lock()
            .await
            .take()
            .expect("the clip receiver is taken once")
    }

    #[cfg(test)]
    pub(crate) async fn accepted_is_empty(&self) -> bool {
        self.accepted.lock().await.0.is_empty()
    }
}

pub(crate) async fn process_clips(state: AppState) {
    let mut receiver = state
        .0
        .clips
        .receiver
        .lock()
        .await
        .take()
        .expect("clip worker started once");
    while let Some(clip) = receiver.recv().await {
        // The clip id is the one identifier that spans the whole call path —
        // the browser minted it, the transcript carries it, and every error
        // frame quotes it. Logging it at each stage is what makes a caller's
        // "it broke when I said X" answerable from the journal.
        let started = std::time::Instant::now();
        tracing::info!(parent: &clip.connection, clip = %clip.id, bytes = clip.audio.len(), "transcribing clip");
        let stt = tracing::info_span!(parent: &clip.connection, "stt", clip = %clip.id);
        let transcript = match state.0.stt.transcribe(&clip.audio).instrument(stt).await {
            Ok(text) => text,
            Err(error) => {
                tracing::error!(clip = %clip.id, bytes = clip.audio.len(), %error, "transcription failed");
                emit_clip_verdict(
                    &state,
                    &clip.id,
                    ServerMessage::error_for(
                        clip.id.clone(),
                        format!("Transcription failed: {error}"),
                    ),
                );
                continue;
            }
        };
        if transcript.trim().is_empty() {
            tracing::info!(clip = %clip.id, elapsed = ?started.elapsed(), "transcription returned nothing");
        } else {
            tracing::info!(
                clip = %clip.id,
                route = %state.0.coordinator.route(),
                chars = transcript.chars().count(),
                elapsed = ?started.elapsed(),
                "transcribed clip"
            );
        }
        route_final_transcript(&state, &clip.id, clip.generation, transcript).await;
    }
    tracing::warn!("the clip worker stopped; no further speech will be transcribed");
}
pub(crate) fn emit_stale_clip(state: &AppState, id: &str) {
    emit_clip_verdict(
        state,
        id,
        ServerMessage::Error {
            id: Some(id.to_owned()),
            code: Some(ErrorCode::StaleEpoch),
            message: "The line changed before that got through. Please repeat it.".into(),
        },
    );
}

/// A clip header: its id, its mime type, and the turn epoch the browser held
/// when it began recording.
///
/// The epoch is required, as it is for a typed turn and a streaming clip:
/// every page that sends a clip stamps it, and a clip without one could not be
/// checked against a transfer that landed between recording and upload. It is
/// never stamped on arrival instead (`AGENTS.md`, the browser command rule). A
/// value the browser cannot have learned yet simply fails the equality check
/// later and the clip is dropped, so a wrong number can only discard speech,
/// never route it somewhere it does not belong.
pub(crate) type ClipHeader = (String, String, u64);
pub(crate) type StreamChunkHeader = (String, u64, u64);

/// The longest clip id a page may send. One rule for every command that names
/// a clip: the complete-clip header, a typed turn, and the streaming commands.
pub(crate) const MAX_CLIP_ID_CHARS: usize = 128;

/// Whether `id` may name a clip: not empty and within `MAX_CLIP_ID_CHARS`.
pub(crate) fn is_clip_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= MAX_CLIP_ID_CHARS
}

/// A clip header, or the error that refuses it: one with no usable id is
/// refused without an id, one with an id but no generation is refused by that
/// id. A refused header leaves none pending, so the audio frame after it
/// arrives without a header and is answered as such, as after a refused
/// `stt_chunk`.
pub(crate) fn parse_clip_header(
    id: Option<String>,
    mime: Option<String>,
    generation: Option<u64>,
) -> Result<ClipHeader, Box<ServerMessage>> {
    let Some(id) = id.filter(|id| is_clip_id(id)) else {
        return Err(Box::new(ServerMessage::error("Invalid clip id.")));
    };
    let Some(generation) = generation else {
        return Err(Box::new(ServerMessage::error_for(
            id,
            "Clip has no generation.",
        )));
    };
    let mime = mime.unwrap_or_default().chars().take(100).collect();
    Ok((id, mime, generation))
}

/// The longest turn a caller may type, the same bound `/speak` puts on text.
pub(crate) const MAX_TYPED_TURN_CHARS: usize = 16 * 1024;

/// A turn the caller typed: `(id, generation, text)`.
///
/// The generation is required, as it is for a clip header. Every browser that
/// can send a typed turn also stamps its epoch, and a turn without one could
/// not be checked against a transfer that landed after the caller sent it.
pub(crate) fn parse_typed_turn(
    id: Option<&str>,
    generation: Option<u64>,
    text: Option<&str>,
) -> Option<(String, u64, String)> {
    let id = id.filter(|id| is_clip_id(id))?;
    let generation = generation?;
    let text = text
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.chars().count() <= MAX_TYPED_TURN_CHARS)?;
    Some((id.to_owned(), generation, text.to_owned()))
}

/// `stt_start`: opens a streaming clip for this connection, or resumes one it
/// already holds, and starts its worker stream. Answers `accepted`, or
/// `abandoned` with the reason the clip must go the complete-clip way instead.
///
/// The generation is required, as it is for a typed turn: every page that
/// streams stamps it, and a stream without one could not be checked against
/// a transfer that landed while the caller was still talking. A start
/// without one is refused like one without a usable clip id.
pub(crate) async fn start_stream_clip(
    state: &AppState,
    epoch: u64,
    clip_id: Option<String>,
    generation: Option<u64>,
    mime: Option<String>,
) -> Result<(), ()> {
    let Some(id) = clip_id.as_deref().filter(|id| is_clip_id(id)) else {
        return send_message(
            state,
            epoch,
            ServerMessage::error("Invalid streaming clip id."),
        )
        .await;
    };
    let Some(generation) = generation else {
        return send_message(
            state,
            epoch,
            ServerMessage::error_for(id.to_owned(), "Streaming clip has no generation."),
        )
        .await;
    };
    if let Some(replayed) = replay_clip_verdict(state, epoch, id).await {
        return replayed;
    }
    let mime = mime.as_deref().unwrap_or("");
    if mime != "audio/webm;codecs=opus" || !state.0.stt_stream.configured() {
        return send_message(
            state,
            epoch,
            ServerMessage::Abandoned {
                id: id.to_owned(),
                reason: "streaming STT is unavailable for this clip".into(),
            },
        )
        .await;
    }
    let mut clips = state.0.clips.streams.lock().await;
    match clips.get(id).copied() {
        Some(StreamClipState::Open { connection, .. }) if connection == epoch => {
            return accept_stream_clip(state, epoch, id).await;
        }
        Some(StreamClipState::Ended {
            generation: _,
            connection,
        }) if connection == epoch => {
            return accept_stream_clip(state, epoch, id).await;
        }
        Some(StreamClipState::Ended { generation, .. }) => {
            clips.insert(
                id.to_owned(),
                StreamClipState::Open {
                    generation,
                    next_sequence: 0,
                    connection: epoch,
                },
            );
            drop(clips);
            return open_worker_stream(state, epoch, id, generation, mime).await;
        }
        Some(
            StreamClipState::Abandoned | StreamClipState::Cancelled | StreamClipState::Finalized,
        ) => {
            return send_message(
                state,
                epoch,
                ServerMessage::Abandoned {
                    id: id.to_owned(),
                    reason: "clip is no longer resumable".into(),
                },
            )
            .await;
        }
        _ => {}
    }
    if clips.len() >= 512 {
        let retired = clips
            .iter()
            .find(|(_, state)| {
                matches!(
                    state,
                    StreamClipState::Cancelled
                        | StreamClipState::Abandoned
                        | StreamClipState::Finalized
                )
            })
            .map(|(id, _)| id.clone());
        if let Some(retired) = retired {
            clips.remove(&retired);
        }
    }
    if clips.len() >= 512 {
        return send_message(
            state,
            epoch,
            ServerMessage::Abandoned {
                id: id.to_owned(),
                reason: "too many active streaming clips".into(),
            },
        )
        .await;
    }
    clips.insert(
        id.to_owned(),
        StreamClipState::Open {
            generation,
            next_sequence: 0,
            connection: epoch,
        },
    );
    drop(clips);
    open_worker_stream(state, epoch, id, generation, mime).await
}

/// `stt_end`: the page has sent the clip's last chunk. The clip is marked
/// ended for this connection and generation and the worker stream is told to
/// finish; a worker that cannot answers `abandoned` with its reason. Anything
/// else (an unknown, cancelled, finished or other connection's clip, or a
/// command naming no clip or no generation) is ignored, as a stale clip is.
pub(crate) async fn end_stream_clip(
    state: &AppState,
    epoch: u64,
    clip_id: Option<String>,
    generation: Option<u64>,
) -> Result<(), ()> {
    let (Some(id), Some(generation)) = (clip_id.as_deref(), generation) else {
        return Ok(());
    };
    let valid = {
        let mut clips = state.0.clips.streams.lock().await;
        match clips.get(id).copied() {
            Some(StreamClipState::Open {
                generation: current,
                connection,
                ..
            }) if current == generation && connection == epoch => {
                clips.insert(
                    id.to_owned(),
                    StreamClipState::Ended {
                        generation,
                        connection,
                    },
                );
                true
            }
            Some(StreamClipState::Ended { .. })
            | Some(StreamClipState::Cancelled)
            | Some(StreamClipState::Abandoned)
            | Some(StreamClipState::Finalized) => false,
            _ => false,
        }
    };
    if valid {
        if let Err(reason) = state.0.stt_stream.try_end(id.to_owned(), generation) {
            state
                .0
                .clips
                .streams
                .lock()
                .await
                .insert(id.to_owned(), StreamClipState::Abandoned);
            return send_message(
                state,
                epoch,
                ServerMessage::Abandoned {
                    id: id.to_owned(),
                    reason: reason.into(),
                },
            )
            .await;
        }
    }
    Ok(())
}

/// `stt_cancel`: the page gave up on the clip. An open or ended clip is marked
/// cancelled and its worker stream told so; a clip already past that point is
/// left alone.
pub(crate) async fn cancel_stream_clip(
    state: &AppState,
    clip_id: Option<String>,
    generation: Option<u64>,
) -> Result<(), ()> {
    let (Some(id), Some(generation)) = (clip_id.as_deref(), generation) else {
        return Ok(());
    };
    let should_cancel = {
        let mut clips = state.0.clips.streams.lock().await;
        match clips.get(id).copied() {
            Some(StreamClipState::Cancelled)
            | Some(StreamClipState::Finalized)
            | Some(StreamClipState::Abandoned)
            | None => false,
            Some(_) => {
                clips.insert(id.to_owned(), StreamClipState::Cancelled);
                true
            }
        }
    };
    if should_cancel {
        let _ = state.0.stt_stream.try_cancel(id.to_owned(), generation);
    }
    Ok(())
}

async fn accept_stream_clip(state: &AppState, epoch: u64, id: &str) -> Result<(), ()> {
    send_message(
        state,
        epoch,
        ServerMessage::Accepted {
            id: id.to_owned(),
            streaming: true,
        },
    )
    .await
}

/// Starts the worker stream for a clip already recorded as open. If the worker
/// will not take it, the clip is marked abandoned and the browser is told why,
/// so it sends the clip whole instead.
async fn open_worker_stream(
    state: &AppState,
    epoch: u64,
    id: &str,
    generation: u64,
    mime: &str,
) -> Result<(), ()> {
    if let Err(reason) = state
        .0
        .stt_stream
        .try_start(id.to_owned(), generation, mime.to_owned())
    {
        state
            .0
            .clips
            .streams
            .lock()
            .await
            .insert(id.to_owned(), StreamClipState::Abandoned);
        return send_message(
            state,
            epoch,
            ServerMessage::Abandoned {
                id: id.to_owned(),
                reason: reason.into(),
            },
        )
        .await;
    }
    accept_stream_clip(state, epoch, id).await
}

pub(crate) async fn handle_audio_frame(
    state: &AppState,
    epoch: u64,
    pending_header: &mut Option<ClipHeader>,
    pending_stream_chunk: &mut Option<StreamChunkHeader>,
    audio: Vec<u8>,
) -> Result<(), ()> {
    if let Some((id, generation, sequence)) = pending_stream_chunk.take() {
        let admitted = {
            let mut clips = state.0.clips.streams.lock().await;
            match clips.get_mut(&id) {
                Some(StreamClipState::Open {
                    generation: current,
                    next_sequence,
                    connection,
                }) if *current == generation
                    && *connection == epoch
                    && *next_sequence == sequence =>
                {
                    *next_sequence += 1;
                    true
                }
                _ => false,
            }
        };
        if !admitted {
            return send_message(
                state,
                epoch,
                ServerMessage::error_for(id, "Invalid or out-of-order streaming chunk."),
            )
            .await;
        }
        if let Err(reason) = state
            .0
            .stt_stream
            .try_chunk(id.clone(), generation, sequence, audio)
        {
            state
                .0
                .clips
                .streams
                .lock()
                .await
                .insert(id.clone(), StreamClipState::Abandoned);
            return send_message(
                state,
                epoch,
                ServerMessage::Abandoned {
                    id: id.to_owned(),
                    reason: reason.into(),
                },
            )
            .await;
        }
        return Ok(());
    }
    let Some((id, mime, generation)) = pending_header.take() else {
        tracing::warn!(bytes = audio.len(), "audio arrived without a clip header");
        return send_message(
            state,
            epoch,
            ServerMessage::error("Audio arrived without a clip header."),
        )
        .await;
    };
    // What the browser recorded, named as it arrives. The mime is the
    // browser's own answer about its recorder: Safari and every iPad browser
    // record `audio/mp4` where the rest record `audio/webm;codecs=opus`, and
    // a sidecar verdict is only readable next to the format it was handed.
    tracing::info!(clip = %id, bytes = audio.len(), mime = %mime, "clip arrived");
    if let Some(replayed) = replay_clip_verdict(state, epoch, &id).await {
        return replayed;
    }

    let fresh = {
        let mut accepted = state.0.clips.accepted.lock().await;
        let fresh = accepted.0.insert(id.clone());
        if fresh {
            accepted.1.push_back(id.clone());
            while accepted.1.len() > 512 {
                if let Some(old) = accepted.1.pop_front() {
                    accepted.0.remove(&old);
                }
            }
        } else {
            // A reconnect retransmits the oldest unacknowledged clip first.
            // Keep that id recent just like the Python OrderedDict baseline so
            // a live retry cannot fall out of the bounded idempotency window.
            accepted.1.retain(|accepted_id| accepted_id != &id);
            accepted.1.push_back(id.clone());
        }
        fresh
    };
    if fresh
        && state
            .0
            .clips
            .sender
            .send(Clip {
                id: id.clone(),
                audio,
                _mime: mime,
                // The browser's stamp is taken when recording starts, which is
                // earlier than anything this side can observe and therefore
                // closes the upload window too.
                generation,
                connection: tracing::Span::current(),
            })
            .await
            .is_err()
    {
        // Do not acknowledge ownership the application did not actually take.
        // A reconnect must be allowed to retry this id.
        let mut accepted = state.0.clips.accepted.lock().await;
        accepted.0.remove(&id);
        accepted.1.retain(|accepted_id| accepted_id != &id);
        return send_message(
            state,
            epoch,
            ServerMessage::error_for(id.clone(), "The call worker is unavailable."),
        )
        .await;
    }
    send_message(
        state,
        epoch,
        ServerMessage::Accepted {
            id,
            streaming: false,
        },
    )
    .await
}

#[cfg(test)]
pub(crate) fn assert_dropped_with_notice(frame: &Value, id: &str) {
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

#[cfg(test)]
#[path = "../tests/test_caller_input.rs"]
mod tests;

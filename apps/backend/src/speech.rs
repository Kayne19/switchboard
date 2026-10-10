//! Speech to the caller: the one ordered speech worker, its continuity
//! stitching, the audio slots it reserves, the voice a reply or a floor
//! release reserves before it speaks, and the floor worker's hooks.
use crate::app_state::AppState;
use crate::app_state::{
    clear_active_operation, emit, emit_message, publish_agents, publish_status,
    spawn_registered_operation, AppInner,
};
use crate::audio::TtsContinuity;
use crate::debug::DebugEvent;
use crate::delivery::Event;
use crate::floor;
use crate::floor::{FloorHooks, FloorRequest, FloorRewriteInput, ReleaseOutcome};
use crate::history::AGENT;
use crate::pbx::Switchboard;
use crate::protocol::ServerMessage;
use crate::turns::{call_summary_without_desk_sessions, jev_response_event};
use futures_util::StreamExt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};
use tracing::Instrument;

/// The call-scoped continuity context for the next ElevenLabs request.
///
/// A request id is safe to reuse only after its response stream has drained.
/// `pending_text` covers the handoff window while that drain is still in
/// progress. The epoch, generation, and model together identify the lifecycle
/// that admitted the request; a late drain must not poison a later call leg.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SpeechContinuity {
    pub(crate) last_request_id: Option<String>,
    pub(crate) last_text: Option<String>,
    pub(crate) pending_text: Option<String>,
    pub(crate) pending_sequence: Option<u64>,
    pub(crate) generation: u64,
    pub(crate) model: String,
    pub(crate) epoch: u64,
    pub(crate) last_sequence: Option<u64>,
}

impl SpeechContinuity {
    pub(crate) fn clear(&mut self, generation: u64, model: &str) {
        self.last_request_id = None;
        self.last_text = None;
        self.pending_text = None;
        self.pending_sequence = None;
        self.generation = generation;
        self.model = model.to_owned();
        self.epoch = self.epoch.saturating_add(1);
        self.last_sequence = None;
    }

    #[cfg(test)]
    pub(crate) fn mark_pending(&mut self, generation: u64, model: &str, text: String) -> bool {
        self.mark_pending_ordered(generation, model, None, text)
    }

    pub(crate) fn mark_pending_ordered(
        &mut self,
        generation: u64,
        model: &str,
        sequence: Option<u64>,
        text: String,
    ) -> bool {
        if self.generation != generation {
            return false;
        }
        // Tests and startup can create the record before a TTS model snapshot
        // is available. Adopt the first model only while the record is empty;
        // never cross-condition an existing clip between models.
        if self.model != model {
            if self.last_request_id.is_none()
                && self.last_text.is_none()
                && self.pending_text.is_none()
            {
                self.model = model.to_owned();
            } else {
                return false;
            }
        }
        self.pending_text = Some(text);
        self.pending_sequence = sequence;
        true
    }

    pub(crate) fn clear_pending_if_matching(
        &mut self,
        generation: u64,
        model: &str,
        epoch: u64,
        sequence: Option<u64>,
        text: &str,
    ) -> bool {
        if self.generation == generation
            && self.model == model
            && self.epoch == epoch
            && self.pending_sequence == sequence
            && self.pending_text.as_deref() == Some(text)
        {
            self.pending_text = None;
            self.pending_sequence = None;
            true
        } else {
            false
        }
    }

    /// Commit only a fully drained response from the lifecycle that admitted it.
    /// A newer pending clip is retained when an older drain completes later.
    #[cfg(test)]
    pub(crate) fn commit(
        &mut self,
        generation: u64,
        model: &str,
        epoch: u64,
        request_id: Option<String>,
        text: String,
    ) -> bool {
        self.commit_ordered(generation, model, epoch, None, request_id, text)
    }

    /// Commit a drained clip only when it is newer than the clip already
    /// committed. Drains run independently, so body completion order is not
    /// enough to establish continuity order.
    pub(crate) fn commit_ordered(
        &mut self,
        generation: u64,
        model: &str,
        epoch: u64,
        sequence: Option<u64>,
        request_id: Option<String>,
        text: String,
    ) -> bool {
        if self.generation != generation || self.model != model || self.epoch != epoch {
            return false;
        }
        if let (Some(sequence), Some(last_sequence)) = (sequence, self.last_sequence) {
            if sequence <= last_sequence {
                return false;
            }
        }
        self.last_request_id = request_id;
        self.last_text = Some(text.clone());
        if let Some(sequence) = sequence {
            self.last_sequence = Some(sequence);
        }
        if self.pending_text.as_deref() == Some(text.as_str()) && self.pending_sequence == sequence
        {
            self.pending_text = None;
            self.pending_sequence = None;
        }
        true
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ContinuationScope {
    /// The first utterance after caller speech or an unrelated speech group.
    FreshTurn,
    /// Another utterance from the same active model turn.
    ContinueCurrentTurn,
    /// A floor update that follows foreground audio in this generation.
    ContinueAfterForeground,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SpeechGroup(u64);

pub(crate) struct SpeechRequest {
    text: String,
    /// Transcript route for floor speech; ordinary agent speech uses the live
    /// coordinator route.
    route: String,
    generation: u64,
    sequence: u64,
    deadline: std::time::Instant,
    scope: ContinuationScope,
    group: SpeechGroup,
    /// The active model snapshot captured when this request was admitted.
    /// A model swap invalidates the call's continuity chain.
    model: String,
    /// Mid-turn and floor speech are written to the spoken transcript. Settled
    /// replies already have their own Reply event and must not be duplicated.
    log_spoken: bool,
    result: oneshot::Sender<Result<(), String>>,
    /// The `/speak` request it answers; the synthesis logs under it although
    /// the speech worker runs it.
    span: tracing::Span,
}

impl AppInner {
    pub(crate) fn continuity_snapshot(&self) -> SpeechContinuity {
        self.continuity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub(crate) fn clear_continuity(&self) {
        let generation = self.coordinator.generation();
        let model = self.coordinator.status().model;
        self.clear_continuity_for(generation, &model);
        *self
            .active_speech_group
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .foreground_audio_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    pub(crate) fn clear_continuity_if_current(&self, generation: u64) -> bool {
        if generation != self.coordinator.generation() {
            return false;
        }
        let model = self.coordinator.status().model;
        self.clear_continuity_for(generation, &model);
        *self
            .active_speech_group
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .foreground_audio_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        true
    }

    pub(crate) fn clear_continuity_for(&self, generation: u64, model: &str) {
        self.continuity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear(generation, model);
    }

    #[cfg(test)]
    pub(crate) fn mark_continuity_pending(
        &self,
        generation: u64,
        model: &str,
        text: String,
    ) -> bool {
        self.continuity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .mark_pending(generation, model, text)
    }

    pub(crate) fn mark_continuity_pending_ordered(
        &self,
        generation: u64,
        model: &str,
        sequence: u64,
        text: String,
    ) -> bool {
        self.continuity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .mark_pending_ordered(generation, model, Some(sequence), text)
    }

    pub(crate) fn clear_pending_continuity_if_matching(
        &self,
        generation: u64,
        model: &str,
        epoch: u64,
        sequence: Option<u64>,
        text: &str,
    ) -> bool {
        self.continuity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear_pending_if_matching(generation, model, epoch, sequence, text)
    }

    #[cfg(test)]
    pub(crate) fn commit_continuity(
        &self,
        generation: u64,
        model: &str,
        epoch: u64,
        request_id: Option<String>,
        text: String,
    ) -> bool {
        self.continuity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .commit(generation, model, epoch, request_id, text)
    }

    pub(crate) fn commit_continuity_ordered(
        &self,
        generation: u64,
        model: &str,
        epoch: u64,
        sequence: u64,
        request_id: Option<String>,
        text: String,
    ) -> bool {
        self.continuity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .commit_ordered(generation, model, epoch, Some(sequence), request_id, text)
    }

    pub(crate) fn new_speech_group(&self) -> SpeechGroup {
        SpeechGroup(self.speech.next_group.fetch_add(1, Ordering::Relaxed))
    }

    pub(crate) fn set_active_speech_group(&self, group: SpeechGroup) {
        *self
            .active_speech_group
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(group);
    }

    pub(crate) fn active_speech_group(&self) -> Option<SpeechGroup> {
        *self
            .active_speech_group
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn clear_active_speech_group(&self, group: SpeechGroup) {
        let mut active = self
            .active_speech_group
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *active == Some(group) {
            *active = None;
        }
    }

    pub(crate) fn mark_foreground_audio(&self, generation: u64) {
        *self
            .foreground_audio_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(generation);
    }

    pub(crate) fn take_foreground_audio(&self, generation: u64) -> bool {
        let mut foreground = self
            .foreground_audio_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *foreground == Some(generation) {
            *foreground = None;
            true
        } else {
            false
        }
    }
}

pub(crate) fn ensure_speech_worker(state: &AppState) {
    if state
        .0
        .speech
        .worker_started
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        let speech_state = state.clone();
        tokio::spawn(async move {
            process_speech(speech_state).await;
        });
    }
}

pub(crate) fn spawn_floor_worker(state: AppState) {
    let floor = state.0.floor.clone();
    let connected_state = state.clone();
    let live_state = state.clone();
    let gate_state = state.clone();
    let rewrite_state = state.clone();
    let release_state = state.clone();
    let hooks = FloorHooks {
        connected: Arc::new(move || connected_state.0.delivery.connected()),
        live: Arc::new(move |request: &FloorRequest| {
            let current_generation = live_state.0.coordinator.generation();
            live_state
                .0
                .coordinator
                .with_background(&request.token, |project| {
                    project == request.project && current_generation == request.generation
                })
                .is_some()
        }),
        gate: Arc::new(move |request: &FloorRequest| {
            let state = gate_state.clone();
            let request = request.clone();
            Box::pin(async move {
                let entries = state.0.transcript_log.lock().await.entries();
                let screen = state.0.display_gate.lock().await.screen_state.clone();
                // Floor admission only asks whether a background agent may
                // speak. Desk discovery is for caller routing and would make
                // this gate wait on every host link for no decision benefit.
                // `caller_just_said` keeps its meaning: the caller's last
                // words. The update being judged is its own named field.
                let caller_last = entries
                    .iter()
                    .rev()
                    .find(|entry| entry.role == crate::history::CALLER)
                    .map(|entry| entry.text.clone())
                    .unwrap_or_default();
                let (router, mut summary) =
                    call_summary_without_desk_sessions(&state, &entries, screen, caller_last);
                summary.queued_update = Some(crate::router::QueuedUpdate {
                    from_agent: request.project.clone(),
                    message: request.message.clone(),
                });
                let floor_id = request.floor_debug_id();
                let jev_request = router.good_moment_request(&summary);
                state.0.debug.publish(DebugEvent::JevRequest {
                    utterance_id: None,
                    purpose: "good_moment".into(),
                    state: jev_request.state.clone(),
                    floor_id: Some(floor_id.clone()),
                });
                let trace = router.good_moment(jev_request).await;
                state.0.debug.publish(jev_response_event(
                    None,
                    Some(floor_id),
                    "good_moment",
                    trace.latency_ms,
                    trace.response.as_ref(),
                    trace.result.as_ref().err(),
                ));
                trace.result.map_err(|_| ())
            }) as floor::GateFuture
        }),
        rewrite: Arc::new(move |input: FloorRewriteInput| {
            let state = rewrite_state.clone();
            Box::pin(async move {
                let project = input.project.clone();
                // The utility is reached through the PBX lock, which a
                // foreground turn holds for its whole prompt, so the wait for
                // it is inside the timeout too.
                let operation = async {
                    let session = {
                        let mut board = state.0.switchboard.lock().await;
                        board.floor_rewrite_session().await.map_err(|_| ())?
                    };
                    Switchboard::rewrite_floor_with_session(&session, &input)
                        .await
                        .map_err(|error| {
                            tracing::warn!(%project, %error, "floor rewrite failed; speaking the original");
                        })?
                        .filter(|text| !text.trim().is_empty())
                        .ok_or_else(|| {
                            tracing::warn!(%project, "floor rewrite gave no text; speaking the original");
                        })
                };
                tokio::time::timeout(floor::REWRITE_TIMEOUT, operation)
                    .await
                    .map_err(|_| {
                        tracing::warn!(project = %input.project, "floor rewrite timed out; speaking the original");
                    })?
            }) as floor::RewriteFuture
        }),
        release: Arc::new(move |request: FloorRequest, rewritten: String| {
            let state = release_state.clone();
            Box::pin(async move { release_floor(&state, request, rewritten).await })
                as floor::ReleaseFuture
        }),
    };
    tokio::spawn(async move { floor.run(hooks).await });
}

/// How many audio clips may wait for the browser at once. A reservation past
/// it is refused, like one for a generation that has moved on.
pub(crate) const AUDIO_SLOTS: usize = 64;

async fn reserve_audio(state: &AppState, generation: u64) -> Option<u64> {
    let mut audio = state.0.audio.lock().await;
    if generation != state.0.coordinator.generation() || audio.slots.len() >= AUDIO_SLOTS {
        return None;
    }
    Some(audio.reserve(generation))
}

async fn publish_audio_events(state: &AppState, events: Vec<Event>) -> bool {
    let mut delivered = false;
    for event in events {
        delivered |= emit(state, event);
    }
    delivered
}

async fn start_audio(state: &AppState, sequence: u64, generation: u64) -> bool {
    let events = {
        let mut audio = state.0.audio.lock().await;
        audio.start(sequence, generation)
    };
    publish_audio_events(state, events).await
}

async fn append_audio(state: &AppState, sequence: u64, generation: u64, bytes: Vec<u8>) -> bool {
    let events = {
        let mut audio = state.0.audio.lock().await;
        audio.append(sequence, generation, bytes)
    };
    publish_audio_events(state, events).await
}

pub(crate) async fn finish_audio(
    state: &AppState,
    sequence: u64,
    generation: u64,
    bytes: Vec<u8>,
) -> bool {
    let (events, current) = {
        let mut audio = state.0.audio.lock().await;
        let current = generation == state.0.coordinator.generation();
        let events = if current {
            let mut events = audio.append(sequence, generation, bytes);
            events.extend(audio.finish(sequence, generation));
            events
        } else {
            audio.cancel(sequence, generation)
        };
        (events, current)
    };
    publish_audio_events(state, events).await && current
}

fn continuity_for_request(
    state: &AppState,
    scope: ContinuationScope,
    generation: u64,
    model: &str,
) -> (TtsContinuity, u64) {
    let snapshot = state.0.continuity_snapshot();
    if matches!(scope, ContinuationScope::FreshTurn)
        || snapshot.generation != generation
        || snapshot.model != model
    {
        return (TtsContinuity::Fresh, snapshot.epoch);
    }
    if let Some(text) = snapshot.pending_text {
        return (TtsContinuity::PreviousText(text), snapshot.epoch);
    }
    if let Some(request_id) = snapshot.last_request_id {
        return (
            TtsContinuity::previous_request_ids([request_id], snapshot.last_text),
            snapshot.epoch,
        );
    }
    snapshot
        .last_text
        .map_or((TtsContinuity::Fresh, snapshot.epoch), |text| {
            (TtsContinuity::PreviousText(text), snapshot.epoch)
        })
}

async fn drain_speech_stream(
    state: AppState,
    mut stream: crate::audio::TtsChunkStream,
    text: String,
    sequence: u64,
    generation: u64,
    model: String,
    epoch: u64,
) -> Result<(usize, bool), crate::audio::AudioError> {
    let request_id = stream.metadata().request_id.clone();
    let mut delivered = start_audio(&state, sequence, generation).await;
    let mut bytes = 0usize;
    while let Some(chunk) = stream.next().await {
        if generation != state.0.coordinator.generation() {
            state.0.clear_pending_continuity_if_matching(
                generation,
                &model,
                epoch,
                Some(sequence),
                &text,
            );
            finish_audio(&state, sequence, generation, Vec::new()).await;
            return Err(crate::audio::AudioError::Tts(
                "speech generation was superseded".into(),
            ));
        }
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                state.0.clear_pending_continuity_if_matching(
                    generation,
                    &model,
                    epoch,
                    Some(sequence),
                    &text,
                );
                finish_audio(&state, sequence, generation, Vec::new()).await;
                return Err(error);
            }
        };
        bytes = bytes.saturating_add(chunk.len());
        for part in chunk.chunks(32 * 1024) {
            delivered |= append_audio(&state, sequence, generation, part.to_vec()).await;
        }
    }
    delivered |= finish_audio(&state, sequence, generation, Vec::new()).await;
    // A request id is useful only after the complete body has been consumed.
    // The epoch/model/generation checks reject a late drain after a reset.
    state
        .0
        .commit_continuity_ordered(generation, &model, epoch, sequence, request_id, text);
    Ok((bytes, delivered))
}

async fn complete_speech_request(
    state: &AppState,
    text: String,
    generation: u64,
    result: oneshot::Sender<Result<(), String>>,
    synthesized: Result<(usize, bool), crate::audio::AudioError>,
    started: std::time::Instant,
    // The utterance's sequence, and the route it is logged under, when the
    // line is written to the spoken transcript; None when it is not.
    spoken_as: Option<(u64, String)>,
) {
    match synthesized {
        Ok((bytes, delivered)) => {
            tracing::info!(
                chars = text.chars().count(),
                bytes,
                elapsed = ?started.elapsed(),
                "synthesized a speech line"
            );
            if delivered {
                if let Some((sequence, route)) = spoken_as {
                    if let Some(entry) = state
                        .0
                        .transcript_log
                        .lock()
                        .await
                        .add_voiced(AGENT, &text, route)
                    {
                        // Emitted once its audio is out: the line names the
                        // utterance, and the page shows it when it plays.
                        emit_message(
                            state,
                            ServerMessage::Spoken {
                                entry,
                                sequence: Some(sequence),
                            },
                        );
                    }
                }
                let _ = result.send(Ok(()));
            } else {
                let _ = result.send(Err(
                    "no browser connected or the writer rejected audio".into()
                ));
            }
        }
        Err(error) => {
            let detail = error.to_string();
            let _ = result.send(Err(detail.clone()));
            // A rescue retires the generation before it stops that
            // generation's speech, so speech it cancelled or superseded went
            // as meant: the caller is not shown it as an error.
            if generation != state.0.coordinator.generation() {
                tracing::info!(%error, chars = text.chars().count(), "speech for a retired generation was not spoken");
                return;
            }
            tracing::error!(%error, chars = text.chars().count(), "speech synthesis failed");
            emit_message(state, ServerMessage::error(detail));
        }
    }
}

async fn process_speech(state: AppState) {
    let mut receiver = state
        .0
        .speech
        .receiver
        .lock()
        .await
        .take()
        .expect("speech worker started once");
    let mut current_group = None;
    while let Some(request) = receiver.recv().await {
        let SpeechRequest {
            text,
            route,
            generation,
            sequence,
            deadline,
            scope,
            group,
            model,
            log_spoken,
            result,
            span,
        } = request;
        let started = std::time::Instant::now();
        let scope = match scope {
            ContinuationScope::FreshTurn => {
                current_group = Some(group);
                ContinuationScope::FreshTurn
            }
            ContinuationScope::ContinueCurrentTurn if current_group == Some(group) => {
                ContinuationScope::ContinueCurrentTurn
            }
            ContinuationScope::ContinueCurrentTurn => {
                current_group = Some(group);
                ContinuationScope::FreshTurn
            }
            ContinuationScope::ContinueAfterForeground => {
                current_group = Some(group);
                ContinuationScope::ContinueAfterForeground
            }
        };
        if matches!(scope, ContinuationScope::FreshTurn)
            && generation == state.0.coordinator.generation()
        {
            // A fresh group must invalidate any older in-flight drain before
            // its stream can become the next continuation. Never let a stale
            // queued request rewrite the newer lifecycle record.
            state.0.clear_continuity_for(generation, &model);
        }
        let (continuity, epoch) = continuity_for_request(&state, scope, generation, &model);
        let admission_state = state.clone();
        let admission_text = text.clone();
        let admission = async move {
            admission_state
                .0
                .speaker
                .stream_until_with_continuity(&admission_text, deadline, continuity)
                .await
        };
        let stream = match spawn_registered_operation(
            &state,
            generation,
            admission.instrument(span.clone()),
        )
        .await
        {
            Some((task, task_id)) => {
                let stream = match task.await {
                    Ok(stream) => stream,
                    Err(error) if error.is_cancelled() => {
                        Err(crate::audio::AudioError::Tts("speech was cancelled".into()))
                    }
                    Err(error) => Err(crate::audio::AudioError::Tts(format!(
                        "speech worker failed: {error}"
                    ))),
                };
                clear_active_operation(&state, task_id).await;
                stream
            }
            None => Err(crate::audio::AudioError::Tts(
                "speech generation was superseded".into(),
            )),
        };
        let stream = match stream {
            Ok(stream) => stream,
            Err(error) => {
                finish_audio(&state, sequence, generation, Vec::new()).await;
                complete_speech_request(
                    &state,
                    text,
                    generation,
                    result,
                    Err(error),
                    started,
                    log_spoken.then_some((sequence, route)),
                )
                .await;
                continue;
            }
        };
        // The text is visible as a fallback while the provider body drains.
        // Do this before handing the stream to the task so a concurrent next
        // request cannot accidentally reuse an undrained request id.
        state
            .0
            .mark_continuity_pending_ordered(generation, &model, sequence, text.clone());
        let operation_state = state.clone();
        let operation_text = text.clone();
        let operation_model = model.clone();
        let operation = async move {
            drain_speech_stream(
                operation_state,
                stream,
                operation_text,
                sequence,
                generation,
                operation_model,
                epoch,
            )
            .await
        };
        let Some((task, task_id)) =
            spawn_registered_operation(&state, generation, operation.instrument(span)).await
        else {
            finish_audio(&state, sequence, generation, Vec::new()).await;
            complete_speech_request(
                &state,
                text,
                generation,
                result,
                Err(crate::audio::AudioError::Tts(
                    "speech generation was superseded".into(),
                )),
                started,
                log_spoken.then_some((sequence, route)),
            )
            .await;
            continue;
        };
        // The worker is intentionally free to admit the next request while
        // this ordered drain task is still consuming the provider body.
        let completion_state = state.clone();
        let completion_text = text.clone();
        let completion_model = model.clone();
        tokio::spawn(async move {
            let synthesized = match task.await {
                Ok(result) => result,
                Err(error) if error.is_cancelled() => {
                    Err(crate::audio::AudioError::Tts("speech was cancelled".into()))
                }
                Err(error) => Err(crate::audio::AudioError::Tts(format!(
                    "speech worker failed: {error}"
                ))),
            };
            clear_active_operation(&completion_state, task_id).await;
            if synthesized.is_err() {
                completion_state.0.clear_pending_continuity_if_matching(
                    generation,
                    &completion_model,
                    epoch,
                    Some(sequence),
                    &completion_text,
                );
            }
            complete_speech_request(
                &completion_state,
                text,
                generation,
                result,
                synthesized,
                started,
                log_spoken.then_some((sequence, route)),
            )
            .await;
        });
    }
    tracing::warn!("the speech worker stopped; agent-spoken lines will not be voiced");
}

/// Send one background update through the same ordered speech worker as every
/// other utterance. The lifecycle token is checked both before reserving audio
/// and after synthesis starts; a promoted or stopped resident can never speak
/// from the old queue entry.
async fn release_floor(
    state: &AppState,
    request: FloorRequest,
    rewritten: String,
) -> ReleaseOutcome {
    if !state.0.delivery.connected() {
        return ReleaseOutcome::Retry;
    }
    let live = request.generation == state.0.coordinator.generation()
        && state
            .0
            .coordinator
            .with_background(&request.token, |project| project == request.project)
            .is_some();
    if !live {
        return ReleaseOutcome::Drop;
    }
    let mut text = rewritten.trim().to_owned();
    if text.is_empty() {
        text = request.message.clone();
    }
    // The rewrite owns any natural conversational lead-in (it is told whether
    // the line has been quiet); on rewrite failure the floor supplied the
    // minimal project-labelled fallback. Release only speaks what it is given.
    let spoken = state.0.speaker.clip_for_speech(&text);
    if spoken.is_empty() {
        return ReleaseOutcome::Played;
    }
    // The release speaks under whatever generation is current once the
    // worker has room for it; its own check below drops a request whose leg
    // changed meanwhile.
    let reserved =
        match reserve_speech(state, SpeakUnder::CurrentWhenPlaced, WhenQueueFull::Wait).await {
            Ok(reserved) => reserved,
            Err(_) => return ReleaseOutcome::Retry,
        };
    let generation = reserved.generation;
    let sequence = reserved.sequence;
    // The page may have gone while the request waited for its place; the
    // place is given back and the request waits for the page.
    if !state.0.delivery.connected() {
        release_reply_voice(state, Some(reserved), generation).await;
        return ReleaseOutcome::Retry;
    }
    // Promotion or host loss may have happened while the audio slot was
    // reserved. Do not let a stale background request cross the final speech
    // side-effect boundary.
    if request.generation != state.0.coordinator.generation()
        || state
            .0
            .coordinator
            .with_background(&request.token, |project| project == request.project)
            .is_none()
    {
        release_reply_voice(state, Some(reserved), generation).await;
        return ReleaseOutcome::Drop;
    }
    let scope = if state.0.take_foreground_audio(generation) {
        ContinuationScope::ContinueAfterForeground
    } else {
        ContinuationScope::FreshTurn
    };
    let admission = SpeechAdmission {
        text: spoken,
        route: request.project.clone(),
        generation,
        deadline: std::time::Instant::now() + state.0.speech_deadline,
        scope,
        group: state.0.new_speech_group(),
        log_spoken: true,
    };
    let floor_id = Some(request.floor_debug_id());
    let result = send_speech(state, admission, reserved).await;
    match &result {
        Ok(()) => trace_speech(state, request.project.clone(), &text, None, floor_id),
        Err(failure) => trace_speech(
            state,
            request.project.clone(),
            &text,
            Some(failure.to_string()),
            floor_id,
        ),
    }
    match result {
        Ok(()) => {
            if let Some(change) = state
                .0
                .coordinator
                .with_background(&request.token, |project| {
                    state.0.projection.floor_released(project)
                })
            {
                publish_agents(state, change);
                ReleaseOutcome::Played
            } else {
                ReleaseOutcome::Drop
            }
        }
        Err(SpeechFailure::NotSpoken(_)) => {
            finish_audio(state, sequence, generation, Vec::new()).await;
            if state.0.delivery.connected() {
                ReleaseOutcome::Drop
            } else {
                ReleaseOutcome::Retry
            }
        }
        Err(SpeechFailure::WorkerStopped) => ReleaseOutcome::Retry,
    }
}

pub(crate) async fn deliver_page_reply_if_current(
    state: &AppState,
    reply: &crate::reply::Reply,
    generation: u64,
) -> bool {
    let (voice, _transition) = match admit_reply(state, reply, generation).await {
        ReplyAdmission::Stale => return false,
        ReplyAdmission::RoutingUnavailable => return true,
        ReplyAdmission::Deliver { voice, transition } => (voice, transition),
    };
    if !reply.text.is_empty() {
        if let Some(entry) =
            state
                .0
                .transcript_log
                .lock()
                .await
                .add_voiced(AGENT, &reply.text, reply.route.clone())
        {
            emit_message(
                state,
                ServerMessage::Spoken {
                    entry,
                    sequence: voice.as_ref().map(|voice| voice.sequence),
                },
            );
        }
    }
    publish_status(state);
    drop(_transition);
    let _ = synthesize_reply_if_current(
        state,
        &reply.to_speak,
        generation,
        std::time::Instant::now() + state.0.speech_deadline,
        voice,
    )
    .await;
    generation == state.0.coordinator.generation()
}

/// What a reply may do once it reaches the line. Both delivery paths (the
/// caller's turn and a page-initiated reply) open the same way: reserve the
/// reply's voice, take the operation transition, and refuse a reply whose
/// generation has passed or whose routing was unavailable. What they show on
/// the page differs, so that stays with each caller.
enum ReplyAdmission<'a> {
    /// The generation moved on; nothing was shown or spoken.
    Stale,
    /// Routing was unavailable; the page has been told and the reply is done.
    RoutingUnavailable,
    /// Deliver it. The transition lock is held until the caller drops it.
    Deliver {
        voice: Option<ReservedSpeech<'a>>,
        transition: tokio::sync::MutexGuard<'a, ()>,
    },
}

async fn admit_reply<'a>(
    state: &'a AppState,
    reply: &crate::reply::Reply,
    generation: u64,
) -> ReplyAdmission<'a> {
    let voice = reserve_reply_voice(state, &reply.to_speak, generation).await;
    let transition = state.0.operation_transition.lock().await;
    if generation != state.0.coordinator.generation() {
        release_reply_voice(state, voice, generation).await;
        return ReplyAdmission::Stale;
    }
    if reply.error.as_deref() == Some("routing_unavailable") {
        emit_message(
            state,
            ServerMessage::RoutingUnavailable {
                message: "Routing is unavailable. Please try again.".into(),
            },
        );
        publish_status(state);
        release_reply_voice(state, voice, generation).await;
        return ReplyAdmission::RoutingUnavailable;
    }
    ReplyAdmission::Deliver { voice, transition }
}

pub(crate) async fn deliver_turn_if_current(
    state: &AppState,
    reply: &crate::reply::Reply,
    generation: u64,
    response_id: &str,
) -> bool {
    let (voice, _transition) = match admit_reply(state, reply, generation).await {
        ReplyAdmission::Stale => {
            trace_reply_speech(state, reply, Some("stale_generation"));
            return false;
        }
        ReplyAdmission::RoutingUnavailable => return true,
        ReplyAdmission::Deliver { voice, transition } => (voice, transition),
    };
    if !reply.text.is_empty() {
        state.0.transcript_log.lock().await.add_with_id_and_voiced(
            AGENT,
            &reply.text,
            reply.route.clone(),
            None,
            reply.voiced,
        );
    }
    emit_message(
        state,
        ServerMessage::Reply {
            text: reply.text.clone(),
            route: reply.route.clone(),
            voiced: reply.voiced,
            sequence: voice.as_ref().map(|voice| voice.sequence),
        },
    );
    publish_status(state);
    drop(_transition);
    let success = synthesize_reply_if_current(
        state,
        &reply.to_speak,
        generation,
        std::time::Instant::now() + state.0.speech_deadline,
        voice,
    )
    .await;
    if generation != state.0.coordinator.generation() {
        trace_reply_speech(state, reply, Some("stale_generation"));
        return false;
    }
    trace_reply_speech(state, reply, (!success).then_some("not_spoken"));
    let Some(sequence) = reserve_audio(state, generation).await else {
        return false;
    };
    let barrier = ServerMessage::FinalResponseAudioClosed {
        response_id: response_id.to_owned(),
        generation,
        success,
    }
    .to_value();
    let events = {
        let mut audio = state.0.audio.lock().await;
        audio.barrier(sequence, generation, barrier)
    };
    let _ = publish_audio_events(state, events).await;
    success
}

/// What became of speech the caller was meant to hear, for the debug page.
pub(crate) fn trace_speech(
    state: &AppState,
    agent: String,
    text: &str,
    not_delivered: Option<String>,
    floor_id: Option<String>,
) {
    state.0.debug.publish(DebugEvent::Speech {
        agent,
        text: text.to_owned(),
        delivered: not_delivered.is_none(),
        reason: not_delivered,
        floor_id,
    });
}

/// A turn's reply speech; a reply with nothing to say aloud is not speech.
fn trace_reply_speech(state: &AppState, reply: &crate::reply::Reply, not_delivered: Option<&str>) {
    if reply.to_speak.is_empty() {
        return;
    }
    trace_speech(
        state,
        reply.route.clone(),
        &reply.to_speak.join(" "),
        not_delivered.map(str::to_owned),
        None,
    );
}

pub(crate) struct SpeechAdmission {
    pub(crate) text: String,
    pub(crate) route: String,
    pub(crate) generation: u64,
    pub(crate) deadline: std::time::Instant,
    pub(crate) scope: ContinuationScope,
    pub(crate) group: SpeechGroup,
    pub(crate) log_spoken: bool,
}

/// The speech worker's queue and the state only this module reads: the
/// request channel, the receiver the worker takes once, the once-flag that
/// starts it, and the counter behind speech groups. `AppInner` holds one so
/// the fields are the speech module's own.
pub(crate) struct SpeechQueue {
    sender: mpsc::Sender<SpeechRequest>,
    receiver: Mutex<Option<mpsc::Receiver<SpeechRequest>>>,
    worker_started: AtomicBool,
    next_group: AtomicU64,
}

impl SpeechQueue {
    pub(crate) fn new() -> Self {
        let (sender, receiver) = mpsc::channel(64);
        Self {
            sender,
            receiver: Mutex::new(Some(receiver)),
            worker_started: AtomicBool::new(false),
            next_group: AtomicU64::new(1),
        }
    }

    /// A place in the speech order, when the queue has one now.
    #[cfg(test)]
    pub(crate) fn try_reserve(&self) -> Result<mpsc::Permit<'_, SpeechRequest>, ()> {
        self.sender.try_reserve().map_err(|_| ())
    }
}

/// A speech request's place in the speech worker and the audio order, taken
/// before the request itself is made. The permit comes first and then the
/// audio slot, as for every speech request.
pub(crate) struct ReservedSpeech<'a> {
    permit: mpsc::Permit<'a, SpeechRequest>,
    pub(crate) sequence: u64,
    /// The generation the audio slot was reserved under.
    pub(crate) generation: u64,
}

/// The generation a speech request speaks under. A reply knows its delivery
/// generation up front; a floor release speaks under whatever generation is
/// current once the worker has room for it, so a leg change during the wait
/// is seen by the release's own staleness check rather than refused as a
/// superseded reservation it would only retry.
#[derive(Clone, Copy)]
pub(crate) enum SpeakUnder {
    Generation(u64),
    CurrentWhenPlaced,
}

/// What a speech request does when the speech worker's queue is full.
#[derive(Clone, Copy)]
pub(crate) enum WhenQueueFull {
    Wait,
    Refuse,
}

/// Why a speech request got no place in the speech order.
pub(crate) enum ReserveFailure {
    /// The speech worker is gone, or its queue is full and the request does
    /// not wait.
    WorkerUnavailable,
    /// The generation moved on, or the audio queue is full.
    Superseded,
}

impl std::fmt::Display for ReserveFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::WorkerUnavailable => "speech worker is unavailable or busy",
            Self::Superseded => "speech generation was superseded",
        })
    }
}

pub(crate) async fn reserve_speech(
    state: &AppState,
    under: SpeakUnder,
    when_full: WhenQueueFull,
) -> Result<ReservedSpeech<'_>, ReserveFailure> {
    let permit = match when_full {
        WhenQueueFull::Wait => state.0.speech.sender.reserve().await.ok(),
        WhenQueueFull::Refuse => state.0.speech.sender.try_reserve().ok(),
    }
    .ok_or(ReserveFailure::WorkerUnavailable)?;
    let generation = match under {
        SpeakUnder::Generation(generation) => generation,
        SpeakUnder::CurrentWhenPlaced => state.0.coordinator.generation(),
    };
    let sequence = reserve_audio(state, generation)
        .await
        .ok_or(ReserveFailure::Superseded)?;
    Ok(ReservedSpeech {
        permit,
        sequence,
        generation,
    })
}

/// The first utterance of a reply that will be spoken, reserved before the
/// reply is announced so the announcement can name the audio that voices it
/// (#112): the page shows the line when that utterance starts to play. None
/// when nothing in the reply can be said aloud, or nothing could be reserved,
/// in which case the page shows the line when it arrives.
async fn reserve_reply_voice<'a>(
    state: &'a AppState,
    utterances: &[String],
    generation: u64,
) -> Option<ReservedSpeech<'a>> {
    if utterances
        .iter()
        .all(|text| state.0.speaker.clip_for_speech(text).is_empty())
    {
        return None;
    }
    reserve_speech(
        state,
        SpeakUnder::Generation(generation),
        WhenQueueFull::Wait,
    )
    .await
    .ok()
}

/// Gives back a reply's reserved first utterance that will not be spoken. Its
/// audio slot is closed, or every later utterance would wait behind it.
pub(crate) async fn release_reply_voice(
    state: &AppState,
    voice: Option<ReservedSpeech<'_>>,
    generation: u64,
) {
    if let Some(ReservedSpeech {
        permit, sequence, ..
    }) = voice
    {
        drop(permit);
        finish_audio(state, sequence, generation, Vec::new()).await;
    }
}

/// Why speech that had its place was not spoken.
pub(crate) enum SpeechFailure {
    /// The speech worker dropped the request without an answer.
    WorkerStopped,
    /// The speech worker's answer: synthesis failed, or no browser took the
    /// audio.
    NotSpoken(String),
}

impl std::fmt::Display for SpeechFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WorkerStopped => f.write_str("speech worker stopped"),
            Self::NotSpoken(detail) => f.write_str(detail),
        }
    }
}

/// Hands a speech request to the speech worker in the place `reserved` holds
/// for it, and waits for the worker's answer.
pub(crate) async fn send_speech(
    state: &AppState,
    admission: SpeechAdmission,
    reserved: ReservedSpeech<'_>,
) -> Result<(), SpeechFailure> {
    let SpeechAdmission {
        text,
        route,
        generation,
        deadline,
        scope,
        group,
        log_spoken,
    } = admission;
    let ReservedSpeech {
        permit, sequence, ..
    } = reserved;
    let (result_tx, result_rx) = oneshot::channel();
    permit.send(SpeechRequest {
        text,
        route,
        generation,
        sequence,
        deadline,
        scope,
        group,
        model: state.0.coordinator.status().model,
        log_spoken,
        result: result_tx,
        span: tracing::Span::current(),
    });
    match result_rx.await {
        Ok(answer) => answer.map_err(SpeechFailure::NotSpoken),
        Err(_) => Err(SpeechFailure::WorkerStopped),
    }
}

/// A reply's utterance, spoken in the place reserved for it, or in one it
/// waits for.
async fn queue_speech(
    state: &AppState,
    admission: SpeechAdmission,
    reserved: Option<ReservedSpeech<'_>>,
) -> Result<(), String> {
    let reserved = match reserved {
        Some(reserved) => reserved,
        None => reserve_speech(
            state,
            SpeakUnder::Generation(admission.generation),
            WhenQueueFull::Wait,
        )
        .await
        .map_err(|failure| failure.to_string())?,
    };
    send_speech(state, admission, reserved)
        .await
        .map_err(|failure| failure.to_string())
}

/// Speaks a reply's utterances in order. `first` is the slot reserved for
/// the first of them when the reply was announced (`reserve_reply_voice`).
async fn synthesize_reply_if_current(
    state: &AppState,
    utterances: &[String],
    generation: u64,
    deadline: std::time::Instant,
    mut first: Option<ReservedSpeech<'_>>,
) -> bool {
    let group = state.0.new_speech_group();
    let mut first_spoken = true;
    let mut success = true;
    for text in utterances {
        let spoken = state.0.speaker.clip_for_speech(text);
        if spoken.is_empty() {
            continue;
        }
        let scope = if first_spoken {
            first_spoken = false;
            ContinuationScope::FreshTurn
        } else {
            ContinuationScope::ContinueCurrentTurn
        };
        if let Err(error) = queue_speech(
            state,
            SpeechAdmission {
                text: spoken.clone(),
                route: state.0.coordinator.route(),
                generation,
                deadline,
                scope,
                group,
                log_spoken: false,
            },
            first.take(),
        )
        .await
        {
            if generation == state.0.coordinator.generation() {
                tracing::error!(%error, chars = spoken.chars().count(), "synthesis failed; the caller hears nothing for this reply");
            } else {
                tracing::info!(%error, "a rescue stopped this reply's speech");
            }
            success = false;
            break;
        }
    }
    release_reply_voice(state, first, generation).await;
    if success && generation == state.0.coordinator.generation() {
        state.0.mark_foreground_audio(generation);
        true
    } else {
        false
    }
}

#[cfg(test)]
pub(crate) fn start_speech_worker_for_test(state: &AppState) {
    ensure_speech_worker(state);
}

#[cfg(test)]
#[path = "../tests/test_speech.rs"]
mod tests;

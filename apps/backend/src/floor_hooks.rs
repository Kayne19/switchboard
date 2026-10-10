//! The floor worker's application-side hooks: the adapters `floor.rs`'s
//! `FloorHooks` calls to learn whether the page is connected and a request is
//! still live, to ask Jev for a good moment, to have the utility rewrite an
//! update, and to release one through the speech worker.
use crate::app_state::{publish_agents, AppInner, AppState};
use crate::debug::DebugEvent;
use crate::floor;
use crate::floor::{
    FloorHooks, FloorRequest, FloorRewriteInput, ReleaseOutcome, Waiting, WaitingHook,
};
use crate::pbx::Switchboard;
use crate::protocol::AgentRequest;
use crate::speech::{
    finish_audio, release_reply_voice, reserve_speech, send_speech, trace_speech,
    ContinuationScope, SpeakUnder, SpeechAdmission, SpeechFailure, WhenQueueFull,
};
use crate::turns::{call_summary_without_desk_sessions, jev_response_event};
use std::sync::{Arc, Weak};

pub(crate) fn spawn_floor_worker(state: AppState) {
    let floor = state.0.floor.clone();
    let connected_state = state.clone();
    let live_state = state.clone();
    let gate_state = state.clone();
    let rewrite_state = state.clone();
    let release_state = state.clone();
    let hooks = FloorHooks {
        connected: Arc::new(move || connected_state.0.delivery.connected()),
        live: Arc::new(move |request: &FloorRequest| still_live(&live_state, request)),
        gate: Arc::new(move |request: &FloorRequest| {
            let state = gate_state.clone();
            let request = request.clone();
            Box::pin(async move {
                let entries = state.0.transcript_log.lock().await.entries();
                let screen = state.0.display_gate.lock().await.screen().to_value();
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

/// Mirrors the floor's word on who is waiting to speak into the agent
/// projection, for a token that is still a background resident, and sends the
/// change to the page. The floor calls it under its lock (`Waiting`).
pub(crate) fn waiting_hook(app: Weak<AppInner>) -> WaitingHook {
    Arc::new(move |waiting: Waiting<'_>| {
        let Some(app) = app.upgrade() else { return };
        let state = AppState(app);
        let projection = &state.0.projection;
        let change = match waiting {
            Waiting::Asked(request) => {
                state
                    .0
                    .coordinator
                    .with_background(&request.token, |project| {
                        projection.waiting(
                            project.to_owned(),
                            AgentRequest {
                                message: request.message.clone(),
                                reason: request.reason.clone(),
                            },
                        )
                    })
            }
            Waiting::Spoken(request) => state
                .0
                .coordinator
                .with_background(&request.token, |project| projection.floor_released(project)),
        };
        if let Some(change) = change {
            publish_agents(&state, change);
        }
    })
}

/// Whether `request` may still be spoken: it was queued under the current
/// generation, and its token is still a background resident of its project.
/// The floor asks before and after the rewrite, and the release before it
/// reserves audio and again once it has it; all four are this one check.
fn still_live(state: &AppState, request: &FloorRequest) -> bool {
    request.generation == state.0.coordinator.generation()
        && state
            .0
            .coordinator
            .with_background(&request.token, |project| project == request.project)
            == Some(true)
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
    if !still_live(state, &request) {
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
    if !still_live(state, &request) {
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
        // Spoken. The floor ends the agent's waiting mark when it lets the
        // request go (`Waiting::Spoken`); a resident that went while it was
        // spoken is reported gone.
        Ok(()) if state.0.coordinator.is_background(&request.token) => ReleaseOutcome::Played,
        Ok(()) => ReleaseOutcome::Drop,
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

#[cfg(test)]
#[path = "../tests/test_floor_hooks.rs"]
mod tests;

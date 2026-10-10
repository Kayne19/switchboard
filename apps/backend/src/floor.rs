//! The speech floor for background-agent updates.
//!
//! `Floor` is the only owner of the request queue and its release order.  The
//! application supplies small callbacks for Jev, the stateless rewrite
//! process, and audio delivery; lifecycle and presentation mutations remain in
//! their existing owners.
use crate::debug::{DebugBus, DebugEvent};
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};
use tokio::time::{sleep_until, Duration, Instant};

/// Rewrite work is best effort and must not delay a queued announcement.
pub(crate) const REWRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a release that could not get its audio waits before it tries
/// again, when no floor event wakes it first. Audio slots free up as clips
/// finish, and nothing tells the floor when.
const RETRY_AFTER: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FloorRequest {
    /// Links one message's floor events on the debug page. `Floor::enqueue`
    /// assigns it; whatever the caller set is replaced.
    pub floor_id: u64,
    pub project: String,
    pub token: String,
    /// The lifecycle generation at admission. A route rescue during rewrite
    /// makes this request stale even if the resident token is still present.
    pub generation: u64,
    /// A small snapshot of the recent conversation, used to make the spoken
    /// update flow naturally from what the caller just heard.
    pub context: String,
    pub message: String,
    pub reason: String,
    /// Whether this agent has a display buffered that the caller has not seen.
    pub held_display: bool,
}

impl FloorRequest {
    /// The id the debug page links this message's floor events by.
    pub(crate) fn floor_debug_id(&self) -> String {
        format!("floor-{}", self.floor_id)
    }
}

/// All information the floor rewrite model needs. The caller's recent context
/// is captured when the request is queued; `quiet` is computed at release time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FloorRewriteInput {
    pub context: String,
    pub project: String,
    pub quiet: bool,
    pub message: String,
    pub reason: String,
    /// Whether this agent has a display buffered that the caller has not seen.
    pub held_display: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReleaseOutcome {
    /// The message was played and can leave the queue.
    Played,
    /// The page went away or audio could not be reserved. Keep the request.
    Retry,
    /// The lifecycle owner says the request's agent is gone. Drop it.
    Drop,
}

pub(crate) type GateFuture = Pin<Box<dyn Future<Output = Result<bool, ()>> + Send>>;
pub(crate) type RewriteFuture = Pin<Box<dyn Future<Output = Result<String, ()>> + Send>>;
pub(crate) type ReleaseFuture = Pin<Box<dyn Future<Output = ReleaseOutcome> + Send>>;

/// Hooks are adapters, not owners. The callbacks must re-check lifecycle
/// identity immediately before every side effect because promotion or host
/// loss may race a queued release.
#[derive(Clone)]
pub(crate) struct FloorHooks {
    pub connected: Arc<dyn Fn() -> bool + Send + Sync>,
    pub live: Arc<dyn Fn(&FloorRequest) -> bool + Send + Sync>,
    pub gate: Arc<dyn Fn(&FloorRequest) -> GateFuture + Send + Sync>,
    pub rewrite: Arc<dyn Fn(FloorRewriteInput) -> RewriteFuture + Send + Sync>,
    pub release: Arc<dyn Fn(FloorRequest, String) -> ReleaseFuture + Send + Sync>,
}

#[derive(Clone)]
struct QueuedRequest {
    request: FloorRequest,
    /// A failed Jev request is not retried. It is released at the next quiet
    /// moment, as required by the floor contract. The timestamp starts after
    /// the rejection, so an already-quiet line cannot release immediately.
    held_after: Option<Instant>,
}

struct FloorState {
    queue: VecDeque<QueuedRequest>,
    caller_last_spoke: Instant,
    page_connected: bool,
}

/// One ordered queue for all background requests.
#[derive(Clone)]
pub(crate) struct Floor {
    state: Arc<Mutex<FloorState>>,
    changed: Arc<Notify>,
    quiet_threshold: Duration,
    next_id: Arc<std::sync::atomic::AtomicU64>,
    /// Read-only observer; the queue never waits on it.
    debug: DebugBus,
}

impl Floor {
    pub(crate) fn new(quiet_threshold: Duration) -> Self {
        Self {
            state: Arc::new(Mutex::new(FloorState {
                queue: VecDeque::new(),
                caller_last_spoke: Instant::now(),
                page_connected: false,
            })),
            changed: Arc::new(Notify::new()),
            quiet_threshold,
            next_id: Arc::new(std::sync::atomic::AtomicU64::new(1)),
            debug: DebugBus::off(),
        }
    }

    /// Report the queue's steps to `debug`.
    pub(crate) fn with_debug(mut self, debug: DebugBus) -> Self {
        self.debug = debug;
        self
    }

    /// Queues `request`. An agent has at most one request waiting: a newer
    /// one takes the place of the one it already has behind the front, and
    /// that one's trace ends as `replaced`. The front is not replaced, as it
    /// may already be on its way to the caller. So the queue holds at most
    /// two requests per agent, however often one asks (#252); the projection
    /// shows only the newest request too (`AgentProjection::waiting`).
    pub(crate) async fn enqueue(&self, mut request: FloorRequest) {
        let mut state = self.state.lock().await;
        let waiting = state
            .queue
            .iter()
            .skip(1)
            .position(|entry| entry.request.token == request.token)
            .map(|index| index + 1);
        request.floor_id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.debug.publish(DebugEvent::FloorRequest {
            agent: request.project.clone(),
            message: request.message.clone(),
            floor_id: Some(request.floor_debug_id()),
        });
        let entry = QueuedRequest {
            request,
            held_after: None,
        };
        match waiting.and_then(|index| state.queue.get_mut(index)) {
            Some(slot) => {
                let replaced = std::mem::replace(slot, entry);
                self.trace_released(&replaced.request, "replaced");
            }
            None => state.queue.push_back(entry),
        }
        drop(state);
        self.changed.notify_waiters();
    }

    pub(crate) async fn caller_spoke(&self) {
        self.state.lock().await.caller_last_spoke = Instant::now();
        self.changed.notify_waiters();
    }

    pub(crate) async fn set_page_connected(&self, connected: bool) {
        self.state.lock().await.page_connected = connected;
        self.changed.notify_waiters();
    }

    #[cfg(test)]
    pub(crate) async fn queue_len(&self) -> usize {
        self.state.lock().await.queue.len()
    }

    #[cfg(test)]
    pub(crate) async fn force_quiet_for_test(&self) {
        let mut state = self.state.lock().await;
        let quiet_at = Instant::now() - self.quiet_threshold - Duration::from_millis(1);
        state.caller_last_spoke = quiet_at;
        if let Some(entry) = state.queue.front_mut() {
            if entry.held_after.is_some() {
                entry.held_after = Some(quiet_at);
            }
        }
        self.changed.notify_waiters();
    }

    #[cfg(test)]
    pub(crate) async fn force_not_quiet_for_test(&self) {
        let mut state = self.state.lock().await;
        state.caller_last_spoke = Instant::now();
        self.changed.notify_waiters();
    }

    /// Run the queue until the task is cancelled. The queue entry is retained
    /// through Jev, rewriting, and synthesis; this makes a disconnect or
    /// promotion race fail closed without losing a message that is still
    /// owned by a live background session.
    pub(crate) async fn run(&self, hooks: FloorHooks) {
        loop {
            let (entry, quiet) = self.next_ready(&hooks).await;
            if !(hooks.live)(&entry.request) {
                self.trace_released(&entry.request, "dropped_agent_gone");
                self.drop_front(&entry.request).await;
                continue;
            }
            let input = FloorRewriteInput {
                context: entry.request.context.clone(),
                project: entry.request.project.clone(),
                quiet,
                message: entry.request.message.clone(),
                reason: entry.request.reason.clone(),
                held_display: entry.request.held_display,
            };
            // Without a rewrite the message is spoken as the agent wrote it:
            // it is already in the speaker's own voice.
            let started = Instant::now();
            let rewritten = (hooks.rewrite)(input)
                .await
                .unwrap_or_else(|_| entry.request.message.clone());
            self.debug.publish(DebugEvent::FloorRewrite {
                agent: entry.request.project.clone(),
                original: entry.request.message.clone(),
                rewritten: rewritten.clone(),
                latency_ms: elapsed_ms(started),
                floor_id: Some(entry.request.floor_debug_id()),
            });
            if !(hooks.live)(&entry.request) {
                self.trace_released(&entry.request, "dropped_agent_gone");
                self.drop_front(&entry.request).await;
                continue;
            }
            // Listening before the release, so a page that comes back while
            // it runs is not missed.
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let outcome = (hooks.release)(entry.request.clone(), rewritten).await;
            match outcome {
                ReleaseOutcome::Played | ReleaseOutcome::Drop => {
                    let how = match outcome {
                        ReleaseOutcome::Drop => "dropped_agent_gone",
                        _ if entry.held_after.is_some() => "quiet_after_hold",
                        _ => "gate_yes",
                    };
                    self.trace_released(&entry.request, how);
                    self.drop_front(&entry.request).await;
                }
                ReleaseOutcome::Retry => {
                    // A page disconnect wakes the queue. A failed audio
                    // reservation tries again after `RETRY_AFTER` at most,
                    // and never spins.
                    let _ = tokio::time::timeout(RETRY_AFTER, changed).await;
                }
            }
        }
    }

    /// The next request that may be spoken, and whether the line has been
    /// quiet for the threshold (the rewrite eases in with the project name
    /// when it has).
    async fn next_ready(&self, hooks: &FloorHooks) -> (QueuedRequest, bool) {
        loop {
            // Listening before the state is read: `notify_waiters` stores no
            // permit, so a request queued between the read and the wait
            // would otherwise sleep until some later floor event.
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let (entry, wait_until, quiet, blocked_by_page) = {
                let state = self.state.lock().await;
                let Some(entry) = state.queue.front().cloned() else {
                    drop(state);
                    changed.await;
                    continue;
                };
                if !state.page_connected || !(hooks.connected)() {
                    (entry, None, false, true)
                } else {
                    let quiet_baseline = entry
                        .held_after
                        .map_or(state.caller_last_spoke, |held_after| {
                            held_after.max(state.caller_last_spoke)
                        });
                    let quiet_at = quiet_baseline + self.quiet_threshold;
                    let quiet = Instant::now() >= quiet_at;
                    if entry.held_after.is_some() && !quiet {
                        (entry, Some(quiet_at), false, false)
                    } else {
                        (entry, None, quiet, false)
                    }
                }
            };
            if blocked_by_page {
                changed.await;
                continue;
            }
            if let Some(deadline) = wait_until {
                tokio::select! {
                    _ = sleep_until(deadline) => {},
                    _ = changed => {},
                }
                continue;
            }
            if !(hooks.connected)() {
                changed.await;
                continue;
            }
            // A Jev failure/negative answer is held until quiet. The next
            // quiet moment deliberately bypasses Jev: retrying the failed gate
            // would turn an outage into an unbounded queue.
            let held = {
                let state = self.state.lock().await;
                state
                    .queue
                    .front()
                    .is_some_and(|item| item.held_after.is_some())
            };
            if !held {
                let started = Instant::now();
                let answer = (hooks.gate)(&entry.request).await;
                self.debug.publish(DebugEvent::FloorGate {
                    agent: entry.request.project.clone(),
                    answer: match answer {
                        Ok(true) => "yes",
                        Ok(false) => "no",
                        Err(()) => "failed",
                    }
                    .into(),
                    latency_ms: elapsed_ms(started),
                    floor_id: Some(entry.request.floor_debug_id()),
                });
                match answer {
                    Ok(true) => {}
                    Ok(false) | Err(()) => {
                        self.debug.publish(DebugEvent::FloorHeld {
                            agent: entry.request.project.clone(),
                            message: entry.request.message.clone(),
                            floor_id: Some(entry.request.floor_debug_id()),
                        });
                        let mut state = self.state.lock().await;
                        if let Some(item) = state.queue.front_mut() {
                            item.held_after = Some(Instant::now());
                        }
                        self.changed.notify_waiters();
                        continue;
                    }
                }
            }
            return (entry, quiet);
        }
    }

    fn trace_released(&self, request: &FloorRequest, how: &str) {
        self.debug.publish(DebugEvent::FloorReleased {
            agent: request.project.clone(),
            how: how.to_owned(),
            floor_id: Some(request.floor_debug_id()),
        });
    }

    async fn drop_front(&self, request: &FloorRequest) {
        let mut state = self.state.lock().await;
        if state
            .queue
            .front()
            .is_some_and(|entry| entry.request == *request)
        {
            state.queue.pop_front();
        }
        self.changed.notify_waiters();
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
#[path = "../tests/test_floor.rs"]
mod tests;

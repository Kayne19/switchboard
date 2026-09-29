//! The speech floor for background-agent updates.
//!
//! `Floor` is the only owner of the request queue and its release order.  The
//! application supplies small callbacks for Jev, the stateless rewrite
//! process, and audio delivery; lifecycle and presentation mutations remain in
//! their existing owners.
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};
use tokio::time::{sleep_until, Duration, Instant};

/// Rewrite work is best effort and must not delay a queued announcement.
#[allow(dead_code)]
pub(crate) const REWRITE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FloorRequest {
    pub project: String,
    pub token: String,
    pub message: String,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)]
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
    pub rewrite: Arc<dyn Fn(&FloorRequest) -> RewriteFuture + Send + Sync>,
    pub release: Arc<dyn Fn(FloorRequest, String, bool) -> ReleaseFuture + Send + Sync>,
}

#[derive(Clone)]
struct QueuedRequest {
    request: FloorRequest,
    /// A failed Jev request is not retried. It is released at the next quiet
    /// moment, as required by the floor contract.
    held_until_quiet: bool,
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
        }
    }

    pub(crate) async fn enqueue(&self, request: FloorRequest) {
        self.state.lock().await.queue.push_back(QueuedRequest {
            request,
            held_until_quiet: false,
        });
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
        state.caller_last_spoke = Instant::now() - self.quiet_threshold - Duration::from_millis(1);
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
            let (entry, announce) = self.next_ready(&hooks).await;
            if !(hooks.live)(&entry.request) {
                self.drop_front(&entry.request).await;
                continue;
            }
            let rewritten = (hooks.rewrite)(&entry.request)
                .await
                .unwrap_or_else(|_| entry.request.message.clone());
            if !(hooks.live)(&entry.request) {
                self.drop_front(&entry.request).await;
                continue;
            }
            let outcome = (hooks.release)(entry.request.clone(), rewritten, announce).await;
            match outcome {
                ReleaseOutcome::Played | ReleaseOutcome::Drop => {
                    self.drop_front(&entry.request).await;
                }
                ReleaseOutcome::Retry => {
                    // A page disconnect wakes the queue. A failed audio
                    // reservation is treated the same way and never spins.
                    self.changed.notified().await;
                }
            }
        }
    }

    async fn next_ready(&self, hooks: &FloorHooks) -> (QueuedRequest, bool) {
        loop {
            let (entry, wait_until, announce, blocked_by_page) = {
                let state = self.state.lock().await;
                let Some(entry) = state.queue.front().cloned() else {
                    drop(state);
                    self.changed.notified().await;
                    continue;
                };
                if !state.page_connected || !(hooks.connected)() {
                    (entry, None, false, true)
                } else {
                    let quiet_at = state.caller_last_spoke + self.quiet_threshold;
                    let quiet = Instant::now() >= quiet_at;
                    if entry.held_until_quiet && !quiet {
                        (entry, Some(quiet_at), false, false)
                    } else {
                        (entry, None, quiet, false)
                    }
                }
            };
            if blocked_by_page {
                self.changed.notified().await;
                continue;
            }
            if let Some(deadline) = wait_until {
                tokio::select! {
                    _ = sleep_until(deadline) => {},
                    _ = self.changed.notified() => {},
                }
                continue;
            }
            if !(hooks.connected)() {
                self.changed.notified().await;
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
                    .is_some_and(|item| item.held_until_quiet)
            };
            if !held {
                match (hooks.gate)(&entry.request).await {
                    Ok(true) => {}
                    Ok(false) | Err(()) => {
                        let mut state = self.state.lock().await;
                        if let Some(item) = state.queue.front_mut() {
                            item.held_until_quiet = true;
                        }
                        self.changed.notify_waiters();
                        continue;
                    }
                }
            }
            return (entry, announce);
        }
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

#[cfg(test)]
#[path = "../tests/test_floor.rs"]
mod tests;

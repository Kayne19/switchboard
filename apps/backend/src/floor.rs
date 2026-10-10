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
use tokio::sync::futures::Notified;
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

/// What the floor tells the agent projection about an agent's request to
/// speak. The floor decides who is waiting; the projection mirrors it (#388).
/// The hook runs under the floor's lock, so a mark and the queue change it
/// reports cannot be reordered by another request or release.
pub(crate) enum Waiting<'a> {
    /// The agent asked to speak; `request` is now its newest on the floor.
    Asked(&'a FloorRequest),
    /// The agent's last request on the floor was spoken.
    Spoken(&'a FloorRequest),
}

pub(crate) type WaitingHook = Arc<dyn Fn(Waiting<'_>) + Send + Sync>;

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

struct FloorState {
    queue: VecDeque<FloorRequest>,
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
    /// Where the floor reports who is waiting to speak.
    waiting: WaitingHook,
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
            waiting: Arc::new(|_| {}),
        }
    }

    /// Report the queue's steps to `debug`.
    pub(crate) fn with_debug(mut self, debug: DebugBus) -> Self {
        self.debug = debug;
        self
    }

    /// Report who is waiting to speak to `waiting`.
    pub(crate) fn with_waiting(mut self, waiting: WaitingHook) -> Self {
        self.waiting = waiting;
        self
    }

    /// Queues `request`. An agent has at most one request waiting: a newer
    /// one takes the place of the one it already has behind the front, and
    /// that one's trace ends as `replaced`. The front is not replaced, as it
    /// may already be on its way to the caller. So the queue holds at most
    /// two requests per agent, however often one asks (#252). The agent is
    /// marked waiting with its newest request (`Waiting::Asked`).
    pub(crate) async fn enqueue(&self, mut request: FloorRequest) {
        let mut state = self.state.lock().await;
        let waiting = state
            .queue
            .iter()
            .skip(1)
            .position(|entry| entry.token == request.token)
            .map(|index| index + 1);
        request.floor_id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.debug.publish(DebugEvent::FloorRequest {
            agent: request.project.clone(),
            message: request.message.clone(),
            floor_id: Some(request.floor_debug_id()),
        });
        (self.waiting)(Waiting::Asked(&request));
        match waiting.and_then(|index| state.queue.get_mut(index)) {
            Some(slot) => {
                let replaced = std::mem::replace(slot, request);
                self.trace_released(&replaced, "replaced");
            }
            None => state.queue.push_back(request),
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

    /// The caller last spoke longer than the threshold ago. A held request
    /// still waits the threshold from its hold: the hold belongs to the
    /// worker's `FrontPhase`, which nothing outside the worker writes.
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

    /// Runs the queue until the task is cancelled: takes the front request,
    /// drives it through its phases until it leaves, then takes the next. The
    /// request stays at the front of the queue through Jev, the rewrite and
    /// the release, so a lost page or a promotion fails closed without losing
    /// a message a live background session still owns.
    pub(crate) async fn run(&self, hooks: FloorHooks) {
        let mut listener = self.listen();
        loop {
            let front = self.state.lock().await.queue.front().cloned();
            let Some(request) = front else {
                listener.as_mut().await;
                listener = self.listen();
                continue;
            };
            let left = self.serve(&hooks, &request, &mut listener).await;
            self.leave(&request, left).await;
            listener = self.listen();
        }
    }

    /// Drives the front request until it leaves the floor. `step` decides
    /// every move; this only does what the phase asks for and reports it.
    async fn serve<'floor>(
        &'floor self,
        hooks: &FloorHooks,
        request: &FloorRequest,
        listener: &mut Listener<'floor>,
    ) -> Left {
        let mut phase = FrontPhase::Reading { hold: None };
        loop {
            let event = self.act(&phase, hooks, request, listener).await;
            match step(phase, event, Instant::now()) {
                Step::Next(next) => phase = next,
                Step::Left(left) => return left,
            }
        }
    }

    /// What the worker does in `phase`, as the event `step` reads. A phase
    /// that waits does so on `listener`, which was listening before the read
    /// or the release that put the worker in that phase (#252).
    async fn act<'floor>(
        &'floor self,
        phase: &FrontPhase,
        hooks: &FloorHooks,
        request: &FloorRequest,
        listener: &mut Listener<'floor>,
    ) -> FloorEvent {
        match phase {
            FrontPhase::Reading { .. } => self.read(hooks, listener).await,
            FrontPhase::AwaitingPage { .. } => {
                listener.as_mut().await;
                self.read(hooks, listener).await
            }
            FrontPhase::AwaitingQuiet { until, .. } => {
                tokio::select! {
                    _ = sleep_until(*until) => {},
                    _ = listener.as_mut() => {},
                }
                self.read(hooks, listener).await
            }
            FrontPhase::Gating { .. } => {
                FloorEvent::GateAnswered(self.ask_gate(hooks, request).await)
            }
            FrontPhase::Rewriting { quiet, .. } => self.rewrite(hooks, request, *quiet).await,
            FrontPhase::Releasing { words, .. } => {
                // Listening before the release, so a floor event while it
                // runs ends a retry at once.
                *listener = self.listen();
                match (hooks.release)(request.clone(), words.clone()).await {
                    ReleaseOutcome::Played => FloorEvent::Played,
                    ReleaseOutcome::Drop => FloorEvent::AgentGone,
                    ReleaseOutcome::Retry => FloorEvent::NotReleased {
                        page: (hooks.connected)(),
                    },
                }
            }
            FrontPhase::RetryingRelease { next, .. } => {
                tokio::select! {
                    _ = sleep_until(*next) => FloorEvent::RetryDue,
                    _ = listener.as_mut() => FloorEvent::FloorChanged,
                }
            }
        }
    }

    /// A listener for the next floor event, enabled now. `notify_waiters`
    /// stores no permit, so a listener made after a read would miss an event
    /// that landed between the read and the wait (#252).
    fn listen(&self) -> Listener<'_> {
        let mut listener = Box::pin(self.changed.notified());
        listener.as_mut().enable();
        listener
    }

    /// Reads the floor, after listening for its next change.
    async fn read<'floor>(
        &'floor self,
        hooks: &FloorHooks,
        listener: &mut Listener<'floor>,
    ) -> FloorEvent {
        *listener = self.listen();
        let state = self.state.lock().await;
        FloorEvent::Read(FloorView {
            page: state.page_connected && (hooks.connected)(),
            caller_last_spoke: state.caller_last_spoke,
            quiet_threshold: self.quiet_threshold,
        })
    }

    /// Asks Jev whether now is a good moment, and traces the answer and the
    /// hold a no or a failure puts on the request.
    async fn ask_gate(&self, hooks: &FloorHooks, request: &FloorRequest) -> Result<bool, ()> {
        let started = Instant::now();
        let answer = (hooks.gate)(request).await;
        self.debug.publish(DebugEvent::FloorGate {
            agent: request.project.clone(),
            answer: match answer {
                Ok(true) => "yes",
                Ok(false) => "no",
                Err(()) => "failed",
            }
            .into(),
            latency_ms: elapsed_ms(started),
            floor_id: Some(request.floor_debug_id()),
        });
        if answer != Ok(true) {
            self.debug.publish(DebugEvent::FloorHeld {
                agent: request.project.clone(),
                message: request.message.clone(),
                floor_id: Some(request.floor_debug_id()),
            });
        }
        answer
    }

    /// Rewrites the request for the caller, between two checks that its agent
    /// is still live: one before the utility is asked, one before the words
    /// go to the release. Without a rewrite the message is spoken as the
    /// agent wrote it: it is already in the speaker's own voice.
    async fn rewrite(&self, hooks: &FloorHooks, request: &FloorRequest, quiet: bool) -> FloorEvent {
        if !(hooks.live)(request) {
            return FloorEvent::AgentGone;
        }
        let input = FloorRewriteInput {
            context: request.context.clone(),
            project: request.project.clone(),
            quiet,
            message: request.message.clone(),
            reason: request.reason.clone(),
            held_display: request.held_display,
        };
        let started = Instant::now();
        let words = (hooks.rewrite)(input)
            .await
            .unwrap_or_else(|_| request.message.clone());
        self.debug.publish(DebugEvent::FloorRewrite {
            agent: request.project.clone(),
            original: request.message.clone(),
            rewritten: words.clone(),
            latency_ms: elapsed_ms(started),
            floor_id: Some(request.floor_debug_id()),
        });
        if !(hooks.live)(request) {
            return FloorEvent::AgentGone;
        }
        FloorEvent::Rewritten(words)
    }

    fn trace_released(&self, request: &FloorRequest, how: &str) {
        self.debug.publish(DebugEvent::FloorReleased {
            agent: request.project.clone(),
            how: how.to_owned(),
            floor_id: Some(request.floor_debug_id()),
        });
    }

    /// The front request's teardown, whichever phase it left from: its trace,
    /// its place in the queue, and, when it was spoken and was its agent's
    /// last request on the floor, the agent's waiting mark.
    async fn leave(&self, request: &FloorRequest, left: Left) {
        self.trace_released(request, left.how());
        let mut state = self.state.lock().await;
        if state.queue.front() == Some(request) {
            state.queue.pop_front();
        }
        let still_waiting = state.queue.iter().any(|entry| entry.token == request.token);
        if matches!(left, Left::Played(_)) && !still_waiting {
            (self.waiting)(Waiting::Spoken(request));
        }
        drop(state);
        self.changed.notify_waiters();
    }
}

/// A listener for the floor's next change; see `Floor::listen`.
type Listener<'floor> = Pin<Box<Notified<'floor>>>;

/// How the front request earned its release.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Clearance {
    /// Jev said now is a good moment.
    GateYes,
    /// Jev said no, or could not answer, at `held_since`, and the line has
    /// since been quiet for the threshold. Retrying a failed gate would turn
    /// an outage into an unbounded queue, so a held request is never gated
    /// again: not after a lost page, not after a release that could not run.
    QuietAfterHold { held_since: Instant },
}

impl Clearance {
    fn hold(self) -> Option<Instant> {
        match self {
            Clearance::GateYes => None,
            Clearance::QuietAfterHold { held_since } => Some(held_since),
        }
    }
}

/// Where the front request is, from reaching the front of the queue until it
/// leaves. Each phase carries what is valid in it; `step` is the only writer.
#[derive(Clone, Debug, PartialEq, Eq)]
enum FrontPhase {
    /// Read the floor now: the request just reached the front, Jev just held
    /// it, or a release could not run and the moment has changed.
    Reading { hold: Option<Instant> },
    /// No page to speak to: wait for a floor event.
    AwaitingPage { hold: Option<Instant> },
    /// Held: wait until the line has been quiet for the threshold since the
    /// hold and since the caller's last words.
    AwaitingQuiet { held_since: Instant, until: Instant },
    /// Asking Jev for a good moment. `quiet` is the line as read before.
    Gating { quiet: bool },
    /// Asking the utility for the words. `quiet` lets it ease in.
    Rewriting { quiet: bool, clearance: Clearance },
    /// Speaking `words` through the release hook.
    Releasing { words: String, clearance: Clearance },
    /// The release could not get its audio. Audio slots free up as clips
    /// finish, and nothing tells the floor when: try the same words again at
    /// `next`, without asking Jev or the utility again, unless the floor
    /// changes first.
    RetryingRelease {
        words: String,
        clearance: Clearance,
        next: Instant,
    },
}

/// The floor as the worker read it, under the floor's lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FloorView {
    /// The floor's page flag and the delivery hook both say a page is there.
    page: bool,
    caller_last_spoke: Instant,
    quiet_threshold: Duration,
}

/// What happened to the front request in its phase. Each comes from the
/// phase's own action in `Floor::act`, so none can arrive for another phase.
#[derive(Clone, Debug, PartialEq, Eq)]
enum FloorEvent {
    Read(FloorView),
    GateAnswered(Result<bool, ()>),
    Rewritten(String),
    /// The live check, or the release, says the request's agent is gone.
    AgentGone,
    Played,
    /// The release could not get its audio; `page` is whether a page is there.
    NotReleased {
        page: bool,
    },
    RetryDue,
    FloorChanged,
}

/// How the front request left the floor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Left {
    Played(Clearance),
    AgentGone,
}

impl Left {
    /// The `FloorReleased` trace's `how`.
    fn how(self) -> &'static str {
        match self {
            Left::Played(Clearance::GateYes) => "gate_yes",
            Left::Played(Clearance::QuietAfterHold { .. }) => "quiet_after_hold",
            Left::AgentGone => "dropped_agent_gone",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Step {
    Next(FrontPhase),
    Left(Left),
}

/// The front request's one transition: the phase it is in and what happened
/// there give the next phase, or how it leaves. Pure, so its table is tested
/// without a worker. An event a phase does not wait for changes nothing.
fn step(phase: FrontPhase, event: FloorEvent, now: Instant) -> Step {
    use FloorEvent as Event;
    use FrontPhase as Phase;
    let next = match phase {
        Phase::Reading { hold } | Phase::AwaitingPage { hold } => match event {
            Event::Read(view) => after_reading(hold, view, now),
            _ => phase,
        },
        Phase::AwaitingQuiet { held_since, .. } => match event {
            Event::Read(view) => after_reading(Some(held_since), view, now),
            _ => phase,
        },
        Phase::Gating { quiet } => match event {
            Event::GateAnswered(Ok(true)) => Phase::Rewriting {
                quiet,
                clearance: Clearance::GateYes,
            },
            Event::GateAnswered(Ok(false) | Err(())) => Phase::Reading { hold: Some(now) },
            _ => phase,
        },
        Phase::Rewriting { clearance, .. } => match event {
            Event::Rewritten(words) => Phase::Releasing { words, clearance },
            Event::AgentGone => return Step::Left(Left::AgentGone),
            _ => phase,
        },
        Phase::Releasing { words, clearance } => match event {
            Event::Played => return Step::Left(Left::Played(clearance)),
            Event::AgentGone => return Step::Left(Left::AgentGone),
            Event::NotReleased { page: true } => Phase::RetryingRelease {
                words,
                clearance,
                next: now + RETRY_AFTER,
            },
            // The page went: wait for it, and gate again unless held, as
            // the moment has changed.
            Event::NotReleased { page: false } => Phase::Reading {
                hold: clearance.hold(),
            },
            _ => Phase::Releasing { words, clearance },
        },
        Phase::RetryingRelease {
            words,
            clearance,
            next,
        } => match event {
            Event::RetryDue => Phase::Releasing { words, clearance },
            Event::FloorChanged => Phase::Reading {
                hold: clearance.hold(),
            },
            _ => Phase::RetryingRelease {
                words,
                clearance,
                next,
            },
        },
    };
    Step::Next(next)
}

/// Where a read of the floor puts the front request.
fn after_reading(hold: Option<Instant>, view: FloorView, now: Instant) -> FrontPhase {
    if !view.page {
        return FrontPhase::AwaitingPage { hold };
    }
    match hold {
        None => FrontPhase::Gating {
            quiet: now >= view.caller_last_spoke + view.quiet_threshold,
        },
        Some(held_since) => {
            // The hold starts the quiet period, so an already-quiet line
            // cannot release the moment Jev says no.
            let until = held_since.max(view.caller_last_spoke) + view.quiet_threshold;
            if now < until {
                FrontPhase::AwaitingQuiet { held_since, until }
            } else {
                FrontPhase::Rewriting {
                    quiet: true,
                    clearance: Clearance::QuietAfterHold { held_since },
                }
            }
        }
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
#[path = "../tests/test_floor.rs"]
mod tests;

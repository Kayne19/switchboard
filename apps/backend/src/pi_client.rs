//! The local pi process: the operator and the routing utility, each a `pi
//! --mode rpc` child over stdio, one turn in, text and signals out. Also the
//! process-tree helpers other local children share, and `LegSession`, the leg
//! on the line as the application's controls see it. A project session over
//! the host link is in `project_session.rs`.
use crate::debug::{DebugBus, DebugEvent};
use crate::project_session::{ProjectSession, QueuedSteer};
use futures_util::FutureExt;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock as StdOnceLock, PoisonError};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, Command};
use tokio::sync::{watch, Mutex};
use tokio::time::{timeout, timeout_at, Duration, Instant};

pub const STREAM_LIMIT: usize = 16 * 1024 * 1024;
pub const ROUTE_TOOL: &str = "route";
pub const SECOND_OPINION_TOOL: &str = "second_opinion";
pub const DISPATCH_PARTS_TOOL: &str = "dispatch_parts";
pub const REWRITE_TOOL: &str = "rewrite";
pub const SPEAK_TOOL: &str = "speak";
const ERROR_STOP_REASON: &str = "error";
const ERROR_DETAIL_CHARS: usize = 160;
const ACTIVITY_DETAIL_CHARS: usize = 80;
const STDERR_LINE_LIMIT: usize = 16 * 1024;
/// How long a failure report waits for a process that has stopped talking
/// to exit and finish saying why on stderr.
const EXIT_REPORT_GRACE: Duration = Duration::from_secs(5);

const ACTIVITY_ARG_ORDER: [&str; 11] = [
    "path",
    "file_path",
    "filePath",
    "command",
    "pattern",
    "query",
    "url",
    "description",
    "symbol",
    "project",
    "text",
];

#[derive(Clone, Debug, PartialEq)]
pub struct Signal {
    pub name: String,
    pub args: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Turn {
    pub text: String,
    pub signals: Vec<Signal>,
    pub failed: bool,
    pub error: String,
}

#[derive(Debug)]
pub struct PiSessionError(pub String);
impl fmt::Display for PiSessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for PiSessionError {}

/// An RPC event worth reporting: a tool call starting or ending, or the
/// turn's first sign of life.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Activity {
    pub state: String,
    pub tool: String,
    pub detail: String,
    /// The name the page shows for the process's leg.
    pub label: String,
    /// The token of the leg the process was started for: `operator` for the
    /// operator, the leg's session token for a project leg.
    pub leg: String,
}
pub type ActivityCallback =
    Arc<dyn Fn(Activity) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

struct SessionInner {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    stdout: Mutex<BufReader<tokio::process::ChildStdout>>,
    stderr_tail: Arc<StdMutex<Vec<String>>>,
    /// What the process can do now. Written only by `transition`.
    state: StdMutex<ProcessState>,
    turn_lock: Mutex<()>,
    label: String,
    leg: String,
    turn_timeout: Duration,
    on_activity: Option<ActivityCallback>,
    stderr_task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
    /// True once stderr has been read to its end.
    stderr_closed: watch::Receiver<bool>,
    process_guard: ProcessTreeGuard,
    /// Where this process's conversation is mirrored for the debug page.
    /// Observation only: nothing here waits on it.
    debug: StdOnceLock<DebugBus>,
    /// Numbers this process's prompts, for the debug page's turn ids.
    prompts: AtomicU64,
}

#[derive(Clone)]
pub struct PiSession {
    inner: Arc<SessionInner>,
}

/// The phase of a local process: what it can do now. `step` says how an
/// event moves it, and `PiSession::transition` is the only writer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProcessState {
    /// Running between turns: it takes the next prompt.
    Idle,
    /// Prompt `turn` is being written. No turn runs yet, so a steer is
    /// refused; a cancel leaves part of a prompt in the pipe.
    Sending { turn: u64 },
    /// Prompt `turn` is out and its turn is read up to `agent_settled`.
    Prompting { turn: u64 },
    /// A prompt was cancelled before its turn ended. Nothing ties an event
    /// to the prompt that caused it, so the rest of that turn would be read
    /// as the next prompt's answer: the process is never reused, and its
    /// close is on its way.
    Abandoned,
    /// Closed by its owner, by a turn that broke it, or after an abandon.
    /// Terminal.
    Closed,
}

/// Something that happens to a local process. A prompt's events carry the
/// number of the prompt they belong to, so one that arrives after the
/// process has moved on (its owner closed it mid-turn) changes nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProcessEvent {
    /// `prompt_for` starts writing prompt `turn`.
    Send { turn: u64 },
    /// The write failed, so no turn is running. The process is left as it
    /// is: if it has exited, `alive` says so.
    Unsent { turn: u64 },
    /// The prompt is written; its turn runs.
    Sent { turn: u64 },
    /// The turn ended, as `how` says.
    Ended { turn: u64, how: TurnEnd },
    /// The prompt's future was dropped before its turn ended: a timeout
    /// around it, or an aborted task.
    Cancelled { turn: u64 },
    /// The owner closes the process.
    Close,
}

/// How reading a turn ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TurnEnd {
    /// It read `agent_settled`.
    Settled,
    /// The output ended, or could not be read, before `agent_settled`. The
    /// process is left as it is: if it has exited, `alive` says so.
    StreamEnded,
    /// The turn broke the process: silent past its deadline, a line too
    /// big to read, or too much text. The process is closed before the
    /// caller hears why.
    Failed,
}

/// What entering a phase leaves to do. The transition says which; the
/// event's caller runs it, in `PiSession::tear_down`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Teardown {
    /// Entering `Abandoned`: close the process in the background, since a
    /// dropped prompt cannot await.
    CloseLater,
    /// Entering `Closed`: release the process now, before the caller goes
    /// on.
    Release,
}

/// The local process's transition table. An event that does not apply to
/// the phase (a prompt's late event after its process was closed) leaves
/// it where it is.
fn step(state: ProcessState, event: ProcessEvent) -> (ProcessState, Option<Teardown>) {
    use ProcessEvent as Event;
    use ProcessState as State;
    match (state, event) {
        (State::Idle, Event::Send { turn }) => (State::Sending { turn }, None),
        (State::Sending { turn }, Event::Unsent { turn: unsent }) if unsent == turn => {
            (State::Idle, None)
        }
        (State::Sending { turn }, Event::Sent { turn: sent }) if sent == turn => {
            (State::Prompting { turn }, None)
        }
        (State::Prompting { turn }, Event::Ended { turn: ended, how }) if ended == turn => {
            match how {
                TurnEnd::Settled | TurnEnd::StreamEnded => (State::Idle, None),
                TurnEnd::Failed => (State::Closed, Some(Teardown::Release)),
            }
        }
        (
            State::Sending { turn } | State::Prompting { turn },
            Event::Cancelled { turn: cancelled },
        ) if cancelled == turn => (State::Abandoned, Some(Teardown::CloseLater)),
        (
            State::Idle | State::Sending { .. } | State::Prompting { .. } | State::Abandoned,
            Event::Close,
        ) => (State::Closed, Some(Teardown::Release)),
        (
            State::Idle
            | State::Sending { .. }
            | State::Prompting { .. }
            | State::Abandoned
            | State::Closed,
            Event::Send { .. }
            | Event::Unsent { .. }
            | Event::Sent { .. }
            | Event::Ended { .. }
            | Event::Cancelled { .. }
            | Event::Close,
        ) => (state, None),
    }
}

/// A prompt out on the process, from the start of its write until its
/// turn ends. Its exits are the prompt's events: `sent`, then `end`.
/// Dropped before `end`, it is the `Cancelled` event.
struct PromptInFlight<'a> {
    session: &'a PiSession,
    turn: u64,
    ended: bool,
}

impl<'a> PromptInFlight<'a> {
    fn begin(session: &'a PiSession, turn: u64) -> Self {
        session.transition(ProcessEvent::Send { turn });
        Self {
            session,
            turn,
            ended: false,
        }
    }

    fn sent(&self) {
        self.session
            .transition(ProcessEvent::Sent { turn: self.turn });
    }

    fn unsent(mut self) {
        self.ended = true;
        self.session
            .transition(ProcessEvent::Unsent { turn: self.turn });
    }

    async fn end(mut self, how: TurnEnd) {
        self.ended = true;
        let teardown = self.session.transition(ProcessEvent::Ended {
            turn: self.turn,
            how,
        });
        self.session.tear_down(teardown).await;
    }
}

impl Drop for PromptInFlight<'_> {
    fn drop(&mut self) {
        if self.ended {
            return;
        }
        let teardown = self
            .session
            .transition(ProcessEvent::Cancelled { turn: self.turn });
        if teardown.is_some() {
            let session = self.session.clone();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move { session.tear_down(teardown).await });
            }
        }
    }
}

impl PiSession {
    /// Starts a leg's process. `label` names it in logs and on the page;
    /// `leg` is the token of the leg it serves, which every `Activity` it
    /// reports carries so the application can tell whose it is.
    pub async fn start(
        argv: Vec<String>,
        label: impl Into<String>,
        leg: impl Into<String>,
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
        turn_timeout: Duration,
        on_activity: Option<ActivityCallback>,
    ) -> Result<Self, PiSessionError> {
        let mut command = Command::new(
            argv.first()
                .ok_or_else(|| PiSessionError("no agent command was supplied".into()))?,
        );
        command
            .args(argv.iter().skip(1))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        isolate_process(&mut command);
        if let Some(cwd) = &cwd {
            command.current_dir(cwd);
        }
        if let Some(env) = &env {
            command.envs(env);
        }
        let label = label.into();
        // Keep process diagnostics bounded and avoid recording prompts, paths,
        // hosts, or other deployment values from the command line.
        tracing::info!(%label, program = %argv[0], argc = argv.len(), "starting agent leg");
        let mut child = command.spawn().map_err(|error| {
            tracing::error!(%label, program = %argv[0], %error, "could not start agent leg");
            PiSessionError(format!("could not start {}: {error}", argv[0]))
        })?;
        let process_guard = ProcessTreeGuard::new(&child);
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| PiSessionError("agent process has no stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| PiSessionError("agent process has no stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| PiSessionError("agent process has no stderr".into()))?;
        let stderr_tail = Arc::new(StdMutex::new(Vec::new()));
        let tail = Arc::clone(&stderr_tail);
        let (stderr_done, stderr_closed) = watch::channel(false);
        let drain_label = label.clone();
        let stderr_task = tokio::spawn(async move {
            drain_stderr(stderr, tail, drain_label).await;
            stderr_done.send_replace(true);
        });
        let inner = Arc::new(SessionInner {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            stdout: Mutex::new(BufReader::new(stdout)),
            stderr_tail,
            state: StdMutex::new(ProcessState::Idle),
            turn_lock: Mutex::new(()),
            label,
            leg: leg.into(),
            turn_timeout,
            on_activity,
            stderr_task: StdMutex::new(Some(stderr_task)),
            stderr_closed,
            process_guard,
            debug: StdOnceLock::new(),
            prompts: AtomicU64::new(0),
        });
        Ok(Self { inner })
    }

    /// Waits, at most `EXIT_REPORT_GRACE`, for a process that has stopped
    /// talking to finish writing to stderr and exit. True when it has exited.
    ///
    /// A failing process says why on stderr on its way out, while a separate
    /// task drains that pipe. Reading the tail the moment stdout ends, or the
    /// moment a write to stdin fails, races that task and usually reports
    /// nothing, or reports the broken pipe instead of its cause.
    async fn settle_exit(&self) -> bool {
        let deadline = Instant::now() + EXIT_REPORT_GRACE;
        let mut stderr_closed = self.inner.stderr_closed.clone();
        let _ = timeout_at(deadline, stderr_closed.wait_for(|closed| *closed)).await;
        // Stderr closes as the process exits, so this is normally one check.
        // The child lock is taken per check rather than held across a wait:
        // `alive` callers, and a rescue closing this session, must not queue
        // behind a process that closed its pipes and kept running.
        loop {
            if !self.alive().await {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    async fn exited_error(&self) -> PiSessionError {
        self.settle_exit().await;
        PiSessionError(format!(
            "agent process is not running ({})",
            self.stderr_tail(5)
        ))
    }

    fn state(&self) -> ProcessState {
        *self
            .inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Moves the process's phase by `event`: the only writer of its state.
    /// Returns what entering the new phase leaves to do; the caller runs it
    /// with `tear_down`.
    fn transition(&self, event: ProcessEvent) -> Option<Teardown> {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let from = *state;
        let (to, teardown) = step(from, event);
        *state = to;
        drop(state);
        if to != from {
            tracing::debug!(label = %self.inner.label, ?from, ?event, ?to, "agent leg phase");
            if to == ProcessState::Abandoned {
                tracing::warn!(label = %self.inner.label, "a prompt was cancelled mid-turn; dropping the leg");
            }
        }
        teardown
    }

    /// Runs what entering a phase left to do. Closing an abandoned process
    /// is the `Close` event, whose entry into `Closed` releases it.
    async fn tear_down(&self, mut teardown: Option<Teardown>) {
        while let Some(next) = teardown {
            teardown = match next {
                Teardown::CloseLater => self.transition(ProcessEvent::Close),
                Teardown::Release => {
                    self.release().await;
                    None
                }
            };
        }
    }

    /// Releases the process: its input, the process tree, and the stderr
    /// drain. Run once, on entry to `Closed`.
    async fn release(&self) {
        self.inner.stdin.lock().await.take();
        if let Some(mut child) = self.inner.child.lock().await.take() {
            tracing::info!(label = %self.inner.label, "closing agent leg");
            terminate_process(&mut child).await;
        }
        self.inner.process_guard.disarm();
        if let Ok(mut task) = self.inner.stderr_task.lock() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
    }

    /// True while a prompt's turn runs: a steer is written into it.
    pub fn busy(&self) -> bool {
        matches!(self.state(), ProcessState::Prompting { .. })
    }
    pub fn label(&self) -> &str {
        &self.inner.label
    }

    /// Mirrors this process's prompts, replies and tool calls to `bus`,
    /// tagged with the leg token (`operator`, `utility`). Set once, before
    /// the first prompt; a later call changes nothing.
    pub(crate) fn observe(&self, bus: DebugBus) {
        let _ = self.inner.debug.set(bus);
    }

    fn publish(&self, event: DebugEvent) {
        if let Some(bus) = self.inner.debug.get() {
            bus.publish(event);
        }
    }

    /// True when a recording bus observes this process, so an event worth
    /// building (a deep copy of tool arguments) is built only then.
    fn observed(&self) -> bool {
        self.inner.debug.get().is_some_and(DebugBus::enabled)
    }

    /// The debug turn id of the prompt being run: `<leg>-<n>`.
    fn debug_turn_id(&self) -> String {
        format!(
            "{}-{}",
            self.inner.leg,
            self.inner.prompts.load(Ordering::Acquire)
        )
    }

    #[cfg(test)]
    pub fn same_session(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
    /// True while the process runs and can take a prompt. A process whose
    /// prompt was cancelled mid-turn is not: its owner restarts it.
    pub async fn alive(&self) -> bool {
        match self.state() {
            ProcessState::Idle | ProcessState::Sending { .. } | ProcessState::Prompting { .. } => {}
            ProcessState::Abandoned | ProcessState::Closed => return false,
        }
        let mut child = self.inner.child.lock().await;
        child
            .as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None)))
    }
    pub fn stderr_tail(&self, limit: usize) -> String {
        self.inner
            .stderr_tail
            .lock()
            .map(|tail| {
                tail.iter()
                    .rev()
                    .take(limit)
                    .rev()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" | ")
            })
            .unwrap_or_default()
    }

    /// Closes the process: its owner is done with it, or is replacing it.
    /// Returns once the process is gone, also when another path (a turn
    /// that broke it, an abandoned prompt) is already closing it.
    pub async fn close(&self) {
        match self.transition(ProcessEvent::Close) {
            Some(teardown) => self.tear_down(Some(teardown)).await,
            // A release already under way holds `stdin`, then `child`;
            // both locks are fair, so taking them in that order waits for
            // it to finish.
            None => {
                drop(self.inner.stdin.lock().await);
                drop(self.inner.child.lock().await);
            }
        }
    }

    pub async fn prompt(&self, message: &str) -> Result<Turn, PiSessionError> {
        self.prompt_for(message, None).await
    }

    /// `prompt`, naming the caller line (`utterance_id`) the message carries
    /// so the debug page can link the route to it.
    pub async fn prompt_for(
        &self,
        message: &str,
        utterance_id: Option<&str>,
    ) -> Result<Turn, PiSessionError> {
        let _turn = self.inner.turn_lock.lock().await;
        if !self.alive().await {
            return Err(self.exited_error().await);
        }
        // Prompts are numbered under the turn lock, so this is the number
        // this one takes once it is written.
        let turn = self.inner.prompts.load(Ordering::Acquire) + 1;
        let prompting = PromptInFlight::begin(self, turn);
        if let Err(error) = self
            .write(json!({"type":"prompt", "message":message}), false)
            .await
        {
            prompting.unsent();
            // A process that stops reading has usually failed; its exit and
            // stderr say why, and the broken pipe is only the symptom.
            if self.settle_exit().await {
                return Err(self.exited_error().await);
            }
            return Err(error);
        }
        self.inner.prompts.store(turn, Ordering::Release);
        let turn_id = self.debug_turn_id();
        self.publish(DebugEvent::AgentInput {
            agent: self.inner.leg.clone(),
            turn_id: Some(turn_id.clone()),
            text: message.to_owned(),
            source: local_prompt_source(&self.inner.leg, message).into(),
            utterance_id: utterance_id.map(str::to_owned),
        });
        prompting.sent();
        let (how, result) = self.collect(&turn_id).await;
        // A failed turn closes the process before the caller hears why.
        prompting.end(how).await;
        result
    }

    pub async fn steer(
        &self,
        message: &str,
        utterance_id: Option<&str>,
    ) -> Result<(), PiSessionError> {
        if !self.alive().await {
            return Err(PiSessionError(format!(
                "agent process is not running ({})",
                self.stderr_tail(5)
            )));
        }
        let result = self
            .write(json!({"type":"steer", "message":message}), true)
            .await;
        match &result {
            Ok(()) => {
                tracing::info!(
                    label = %self.inner.label,
                    chars = message.chars().count(),
                    "steered the running turn"
                );
                self.publish(DebugEvent::AgentInput {
                    agent: self.inner.leg.clone(),
                    turn_id: Some(self.debug_turn_id()),
                    text: message.to_owned(),
                    source: "steer".into(),
                    utterance_id: utterance_id.map(str::to_owned),
                });
            }
            Err(error) => tracing::info!(
                label = %self.inner.label,
                %error,
                "could not steer the running turn"
            ),
        }
        result
    }

    async fn write(&self, command: Value, require_busy: bool) -> Result<(), PiSessionError> {
        let mut stdin = self.inner.stdin.lock().await;
        if require_busy && !self.busy() {
            return Err(PiSessionError("agent turn is no longer running".into()));
        }
        let stdin = stdin
            .as_mut()
            .ok_or_else(|| PiSessionError("agent process has no input to write to".into()))?;
        let mut payload =
            serde_json::to_vec(&command).map_err(|error| PiSessionError(error.to_string()))?;
        payload.push(b'\n');
        stdin
            .write_all(&payload)
            .await
            .map_err(|error| PiSessionError(format!("agent process closed its input: {error}")))?;
        stdin
            .flush()
            .await
            .map_err(|error| PiSessionError(format!("agent process closed its input: {error}")))
    }

    /// Reads the prompt's turn up to `agent_settled`, and says how it ended.
    async fn collect(&self, turn_id: &str) -> (TurnEnd, Result<Turn, PiSessionError>) {
        let mut chunks = Vec::new();
        let mut signals = Vec::new();
        let mut error = String::new();
        let mut response_life_reported = false;
        let mut deltas = DeltaBuffer::default();
        loop {
            let read = {
                let mut stdout = self.inner.stdout.lock().await;
                timeout(
                    self.inner.turn_timeout,
                    read_limited_line(&mut *stdout, STREAM_LIMIT),
                )
                .await
            };
            let label = &self.inner.label;
            let line = match read {
                Ok(Ok(LimitedLine::Line(line))) => line,
                Ok(Ok(LimitedLine::Eof)) => {
                    // Callers report the stderr tail when a turn fails with no
                    // error of its own, so it has to be complete first.
                    self.settle_exit().await;
                    tracing::warn!(
                        %label,
                        stderr_lines = self.stderr_tail(5).lines().count(),
                        "agent stream ended mid-turn"
                    );
                    self.publish_delta(turn_id, deltas.take());
                    let turn = Turn {
                        text: chunks.join("\n"),
                        signals,
                        failed: true,
                        error,
                    };
                    return (TurnEnd::StreamEnded, Ok(turn));
                }
                Ok(Ok(LimitedLine::TooLong)) => {
                    tracing::error!(%label, limit = STREAM_LIMIT, "oversized RPC event; dropping the leg");
                    let turn = Turn {
                        text: String::new(),
                        signals,
                        failed: true,
                        error: "the agent sent something too big to read".into(),
                    };
                    return (TurnEnd::Failed, Ok(turn));
                }
                Ok(Err(error)) => {
                    tracing::error!(%label, %error, "could not read agent output");
                    let error = PiSessionError(format!("could not read agent output: {error}"));
                    return (TurnEnd::StreamEnded, Err(error));
                }
                Err(_) => {
                    // The most common wedged-agent symptom in production, and
                    // until now the one that left the least behind.
                    tracing::warn!(
                        %label,
                        timeout = ?self.inner.turn_timeout,
                        stderr_lines = self.stderr_tail(5).lines().count(),
                        "agent went silent past the turn deadline; dropping the leg"
                    );
                    let turn = Turn {
                        text: String::new(),
                        signals,
                        failed: true,
                        error: "the agent stopped responding".into(),
                    };
                    return (TurnEnd::Failed, Ok(turn));
                }
            };
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                continue;
            }
            let event: Value = match serde_json::from_str(line) {
                Ok(event) => event,
                // Skipping is right — a runtime that prints a banner must not
                // fail the call — but the skipped line is worth keeping.
                Err(error) => {
                    tracing::debug!(
                        %label,
                        %error,
                        bytes = line.len(),
                        "skipping a non-JSON line from the agent"
                    );
                    continue;
                }
            };
            match event.get("type").and_then(Value::as_str) {
                Some("message_update") => {
                    let assistant_event = event.get("assistantMessageEvent");
                    let event_type = assistant_event
                        .and_then(Value::as_object)
                        .and_then(|event| event.get("type"))
                        .and_then(Value::as_str);
                    let text = assistant_event
                        .and_then(Value::as_object)
                        .and_then(|event| event.get("content").or_else(|| event.get("delta")))
                        .and_then(Value::as_str)
                        .filter(|text| !text.trim().is_empty());
                    if text.is_some() && !response_life_reported {
                        response_life_reported = true;
                        self.report_activity("life", "", String::new()).await;
                    }
                    if event_type == Some("text_delta") {
                        if let Some(delta) = assistant_event
                            .and_then(|event| event.get("delta"))
                            .and_then(Value::as_str)
                        {
                            self.publish_delta(turn_id, deltas.push(delta));
                        }
                    }
                    if event_type == Some("text_end") {
                        self.publish_delta(turn_id, deltas.take());
                        if let Some(content) = text {
                            let collected = chunks.iter().map(String::len).sum::<usize>();
                            if collected.saturating_add(content.len()) > STREAM_LIMIT {
                                tracing::error!(
                                    %label,
                                    collected,
                                    limit = STREAM_LIMIT,
                                    "agent produced too much text in one turn; dropping the leg"
                                );
                                let turn = Turn {
                                    text: String::new(),
                                    signals,
                                    failed: true,
                                    error: "the agent produced too much text in one turn".into(),
                                };
                                return (TurnEnd::Failed, Ok(turn));
                            }
                            chunks.push(content.trim().to_owned());
                        }
                    }
                }
                Some("message_end") => {
                    let message = event.get("message").and_then(Value::as_object);
                    if message
                        .and_then(|message| message.get("role"))
                        .and_then(Value::as_str)
                        == Some("assistant")
                        && message
                            .and_then(|message| message.get("stopReason"))
                            .and_then(Value::as_str)
                            == Some(ERROR_STOP_REASON)
                    {
                        let raw = message.and_then(|message| message.get("errorMessage"));
                        // Keep the same sanitized detail that the caller hears;
                        // raw provider errors can contain prompts or credentials.
                        let sanitized = spoken_error(raw);
                        tracing::error!(
                            %label,
                            error = %sanitized,
                            "the agent's model call failed"
                        );
                        error = sanitized;
                    }
                }
                Some("tool_execution_start") => {
                    let name = event.get("toolName").and_then(Value::as_str).unwrap_or("");
                    if self.observed() {
                        self.publish(DebugEvent::ToolStart {
                            agent: self.inner.leg.clone(),
                            call_id: event
                                .get("toolCallId")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            tool: name.into(),
                            args: event.get("args").cloned(),
                            turn_id: Some(turn_id.to_owned()),
                        });
                    }
                    if [
                        ROUTE_TOOL,
                        SECOND_OPINION_TOOL,
                        DISPATCH_PARTS_TOOL,
                        REWRITE_TOOL,
                    ]
                    .contains(&name)
                    {
                        let args = event
                            .get("args")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        // The signal name and argument count are enough to
                        // trace routing without writing speech or model content.
                        tracing::info!(
                            %label,
                            signal = name,
                            arg_count = args.len(),
                            "agent raised a routing signal"
                        );
                        signals.push(Signal {
                            name: name.into(),
                            args,
                        });
                    }
                    self.report_activity("start", name, activity_detail(event.get("args")))
                        .await;
                }
                Some("tool_execution_end") => {
                    let name = event.get("toolName").and_then(Value::as_str).unwrap_or("");
                    if self.observed() {
                        let result = event.get("result").filter(|value| !value.is_null());
                        self.publish(DebugEvent::ToolEnd {
                            agent: self.inner.leg.clone(),
                            call_id: event
                                .get("toolCallId")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            tool: name.into(),
                            result: result.cloned(),
                            error: (event.get("isError") == Some(&Value::Bool(true)))
                                .then(|| tool_error_text(result)),
                            turn_id: Some(turn_id.to_owned()),
                        });
                    }
                    self.report_activity("end", name, String::new()).await
                }
                Some("extension_error") => {
                    tracing::error!(
                        label = %self.inner.label,
                        error = ?event.get("error"),
                        "agent extension error"
                    );
                }
                Some("agent_settled") => break,
                _ => {}
            }
        }
        self.publish_delta(turn_id, deltas.take());
        let text = chunks.join("\n").trim().to_owned();
        if !text.is_empty() {
            self.publish(DebugEvent::AgentText {
                agent: self.inner.leg.clone(),
                turn_id: Some(turn_id.to_owned()),
                text: text.clone(),
                final_: true,
            });
        }
        let turn = Turn {
            text,
            signals,
            failed: !error.is_empty(),
            error,
        };
        (TurnEnd::Settled, Ok(turn))
    }

    fn publish_delta(&self, turn_id: &str, text: Option<String>) {
        if let Some(text) = text {
            self.publish(DebugEvent::AgentText {
                agent: self.inner.leg.clone(),
                turn_id: Some(turn_id.to_owned()),
                text,
                final_: false,
            });
        }
    }

    async fn report_activity(&self, state: &str, tool: &str, detail: String) {
        if let Some(callback) = &self.inner.on_activity {
            let callback = Arc::clone(callback);
            let activity = Activity {
                state: state.into(),
                tool: tool.into(),
                detail,
                label: self.inner.label.clone(),
                leg: self.inner.leg.clone(),
            };
            if let Err(panic) = AssertUnwindSafe(callback(activity)).catch_unwind().await {
                tracing::error!(
                    label = %self.inner.label,
                    tool,
                    panic = %panic_message(&panic),
                    "activity callback panicked"
                );
            }
        }
    }
}

/// A steer of the leg on the line: written to the operator's process, or
/// queued on a project session's host link.
pub enum LegSteer {
    Written,
    Queued(QueuedSteer),
}

impl LegSteer {
    /// Waits for the steer to be taken: at once for the operator, on the
    /// host's answer for a project session.
    pub async fn sent(self) -> Result<(), PiSessionError> {
        match self {
            Self::Written => Ok(()),
            Self::Queued(steer) => steer.sent().await,
        }
    }
}

/// The leg on the line, as the application's controls see it: the local
/// operator's process, or a project session.
#[derive(Clone)]
pub enum LegSession {
    Operator(PiSession),
    Project(ProjectSession),
}

impl LegSession {
    pub fn label(&self) -> &str {
        match self {
            Self::Operator(session) => session.label(),
            Self::Project(session) => session.label(),
        }
    }
    #[cfg(test)]
    pub fn instance_id(&self) -> u64 {
        match self {
            Self::Operator(_) => 0,
            Self::Project(session) => session.instance_id(),
        }
    }
    pub fn busy(&self) -> bool {
        match self {
            Self::Operator(session) => session.busy(),
            Self::Project(session) => session.busy(),
        }
    }
    pub async fn alive(&self) -> bool {
        match self {
            Self::Operator(session) => session.alive().await,
            Self::Project(session) => session.alive(),
        }
    }
    /// Steers the leg's running turn: writes it to the operator's process,
    /// or queues it on the project session's host link. `LegSteer::sent`
    /// waits for the host's answer, which needs none of the guards a steer
    /// is checked and queued under.
    pub async fn queue_steer(
        &self,
        message: &str,
        utterance_id: Option<&str>,
    ) -> Result<LegSteer, PiSessionError> {
        match self {
            Self::Operator(session) => session
                .steer(message, utterance_id)
                .await
                .map(|()| LegSteer::Written),
            Self::Project(session) => session
                .queue_steer(message, utterance_id)
                .await
                .map(LegSteer::Queued),
        }
    }
    #[cfg(test)]
    pub fn same_session(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Operator(left), Self::Operator(right)) => left.same_session(right),
            (Self::Project(left), Self::Project(right)) => left.same_session(right),
            _ => false,
        }
    }
    /// Ends the leg: the operator's process, or the project session on its
    /// host.
    pub async fn close(&self) {
        match self {
            Self::Operator(session) => session.close().await,
            Self::Project(session) => session.close(),
        }
    }
    /// Stops the leg's running work and keeps the leg: a project turn is
    /// aborted, for a model change that keeps the session. The operator has
    /// nothing to keep, so its process is closed.
    pub async fn interrupt(&self) {
        match self {
            Self::Operator(session) => session.close().await,
            Self::Project(session) => session.interrupt(),
        }
    }
}

/// Put a supervised command in its own process group where the platform
/// supports it. Pi and the speech commands may launch helpers; cancellation
/// must reap the whole local tree rather than only its top-level shell.
pub(crate) fn isolate_process(command: &mut Command) {
    command.kill_on_drop(true);
    #[cfg(unix)]
    {
        command.process_group(0);
        #[cfg(target_os = "linux")]
        {
            unsafe {
                command.pre_exec(|| {
                    libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                    Ok(())
                });
            }
        }
    }
}

/// Synchronous cancellation backstop for async operations that own child
/// process trees. `kill_on_drop` only targets the immediate process; this guard
/// also terminates helpers launched by a shell or runtime if the future is
/// aborted before it can run its async cleanup path.
pub(crate) struct ProcessTreeGuard(StdMutex<Option<i32>>);

impl ProcessTreeGuard {
    pub(crate) fn new(child: &Child) -> Self {
        #[cfg(unix)]
        let pid = child.id().map(|pid| pid as i32);
        #[cfg(not(unix))]
        let pid = None;
        Self(StdMutex::new(pid))
    }

    pub(crate) fn disarm(&self) {
        if let Ok(mut pid) = self.0.lock() {
            pid.take();
        }
    }
}

impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Ok(pid) = self.0.get_mut() {
            if let Some(pid) = pid.take() {
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                }
            }
        }
    }
}

pub(crate) async fn terminate_process(child: &mut Child) {
    match child.try_wait() {
        Ok(Some(_)) => return,
        Ok(None) => {}
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return;
        }
    }
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = child.kill().await;
    let _ = child.wait().await;
}

#[derive(Debug, PartialEq, Eq)]
enum LimitedLine {
    Eof,
    Line(Vec<u8>),
    TooLong,
}

/// Read one JSONL record without allowing a missing newline to grow memory
/// without bound. `AsyncBufReadExt::read_line` only reports the length after it
/// has allocated the whole record, which defeats `STREAM_LIMIT` for a wedged or
/// hostile child process.
async fn read_limited_line<R>(reader: &mut R, limit: usize) -> std::io::Result<LimitedLine>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::with_capacity(limit.min(8 * 1024));
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(if line.is_empty() {
                LimitedLine::Eof
            } else {
                LimitedLine::Line(line)
            });
        }

        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        if line.len().saturating_add(take) > limit {
            return Ok(LimitedLine::TooLong);
        }
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if line.last() == Some(&b'\n') {
            return Ok(LimitedLine::Line(line));
        }
    }
}

async fn drain_stderr(stderr: ChildStderr, tail: Arc<StdMutex<Vec<String>>>, label: String) {
    let mut stderr = BufReader::new(stderr);
    let mut chunk = [0_u8; 8192];
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let read = match stderr.read(&mut chunk).await {
            Ok(0) => break,
            // A pipe that fails is not the same as a process that finished
            // talking, and only one of the two is worth investigating.
            Err(error) => {
                tracing::error!(%label, %error, "agent stderr drain failed");
                break;
            }
            Ok(read) => read,
        };
        for byte in &chunk[..read] {
            if *byte == b'\n' {
                if oversized {
                    push_stderr(&tail, "[oversized stderr line]".into());
                } else {
                    let value = String::from_utf8_lossy(&line)
                        .trim_end_matches('\r')
                        .to_owned();
                    if !value.trim().is_empty() {
                        tracing::debug!(%label, bytes = value.len(), "agent wrote to stderr");
                        push_stderr(&tail, value);
                    }
                }
                line.clear();
                oversized = false;
            } else if line.len() < STDERR_LINE_LIMIT {
                line.push(*byte);
            } else {
                oversized = true;
            }
        }
    }
    if oversized {
        push_stderr(&tail, "[oversized stderr line]".into());
    } else if !line.is_empty() {
        let value = String::from_utf8_lossy(&line).trim().to_owned();
        if !value.is_empty() {
            push_stderr(&tail, value);
        }
    }
}

/// The message a caught panic carried.
///
/// `catch_unwind` hands back a boxed `Any`, and reporting only that a callback
/// "failed" throws away the one part of it worth reading. `panic!` produces
/// either a `&'static str` or a `String`; anything else is named rather than
/// silently rendered as nothing.
pub(crate) fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    panic
        .downcast_ref::<&'static str>()
        .map(|text| (*text).to_owned())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "<non-string panic payload>".to_owned())
}

fn push_stderr(tail: &StdMutex<Vec<String>>, line: String) {
    if let Ok(mut tail) = tail.lock() {
        tail.push(line);
        if tail.len() > 20 {
            let remove = tail.len() - 20;
            tail.drain(..remove);
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct BoundedOutput {
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

pub(crate) async fn drain_bounded<R>(mut reader: R, limit: usize) -> BoundedOutput
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::with_capacity(limit.min(8192));
    let mut chunk = [0_u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let available = limit.saturating_sub(bytes.len());
                let keep = available.min(read);
                bytes.extend_from_slice(&chunk[..keep]);
                truncated |= keep < read;
            }
        }
    }
    BoundedOutput { bytes, truncated }
}

/// Streamed reply text gathered for the debug page. Deltas arrive about one
/// per token; one event each would crowd the debug ring, so they go out in
/// pieces of `DELTA_FLUSH_BYTES` or every `DELTA_FLUSH_AFTER`.
#[derive(Default)]
struct DeltaBuffer {
    text: String,
    since: Option<Instant>,
}

const DELTA_FLUSH_BYTES: usize = 256;
const DELTA_FLUSH_AFTER: Duration = Duration::from_millis(250);

impl DeltaBuffer {
    /// Adds `delta`; the gathered text when it is due to go out.
    fn push(&mut self, delta: &str) -> Option<String> {
        if delta.is_empty() {
            return None;
        }
        self.text.push_str(delta);
        let since = *self.since.get_or_insert_with(Instant::now);
        if self.text.len() >= DELTA_FLUSH_BYTES || since.elapsed() >= DELTA_FLUSH_AFTER {
            return self.take();
        }
        None
    }

    /// The text gathered so far, if any.
    fn take(&mut self) -> Option<String> {
        self.since = None;
        (!self.text.is_empty()).then(|| std::mem::take(&mut self.text))
    }
}

/// What a local process's prompt is, for the debug page. The utility gets
/// routing requests and floor rewrites; the operator gets the caller's turns.
fn local_prompt_source(leg: &str, message: &str) -> &'static str {
    match leg {
        "utility" if message.starts_with("[FLOOR REWRITE]") => "floor_rewrite",
        "utility" => "routing_request",
        _ => "caller",
    }
}

/// A failed tool's error for the debug page: the text its result carries,
/// clipped, or a plain note when it carries none.
pub(crate) fn tool_error_text(result: Option<&Value>) -> String {
    let text = match result {
        Some(Value::String(text)) => text.clone(),
        Some(result) => result
            .get("content")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
        None => String::new(),
    };
    let text = text.trim();
    if text.is_empty() {
        return "the tool reported an error".into();
    }
    if text.chars().count() > TOOL_ERROR_CHARS {
        let clipped = text.chars().take(TOOL_ERROR_CHARS).collect::<String>();
        return format!("{}…", clipped.trim_end());
    }
    text.to_owned()
}

const TOOL_ERROR_CHARS: usize = 500;

fn activity_detail(args: Option<&Value>) -> String {
    let Some(args) = args.and_then(Value::as_object) else {
        return String::new();
    };
    for key in ACTIVITY_ARG_ORDER {
        if let Some(value) = args
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
            if value.chars().count() > ACTIVITY_DETAIL_CHARS {
                let clipped = value
                    .chars()
                    .take(ACTIVITY_DETAIL_CHARS)
                    .collect::<String>();
                return format!("{}…", clipped.trim_end());
            }
            return value;
        }
    }
    String::new()
}

pub(crate) fn spoken_error(detail: Option<&Value>) -> String {
    let mut first = detail
        .and_then(Value::as_str)
        .unwrap_or("the model call failed")
        .trim()
        .split('\n')
        .next()
        .unwrap_or("")
        .to_owned();
    for cut in ["; details=", " url=", "; stack="] {
        if let Some(index) = first.find(cut) {
            first.truncate(index);
        }
    }
    if first.chars().count() > ERROR_DETAIL_CHARS {
        first = first.chars().take(ERROR_DETAIL_CHARS).collect();
        first.push('…');
    }
    if first.trim().is_empty() {
        "the model call failed".into()
    } else {
        first
    }
}

pub fn local_argv(
    binary: &str,
    model: Option<&str>,
    system_prompt_file: Option<&Path>,
    system_prompt_suffix: Option<&str>,
    extension: Option<&str>,
    extra_args: &[String],
) -> Result<Vec<String>, PiSessionError> {
    let mut argv = vec![binary.into(), "--mode".into(), "rpc".into()];
    if let Some(model) = model {
        argv.extend(["--model".into(), model.into()]);
    }
    let mut prompt = match system_prompt_file {
        Some(path) => Some(std::fs::read_to_string(path).map_err(|error| {
            PiSessionError(format!(
                "could not read system prompt {}: {error}",
                path.display()
            ))
        })?),
        None => None,
    };
    if let Some(suffix) = system_prompt_suffix {
        let prompt = prompt.get_or_insert_default();
        if !prompt.is_empty() {
            prompt.push_str("\n\n");
        }
        prompt.push_str(suffix);
    }
    if let Some(prompt) = prompt {
        argv.extend(["--system-prompt".into(), prompt]);
    }
    if let Some(extension) = extension {
        argv.extend(["-e".into(), extension.into()]);
    }
    argv.extend(extra_args.iter().cloned());
    Ok(argv)
}
/// Writes `body` as a `/bin/sh` script, marks it executable, and does not return
/// until the kernel will actually run it.
///
/// Tests run on many threads inside one process. Spawning a child forks, and the
/// fork duplicates every open descriptor, so a child forked while this file is
/// still being written inherits a writable descriptor to it and keeps that copy
/// until it execs. Linux refuses to execute a file any process holds open for
/// writing, so callers would otherwise fail intermittently with `ETXTBSY`.
///
/// Draining that window here — rather than retrying the operation under test —
/// is what keeps a real failure legible: the file is never rewritten after the
/// probe succeeds, so it stays runnable, and the code under test still executes
/// exactly once with its own errors surfacing unchanged.
#[cfg(all(test, unix))]
pub(crate) fn write_executable_script(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    const PROBE: &str = "--switchboard-exec-probe";

    std::fs::write(
        path,
        format!("#!/bin/sh\nif [ \"$1\" = \"{PROBE}\" ]; then exit 0; fi\n{body}"),
    )
    .unwrap_or_else(|error| panic!("could not write {}: {error}", path.display()));
    let mut permissions = std::fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(path, permissions).unwrap();

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        match std::process::Command::new(path).arg(PROBE).output() {
            Ok(probe) => {
                assert!(
                    probe.status.success(),
                    "{} did not survive its exec probe: {probe:?}",
                    path.display()
                );
                return;
            }
            // Only ETXTBSY is the transient fork/exec window. Every other spawn
            // failure is a real defect and is reported now instead of retried.
            Err(error) if error.raw_os_error() == Some(libc::ETXTBSY) => {
                assert!(
                    std::time::Instant::now() < deadline,
                    "{} was still held open for writing after 30s",
                    path.display()
                );
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(error) => panic!("{} could not start: {error}", path.display()),
        }
    }
}

#[cfg(test)]
#[path = "../tests/test_pi_client.rs"]
mod tests;

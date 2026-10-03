use crate::debug::{DebugBus, DebugEvent};
use futures_util::FutureExt;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock as StdOnceLock};
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

/// Distinguishes live handles that reopen the same persistent daemon session.
static NEXT_PROJECT_INSTANCE_ID: AtomicU64 = AtomicU64::new(1);
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
    busy: AtomicBool,
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
            busy: AtomicBool::new(false),
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

    pub fn busy(&self) -> bool {
        self.inner.busy.load(Ordering::Acquire)
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

    pub fn same_session(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
    pub async fn alive(&self) -> bool {
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

    pub async fn close(&self) {
        self.inner.busy.store(false, Ordering::Release);
        self.inner.stdin.lock().await.take();
        if let Some(mut child) = self.inner.child.lock().await.take() {
            // Only when a child was actually still there. `close` is
            // idempotent and called on every teardown path, so logging
            // unconditionally would report tear-downs that did nothing.
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
        if let Err(error) = self
            .write(json!({"type":"prompt", "message":message}), false)
            .await
        {
            // A process that stops reading has usually failed; its exit and
            // stderr say why, and the broken pipe is only the symptom.
            if self.settle_exit().await {
                return Err(self.exited_error().await);
            }
            return Err(error);
        }
        self.inner.prompts.fetch_add(1, Ordering::AcqRel);
        let turn_id = self.debug_turn_id();
        self.publish(DebugEvent::AgentInput {
            agent: self.inner.leg.clone(),
            turn_id: Some(turn_id.clone()),
            text: message.to_owned(),
            source: local_prompt_source(&self.inner.leg, message).into(),
            utterance_id: utterance_id.map(str::to_owned),
        });
        self.inner.busy.store(true, Ordering::Release);
        let result = self.collect(&turn_id).await;
        self.inner.busy.store(false, Ordering::Release);
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

    async fn collect(&self, turn_id: &str) -> Result<Turn, PiSessionError> {
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
                    return Ok(Turn {
                        text: chunks.join("\n"),
                        signals,
                        failed: true,
                        error,
                    });
                }
                Ok(Ok(LimitedLine::TooLong)) => {
                    tracing::error!(%label, limit = STREAM_LIMIT, "oversized RPC event; dropping the leg");
                    self.close().await;
                    return Ok(Turn {
                        text: String::new(),
                        signals,
                        failed: true,
                        error: "the agent sent something too big to read".into(),
                    });
                }
                Ok(Err(error)) => {
                    tracing::error!(%label, %error, "could not read agent output");
                    return Err(PiSessionError(format!(
                        "could not read agent output: {error}"
                    )));
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
                    self.close().await;
                    return Ok(Turn {
                        text: String::new(),
                        signals,
                        failed: true,
                        error: "the agent stopped responding".into(),
                    });
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
                                self.close().await;
                                return Ok(Turn {
                                    text: String::new(),
                                    signals,
                                    failed: true,
                                    error: "the agent produced too much text in one turn".into(),
                                });
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
        Ok(Turn {
            text,
            signals,
            failed: !error.is_empty(),
            error,
        })
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

/// A module call from a project session that only the application can
/// answer (`speak`, `display`, `view`): the call, its arguments, and the call
/// token it carried. The answer is a module reply body: `status`, `reason`,
/// and optionally `result`.
#[derive(Clone, Debug)]
pub struct AgentCall {
    pub call: String,
    pub token: String,
    pub turn_id: Option<String>,
    pub cause: Option<String>,
    pub args: Value,
}
pub type ModuleCallback =
    Arc<dyn Fn(AgentCall) -> Pin<Box<dyn Future<Output = Value> + Send>> + Send + Sync>;

/// A project session turn boundary reported by the host agent. The callback
/// runs in the session pump, so a start is admitted before its module calls.
#[derive(Clone, Debug)]
pub struct ProjectTurn {
    pub instance_id: u64,
    pub token: String,
    pub turn_id: Option<String>,
    pub cause: String,
    pub ended: bool,
    pub text: String,
}
/// Answers whether the application admitted a self-woken turn's start as an
/// operation of its own; false for every other report.
pub type TurnCallback =
    Arc<dyn Fn(ProjectTurn) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;
/// Called once when the host reports that a project session closed. The PBX
/// uses this to evict a background resident without waiting for another call.
pub type SessionClosedCallback =
    Arc<dyn Fn(String, String, u64) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// How long a host agent has to answer a session command.
const SESSION_COMMAND_WAIT: Duration = Duration::from_secs(30);

/// What starts a project session: where it runs and what it is told.
#[derive(Clone)]
pub struct ProjectLaunch {
    pub host: String,
    pub project: String,
    pub cwd: String,
    /// Model spec, `provider/model:thinking`; any part may be empty.
    pub spec: String,
    /// The voice brief, put at the start of the first prompt and again on
    /// the first prompt after a compaction.
    pub brief: String,
    pub turn_timeout: Duration,
    pub on_activity: Option<ActivityCallback>,
    pub on_module: Option<ModuleCallback>,
    pub on_turn: Option<TurnCallback>,
    pub on_closed: Option<SessionClosedCallback>,
    /// Where the session's conversation is mirrored for the debug page.
    pub debug: Option<DebugBus>,
}

/// The model and effective thinking level a host agent reports for a
/// session.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionState {
    pub model: String,
    pub thinking: String,
    pub provenance: String,
}

impl SessionState {
    fn from_info(info: &Value) -> Self {
        Self {
            model: info["model"].as_str().unwrap_or_default().to_owned(),
            thinking: info["thinking"].as_str().unwrap_or_default().to_owned(),
            provenance: info["provenance"].as_str().unwrap_or("created").to_owned(),
        }
    }
}

/// What reaches a turn while it is being collected.
enum TurnFrame {
    Event { seq: u64, event: Value },
    Snapshot { seq: u64, info: Value },
}

struct AutonomousTurn {
    turn_id: Option<String>,
    cause: String,
    text: Vec<String>,
}

struct ProjectInner {
    hosts: crate::hosts::Hosts,
    host: String,
    /// The daemon's live handle for the session.
    session: String,
    /// The persisted id used to reopen the resident session.
    persistent_session_id: String,
    /// Unique for each live service handle, even when it resumes the same id.
    instance_id: u64,
    label: String,
    /// Provenance controls whether hangup kills or detaches the session.
    provenance: String,
    /// The call token the session was last joined with; module calls must
    /// carry it.
    token: StdMutex<String>,
    turn_timeout: Duration,
    on_activity: Option<ActivityCallback>,
    on_module: Option<ModuleCallback>,
    on_turn: Option<TurnCallback>,
    on_closed: Option<SessionClosedCallback>,
    /// Observation only: nothing here waits on it.
    debug: Option<DebugBus>,
    turn_lock: Mutex<()>,
    busy: AtomicBool,
    closed: AtomicBool,
    released: AtomicBool,
    brief: String,
    brief_due: AtomicBool,
    /// Where the events of the caller turn being collected go.
    turn: StdMutex<Option<tokio::sync::mpsc::UnboundedSender<TurnFrame>>>,
    /// An autonomous turn has no prompt collector, so keep its text and
    /// authority until the host reports turn_end.
    autonomous_turn: StdMutex<Option<AutonomousTurn>>,
    /// Turn id (empty for legacy hosts) of an autonomous turn refused because
    /// a caller operation already owned the leg. Its events must not enter the
    /// caller's collector.
    ignored_autonomous: StdMutex<Option<String>>,
}

impl ProjectInner {
    fn token(&self) -> String {
        self.token
            .lock()
            .map(|token| token.clone())
            .unwrap_or_default()
    }

    /// Hands `frame` to the turn being collected; false when there is none.
    fn to_turn(&self, frame: TurnFrame) -> bool {
        self.turn
            .lock()
            .ok()
            .and_then(|turn| turn.as_ref().map(|turn| turn.send(frame).is_ok()))
            .unwrap_or(false)
    }

    fn start_autonomous(&self, turn_id: Option<String>, cause: String) -> bool {
        let Ok(mut turn) = self.autonomous_turn.lock() else {
            return false;
        };
        if turn.is_some() {
            return false;
        }
        *turn = Some(AutonomousTurn {
            turn_id,
            cause,
            text: Vec::new(),
        });
        self.busy.store(true, Ordering::Release);
        true
    }

    fn append_autonomous_text(&self, turn_id: Option<&str>, text: &str) -> bool {
        let Ok(mut turn) = self.autonomous_turn.lock() else {
            return false;
        };
        let Some(turn) = turn.as_mut() else {
            return false;
        };
        // Modern hosts stamp every text event. A mismatched or missing id is
        // stale once this turn has an authority; legacy turns have no
        // authority and are refused by the API callback instead.
        if turn.turn_id.as_deref() != turn_id {
            return false;
        }
        let collected = turn.text.iter().map(String::len).sum::<usize>();
        if collected.saturating_add(text.len()) <= STREAM_LIMIT {
            turn.text.push(text.to_owned());
        }
        true
    }

    fn finish_autonomous(&self, turn_id: Option<&str>) -> Option<(Option<String>, String, String)> {
        let Ok(mut turn) = self.autonomous_turn.lock() else {
            return None;
        };
        let current = turn.as_ref()?;
        if current.turn_id.as_deref() != turn_id {
            return None;
        }
        let current = turn.take()?;
        self.busy.store(false, Ordering::Release);
        Some((
            current.turn_id,
            current.cause,
            current.text.join("\n").trim().to_owned(),
        ))
    }

    fn autonomous_authority(&self) -> Option<(Option<String>, String)> {
        self.autonomous_turn.lock().ok().and_then(|turn| {
            turn.as_ref()
                .map(|turn| (turn.turn_id.clone(), turn.cause.clone()))
        })
    }

    fn has_turn_collector(&self) -> bool {
        self.turn.lock().ok().is_some_and(|turn| turn.is_some())
    }

    fn ignore_autonomous(&self, turn_id: Option<&str>) {
        if let Ok(mut ignored) = self.ignored_autonomous.lock() {
            *ignored = Some(turn_id.unwrap_or_default().to_owned());
        }
    }

    fn ignored_autonomous(&self, turn_id: Option<&str>) -> bool {
        self.ignored_autonomous
            .lock()
            .ok()
            .and_then(|ignored| ignored.clone())
            .is_some_and(|ignored| ignored == turn_id.unwrap_or_default())
    }

    fn clear_ignored_autonomous(&self) {
        if let Ok(mut ignored) = self.ignored_autonomous.lock() {
            *ignored = None;
        }
    }

    /// Reports a turn boundary to the application; true when it admitted a
    /// self-woken start as an operation of its own.
    async fn report_turn(&self, event: ProjectTurn) -> bool {
        let Some(callback) = &self.on_turn else {
            return false;
        };
        let callback = Arc::clone(callback);
        match AssertUnwindSafe(callback(event)).catch_unwind().await {
            Ok(admitted) => admitted,
            Err(panic) => {
                tracing::error!(label = %self.label, panic = %panic_message(&panic), "turn callback panicked");
                false
            }
        }
    }

    /// Queues release for this session exactly once. A session taken over from
    /// a desk is never killed: abort its active turn first, then detach it so
    /// the desk can keep owning it. Release is separate from `closed`: a host
    /// command can mark a handle closed before its lifecycle owner gets a
    /// chance to release a taken-over session.
    fn release_in_background(&self) {
        if self.released.swap(true, Ordering::AcqRel) {
            return;
        }
        self.hosts.unsubscribe(&self.host, &self.session);
        let host = self.host.clone();
        let session = self.session.clone();
        let label = self.label.clone();
        let taken_over = self.provenance == "taken_over";
        let hosts = self.hosts.clone();
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        runtime.spawn(async move {
            if taken_over {
                if let Ok(abort) = hosts.send_command(&host, "abort", json!({"session": session})) {
                    if let Err(error) = abort.reply(SESSION_COMMAND_WAIT).await {
                        tracing::warn!(%label, %host, %error, "could not abort the taken-over project session");
                    }
                } else {
                    tracing::warn!(%label, %host, "could not queue abort for the taken-over project session");
                }
                match hosts.send_command(&host, "detach", json!({"session": session})) {
                    Ok(sent) => match sent.reply(SESSION_COMMAND_WAIT).await {
                        Ok(_) => tracing::info!(%label, %host, "taken-over project session detached"),
                        Err(error) => tracing::warn!(%label, %host, %error, "could not detach the taken-over project session"),
                    },
                    Err(error) => tracing::warn!(%label, %host, %error, "could not detach the taken-over project session"),
                }
            } else {
                match hosts.send_command(&host, "kill", json!({"session": session})) {
                    Ok(sent) => match sent.reply(SESSION_COMMAND_WAIT).await {
                        Ok(_) => tracing::info!(%label, %host, "project session ended"),
                        Err(error) => tracing::warn!(%label, %host, %error, "could not end the project session"),
                    },
                    Err(error) => tracing::warn!(%label, %host, %error, "could not end the project session"),
                }
            }
        });
    }

    async fn report_closed(&self) {
        if let Some(callback) = &self.on_closed {
            let callback = Arc::clone(callback);
            if let Err(panic) = AssertUnwindSafe(callback(
                self.label.clone(),
                self.persistent_session_id.clone(),
                self.instance_id,
            ))
            .catch_unwind()
            .await
            {
                tracing::error!(label = %self.label, panic = %panic_message(&panic), "session closed callback panicked");
            }
        }
    }

    async fn mark_closed(&self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            self.report_closed().await;
        }
    }

    fn publish(&self, event: DebugEvent) {
        if let Some(bus) = &self.debug {
            bus.publish(event);
        }
    }

    /// Mirrors a host event to the debug page: tool calls with the
    /// arguments and results new hosts send, and each assistant message.
    /// Every event is mirrored, whichever turn it belongs to.
    fn mirror_event(&self, event: &Value) {
        if !self.debug.as_ref().is_some_and(DebugBus::enabled) {
            return;
        }
        let call_id = || event["call_id"].as_str().map(str::to_owned);
        let tool = || event["tool"].as_str().unwrap_or_default().to_owned();
        let turn_id = || event["turn_id"].as_str().map(str::to_owned);
        match event["kind"].as_str() {
            Some("tool_start") => self.publish(DebugEvent::ToolStart {
                agent: self.label.clone(),
                call_id: call_id(),
                tool: tool(),
                args: event.get("args").filter(|v| !v.is_null()).cloned(),
                turn_id: turn_id(),
            }),
            Some("tool_end") => {
                let result = event.get("result").filter(|value| !value.is_null());
                self.publish(DebugEvent::ToolEnd {
                    agent: self.label.clone(),
                    call_id: call_id(),
                    tool: tool(),
                    result: result.cloned(),
                    error: (event["error"] == true).then(|| tool_error_text(result)),
                    turn_id: turn_id(),
                });
            }
            Some("text") => {
                if let Some(text) = event["text"]
                    .as_str()
                    .filter(|text| !text.trim().is_empty())
                {
                    self.publish(DebugEvent::AgentText {
                        agent: self.label.clone(),
                        turn_id: turn_id(),
                        text: text.to_owned(),
                        final_: false,
                    });
                }
            }
            _ => {}
        }
    }

    /// The whole reply of a settled turn, for the debug page.
    fn publish_final(&self, turn_id: Option<String>, text: &str) {
        if !text.trim().is_empty() {
            self.publish(DebugEvent::AgentText {
                agent: self.label.clone(),
                turn_id,
                text: text.to_owned(),
                final_: true,
            });
        }
    }

    /// What the service sent the session, for the debug page.
    fn publish_input(&self, text: &str, source: &str, utterance_id: Option<&str>) {
        self.publish(DebugEvent::AgentInput {
            agent: self.label.clone(),
            turn_id: None,
            text: text.to_owned(),
            source: source.into(),
            utterance_id: utterance_id.map(str::to_owned),
        });
    }

    async fn report_activity(&self, state: &str, tool: &str) {
        if let Some(callback) = &self.on_activity {
            let activity = Activity {
                state: state.into(),
                tool: tool.into(),
                detail: String::new(),
                label: self.label.clone(),
                leg: self.token(),
            };
            if let Err(panic) = AssertUnwindSafe(callback(activity)).catch_unwind().await {
                tracing::error!(label = %self.label, tool, panic = %panic_message(&panic), "activity callback panicked");
            }
        }
    }
}

impl Drop for ProjectInner {
    /// A session the service created dies with its last handle, so one whose
    /// transfer was cancelled half way is not left running on its host.
    fn drop(&mut self) {
        if self.provenance == "taken_over" {
            self.closed.store(true, Ordering::Release);
            self.release_in_background();
        } else if !self.closed.swap(true, Ordering::AcqRel) {
            self.release_in_background();
        }
    }
}

/// A project leg: a resident prime-agent session on a project host, reached
/// through its host agent. Turns end on the host link's settled `turn_end`;
/// the session's module calls arrive as frames and are answered here.
#[derive(Clone)]
pub struct ProjectSession {
    inner: Arc<ProjectInner>,
}

/// Marks a turn as being collected, and clears the mark however the turn
/// ends, cancellation included.
struct Collecting<'a>(&'a ProjectInner);

impl Drop for Collecting<'_> {
    fn drop(&mut self) {
        if let Ok(mut turn) = self.0.turn.lock() {
            turn.take();
        }
        // A run the host started right behind this turn keeps the session
        // busy. Checked under the lock its start and finish set `busy` under,
        // so neither can land between the check and the store.
        let Ok(autonomous) = self.0.autonomous_turn.lock() else {
            self.0.busy.store(false, Ordering::Release);
            return;
        };
        if autonomous.is_none() {
            self.0.busy.store(false, Ordering::Release);
        }
    }
}

impl ProjectSession {
    /// Creates a resident session for `launch` on its host and starts
    /// listening to it. The session is not on the call until `join_call`.
    pub async fn create(
        hosts: &crate::hosts::Hosts,
        launch: ProjectLaunch,
    ) -> Result<(Self, SessionState), PiSessionError> {
        let (provider, model, thinking) = crate::models::parse_spec(&launch.spec);
        let mut config = json!({"cwd": launch.cwd});
        for (key, value) in [
            ("provider", provider),
            ("model", model),
            ("thinking", thinking),
        ] {
            if !value.is_empty() {
                config[key] = Value::String(value);
            }
        }
        tracing::info!(project = %launch.project, host = %launch.host, "creating a project session");
        let reply = hosts
            .command(
                &launch.host,
                "create_session",
                json!({"project": launch.project, "config": config}),
                SESSION_COMMAND_WAIT,
            )
            .await
            .map_err(|error| PiSessionError(format!("could not start a session: {error}")))?;
        Self::from_open_reply(hosts, launch, reply, None, "created", "created", None).await
    }

    /// Reopens a saved resident session after a service restart. The host
    /// validates the cwd and project provenance before returning the live
    /// handle; this path never creates a second session.
    pub async fn open(
        hosts: &crate::hosts::Hosts,
        launch: ProjectLaunch,
        session_id: &str,
    ) -> Result<(Self, SessionState), PiSessionError> {
        if session_id.trim().is_empty() {
            return Err(PiSessionError("a saved session id is required".into()));
        }
        tracing::info!(project = %launch.project, host = %launch.host, session_id, "opening a project session");
        let reply = hosts
            .command(
                &launch.host,
                "open_session",
                json!({"session_id": session_id, "cwd": launch.cwd, "project": launch.project}),
                SESSION_COMMAND_WAIT,
            )
            .await
            .map_err(|error| PiSessionError(format!("could not open a session: {error}")))?;
        Self::from_open_reply(
            hosts,
            launch,
            reply,
            Some(session_id),
            "opened",
            "created",
            None,
        )
        .await
    }

    /// Attaches to a live desk session in the registered folder. This never
    /// creates or reopens a daemon session; its `taken_over` provenance makes
    /// close release it with abort followed by detach.
    pub async fn attach(
        hosts: &crate::hosts::Hosts,
        launch: ProjectLaunch,
        session: &str,
    ) -> Result<(Self, SessionState), PiSessionError> {
        if session.trim().is_empty() {
            return Err(PiSessionError("a live session handle is required".into()));
        }
        tracing::info!(project = %launch.project, host = %launch.host, session, "taking over a desk session");
        let reply = hosts
            .command(
                &launch.host,
                "attach",
                json!({"session": session, "project": launch.project, "cwd": launch.cwd}),
                SESSION_COMMAND_WAIT,
            )
            .await
            .map_err(|error| PiSessionError(format!("could not take over a session: {error}")))?;
        let result = Self::from_open_reply(
            hosts,
            launch.clone(),
            reply,
            None,
            "attached",
            "taken_over",
            Some("taken_over"),
        )
        .await;
        if result.is_err() {
            // The host persists taken_over provenance before replying. A
            // malformed success must therefore undo the attach even though no
            // session handle could be built for the pump.
            match hosts
                .command(
                    &launch.host,
                    "detach",
                    json!({"session": session}),
                    SESSION_COMMAND_WAIT,
                )
                .await
            {
                Ok(_) => {
                    tracing::info!(host = %launch.host, session, "rolled back malformed desk takeover")
                }
                Err(error) => {
                    tracing::warn!(host = %launch.host, session, %error, "could not roll back malformed desk takeover")
                }
            }
        }
        result
    }

    async fn from_open_reply(
        hosts: &crate::hosts::Hosts,
        launch: ProjectLaunch,
        reply: crate::hosts::CommandReply,
        requested_session_id: Option<&str>,
        verb: &str,
        default_provenance: &str,
        forced_provenance: Option<&str>,
    ) -> Result<(Self, SessionState), PiSessionError> {
        let Some(session) = reply.result["session"].as_str().map(str::to_owned) else {
            return Err(PiSessionError(
                "the host agent did not name the new session".into(),
            ));
        };
        let frames = hosts.subscribe(&launch.host, &session);
        let inner = Arc::new(ProjectInner {
            hosts: hosts.clone(),
            host: launch.host,
            session,
            persistent_session_id: requested_session_id
                .map(str::to_owned)
                .or_else(|| reply.result["session_id"].as_str().map(str::to_owned))
                .unwrap_or_default(),
            instance_id: NEXT_PROJECT_INSTANCE_ID.fetch_add(1, Ordering::Relaxed),
            label: launch.project,
            provenance: forced_provenance
                .or_else(|| reply.result["provenance"].as_str())
                .unwrap_or(default_provenance)
                .to_owned(),
            token: StdMutex::new(String::new()),
            turn_timeout: launch.turn_timeout,
            on_activity: launch.on_activity,
            on_module: launch.on_module,
            on_turn: launch.on_turn,
            on_closed: launch.on_closed,
            debug: launch.debug,
            turn_lock: Mutex::new(()),
            busy: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            released: AtomicBool::new(false),
            brief: launch.brief,
            brief_due: AtomicBool::new(true),
            turn: StdMutex::new(None),
            autonomous_turn: StdMutex::new(None),
            ignored_autonomous: StdMutex::new(None),
        });
        tokio::spawn(pump(Arc::downgrade(&inner), frames));
        tracing::info!(label = %inner.label, host = %inner.host, name = reply.result["name"].as_str().unwrap_or_default(), %verb, "project session ready");
        Ok((Self { inner }, SessionState::from_info(&reply.result)))
    }

    pub fn label(&self) -> &str {
        &self.inner.label
    }

    pub fn token(&self) -> String {
        self.inner.token()
    }

    pub fn session_id(&self) -> &str {
        &self.inner.persistent_session_id
    }

    pub fn is_taken_over(&self) -> bool {
        self.inner.provenance == "taken_over"
    }

    pub fn instance_id(&self) -> u64 {
        self.inner.instance_id
    }

    pub fn busy(&self) -> bool {
        self.inner.busy.load(Ordering::Acquire)
    }
    pub fn alive(&self) -> bool {
        !self.inner.closed.load(Ordering::Acquire)
    }
    pub fn same_session(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    async fn command(
        &self,
        name: &str,
        mut args: Value,
    ) -> Result<crate::hosts::CommandReply, PiSessionError> {
        if !self.alive() {
            return Err(PiSessionError("the project session has ended".into()));
        }
        args["session"] = Value::String(self.inner.session.clone());
        match self
            .inner
            .hosts
            .command(&self.inner.host, name, args, SESSION_COMMAND_WAIT)
            .await
        {
            Ok(reply) => Ok(reply),
            Err(error) => {
                // A failed host command means this resident is no longer
                // usable. Mark it closed before returning so its owner can
                // evict it instead of publishing a misleading idle state.
                self.inner.mark_closed().await;
                Err(PiSessionError(error.to_string()))
            }
        }
    }

    /// Puts the session on the call with `token`: module calls must carry it
    /// from now on, and any carrying an earlier one are refused.
    pub async fn join_call(
        &self,
        token: &str,
        persona: &str,
        speech_deadline_ms: u64,
    ) -> Result<(), PiSessionError> {
        self.join_call_mode(token, persona, speech_deadline_ms, "foreground")
            .await
    }

    /// Puts the session on the call in an explicit delivery mode. Background
    /// sessions stay live but the host agent refuses their speech.
    pub async fn join_call_mode(
        &self,
        token: &str,
        persona: &str,
        speech_deadline_ms: u64,
        mode: &str,
    ) -> Result<(), PiSessionError> {
        if let Ok(mut current) = self.inner.token.lock() {
            *current = token.to_owned();
        }
        self.command(
            "join_call",
            json!({"token": token, "persona": persona, "speech_deadline_ms": speech_deadline_ms, "mode": mode}),
        )
        .await
        .map(|_| ())
    }

    /// Changes delivery mode without replacing the resident session.
    pub async fn set_mode(&self, mode: &str) -> Result<(), PiSessionError> {
        self.command("set_mode", json!({"mode": mode}))
            .await
            .map(|_| ())
    }

    /// Switches the live session to `provider/model`; it keeps its history.
    pub async fn set_model(
        &self,
        provider: &str,
        model: &str,
    ) -> Result<SessionState, PiSessionError> {
        let reply = self
            .command("set_model", json!({"provider": provider, "model": model}))
            .await?;
        Ok(SessionState::from_info(&reply.result))
    }

    /// Sets the live session's thinking level; the reply has the level the
    /// model actually runs at.
    pub async fn set_thinking(&self, level: &str) -> Result<SessionState, PiSessionError> {
        let reply = self
            .command("set_thinking", json!({"level": level}))
            .await?;
        Ok(SessionState::from_info(&reply.result))
    }

    /// Ends the session on its host. Idempotent; nothing waits for the host.
    pub fn close(&self) {
        let was_closed = self.inner.closed.swap(true, Ordering::AcqRel);
        if self.inner.provenance == "taken_over" || !was_closed {
            tracing::info!(label = %self.inner.label, "closing the project session");
            self.inner.release_in_background();
        }
    }

    /// Aborts the running turn, if any; the session stays. The abort is
    /// queued now, ahead of anything sent after it; nothing waits for the
    /// host.
    pub fn interrupt(&self) {
        if !self.alive() {
            return;
        }
        let inner = &self.inner;
        let sent =
            inner
                .hosts
                .send_command(&inner.host, "abort", json!({"session": inner.session}));
        let label = inner.label.clone();
        match sent {
            Ok(sent) => {
                tokio::spawn(async move {
                    if let Err(error) = sent.reply(SESSION_COMMAND_WAIT).await {
                        tracing::info!(%label, %error, "could not abort the project turn");
                    }
                });
            }
            Err(error) => tracing::info!(%label, %error, "could not abort the project turn"),
        }
    }

    pub async fn steer(
        &self,
        message: &str,
        utterance_id: Option<&str>,
    ) -> Result<(), PiSessionError> {
        if !self.busy() {
            return Err(PiSessionError("agent turn is no longer running".into()));
        }
        let result = self
            .command("steer", json!({"message": message}))
            .await
            .map(|_| ());
        match &result {
            Ok(()) => {
                tracing::info!(label = %self.inner.label, chars = message.chars().count(), "steered the running turn");
                self.inner.publish_input(message, "steer", utterance_id);
            }
            Err(error) => {
                tracing::info!(label = %self.inner.label, %error, "could not steer the running turn")
            }
        }
        result
    }

    /// `prompt_as` for a caller line with no utterance id. Production code
    /// always names the source; tests use this shorthand.
    #[cfg(test)]
    pub async fn prompt(&self, message: &str) -> Result<Turn, PiSessionError> {
        self.prompt_as(message, "caller", None).await
    }

    /// Sends `message` and collects the turn until the host link says it has
    /// settled. The voice brief goes first when it is due: on the first
    /// prompt, and on the first after a compaction. `source` says for the
    /// debug page what the message is (`caller`, `intro`, `foreground`,
    /// `model_change`), and `utterance_id` names the caller line it carries,
    /// if any.
    pub async fn prompt_as(
        &self,
        message: &str,
        source: &str,
        utterance_id: Option<&str>,
    ) -> Result<Turn, PiSessionError> {
        let _turn = self.inner.turn_lock.lock().await;
        if !self.alive() {
            return Err(PiSessionError("the project session has ended".into()));
        }
        let (sender, mut frames) = tokio::sync::mpsc::unbounded_channel();
        if let Ok(mut turn) = self.inner.turn.lock() {
            *turn = Some(sender);
        }
        self.inner.busy.store(true, Ordering::Release);
        let _collecting = Collecting(&self.inner);
        let briefed = self.inner.brief_due.swap(false, Ordering::AcqRel);
        // Published as the prompt goes out: the host's first events can be
        // read before its reply to the prompt is. The page shows the brief as
        // an input of its own, so the pane can fold it away.
        if briefed {
            self.inner.publish_input(&self.inner.brief, "brief", None);
        }
        self.inner.publish_input(message, source, utterance_id);
        let message = if briefed {
            format!("{}\n\n{message}", self.inner.brief)
        } else {
            message.to_owned()
        };
        let sent = match self.command("prompt", json!({"message": message})).await {
            Ok(reply) => reply,
            Err(error) => {
                if briefed {
                    self.inner.brief_due.store(true, Ordering::Release);
                }
                return Err(error);
            }
        };
        Ok(self.collect(&mut frames, sent.seq).await)
    }

    /// Collects the turn's text and signals until `turn_end`. Frames the
    /// host sent before the prompt's reply (`from`) belong to an earlier
    /// turn, such as the tail of one that was aborted, and are skipped.
    async fn collect(
        &self,
        frames: &mut tokio::sync::mpsc::UnboundedReceiver<TurnFrame>,
        from: u64,
    ) -> Turn {
        let label = &self.inner.label;
        let mut texts: Vec<String> = Vec::new();
        let signals = Vec::new();
        let mut error = String::new();
        let mut settled_turn = None;
        loop {
            let frame = match timeout(self.inner.turn_timeout, frames.recv()).await {
                Ok(Some(frame)) => frame,
                Ok(None) | Err(_) => {
                    tracing::warn!(%label, timeout = ?self.inner.turn_timeout, "the project agent went silent past the turn deadline");
                    self.interrupt();
                    return Turn {
                        text: String::new(),
                        signals,
                        failed: true,
                        error: "the agent stopped responding".into(),
                    };
                }
            };
            let (seq, event) = match frame {
                TurnFrame::Snapshot { seq, info } => {
                    // A host that lost track of the turn settles it here: a
                    // snapshot of an idle session is a turn that has ended.
                    if seq < from || info["turn_open"] != false || info["busy"] == true {
                        continue;
                    }
                    if texts.is_empty() {
                        if let Some(last) = info["last_text"]
                            .as_str()
                            .filter(|text| !text.trim().is_empty())
                        {
                            texts.push(last.trim().to_owned());
                        }
                    }
                    break;
                }
                TurnFrame::Event { seq, event } => (seq, event),
            };
            if seq < from {
                continue;
            }
            match event["kind"].as_str() {
                Some("text") => {
                    let Some(text) = event["text"]
                        .as_str()
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                    else {
                        continue;
                    };
                    let collected = texts.iter().map(String::len).sum::<usize>();
                    if collected.saturating_add(text.len()) > STREAM_LIMIT {
                        tracing::error!(%label, collected, limit = STREAM_LIMIT, "agent produced too much text in one turn");
                        self.interrupt();
                        return Turn {
                            text: String::new(),
                            signals,
                            failed: true,
                            error: "the agent produced too much text in one turn".into(),
                        };
                    }
                    texts.push(text.to_owned());
                }
                Some("error") => {
                    error = spoken_error(event.get("message"));
                    tracing::error!(%label, error = %error, "the agent's model call failed");
                }
                Some("turn_end") => {
                    if let Some(failure) = event.get("error").filter(|value| !value.is_null()) {
                        if error.is_empty() {
                            error = spoken_error(Some(failure));
                        }
                    }
                    settled_turn = event["turn_id"].as_str().map(str::to_owned);
                    break;
                }
                Some("session_closed") => {
                    tracing::warn!(%label, reason = event["reason"].as_str().unwrap_or_default(), "the project session closed mid-turn");
                    return Turn {
                        text: texts.join("\n"),
                        signals,
                        failed: true,
                        error: "the project session ended".into(),
                    };
                }
                _ => {}
            }
        }
        let text = texts.join("\n").trim().to_owned();
        self.inner.publish_final(settled_turn, &text);
        Turn {
            text,
            signals,
            failed: !error.is_empty(),
            error,
        }
    }
}

/// Reads a project session's frames for as long as its handle lives: turn
/// events go to the turn being collected, activity to the page, and module
/// calls are answered.
async fn pump(
    inner: std::sync::Weak<ProjectInner>,
    mut frames: tokio::sync::mpsc::UnboundedReceiver<crate::hosts::SessionFrame>,
) {
    use crate::hosts::SessionFrame;
    while let Some(frame) = frames.recv().await {
        let Some(inner) = inner.upgrade() else {
            return;
        };
        match frame {
            SessionFrame::Event { seq, event } => {
                inner.mirror_event(&event);
                let kind = event["kind"].as_str().unwrap_or_default();
                if kind == "turn_start" {
                    let cause = event["cause"].as_str().unwrap_or("unknown").to_owned();
                    let turn_id = event["turn_id"].as_str().map(str::to_owned);
                    if matches!(cause.as_str(), "autonomous" | "unknown") {
                        let start = ProjectTurn {
                            instance_id: inner.instance_id,
                            token: inner.token(),
                            turn_id: turn_id.clone(),
                            cause: cause.clone(),
                            ended: false,
                            text: String::new(),
                        };
                        if inner.has_turn_collector() {
                            // The host opens a turn only once the one before
                            // it settled. So a self-woken start seen while the
                            // caller's prompt is collected either carries that
                            // prompt (it reached a session that had just woken
                            // itself), and the collector keeps it, or it follows
                            // the caller's turn straight away: a run resumed
                            // after an external abort, or a wake queued behind
                            // the turn. The application tells them apart: it
                            // admits the start only once the caller's operation
                            // has closed, which the host's settle report of
                            // that turn does (`settle_turn`).
                            if inner.autonomous_authority().is_none()
                                && inner.report_turn(start).await
                            {
                                inner.start_autonomous(turn_id, cause);
                                inner.clear_ignored_autonomous();
                            } else {
                                inner.to_turn(TurnFrame::Event { seq, event });
                            }
                            continue;
                        }
                        if inner.start_autonomous(turn_id.clone(), cause.clone()) {
                            inner.clear_ignored_autonomous();
                            inner.report_turn(start).await;
                        } else {
                            inner.ignore_autonomous(turn_id.as_deref());
                        }
                        // With no prompt being collected, an autonomous
                        // start, admitted or refused, is no caller's turn.
                        continue;
                    } else {
                        inner.clear_ignored_autonomous();
                        inner
                            .report_turn(ProjectTurn {
                                instance_id: inner.instance_id,
                                token: inner.token(),
                                turn_id,
                                cause,
                                ended: false,
                                text: String::new(),
                            })
                            .await;
                    }
                }
                match kind {
                    "compaction" if event["phase"] == "end" => {
                        tracing::info!(label = %inner.label, "the project session compacted; the brief goes out again");
                        inner.brief_due.store(true, Ordering::Release);
                    }
                    "session_closed" => {
                        inner.mark_closed().await;
                    }
                    "tool_start" => {
                        inner.report_activity("life", "").await;
                        inner
                            .report_activity("start", event["tool"].as_str().unwrap_or_default())
                            .await;
                    }
                    "tool_end" => {
                        inner
                            .report_activity("end", event["tool"].as_str().unwrap_or_default())
                            .await;
                    }
                    "text" => {
                        inner.report_activity("life", "").await;
                        let event_turn_id = event["turn_id"].as_str();
                        if inner.ignored_autonomous(event_turn_id)
                            || inner.append_autonomous_text(
                                event["turn_id"].as_str(),
                                event["text"].as_str().unwrap_or_default(),
                            )
                        {
                            continue;
                        }
                    }
                    "turn_end" => {
                        let event_turn_id = event["turn_id"].as_str();
                        if inner.ignored_autonomous(event_turn_id) {
                            inner.clear_ignored_autonomous();
                            continue;
                        }
                        if let Some((turn_id, cause, text)) = inner.finish_autonomous(event_turn_id)
                        {
                            inner.publish_final(turn_id.clone(), &text);
                            inner
                                .report_turn(ProjectTurn {
                                    instance_id: inner.instance_id,
                                    token: inner.token(),
                                    turn_id,
                                    cause,
                                    ended: true,
                                    text,
                                })
                                .await;
                            continue;
                        }
                    }
                    _ => {}
                }
                if inner.autonomous_authority().is_some() {
                    continue;
                }
                let settled = (kind == "turn_end")
                    .then(|| event["turn_id"].as_str().map(str::to_owned))
                    .flatten();
                inner.to_turn(TurnFrame::Event { seq, event });
                if let Some(turn_id) = settled {
                    // The caller's turn settled on the host. Its operation
                    // closes on this report, not when the prompt returns, so
                    // a run the host starts right behind it is admitted.
                    inner
                        .report_turn(ProjectTurn {
                            instance_id: inner.instance_id,
                            token: inner.token(),
                            turn_id: Some(turn_id),
                            cause: "input".into(),
                            ended: true,
                            text: String::new(),
                        })
                        .await;
                }
            }
            SessionFrame::Snapshot { seq, info } => {
                if inner.autonomous_authority().is_some() && info["turn_open"] == false {
                    if let Some((turn_id, cause, text)) =
                        inner.finish_autonomous(info["turn_id"].as_str())
                    {
                        let text = if text.is_empty() {
                            info["last_text"].as_str().unwrap_or_default().to_owned()
                        } else {
                            text
                        };
                        inner.publish_final(turn_id.clone(), &text);
                        inner
                            .report_turn(ProjectTurn {
                                instance_id: inner.instance_id,
                                token: inner.token(),
                                turn_id,
                                cause,
                                ended: true,
                                text,
                            })
                            .await;
                        continue;
                    }
                }
                if !inner.has_turn_collector()
                    && inner.autonomous_authority().is_none()
                    && info["turn_open"] == true
                {
                    let cause = info["cause"].as_str().unwrap_or("unknown").to_owned();
                    let turn_id = info["turn_id"].as_str().map(str::to_owned);
                    if inner.start_autonomous(turn_id.clone(), cause.clone()) {
                        inner
                            .report_turn(ProjectTurn {
                                instance_id: inner.instance_id,
                                token: inner.token(),
                                turn_id,
                                cause,
                                ended: false,
                                text: String::new(),
                            })
                            .await;
                        continue;
                    }
                }
                inner.to_turn(TurnFrame::Snapshot { seq, info });
            }
            SessionFrame::ModuleCall(call) => {
                // Keep side effects before the matching turn_end. The daemon
                // waits for this response, so awaiting here preserves turn
                // authority without introducing another lifecycle owner.
                answer_module_call(inner, call).await;
            }
        }
    }
}

/// Answers one module call. A call must carry the session's current call
/// token; routing signals become signals of the turn being collected, and
/// the rest go to the application. The call and its answer are mirrored to
/// the debug page, refusals included, after the answer is sent: the mirror
/// takes the call's fields instead of copying them, and never delays the
/// answer.
async fn answer_module_call(inner: Arc<ProjectInner>, mut call: crate::hosts::ModuleCall) {
    let reply = module_reply(&inner, &call).await;
    let ok = matches!(reply["status"].as_str(), Some("delivered" | "accepted"));
    let detail = reply.clone();
    let call_id = std::mem::take(&mut call.id);
    let name = std::mem::take(&mut call.call);
    let args = std::mem::take(&mut call.args);
    let turn_id = call.turn_id.take();
    call.answer(reply);
    inner.publish(DebugEvent::ModuleCall {
        agent: inner.label.clone(),
        call_id: call_id.clone(),
        name,
        args,
        turn_id,
    });
    inner.publish(DebugEvent::ModuleResult {
        agent: inner.label.clone(),
        call_id,
        ok,
        detail,
    });
}

/// The answer to one module call (`answer_module_call`).
async fn module_reply(inner: &ProjectInner, call: &crate::hosts::ModuleCall) -> Value {
    let label = inner.label.clone();
    if call.token.is_empty() || call.token != inner.token() {
        tracing::info!(%label, call = %call.call, "module call with a stale call token refused");
        return json!({"status": "refused", "reason": "not_on_call"});
    }
    match call.call.as_str() {
        // These names remain recognized for one release so hosts that still
        // have the old module installed get a useful result. They are not
        // signals: stale hosts must never move the caller.
        "transfer_to_project" | "return_to_operator" | "set_model" => {
            tracing::info!(%label, call = %call.call, "removed project routing call refused");
            json!({"status": "refused", "reason": "removed"})
        }
        SPEAK_TOOL | "request_to_speak" | "display" | "view" => {
            let Some(callback) = inner.on_module.clone() else {
                return json!({"status": "failed", "reason": "failed"});
            };
            let mut args = call.args.clone();
            if call.call == "request_to_speak" {
                if let Some(object) = args.as_object_mut() {
                    object.insert("_project".into(), Value::String(label.clone()));
                }
            }
            let (turn_id, cause) = match (call.turn_id.clone(), call.cause.clone()) {
                (Some(turn_id), cause) => (Some(turn_id), cause),
                (None, Some(cause)) => (None, Some(cause)),
                (None, None) => inner
                    .autonomous_authority()
                    .map(|(_, cause)| (None, Some(cause)))
                    .unwrap_or((None, None)),
            };
            let request = AgentCall {
                call: call.call.clone(),
                token: call.token.clone(),
                turn_id,
                cause,
                args,
            };
            match AssertUnwindSafe(callback(request)).catch_unwind().await {
                Ok(reply) => reply,
                Err(panic) => {
                    tracing::error!(%label, call = %call.call, panic = %panic_message(&panic), "module call handler panicked");
                    json!({"status": "failed", "reason": "failed"})
                }
            }
        }
        _ => json!({"status": "refused", "reason": "unknown_call"}),
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
    pub async fn steer(
        &self,
        message: &str,
        utterance_id: Option<&str>,
    ) -> Result<(), PiSessionError> {
        match self {
            Self::Operator(session) => session.steer(message, utterance_id).await,
            Self::Project(session) => session.steer(message, utterance_id).await,
        }
    }
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
            #[allow(unused_imports)]
            use std::os::unix::process::CommandExt;
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
fn tool_error_text(result: Option<&Value>) -> String {
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

fn spoken_error(detail: Option<&Value>) -> String {
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

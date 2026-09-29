use futures_util::FutureExt;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
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
    pub tool_call_id: Option<String>,
    pub successful_end: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Turn {
    pub text: String,
    pub signals: Vec<Signal>,
    pub failed: bool,
    pub error: String,
}
impl Turn {
    pub fn agent_spoke(&self) -> bool {
        self.signals
            .iter()
            .any(|signal| signal.name == SPEAK_TOOL && signal.successful_end)
    }
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
        self.inner.busy.store(true, Ordering::Release);
        let result = self.collect().await;
        self.inner.busy.store(false, Ordering::Release);
        result
    }

    pub async fn steer(&self, message: &str) -> Result<(), PiSessionError> {
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
            Ok(()) => tracing::info!(
                label = %self.inner.label,
                chars = message.chars().count(),
                "steered the running turn"
            ),
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

    async fn collect(&self) -> Result<Turn, PiSessionError> {
        let mut chunks = Vec::new();
        let mut signals = Vec::new();
        let mut error = String::new();
        let mut response_life_reported = false;
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
                    if event_type == Some("text_end") {
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
                    if [
                        ROUTE_TOOL,
                        SECOND_OPINION_TOOL,
                        DISPATCH_PARTS_TOOL,
                        REWRITE_TOOL,
                        SPEAK_TOOL,
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
                            tool_call_id: event
                                .get("toolCallId")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            successful_end: false,
                        });
                    }
                    self.report_activity("start", name, activity_detail(event.get("args")))
                        .await;
                }
                Some("tool_execution_end") => {
                    let name = event.get("toolName").and_then(Value::as_str).unwrap_or("");
                    let call_id = event.get("toolCallId").and_then(Value::as_str);
                    if name == SPEAK_TOOL {
                        if let Some(signal) = signals.iter_mut().rev().find(|signal| {
                            call_id.is_some()
                                && signal.name == SPEAK_TOOL
                                && signal.tool_call_id.as_deref() == call_id
                        }) {
                            signal.successful_end = !event
                                .get("isError")
                                .and_then(Value::as_bool)
                                .unwrap_or(false);
                        }
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
        let text = chunks.join("\n").trim().to_owned();
        Ok(Turn {
            text,
            signals,
            failed: !error.is_empty(),
            error,
        })
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
    pub args: Value,
}
pub type ModuleCallback =
    Arc<dyn Fn(AgentCall) -> Pin<Box<dyn Future<Output = Value> + Send>> + Send + Sync>;
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
    pub on_closed: Option<SessionClosedCallback>,
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
    Signal(Signal),
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
    on_closed: Option<SessionClosedCallback>,
    turn_lock: Mutex<()>,
    busy: AtomicBool,
    closed: AtomicBool,
    brief: String,
    brief_due: AtomicBool,
    /// Where the events of the turn being collected go.
    turn: StdMutex<Option<tokio::sync::mpsc::UnboundedSender<TurnFrame>>>,
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

    /// Queues kill for service-created sessions. A session taken over from a
    /// desk is never killed: abort its active turn first, then detach it so
    /// the desk can keep owning it.
    fn release_in_background(&self) {
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
        if !self.closed.swap(true, Ordering::AcqRel) {
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
        self.0.busy.store(false, Ordering::Release);
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
        Self::from_open_reply(hosts, launch, reply, None, "created").await
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
        Self::from_open_reply(hosts, launch, reply, Some(session_id), "opened").await
    }

    async fn from_open_reply(
        hosts: &crate::hosts::Hosts,
        launch: ProjectLaunch,
        reply: crate::hosts::CommandReply,
        requested_session_id: Option<&str>,
        verb: &str,
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
            provenance: reply.result["provenance"]
                .as_str()
                .unwrap_or(if verb == "opened" { "created" } else { verb })
                .to_owned(),
            token: StdMutex::new(String::new()),
            turn_timeout: launch.turn_timeout,
            on_activity: launch.on_activity,
            on_module: launch.on_module,
            on_closed: launch.on_closed,
            turn_lock: Mutex::new(()),
            busy: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            brief: launch.brief,
            brief_due: AtomicBool::new(true),
            turn: StdMutex::new(None),
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
        if !self.inner.closed.swap(true, Ordering::AcqRel) {
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

    pub async fn steer(&self, message: &str) -> Result<(), PiSessionError> {
        if !self.busy() {
            return Err(PiSessionError("agent turn is no longer running".into()));
        }
        let result = self
            .command("steer", json!({"message": message}))
            .await
            .map(|_| ());
        match &result {
            Ok(()) => {
                tracing::info!(label = %self.inner.label, chars = message.chars().count(), "steered the running turn")
            }
            Err(error) => {
                tracing::info!(label = %self.inner.label, %error, "could not steer the running turn")
            }
        }
        result
    }

    /// Sends `message` and collects the turn until the host link says it has
    /// settled. The voice brief goes first when it is due: on the first
    /// prompt, and on the first after a compaction.
    pub async fn prompt(&self, message: &str) -> Result<Turn, PiSessionError> {
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
        let mut signals = Vec::new();
        let mut error = String::new();
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
                TurnFrame::Signal(signal) => {
                    signals.push(signal);
                    continue;
                }
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
        Turn {
            text: texts.join("\n").trim().to_owned(),
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
                match event["kind"].as_str() {
                    Some("compaction") if event["phase"] == "end" => {
                        tracing::info!(label = %inner.label, "the project session compacted; the brief goes out again");
                        inner.brief_due.store(true, Ordering::Release);
                    }
                    Some("session_closed") => {
                        inner.mark_closed().await;
                    }
                    Some("tool_start") => {
                        inner.report_activity("life", "").await;
                        inner
                            .report_activity("start", event["tool"].as_str().unwrap_or_default())
                            .await;
                    }
                    Some("tool_end") => {
                        inner
                            .report_activity("end", event["tool"].as_str().unwrap_or_default())
                            .await;
                    }
                    Some("text") => inner.report_activity("life", "").await,
                    _ => {}
                }
                inner.to_turn(TurnFrame::Event { seq, event });
            }
            SessionFrame::Snapshot { seq, info } => {
                inner.to_turn(TurnFrame::Snapshot { seq, info });
            }
            SessionFrame::ModuleCall(call) => {
                tokio::spawn(answer_module_call(inner, call));
            }
        }
    }
}

/// Answers one module call. A call must carry the session's current call
/// token; routing signals become signals of the turn being collected, and
/// the rest go to the application.
async fn answer_module_call(inner: Arc<ProjectInner>, call: crate::hosts::ModuleCall) {
    let label = inner.label.clone();
    if call.token.is_empty() || call.token != inner.token() {
        tracing::info!(%label, call = %call.call, "module call with a stale call token refused");
        call.answer(json!({"status": "refused", "reason": "not_on_call"}));
        return;
    }
    match call.call.as_str() {
        // These names remain recognized for one release so hosts that still
        // have the old module installed get a useful result. They are not
        // signals: stale hosts must never move the caller.
        "transfer_to_project" | "return_to_operator" | "set_model" => {
            tracing::info!(%label, call = %call.call, "removed project routing call refused");
            call.answer(json!({"status": "refused", "reason": "removed"}));
        }
        SPEAK_TOOL | "request_to_speak" | "display" | "view" => {
            let Some(callback) = inner.on_module.clone() else {
                call.answer(json!({"status": "failed", "reason": "failed"}));
                return;
            };
            let mut args = call.args.clone();
            if call.call == "request_to_speak" {
                if let Some(object) = args.as_object_mut() {
                    object.insert("_project".into(), Value::String(label.clone()));
                }
            }
            let request = AgentCall {
                call: call.call.clone(),
                token: call.token.clone(),
                args,
            };
            let reply = match AssertUnwindSafe(callback(request)).catch_unwind().await {
                Ok(reply) => reply,
                Err(panic) => {
                    tracing::error!(%label, call = %call.call, panic = %panic_message(&panic), "module call handler panicked");
                    json!({"status": "failed", "reason": "failed"})
                }
            };
            if call.call == SPEAK_TOOL && reply["status"] == "delivered" {
                inner.to_turn(TurnFrame::Signal(Signal {
                    name: SPEAK_TOOL.into(),
                    args: Map::new(),
                    tool_call_id: None,
                    successful_end: true,
                }));
            }
            call.answer(reply);
        }
        _ => call.answer(json!({"status": "refused", "reason": "unknown_call"})),
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
    pub async fn steer(&self, message: &str) -> Result<(), PiSessionError> {
        match self {
            Self::Operator(session) => session.steer(message).await,
            Self::Project(session) => session.steer(message).await,
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

use futures_util::FutureExt;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, Command};
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

pub const STREAM_LIMIT: usize = 16 * 1024 * 1024;
pub const TRANSFER_TOOL: &str = "transfer_to_project";
pub const RETURN_TOOL: &str = "return_to_operator";
pub const SET_MODEL_TOOL: &str = "set_model";
pub const SPEAK_TOOL: &str = "speak";
pub const RETURN_SENTINEL: &str = "[[SWITCHBOARD:RETURN]]";
const ERROR_STOP_REASON: &str = "error";
const ERROR_DETAIL_CHARS: usize = 160;
const ACTIVITY_DETAIL_CHARS: usize = 80;
const STDERR_LINE_LIMIT: usize = 16 * 1024;
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Activity {
    pub state: String,
    pub tool: String,
    pub detail: String,
    pub label: String,
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
    turn_timeout: Duration,
    on_activity: Option<ActivityCallback>,
    stderr_task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
    process_guard: ProcessTreeGuard,
}

#[derive(Clone)]
pub struct PiSession {
    inner: Arc<SessionInner>,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
}

impl PiSession {
    pub async fn start(
        argv: Vec<String>,
        label: impl Into<String>,
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
        let stderr_task = tokio::spawn(drain_stderr(stderr, tail, label.clone()));
        let inner = Arc::new(SessionInner {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            stdout: Mutex::new(BufReader::new(stdout)),
            stderr_tail,
            busy: AtomicBool::new(false),
            turn_lock: Mutex::new(()),
            label,
            turn_timeout,
            on_activity,
            stderr_task: StdMutex::new(Some(stderr_task)),
            process_guard,
        });
        Ok(Self { inner, argv, cwd })
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
            return Err(PiSessionError(format!(
                "agent process is not running ({})",
                self.stderr_tail(5).as_str()
            )));
        }
        self.write(json!({"type":"prompt", "message":message}), false)
            .await?;
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
                    if [TRANSFER_TOOL, RETURN_TOOL, SET_MODEL_TOOL, SPEAK_TOOL].contains(&name) {
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
        let mut text = chunks.join("\n").trim().to_owned();
        if text.contains(RETURN_SENTINEL) {
            text = text.replace(RETURN_SENTINEL, "").trim().to_owned();
            if !signals.iter().any(|signal| signal.name == RETURN_TOOL) {
                signals.push(Signal {
                    name: RETURN_TOOL.into(),
                    args: Map::from_iter([(String::from("via"), Value::String("sentinel".into()))]),
                    tool_call_id: None,
                    successful_end: true,
                });
            }
        }
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

/// Put a supervised command in its own process group where the platform
/// supports it. Pi and SSH may launch helpers; cancellation must reap the whole
/// local tree rather than only its top-level shell/client.
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

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// An SSH destination that has passed the one-argument boundary. Keeping this
/// validation here means every SSH caller applies the same fail-closed rules.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedSshTarget(String);

impl ValidatedSshTarget {
    pub fn new(raw: &str) -> Result<Self, PiSessionError> {
        let value = raw.trim();
        if value.is_empty() {
            return Err(PiSessionError("SSH target is empty".into()));
        }
        if value.len() > 255 || value.starts_with('-') {
            return Err(PiSessionError("SSH target is invalid".into()));
        }
        if value.chars().any(|character| {
            character.is_control()
                || character.is_whitespace()
                || matches!(
                    character,
                    ';' | '|' | '&' | '$' | '`' | '<' | '>' | '\'' | '"'
                )
        }) {
            return Err(PiSessionError(
                "SSH target contains invalid characters".into(),
            ));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshClientOptions {
    pub ssh_program: String,
    pub target: ValidatedSshTarget,
    pub control_path: Option<std::path::PathBuf>,
}

impl SshClientOptions {
    pub fn new(ssh_program: impl Into<String>, target: ValidatedSshTarget) -> Self {
        Self {
            ssh_program: ssh_program.into(),
            target,
            control_path: None,
        }
    }

    pub fn with_control_path(mut self, control_path: impl Into<std::path::PathBuf>) -> Self {
        self.control_path = Some(control_path.into());
        self
    }

    pub fn base_args(&self) -> Vec<String> {
        let mut args = vec![
            "-T".into(),
            "-o".into(),
            "BatchMode=yes".into(),
            "-o".into(),
            "ConnectTimeout=10".into(),
            "-o".into(),
            "ControlMaster=no".into(),
        ];
        if let Some(control_path) = &self.control_path {
            args.extend([
                "-o".into(),
                format!("ControlPath={}", control_path.display()),
            ]);
        }
        args.push(self.target.as_str().into());
        args
    }

    pub fn remote_command(&self, remote_cmd: &str) -> Command {
        let mut command = Command::new(&self.ssh_program);
        command.args(self.base_args());
        command.arg(remote_cmd);
        command
    }

    #[allow(clippy::too_many_arguments)]
    pub fn remote_argv(
        &self,
        cwd: &str,
        binary: &str,
        model: Option<&str>,
        extension: Option<&str>,
        append_system_prompt: Option<&str>,
        session_id: Option<&str>,
        extra_args: &[String],
        env: &HashMap<String, String>,
    ) -> Vec<String> {
        let mut remote = vec![binary.into(), "--mode".into(), "rpc".into()];
        if let Some(model) = model {
            remote.extend(["--model".into(), model.into()]);
        }
        if let Some(session_id) = session_id {
            remote.extend(["--session-id".into(), session_id.into()]);
        }
        if let Some(extension) = extension {
            remote.extend(["-e".into(), extension.into()]);
        }
        if let Some(prompt) = append_system_prompt {
            remote.extend(["--append-system-prompt".into(), prompt.into()]);
        }
        remote.extend(extra_args.iter().cloned());
        let mut environment = env.iter().collect::<Vec<_>>();
        environment.sort_unstable_by_key(|(left, _)| *left);
        let exports = environment
            .into_iter()
            .map(|(name, value)| format!("export {name}={}; ", shell_quote(value)))
            .collect::<Vec<_>>()
            .join("");
        let command = format!(
            "set -e; cd {}; {}exec {}",
            shell_quote(cwd),
            exports,
            remote
                .iter()
                .map(|arg| shell_quote(arg))
                .collect::<Vec<_>>()
                .join(" ")
        );

        let mut argv = vec![self.ssh_program.clone()];
        argv.extend(self.base_args());
        argv.push(command);
        argv
    }

    pub fn catalog_argv(&self, binary: &str) -> Vec<String> {
        let remote_cmd = format!("{} --list-models", shell_quote(binary));
        let mut argv = vec![self.ssh_program.clone()];
        argv.extend(self.base_args());
        argv.push(remote_cmd);
        argv
    }

    pub fn master_command(&self, control_path: &Path) -> Command {
        let mut command = Command::new(&self.ssh_program);
        command.args([
            "-N",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ControlMaster=yes",
            "-o",
            "ControlPersist=no",
            "-o",
            &format!("ControlPath={}", control_path.display()),
            self.target.as_str(),
        ]);
        command
    }

    pub fn check_command(&self, control_path: &Path) -> Command {
        let mut command = Command::new(&self.ssh_program);
        command.args([
            "-o",
            &format!("ControlPath={}", control_path.display()),
            "-O",
            "check",
            self.target.as_str(),
        ]);
        command
    }

    pub fn exit_command(&self, control_path: &Path) -> Command {
        let mut command = Command::new(&self.ssh_program);
        command.args([
            "-o",
            &format!("ControlPath={}", control_path.display()),
            "-O",
            "exit",
            self.target.as_str(),
        ]);
        command
    }
}

pub fn list_models_argv(binary: &str, ssh_host: &str) -> Vec<String> {
    list_models_argv_with_program("ssh", binary, ssh_host)
}

pub fn list_models_argv_with_program(
    ssh_program: &str,
    binary: &str,
    ssh_host: &str,
) -> Vec<String> {
    if ssh_host.is_empty() {
        return vec![binary.into(), "--list-models".into()];
    }
    let Ok(target) = ValidatedSshTarget::new(ssh_host) else {
        return vec!["ssh-target-invalid".into()];
    };
    SshClientOptions::new(ssh_program, target).catalog_argv(binary)
}

pub fn list_models_argv_checked(binary: &str, target: &ValidatedSshTarget) -> Vec<String> {
    SshClientOptions::new("ssh", target.clone()).catalog_argv(binary)
}
pub fn local_argv(
    binary: &str,
    model: Option<&str>,
    system_prompt_file: Option<&Path>,
    extension: Option<&str>,
    extra_args: &[String],
) -> Result<Vec<String>, PiSessionError> {
    let mut argv = vec![binary.into(), "--mode".into(), "rpc".into()];
    if let Some(model) = model {
        argv.extend(["--model".into(), model.into()]);
    }
    if let Some(path) = system_prompt_file {
        let prompt = std::fs::read_to_string(path).map_err(|error| {
            PiSessionError(format!(
                "could not read system prompt {}: {error}",
                path.display()
            ))
        })?;
        argv.extend(["--system-prompt".into(), prompt]);
    }
    if let Some(extension) = extension {
        argv.extend(["-e".into(), extension.into()]);
    }
    argv.extend(extra_args.iter().cloned());
    Ok(argv)
}
#[allow(clippy::too_many_arguments)]
pub fn remote_argv(
    host: &str,
    cwd: &str,
    binary: &str,
    model: Option<&str>,
    extension: Option<&str>,
    append_system_prompt: Option<&str>,
    session_id: Option<&str>,
    extra_args: &[String],
    env: &HashMap<String, String>,
) -> Vec<String> {
    remote_argv_with_program(
        "ssh",
        host,
        cwd,
        binary,
        model,
        extension,
        append_system_prompt,
        session_id,
        extra_args,
        env,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn remote_argv_with_program(
    ssh_program: &str,
    host: &str,
    cwd: &str,
    binary: &str,
    model: Option<&str>,
    extension: Option<&str>,
    append_system_prompt: Option<&str>,
    session_id: Option<&str>,
    extra_args: &[String],
    env: &HashMap<String, String>,
) -> Vec<String> {
    let Ok(target) = ValidatedSshTarget::new(host) else {
        return vec!["ssh-target-invalid".into()];
    };
    let options = SshClientOptions::new(ssh_program, target);
    options.remote_argv(
        cwd,
        binary,
        model,
        extension,
        append_system_prompt,
        session_id,
        extra_args,
        env,
    )
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

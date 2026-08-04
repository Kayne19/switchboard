use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
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
impl Turn {
    pub fn agent_spoke(&self) -> bool {
        self.signals.iter().any(|signal| signal.name == SPEAK_TOOL)
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
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = &cwd {
            command.current_dir(cwd);
        }
        if let Some(env) = &env {
            command.envs(env);
        }
        let mut child = command
            .spawn()
            .map_err(|error| PiSessionError(format!("could not start {}: {error}", argv[0])))?;
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
        let label = label.into();
        let stderr_task = tokio::spawn(drain_stderr(stderr, tail));
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
        });
        Ok(Self { inner, argv, cwd })
    }

    pub fn busy(&self) -> bool {
        self.inner.busy.load(Ordering::Acquire)
    }
    pub fn same_session(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
    pub async fn alive(&self) -> bool {
        let mut child = self.inner.child.lock().await;
        child
            .as_mut()
            .is_some_and(|child| child.try_wait().ok().flatten().is_none())
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
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
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
        self.write(json!({"type":"steer", "message":message}), true)
            .await
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
        loop {
            let mut line = String::new();
            let read = {
                let mut stdout = self.inner.stdout.lock().await;
                timeout(self.inner.turn_timeout, stdout.read_line(&mut line)).await
            };
            let size = match read {
                Ok(Ok(size)) => size,
                Ok(Err(error)) => {
                    return Err(PiSessionError(format!(
                        "could not read agent output: {error}"
                    )))
                }
                Err(_) => {
                    self.close().await;
                    return Ok(Turn {
                        text: String::new(),
                        signals,
                        failed: true,
                        error: "the agent stopped responding".into(),
                    });
                }
            };
            if size == 0 {
                return Ok(Turn {
                    text: chunks.join("\n"),
                    signals,
                    failed: true,
                    error,
                });
            }
            if line.len() > STREAM_LIMIT {
                self.close().await;
                return Ok(Turn {
                    text: String::new(),
                    signals,
                    failed: true,
                    error: "the agent sent something too big to read".into(),
                });
            }
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                continue;
            }
            let event: Value = match serde_json::from_str(line) {
                Ok(event) => event,
                Err(_) => continue,
            };
            match event.get("type").and_then(Value::as_str) {
                Some("message_update") => {
                    if event
                        .pointer("/assistantMessageEvent/type")
                        .and_then(Value::as_str)
                        == Some("text_end")
                    {
                        if let Some(content) = event
                            .pointer("/assistantMessageEvent/content")
                            .and_then(Value::as_str)
                            .filter(|content| !content.trim().is_empty())
                        {
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
                        error =
                            spoken_error(message.and_then(|message| message.get("errorMessage")));
                    }
                }
                Some("tool_execution_start") => {
                    let name = event.get("toolName").and_then(Value::as_str).unwrap_or("");
                    if [TRANSFER_TOOL, RETURN_TOOL, SET_MODEL_TOOL, SPEAK_TOOL].contains(&name) {
                        signals.push(Signal {
                            name: name.into(),
                            args: event
                                .get("args")
                                .and_then(Value::as_object)
                                .cloned()
                                .unwrap_or_default(),
                        });
                    }
                    self.report_activity("start", name, activity_detail(event.get("args")))
                        .await;
                }
                Some("tool_execution_end") => {
                    self.report_activity(
                        "end",
                        event.get("toolName").and_then(Value::as_str).unwrap_or(""),
                        String::new(),
                    )
                    .await
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
            callback(Activity {
                state: state.into(),
                tool: tool.into(),
                detail,
                label: self.inner.label.clone(),
            })
            .await;
        }
    }
}

async fn drain_stderr(stderr: ChildStderr, tail: Arc<StdMutex<Vec<String>>>) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(mut tail) = tail.lock() {
            tail.push(line);
            if tail.len() > 20 {
                let remove = tail.len() - 20;
                tail.drain(..remove);
            }
        }
    }
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
pub fn list_models_argv(binary: &str, ssh_host: &str) -> Vec<String> {
    if ssh_host.is_empty() {
        return vec![binary.into(), "--list-models".into()];
    }
    vec![
        "ssh".into(),
        "-T".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=10".into(),
        ssh_host.into(),
        format!("{} --list-models", shell_quote(binary)),
    ]
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
    let exports = env
        .iter()
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
    vec![
        "ssh".into(),
        "-T".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=10".into(),
        host.into(),
        command,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quotes_shell_values_and_builds_remote_commands() {
        assert_eq!(shell_quote("a b; rm -rf /"), "'a b; rm -rf /'");
        let args = remote_argv(
            "host",
            "/tmp/a b; rm -rf /",
            "pi",
            None,
            None,
            None,
            None,
            &[],
            &HashMap::new(),
        );
        assert!(args.last().unwrap().contains("cd '/tmp/a b; rm -rf /'"));
        assert!(args.last().unwrap().contains("exec 'pi' '--mode' 'rpc'"));
    }
    #[test]
    fn builds_local_rpc_argv() {
        let args = local_argv(
            "pi",
            Some("anthropic/opus"),
            None,
            Some("/tmp/ext.ts"),
            &["--no-session".into()],
        )
        .unwrap();
        assert_eq!(&args[..3], ["pi", "--mode", "rpc"]);
        assert!(args.contains(&"--no-session".into()));
    }
    #[test]
    fn parses_sentinel_and_activity_detail() {
        assert_eq!(
            activity_detail(Some(&json!({"command":"  ls   -la  "}))),
            "ls -la"
        );
        assert_eq!(
            activity_detail(Some(&json!({"command":"x".repeat(100)}))).len(),
            83
        );
        let unicode = "é".repeat(100);
        let detail = activity_detail(Some(&json!({"command": unicode})));
        assert!(detail.chars().count() <= ACTIVITY_DETAIL_CHARS + 1);
    }
    #[test]
    fn spoken_error_removes_diagnostics() {
        assert_eq!(
            spoken_error(Some(&json!(
                "OAuth failed url=https://example.test; details=secret"
            ))),
            "OAuth failed"
        );
        let unicode = spoken_error(Some(&json!("é".repeat(ERROR_DETAIL_CHARS + 10))));
        assert!(unicode.chars().count() <= ERROR_DETAIL_CHARS + 1);
        assert_eq!(spoken_error(None), "the model call failed");
    }

    #[tokio::test]
    async fn steer_writes_into_the_running_process() {
        let script = "read first; read second; printf '%s\\n' '{\"type\":\"agent_settled\"}'";
        let session = Arc::new(
            PiSession::start(
                vec!["sh".into(), "-c".into(), script.into()],
                "test",
                None,
                None,
                Duration::from_secs(1),
                None,
            )
            .await
            .unwrap(),
        );
        let running = Arc::clone(&session);
        let prompt = tokio::spawn(async move { running.prompt("hello").await.unwrap() });
        for _ in 0..10 {
            if session.busy() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(session.busy());
        session.steer("also check docs").await.unwrap();
        assert!(!prompt.await.unwrap().failed);
        session.close().await;
    }

    #[tokio::test]
    async fn process_prompt_collects_text_signal_and_sentinel() {
        let script = "read line; printf '%s\\n' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_end\",\"content\":\"All done. [[SWITCHBOARD:RETURN]]\"}}' '{\"type\":\"agent_settled\"}'";
        let session = PiSession::start(
            vec!["sh".into(), "-c".into(), script.into()],
            "test",
            None,
            None,
            Duration::from_secs(1),
            None,
        )
        .await
        .unwrap();
        let turn = session.prompt("hello").await.unwrap();
        assert_eq!(turn.text, "All done.");
        assert_eq!(turn.signals[0].name, RETURN_TOOL);
        session.close().await;
    }
}

//! Transitional speech adapters.
//!
//! STT intentionally is not a Rust Whisper implementation: `SttAdapter` runs
//! the command in `SWITCHBOARD_STT_COMMAND`, writes WebM bytes to its stdin,
//! and reads the transcript from stdout. This keeps the service portable while
//! deployments migrate their existing faster-whisper sidecar.

use futures_util::{Stream, StreamExt};
use reqwest::StatusCode;
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{sleep, timeout, Duration, Instant as TokioInstant};

pub const ELEVENLABS_TTS_URL: &str = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}";
const STT_TIMEOUT: Duration = Duration::from_secs(120);
const STT_STDOUT_LIMIT: usize = 1024 * 1024;
const STT_STDERR_LIMIT: usize = 64 * 1024;
/// How much of a failed process's stderr reaches the journal: the end of it,
/// where a traceback or a decoder names what went wrong.
const STDERR_LOG_CHARS: usize = 1000;
const TTS_RESPONSE_LIMIT: usize = 32 * 1024 * 1024;

#[derive(Debug)]
pub enum AudioError {
    MissingSttCommand,
    Deadline,
    Process(String),
    Tts(String),
}
impl std::fmt::Display for AudioError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingSttCommand => f.write_str(
                "SWITCHBOARD_STT_COMMAND is not set; configure a WebM-to-text sidecar command",
            ),
            Self::Deadline => f.write_str("speech deadline expired"),
            Self::Process(s) | Self::Tts(s) => f.write_str(s),
        }
    }
}
impl std::error::Error for AudioError {}

#[derive(Clone, Debug)]
struct TtsRequest {
    url: String,
    api_key: String,
    body: serde_json::Value,
    deadline: Instant,
}

type TtsByteStream = Pin<Box<dyn Stream<Item = Result<Vec<u8>, AudioError>> + Send>>;
type TtsStreamFuture = Pin<
    Box<
        dyn Future<Output = Result<(StatusCode, Option<u64>, TtsByteStream), AudioError>>
            + Send
            + 'static,
    >,
>;

trait TtsTransport: Send + Sync {
    fn send_stream(&self, request: TtsRequest) -> TtsStreamFuture;
}

#[derive(Clone, Debug)]
struct HttpTtsTransport {
    client: reqwest::Client,
}

impl HttpTtsTransport {
    fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}

impl TtsTransport for HttpTtsTransport {
    fn send_stream(&self, request: TtsRequest) -> TtsStreamFuture {
        let client = self.client.clone();
        Box::pin(async move {
            let remaining = request.deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(AudioError::Deadline);
            }
            let response = timeout(
                remaining,
                client
                    .post(request.url)
                    .header("xi-api-key", request.api_key)
                    .header("Content-Type", "application/json")
                    .header("Accept", "audio/mpeg")
                    .json(&request.body)
                    .send(),
            )
            .await
            .map_err(|_| AudioError::Deadline)?
            .map_err(|error| AudioError::Tts(format!("could not reach ElevenLabs: {error}")))?;
            let status = response.status();
            let length = response.content_length();
            if let Some(length) = length.filter(|length| *length > TTS_RESPONSE_LIMIT as u64) {
                tracing::warn!(
                    %status,
                    content_length = length,
                    limit = TTS_RESPONSE_LIMIT,
                    "refusing an ElevenLabs response larger than the audio size limit"
                );
                return Err(AudioError::Tts(
                    "ElevenLabs response exceeded the audio size limit".into(),
                ));
            }
            let (sender, receiver) = mpsc::channel(8);
            let task = tokio::spawn(async move {
                let mut response = response;
                loop {
                    let item = match response.chunk().await {
                        Ok(Some(chunk)) => Ok(chunk.to_vec()),
                        Ok(None) => break,
                        Err(error) => Err(AudioError::Tts(format!(
                            "could not read ElevenLabs response: {error}"
                        ))),
                    };
                    if sender.send(item).await.is_err() {
                        break;
                    }
                }
            });
            Ok((
                status,
                length,
                Box::pin(ChunkReceiverStream {
                    receiver,
                    task: Some(task),
                }) as TtsByteStream,
            ))
        })
    }
}

struct ChunkReceiverStream {
    receiver: mpsc::Receiver<Result<Vec<u8>, AudioError>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for ChunkReceiverStream {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl Stream for ChunkReceiverStream {
    type Item = Result<Vec<u8>, AudioError>;

    fn poll_next(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.receiver.poll_recv(cx)
    }
}

pub struct TtsChunkStream {
    inner: TtsByteStream,
    deadline: Instant,
    deadline_wake: Pin<Box<tokio::time::Sleep>>,
    bytes: usize,
    finished: bool,
}

impl Stream for TtsChunkStream {
    type Item = Result<Vec<u8>, AudioError>;

    fn poll_next(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        if self.finished {
            return std::task::Poll::Ready(None);
        }
        if self.deadline_wake.as_mut().poll(cx).is_ready() || Instant::now() >= self.deadline {
            self.finished = true;
            return std::task::Poll::Ready(Some(Err(AudioError::Deadline)));
        }
        match self.inner.as_mut().poll_next(cx) {
            std::task::Poll::Ready(Some(Ok(chunk))) => {
                if self.bytes.saturating_add(chunk.len()) > TTS_RESPONSE_LIMIT {
                    tracing::warn!(
                        bytes = self.bytes.saturating_add(chunk.len()),
                        limit = TTS_RESPONSE_LIMIT,
                        "the ElevenLabs stream outgrew the audio size limit; stopping it"
                    );
                    self.finished = true;
                    return std::task::Poll::Ready(Some(Err(AudioError::Tts(
                        "ElevenLabs response exceeded the audio size limit".into(),
                    ))));
                }
                self.bytes += chunk.len();
                std::task::Poll::Ready(Some(Ok(chunk)))
            }
            std::task::Poll::Ready(Some(Err(error))) => {
                self.finished = true;
                std::task::Poll::Ready(Some(Err(error)))
            }
            std::task::Poll::Ready(None) => {
                self.finished = true;
                std::task::Poll::Ready(None)
            }
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}

/// Run the explicitly transitional STT sidecar.
#[derive(Clone, Debug)]
pub struct SttAdapter {
    pub command: Option<String>,
    timeout: Duration,
}
impl SttAdapter {
    pub fn from_command(command: Option<String>) -> Self {
        Self {
            command: command.filter(|value| !value.trim().is_empty()),
            timeout: STT_TIMEOUT,
        }
    }

    pub async fn transcribe(&self, webm: &[u8]) -> Result<String, AudioError> {
        let command = self
            .command
            .as_deref()
            .ok_or(AudioError::MissingSttCommand)?;
        let started = Instant::now();
        tracing::debug!(bytes = webm.len(), "running the STT sidecar");
        let mut command_process = Command::new("sh");
        command_process
            .args(["-c", command])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::pi_client::isolate_process(&mut command_process);
        let mut child = command_process
            .spawn()
            .map_err(|e| AudioError::Process(format!("could not start STT sidecar: {e}")))?;
        let process_guard = crate::pi_client::ProcessTreeGuard::new(&child);
        let mut stdin = child.stdin.take();
        let stdout_task = child.stdout.take().map(|mut output| {
            tokio::spawn(async move {
                crate::pi_client::drain_bounded(&mut output, STT_STDOUT_LIMIT).await
            })
        });
        let stderr_task = child.stderr.take().map(|mut output| {
            tokio::spawn(async move {
                crate::pi_client::drain_bounded(&mut output, STT_STDERR_LIMIT).await
            })
        });
        let interaction = async {
            if let Some(mut input) = stdin.take() {
                match input.write_all(webm).await {
                    Ok(()) => {}
                    // A broken pipe means the sidecar stopped reading, which
                    // normally means it already exited. Its status and stderr
                    // say why, and that is the diagnosis worth reporting, so
                    // fall through and let the wait below surface it instead of
                    // masking it with the write failure it caused.
                    Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => {}
                    Err(error) => {
                        return Err(AudioError::Process(format!(
                            "could not send audio to STT sidecar: {error}"
                        )))
                    }
                }
                drop(input);
            }
            child
                .wait()
                .await
                .map_err(|error| AudioError::Process(format!("STT sidecar failed: {error}")))
        };
        let status = match timeout(self.timeout, interaction).await {
            Ok(Ok(status)) => {
                process_guard.disarm();
                status
            }
            Ok(Err(error)) => {
                crate::pi_client::terminate_process(&mut child).await;
                process_guard.disarm();
                abort_drain(stdout_task);
                abort_drain(stderr_task);
                return Err(error);
            }
            Err(_) => {
                // The deadline covers stdin too: a sidecar that never reads
                // must not block forever on a full pipe. Reap it explicitly so
                // repeated bad clips cannot accumulate local children.
                crate::pi_client::terminate_process(&mut child).await;
                process_guard.disarm();
                abort_drain(stdout_task);
                abort_drain(stderr_task);
                tracing::warn!(
                    bytes = webm.len(),
                    timeout = ?self.timeout,
                    "the STT sidecar did not finish in time and was killed"
                );
                return Err(AudioError::Process("STT sidecar timed out".into()));
            }
        };
        let elapsed = started.elapsed();
        let stdout = join_bounded(stdout_task).await;
        let stderr = join_bounded(stderr_task).await;
        if stdout.truncated {
            tracing::warn!(
                bytes = webm.len(),
                limit = STT_STDOUT_LIMIT,
                ?elapsed,
                "the STT sidecar wrote more than the transcript limit; discarding it"
            );
            return Err(AudioError::Process(
                "STT sidecar produced too much transcript output".into(),
            ));
        }
        if !status.success() {
            tracing::warn!(
                %status,
                bytes = webm.len(),
                ?elapsed,
                stderr = %stderr_excerpt(&stderr.bytes),
                "the STT sidecar exited unsuccessfully"
            );
            let detail = String::from_utf8_lossy(&stderr.bytes)
                .trim()
                .chars()
                .take(300)
                .collect::<String>();
            return Err(AudioError::Process(format!(
                "STT sidecar exited unsuccessfully{}",
                if detail.is_empty() {
                    String::new()
                } else {
                    format!(": {detail}")
                }
            )));
        }
        tracing::debug!(
            bytes = webm.len(),
            transcript_bytes = stdout.bytes.len(),
            ?elapsed,
            "the STT sidecar finished"
        );
        Ok(String::from_utf8_lossy(&stdout.bytes).trim().to_owned())
    }
}

/// The end of a process's stderr, trimmed and bounded for a log line.
fn stderr_excerpt(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    let skip = text.chars().count().saturating_sub(STDERR_LOG_CHARS);
    text.chars().skip(skip).collect()
}

/// Keeps the last `limit` bytes a long-lived process writes, so the reason it
/// stopped is still there when it does.
async fn drain_tail<R>(mut reader: R, limit: usize) -> Vec<u8>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut tail = std::collections::VecDeque::with_capacity(limit.min(8192));
    let mut chunk = [0_u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                tail.extend(&chunk[..read]);
                let excess = tail.len().saturating_sub(limit);
                tail.drain(..excess);
            }
        }
    }
    tail.into()
}

fn abort_drain(task: Option<tokio::task::JoinHandle<crate::pi_client::BoundedOutput>>) {
    if let Some(task) = task {
        task.abort();
    }
}

async fn join_bounded(
    task: Option<tokio::task::JoinHandle<crate::pi_client::BoundedOutput>>,
) -> crate::pi_client::BoundedOutput {
    match task {
        Some(task) => task.await.unwrap_or_default(),
        None => crate::pi_client::BoundedOutput::default(),
    }
}

const STREAM_QUEUE: usize = 128;
const STREAM_QUEUE_BYTES: usize = 16 * 1024 * 1024;
const STREAM_FRAME_LIMIT: usize = 8 * 1024 * 1024;
const STREAM_CHUNK_HEADER: usize = 1 + 128 + 8 + 8;
const STREAM_CHUNK_LIMIT: usize = STREAM_FRAME_LIMIT - STREAM_CHUNK_HEADER;
const STREAM_OUTPUT_LIMIT: usize = 64 * 1024;
const STREAM_START_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a stopped stream worker's stderr gets to finish draining. The
/// worker is dead by then; only a helper it left holding the pipe keeps it
/// open, and that must not hold up the restart.
const STREAM_STDERR_GRACE: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamClip {
    pub clip_id: String,
    pub generation: u64,
    pub sequence: u64,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StreamResult {
    Partial(StreamClip),
    Final(StreamClip),
    WorkerError(String),
}

#[derive(Debug)]
enum StreamRequest {
    Start {
        clip_id: String,
        generation: u64,
        mime: String,
    },
    Chunk {
        clip_id: String,
        generation: u64,
        sequence: u64,
        audio: Vec<u8>,
    },
    End {
        clip_id: String,
        generation: u64,
    },
    Cancel {
        clip_id: String,
        generation: u64,
    },
}

#[derive(Clone, Debug)]
pub struct SttStreamAdapter {
    command: Option<String>,
    requests: mpsc::Sender<StreamRequest>,
    results: Arc<Mutex<Option<mpsc::Receiver<StreamResult>>>>,
    queued_bytes: Arc<std::sync::atomic::AtomicUsize>,
    started: Arc<AtomicBool>,
}

impl SttStreamAdapter {
    pub fn from_command(command: Option<String>) -> Self {
        let (requests, request_rx) = mpsc::channel(STREAM_QUEUE);
        let (results, result_rx) = mpsc::channel(STREAM_QUEUE);
        let adapter = Self {
            command: command.filter(|value| !value.trim().is_empty()),
            requests,
            results: Arc::new(Mutex::new(Some(result_rx))),
            queued_bytes: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            started: Arc::new(AtomicBool::new(false)),
        };
        if tokio::runtime::Handle::try_current().is_ok() {
            adapter.spawn_worker(request_rx, results);
        }
        adapter
    }

    pub fn configured(&self) -> bool {
        self.command.is_some()
    }

    pub async fn take_results(&self) -> Option<mpsc::Receiver<StreamResult>> {
        self.results.lock().await.take()
    }

    fn spawn_worker(
        &self,
        mut requests: mpsc::Receiver<StreamRequest>,
        results: mpsc::Sender<StreamResult>,
    ) {
        if self.command.is_none() || self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let command = self.command.clone().expect("stream command configured");
        let queued_bytes = Arc::clone(&self.queued_bytes);
        tokio::spawn(async move {
            let result_tx = results;
            let mut backoff = Duration::from_millis(100);
            loop {
                if !start_stream_process(&command, &mut requests, &result_tx, &queued_bytes).await {
                    if requests.is_closed() {
                        return;
                    }
                    tracing::info!(?backoff, "restarting the STT stream worker");
                    sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(5));
                } else {
                    backoff = Duration::from_millis(100);
                }
            }
        });
    }

    fn try_request(&self, request: StreamRequest) -> Result<(), &'static str> {
        if !self.configured() {
            return Err("streaming STT is not configured");
        }
        let bytes = request.queued_bytes();
        if bytes > 0 {
            let mut current = self.queued_bytes.load(Ordering::Acquire);
            loop {
                let Some(next) = current.checked_add(bytes) else {
                    return Err("streaming STT admission is full");
                };
                if next > STREAM_QUEUE_BYTES {
                    return Err("streaming STT admission is full");
                }
                match self.queued_bytes.compare_exchange_weak(
                    current,
                    next,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                ) {
                    Ok(_) => break,
                    Err(observed) => current = observed,
                }
            }
        }
        match self.requests.try_send(request) {
            Ok(()) => Ok(()),
            Err(error) => {
                if bytes > 0 {
                    self.queued_bytes.fetch_sub(bytes, Ordering::AcqRel);
                }
                Err(match error {
                    mpsc::error::TrySendError::Full(_) => "streaming STT admission is full",
                    mpsc::error::TrySendError::Closed(_) => "streaming STT worker is unavailable",
                })
            }
        }
    }

    pub fn try_start(
        &self,
        clip_id: String,
        generation: u64,
        mime: String,
    ) -> Result<(), &'static str> {
        self.try_request(StreamRequest::Start {
            clip_id,
            generation,
            mime,
        })
    }
    pub fn try_chunk(
        &self,
        clip_id: String,
        generation: u64,
        sequence: u64,
        audio: Vec<u8>,
    ) -> Result<(), &'static str> {
        if audio.len() > STREAM_CHUNK_LIMIT {
            return Err("streaming STT chunk exceeds the size limit");
        }
        self.try_request(StreamRequest::Chunk {
            clip_id,
            generation,
            sequence,
            audio,
        })
    }
    pub fn try_end(&self, clip_id: String, generation: u64) -> Result<(), &'static str> {
        self.try_request(StreamRequest::End {
            clip_id,
            generation,
        })
    }
    pub fn try_cancel(&self, clip_id: String, generation: u64) -> Result<(), &'static str> {
        self.try_request(StreamRequest::Cancel {
            clip_id,
            generation,
        })
    }
}

impl StreamRequest {
    fn queued_bytes(&self) -> usize {
        match self {
            Self::Chunk { audio, .. } => audio.len(),
            Self::Start { .. } | Self::End { .. } | Self::Cancel { .. } => 0,
        }
    }
}

fn encode_chunk_payload(
    clip_id: &str,
    generation: u64,
    sequence: u64,
    audio: Vec<u8>,
) -> Option<Vec<u8>> {
    if clip_id.is_empty() || clip_id.len() > 128 || audio.len() > STREAM_CHUNK_LIMIT {
        return None;
    }
    let mut payload = Vec::with_capacity(STREAM_CHUNK_HEADER + audio.len());
    payload.push(clip_id.len() as u8);
    payload.extend_from_slice(clip_id.as_bytes());
    payload.extend_from_slice(&generation.to_be_bytes());
    payload.extend_from_slice(&sequence.to_be_bytes());
    payload.extend_from_slice(&audio);
    Some(payload)
}

async fn write_worker_frame(
    stdin: &mut tokio::process::ChildStdin,
    kind: u8,
    payload: &[u8],
) -> bool {
    if payload.len() > STREAM_FRAME_LIMIT || payload.len() > u32::MAX as usize {
        return false;
    }
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.push(kind);
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    stdin.write_all(&frame).await.is_ok()
}

async fn start_stream_process(
    command: &str,
    requests: &mut mpsc::Receiver<StreamRequest>,
    results: &mpsc::Sender<StreamResult>,
    queued_bytes: &Arc<std::sync::atomic::AtomicUsize>,
) -> bool {
    let started = Instant::now();
    tracing::debug!("starting the STT stream worker");
    let mut process = Command::new("sh");
    process
        .args(["-c", command])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::pi_client::isolate_process(&mut process);
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = results
                .send(StreamResult::WorkerError(format!(
                    "could not start STT stream worker: {error}"
                )))
                .await;
            return false;
        }
    };
    let guard = crate::pi_client::ProcessTreeGuard::new(&child);
    let mut stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => return false,
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => return false,
    };
    // A worker that dies says why on stderr. Keep the end of it for the
    // journal rather than draining it into nothing.
    let stderr_task = child
        .stderr
        .take()
        .map(|stderr| tokio::spawn(drain_tail(stderr, STT_STDERR_LIMIT)));
    let mut lines = BufReader::new(stdout).lines();
    let not_ready = match timeout(STREAM_START_TIMEOUT, lines.next_line()).await {
        Err(_) => Some("no ready record within the start timeout"),
        Ok(Err(_)) => Some("its output could not be read"),
        Ok(Ok(None)) => Some("it exited before reporting ready"),
        Ok(Ok(Some(line))) => serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .is_none_or(|value| value.get("type").and_then(|value| value.as_str()) != Some("ready"))
            .then_some("its first line was not a ready record"),
    };
    if let Some(reason) = not_ready {
        crate::pi_client::terminate_process(&mut child).await;
        guard.disarm();
        let (status, stderr) = stream_worker_exit(&mut child, stderr_task).await;
        tracing::warn!(
            reason,
            %status,
            startup = ?started.elapsed(),
            %stderr,
            "the STT stream worker did not become ready"
        );
        let _ = results
            .send(StreamResult::WorkerError(
                "STT stream worker did not become ready".into(),
            ))
            .await;
        return false;
    }
    tracing::info!(
        pid = child.id(),
        startup = ?started.elapsed(),
        "the STT stream worker is ready"
    );
    let failure = loop {
        tokio::select! {
            request = requests.recv() => {
                let Some(request) = request else { crate::pi_client::terminate_process(&mut child).await; guard.disarm(); break None; };
                let request_bytes = request.queued_bytes();
                if request_bytes > 0 { queued_bytes.fetch_sub(request_bytes, Ordering::AcqRel); }
                let (kind, payload) = match request {
                    StreamRequest::Start { clip_id, generation, mime } => (b's', serde_json::json!({"clip_id":clip_id,"generation":generation,"mime":mime}).to_string().into_bytes()),
                    StreamRequest::Chunk { clip_id, generation, sequence, audio } => {
                        let Some(payload) = encode_chunk_payload(&clip_id, generation, sequence, audio) else {
                            break Some("STT stream worker received an invalid chunk".into());
                        };
                        (b'c', payload)
                    },
                    StreamRequest::End { clip_id, generation } => (b'e', serde_json::json!({"clip_id":clip_id,"generation":generation}).to_string().into_bytes()),
                    StreamRequest::Cancel { clip_id, generation } => (b'x', serde_json::json!({"clip_id":clip_id,"generation":generation}).to_string().into_bytes()),
                };
                if !write_worker_frame(&mut stdin, kind, &payload).await {
                    break Some("STT stream worker stdin closed unexpectedly".into());
                }
            }
            line = lines.next_line() => {
                let line = match line { Ok(Some(line)) => line, Ok(None) => break Some("STT stream worker exited unexpectedly".into()), Err(error) => break Some(format!("could not read STT stream worker output: {error}")) };
                if line.len() > STREAM_OUTPUT_LIMIT { break Some("STT stream worker output exceeded the limit".into()); }
                let value: serde_json::Value = match serde_json::from_str(&line) { Ok(value) => value, Err(_) => break Some("STT stream worker emitted malformed JSON".into()) };
                let kind = value.get("type").and_then(|value| value.as_str());
                if kind == Some("ready") { continue; }
                let clip_id = value.get("clip_id").and_then(|value| value.as_str()).filter(|id| !id.is_empty() && id.len() <= 128);
                let generation = value.get("generation").and_then(|value| value.as_u64());
                let sequence = value.get("sequence").and_then(|value| value.as_u64());
                let text = value.get("text").and_then(|value| value.as_str()).filter(|text| text.chars().count() <= 16 * 1024);
                let (Some(clip_id), Some(generation), Some(sequence), Some(text)) = (clip_id, generation, sequence, text) else { break Some("STT stream worker emitted an invalid result".into()); };
                let output = StreamClip { clip_id: clip_id.to_owned(), generation, sequence, text: text.to_owned() };
                match kind { Some("partial") => { if results.send(StreamResult::Partial(output)).await.is_err() { return false; } }, Some("final") => { if results.send(StreamResult::Final(output)).await.is_err() { return false; } }, _ => { break Some("STT stream worker emitted an unknown result".into()); } }
            }
        }
    };
    crate::pi_client::terminate_process(&mut child).await;
    guard.disarm();
    let (status, stderr) = stream_worker_exit(&mut child, stderr_task).await;
    match &failure {
        Some(reason) => tracing::warn!(
            %reason,
            %status,
            uptime = ?started.elapsed(),
            %stderr,
            "the STT stream worker stopped"
        ),
        None => tracing::debug!(
            %status,
            uptime = ?started.elapsed(),
            "the STT stream worker stopped: the service is shutting down"
        ),
    }
    if let Some(error) = failure {
        let _ = results.send(StreamResult::WorkerError(error)).await;
    }
    false
}

/// How a stopped stream worker ended, and the end of what it wrote to stderr.
async fn stream_worker_exit(
    child: &mut tokio::process::Child,
    stderr: Option<tokio::task::JoinHandle<Vec<u8>>>,
) -> (String, String) {
    let status = match child.try_wait() {
        Ok(Some(status)) => status.to_string(),
        _ => "unknown".into(),
    };
    let stderr = match stderr {
        None => String::new(),
        Some(mut task) => match timeout(STREAM_STDERR_GRACE, &mut task).await {
            Ok(Ok(bytes)) => stderr_excerpt(&bytes),
            _ => {
                task.abort();
                String::new()
            }
        },
    };
    (status, stderr)
}

#[derive(Clone)]
pub struct Speaker {
    pub api_key: String,
    pub voice_id: String,
    pub model_id: String,
    pub stability: f32,
    pub similarity_boost: f32,
    pub style: f32,
    pub speed: f32,
    pub max_chars: usize,
    pub speech_deadline: Duration,
    transport: Arc<dyn TtsTransport>,
}
impl std::fmt::Debug for Speaker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Speaker")
            .field("api_key_configured", &self.configured())
            .field("voice_id", &self.voice_id)
            .field("model_id", &self.model_id)
            .field("stability", &self.stability)
            .field("similarity_boost", &self.similarity_boost)
            .field("style", &self.style)
            .field("speed", &self.speed)
            .field("max_chars", &self.max_chars)
            .field("speech_deadline", &self.speech_deadline)
            .finish()
    }
}
impl Speaker {
    /// `values` supplies the ElevenLabs settings; the deadline is the parsed
    /// `SWITCHBOARD_SPEECH_DEADLINE_MS`, shared with the project extension.
    pub fn from_values(
        max_chars: usize,
        speech_deadline: Duration,
        values: &HashMap<String, String>,
    ) -> Self {
        fn value(values: &HashMap<String, String>, name: &str, default: &str) -> String {
            values
                .get(name)
                .map(String::as_str)
                .unwrap_or(default)
                .trim()
                .to_owned()
        }
        fn number(values: &HashMap<String, String>, name: &str, default: f32) -> f32 {
            values
                .get(name)
                .and_then(|value| value.trim().parse().ok())
                .filter(|value: &f32| value.is_finite())
                .unwrap_or(default)
        }
        Self {
            api_key: value(values, "ELEVENLABS_API_KEY", ""),
            voice_id: value(values, "ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"),
            model_id: value(values, "ELEVENLABS_MODEL_ID", "eleven_multilingual_v2"),
            stability: number(values, "ELEVENLABS_STABILITY", 0.5),
            similarity_boost: number(values, "ELEVENLABS_SIMILARITY_BOOST", 0.75),
            style: number(values, "ELEVENLABS_STYLE", 0.0),
            speed: number(values, "ELEVENLABS_SPEED", 1.0),
            max_chars,
            speech_deadline,
            transport: Arc::new(HttpTtsTransport::new()),
        }
    }
    pub fn configured(&self) -> bool {
        !self.api_key.trim().is_empty()
    }
    pub fn clip_for_speech(&self, text: &str) -> String {
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.chars().count() <= self.max_chars {
            return text;
        }
        let chars = text.chars().take(self.max_chars).collect::<String>();
        let boundary = [". ", "! ", "? "]
            .iter()
            .filter_map(|mark| chars.rfind(mark).map(|i| chars[..i + 1].chars().count()))
            .max();
        let clipped = boundary.filter(|i| *i > self.max_chars / 3).map_or_else(
            || {
                chars
                    .rsplit_once(' ')
                    .map_or(chars.clone(), |(head, _)| head.to_owned())
            },
            |count| chars.chars().take(count).collect(),
        );
        format!("{} — there's more on screen.", clipped.trim_end())
    }

    pub async fn stream_until(
        &self,
        text: &str,
        deadline: Instant,
    ) -> Result<TtsChunkStream, AudioError> {
        if deadline <= Instant::now() {
            return Err(AudioError::Deadline);
        }
        if !self.configured() {
            return Err(AudioError::Tts("ELEVENLABS_API_KEY is not set".into()));
        }
        #[derive(Serialize)]
        struct Settings {
            stability: f32,
            similarity_boost: f32,
            style: f32,
            speed: f32,
        }
        let body = serde_json::json!({"text": text, "model_id": self.model_id, "voice_settings": Settings { stability: self.stability, similarity_boost: self.similarity_boost, style: self.style, speed: self.speed }});
        let request = TtsRequest {
            url: format!(
                "{}/stream?output_format=mp3_44100_128",
                ELEVENLABS_TTS_URL.replace("{voice_id}", &self.voice_id)
            ),
            api_key: self.api_key.clone(),
            body,
            deadline,
        };
        // The request is logged by what identifies it, never by its key or
        // the words being spoken: the journal is not where either belongs.
        let chars = text.chars().count();
        let started = Instant::now();
        tracing::debug!(
            voice = %self.voice_id,
            model = %self.model_id,
            chars,
            "requesting speech from ElevenLabs"
        );
        let (status, length, stream) = match self.transport.send_stream(request).await {
            Ok(response) => response,
            Err(error) => {
                tracing::warn!(
                    voice = %self.voice_id,
                    model = %self.model_id,
                    chars,
                    elapsed = ?started.elapsed(),
                    %error,
                    "the ElevenLabs request failed"
                );
                return Err(error);
            }
        };
        let elapsed = started.elapsed();
        if status != StatusCode::OK {
            tracing::warn!(
                voice = %self.voice_id,
                model = %self.model_id,
                chars,
                %status,
                ?elapsed,
                "ElevenLabs refused the request"
            );
            let mut body = Vec::new();
            let mut stream = stream;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                if body.len().saturating_add(chunk.len()) > 4096 {
                    break;
                }
                body.extend_from_slice(&chunk);
            }
            return Err(AudioError::Tts(format!(
                "ElevenLabs TTS failed ({status}): {}",
                String::from_utf8_lossy(&body)
                    .chars()
                    .take(500)
                    .collect::<String>()
            )));
        }
        tracing::info!(
            voice = %self.voice_id,
            model = %self.model_id,
            chars,
            %status,
            ?elapsed,
            content_length = ?length,
            "ElevenLabs answered; streaming speech"
        );
        Ok(TtsChunkStream {
            inner: stream,
            deadline,
            deadline_wake: Box::pin(tokio::time::sleep_until(TokioInstant::from_std(deadline))),
            bytes: 0,
            finished: false,
        })
    }
}

#[cfg(test)]
#[path = "../tests/test_audio.rs"]
mod tests;

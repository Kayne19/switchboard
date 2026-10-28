//! The ElevenLabs text-to-speech client.

use futures_util::{Stream, StreamExt};
use reqwest::StatusCode;
use serde::Serialize;
use std::future::Future;
use std::pin::Pin;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;
#[cfg(test)]
use tokio::sync::Notify;
use tokio::time::{timeout, Duration, Instant as TokioInstant};

pub const ELEVENLABS_TTS_URL: &str = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}";
const TTS_RESPONSE_LIMIT: usize = 32 * 1024 * 1024;

#[derive(Debug)]
pub enum TtsError {
    Deadline,
    Tts(String),
}
impl std::fmt::Display for TtsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Deadline => f.write_str("speech deadline expired"),
            Self::Tts(s) => f.write_str(s),
        }
    }
}
impl std::error::Error for TtsError {}

#[derive(Clone, Debug)]
struct TtsRequest {
    url: String,
    api_key: String,
    body: serde_json::Value,
    deadline: Instant,
}

type TtsByteStream = Pin<Box<dyn Stream<Item = Result<Vec<u8>, TtsError>> + Send>>;

/// The response metadata needed by the continuity owner.  `request_id` is
/// deliberately separate from the stream: ElevenLabs only permits it to be
/// used after the complete response body has been read.
struct TtsResponse {
    status: StatusCode,
    content_length: Option<u64>,
    request_id: Option<String>,
    stream: TtsByteStream,
}

type TtsStreamFuture =
    Pin<Box<dyn Future<Output = Result<TtsResponse, TtsError>> + Send + 'static>>;

trait TtsTransport: Send + Sync {
    fn send_stream(&self, request: TtsRequest) -> TtsStreamFuture;
}

/// Context for a continuation request.  The request body always contains
/// exactly one of `previous_request_ids` and `previous_text`; the text kept
/// alongside ids is only the deterministic fallback for an expired/rejected
/// id request.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum TtsContinuity {
    #[default]
    Fresh,
    PreviousText(String),
    PreviousRequestIds {
        ids: Vec<String>,
        fallback_text: Option<String>,
    },
}

impl TtsContinuity {
    pub(crate) fn previous_request_ids<I, S>(ids: I, fallback_text: Option<String>) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut ids = ids.into_iter().map(Into::into).collect::<Vec<_>>();
        if ids.len() > 3 {
            ids.drain(..ids.len() - 3);
        }
        if ids.is_empty() {
            fallback_text.map_or(Self::Fresh, Self::PreviousText)
        } else {
            Self::PreviousRequestIds { ids, fallback_text }
        }
    }

    fn body_fields(&self) -> Option<(&'static str, serde_json::Value)> {
        match self {
            Self::Fresh => None,
            Self::PreviousText(text) => {
                Some(("previous_text", serde_json::Value::String(text.clone())))
            }
            Self::PreviousRequestIds { ids, .. } => Some((
                "previous_request_ids",
                serde_json::Value::Array(
                    ids.iter().cloned().map(serde_json::Value::String).collect(),
                ),
            )),
        }
    }

    fn fallback_text(&self) -> Option<&str> {
        match self {
            Self::PreviousRequestIds { fallback_text, .. } => fallback_text.as_deref(),
            _ => None,
        }
    }

    fn has_request_ids(&self) -> bool {
        matches!(self, Self::PreviousRequestIds { ids, .. } if !ids.is_empty())
    }
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
                return Err(TtsError::Deadline);
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
            .map_err(|_| TtsError::Deadline)?
            .map_err(|error| TtsError::Tts(format!("could not reach ElevenLabs: {error}")))?;
            let status = response.status();
            let length = response.content_length();
            let request_id = response
                .headers()
                .get("request-id")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            if let Some(length) = length.filter(|length| *length > TTS_RESPONSE_LIMIT as u64) {
                tracing::warn!(
                    %status,
                    content_length = length,
                    limit = TTS_RESPONSE_LIMIT,
                    "refusing an ElevenLabs response larger than the audio size limit"
                );
                return Err(TtsError::Tts(
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
                        Err(error) => Err(TtsError::Tts(format!(
                            "could not read ElevenLabs response: {error}"
                        ))),
                    };
                    if sender.send(item).await.is_err() {
                        break;
                    }
                }
            });
            Ok(TtsResponse {
                status,
                content_length: length,
                request_id,
                stream: Box::pin(ChunkReceiverStream {
                    receiver,
                    task: Some(task),
                }) as TtsByteStream,
            })
        })
    }
}

struct ChunkReceiverStream {
    receiver: mpsc::Receiver<Result<Vec<u8>, TtsError>>,
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
    type Item = Result<Vec<u8>, TtsError>;

    fn poll_next(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.receiver.poll_recv(cx)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TtsResponseMetadata {
    pub(crate) request_id: Option<String>,
    pub(crate) content_length: Option<u64>,
}

pub struct TtsChunkStream {
    inner: TtsByteStream,
    deadline: Instant,
    deadline_wake: Pin<Box<tokio::time::Sleep>>,
    bytes: usize,
    finished: bool,
    metadata: TtsResponseMetadata,
}

impl TtsChunkStream {
    /// Bounds a provider body by the request's deadline and the audio size
    /// limit. Every body the speaker reads, audio or refusal, is read through
    /// one, so no await on the provider outlives the speech deadline.
    fn new(response: TtsResponse, deadline: Instant) -> Self {
        Self {
            inner: response.stream,
            deadline,
            deadline_wake: Box::pin(tokio::time::sleep_until(TokioInstant::from_std(deadline))),
            bytes: 0,
            finished: false,
            metadata: TtsResponseMetadata {
                request_id: response.request_id,
                content_length: response.content_length,
            },
        }
    }

    /// The request id is safe to commit for a later request only after the
    /// stream has been read to its end, which is the provider's stream
    /// stitching requirement; the speech worker does that.
    pub(crate) fn metadata(&self) -> &TtsResponseMetadata {
        &self.metadata
    }
}

#[cfg(test)]
impl TtsChunkStream {
    /// Consume and fully read a response.  The speech worker reads its own
    /// streams chunk by chunk; tests read a whole one with this.
    pub(crate) async fn drain(mut self) -> Result<TtsResponseMetadata, TtsError> {
        while let Some(chunk) = self.next().await {
            chunk?;
        }
        Ok(self.metadata)
    }
}

impl Stream for TtsChunkStream {
    type Item = Result<Vec<u8>, TtsError>;

    fn poll_next(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        if self.finished {
            return std::task::Poll::Ready(None);
        }
        if self.deadline_wake.as_mut().poll(cx).is_ready() || Instant::now() >= self.deadline {
            self.finished = true;
            return std::task::Poll::Ready(Some(Err(TtsError::Deadline)));
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
                    return std::task::Poll::Ready(Some(Err(TtsError::Tts(
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

/// The ElevenLabs voice settings (`ELEVENLABS_*`). `Config` parses them once;
/// the speaker only uses them.
#[derive(Clone, PartialEq)]
pub struct TtsSettings {
    pub api_key: String,
    pub voice_id: String,
    pub model_id: String,
    pub stability: f32,
    pub similarity_boost: f32,
    pub style: f32,
    pub speed: f32,
}
/// The key is reported as configured-or-not, never echoed: `Config` is
/// printed in test failures, and the key does not belong there.
impl std::fmt::Debug for TtsSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TtsSettings")
            .field("api_key_configured", &!self.api_key.trim().is_empty())
            .field("voice_id", &self.voice_id)
            .field("model_id", &self.model_id)
            .field("stability", &self.stability)
            .field("similarity_boost", &self.similarity_boost)
            .field("style", &self.style)
            .field("speed", &self.speed)
            .finish()
    }
}

#[derive(Clone)]
pub struct Speaker {
    tts: TtsSettings,
    pub max_chars: usize,
    pub speech_deadline: Duration,
    transport: Arc<dyn TtsTransport>,
}
impl std::fmt::Debug for Speaker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Speaker")
            .field("api_key_configured", &self.configured())
            .field("voice_id", &self.tts.voice_id)
            .field("model_id", &self.tts.model_id)
            .field("stability", &self.tts.stability)
            .field("similarity_boost", &self.tts.similarity_boost)
            .field("style", &self.tts.style)
            .field("speed", &self.tts.speed)
            .field("max_chars", &self.max_chars)
            .field("speech_deadline", &self.speech_deadline)
            .finish()
    }
}
impl Speaker {
    /// `tts` is the parsed ElevenLabs settings; the deadline is the parsed
    /// `SWITCHBOARD_SPEECH_DEADLINE_MS`, shared with the project extension.
    pub fn new(max_chars: usize, speech_deadline: Duration, tts: TtsSettings) -> Self {
        Self {
            tts,
            max_chars,
            speech_deadline,
            transport: Arc::new(HttpTtsTransport::new()),
        }
    }
    pub fn configured(&self) -> bool {
        !self.tts.api_key.trim().is_empty()
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

    /// Start a streamed request with optional ElevenLabs stitching context.
    ///
    /// A request-id response is metadata on the returned stream.  Callers must
    /// keep consuming the stream to completion before committing that id for a
    /// later request.  If an id-bearing request receives a 4xx response and a
    /// fallback text was supplied, it is retried exactly once with
    /// `previous_text`; timeouts, transport errors, and 5xx responses are not
    /// retried.
    pub(crate) async fn stream_until_with_continuity(
        &self,
        text: &str,
        deadline: Instant,
        continuity: TtsContinuity,
    ) -> Result<TtsChunkStream, TtsError> {
        if deadline <= Instant::now() {
            return Err(TtsError::Deadline);
        }
        if !self.configured() {
            return Err(TtsError::Tts("ELEVENLABS_API_KEY is not set".into()));
        }
        #[derive(Serialize)]
        struct Settings {
            stability: f32,
            similarity_boost: f32,
            style: f32,
            speed: f32,
        }

        // eleven_v3 is explicitly fresh-only.  Keep the capability policy at
        // this boundary so all callers get the same safe fallback.
        let continuity = if self.tts.model_id == "eleven_v3" {
            TtsContinuity::Fresh
        } else {
            continuity
        };
        let base_body = || {
            let mut body = serde_json::json!({
                "text": text,
                "model_id": self.tts.model_id,
                "voice_settings": Settings {
                    stability: self.tts.stability,
                    similarity_boost: self.tts.similarity_boost,
                    style: self.tts.style,
                    speed: self.tts.speed,
                }
            });
            if let Some((name, value)) = continuity.body_fields() {
                body[name] = value;
            }
            body
        };
        let request = TtsRequest {
            url: format!(
                "{}/stream?output_format=mp3_44100_128",
                ELEVENLABS_TTS_URL.replace("{voice_id}", &self.tts.voice_id)
            ),
            api_key: self.tts.api_key.clone(),
            body: base_body(),
            deadline,
        };
        // The request is logged by what identifies it, never by its key or
        // the words being spoken: the journal is not where either belongs.
        let chars = text.chars().count();
        let started = Instant::now();
        tracing::debug!(
            voice = %self.tts.voice_id,
            model = %self.tts.model_id,
            chars,
            "requesting speech from ElevenLabs"
        );
        let mut response = match self.transport.send_stream(request.clone()).await {
            Ok(response) => response,
            Err(error) => {
                tracing::warn!(
                    voice = %self.tts.voice_id,
                    model = %self.tts.model_id,
                    chars,
                    elapsed = ?started.elapsed(),
                    %error,
                    "the ElevenLabs request failed"
                );
                return Err(error);
            }
        };
        let retry = response.status.is_client_error()
            && continuity.has_request_ids()
            && continuity.fallback_text().is_some();
        if retry {
            // Consume the refusal body before retrying.  This keeps the
            // transport lifecycle deterministic and prevents a response task
            // from retaining the connection while the fallback is admitted.
            let _ = collect_error_body(TtsChunkStream::new(response, deadline)).await?;
            let mut retry_body = base_body();
            retry_body
                .as_object_mut()
                .expect("JSON object body")
                .remove("previous_request_ids");
            retry_body["previous_text"] = serde_json::Value::String(
                continuity
                    .fallback_text()
                    .expect("retry text checked above")
                    .to_owned(),
            );
            response = self
                .transport
                .send_stream(TtsRequest {
                    body: retry_body,
                    ..request
                })
                .await?;
        }
        let elapsed = started.elapsed();
        let status = response.status;
        if status != StatusCode::OK {
            tracing::warn!(
                voice = %self.tts.voice_id,
                model = %self.tts.model_id,
                chars,
                %status,
                ?elapsed,
                "ElevenLabs refused the request"
            );
            let body = collect_error_body(TtsChunkStream::new(response, deadline)).await?;
            return Err(TtsError::Tts(format!(
                "ElevenLabs TTS failed ({status}): {}",
                String::from_utf8_lossy(&body)
                    .chars()
                    .take(500)
                    .collect::<String>()
            )));
        }
        tracing::info!(
            voice = %self.tts.voice_id,
            model = %self.tts.model_id,
            chars,
            status = %response.status,
            ?elapsed,
            content_length = ?response.content_length,
            request_id = ?response.request_id,
            "ElevenLabs answered; streaming speech"
        );
        Ok(TtsChunkStream::new(response, deadline))
    }
}

/// Reads the start of a refusal's body. It reads through the same
/// `TtsChunkStream` as audio, so it ends at the request's deadline: the
/// transport's own deadline ends when the headers arrive, and a body that
/// stalls after them would otherwise hold the speech worker, and every reply
/// behind it, for ever.
async fn collect_error_body(mut stream: TtsChunkStream) -> Result<Vec<u8>, TtsError> {
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if body.len().saturating_add(chunk.len()) > 4096 {
            break;
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Refuses every request without leaving the process, the way ElevenLabs
/// refuses a bad key. Tests of other modules speak through it: tests never
/// reach the network (`AGENTS.md`).
#[cfg(test)]
struct OfflineTtsTransport;

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct TestTtsGate {
    reading: Arc<Notify>,
    release: Arc<Notify>,
    fail_first: Arc<AtomicBool>,
}

#[cfg(test)]
impl TestTtsGate {
    pub(crate) fn new() -> Self {
        Self {
            reading: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
            fail_first: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn fail_first(&self) {
        self.fail_first.store(true, Ordering::Release);
    }

    pub(crate) async fn wait_until_read(&self) {
        self.reading.notified().await;
    }

    pub(crate) fn release(&self) {
        self.release.notify_one();
    }
}

#[cfg(test)]
struct GatedTtsTransport {
    gate: TestTtsGate,
}

#[cfg(test)]
impl TtsTransport for GatedTtsTransport {
    fn send_stream(&self, _request: TtsRequest) -> TtsStreamFuture {
        let gate = self.gate.clone();
        Box::pin(async move {
            let fail = gate.fail_first.swap(false, Ordering::AcqRel);
            let body = futures_util::stream::once(async move {
                gate.reading.notify_one();
                gate.release.notified().await;
                if fail {
                    Err(TtsError::Tts("gated test failure".into()))
                } else {
                    Ok(vec![1u8, 2, 3])
                }
            });
            Ok(TtsResponse {
                status: StatusCode::OK,
                content_length: Some(3),
                request_id: Some("gated-request-id".into()),
                stream: Box::pin(body) as TtsByteStream,
            })
        })
    }
}

#[cfg(test)]
struct ImmediateTtsTransport;

#[cfg(test)]
impl TtsTransport for ImmediateTtsTransport {
    fn send_stream(&self, _request: TtsRequest) -> TtsStreamFuture {
        Box::pin(async {
            let stream =
                futures_util::stream::once(async { Ok::<Vec<u8>, TtsError>(vec![1, 2, 3]) });
            Ok(TtsResponse {
                status: StatusCode::OK,
                content_length: Some(3),
                request_id: Some("test-request-id".into()),
                stream: Box::pin(stream) as TtsByteStream,
            })
        })
    }
}

#[cfg(test)]
struct CutByDeadlineTtsTransport {
    chunks: usize,
}

#[cfg(test)]
impl TtsTransport for CutByDeadlineTtsTransport {
    fn send_stream(&self, _request: TtsRequest) -> TtsStreamFuture {
        let chunks = self.chunks;
        Box::pin(async move {
            let stream = futures_util::stream::iter(
                (0..chunks)
                    .map(|_| Ok::<Vec<u8>, TtsError>(vec![1, 2, 3]))
                    .chain([Err(TtsError::Deadline)]),
            );
            Ok(TtsResponse {
                status: StatusCode::OK,
                content_length: None,
                request_id: Some("cut-request-id".into()),
                stream: Box::pin(stream) as TtsByteStream,
            })
        })
    }
}

#[cfg(test)]
impl TtsTransport for OfflineTtsTransport {
    fn send_stream(&self, _request: TtsRequest) -> TtsStreamFuture {
        Box::pin(async { Err(TtsError::Tts("tests do not reach ElevenLabs".into())) })
    }
}

#[cfg(test)]
impl Speaker {
    /// A configured speaker with the default voice settings and `transport`.
    fn with_test_transport(
        max_chars: usize,
        speech_deadline: Duration,
        transport: Arc<dyn TtsTransport>,
    ) -> Self {
        let tts = TtsSettings {
            api_key: "offline-test-key".into(),
            ..crate::Config::for_tests(&[]).tts
        };
        Self {
            transport,
            ..Self::new(max_chars, speech_deadline, tts)
        }
    }
    /// A configured speaker whose every request fails in-process, so callers
    /// exercise the synthesis path and its failure without a network.
    pub(crate) fn offline(max_chars: usize, speech_deadline: Duration) -> Self {
        Self::with_test_transport(max_chars, speech_deadline, Arc::new(OfflineTtsTransport))
    }
    /// A successful in-process transport for application floor tests. It never
    /// reaches ElevenLabs and emits one tiny audio chunk.
    pub(crate) fn test_success(max_chars: usize, speech_deadline: Duration) -> Self {
        Self::with_test_transport(max_chars, speech_deadline, Arc::new(ImmediateTtsTransport))
    }

    pub(crate) fn test_gated(
        max_chars: usize,
        speech_deadline: Duration,
        gate: TestTtsGate,
    ) -> Self {
        Self::with_test_transport(
            max_chars,
            speech_deadline,
            Arc::new(GatedTtsTransport { gate }),
        )
    }

    pub(crate) fn test_cut_by_deadline(max_chars: usize, speech_deadline: Duration) -> Self {
        Self::with_test_transport(
            max_chars,
            speech_deadline,
            Arc::new(CutByDeadlineTtsTransport { chunks: 1 }),
        )
    }

    pub(crate) fn test_deadline_before_audio(max_chars: usize, speech_deadline: Duration) -> Self {
        Self::with_test_transport(
            max_chars,
            speech_deadline,
            Arc::new(CutByDeadlineTtsTransport { chunks: 0 }),
        )
    }

    /// A request with no stitching context. The speech worker always says
    /// what context it has, so only tests ask for a fresh stream directly.
    pub(crate) async fn stream_until(
        &self,
        text: &str,
        deadline: Instant,
    ) -> Result<TtsChunkStream, TtsError> {
        self.stream_until_with_continuity(text, deadline, TtsContinuity::Fresh)
            .await
    }
}

#[cfg(test)]
#[path = "../tests/test_tts.rs"]
mod tests;

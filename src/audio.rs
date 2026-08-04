//! Transitional speech adapters.
//!
//! STT intentionally is not a Rust Whisper implementation: `SttAdapter` runs
//! the command in `SWITCHBOARD_STT_COMMAND`, writes WebM bytes to its stdin,
//! and reads the transcript from stdout. This keeps the service portable while
//! deployments migrate their existing faster-whisper sidecar.

use reqwest::StatusCode;
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

pub const ELEVENLABS_TTS_URL: &str = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}";
const STT_TIMEOUT: Duration = Duration::from_secs(120);
const STT_STDOUT_LIMIT: usize = 1024 * 1024;
const STT_STDERR_LIMIT: usize = 64 * 1024;
const TTS_RESPONSE_LIMIT: usize = 32 * 1024 * 1024;

#[derive(Debug)]
pub enum AudioError {
    MissingSttCommand,
    Process(String),
    Tts(String),
}
impl std::fmt::Display for AudioError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingSttCommand => f.write_str(
                "SWITCHBOARD_STT_COMMAND is not set; configure a WebM-to-text sidecar command",
            ),
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
}

type TtsFuture =
    Pin<Box<dyn Future<Output = Result<(StatusCode, Vec<u8>), AudioError>> + Send + 'static>>;

trait TtsTransport: Send + Sync {
    fn send(&self, request: TtsRequest) -> TtsFuture;
}

#[derive(Debug)]
struct HttpTtsTransport;

impl TtsTransport for HttpTtsTransport {
    fn send(&self, request: TtsRequest) -> TtsFuture {
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|error| {
                    AudioError::Tts(format!("could not configure ElevenLabs client: {error}"))
                })?;
            let mut response = client
                .post(request.url)
                .header("xi-api-key", request.api_key)
                .header("Content-Type", "application/json")
                .header("Accept", "audio/mpeg")
                .json(&request.body)
                .send()
                .await
                .map_err(|error| AudioError::Tts(format!("could not reach ElevenLabs: {error}")))?;
            let status = response.status();
            if response
                .content_length()
                .is_some_and(|length| length > TTS_RESPONSE_LIMIT as u64)
            {
                return Err(AudioError::Tts(
                    "ElevenLabs response exceeded the audio size limit".into(),
                ));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| {
                AudioError::Tts(format!("could not read ElevenLabs response: {error}"))
            })? {
                if bytes.len().saturating_add(chunk.len()) > TTS_RESPONSE_LIMIT {
                    return Err(AudioError::Tts(
                        "ElevenLabs response exceeded the audio size limit".into(),
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok((status, bytes))
        })
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

    pub fn from_env() -> Self {
        Self::from_command(std::env::var("SWITCHBOARD_STT_COMMAND").ok())
    }

    pub async fn transcribe(&self, webm: &[u8]) -> Result<String, AudioError> {
        let command = self
            .command
            .as_deref()
            .ok_or(AudioError::MissingSttCommand)?;
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
                return Err(AudioError::Process("STT sidecar timed out".into()));
            }
        };
        let stdout = join_bounded(stdout_task).await;
        let stderr = join_bounded(stderr_task).await;
        if stdout.truncated {
            return Err(AudioError::Process(
                "STT sidecar produced too much transcript output".into(),
            ));
        }
        if !status.success() {
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
        Ok(String::from_utf8_lossy(&stdout.bytes).trim().to_owned())
    }
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
            .finish()
    }
}
impl Speaker {
    pub fn from_env(max_chars: usize) -> Self {
        let values = std::env::vars().collect::<HashMap<_, _>>();
        Self::from_values(max_chars, &values)
    }

    pub fn from_values(max_chars: usize, values: &HashMap<String, String>) -> Self {
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
            transport: Arc::new(HttpTtsTransport),
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
    pub async fn synthesize(&self, text: &str) -> Result<Vec<u8>, AudioError> {
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
            url: ELEVENLABS_TTS_URL.replace("{voice_id}", &self.voice_id),
            api_key: self.api_key.clone(),
            body,
        };
        let (status, bytes) = self.transport.send(request).await?;
        if bytes.len() > TTS_RESPONSE_LIMIT {
            return Err(AudioError::Tts(
                "ElevenLabs response exceeded the audio size limit".into(),
            ));
        }
        if status != StatusCode::OK {
            return Err(AudioError::Tts(format!(
                "ElevenLabs TTS failed ({status}): {}",
                String::from_utf8_lossy(&bytes)
                    .chars()
                    .take(500)
                    .collect::<String>()
            )));
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    #[derive(Debug)]
    struct FakeTtsTransport {
        status: StatusCode,
        bytes: Vec<u8>,
        request: Arc<StdMutex<Option<TtsRequest>>>,
    }
    impl TtsTransport for FakeTtsTransport {
        fn send(&self, request: TtsRequest) -> TtsFuture {
            *self.request.lock().unwrap() = Some(request);
            let response = Ok((self.status, self.bytes.clone()));
            Box::pin(async move { response })
        }
    }

    fn speaker_with_response(
        status: StatusCode,
        bytes: &[u8],
    ) -> (Speaker, Arc<StdMutex<Option<TtsRequest>>>) {
        let values = HashMap::from([
            ("ELEVENLABS_API_KEY".into(), "test-secret".into()),
            ("ELEVENLABS_VOICE_ID".into(), "voice-a".into()),
            ("ELEVENLABS_MODEL_ID".into(), "model-a".into()),
        ]);
        let request = Arc::new(StdMutex::new(None));
        let mut speaker = Speaker::from_values(100, &values);
        speaker.transport = Arc::new(FakeTtsTransport {
            status,
            bytes: bytes.to_vec(),
            request: Arc::clone(&request),
        });
        (speaker, request)
    }

    #[test]
    fn clipping_preserves_sentence_and_max_shape() {
        let (mut speaker, _) = speaker_with_response(StatusCode::OK, b"");
        speaker.max_chars = 20;
        let result = speaker.clip_for_speech("One short sentence. Second sentence goes on and on.");
        assert_eq!(result, "One short sentence. — there's more on screen.");
    }
    #[tokio::test]
    async fn missing_sidecar_is_clear() {
        let error = SttAdapter::from_command(None)
            .transcribe(b"webm")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("SWITCHBOARD_STT_COMMAND"));
    }

    #[tokio::test]
    async fn stt_sidecar_covers_success_failure_and_timeout() {
        let adapter = SttAdapter::from_command(Some("tr '[:lower:]' '[:upper:]'".into()));
        assert_eq!(
            adapter.transcribe(b"heard words\n").await.unwrap(),
            "HEARD WORDS"
        );

        let failed = SttAdapter::from_command(Some("printf 'decoder broke' >&2; exit 7".into()))
            .transcribe(b"webm")
            .await
            .unwrap_err();
        assert!(failed.to_string().contains("decoder broke"));

        // A megabyte cannot fit a pipe buffer and this sidecar never reads it,
        // so the write is certain to break. The caller must still be told why
        // the sidecar failed rather than being handed the broken pipe that
        // failure caused. Real clips are this large, so this is the ordinary
        // path for a sidecar that rejects its input, not a rare one.
        let fast_failure =
            SttAdapter::from_command(Some("printf 'model missing' >&2; exit 3".into()))
                .transcribe(&vec![0u8; 1 << 20])
                .await
                .unwrap_err();
        assert!(fast_failure.to_string().contains("model missing"));
        assert!(!fast_failure.to_string().contains("Broken pipe"));

        let timed_out = SttAdapter {
            command: Some("sleep 60".into()),
            timeout: Duration::from_millis(20),
        }
        .transcribe(b"webm")
        .await
        .unwrap_err();
        assert_eq!(timed_out.to_string(), "STT sidecar timed out");
    }

    #[tokio::test]
    async fn tts_adapter_sends_expected_request_and_surfaces_http_failure() {
        let (speaker, request) = speaker_with_response(StatusCode::OK, b"mp3");
        assert_eq!(speaker.synthesize("Hello there").await.unwrap(), b"mp3");
        let request = request.lock().unwrap().clone().unwrap();
        assert_eq!(
            request.url,
            "https://api.elevenlabs.io/v1/text-to-speech/voice-a"
        );
        assert_eq!(request.api_key, "test-secret");
        assert_eq!(request.body["text"], "Hello there");
        assert_eq!(request.body["model_id"], "model-a");

        let (speaker, _) = speaker_with_response(StatusCode::TOO_MANY_REQUESTS, b"slow down");
        let error = speaker.synthesize("Hello").await.unwrap_err();
        assert!(error.to_string().contains("429 Too Many Requests"));
        assert!(error.to_string().contains("slow down"));
    }
}

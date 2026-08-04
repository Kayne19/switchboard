//! Transitional speech adapters.
//!
//! STT intentionally is not a Rust Whisper implementation: `SttAdapter` runs
//! the command in `SWITCHBOARD_STT_COMMAND`, writes WebM bytes to its stdin,
//! and reads the transcript from stdout. This keeps the service portable while
//! deployments migrate their existing faster-whisper sidecar.

use reqwest::StatusCode;
use serde::Serialize;
use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

pub const ELEVENLABS_TTS_URL: &str = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}";
const STT_TIMEOUT: Duration = Duration::from_secs(120);

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

/// Run the explicitly transitional STT sidecar.
#[derive(Clone, Debug)]
pub struct SttAdapter {
    pub command: Option<String>,
}
impl SttAdapter {
    pub fn from_command(command: Option<String>) -> Self {
        Self {
            command: command.filter(|value| !value.trim().is_empty()),
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
        let mut child = Command::new("sh")
            .args(["-c", command])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| AudioError::Process(format!("could not start STT sidecar: {e}")))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(webm).await.map_err(|e| {
                AudioError::Process(format!("could not send audio to STT sidecar: {e}"))
            })?;
            drop(stdin);
        }
        let output = timeout(STT_TIMEOUT, child.wait_with_output())
            .await
            .map_err(|_| AudioError::Process("STT sidecar timed out".into()))?
            .map_err(|e| AudioError::Process(format!("STT sidecar failed: {e}")))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr)
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
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }
}

#[derive(Clone, Debug)]
pub struct Speaker {
    pub api_key: String,
    pub voice_id: String,
    pub model_id: String,
    pub stability: f32,
    pub similarity_boost: f32,
    pub style: f32,
    pub speed: f32,
    pub max_chars: usize,
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
                .cloned()
                .unwrap_or_else(|| default.to_owned())
        }
        fn number(values: &HashMap<String, String>, name: &str, default: f32) -> f32 {
            values
                .get(name)
                .and_then(|value| value.parse().ok())
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
        let url = ELEVENLABS_TTS_URL.replace("{voice_id}", &self.voice_id);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| {
                AudioError::Tts(format!("could not configure ElevenLabs client: {error}"))
            })?;
        let response = client
            .post(url)
            .header("xi-api-key", &self.api_key)
            .header("Content-Type", "application/json")
            .header("Accept", "audio/mpeg")
            .json(&body)
            .send()
            .await
            .map_err(|e| AudioError::Tts(format!("could not reach ElevenLabs: {e}")))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|e| AudioError::Tts(format!("could not read ElevenLabs response: {e}")))?;
        if status != StatusCode::OK {
            return Err(AudioError::Tts(format!(
                "ElevenLabs TTS failed ({status}): {}",
                String::from_utf8_lossy(&bytes)
                    .chars()
                    .take(500)
                    .collect::<String>()
            )));
        }
        Ok(bytes.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clipping_preserves_sentence_and_max_shape() {
        let speaker = Speaker {
            api_key: String::new(),
            voice_id: String::new(),
            model_id: String::new(),
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            speed: 1.0,
            max_chars: 20,
        };
        let result = speaker.clip_for_speech("One short sentence. Second sentence goes on and on.");
        assert_eq!(result, "One short sentence. — there's more on screen.");
    }
    #[tokio::test]
    async fn missing_sidecar_is_clear() {
        let error = SttAdapter { command: None }
            .transcribe(b"webm")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("SWITCHBOARD_STT_COMMAND"));
    }
}

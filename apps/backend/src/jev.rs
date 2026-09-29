//! Typed client for TypeSafe's hosted Jev System One endpoint.
//!
//! The API key is read from the configured file at request time.  The key
//! itself is never retained in a debug value or included in an error.

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

pub const DEFAULT_MODEL: &str = "jev-latest";

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct JevRequest {
    pub model: String,
    pub state: Value,
    pub questions: BTreeMap<String, Question>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Question {
    #[serde(rename = "type")]
    pub question_type: String,
    pub instructions: String,
    pub criteria: BTreeMap<String, String>,
}

impl Question {
    pub fn new(
        question_type: impl Into<String>,
        instructions: impl Into<String>,
        criteria: impl IntoIterator<Item = (impl Into<String>, impl Into<String>)>,
    ) -> Self {
        Self {
            question_type: question_type.into(),
            instructions: instructions.into(),
            criteria: criteria
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct JevResponse {
    #[serde(default)]
    pub model: Option<String>,
    pub answers: BTreeMap<String, JevAnswer>,
    #[serde(default)]
    pub usage: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct JevAnswer {
    #[serde(rename = "type", default)]
    pub answer_type: Option<String>,
    #[serde(default)]
    pub choice: Option<String>,
    #[serde(default)]
    pub probabilities: Option<BTreeMap<String, f64>>,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub noul: Option<f64>,
}

#[derive(Clone)]
pub struct JevClient {
    client: reqwest::Client,
    url: String,
    key_file: PathBuf,
    timeout: Duration,
    model: String,
}

impl JevClient {
    pub fn new(
        url: impl Into<String>,
        key_file: impl Into<PathBuf>,
        timeout: Duration,
    ) -> Result<Self, JevError> {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|error| JevError::Transport(error.to_string()))?;
        Ok(Self {
            client,
            url: url.into(),
            key_file: key_file.into(),
            timeout,
            model: DEFAULT_MODEL.to_owned(),
        })
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub async fn decide(
        &self,
        state: Value,
        questions: BTreeMap<String, Question>,
    ) -> Result<JevResponse, JevError> {
        let key = std::fs::read_to_string(&self.key_file).map_err(|error| {
            JevError::KeyFile(format!("could not read configured Jev key file: {error}"))
        })?;
        let key = key.trim();
        if key.is_empty() {
            return Err(JevError::KeyFile("configured Jev key file is empty".into()));
        }
        let request = JevRequest {
            model: self.model.clone(),
            state,
            questions,
        };
        let response = self
            .client
            .post(&self.url)
            .header(AUTHORIZATION, format!("Bearer {key}"))
            .header(CONTENT_TYPE, "application/json")
            .json(&request)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|error| JevError::Transport(redact(&error.to_string())))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| JevError::Transport(redact(&error.to_string())))?;
        if !status.is_success() {
            return Err(JevError::Http {
                status: status.as_u16(),
                body: redact(&truncate(&body, 512)),
            });
        }
        serde_json::from_str(&body).map_err(|error| {
            JevError::Response(format!("response was not valid Jev JSON: {error}"))
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JevError {
    KeyFile(String),
    Transport(String),
    Http { status: u16, body: String },
    Response(String),
    InvalidAnswer(String),
}

impl std::fmt::Display for JevError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::KeyFile(message) => f.write_str(message),
            Self::Transport(message) => write!(f, "Jev request failed: {message}"),
            Self::Http { status, body } => write!(f, "Jev returned HTTP {status}: {body}"),
            Self::Response(message) => f.write_str(message),
            Self::InvalidAnswer(message) => write!(f, "Jev returned an invalid answer: {message}"),
        }
    }
}
impl std::error::Error for JevError {}

fn truncate(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

/// Defense in depth for an upstream error that echoes request headers.
fn redact(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    if let Some(start) = lower.find("bearer ") {
        let end = value[start + 7..]
            .find(|character: char| {
                character.is_whitespace() || matches!(character, ',' | '}' | '"')
            })
            .map_or(value.len(), |offset| start + 7 + offset);
        return format!("{}Bearer [REDACTED]{}", &value[..start], &value[end..]);
    }
    value.to_owned()
}

#[cfg(test)]
#[path = "../tests/test_jev.rs"]
mod tests;

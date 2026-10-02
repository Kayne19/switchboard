//! Typed client for TypeSafe's hosted Jev System One endpoint.
//!
//! The API key is read from the configured file at request time.  The key
//! itself is never retained in a debug value or included in an error.

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
#[cfg(test)]
use std::future::Future;
use std::path::PathBuf;
#[cfg(test)]
use std::pin::Pin;
#[cfg(test)]
use std::sync::Arc;
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

#[cfg(test)]
type TestResponder = Arc<
    dyn Fn(JevRequest) -> Pin<Box<dyn Future<Output = Result<JevResponse, JevError>> + Send>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct JevClient {
    client: reqwest::Client,
    url: String,
    key_file: PathBuf,
    timeout: Duration,
    model: String,
    #[cfg(test)]
    test_responder: Option<TestResponder>,
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
            #[cfg(test)]
            test_responder: None,
        })
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }

    /// Installs an in-process responder for tests. This keeps Jev coverage
    /// deterministic without binding a local socket or touching a network.
    #[cfg(test)]
    pub fn with_test_responder<F, Fut>(mut self, responder: F) -> Self
    where
        F: Fn(JevRequest) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<JevResponse, JevError>> + Send + 'static,
    {
        self.test_responder = Some(Arc::new(move |request| Box::pin(responder(request))));
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
        let request = JevRequest {
            model: self.model.clone(),
            state,
            questions,
        };
        #[cfg(test)]
        if let Some(responder) = &self.test_responder {
            return match tokio::time::timeout(self.timeout, responder(request)).await {
                Ok(response) => response,
                Err(_) => Err(JevError::Transport(TIMED_OUT.into())),
            };
        }
        let key = std::fs::read_to_string(&self.key_file).map_err(|error| {
            JevError::KeyFile(format!("could not read configured Jev key file: {error}"))
        })?;
        let key = key.trim();
        if key.is_empty() {
            return Err(JevError::KeyFile("configured Jev key file is empty".into()));
        }
        let response = self
            .client
            .post(&self.url)
            .header(AUTHORIZATION, format!("Bearer {key}"))
            .header(CONTENT_TYPE, "application/json")
            .json(&request)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(transport_error)?;
        let status = response.status();
        let body = response.text().await.map_err(transport_error)?;
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

/// The prefix of every timeout, so callers can tell a slow Jev from a broken one.
const TIMED_OUT: &str = "request timed out";

impl JevError {
    /// Whether Jev did not answer in time, as opposed to answering badly.
    pub fn is_timeout(&self) -> bool {
        matches!(self, Self::Transport(message) if message.starts_with(TIMED_OUT))
    }
}

/// reqwest's message for a timeout does not say so; keep that fact.
fn transport_error(error: reqwest::Error) -> JevError {
    let message = redact(&error.to_string());
    JevError::Transport(if error.is_timeout() {
        format!("{TIMED_OUT}: {message}")
    } else {
        message
    })
}

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

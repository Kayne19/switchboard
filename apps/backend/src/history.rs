use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

pub const CALLER: &str = "caller";
pub const AGENT: &str = "agent";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TranscriptEntry {
    pub role: String,
    pub text: String,
    pub route: String,
    pub ts: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Whether this agent line was voiced to the caller.
    #[serde(default)]
    pub voiced: bool,
}

#[derive(Debug)]
pub struct TranscriptLog {
    limit: usize,
    entries: VecDeque<TranscriptEntry>,
}

impl TranscriptLog {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            entries: VecDeque::with_capacity(limit),
        }
    }

    pub fn add_voiced(
        &mut self,
        role: impl Into<String>,
        text: &str,
        route: impl Into<String>,
    ) -> Option<TranscriptEntry> {
        self.add_with_id_and_voiced(role, text, route, None, true)
    }

    pub fn add_with_id(
        &mut self,
        role: impl Into<String>,
        text: &str,
        route: impl Into<String>,
        id: Option<String>,
    ) -> Option<TranscriptEntry> {
        self.add_with_id_and_voiced(role, text, route, id, false)
    }

    /// The entry for `text`, or None when it is blank. The entry is kept for
    /// page reloads only while the limit allows (a limit of 0 keeps none),
    /// but it is returned either way: whether a line is kept does not decide
    /// whether it reaches the live page (#293).
    pub fn add_with_id_and_voiced(
        &mut self,
        role: impl Into<String>,
        text: &str,
        route: impl Into<String>,
        id: Option<String>,
        voiced: bool,
    ) -> Option<TranscriptEntry> {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        let entry = TranscriptEntry {
            role: role.into(),
            text: text.to_owned(),
            route: route.into(),
            ts: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64(),
            id,
            voiced,
        };
        if self.limit == 0 {
            return Some(entry);
        }
        if self.entries.len() == self.limit {
            self.entries.pop_front();
        }
        self.entries.push_back(entry.clone());
        Some(entry)
    }

    pub fn entries(&self) -> Vec<TranscriptEntry> {
        self.entries.iter().cloned().collect()
    }
}

#[cfg(test)]
#[path = "../tests/test_history.rs"]
mod tests;

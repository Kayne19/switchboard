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
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct HistoryPayload {
    #[serde(rename = "type")]
    pub kind: String,
    pub entries: Vec<TranscriptEntry>,
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

    pub fn add(
        &mut self,
        role: impl Into<String>,
        text: &str,
        route: impl Into<String>,
    ) -> Option<TranscriptEntry> {
        self.add_with_id(role, text, route, None)
    }

    pub fn add_with_id(
        &mut self,
        role: impl Into<String>,
        text: &str,
        route: impl Into<String>,
        id: Option<String>,
    ) -> Option<TranscriptEntry> {
        let text = text.trim();
        if text.is_empty() || self.limit == 0 {
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
        };
        if self.entries.len() == self.limit {
            self.entries.pop_front();
        }
        self.entries.push_back(entry.clone());
        Some(entry)
    }

    pub fn entries(&self) -> Vec<TranscriptEntry> {
        self.entries.iter().cloned().collect()
    }

    pub fn payload(&self) -> HistoryPayload {
        HistoryPayload {
            kind: "history".to_owned(),
            entries: self.entries(),
        }
    }
}

#[cfg(test)]
#[path = "../tests/test_history.rs"]
mod tests;

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_LIMIT: usize = 200;
pub const CALLER: &str = "caller";
pub const AGENT: &str = "agent";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TranscriptEntry {
    pub role: String,
    pub text: String,
    pub route: String,
    pub ts: f64,
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

    pub fn limit(&self) -> usize {
        self.limit
    }

    pub fn add(
        &mut self,
        role: impl Into<String>,
        text: &str,
        route: impl Into<String>,
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

    pub fn replace<I>(&mut self, entries: I)
    where
        I: IntoIterator<Item = TranscriptEntry>,
    {
        self.entries.clear();
        for entry in entries {
            if self.limit == 0 {
                break;
            }
            if self.entries.len() == self.limit {
                self.entries.pop_front();
            }
            self.entries.push_back(entry);
        }
    }

    pub fn payload(&self) -> HistoryPayload {
        HistoryPayload {
            kind: "history".to_owned(),
            entries: self.entries(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_trimmed_entries_and_drops_blank_text() {
        let mut log = TranscriptLog::new(DEFAULT_LIMIT);
        assert!(log.add(CALLER, "  hello  ", "").is_some());
        assert!(log.add(CALLER, "   ", "").is_none());
        assert_eq!(log.entries()[0].text, "hello");
    }

    #[test]
    fn is_bounded_and_payload_is_independent() {
        let mut log = TranscriptLog::new(2);
        for value in ["one", "two", "three"] {
            log.add(AGENT, value, "project");
        }
        assert_eq!(
            log.entries()
                .iter()
                .map(|e| e.text.as_str())
                .collect::<Vec<_>>(),
            ["two", "three"]
        );
        assert_eq!(log.payload().kind, "history");
        assert_eq!(log.limit(), 2);
    }
}

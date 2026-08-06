//! Bounded, intentionally boring diagnostics. This is not a log sink: it is a
//! small support ring safe to expose to status tooling without leaking call data.
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

const CAPACITY: usize = 256;
const FIELD_LIMIT: usize = 128;
const PAYLOAD_LIMIT: usize = 2048;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct DiagnosticRecord {
    pub sequence: u64,
    pub phase: String,
    pub code: String,
    pub count: u64,
    pub label: String,
}

#[derive(Clone, Default)]
pub struct DiagnosticTrace {
    sequence: Arc<AtomicU64>,
    records: Arc<Mutex<VecDeque<DiagnosticRecord>>>,
}

static GLOBAL: OnceLock<DiagnosticTrace> = OnceLock::new();

impl DiagnosticTrace {
    pub fn global() -> &'static Self {
        GLOBAL.get_or_init(Self::default)
    }

    pub fn record(&self, phase: &str, code: &str, count: u64, label: &str) -> DiagnosticRecord {
        let record = DiagnosticRecord {
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed),
            phase: bounded(phase),
            code: bounded(code),
            count,
            label: bounded(label),
        };
        let mut records = self
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        records.push_back(record.clone());
        while records.len() > CAPACITY {
            records.pop_front();
        }
        record
    }

    pub fn records(&self) -> Vec<DiagnosticRecord> {
        self.records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    pub fn payload(&self) -> serde_json::Value {
        let records = self.records();
        let mut value = serde_json::to_value(records).unwrap_or_else(|_| serde_json::json!([]));
        while value.to_string().len() > PAYLOAD_LIMIT {
            let Some(array) = value.as_array_mut() else {
                break;
            };
            if array.is_empty() {
                break;
            }
            array.remove(0);
        }
        value
    }
}

fn bounded(value: &str) -> String {
    value.chars().take(FIELD_LIMIT).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_is_bounded_monotonic_and_utf8_safe() {
        let trace = DiagnosticTrace::default();
        let first = trace.record("phase", "code", 1, &"é".repeat(200));
        assert_eq!(first.sequence, 0);
        assert_eq!(first.label.chars().count(), FIELD_LIMIT);
        for index in 0..300 {
            trace.record("p", &index.to_string(), index, "label");
        }
        let records = trace.records();
        assert_eq!(records.len(), CAPACITY);
        assert_eq!(records[0].sequence, 45);
        assert!(trace.payload().to_string().len() <= PAYLOAD_LIMIT);
    }

    #[test]
    fn trace_has_no_free_form_secret_fields() {
        let trace = DiagnosticTrace::default();
        let record = trace.record("turn", "timeout", 0, "safe-label");
        let value = serde_json::to_value(record).unwrap();
        assert!(value.get("prompt").is_none());
        assert!(value.get("token").is_none());
    }
}

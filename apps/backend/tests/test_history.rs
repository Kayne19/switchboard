use super::*;

#[test]
fn stores_trimmed_entries_and_drops_blank_text() {
    let mut log = TranscriptLog::new(200);
    assert!(log.add_with_id(CALLER, "  hello  ", "", None).is_some());
    assert!(log.add_with_id(CALLER, "   ", "", None).is_none());
    assert_eq!(log.entries()[0].text, "hello");
}

#[test]
fn caller_ids_round_trip_and_old_entries_still_load() {
    let mut log = TranscriptLog::new(200);
    let entry = log
        .add_with_id(CALLER, "hello", "operator", Some("clip-1".into()))
        .unwrap();
    assert_eq!(entry.id.as_deref(), Some("clip-1"));
    assert!(!entry.voiced);
    let voiced = log.add_voiced(AGENT, "spoken", "operator").unwrap();
    assert!(voiced.voiced);
    let encoded = serde_json::to_string(&log.entries()).unwrap();
    assert!(encoded.contains("clip-1"));
    let old = r#"{"role":"caller","text":"old","route":"operator","ts":1.0}"#;
    let entry: TranscriptEntry = serde_json::from_str(old).unwrap();
    assert_eq!(entry.id, None);
}

#[test]
fn a_limit_of_zero_keeps_nothing_but_still_returns_the_entry() {
    let mut log = TranscriptLog::new(0);
    let entry = log.add_voiced(AGENT, "spoken", "operator").unwrap();
    assert_eq!(entry.text, "spoken");
    assert!(log.entries().is_empty());
}

#[test]
fn is_bounded_to_the_newest_entries() {
    let mut log = TranscriptLog::new(2);
    for value in ["one", "two", "three"] {
        log.add_with_id(AGENT, value, "project", None);
    }
    assert_eq!(
        log.entries()
            .iter()
            .map(|e| e.text.as_str())
            .collect::<Vec<_>>(),
        ["two", "three"]
    );
}

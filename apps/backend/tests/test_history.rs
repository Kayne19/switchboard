use super::*;

#[test]
fn stores_trimmed_entries_and_drops_blank_text() {
    let mut log = TranscriptLog::new(200);
    assert!(log.add(CALLER, "  hello  ", "").is_some());
    assert!(log.add(CALLER, "   ", "").is_none());
    assert_eq!(log.entries()[0].text, "hello");
}

#[test]
fn caller_ids_round_trip_and_old_entries_still_load() {
    let mut log = TranscriptLog::new(200);
    let entry = log
        .add_with_id(CALLER, "hello", "operator", Some("clip-1".into()))
        .unwrap();
    assert_eq!(entry.id.as_deref(), Some("clip-1"));
    let encoded = serde_json::to_string(&log.payload()).unwrap();
    assert!(encoded.contains("clip-1"));
    let old = r#"{"type":"history","entries":[{"role":"caller","text":"old","route":"operator","ts":1.0}]}"#;
    let payload: HistoryPayload = serde_json::from_str(old).unwrap();
    assert_eq!(payload.entries[0].id, None);
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
}

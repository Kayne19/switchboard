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

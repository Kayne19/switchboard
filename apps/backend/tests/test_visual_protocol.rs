use super::*;
use serde_json::{json, Value};

#[test]
fn normalizes_note_anchor_and_caption() {
    let action = json!({
        "op": "show",
        "id": "spike-note",
        "type": "note",
        "role": "secondary",
        "data": {
            "tag": "LOOK HERE",
            "caption": "ANNOTATION / VALIDATION SPIKE",
            "segments": [{"text": "Validation turns upward here."}],
            "anchor": {"target": "loss-chart", "x": 32, "series": "VAL LOSS"}
        }
    });

    assert_eq!(validate_action(&action), Ok(action));
}

#[test]
fn rejects_note_anchor_without_a_target() {
    let action = json!({
        "op": "show",
        "id": "spike-note",
        "type": "note",
        "data": {
            "segments": [{"text": "No target."}],
            "anchor": {"x": 32}
        }
    });

    assert_eq!(
        validate_action(&action),
        Err("note.anchor.target must be a non-empty identifier".into())
    );
}

fn labelled_chart(data: Value) -> Value {
    let mut data = data;
    let base = json!({
        "kind": "bar",
        "labels": ["backend", "frontend", "skill"],
        "series": [{"name": "SECONDS", "values": [41.2, 18.7, 3.1]}]
    });
    for (key, value) in base.as_object().unwrap() {
        data.as_object_mut()
            .unwrap()
            .entry(key.clone())
            .or_insert(value.clone());
    }
    json!({"op": "show", "id": "durations", "type": "chart", "data": data})
}

// The browser's validateChartData holds the same rules; the fixtures in
// apps/frontend/tests/fixtures/display-actions.json pin both to them.
#[test]
fn normalizes_chart_kind_and_labels() {
    let action = labelled_chart(json!({"title": "SUITE DURATIONS"}));
    assert_eq!(validate_action(&action), Ok(action));
    for kind in CHART_KINDS {
        let action = labelled_chart(json!({"kind": kind}));
        assert_eq!(validate_action(&action), Ok(action), "{kind}");
    }
    // A series may carry fewer values than there are labels.
    let short = labelled_chart(json!({"series": [{"name": "SECONDS", "values": [41.2]}]}));
    assert_eq!(validate_action(&short), Ok(short));
}

#[test]
fn rejects_a_chart_kind_it_does_not_draw() {
    let action = labelled_chart(json!({"kind": "pie"}));
    assert_eq!(validate_action(&action), Err("invalid chart.kind".into()));
}

#[test]
fn rejects_chart_labels_outside_their_bounds() {
    let too_many: Vec<String> = (0..=MAX_CHART_LABELS).map(|i| format!("L{i}")).collect();
    let action = labelled_chart(json!({"labels": too_many}));
    assert_eq!(
        validate_action(&action),
        Err("chart.labels must be an array of 1 to 100 strings".into())
    );
    let action = labelled_chart(json!({"labels": [], "series": []}));
    assert_eq!(
        validate_action(&action),
        Err("chart.labels must be an array of 1 to 100 strings".into())
    );
    let action = labelled_chart(json!({"labels": ["a", 2, "c"]}));
    assert_eq!(
        validate_action(&action),
        Err("chart label must be a string".into())
    );
    let action = labelled_chart(json!({"labels": ["x".repeat(65), "b", "c"]}));
    assert_eq!(
        validate_action(&action),
        Err("chart label exceeds maximum length of 64 UTF-16 code units".into())
    );
    // An astral character is two UTF-16 units, as in the browser.
    let action = labelled_chart(json!({"labels": ["\u{1F600}".repeat(33), "b", "c"]}));
    assert!(validate_action(&action).is_err());
}

#[test]
fn rejects_a_series_longer_than_the_chart_labels() {
    let action = labelled_chart(json!({"series": [{"name": "SECONDS", "values": [1, 2, 3, 4]}]}));
    assert_eq!(
        validate_action(&action),
        Err("series.values is longer than chart.labels".into())
    );
}

fn progress_value(value: Value) -> Value {
    let action = json!({
        "op": "show",
        "id": "deploy",
        "type": "progress",
        "data": { "label": "DEPLOY", "value": value, "text": "65% COMPLETE" }
    });
    match validate_action(&action) {
        Ok(normalized) => normalized["data"]["value"].clone(),
        Err(error) => panic!("expected progress action to validate, got: {error}"),
    }
}

#[test]
fn normalizes_progress_percentage_values() {
    assert_eq!(progress_value(json!(0)), json!(0));
    assert_eq!(progress_value(json!(1)), json!(1));
    assert_eq!(progress_value(json!(1.02)), json!(1.02));
    assert_eq!(progress_value(json!(65)), json!(65));
    assert_eq!(progress_value(json!(100)), json!(100));
    assert_eq!(progress_value(json!(-5)), json!(0));
    assert_eq!(progress_value(json!(150)), json!(100));
}

// The browser's normalizeProgressValue rounds the same way; its test
// pins the same cases.
#[test]
fn rounds_progress_values_to_two_decimal_places() {
    assert_eq!(progress_value(json!(33.333)), json!(33.33));
    assert_eq!(progress_value(json!(66.666)), json!(66.67));
}

#[test]
fn rejects_non_finite_progress_values() {
    for non_finite in [json!("NaN"), json!("Infinity"), json!("-Infinity")] {
        let action = json!({
            "op": "show",
            "id": "deploy",
            "type": "progress",
            "data": { "label": "DEPLOY", "value": non_finite }
        });
        assert!(validate_action(&action).is_err());
    }
}

/// The validator is held to `docs/display-action-v1.schema.json`, the one
/// source for the display protocol: it accepts every show type the schema
/// lists with exactly the data the schema requires, refuses each of those
/// types when a required key is missing, and knows no other type.
#[test]
fn show_types_and_their_required_data_follow_the_schema() {
    let schema: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/docs/display-action-v1.schema.json"
    )))
    .unwrap();
    let definitions = &schema["definitions"];
    let mut required_by_type: Vec<(String, Vec<String>)> = Vec::new();
    for variant in schema["oneOf"].as_array().unwrap() {
        let name = variant["$ref"]
            .as_str()
            .unwrap()
            .rsplit('/')
            .next()
            .unwrap();
        let properties = &definitions[name]["properties"];
        let Some(kind) = properties["type"]["enum"][0].as_str() else {
            continue;
        };
        let data = match properties["data"]["$ref"].as_str() {
            Some(reference) => &definitions[reference.rsplit('/').next().unwrap()],
            None => &properties["data"],
        };
        let required = data["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| key.as_str().unwrap().to_owned())
            .collect();
        required_by_type.push((kind.to_owned(), required));
    }
    let mut schema_types: Vec<&str> = required_by_type.iter().map(|(k, _)| k.as_str()).collect();
    schema_types.sort_unstable();
    let mut content_types = CONTENT_TYPES.to_vec();
    content_types.sort_unstable();
    assert_eq!(
        content_types, schema_types,
        "the validator's types are the schema's"
    );

    // The smallest data the validator accepts for each type. Each carries
    // exactly the schema's required keys, checked below, so a key the schema
    // adds or drops fails here until both sides agree.
    let smallest = |kind: &str| -> Value {
        match kind {
            "chart" => json!({"series": [{"name": "a", "values": [1]}]}),
            "metric" => json!({"label": "L", "value": "1"}),
            "progress" => json!({"label": "L", "value": 50}),
            "diagram" => {
                json!({"mode": "graph", "nodes": [{"id": "n", "label": "N"}], "edges": []})
            }
            "document" => json!({"subject": "S", "paragraphs": ["p"]}),
            "code" => json!({"source": {"text": "x"}}),
            "note" => json!({"segments": [{"text": "t"}]}),
            other => panic!("no sample for {other}; the schema grew a type"),
        }
    };
    for (kind, required) in &required_by_type {
        let data = smallest(kind);
        let mut keys: Vec<&str> = data
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        let mut wanted: Vec<&str> = required.iter().map(String::as_str).collect();
        wanted.sort_unstable();
        assert_eq!(
            keys, wanted,
            "{kind}: the sample carries the schema's required keys"
        );
        let action = json!({"op": "show", "id": "x", "type": kind, "data": data});
        assert!(
            validate_action(&action).is_ok(),
            "{kind}: {:?}",
            validate_action(&action)
        );
        for key in required {
            let mut short = action.clone();
            short["data"].as_object_mut().unwrap().remove(key);
            assert!(
                validate_action(&short).is_err(),
                "{kind} without {key} must be refused"
            );
        }
    }
}

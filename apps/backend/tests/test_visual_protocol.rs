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

fn progress_steps(data: Value) -> Result<Value, String> {
    validate_action(&json!({
        "op": "show",
        "id": "build",
        "type": "progress",
        "data": data
    }))
    .map(|normalized| normalized["data"].clone())
}

// The browser's progressValueOfSteps fills the bar the same way; the
// `show_progress_steps_without_value` fixture pins both to one output.
#[test]
fn fills_in_the_value_from_the_steps_when_the_agent_gives_none() {
    let data = progress_steps(json!({
        "label": "BUILD",
        "steps": [
            {"label": "Fetch", "state": "done"},
            {"label": "Compile", "state": "active"},
            {"label": "Link"}
        ]
    }))
    .unwrap();
    assert_eq!(data["value"], json!(33.33));
    assert_eq!(data["steps"].as_array().unwrap().len(), 3);
    // A step without a state stays as sent: the browser reads it as todo.
    assert_eq!(data["steps"][2], json!({"label": "Link"}));

    let all_done = progress_steps(json!({
        "label": "BUILD",
        "steps": [{"label": "Fetch", "state": "done"}, {"label": "Link", "state": "done"}]
    }))
    .unwrap();
    assert_eq!(all_done["value"], json!(100));
}

#[test]
fn keeps_the_agents_value_over_the_steps_when_both_are_given() {
    let data = progress_steps(json!({
        "label": "BUILD",
        "value": 10,
        "steps": [{"label": "Fetch", "state": "done"}]
    }))
    .unwrap();
    assert_eq!(data["value"], json!(10));
}

#[test]
fn refuses_a_progress_with_neither_value_nor_steps() {
    assert_eq!(
        progress_steps(json!({"label": "BUILD", "text": "working"})),
        Err("progress requires value or steps".into())
    );
}

#[test]
fn bounds_and_shapes_the_steps() {
    let many: Vec<Value> = (0..31).map(|i| json!({"label": format!("s{i}")})).collect();
    assert_eq!(
        progress_steps(json!({"label": "L", "steps": many})),
        Err("progress.steps must be an array of 1 to 30 items".into())
    );
    assert_eq!(
        progress_steps(json!({"label": "L", "value": 1, "steps": []})),
        Err("progress.steps must be an array of 1 to 30 items".into())
    );
    assert_eq!(
        progress_steps(json!({"label": "L", "steps": [{"label": "S", "state": "paused"}]})),
        Err("invalid progress step.state".into())
    );
    assert_eq!(
        progress_steps(json!({"label": "L", "steps": [{"label": "S", "percent": 5}]})),
        Err("unknown field in progress step: percent".into())
    );
    assert_eq!(
        progress_steps(json!({"label": "L", "steps": [{"label": "x".repeat(129)}]})),
        Err("progress step.label exceeds maximum length of 128 UTF-16 code units".into())
    );
    assert_eq!(
        progress_steps(json!({"label": "L", "steps": [{"label": "S", "detail": "d".repeat(257)}]})),
        Err("progress step.detail exceeds maximum length of 256 UTF-16 code units".into())
    );
    assert_eq!(
        progress_steps(json!({"label": "L", "steps": ["Fetch"]})),
        Err("progress step must be an object".into())
    );
}

fn metric(data: Value) -> Result<Value, String> {
    validate_action(&json!({"op": "show", "id": "m", "type": "metric", "data": data}))
        .map(|normalized| normalized["data"].clone())
}

#[test]
fn carries_a_metric_trend_and_delta_and_bounds_them() {
    let data = metric(json!({
        "label": "P95", "value": "182 ms", "trend": "down", "delta": "-12 ms"
    }))
    .unwrap();
    assert_eq!(data["trend"], json!("down"));
    assert_eq!(data["delta"], json!("-12 ms"));
    for trend in ["up", "down", "flat"] {
        assert!(metric(json!({"label": "P95", "value": "1", "trend": trend})).is_ok());
    }
    assert_eq!(
        metric(json!({"label": "P95", "value": "1", "trend": "sideways"})),
        Err("invalid metric.trend".into())
    );
    assert_eq!(
        metric(json!({"label": "P95", "value": "1", "trend": 1})),
        Err("invalid metric.trend".into())
    );
    assert!(metric(json!({"label": "P95", "value": "1", "delta": "x".repeat(32)})).is_ok());
    assert_eq!(
        metric(json!({"label": "P95", "value": "1", "delta": "x".repeat(33)})),
        Err("metric.delta exceeds maximum length of 32 UTF-16 code units".into())
    );
    assert_eq!(
        metric(json!({"label": "P95", "value": "1", "delta": 3})),
        Err("metric.delta must be a string".into())
    );
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
        // A shape with an `anyOf` of `required` branches (progress: value
        // or steps) needs one branch met; the first is the one the sample
        // carries.
        let first_branch = data["anyOf"][0]["required"].as_array();
        let required = data["required"]
            .as_array()
            .unwrap()
            .iter()
            .chain(first_branch.into_iter().flatten())
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
    // exactly the schema's required keys (and the first `anyOf` branch's),
    // checked below, so a key the schema adds or drops fails here until both
    // sides agree.
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

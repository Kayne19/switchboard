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
    fn resolve<'a>(definitions: &'a Value, node: &'a Value) -> &'a Value {
        match node["$ref"].as_str() {
            Some(reference) => &definitions[reference.rsplit('/').next().unwrap()],
            None => node,
        }
    }
    // A type's data is one shape, or (a diagram's) one shape per `mode`:
    // (type, mode, required keys).
    let mut required_by_shape: Vec<(String, Option<String>, Vec<String>)> = Vec::new();
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
        let data = resolve(definitions, &properties["data"]);
        let shapes: Vec<&Value> = match data["oneOf"].as_array() {
            Some(branches) => branches
                .iter()
                .map(|branch| resolve(definitions, branch))
                .collect(),
            None => vec![data],
        };
        for shape in shapes {
            let mode = shape["properties"]["mode"]["enum"][0]
                .as_str()
                .map(str::to_owned);
            let required = shape["required"]
                .as_array()
                .unwrap()
                .iter()
                .map(|key| key.as_str().unwrap().to_owned())
                .collect();
            required_by_shape.push((kind.to_owned(), mode, required));
        }
    }
    let mut schema_types: Vec<&str> = required_by_shape
        .iter()
        .map(|(k, _, _)| k.as_str())
        .collect();
    schema_types.sort_unstable();
    schema_types.dedup();
    let mut content_types = CONTENT_TYPES.to_vec();
    content_types.sort_unstable();
    assert_eq!(
        content_types, schema_types,
        "the validator's types are the schema's"
    );

    // The smallest data the validator accepts for each shape. Each carries
    // exactly the schema's required keys, checked below, so a key the schema
    // adds or drops fails here until both sides agree.
    let smallest = |kind: &str, mode: Option<&str>| -> Value {
        match (kind, mode) {
            ("chart", None) => json!({"series": [{"name": "a", "values": [1]}]}),
            ("metric", None) => json!({"label": "L", "value": "1"}),
            ("progress", None) => json!({"label": "L", "value": 50}),
            ("diagram", Some("graph")) => {
                json!({"mode": "graph", "nodes": [{"id": "n", "label": "N"}], "edges": []})
            }
            ("diagram", Some("sequence")) => {
                json!({"mode": "sequence", "actors": [{"id": "a", "label": "A"}], "messages": []})
            }
            ("document", None) => json!({"subject": "S", "paragraphs": ["p"]}),
            ("code", None) => json!({"source": {"text": "x"}}),
            ("note", None) => json!({"segments": [{"text": "t"}]}),
            other => panic!("no sample for {other:?}; the schema grew a type or a mode"),
        }
    };
    for (kind, mode, required) in &required_by_shape {
        let shape = match mode {
            Some(mode) => format!("{kind}/{mode}"),
            None => kind.clone(),
        };
        let data = smallest(kind, mode.as_deref());
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
            "{shape}: the sample carries the schema's required keys"
        );
        let action = json!({"op": "show", "id": "x", "type": kind, "data": data});
        assert!(
            validate_action(&action).is_ok(),
            "{shape}: {:?}",
            validate_action(&action)
        );
        for key in required {
            let mut short = action.clone();
            short["data"].as_object_mut().unwrap().remove(key);
            assert!(
                validate_action(&short).is_err(),
                "{shape} without {key} must be refused"
            );
        }
    }
}

/// Sequence mode is held to the same rules as the browser validator: actor
/// ids unique, every message between known actors with a label, a known
/// kind, a boolean `active`; a self-message allowed; the graph arrays
/// refused by name, and the sequence arrays refused in graph mode.
#[test]
fn sequence_diagrams_follow_the_browser_rules() {
    let sequence = |actors: Value, messages: Value| {
        json!({
            "op": "show", "id": "seq", "type": "diagram",
            "data": {"mode": "sequence", "actors": actors, "messages": messages}
        })
    };
    let actors = json!([{"id": "a", "label": "A"}, {"id": "b", "label": "B", "sub": "S", "semantic": "cyan"}]);

    let accepted = sequence(
        actors.clone(),
        json!([
            {"from": "a", "to": "b", "label": "call"},
            {"from": "b", "to": "b", "label": "self"},
            {"from": "b", "to": "a", "label": "back", "kind": "return", "active": true}
        ]),
    );
    assert_eq!(validate_action(&accepted), Ok(accepted.clone()));

    let refused = [
        (
            sequence(
                json!([{"id": "a", "label": "A"}, {"id": "a", "label": "B"}]),
                json!([]),
            ),
            "duplicate diagram actor id: a",
        ),
        (
            sequence(
                actors.clone(),
                json!([{"from": "a", "to": "c", "label": "x"}]),
            ),
            "diagram message to endpoint \"c\" not found in actors",
        ),
        (
            sequence(actors.clone(), json!([{"from": "a", "to": "b"}])),
            "diagram message.label must be a string",
        ),
        (
            sequence(
                actors.clone(),
                json!([{"from": "a", "to": "b", "label": "x", "kind": "reply"}]),
            ),
            "invalid diagram message.kind",
        ),
        (
            sequence(
                actors.clone(),
                json!([{"from": "a", "to": "b", "label": "x", "active": "yes"}]),
            ),
            "diagram message.active must be boolean",
        ),
        (
            json!({"op": "show", "id": "seq", "type": "diagram", "data": {"mode": "sequence", "actors": actors, "messages": [], "nodes": []}}),
            "diagram.nodes and diagram.edges belong to mode \"graph\"",
        ),
        (
            json!({"op": "show", "id": "seq", "type": "diagram", "data": {"mode": "graph", "nodes": [{"id": "n", "label": "N"}], "edges": [], "messages": []}}),
            "diagram.actors and diagram.messages belong to mode \"sequence\"",
        ),
        (
            json!({"op": "show", "id": "seq", "type": "diagram", "data": {"mode": "timeline", "actors": [], "messages": []}}),
            "diagram.mode must be \"graph\" or \"sequence\"",
        ),
    ];
    for (action, reason) in refused {
        assert_eq!(validate_action(&action), Err(reason.into()), "{action}");
    }
}

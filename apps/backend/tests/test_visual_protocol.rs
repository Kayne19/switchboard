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

fn table_action(data: Value) -> Value {
    json!({"op": "show", "id": "results", "type": "table", "data": data})
}

// The table rules the schema cannot state (docs/display-tool.md, "Table v1
// rules"): a row has exactly one cell per column, a highlight names a row,
// and a cell is a string, a number or `{text, semantic?, bold?}`. The
// browser's validation.test.ts pins the same cases.
#[test]
fn table_rows_fit_their_columns() {
    let two = json!([{"label": "a"}, {"label": "b"}]);
    assert!(validate_action(&table_action(json!({"columns": two, "rows": [["x", 1]]}))).is_ok());
    assert_eq!(
        validate_action(&table_action(
            json!({"columns": two, "rows": [["x", 1], ["y"]]})
        )),
        Err("table row 1 has 1 cells; the table has 2 columns".into())
    );
    assert_eq!(
        validate_action(&table_action(json!({"columns": two, "rows": ["x"]}))),
        Err("table row 0 must be an array".into())
    );
}

#[test]
fn table_rows_are_at_most_two_hundred() {
    let one = json!([{"label": "a"}]);
    let rows = |n: usize| Value::Array((0..n).map(|_| json!(["x"])).collect());
    assert!(validate_action(&table_action(json!({"columns": one, "rows": rows(200)}))).is_ok());
    for data in [
        json!({"columns": one, "rows": rows(201)}),
        json!({"columns": one}),
    ] {
        assert_eq!(
            validate_action(&table_action(data)),
            Err("table.rows must be an array of at most 200 items".into())
        );
    }
}

#[test]
fn table_highlight_names_rows() {
    let one = json!([{"label": "a"}]);
    let rows = json!([["x"], ["y"]]);
    for index in [json!(0), json!(1), json!(1.0)] {
        let data = json!({"columns": one, "rows": rows, "highlight": [index]});
        assert!(validate_action(&table_action(data)).is_ok());
    }
    for index in [json!(2), json!(-1), json!(0.5), json!("0")] {
        let data = json!({"columns": one, "rows": rows, "highlight": [index]});
        assert_eq!(
            validate_action(&table_action(data)),
            Err("table.highlight must contain row indices".into())
        );
    }
}

#[test]
fn table_cells_are_text_numbers_or_styled_text() {
    let one = json!([{"label": "a"}]);
    let ok = json!({"columns": one, "rows": [["x"], [1.5], [{"text": "y", "semantic": "red", "bold": true}]]});
    assert_eq!(
        validate_action(&table_action(ok.clone())),
        Ok(table_action(ok))
    );
    for (cell, error) in [
        (
            json!(true),
            "table cell must be a string, a number or an object",
        ),
        (
            json!(null),
            "table cell must be a string, a number or an object",
        ),
        (
            json!({"semantic": "red"}),
            "table cell.text must be a string",
        ),
        (
            json!({"text": "y", "semantic": "pink"}),
            "invalid table cell.semantic",
        ),
        (
            json!({"text": "y", "bold": "yes"}),
            "table cell.bold must be boolean",
        ),
        (
            json!({"text": "y", "align": "right"}),
            "unknown field in table cell: align",
        ),
        (
            json!("x".repeat(257)),
            "table cell exceeds maximum length of 256 UTF-16 code units",
        ),
        (
            json!({"text": "x".repeat(257)}),
            "table cell.text exceeds maximum length of 256 UTF-16 code units",
        ),
    ] {
        let data = json!({"columns": one, "rows": [[cell]]});
        assert_eq!(validate_action(&table_action(data)), Err(error.into()));
    }
}

#[test]
fn table_columns_are_one_to_twelve_labelled() {
    let columns = |n: usize| -> Value {
        Value::Array((0..n).map(|i| json!({"label": format!("c{i}")})).collect())
    };
    assert!(validate_action(&table_action(json!({"columns": columns(12), "rows": []}))).is_ok());
    for n in [0, 13] {
        assert_eq!(
            validate_action(&table_action(json!({"columns": columns(n), "rows": []}))),
            Err("table.columns must be an array of 1 to 12 items".into())
        );
    }
    assert_eq!(
        validate_action(&table_action(
            json!({"columns": [{"label": "a", "align": "right"}], "rows": []})
        )),
        Err("unknown field in table column: align".into())
    );
    assert_eq!(
        validate_action(&table_action(
            json!({"columns": [{"label": "x".repeat(65)}], "rows": []})
        )),
        Err("table column.label exceeds maximum length of 64 UTF-16 code units".into())
    );
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
            "table" => json!({"columns": [{"label": "c"}], "rows": []}),
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

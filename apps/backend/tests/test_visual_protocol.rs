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
            ("table", None) => json!({"columns": [{"label": "c"}], "rows": []}),
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

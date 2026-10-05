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
        // A shape with an `anyOf` of `required` branches (progress: value
        // or steps) needs one branch met; the first is the one the sample
        // carries.
        for shape in shapes {
            let mode = shape["properties"]["mode"]["enum"][0]
                .as_str()
                .map(str::to_owned);
            let first_branch = shape["anyOf"][0]["required"].as_array();
            let required = shape["required"]
                .as_array()
                .unwrap()
                .iter()
                .chain(first_branch.into_iter().flatten())
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
    // exactly the schema's required keys (and the first `anyOf` branch's),
    // checked below, so a key the schema adds or drops fails here until both
    // sides agree.
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
            ("image", None) => json!({"format": "png", "bytes": PNG_1X1, "alt": "a"}),
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

// ---- image -----------------------------------------------------------------

/// A real 1x1 PNG (69 bytes), the same one `display-actions.json` carries.
const PNG_1X1: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mN48ew+AAVnAq5EDgAUAAAAAElFTkSuQmCC";

/// Standard base64 of `bytes`, for building test images.
fn base64_of(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// `size` bytes that start with `format`'s signature and are otherwise zero:
/// enough for the validator, which sniffs the signature and never decodes
/// the picture.
pub(crate) fn image_bytes(format: &str, size: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; size];
    let signature: &[u8] = match format {
        "png" => &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        "jpeg" => &[0xff, 0xd8, 0xff, 0xe0],
        "webp" => b"RIFF\0\0\0\0WEBP",
        other => panic!("no signature for {other}"),
    };
    bytes[..signature.len()].copy_from_slice(signature);
    bytes
}

/// A `show` of a `format` image of `size` raw bytes, as an agent sends it.
pub(crate) fn image_show(id: &str, format: &str, size: usize) -> Value {
    json!({"op": "show", "id": id, "type": "image", "role": "primary",
        "data": {"format": format, "bytes": base64_of(&image_bytes(format, size)), "alt": "a test image"}})
}

#[test]
fn the_base64_decoder_is_strict_and_round_trips() {
    assert_eq!(decode_base64("aGVsbG8="), Ok(b"hello".to_vec()));
    assert_eq!(decode_base64("aGk="), Ok(b"hi".to_vec()));
    assert_eq!(decode_base64("aGV5"), Ok(b"hey".to_vec()));
    assert_eq!(decode_base64("/+8="), Ok(vec![0xff, 0xef]));
    for size in 0..40 {
        let bytes: Vec<u8> = (0..size).map(|n| (n * 37 % 256) as u8).collect();
        let encoded = base64_of(&bytes);
        assert_eq!(
            base64_decoded_length(&encoded),
            (size > 0).then_some(size),
            "{size}"
        );
        if size > 0 {
            assert_eq!(decode_base64(&encoded), Ok(bytes), "{size}");
        }
    }
    // Not strict standard base64: empty, unpadded, over-padded, whitespace,
    // the URL-safe alphabet, a data: prefix, padding in the middle.
    for bad in [
        "",
        "aGk",
        "aGk==",
        "aG k=",
        "aGVsbG8=\n",
        "_-8=",
        "data:image/png;base64,aGk=",
        "aG==k=",
        "====",
    ] {
        assert_eq!(base64_decoded_length(bad), None, "{bad:?}");
        assert!(decode_base64(bad).is_err(), "{bad:?}");
    }
    assert_eq!(
        decode_base64_head(PNG_1X1, 8),
        Ok(vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    assert_eq!(decode_base64_head("aGk=", 12), Ok(b"hi".to_vec()));
}

#[test]
fn image_signatures_are_sniffed_per_format() {
    for format in ["png", "jpeg", "webp"] {
        let bytes = image_bytes(format, 16);
        assert!(image_signature_matches(format, &bytes), "{format}");
        for other in ["png", "jpeg", "webp"] {
            if other != format {
                assert!(
                    !image_signature_matches(other, &bytes),
                    "{format} as {other}"
                );
            }
        }
    }
    assert!(!image_signature_matches("webp", b"RIFF\0\0\0\0WAVE"));
    assert!(!image_signature_matches(
        "svg",
        b"<svg xmlns=\"http://www.w3.org/2000/svg\">"
    ));
    assert!(!image_signature_matches("png", &[0x89, 0x50]));
}

#[test]
fn accepts_a_real_png_and_keeps_its_fields() {
    let action = json!({"op": "show", "id": "fig", "type": "image", "role": "primary", "data": {
        "format": "png", "bytes": PNG_1X1, "alt": "One paper pixel",
        "title": "FIGURE / PIXEL", "subtitle": "TEST", "context": "FIGURE", "caption": "IMAGE / PNG"}});
    assert_eq!(validate_action(&action), Ok(action));
    for format in ["jpeg", "webp"] {
        assert!(
            validate_action(&image_show("fig", format, 64)).is_ok(),
            "{format}"
        );
    }
}

#[test]
fn refuses_images_that_are_not_raster_bytes_of_their_format() {
    let show = |data: Value| json!({"op": "show", "id": "fig", "type": "image", "data": data});
    assert_eq!(
        validate_action(&show(
            json!({"format": "svg", "bytes": base64_of(b"<svg xmlns='x'></svg>"), "alt": "a"})
        )),
        Err("image.format svg is refused: an image is raster bytes, not markup".into())
    );
    assert_eq!(
        validate_action(&show(
            json!({"format": "gif", "bytes": PNG_1X1, "alt": "a"})
        )),
        Err("image.format must be one of png, jpeg, webp".into())
    );
    assert_eq!(
        validate_action(&show(
            json!({"format": "jpeg", "bytes": PNG_1X1, "alt": "a"})
        )),
        Err("image.bytes do not start with the jpeg signature".into())
    );
    assert_eq!(
        validate_action(&show(json!({"format": "png", "bytes": format!("data:image/png;base64,{PNG_1X1}"), "alt": "a"}))),
        Err("image.bytes must be standard base64: the A-Za-z0-9+/ alphabet, padded with =, no data: prefix".into())
    );
    assert_eq!(
        validate_action(&show(
            json!({"format": "png", "bytes": "iVBORw0K", "alt": "a"})
        )),
        Err("image.bytes are too short to be a png".into())
    );
    assert_eq!(
        validate_action(&show(json!({"format": "png", "bytes": 7, "alt": "a"}))),
        Err("image.bytes must be a base64 string".into())
    );
    assert_eq!(
        validate_action(&show(json!({"format": "png", "bytes": PNG_1X1}))),
        Err("image.alt must be a string".into())
    );
    assert_eq!(
        validate_action(&show(
            json!({"format": "png", "bytes": PNG_1X1, "alt": "  "})
        )),
        Err("image.alt must not be empty".into())
    );
    assert_eq!(
        validate_action(&show(
            json!({"format": "png", "bytes": PNG_1X1, "alt": "a", "width": 64})
        )),
        Err("model-controlled layout field is forbidden: width".into())
    );
    assert_eq!(
        validate_action(&show(
            json!({"format": "png", "bytes": PNG_1X1, "alt": "a", "zoom": 2})
        )),
        Err("unknown field in image data: zoom".into())
    );
}

#[test]
fn an_image_is_capped_at_eight_mebibytes_and_its_action_at_twelve() {
    assert!(validate_action(&image_show("fig", "png", MAX_IMAGE_BYTES)).is_ok());
    assert_eq!(
        validate_action(&image_show("fig", "png", MAX_IMAGE_BYTES + 1)),
        Err(format!(
            "image.bytes decode to more than {MAX_IMAGE_BYTES} bytes"
        ))
    );
    // Past the action cap, the size check answers before the image is read.
    let oversized = image_show("fig", "png", MAX_IMAGE_ACTION_BYTES);
    assert_eq!(
        validate_action(&oversized),
        Err("action exceeds size limit".into())
    );
    // Only an image show gets the larger cap: the same bytes under another
    // type, or in a note, are held to the general one.
    let mut as_document = image_show("fig", "png", 100_000);
    as_document["type"] = json!("document");
    assert_eq!(
        validate_action(&as_document),
        Err("action exceeds size limit".into())
    );
    let note = json!({"op": "show", "id": "n", "type": "note",
        "data": {"segments": [{"text": "x".repeat(49_000)}]}});
    assert_eq!(
        validate_action(&note),
        Err("action exceeds size limit".into())
    );
}

/// `WHITE_SPACE` is Unicode White_Space exactly, which `char::is_whitespace`
/// is defined as; the browser's list is held to `\p{White_Space}` the same
/// way (validation.test.ts).
#[test]
fn the_whitespace_set_is_unicode_white_space() {
    let differ: Vec<String> = (char::MIN..=char::MAX)
        .filter(|c| WHITE_SPACE.contains(c) != c.is_whitespace())
        .map(|c| format!("U+{:04X}", c as u32))
        .collect();
    assert!(differ.is_empty(), "{differ:?}");
    assert!(is_blank("") && is_blank(" \u{85}\u{3000}"));
    assert!(!is_blank("\u{feff}") && !is_blank("\u{200b}") && !is_blank("\u{1c}"));
}

/// The size cap counts the action as the browser's JSON.stringify writes it
/// (validation.ts `serializedSize`), numbers included: each pair is the JSON
/// an agent may send and what JSON.stringify writes once the browser has
/// parsed it, both taken from node.
#[test]
fn the_size_is_counted_as_json_stringify_writes_the_action() {
    for (sent, javascript) in [
        ("0", "0"),
        ("-0", "0"),
        ("-0.0", "0"),
        ("0.0", "0"),
        ("1", "1"),
        ("1.0", "1"),
        ("-1.5", "-1.5"),
        ("100", "100"),
        ("1e2", "100"),
        ("0.1", "0.1"),
        ("0.000001", "0.000001"),
        ("0.0000001", "1e-7"),
        ("1e-7", "1e-7"),
        ("1.5e-7", "1.5e-7"),
        ("123.456", "123.456"),
        ("1e16", "10000000000000000"),
        ("1e+16", "10000000000000000"),
        ("12345678901234567890", "12345678901234567000"),
        ("18446744073709551615", "18446744073709552000"),
        ("-9223372036854775808", "-9223372036854776000"),
        ("1e21", "1e+21"),
        ("1e20", "100000000000000000000"),
        ("123456789012345680000", "123456789012345680000"),
        ("1.7976931348623157e308", "1.7976931348623157e+308"),
        ("5e-324", "5e-324"),
        ("0.30000000000000004", "0.30000000000000004"),
        ("4.35", "4.35"),
        ("1e-6", "0.000001"),
        ("999999999999999999999", "1e+21"),
        ("2.5e+25", "2.5e+25"),
        ("-1e-10", "-1e-10"),
    ] {
        let number: Value = serde_json::from_str(sent).unwrap();
        assert_eq!(
            json_len(&number),
            javascript.len(),
            "{sent} is {javascript}"
        );
    }
    for (text, bytes) in [
        ("", 2),
        ("plain", 7),
        ("a\"b\\c", 9),
        ("\u{8}\u{c}\n\r\t", 12),
        ("\u{1}\u{1f}", 14),
        ("\u{7f}\u{2028}", 6),
        ("\u{e9}\u{1f600}", 8),
        ("<\u{0}>", 10),
    ] {
        assert_eq!(json_len(&json!(text)), bytes, "{text:?}");
    }
    let action: Value = serde_json::from_str(r#"{"op": "show", "id": "t", "type": "table", "data": {"columns": [{"label": "a\"\n"}], "rows": [[1.0], [-0.0], [1e+16], [{"text": "\u00e9", "bold": false}]], "highlight": [0]}}"#).unwrap();
    assert_eq!(json_len(&action), 158);
}

// ---- the shared corpus -------------------------------------------------------

/// `{"$repeat": s, "times": n}` in the corpus stands for `s` repeated `n`
/// times, so a case at a length cap stays one readable line. The browser's
/// `validatorCorpus.test.ts` expands it the same way.
fn expand_corpus_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            if map.len() == 2 {
                if let (Some(Value::String(text)), Some(times)) =
                    (map.get("$repeat"), map.get("times").and_then(Value::as_u64))
                {
                    return Value::String(text.repeat(times as usize));
                }
            }
            Value::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), expand_corpus_value(value)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(expand_corpus_value).collect()),
        other => other.clone(),
    }
}

/// JSON equality with numbers compared by value, as the browser compares
/// them: the corpus's `1.0` and the validator's `1` are one number.
fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same_json(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, value)| y.get(key).is_some_and(|other| same_json(value, other)))
        }
        _ => a == b,
    }
}

/// The two validators agree rule for rule (AGENTS.md): each case in
/// `apps/frontend/tests/fixtures/validator-corpus.json` is an action and
/// what both must make of it, either the exact error or acceptance (with
/// the normalized action, when it is not the action as sent). The browser's
/// `validatorCorpus.test.ts` runs the same file. An accepted action is
/// accepted again, unchanged, when it is validated a second time: the
/// browser validates what this side normalized.
#[test]
fn agrees_with_the_shared_validator_corpus() {
    let corpus: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/apps/frontend/tests/fixtures/validator-corpus.json"
    )))
    .unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let action = expand_corpus_value(&case["action"]);
        let got = validate_action(&action);
        match (case.get("error"), case.get("accepted")) {
            (Some(Value::String(error)), None) => {
                if got.as_ref() != Err(error) {
                    failures.push(format!("{name}: wanted the error {error:?}, got {got:?}"));
                }
            }
            (None, Some(Value::Bool(true))) => {
                let wanted = expand_corpus_value(case.get("normalized").unwrap_or(&case["action"]));
                match got {
                    Ok(normalized) if same_json(&normalized, &wanted) => {
                        let again = validate_action(&normalized);
                        if again.as_ref() != Ok(&normalized) {
                            failures.push(format!(
                                "{name}: its normalized action validates to {again:?}"
                            ));
                        }
                    }
                    Ok(normalized) => failures.push(format!("{name}: normalized to {normalized}")),
                    Err(error) => failures.push(format!("{name}: refused with {error:?}")),
                }
            }
            _ => panic!("{name}: a case is either accepted or names its error"),
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} corpus cases disagree:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
    // Every op and every show type is both accepted and refused somewhere.
    for outcome in ["accepted", "error"] {
        let mut wanted: Vec<String> = ["hide", "focus", "say", "clear"]
            .iter()
            .map(|op| op.to_string())
            .chain(CONTENT_TYPES.iter().map(|kind| format!("show {kind}")))
            .collect();
        wanted.retain(|kind| {
            !cases.iter().any(|case| {
                let action = &case["action"];
                let named = match (action["op"].as_str(), action["type"].as_str()) {
                    (Some("show"), Some(kind)) => format!("show {kind}"),
                    (Some(op), _) => op.to_owned(),
                    _ => return false,
                };
                case.get(outcome).is_some() && named == *kind
            })
        });
        assert!(wanted.is_empty(), "no {outcome} case for {wanted:?}");
    }
}

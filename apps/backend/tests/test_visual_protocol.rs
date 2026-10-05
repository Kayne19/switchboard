use super::*;
use serde_json::{json, Value};

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

// Clamping and rounding are corpus cases (`progress_value_clamps_*`,
// `progress_value_rounds*`). These values come back as sent: a value of 1
// or less is a percent, not a fraction.
#[test]
fn normalizes_progress_percentage_values() {
    assert_eq!(progress_value(json!(0)), json!(0));
    assert_eq!(progress_value(json!(1)), json!(1));
    assert_eq!(progress_value(json!(1.02)), json!(1.02));
    assert_eq!(progress_value(json!(65)), json!(65));
    assert_eq!(progress_value(json!(100)), json!(100));
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

// The browser's progressValueOfSteps fills the bar the same way. A third
// done (`progress_steps_thirds`) and a step without a state kept as sent
// (`progress_steps_fill_the_value`) are corpus cases; all done is a full bar.
#[test]
fn fills_in_the_value_from_the_steps_when_the_agent_gives_none() {
    let all_done = progress_steps(json!({
        "label": "BUILD",
        "steps": [{"label": "Fetch", "state": "done"}, {"label": "Link", "state": "done"}]
    }))
    .unwrap();
    assert_eq!(all_done["value"], json!(100));
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
            ("calendar", None) => json!({"view": "week", "start": "2026-10-05", "events": []}),
            ("tasks", None) => json!({"items": [{"id": "t", "text": "T"}]}),
            ("timer", None) => {
                json!({"timers": [{"id": "t", "label": "T", "endsAt": "2026-10-05T18:42:00Z"}]})
            }
            ("weather", None) => {
                json!({"location": "L", "units": "C", "current": {"temp": 1, "condition": "clear"}})
            }
            ("inbox", None) => {
                json!({"messages": [{"id": "m", "from": "F", "time": "2026-10-05"}]})
            }
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

/// A number is read as the double JavaScript reads it from the same text
/// (serde_json's `float_roundtrip`): the default parse reads these one step
/// off, and the size and the normalized action would follow the wrong value.
#[test]
fn numbers_parse_to_the_double_javascript_reads() {
    for (text, double, javascript) in [
        ("6e23", 6e23_f64, "6e+23"),
        ("6e+23", 6e23, "6e+23"),
        ("3e27", 3e27, "3e+27"),
        (
            "970034019735371.5",
            970_034_019_735_371.5,
            "970034019735371.5",
        ),
    ] {
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed.as_f64(), Some(double), "{text}");
        assert_eq!(json_len(&parsed), javascript.len(), "{text}");
    }
}

/// The service's one time parser (docs/display-tool.md, "Time values"). The
/// shared corpus pins which texts both validators accept; this pins the day
/// a time falls on and the order of two instants, which the browser's
/// `timeValues.test.ts` pins for `parseTimeValue` too.
#[test]
fn time_values_count_days_from_1970_and_order_instants_by_the_moment() {
    for (text, day_number) in [
        ("1970-01-01", 0),
        ("2000-02-29", 11_016),
        ("2026-10-05", 20_731),
        ("2100-03-01", 47_541),
        ("2199-12-31", 84_005),
        ("2026-10-05T23:59", 20_731),
        ("2026-10-05T23:59:59-07:00", 20_731),
    ] {
        let time = parse_time_value(text).expect(text);
        assert_eq!(time.day_number, day_number, "{text}");
    }
    let at = |text: &str| parse_time_value(text).expect(text).place;
    assert_eq!(at("2026-10-05T18:42:00-07:00"), at("2026-10-06T01:42:00Z"));
    assert_eq!(at("2026-10-05T18:42:00-00:00"), at("2026-10-05T18:42:00Z"));
    assert!(at("2026-10-06T02:30:00+01:00") < at("2026-10-05T18:42:00-07:00"));
    assert!(at("2026-10-05T18:42:00.000000001Z") > at("2026-10-05T18:42:00Z"));
    assert!(at("2026-10-05T09:30") < at("2026-10-05T09:31"));
    for text in [
        "2026-02-29",
        "2026-10-05T24:00",
        "2026-10-05T09:00:00",
        "2026-10-05t09:00",
        "2026-10-05T18:42:00z",
        "\u{ff12}026-10-05",
    ] {
        assert!(parse_time_value(text).is_none(), "{text}");
    }
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

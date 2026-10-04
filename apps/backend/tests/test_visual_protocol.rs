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
            "image" => json!({"format": "png", "bytes": PNG_1X1, "alt": "a"}),
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

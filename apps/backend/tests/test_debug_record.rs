use super::*;
use crate::debug::{host_link, DebugBus, DebugEvent};
use serde_json::json;

#[test]
fn one_record_cannot_exceed_the_size_bounds() {
    let bus = DebugBus::new();
    let huge = "é".repeat(MAX_FIELD_BYTES); // two bytes per char
    bus.publish(DebugEvent::UtilityRequest {
        utterance_id: "u".into(),
        attempt: "first".into(),
        prompt: huge.clone(),
    });
    let wide: serde_json::Map<String, Value> = (0..1_000)
        .map(|n| (format!("k{n}"), Value::String(huge.clone())))
        .collect();
    bus.publish(DebugEvent::ToolEnd {
        agent: "alpha".into(),
        call_id: None,
        tool: "bash".into(),
        result: Some(json!({"items": vec![1; 1_000], "wide": wide})),
        error: None,
        turn_id: None,
    });
    bus.publish(host_link(1));
    bus.publish_log("INFO".into(), "t".into(), huge.clone(), json!({"f": huge}));
    let snapshot = bus.snapshot();
    let DebugEvent::UtilityRequest { prompt, .. } = &snapshot.events[0].event else {
        panic!("utility request")
    };
    assert!(snapshot.events[0].clipped);
    assert!(prompt.ends_with(CLIP_MARKER));
    assert!(prompt.len() <= MAX_FIELD_BYTES + CLIP_MARKER.len());
    assert!(snapshot.events[1].clipped);
    let size = serde_json::to_string(snapshot.events[1].as_ref())
        .unwrap()
        .len();
    assert!(
        size < MAX_RECORD_BYTES * 2,
        "tool result record is {size} bytes"
    );
    assert!(!snapshot.events[2].clipped);
    assert!(snapshot.logs[0].clipped);
    assert!(snapshot.logs[0].message.ends_with(CLIP_MARKER));
}

#[test]
fn credentials_are_scrubbed_from_text() {
    assert_eq!(
        scrub_text("API_KEY=abc123 and token: \"xyz.789\" ok"),
        "API_KEY=[redacted] and token: \"[redacted]\" ok"
    );
    assert_eq!(
        scrub_text("Authorization: Bearer eyJhbGci.payload.sig"),
        "Authorization: [redacted] [redacted]"
    );
    assert_eq!(scrub_text("Bearer abc.def end"), "Bearer [redacted] end");
    assert_eq!(
        scrub_text("use ghp_0123456789abcdefABCDEF now"),
        "use [redacted] now"
    );
    assert_eq!(scrub_text("max tokens: 500"), "max tokens: 500");
    assert_eq!(scrub_text("the key idea"), "the key idea");
}

#[test]
fn secret_names_match_whole_key_parts_only() {
    for name in [
        "token",
        "call_token",
        "api_key",
        "apiKey",
        "Authorization",
        "client_secret",
        "KEY",
        "x-api-keys",
    ] {
        assert!(secret_name(name), "{name}");
    }
    for name in ["keyboard", "monkey", "project", "path"] {
        assert!(!secret_name(name), "{name}");
    }
}

#[test]
fn published_events_are_scrubbed_before_they_are_kept() {
    let bus = DebugBus::new();
    bus.publish(DebugEvent::ToolStart {
        agent: "alpha".into(),
        call_id: None,
        tool: "bash".into(),
        args: Some(json!({
            "call_token": "t-1",
            "input_tokens": 12,
            "nested": [{"password": "p"}, "SECRET=s"],
            "path": "/srv/a"
        })),
        turn_id: None,
    });
    bus.publish(DebugEvent::AgentInput {
        agent: "alpha".into(),
        turn_id: None,
        text: "deploy with GITHUB_TOKEN=ghp_0123456789abcdefABCDEF".into(),
        source: "caller".into(),
        utterance_id: None,
    });
    let snapshot = bus.snapshot();
    let DebugEvent::ToolStart { args, .. } = &snapshot.events[0].event else {
        panic!("tool start")
    };
    assert_eq!(
        args.as_ref().unwrap(),
        &json!({
            "call_token": "[redacted]",
            "input_tokens": 12,
            "nested": [{"password": "[redacted]"}, "SECRET=[redacted]"],
            "path": "/srv/a"
        })
    );
    // Scrubbing alone does not mark a record clipped.
    assert!(!snapshot.events[0].clipped);
    let DebugEvent::AgentInput { text, .. } = &snapshot.events[1].event else {
        panic!("agent input")
    };
    assert_eq!(text, "deploy with GITHUB_TOKEN=[redacted]");
}

#[test]
fn private_key_blocks_are_redacted_whole() {
    let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nAAAAMwAAAAtzc2gtZWQyNTUxOQ\n-----END OPENSSH PRIVATE KEY-----";
    assert_eq!(
        scrub_text(&format!("$ cat id_ed25519\n{key}\n$ ")),
        "$ cat id_ed25519\n[redacted]\n$ "
    );
    for label in [
        "RSA PRIVATE KEY",
        "PRIVATE KEY",
        "EC PRIVATE KEY",
        "ENCRYPTED PRIVATE KEY",
    ] {
        let block = format!("-----BEGIN {label}-----\nMIIEow\n-----END {label}-----");
        assert_eq!(
            scrub_text(&format!("a {block} b")),
            "a [redacted] b",
            "{label}"
        );
    }
    // A block cut before its end is redacted to the end of the text.
    assert_eq!(
        scrub_text("key:\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC"),
        "key:\n[redacted]"
    );
    // A public certificate is not a secret.
    let cert = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    assert_eq!(scrub_text(cert), cert);
}

#[test]
fn credentials_with_a_known_shape_are_redacted() {
    let secrets = [
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        "AKIAIOSFODNN7EXAMPLE",
        "ASIAY34FZKBOKMUTVV7A",
        "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
        "hf_aBcDeFgHiJkLmNoPqRsTuVwXyZ01234567",
        "xoxb-1234567890-0987654321-AbCdEfGhIjKl",
        "xoxp-1234567890-0987654321-AbCdEfGhIjKl",
        "ghp_0123456789abcdefABCDEF0123456789ab",
        "gho_0123456789abcdefABCDEF0123456789ab",
        "ghu_0123456789abcdefABCDEF0123456789ab",
        "ghs_0123456789abcdefABCDEF0123456789ab",
        "ghr_0123456789abcdefABCDEF0123456789ab",
        "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
        "sk-proj-0123456789abcdefABCDEF",
        "sk-ant-api03-0123456789abcdef",
        concat!("glp", "at-0123456789abcdefABCD"),
        "npm_0123456789abcdefABCDEF0123456789ab",
        // No known prefix, but long and random: an opaque bearer token.
        "Zx8Qp2Lk9Vw3Rt7Ym4Nb6Hc1Jd5Fg0Ks2Pq9",
    ];
    for secret in secrets {
        assert_eq!(
            scrub_text(&format!("got {secret} back")),
            "got [redacted] back",
            "{secret}"
        );
    }
}

#[test]
fn ordinary_words_and_digests_are_kept() {
    for text in [
        "sk-learn is installed",
        "commit a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 landed",
        "id 550e8400-e29b-41d4-a716-446655440000",
        "handleDecisionForStateWithUtterance2 returned",
        "test_debug_published_events_are_scrubbed_before_they_are_kept",
        "AKIA is a prefix",
        "eyJhbGciOiJIUzI1NiJ9 alone",
        "the key idea",
    ] {
        assert_eq!(scrub_text(text), text);
    }
}

#[test]
fn a_secret_named_value_is_redacted_whatever_its_type() {
    let mut clip = Clip::new();
    let mut value = json!({
        "password": ["hunter2"],
        "client_secret": {"value": "s"},
        "pin_token": 987654321,
        "api_key": "k",
        "input_tokens": 12,
        "jev_summary_token_budget": 300,
        "key_configured": true,
        "token": null,
        "path": "/srv/a"
    });
    clip.json(&mut value);
    assert_eq!(
        value,
        json!({
            "password": "[redacted]",
            "client_secret": "[redacted]",
            "pin_token": "[redacted]",
            "api_key": "[redacted]",
            "input_tokens": 12,
            "jev_summary_token_budget": 300,
            "key_configured": true,
            "token": null,
            "path": "/srv/a"
        })
    );
}

#[test]
fn names_and_ids_are_scrubbed_too() {
    let bus = DebugBus::new();
    let secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
    bus.publish(DebugEvent::OperatorRouteTool {
        utterance_id: "u".into(),
        target: secret.into(),
        mode: "fresh".into(),
        action: "transfer".into(),
    });
    bus.publish(DebugEvent::Routed {
        utterance_id: "u".into(),
        to_agent: secret.into(),
        text_part: "t".into(),
        mode: "fresh".into(),
        via: "operator".into(),
    });
    bus.publish(DebugEvent::ModuleCall {
        agent: "alpha".into(),
        call_id: secret.into(),
        name: secret.into(),
        args: json!({}),
        turn_id: None,
    });
    bus.publish(DebugEvent::ToolEnd {
        agent: "alpha".into(),
        call_id: Some(secret.into()),
        tool: secret.into(),
        result: None,
        error: None,
        turn_id: Some(secret.into()),
    });
    for record in bus.snapshot().events {
        let wire = serde_json::to_string(record.as_ref()).unwrap();
        assert!(!wire.contains(secret), "leaked: {wire}");
    }
}

#[test]
fn names_ids_and_keys_are_cut_and_a_record_has_a_hard_size() {
    let bus = DebugBus::new();
    let long = "n".repeat(100_000);
    let mut args = serde_json::Map::new();
    args.insert("k".repeat(1 << 20), json!("v"));
    bus.publish(DebugEvent::ModuleCall {
        agent: long.clone(),
        call_id: long.clone(),
        name: long.clone(),
        args: Value::Object(args),
        turn_id: Some(long.clone()),
    });
    // Deep and wide JSON, every string at the field bound.
    let field = "x".repeat(MAX_FIELD_BYTES * 2);
    let mut deep = json!(field);
    for _ in 0..100 {
        deep = json!([deep.clone(), {"a": field, "b": [field, field]}]);
    }
    bus.publish(DebugEvent::ToolEnd {
        agent: "alpha".into(),
        call_id: None,
        tool: "bash".into(),
        result: Some(deep),
        error: Some(field.clone()),
        turn_id: None,
    });
    let snapshot = bus.snapshot();
    let DebugEvent::ModuleCall {
        call_id,
        name,
        args,
        ..
    } = &snapshot.events[0].event
    else {
        panic!("module call")
    };
    assert!(snapshot.events[0].clipped);
    assert!(call_id.len() <= MAX_NAME_BYTES + CLIP_MARKER.len());
    assert!(name.ends_with(CLIP_MARKER));
    let key = args.as_object().unwrap().keys().next().unwrap();
    assert!(
        key.len() <= MAX_NAME_BYTES + CLIP_MARKER.len(),
        "{}",
        key.len()
    );
    for record in &snapshot.events {
        let size = serde_json::to_string(record.as_ref()).unwrap().len();
        assert!(size < MAX_RECORD_BYTES * 2, "record is {size} bytes");
    }
}

#[test]
fn an_image_display_call_is_kept_as_a_clipped_record() {
    // An image action carries up to ~11 MiB of base64. The feed keeps the
    // call, with the image's bytes cut to one field's bound.
    let bus = DebugBus::new();
    let bytes = format!("iVBORw0KGgo{}", "A".repeat(11 << 20));
    bus.publish(DebugEvent::ModuleCall {
        agent: "alpha".into(),
        call_id: "m1".into(),
        name: "display".into(),
        args: json!({"action": {"op": "show", "id": "fig", "type": "image",
            "data": {"format": "png", "bytes": bytes, "alt": "a figure"}}}),
        turn_id: None,
    });
    let snapshot = bus.snapshot();
    let record = &snapshot.events[0];
    assert!(record.clipped);
    let DebugEvent::ModuleCall { args, .. } = &record.event else {
        panic!("module call")
    };
    let data = &args["action"]["data"];
    let kept = data["bytes"].as_str().unwrap();
    assert!(kept.starts_with("iVBORw0KGgo"));
    assert!(kept.ends_with(CLIP_MARKER));
    assert!(kept.len() <= MAX_FIELD_BYTES + CLIP_MARKER.len());
    assert_eq!(data["alt"], "a figure");
    let size = serde_json::to_string(record.as_ref()).unwrap().len();
    assert!(size < MAX_RECORD_BYTES * 2, "record is {size} bytes");
}

#[test]
fn only_the_part_of_a_string_that_can_be_kept_is_scrubbed() {
    // A 16 MiB field costs what its kept prefix costs: the rest is never
    // scanned.
    let huge = "word ".repeat(16 << 20 >> 2);
    assert_eq!(
        scrub_window(&huge, MAX_FIELD_BYTES).len(),
        MAX_FIELD_BYTES + SCRUB_MARGIN
    );
    let mut text = huge;
    Clip::new().text(&mut text);
    assert!(text.len() <= MAX_FIELD_BYTES + CLIP_MARKER.len());
    // A credential that runs across the cut is still redacted up to it.
    let mut text = format!(
        "{}API_KEY={}",
        "a ".repeat((MAX_FIELD_BYTES - 10) / 2),
        "s".repeat(4 * MAX_FIELD_BYTES)
    );
    Clip::new().text(&mut text);
    assert!(!text.contains("sss"), "{}", &text[text.len() - 40..]);
}

#[test]
fn a_record_size_estimate_counts_what_it_keeps() {
    let mut small = Clip::new();
    small.name(&mut "alpha".to_owned());
    assert_eq!(small.bytes(), RECORD_OVERHEAD_BYTES + 5);
    let mut large = Clip::new();
    large.json(&mut json!(vec!["x".repeat(MAX_FIELD_BYTES * 8); 8]));
    assert!(large.bytes() > MAX_RECORD_BYTES);
    assert!(large.bytes() < MAX_RECORD_BYTES + RECORD_OVERHEAD_BYTES + 256);
}

#[test]
fn a_clipped_array_does_not_keep_its_input_buffer() {
    // A producer moves its value into the record. The kept array must be a
    // new buffer of the kept items, not the input's buffer cut short.
    let bus = DebugBus::new();
    bus.publish(DebugEvent::ModuleCall {
        agent: "alpha".into(),
        call_id: "m1".into(),
        name: "display".into(),
        args: Value::Array(vec![Value::Null; 1_000_000]),
        turn_id: None,
    });
    let snapshot = bus.snapshot();
    let DebugEvent::ModuleCall { args, .. } = &snapshot.events[0].event else {
        panic!("module call")
    };
    let items = args.as_array().unwrap();
    assert_eq!(items.len(), MAX_JSON_ITEMS + 1);
    assert!(
        items.capacity() <= MAX_JSON_ITEMS + 1,
        "the kept array holds {} slots",
        items.capacity()
    );
}

#[test]
fn a_record_size_estimate_counts_every_json_node() {
    fn nodes(value: &Value) -> usize {
        1 + match value {
            Value::Array(items) => items.iter().map(nodes).sum(),
            Value::Object(map) => map.values().map(nodes).sum(),
            _ => 0,
        }
    }
    // Empty strings and arrays have almost no text, but each node is a
    // `Value` in memory all the same.
    let mut value = json!(vec![vec![""; 64]; 64]);
    let mut clip = Clip::new();
    clip.json(&mut value);
    let kept = nodes(&value);
    assert!(
        clip.bytes() >= kept * std::mem::size_of::<Value>(),
        "{kept} nodes kept, estimated at {} bytes",
        clip.bytes()
    );
}

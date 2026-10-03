use super::*;
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeSet;

/// The examples both halves of the protocol are held to, as `(name, message)`.
fn examples() -> Vec<(String, Value)> {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../frontend/tests/fixtures/server-messages.json"
    ))
    .expect("server-messages.json is JSON");
    fixture["messages"]
        .as_array()
        .expect("the fixture holds a `messages` array")
        .iter()
        .map(|example| {
            let name = example["name"].as_str().expect("every example is named");
            (name.to_owned(), example["message"].clone())
        })
        .collect()
}

fn example(name: &str) -> Value {
    examples()
        .into_iter()
        .find_map(|(example, message)| (example == name).then_some(message))
        .unwrap_or_else(|| panic!("the fixture has no example named {name}"))
}

/// Every `type` a message of the enum `M` can have, as serde itself knows
/// them.
///
/// Asked to read a tag it does not know, serde reports the whole list of
/// variants through `serde::de::Error::unknown_variant`. This error type keeps
/// that list rather than formatting it into a message, so the list cannot fall
/// behind the enum.
fn message_types<M: Deserialize<'static> + std::fmt::Debug>() -> &'static [&'static str] {
    #[derive(Debug)]
    struct Variants(&'static [&'static str]);
    impl std::fmt::Display for Variants {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(formatter, "variants {:?}", self.0)
        }
    }
    impl std::error::Error for Variants {}
    impl serde::de::Error for Variants {
        fn custom<T: std::fmt::Display>(message: T) -> Self {
            panic!("expected serde to report the variants, not: {message}")
        }
        fn unknown_variant(_variant: &str, expected: &'static [&'static str]) -> Self {
            Variants(expected)
        }
    }
    let probe = serde::de::value::MapDeserializer::<_, Variants>::new(std::iter::once((
        "type",
        "not a message type",
    )));
    match M::deserialize(probe) {
        Err(Variants(expected)) => expected,
        Ok(message) => panic!("an unknown type decoded as {message:?}"),
    }
}

#[test]
fn every_example_serializes_back_to_itself() {
    for (name, example) in examples() {
        let message: ServerMessage = serde_json::from_value(example.clone())
            .unwrap_or_else(|error| panic!("example {name} is not a server message: {error}"));
        assert_eq!(
            message.to_value(),
            example,
            "example {name} does not serialize back to itself"
        );
    }
}

#[test]
fn every_message_type_has_an_example() {
    let known: BTreeSet<&str> = message_types::<ServerMessage>().iter().copied().collect();
    assert!(known.contains("epoch") && known.contains("screen_state_ack"));
    let examples = examples();
    let exemplified: BTreeSet<&str> = examples
        .iter()
        .filter_map(|(_, message)| message["type"].as_str())
        .collect();
    let missing: Vec<&str> = known.difference(&exemplified).copied().collect();
    assert!(
        missing.is_empty(),
        "these message types have no example in server-messages.json: {missing:?}"
    );
}

#[test]
fn optional_fields_are_left_out_rather_than_sent_empty() {
    assert_eq!(
        ServerMessage::error("Unknown websocket command.").to_value(),
        json!({"type":"error", "message":"Unknown websocket command."})
    );
    assert_eq!(
        ServerMessage::error_for("clip-1", "The call worker is unavailable.").to_value(),
        json!({"type":"error", "id":"clip-1", "message":"The call worker is unavailable."})
    );
    assert_eq!(
        ServerMessage::Accepted {
            id: "clip-1".into(),
            streaming: false,
        }
        .to_value(),
        json!({"type":"accepted", "id":"clip-1"})
    );
    assert_eq!(
        ServerMessage::Display {
            action: json!({"op":"clear"}),
            seq: None,
        }
        .to_value(),
        json!({"type":"display", "action":{"op":"clear"}})
    );
}

/// The status message `status` the coordinator publishes.
fn published(coordinator: &crate::lifecycle::Coordinator) -> Value {
    ServerMessage::Status(coordinator.status()).to_value()
}

/// The browser types every status field, so the examples it is held to must
/// be what the coordinator actually publishes: on the operator, as a
/// switchboard built from the deployment's settings starts, and on a project.
#[test]
fn the_status_examples_are_the_statuses_the_coordinator_publishes() {
    let config = crate::Config::for_tests(&[
        ("SWITCHBOARD_OPERATOR_MODEL", "provider/operator-model:low"),
        ("SWITCHBOARD_AGENT_THINKING", "medium"),
    ]);
    let alpha: crate::registry::Project =
        serde_json::from_value(json!({"id":"alpha"})).expect("a minimal project");
    let registry = crate::registry::Registry::new(vec![alpha]);
    let prewarm = crate::prewarm::Prewarm::settled(
        &config,
        &registry,
        crate::models::ModelCatalog::unavailable("no catalog in this test"),
    );
    let board = crate::pbx::Switchboard::new(&config, registry, std::sync::Arc::new(prewarm));
    assert_eq!(published(&board.coordinator()), example("status_operator"));

    let on_a_project = || {
        crate::lifecycle::Coordinator::new(
            crate::lifecycle::StatusConfig {
                operator_model: "provider/operator-model:low".into(),
                model_swaps: true,
                projects: vec!["alpha".into(), "beta".into()],
            },
            "medium",
        )
    };

    // A leg on its launch catalog that has reported its thinking level.
    let coordinator = on_a_project();
    let catalog = crate::models::ModelCatalog {
        entries: [("model-a", true), ("model-b", false)]
            .into_iter()
            .map(|(model, thinks)| crate::models::CatalogEntry {
                provider: "provider".into(),
                model: model.into(),
                thinks,
            })
            .collect(),
        available: true,
        diagnostic: None,
    };
    coordinator
        .begin_candidate(
            crate::lifecycle::CandidateLeg::new(
                "alpha",
                "alpha",
                "session",
                "alpha-leg",
                "provider/model-a:high",
                "high",
            )
            .with_catalog(catalog),
        )
        .unwrap();
    coordinator.adopt_candidate("alpha-leg").unwrap();
    coordinator.finish_intro();
    assert_eq!(
        coordinator.accept_thinking_callback("alpha-leg", "high"),
        Ok(true)
    );
    assert_eq!(published(&coordinator), example("status_project"));

    // A leg adopted without a catalog, before it reports its level.
    let coordinator = on_a_project();
    coordinator
        .begin_candidate(crate::lifecycle::CandidateLeg::new(
            "beta",
            "beta",
            "session",
            "beta-leg",
            "provider/model-a",
            "medium",
        ))
        .unwrap();
    coordinator.adopt_candidate("beta-leg").unwrap();
    assert_eq!(
        published(&coordinator),
        example("status_project_without_a_catalog")
    );
}

#[test]
fn a_frame_that_is_no_command_is_unreadable_in_one_of_three_ways() {
    for (frame, unreadable) in [
        ("not json", UnreadableFrame::NotJson),
        ("", UnreadableFrame::NotJson),
        (r#"{"type":"ping""#, UnreadableFrame::NotJson),
        ("null", UnreadableFrame::NotAnObject),
        ("42", UnreadableFrame::NotAnObject),
        (r#""ping""#, UnreadableFrame::NotAnObject),
        (r#"[{"type":"ping"}]"#, UnreadableFrame::NotAnObject),
        ("{}", UnreadableFrame::UnknownType),
        (r#"{"type":null}"#, UnreadableFrame::UnknownType),
        (r#"{"type":0}"#, UnreadableFrame::UnknownType),
        (r#"{"type":"Ping"}"#, UnreadableFrame::UnknownType),
        (r#"{"type":"dance"}"#, UnreadableFrame::UnknownType),
        (
            r#"{"type":"hello_ack","version":1}"#,
            UnreadableFrame::UnknownType,
        ),
    ] {
        assert_eq!(ClientMessage::parse(frame), Err(unreadable), "{frame}");
    }
}

#[test]
fn a_command_of_a_known_type_always_reads() {
    let parse = |frame: Value| ClientMessage::parse(&frame.to_string()).unwrap();
    // A field missing, null, or of the wrong kind is absent; one no command
    // declares is ignored.
    assert_eq!(
        parse(json!({"type":"clip", "id":7, "mime":null, "generation":1.5, "x":1})),
        ClientMessage::Clip {
            id: None,
            mime: None,
            generation: None
        }
    );
    assert_eq!(
        parse(json!({"type":"stt_chunk", "clip_id":"c", "generation":-1, "sequence":"2"})),
        ClientMessage::SttChunk {
            clip_id: Some("c".into()),
            generation: None,
            sequence: None
        }
    );
    // The echoed heartbeat fields are taken as they come.
    assert_eq!(
        parse(json!({"type":"ping", "nonce":[1], "time":{"t":2}})),
        ClientMessage::Ping {
            nonce: json!([1]),
            time: json!({"t":2})
        }
    );
    assert_eq!(
        parse(json!({"type":"ping"})),
        ClientMessage::Ping {
            nonce: Value::Null,
            time: Value::Null
        }
    );
    // A nested object that is not an object, or lacks what it needs, is
    // absent as a whole; an array is not read as the object's fields.
    assert_eq!(
        parse(json!({"type":"hello", "version":1, "capabilities":[true, true]})),
        ClientMessage::Hello {
            version: Some(1),
            capabilities: None
        }
    );
    let rejected =
        |rejected: Value| match parse(json!({"type":"screen_state", "rejected":rejected})) {
            ClientMessage::ScreenState(report) => report.rejected,
            other => panic!("not a screen state: {other:?}"),
        };
    assert_eq!(rejected(json!([3, "why"])), None);
    assert_eq!(rejected(json!({"reason":"why"})), None);
    assert_eq!(
        rejected(json!({"seq":3, "reason":4})),
        Some(Rejection {
            seq: 3,
            reason: None
        })
    );
    // A repeated key keeps its last value, the type included.
    assert_eq!(
        ClientMessage::parse(r#"{"type":"dance","type":"stt_end","clip_id":"a","clip_id":"b"}"#),
        Ok(ClientMessage::SttEnd {
            clip_id: Some("b".into()),
            generation: None
        })
    );
}

/// The examples of the browser's commands, as `(name, message)`. The browser
/// builds each with its builder in `protocol.ts` and must get exactly the
/// example (`apps/frontend/tests/test_protocol.mjs`).
fn client_examples() -> Vec<(String, Value)> {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../frontend/tests/fixtures/client-messages.json"
    ))
    .expect("client-messages.json is JSON");
    fixture["messages"]
        .as_array()
        .expect("the fixture holds a `messages` array")
        .iter()
        .map(|example| {
            let name = example["name"].as_str().expect("every example is named");
            (name.to_owned(), example["message"].clone())
        })
        .collect()
}

/// `value` without its null fields, at any depth. A command's fields are
/// read leniently, so a null one reads as absent, the same as a missing one.
fn without_nulls(value: Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .filter(|(_, field)| !field.is_null())
                .map(|(name, field)| (name, without_nulls(field)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(without_nulls).collect()),
        other => other,
    }
}

/// Each example reads as a command, and writing that command back gives the
/// example: every field the browser sends is one the service reads, under
/// that name and as that kind. A field read as anything else (renamed, or of
/// the wrong kind) reads as absent and is missing from what is written back.
#[test]
fn every_client_example_reads_back_to_itself() {
    for (name, example) in client_examples() {
        let command = ClientMessage::parse(&example.to_string())
            .unwrap_or_else(|unreadable| panic!("example {name} is unreadable: {unreadable:?}"));
        let written = serde_json::to_value(&command).expect("a command serializes");
        assert_eq!(
            without_nulls(written),
            without_nulls(example),
            "example {name} does not read back to itself as {command:?}"
        );
    }
}

#[test]
fn every_client_message_type_has_an_example() {
    let known: BTreeSet<&str> = message_types::<ClientMessage>().iter().copied().collect();
    assert!(known.contains("hello") && known.contains("screen_state"));
    let examples = client_examples();
    let exemplified: BTreeSet<&str> = examples
        .iter()
        .filter_map(|(_, message)| message["type"].as_str())
        .collect();
    let missing: Vec<&str> = known.difference(&exemplified).copied().collect();
    assert!(
        missing.is_empty(),
        "these command types have no example in client-messages.json: {missing:?}"
    );
}

/// `parse` answers every error from the enum as an unknown type, which is
/// right only while every field is lenient: a variant that gained a required
/// field would refuse a frame of a known type as unknown.
#[test]
fn every_known_command_type_reads_with_no_other_field() {
    for kind in message_types::<ClientMessage>() {
        let frame = json!({ "type": kind }).to_string();
        assert!(
            ClientMessage::parse(&frame).is_ok(),
            "{frame} is unreadable"
        );
    }
}

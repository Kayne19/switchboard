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

/// Every `type` a `ServerMessage` can be sent as, as serde itself knows them.
///
/// Asked to read a tag it does not know, serde reports the whole list of
/// variants through `serde::de::Error::unknown_variant`. This error type keeps
/// that list rather than formatting it into a message, so the list cannot fall
/// behind the enum.
fn message_types() -> &'static [&'static str] {
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
    match ServerMessage::deserialize(probe) {
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
    let known: BTreeSet<&str> = message_types().iter().copied().collect();
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
    coordinator.adopt_candidate().unwrap();
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
    coordinator.adopt_candidate().unwrap();
    assert_eq!(
        published(&coordinator),
        example("status_project_without_a_catalog")
    );
}

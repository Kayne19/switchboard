use super::*;
use serde_json::json;

/// A host's `list_models` reply: the same models the old table listed.
fn listing() -> ModelCatalog {
    ModelCatalog::from_host_models(&json!({"models": [
        {"provider": "anthropic", "id": "claude-opus-5", "name": "Claude Opus 5", "reasoning": true},
        {"provider": "anthropic", "id": "claude-sonnet-5", "name": "Claude Sonnet 5", "reasoning": true},
        {"provider": "openai", "id": "claude-sonnet-5", "name": "Sonnet via OpenAI", "reasoning": true},
        {"provider": "groq", "id": "llama-4-fast", "name": "Llama 4 Fast", "reasoning": false},
    ]}))
}

#[test]
fn parses_and_normalizes_specs() {
    assert_eq!(
        parse_spec("anthropic/claude-opus-5:high"),
        ("anthropic".into(), "claude-opus-5".into(), "high".into())
    );
    assert_eq!(parse_spec("  "), ("".into(), "".into(), "".into()));
}

#[test]
fn catalog_exposes_provider_models_with_decimal_and_short_names() {
    let catalog = ModelCatalog::from_host_models(&json!({"models": [
        {"provider": "openai", "id": "gpt-5.6", "name": "GPT 5.6", "reasoning": true},
        {"provider": "moonshot", "id": "luna", "name": "Luna", "reasoning": true},
        {"provider": "openai", "id": "sol", "name": "Sol", "reasoning": false},
    ]}));
    assert_eq!(catalog.entries.len(), 3);
    assert_eq!(
        catalog.resolve("GPT 5.6", "").unwrap().spec(),
        "openai/gpt-5.6"
    );
    assert_eq!(
        catalog.resolve("moonshot/luna", "high").unwrap().spec(),
        "moonshot/luna:high"
    );
    assert_eq!(
        catalog.resolve("openai/sol", "").unwrap().spec(),
        "openai/sol"
    );
    assert!(catalog.resolve("openai/sol", "high").is_err());
}

#[test]
fn resolves_digits_and_rejects_ambiguity() {
    let catalog = listing();
    assert_eq!(
        catalog.resolve("opus five", "").unwrap().spec(),
        "anthropic/claude-opus-5"
    );
    assert!(catalog
        .resolve("sonnet 5", "")
        .unwrap_err()
        .to_string()
        .contains("openai/claude-sonnet-5"));
    assert_eq!(
        catalog.resolve("groq/llama 4 fast", "").unwrap().spec(),
        "groq/llama-4-fast"
    );
}

#[test]
fn validates_thinking_and_pins_specs() {
    assert_eq!(
        normalize_thinking("set thinking to medium").unwrap(),
        "medium"
    );
    assert_eq!(normalize_thinking("maximum").unwrap(), "max");
    assert_eq!(normalize_thinking("no thinking").unwrap(), "off");
    assert_eq!(normalize_thinking("without thinking").unwrap(), "off");
    assert_eq!(
        normalize_thinking("thinking level x high").unwrap(),
        "xhigh"
    );
    assert!(normalize_thinking("ludicrous").is_err());
    assert_eq!(
        pin_thinking("anthropic/opus", "medium"),
        "anthropic/opus:medium"
    );
    assert_eq!(
        pin_thinking("anthropic/opus:max", "medium"),
        "anthropic/opus:max"
    );
}

#[test]
fn valid_empty_catalog_rejects_unlisted_models() {
    let catalog = ModelCatalog {
        entries: vec![],
        available: true,
        diagnostic: None,
    };
    assert!(catalog.resolve("opus five", "").is_err());
    assert!(catalog.resolve("anthropic/opus", "high").is_err());
}

#[test]
fn malformed_or_empty_listings_are_unavailable() {
    for listing in [
        json!({}),
        json!({"models": []}),
        json!({"models": [{"provider": "anthropic"}]}),
        json!({"models": [{"provider": " ", "id": "opus"}]}),
    ] {
        let catalog = ModelCatalog::from_host_models(&listing);
        assert!(!catalog.available, "{listing}");
        assert!(catalog.diagnostic.is_some(), "{listing}");
    }
}

#[test]
fn unavailable_catalog_passes_through_qualified_models_and_suffixes() {
    let catalog = ModelCatalog::unavailable("host not connected");
    assert!(!catalog.available);
    assert_eq!(catalog.diagnostic.as_deref(), Some("host not connected"));
    assert_eq!(
        catalog
            .resolve("anthropic/opus:thinking level x high", "")
            .unwrap()
            .spec(),
        "anthropic/opus:xhigh"
    );
    assert_eq!(
        catalog.resolve("openai/gpt-5.6", "medium").unwrap().spec(),
        "openai/gpt-5.6:medium"
    );
    assert!(catalog
        .resolve("opus", "")
        .unwrap_err()
        .to_string()
        .contains("host not connected"));
}

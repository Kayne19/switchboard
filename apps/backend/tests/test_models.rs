use super::*;

const TABLE: &str = "provider model context max-out thinking images\nanthropic claude-opus-5 1M 128K yes yes\nanthropic claude-sonnet-5 1M 128K yes yes\nopenai claude-sonnet-5 1M 128K yes yes\ngroq llama-4-fast 128K 8K no no\n";

#[test]
fn parses_and_normalizes_specs() {
    assert_eq!(
        parse_spec("anthropic/claude-opus-5:high"),
        ("anthropic".into(), "claude-opus-5".into(), "high".into())
    );
    assert_eq!(parse_spec("  "), ("".into(), "".into(), "".into()));
}

#[test]
fn catalog_key_identity_ignores_launch_only_args() {
    use crate::registry::Project;
    let mut proj1 = Project {
        id: "proj1".into(),
        description: String::new(),
        aliases: Vec::new(),
        host: Some(" host.example.com ".into()),
        cwd: "/tmp/dir1".into(),
        runtime: "pi".into(),
        model: None,
        stage_extension: true,
        extra_args: vec!["--arg1".into()],
        prepare: String::new(),
    };
    let proj2 = Project {
        id: "proj2".into(),
        description: String::new(),
        aliases: Vec::new(),
        host: Some("host.example.com".into()),
        cwd: "/tmp/dir2".into(),
        runtime: "pi".into(),
        model: None,
        stage_extension: true,
        extra_args: vec!["--arg2".into()],
        prepare: String::new(),
    };

    let key1 = CatalogKey::for_project(&proj1);
    let key2 = CatalogKey::for_project(&proj2);
    assert_eq!(key1, key2);

    proj1.runtime = "custom-pi".into();
    let key3 = CatalogKey::for_project(&proj1);
    assert_ne!(key1, key3);
}

#[test]
fn catalog_exposes_provider_models_with_decimal_and_short_names() {
    let catalog = ModelCatalog::parse(
        "provider model context max-out thinking images\nopenai gpt-5.6 1M 128K yes yes\nmoonshot luna 1M 128K yes yes\nopenai sol 1M 128K no no\n",
    );
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
    let catalog = ModelCatalog::parse(TABLE);
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
fn malformed_catalog_is_unavailable() {
    let catalog = ModelCatalog::parse("provider model\nanthropic");
    assert!(!catalog.available);
    assert!(catalog.diagnostic.is_some());
}

#[test]
fn unavailable_catalog_passes_through_qualified_models_and_suffixes() {
    let catalog = ModelCatalog::unavailable("ssh failed");
    assert!(!catalog.available);
    assert_eq!(catalog.diagnostic.as_deref(), Some("ssh failed"));
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
        .contains("ssh failed"));
}

#[tokio::test]
async fn catalog_command_success_and_failure_are_degraded_safely() {
    let table = "printf 'provider model context max-out thinking images\\nanthropic opus 1M 128K yes yes\\n'";
    let catalog = fetch_catalog(&["sh".into(), "-c".into(), table.into()]).await;
    assert_eq!(catalog.entries.len(), 1);
    assert_eq!(catalog.entries[0].provider, "anthropic");

    let failed =
        fetch_catalog(&["sh".into(), "-c".into(), "printf broken >&2; exit 9".into()]).await;
    assert!(failed.entries.is_empty());
    assert!(!failed.available);
    assert!(failed.diagnostic.is_some());
}

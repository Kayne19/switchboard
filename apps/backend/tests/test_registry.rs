use super::*;
use std::io::Write;

fn project(id: &str, aliases: &[&str]) -> Project {
    Project {
        id: id.into(),
        aliases: aliases.iter().map(|s| (*s).into()).collect(),
        ..Project::default_for_test()
    }
}

impl Project {
    fn default_for_test() -> Self {
        Self {
            id: String::new(),
            description: String::new(),
            aliases: Vec::new(),
            host: None,
            cwd: String::new(),
            runtime: "pi".into(),
            model: None,
            stage_extension: true,
            extra_args: Vec::new(),
            prepare: String::new(),
        }
    }
}

#[test]
fn resolves_forgiving_spoken_phrases_and_refuses_ambiguity() {
    let registry = Registry::new(vec![
        project("grape-segmentation", &["grapes", "grape segmentation"]),
        project("ledger", &["accounts"]),
    ]);
    assert_eq!(
        registry
            .resolve("Put me in the GRAPE segmentation project")
            .unwrap()
            .id,
        "grape-segmentation"
    );
    assert!(registry.resolve("tomato").is_none());
    let ambiguous = Registry::new(vec![
        project("alpha", &["the thing"]),
        project("beta", &["the other"]),
    ]);
    assert!(ambiguous.resolve("the").is_none());
}

#[test]
fn malformed_or_missing_registry_is_empty() {
    let path = std::env::temp_dir().join(format!("switchboard-registry-{}", std::process::id()));
    let mut file = fs::File::create(&path).unwrap();
    write!(
        file,
        r#"{{"projects":[{{"id":"ok"}},{{"no_id":true}},"bad"]}}"#
    )
    .unwrap();
    let registry = Registry::load(&path);
    let _ = fs::remove_file(path);
    assert_eq!(registry.projects.len(), 1);
    assert!(Registry::load("/no/such/projects.json").projects.is_empty());
}

#[test]
fn blank_optional_values_use_the_registry_defaults() {
    let registry = Registry::new(vec![Project {
        id: "local".into(),
        host: Some("  ".into()),
        runtime: String::new(),
        model: Some(String::new()),
        ..Project::default_for_test()
    }]);
    let project = &registry.projects[0];
    assert_eq!(project.host, None);
    assert_eq!(project.runtime, "pi");
    assert_eq!(project.model, None);
    assert_eq!(project.public()["location"], "damocles:");
}

#[test]
fn host_canonicalization_and_descriptions_never_resolve() {
    let mut proj = project("alpha", &["a"]);
    proj.description = "secret alpha project".into();
    proj.host = Some("  host-one  ".into());

    let registry = Registry::new(vec![proj]);
    assert_eq!(registry.projects[0].host.as_deref(), Some("host-one"));
    assert_eq!(registry.projects[0].canonical_host(), Some("host-one"));
    assert!(registry.resolve("secret").is_none());
    assert!(registry.resolve("unknown key").is_none());
}

#[test]
fn duplicate_and_overlapping_keys_are_ambiguous() {
    let registry = Registry::new(vec![
        project("proj-a", &["shared-alias"]),
        project("proj-b", &["shared-alias"]),
    ]);
    assert!(registry.resolve("shared-alias").is_none());
    assert_eq!(
        registry.resolve_detailed("shared-alias"),
        ResolveResult::Ambiguous(vec!["proj-a".into(), "proj-b".into()])
    );

    let overlapping = Registry::new(vec![
        project("apple-pie", &["pie"]),
        project("apple-tart", &["tart"]),
    ]);
    assert!(overlapping.resolve("apple").is_none());
    assert_eq!(
        overlapping.resolve_detailed("apple"),
        ResolveResult::Ambiguous(vec!["apple-pie".into(), "apple-tart".into()])
    );
}

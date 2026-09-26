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

/// The project a phrase names outright, if it names exactly one.
fn exact<'a>(registry: &'a Registry, spoken: &str) -> Option<&'a Project> {
    match registry.resolve_detailed(spoken) {
        ResolveResult::Exact(project) => Some(project),
        _ => None,
    }
}

#[test]
fn resolves_forgiving_spoken_phrases_and_refuses_ambiguity() {
    let registry = Registry::new(vec![
        project("grape-segmentation", &["grapes", "grape segmentation"]),
        project("ledger", &["accounts"]),
    ]);
    assert_eq!(
        exact(&registry, "Put me in the GRAPE segmentation project")
            .unwrap()
            .id,
        "grape-segmentation"
    );
    assert!(exact(&registry, "tomato").is_none());
    let ambiguous = Registry::new(vec![
        project("alpha", &["the thing"]),
        project("beta", &["the other"]),
    ]);
    assert!(exact(&ambiguous, "the").is_none());
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
    assert!(!project.is_remote());
}

#[test]
fn host_canonicalization_and_descriptions_never_resolve() {
    let mut proj = project("alpha", &["a"]);
    proj.description = "secret alpha project".into();
    proj.host = Some("  host-one  ".into());

    let registry = Registry::new(vec![proj]);
    assert_eq!(registry.projects[0].host.as_deref(), Some("host-one"));
    assert_eq!(registry.projects[0].canonical_host(), Some("host-one"));
    assert!(exact(&registry, "secret").is_none());
    assert!(exact(&registry, "unknown key").is_none());
}

#[test]
fn operator_prompt_catalog_contains_transfer_targets() {
    let mut alpha = project("alpha", &["a"]);
    alpha.description = "Alpha project".into();
    alpha.host = Some("scriptorium".into());
    alpha.cwd = "/srv/alpha".into();
    let prompt = Registry::new(vec![alpha]).operator_prompt_catalog();
    assert!(prompt.contains("alpha (also: a)"));
    assert!(prompt.contains("Alpha project [scriptorium:/srv/alpha]"));
}

#[test]
fn duplicate_and_overlapping_keys_are_ambiguous() {
    let registry = Registry::new(vec![
        project("proj-a", &["shared-alias"]),
        project("proj-b", &["shared-alias"]),
    ]);
    assert!(exact(&registry, "shared-alias").is_none());
    assert_eq!(
        registry.resolve_detailed("shared-alias"),
        ResolveResult::Ambiguous(vec!["proj-a".into(), "proj-b".into()])
    );

    let overlapping = Registry::new(vec![
        project("apple-pie", &["pie"]),
        project("apple-tart", &["tart"]),
    ]);
    assert!(exact(&overlapping, "apple").is_none());
    assert_eq!(
        overlapping.resolve_detailed("apple"),
        ResolveResult::Ambiguous(vec!["apple-pie".into(), "apple-tart".into()])
    );
}

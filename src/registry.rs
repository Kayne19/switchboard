use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Project {
    pub id: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub cwd: String,
    #[serde(default = "default_runtime")]
    pub runtime: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default = "default_stage_extension")]
    pub stage_extension: bool,
    #[serde(default)]
    pub extra_args: Vec<String>,
    #[serde(default)]
    pub prepare: String,
}

/// Every key a registry entry may carry. Kept beside the struct because serde
/// silently drops anything else, and a dropped key is a project that quietly
/// does the wrong thing.
const PROJECT_FIELDS: [&str; 10] = [
    "id",
    "description",
    "aliases",
    "host",
    "cwd",
    "runtime",
    "model",
    "stage_extension",
    "extra_args",
    "prepare",
];

fn default_runtime() -> String {
    "pi".to_owned()
}
fn default_stage_extension() -> bool {
    true
}

impl Project {
    pub fn canonical_host(&self) -> Option<&str> {
        self.host
            .as_deref()
            .map(str::trim)
            .filter(|host| !host.is_empty())
    }

    pub fn is_remote(&self) -> bool {
        self.canonical_host().is_some()
    }

    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "description": self.description,
            "aliases": self.aliases,
            "location": format!("{}:{}", self.canonical_host().unwrap_or("damocles"), self.cwd),
        })
    }
}

#[derive(Debug, PartialEq)]
pub enum ResolveResult<'a> {
    Exact(&'a Project),
    Ambiguous(Vec<String>),
    Unknown,
}

#[derive(Clone, Debug)]
pub struct Registry {
    pub projects: Vec<Project>,
    by_key: HashMap<String, Vec<usize>>,
}

fn normalize(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

impl Registry {
    pub fn new(mut projects: Vec<Project>) -> Self {
        for project in &mut projects {
            if project.runtime.trim().is_empty() {
                project.runtime = default_runtime();
            }
            if let Some(host) = &project.host {
                let trimmed = host.trim();
                if trimmed.is_empty() {
                    project.host = None;
                } else {
                    project.host = Some(trimmed.to_string());
                }
            }
            if project
                .model
                .as_ref()
                .is_some_and(|model| model.trim().is_empty())
            {
                project.model = None;
            }
        }
        let mut by_key: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, project) in projects.iter().enumerate() {
            for key in std::iter::once(project.id.as_str())
                .chain(project.aliases.iter().map(String::as_str))
            {
                let normalized = normalize(key);
                if normalized.is_empty() {
                    continue;
                }
                let indices = by_key.entry(normalized).or_default();
                if !indices.contains(&index) {
                    if !indices.is_empty() {
                        tracing::warn!(
                            alias = key,
                            first = %projects[indices[0]].id,
                            duplicate = %project.id,
                            "alias maps to multiple projects; resolution will be ambiguous"
                        );
                    }
                    indices.push(index);
                }
            }
        }
        Self { projects, by_key }
    }

    pub fn load(path: impl AsRef<Path>) -> Self {
        let path = path.as_ref();
        let raw = match fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(
                    path = %path.display(),
                    %error,
                    "no project registry; the operator has nowhere to send anyone"
                );
                return Self::new(Vec::new());
            }
        };
        let value: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(error) => {
                tracing::error!(
                    path = %path.display(),
                    %error,
                    "could not parse the project registry; the operator has nowhere to send anyone"
                );
                return Self::new(Vec::new());
            }
        };
        let entries = value.get("projects").cloned().unwrap_or(value);
        let entries = match entries.as_array() {
            Some(entries) => entries,
            None => {
                tracing::error!(
                    path = %path.display(),
                    "the project registry is neither a list nor an object with a projects list"
                );
                return Self::new(Vec::new());
            }
        };
        let projects: Vec<Project> = entries.iter().filter_map(Self::parse_entry).collect();
        tracing::info!(
            path = %path.display(),
            count = projects.len(),
            projects = %projects.iter().map(|project| project.id.as_str()).collect::<Vec<_>>().join(", "),
            "loaded the project registry"
        );
        Self::new(projects)
    }

    /// Parse one registry entry, reporting why it was dropped rather than
    /// letting a deployment discover a missing project by placing a call.
    fn parse_entry(entry: &serde_json::Value) -> Option<Project> {
        let project = match serde_json::from_value::<Project>(entry.clone()) {
            Ok(project) => project,
            Err(error) => {
                tracing::warn!(
                    %error,
                    entry_kind = if entry.is_object() { "object" } else { "other" },
                    "skipping malformed registry entry"
                );
                return None;
            }
        };
        if project.id.trim().is_empty() {
            tracing::warn!(
                entry_kind = if entry.is_object() { "object" } else { "other" },
                "skipping registry entry with a blank id"
            );
            return None;
        }
        // Serde ignores unknown fields, so a template that renders `working_dir`
        // instead of `cwd` produces a project that runs in the wrong directory
        // and reports nothing. Name the keys that had no effect.
        if let Some(object) = entry.as_object() {
            let unknown: Vec<&str> = object
                .keys()
                .map(String::as_str)
                .filter(|key| !PROJECT_FIELDS.contains(key))
                .collect();
            if !unknown.is_empty() {
                tracing::warn!(
                    project = %project.id,
                    unknown = %unknown.join(", "),
                    "registry entry has keys the switchboard does not understand"
                );
            }
        }
        Some(project)
    }

    pub fn resolve_detailed(&self, spoken: &str) -> ResolveResult<'_> {
        let phrase = normalize(spoken);
        if phrase.is_empty() {
            return ResolveResult::Unknown;
        }
        if let Some(indexes) = self.by_key.get(&phrase) {
            if indexes.len() == 1 {
                return ResolveResult::Exact(&self.projects[indexes[0]]);
            }
            let mut candidates = indexes
                .iter()
                .filter_map(|&index| self.projects.get(index))
                .map(|project| project.id.clone())
                .collect::<Vec<_>>();
            candidates.sort();
            let candidates_str = candidates.join(", ");
            tracing::info!(chars = spoken.chars().count(), candidates = %candidates_str, "ambiguous exact project key");
            return ResolveResult::Ambiguous(candidates);
        }
        let mut matches = Vec::new();
        for (key, indexes) in &self.by_key {
            if key.contains(&phrase) || phrase.contains(key) {
                for &index in indexes {
                    if !matches.contains(&index) {
                        matches.push(index);
                    }
                }
            }
        }
        match matches.len() {
            1 => ResolveResult::Exact(&self.projects[matches[0]]),
            0 => {
                tracing::info!(
                    chars = spoken.chars().count(),
                    "no project matched the spoken phrase"
                );
                ResolveResult::Unknown
            }
            _ => {
                let mut candidates = matches
                    .iter()
                    .filter_map(|index| self.projects.get(*index))
                    .map(|project| project.id.clone())
                    .collect::<Vec<_>>();
                candidates.sort();
                let candidates_str = candidates.join(", ");
                tracing::info!(chars = spoken.chars().count(), candidates = %candidates_str, "ambiguous project phrase");
                ResolveResult::Ambiguous(candidates)
            }
        }
    }

    pub fn resolve(&self, spoken: &str) -> Option<&Project> {
        match self.resolve_detailed(spoken) {
            ResolveResult::Exact(project) => Some(project),
            _ => None,
        }
    }

    pub fn catalog(&self) -> Vec<serde_json::Value> {
        self.projects.iter().map(Project::public).collect()
    }

    pub fn ids(&self) -> Vec<String> {
        self.projects
            .iter()
            .map(|project| project.id.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
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
        let path =
            std::env::temp_dir().join(format!("switchboard-registry-{}", std::process::id()));
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
}

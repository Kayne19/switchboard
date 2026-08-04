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

fn default_runtime() -> String {
    "pi".to_owned()
}
fn default_stage_extension() -> bool {
    true
}

impl Project {
    pub fn is_remote(&self) -> bool {
        self.host.as_ref().is_some_and(|host| !host.is_empty())
    }

    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "description": self.description,
            "aliases": self.aliases,
            "location": format!("{}:{}", self.host.as_deref().unwrap_or("damocles"), self.cwd),
        })
    }
}

#[derive(Clone, Debug)]
pub struct Registry {
    pub projects: Vec<Project>,
    by_key: HashMap<String, usize>,
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
    pub fn new(projects: Vec<Project>) -> Self {
        let mut by_key = HashMap::new();
        for (index, project) in projects.iter().enumerate() {
            for key in std::iter::once(project.id.as_str())
                .chain(project.aliases.iter().map(String::as_str))
            {
                let key = normalize(key);
                if !key.is_empty() {
                    by_key.entry(key).or_insert(index);
                }
            }
        }
        Self { projects, by_key }
    }

    pub fn load(path: impl AsRef<Path>) -> Self {
        let raw = match fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(_) => return Self::new(Vec::new()),
        };
        let value: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(_) => return Self::new(Vec::new()),
        };
        let entries = value.get("projects").cloned().unwrap_or(value);
        let entries = match entries.as_array() {
            Some(entries) => entries,
            None => return Self::new(Vec::new()),
        };
        let projects = entries
            .iter()
            .filter_map(|entry| serde_json::from_value::<Project>(entry.clone()).ok())
            .filter(|project| !project.id.trim().is_empty())
            .collect();
        Self::new(projects)
    }

    pub fn resolve(&self, spoken: &str) -> Option<&Project> {
        let phrase = normalize(spoken);
        if phrase.is_empty() {
            return None;
        }
        if let Some(index) = self.by_key.get(&phrase) {
            return self.projects.get(*index);
        }
        let mut matches = Vec::new();
        for (key, index) in &self.by_key {
            if (key.contains(&phrase) || phrase.contains(key)) && !matches.contains(index) {
                matches.push(*index);
            }
        }
        if matches.len() == 1 {
            self.projects.get(matches[0])
        } else {
            None
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
}

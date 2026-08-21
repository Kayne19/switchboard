use std::fmt;
use std::process::Stdio;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

pub const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const CATALOG_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
const CATALOG_ERROR_LIMIT: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelChoice {
    pub provider: String,
    pub model: String,
    pub thinking: String,
}

impl ModelChoice {
    pub fn spec(&self) -> String {
        let base = if self.provider.is_empty() {
            self.model.clone()
        } else {
            format!("{}/{}", self.provider, self.model)
        };
        if base.is_empty() {
            return base;
        }
        if self.thinking.is_empty() {
            base
        } else {
            format!("{}:{}", base, self.thinking)
        }
    }
    pub fn spoken(&self) -> String {
        format!(
            "{}{}{}",
            self.model,
            if self.provider.is_empty() {
                String::new()
            } else {
                format!(" on {}", self.provider)
            },
            if self.thinking.is_empty() {
                String::new()
            } else {
                format!(", thinking {}", self.thinking)
            }
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct CatalogKey {
    pub host: Option<String>,
    pub runtime: String,
    pub list_argv: Vec<String>,
}

impl CatalogKey {
    pub fn for_project(project: &crate::registry::Project) -> Self {
        let host = project.canonical_host().map(String::from);
        let runtime = if project.runtime.trim().is_empty() {
            "pi".to_string()
        } else {
            project.runtime.trim().to_string()
        };
        let list_argv = vec![runtime.clone(), "--list-models".to_string()];
        Self {
            host,
            runtime,
            list_argv,
        }
    }

    pub fn to_key_string(&self) -> String {
        format!("{}:{}", self.host.as_deref().unwrap_or(""), self.runtime)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogSpec {
    pub key: CatalogKey,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogEntry {
    pub provider: String,
    pub model: String,
    pub thinks: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelCatalog {
    pub entries: Vec<CatalogEntry>,
    pub available: bool,
    pub diagnostic: Option<String>,
}
impl ModelCatalog {
    fn unavailable(diagnostic: impl Into<String>) -> Self {
        Self {
            entries: Vec::new(),
            available: false,
            diagnostic: Some(diagnostic.into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelError(pub String);
impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ModelError {}

const NUMBER_WORDS: [(&str, &str); 11] = [
    ("zero", "0"),
    ("one", "1"),
    ("two", "2"),
    ("three", "3"),
    ("four", "4"),
    ("five", "5"),
    ("six", "6"),
    ("seven", "7"),
    ("eight", "8"),
    ("nine", "9"),
    ("ten", "10"),
];

fn normalize(text: &str) -> String {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| {
            let word = word.to_ascii_lowercase();
            NUMBER_WORDS
                .iter()
                .find(|(spoken, _)| *spoken == word)
                .map_or(word, |(_, digit)| (*digit).to_owned())
        })
        .collect()
}

pub fn parse_spec(text: &str) -> (String, String, String) {
    let raw = text.trim();
    if raw.is_empty() {
        return (String::new(), String::new(), String::new());
    }
    let (base, thinking) = raw
        .split_once(':')
        .map_or((raw, ""), |(base, thinking)| (base, thinking.trim()));
    let (provider, model) = base
        .split_once('/')
        .map_or(("", base), |(provider, model)| {
            (provider.trim(), model.trim())
        });
    (provider.to_owned(), model.to_owned(), thinking.to_owned())
}

fn thinking_alias(value: &str) -> Option<&'static str> {
    match value {
        "none" | "no thinking" | "without thinking" => Some("off"),
        "lowest" | "min" => Some("minimal"),
        "mid" | "normal" => Some("medium"),
        "extra high" | "x high" | "very high" => Some("xhigh"),
        "maximum" | "highest" => Some("max"),
        "default" => Some(""),
        _ => None,
    }
}

pub fn normalize_thinking(text: &str) -> Result<String, ModelError> {
    let level = text
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphabetic() || c == ' ' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if level.is_empty() {
        return Ok(String::new());
    }
    if let Some(alias) = thinking_alias(&level) {
        return Ok(alias.to_owned());
    }
    if THINKING_LEVELS.contains(&level.as_str()) {
        return Ok(level);
    }

    let filtered = level
        .split_whitespace()
        .filter(|word| !["reasoning", "thinking", "effort", "level", "set", "to"].contains(word))
        .collect::<Vec<_>>()
        .join(" ");
    let collapsed = filtered.replace(' ', "");
    if let Some(alias) = thinking_alias(&filtered) {
        return Ok(alias.to_owned());
    }
    if THINKING_LEVELS.contains(&collapsed.as_str()) {
        return Ok(collapsed);
    }
    Err(ModelError(format!(
        "{text:?} is not a thinking level. The levels are {}.",
        THINKING_LEVELS.join(", ")
    )))
}

pub fn pin_thinking(spec: &str, level: &str) -> String {
    if spec.is_empty() || level.is_empty() {
        return spec.to_owned();
    }
    let (_, _, thinking) = parse_spec(spec);
    if !thinking.is_empty() {
        return spec.to_owned();
    }
    format!("{}:{}", spec, level)
}

impl ModelCatalog {
    pub fn parse(table: &str) -> Self {
        let mut lines = table.lines().filter(|line| !line.trim().is_empty());
        let Some(header) = lines.next() else {
            return Self::unavailable("model listing was empty");
        };
        let header = header.split_whitespace().collect::<Vec<_>>();
        if header.len() < 5 || header[0] != "provider" || header[1] != "model" {
            return Self::unavailable("model listing had an invalid header");
        }
        let mut entries = Vec::new();
        for line in lines {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 5 {
                return Self::unavailable("model listing had a malformed row");
            }
            entries.push(CatalogEntry {
                provider: fields[0].into(),
                model: fields[1].into(),
                thinks: fields[4] == "yes",
            });
        }
        Self {
            entries,
            available: true,
            diagnostic: None,
        }
    }

    pub fn resolve(&self, model: &str, thinking: &str) -> Result<ModelChoice, ModelError> {
        let (wanted_provider, wanted_model, spec_thinking) = parse_spec(model);
        let level = normalize_thinking(if thinking.trim().is_empty() {
            &spec_thinking
        } else {
            thinking
        })?;
        if wanted_model.is_empty() {
            return Err(ModelError("no model was named".into()));
        }
        if !self.available {
            // A provider-qualified spec is unambiguous even when discovery is
            // unavailable. Keep the deployment contract useful during a
            // transient SSH/listing failure, while refusing a bare name that
            // would require guessing the provider.
            if wanted_provider.is_empty() {
                return Err(ModelError(format!(
                    "I can't verify bare model names right now: {}",
                    self.diagnostic
                        .as_deref()
                        .unwrap_or("the model catalog is unavailable")
                )));
            }
            return Ok(ModelChoice {
                provider: wanted_provider,
                model: wanted_model,
                thinking: level,
            });
        }
        let key = normalize(&wanted_model);
        let pool = self
            .entries
            .iter()
            .filter(|entry| {
                wanted_provider.is_empty()
                    || normalize(&entry.provider) == normalize(&wanted_provider)
            })
            .collect::<Vec<_>>();
        if pool.is_empty() {
            let mut providers = self
                .entries
                .iter()
                .map(|entry| entry.provider.as_str())
                .collect::<Vec<_>>();
            providers.sort_unstable();
            providers.dedup();
            return Err(ModelError(format!(
                "there is no provider called {} here. I have {}.",
                wanted_provider,
                providers.join(", ")
            )));
        }
        let exact = pool
            .iter()
            .copied()
            .filter(|entry| normalize(&entry.model) == key)
            .collect::<Vec<_>>();
        let matches: Vec<&CatalogEntry> = if exact.is_empty() {
            pool.into_iter()
                .filter(|entry| normalize(&entry.model).contains(&key))
                .collect()
        } else {
            exact
        };
        if matches.is_empty() {
            return Err(ModelError(format!(
                "I don't have a model matching {}",
                wanted_model
            )));
        }
        let mut distinct = matches
            .iter()
            .map(|entry| (entry.provider.as_str(), entry.model.as_str()))
            .collect::<Vec<_>>();
        distinct.sort_unstable();
        distinct.dedup();
        if distinct.len() > 1 {
            let names = distinct
                .iter()
                .map(|(provider, model)| format!("{provider}/{model}"))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(ModelError(format!(
                "{} is ambiguous here. It could be {}. Which one?",
                wanted_model, names
            )));
        }
        let entry = matches[0];
        if !level.is_empty() && level != "off" && !entry.thinks {
            return Err(ModelError(format!(
                "{} has no thinking levels, so I can't set {}",
                entry.model, level
            )));
        }
        Ok(ModelChoice {
            provider: entry.provider.clone(),
            model: entry.model.clone(),
            thinking: level,
        })
    }
}

pub async fn fetch_catalog(argv: &[String]) -> ModelCatalog {
    let mut command = Command::new(argv.first().map(String::as_str).unwrap_or(""));
    command
        .args(argv.iter().skip(1))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::pi_client::isolate_process(&mut command);
    // An empty catalog is not an error the caller ever hears about — it just
    // narrows what models may be requested. Without these lines, "the model I
    // asked for was refused" and "listing models never worked on that host"
    // look identical from outside.
    let program = argv.first().map(String::as_str).unwrap_or("<missing>");
    let argc = argv.len();
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            tracing::warn!(%program, argc, %error, "could not list models");
            return ModelCatalog::unavailable(format!("could not run model listing: {error}"));
        }
    };
    let process_guard = crate::pi_client::ProcessTreeGuard::new(&child);
    let stdout_task = child.stdout.take().map(|mut output| {
        tokio::spawn(async move {
            crate::pi_client::drain_bounded(&mut output, CATALOG_OUTPUT_LIMIT).await
        })
    });
    let stderr_task = child.stderr.take().map(|mut output| {
        tokio::spawn(async move {
            crate::pi_client::drain_bounded(&mut output, CATALOG_ERROR_LIMIT).await
        })
    });
    let status = match timeout(LIST_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => {
            process_guard.disarm();
            status
        }
        outcome => {
            match outcome {
                Ok(Err(error)) => {
                    tracing::warn!(%program, argc, %error, "listing models failed")
                }
                _ => tracing::warn!(
                    %program,
                    argc,
                    timeout = ?LIST_TIMEOUT,
                    "listing models timed out"
                ),
            }
            crate::pi_client::terminate_process(&mut child).await;
            process_guard.disarm();
            if let Some(task) = stdout_task {
                task.abort();
            }
            if let Some(task) = stderr_task {
                task.abort();
            }
            return ModelCatalog::unavailable("model listing failed or timed out");
        }
    };
    let stdout = match stdout_task {
        Some(task) => task.await.unwrap_or_default(),
        None => crate::pi_client::BoundedOutput::default(),
    };
    if let Some(task) = stderr_task {
        let _ = task.await;
    }
    if !status.success() || stdout.truncated {
        return ModelCatalog::unavailable("model listing failed or exceeded its output limit");
    }
    let table = match String::from_utf8(stdout.bytes) {
        Ok(table) => table,
        Err(_) => return ModelCatalog::unavailable("model listing was not valid UTF-8"),
    };
    ModelCatalog::parse(&table)
}

#[cfg(test)]
#[path = "../tests/test_models.rs"]
mod tests;

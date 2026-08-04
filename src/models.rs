use std::fmt;
use std::process::Stdio;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

pub const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LIST_TIMEOUT: Duration = Duration::from_secs(30);

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogEntry {
    pub provider: String,
    pub model: String,
    pub thinks: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelCatalog {
    pub entries: Vec<CatalogEntry>,
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

pub fn normalize_thinking(text: &str) -> Result<String, ModelError> {
    let mut level = text
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphabetic() || c == ' ' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>();
    for word in ["reasoning", "thinking", "effort", "level", "set", "to"] {
        level = level.replace(word, " ");
    }
    let level = level.split_whitespace().collect::<Vec<_>>().join(" ");
    if level.is_empty() {
        return Ok(String::new());
    }
    let value = match level.as_str() {
        "none" | "no thinking" | "without thinking" => "off",
        "lowest" | "min" => "minimal",
        "mid" | "normal" => "medium",
        "extra high" | "x high" | "very high" => "xhigh",
        "maximum" | "highest" => "max",
        "default" => "",
        other if THINKING_LEVELS.contains(&other) => other,
        _ => {
            return Err(ModelError(format!(
                "{text:?} is not a thinking level. The levels are {}.",
                THINKING_LEVELS.join(", ")
            )))
        }
    };
    Ok(value.to_owned())
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
        let entries = table
            .lines()
            .filter_map(|line| {
                let fields = line.split_whitespace().collect::<Vec<_>>();
                if fields.len() < 5 || fields[0] == "provider" {
                    return None;
                }
                Some(CatalogEntry {
                    provider: fields[0].into(),
                    model: fields[1].into(),
                    thinks: fields[4] == "yes",
                })
            })
            .collect();
        Self { entries }
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
        if self.entries.is_empty() {
            if wanted_provider.is_empty() {
                return Err(ModelError(format!(
                    "I can't check which provider serves {}. Say it as provider slash model.",
                    wanted_model
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
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = match timeout(LIST_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        _ => {
            return ModelCatalog {
                entries: Vec::new(),
            }
        }
    };
    if !output.status.success() {
        return ModelCatalog {
            entries: Vec::new(),
        };
    }
    ModelCatalog::parse(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
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
    fn empty_catalog_only_accepts_qualified_models() {
        let catalog = ModelCatalog { entries: vec![] };
        assert!(catalog.resolve("opus five", "").is_err());
        assert_eq!(
            catalog.resolve("anthropic/opus", "high").unwrap().spec(),
            "anthropic/opus:high"
        );
    }
}

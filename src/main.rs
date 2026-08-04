pub mod api;
pub mod audio;
pub mod history;
pub mod models;
pub mod pbx;
pub mod pi_client;
pub mod registry;

use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub env_file: PathBuf,
    pub state_dir: PathBuf,
    pub config_dir: PathBuf,
    pub projects_file: PathBuf,
    pub operator_prompt: PathBuf,
    pub operator_extension: Option<String>,
    pub agent_extension: Option<String>,
    pub persona: String,
    pub stt_command: Option<String>,
    pub bind: String,
    pub pi_binary: String,
    pub operator_model: Option<String>,
    pub agent_model: Option<String>,
    pub agent_thinking: String,
    pub remote_cache_dir: String,
    pub model_swaps: bool,
    pub self_url: String,
    pub idle_timeout: f64,
    pub idle_poll: f64,
    pub max_spoken_chars: usize,
    pub history_limit: usize,
    pub session: String,
    pub speak_url: String,
    pub state_url: String,
    pub diagram_url: String,
    /// Environment values loaded from the deployment env file and inherited
    /// process environment. Project legs receive this plus their callback vars.
    pub environment: HashMap<String, String>,
}

impl Config {
    pub fn from_env() -> Self {
        let env_file = PathBuf::from(value(
            "SWITCHBOARD_ENV_FILE",
            "/etc/switchboard/switchboard.env",
        ));
        let mut values = load_env_file(&env_file);
        for (key, value) in env::vars() {
            values.insert(key, value);
        }
        Self::from_values(&values, env_file)
    }

    fn from_values(values: &HashMap<String, String>, env_file: PathBuf) -> Self {
        let config_dir = PathBuf::from(get(values, "SWITCHBOARD_CONFIG_DIR", "/etc/switchboard"));
        let state_dir = PathBuf::from(get(values, "SWITCHBOARD_STATE_DIR", "/var/lib/switchboard"));
        let projects_file = PathBuf::from(get(
            values,
            "SWITCHBOARD_PROJECTS_FILE",
            &config_dir.join("projects.json").to_string_lossy(),
        ));
        let operator_prompt = PathBuf::from(get(
            values,
            "SWITCHBOARD_OPERATOR_PROMPT",
            &config_dir.join("operator.system.md").to_string_lossy(),
        ));
        Self {
            env_file,
            state_dir,
            config_dir,
            projects_file,
            operator_prompt,
            operator_extension: optional(values, "SWITCHBOARD_OPERATOR_EXTENSION"),
            agent_extension: optional(values, "SWITCHBOARD_AGENT_EXTENSION"),
            persona: get(values, "SWITCHBOARD_PERSONA", ""),
            stt_command: optional(values, "SWITCHBOARD_STT_COMMAND"),
            bind: get(values, "SWITCHBOARD_BIND", "0.0.0.0:8765"),
            pi_binary: get(values, "SWITCHBOARD_PI_BINARY", "pi"),
            operator_model: optional(values, "SWITCHBOARD_OPERATOR_MODEL"),
            agent_model: optional(values, "SWITCHBOARD_AGENT_MODEL"),
            agent_thinking: get(values, "SWITCHBOARD_AGENT_THINKING", "medium"),
            remote_cache_dir: get(values, "SWITCHBOARD_REMOTE_CACHE_DIR", ".cache/switchboard"),
            model_swaps: !matches!(
                get(values, "SWITCHBOARD_MODEL_SWAPS", "1")
                    .to_ascii_lowercase()
                    .as_str(),
                "0" | "false" | "no"
            ),
            self_url: get(values, "SWITCHBOARD_SELF_URL", "")
                .trim_end_matches('/')
                .to_owned(),
            idle_timeout: number(values, "SWITCHBOARD_IDLE_TIMEOUT", 3600.0),
            idle_poll: number(values, "SWITCHBOARD_IDLE_POLL", 30.0),
            max_spoken_chars: number(values, "SWITCHBOARD_MAX_SPOKEN_CHARS", 700.0) as usize,
            history_limit: number(values, "SWITCHBOARD_HISTORY_LIMIT", 200.0) as usize,
            session: get(values, "SWITCHBOARD_SESSION", ""),
            speak_url: get(values, "SWITCHBOARD_SPEAK_URL", ""),
            state_url: get(values, "SWITCHBOARD_STATE_URL", ""),
            diagram_url: get(values, "SWITCHBOARD_DIAGRAM_URL", ""),
            environment: values.clone(),
        }
    }
}

fn get(values: &HashMap<String, String>, name: &str, default: &str) -> String {
    values
        .get(name)
        .map(String::as_str)
        .unwrap_or(default)
        .trim()
        .to_owned()
}
fn optional(values: &HashMap<String, String>, name: &str) -> Option<String> {
    let value = get(values, name, "");
    (!value.is_empty()).then_some(value)
}
fn number(values: &HashMap<String, String>, name: &str, default: f64) -> f64 {
    values
        .get(name)
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}

fn load_env_file(path: &PathBuf) -> HashMap<String, String> {
    let mut result = HashMap::new();
    let Ok(contents) = fs::read_to_string(path) else {
        return result;
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        let name = name.trim();
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
        result.insert(name.to_owned(), value.to_owned());
    }
    result
}

fn value(name: &str, default: &str) -> String {
    env::var(name)
        .unwrap_or_else(|_| default.to_owned())
        .trim()
        .to_owned()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let config = Config::from_env();
    let registry = registry::Registry::load(&config.projects_file);
    let callback_url = |configured: &str, path: &str| {
        if configured.is_empty() && !config.self_url.is_empty() {
            format!("{}/{path}", config.self_url)
        } else {
            configured.to_owned()
        }
    };
    let board = pbx::Switchboard::new(
        registry,
        config.pi_binary.clone(),
        config.operator_model.clone(),
        config.operator_prompt.to_string_lossy().into_owned(),
        config.operator_extension.clone(),
        config.agent_extension.clone(),
        config.agent_model.clone(),
        config.agent_thinking.clone(),
        config.remote_cache_dir.clone(),
        config.model_swaps,
        callback_url(&config.speak_url, "speak"),
        callback_url(&config.state_url, "leg-state"),
        callback_url(&config.diagram_url, "diagram"),
        config.persona.clone(),
        config.environment.clone(),
    );
    let state = api::AppState::new(
        board,
        history::TranscriptLog::new(config.history_limit),
        audio::Speaker::from_values(config.max_spoken_chars, &config.environment),
        audio::SttAdapter::from_command(config.stt_command.clone()),
    );
    api::spawn_workers(state.clone());
    api::spawn_idle_worker(state.clone(), config.idle_timeout, config.idle_poll);
    let bind = config.bind.clone();
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .expect("bind switchboard listener");
    tracing::info!(%bind, "switchboard listening");
    if let Err(error) = axum::serve(
        listener,
        state.router(Some(tower_http::services::ServeDir::new("static"))),
    )
    .await
    {
        tracing::error!(%error, "switchboard server stopped");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_switchboard_names_and_defaults() {
        let values = HashMap::from([
            ("SWITCHBOARD_CONFIG_DIR".into(), "/tmp/switchboard".into()),
            ("SWITCHBOARD_MODEL_SWAPS".into(), "false".into()),
            (
                "SWITCHBOARD_SELF_URL".into(),
                "http://localhost:8765/".into(),
            ),
            ("SWITCHBOARD_HISTORY_LIMIT".into(), "12".into()),
        ]);
        let config = Config::from_values(&values, PathBuf::from("/tmp/env"));
        assert_eq!(
            config.projects_file,
            PathBuf::from("/tmp/switchboard/projects.json")
        );
        assert!(!config.model_swaps);
        assert_eq!(config.self_url, "http://localhost:8765");
        assert_eq!(config.history_limit, 12);
    }

    #[test]
    fn env_file_parser_keeps_audio_secrets_available() {
        let path = std::env::temp_dir().join(format!("switchboard-env-{}", std::process::id()));
        fs::write(
            &path,
            "ELEVENLABS_API_KEY='secret'\nSWITCHBOARD_PI_BINARY='pi-custom'\n",
        )
        .unwrap();
        let values = load_env_file(&path);
        let _ = fs::remove_file(path);
        assert_eq!(
            values.get("SWITCHBOARD_PI_BINARY"),
            Some(&"pi-custom".to_owned())
        );
        assert_eq!(values.get("ELEVENLABS_API_KEY"), Some(&"secret".to_owned()));
    }
}

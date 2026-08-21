pub mod api;
pub mod audio;
pub mod diagnostic;
pub mod history;
pub mod lifecycle;
pub mod models;
pub mod pbx;
pub mod pi_client;
pub mod prewarm;
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
    pub stt_stream_command: Option<String>,
    pub bind: String,
    pub pi_binary: String,
    pub ssh_program: String,
    pub operator_model: Option<String>,
    pub agent_model: Option<String>,
    pub agent_thinking: String,
    pub remote_cache_dir: String,
    pub model_swaps: bool,
    pub self_url: String,
    pub idle_timeout: f64,
    pub idle_poll: f64,
    pub max_spoken_chars: usize,
    pub speech_deadline_ms: u64,
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
        let (values, env_file) = Self::values_from_env();
        Self::from_values(&values, env_file)
    }

    /// The deployment env file merged under the inherited process environment.
    ///
    /// Separated from `from_values` so the log subscriber can be installed from
    /// these values *before* any setting is parsed. Parsing warns about values
    /// it had to reject, and those warnings are worth nothing if they are
    /// emitted before a subscriber exists to record them.
    pub fn values_from_env() -> (HashMap<String, String>, PathBuf) {
        let env_file = PathBuf::from(value(
            "SWITCHBOARD_ENV_FILE",
            "/etc/switchboard/switchboard.env",
        ));
        let mut values = load_env_file(&env_file);
        for (key, value) in env::vars() {
            values.insert(key, value);
        }
        (values, env_file)
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
            stt_stream_command: optional(values, "SWITCHBOARD_STT_STREAM_COMMAND"),
            bind: get(values, "SWITCHBOARD_BIND", "0.0.0.0:8765"),
            pi_binary: get(values, "SWITCHBOARD_PI_BINARY", "pi"),
            ssh_program: get(values, "SWITCHBOARD_SSH_PROGRAM", "ssh"),
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
            max_spoken_chars: usize_value(values, "SWITCHBOARD_MAX_SPOKEN_CHARS", 700, false),
            speech_deadline_ms: bounded_ms(values, "SWITCHBOARD_SPEECH_DEADLINE_MS", 25_000),
            history_limit: usize_value(values, "SWITCHBOARD_HISTORY_LIMIT", 200, true),
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
    let Some(raw) = values.get(name).map(|value| value.trim()) else {
        return default;
    };
    if raw.is_empty() {
        return default;
    }
    match raw.parse::<f64>() {
        Ok(parsed) if parsed.is_finite() => parsed,
        // A deployment that misspells a duration gets the default silently
        // otherwise, and the symptom (a leg that never times out, or one that
        // drops instantly) looks nothing like its cause.
        _ => {
            tracing::warn!(setting = name, value = raw, %default, "setting is not a number; using the default");
            default
        }
    }
}
fn bounded_ms(values: &HashMap<String, String>, name: &str, default: u64) -> u64 {
    match values.get(name) {
        None => default,
        Some(raw) => raw
            .trim()
            .parse::<u64>()
            .ok()
            .filter(|value| (1..=120_000).contains(value))
            .unwrap_or_else(|| panic!("{name} must be a positive integer from 1 to 120000 ms")),
    }
}
fn usize_value(
    values: &HashMap<String, String>,
    name: &str,
    default: usize,
    allow_zero: bool,
) -> usize {
    let Some(raw) = values.get(name).map(|value| value.trim()) else {
        return default;
    };
    if raw.is_empty() {
        return default;
    }
    match raw.parse::<usize>() {
        Ok(parsed) if allow_zero || parsed > 0 => parsed,
        _ => {
            tracing::warn!(setting = name, value = raw, %default, "setting is not a whole number; using the default");
            default
        }
    }
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
        let name = name.trim().strip_prefix("export ").unwrap_or(name.trim());
        if name.is_empty()
            || !name.chars().enumerate().all(|(index, character)| {
                character == '_'
                    || character.is_ascii_alphanumeric()
                        && (index > 0 || !character.is_ascii_digit())
            })
        {
            continue;
        }
        result.insert(name.to_owned(), parse_env_value(value));
    }
    result
}

fn parse_env_value(value: &str) -> String {
    let value = value.trim();
    if let Some(quoted) = value.strip_prefix('\'') {
        return quoted
            .rfind('\'')
            .map_or(quoted, |end| &quoted[..end])
            .to_owned();
    }
    if let Some(quoted) = value.strip_prefix('"') {
        let quoted = quoted.rfind('"').map_or(quoted, |end| &quoted[..end]);
        let mut parsed = String::with_capacity(quoted.len());
        let mut chars = quoted.chars();
        while let Some(character) = chars.next() {
            if character == '\\' {
                match chars.next() {
                    Some('n') => parsed.push('\n'),
                    Some('r') => parsed.push('\r'),
                    Some('t') => parsed.push('\t'),
                    Some(next @ ('\\' | '"')) => parsed.push(next),
                    Some(next) => {
                        parsed.push('\\');
                        parsed.push(next);
                    }
                    None => parsed.push('\\'),
                }
            } else {
                parsed.push(character);
            }
        }
        return parsed;
    }
    let comment = value.char_indices().find_map(|(index, character)| {
        (character == '#'
            && value[..index]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace))
        .then_some(index)
    });
    value[..comment.unwrap_or(value.len())]
        .trim_end()
        .to_owned()
}

fn value(name: &str, default: &str) -> String {
    env::var(name)
        .unwrap_or_else(|_| default.to_owned())
        .trim()
        .to_owned()
}

/// What the service logs when nothing asks for anything else.
///
/// Deliberately not `RUST_LOG`'s own default. `tracing_subscriber::fmt::init()`
/// builds its filter with `EnvFilter::from_default_env()`, whose default
/// directive is `error` — and this service has almost no `error!` sites, so an
/// unset `RUST_LOG` produced a process that ran an entire call, dropped legs,
/// failed to stage extensions, and said nothing at all. The deployment env file
/// is owned by homelab and cannot be assumed to set anything, so the useful
/// level has to be the one you get for free.
const DEFAULT_LOG_FILTER: &str = "switchboard=info,warn";

/// Install the log subscriber, reading its filter from the deployment env file
/// as well as the process environment.
///
/// `SWITCHBOARD_LOG` takes precedence over `RUST_LOG` because the env file is
/// the only configuration surface this repository shares with the deployment,
/// and `RUST_LOG` cannot be set there without leaking into every other process
/// the unit starts. Returns a description of what it installed so the caller
/// can log it once the subscriber is live.
fn init_tracing(values: &HashMap<String, String>) -> (String, Option<String>) {
    let requested = values
        .get("SWITCHBOARD_LOG")
        .or_else(|| values.get("RUST_LOG"))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let (filter, rejected) = match &requested {
        None => (tracing_subscriber::EnvFilter::new(DEFAULT_LOG_FILTER), None),
        Some(requested) => match tracing_subscriber::EnvFilter::builder().parse(requested) {
            Ok(filter) => (filter, None),
            // A typo in a filter directive must not cost the operator every
            // log line the service would otherwise have written.
            Err(error) => (
                tracing_subscriber::EnvFilter::new(DEFAULT_LOG_FILTER),
                Some(format!("{requested:?}: {error}")),
            ),
        },
    };
    let describe = requested
        .filter(|_| rejected.is_none())
        .unwrap_or_else(|| DEFAULT_LOG_FILTER.to_owned());
    let json = matches!(
        get(values, "SWITCHBOARD_LOG_FORMAT", "text")
            .to_ascii_lowercase()
            .as_str(),
        "json"
    );
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true);
    if json {
        builder.json().flatten_event(true).init();
    } else {
        builder.init();
    }
    (describe, rejected)
}

#[tokio::main]
async fn main() {
    let (values, env_file) = Config::values_from_env();
    let (filter, rejected_filter) = init_tracing(&values);
    if let Some(rejected) = rejected_filter {
        tracing::warn!(%rejected, default = DEFAULT_LOG_FILTER, "log filter could not be parsed; using the default");
    }
    let config = Config::from_values(&values, env_file);
    // The first thing worth knowing about a running switchboard is what it was
    // configured to be. Secrets are reported as configured-or-not, never
    // echoed: this line goes to the journal, which is not where the
    // ElevenLabs key belongs.
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        git = env!("SWITCHBOARD_GIT_SHA"),
        env_file = %config.env_file.display(),
        projects_file = %config.projects_file.display(),
        operator_prompt = %config.operator_prompt.display(),
        pi_binary = %config.pi_binary,
        operator_model = config.operator_model.as_deref().unwrap_or("<runtime default>"),
        agent_model = config.agent_model.as_deref().unwrap_or("<runtime default>"),
        agent_thinking = %config.agent_thinking,
        model_swaps = config.model_swaps,
        stt_configured = config.stt_command.is_some(),
        stt_stream_configured = config.stt_stream_command.is_some(),
        persona_configured = !config.persona.is_empty(),
        operator_extension = config.operator_extension.as_deref().unwrap_or("<none>"),
        agent_extension = config.agent_extension.as_deref().unwrap_or("<none>"),
        self_url = %config.self_url,
        idle_timeout = config.idle_timeout,
        idle_poll = config.idle_poll,
        max_spoken_chars = config.max_spoken_chars,
        speech_deadline_ms = config.speech_deadline_ms,
        history_limit = config.history_limit,
        log_filter = %filter,
        "switchboard configuration"
    );
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
    let state = api::AppState::new_with_stream(
        board,
        history::TranscriptLog::new(config.history_limit),
        audio::Speaker::from_values(config.max_spoken_chars, &config.environment),
        audio::SttAdapter::from_command(config.stt_command.clone()),
        audio::SttStreamAdapter::from_command(config.stt_stream_command.clone()),
    );
    let prewarm = std::sync::Arc::new(
        prewarm::Prewarm::start(&config, &state.0.switchboard.lock().await.registry).await,
    );
    state.0.switchboard.lock().await.set_prewarm(prewarm);
    api::spawn_workers(state.clone());
    api::spawn_idle_worker(state.clone(), config.idle_timeout, config.idle_poll);
    let bind = config.bind.clone();
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .expect("bind switchboard listener");
    tracing::info!(%bind, "switchboard listening");
    let server = axum::serve(
        listener,
        state
            .clone()
            .router(Some(tower_http::services::ServeDir::new("static"))),
    )
    .with_graceful_shutdown(shutdown_signal(state.clone()));
    let result = server.await;
    // Also covers listener/server failures that did not arrive through the
    // signal future. Shutdown is intentionally idempotent.
    api::shutdown(&state).await;
    if let Err(error) = result {
        tracing::error!(%error, "switchboard server stopped");
    }
}

async fn shutdown_signal(state: api::AppState) {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                if let Err(error) = result {
                    tracing::warn!(%error, "Ctrl-C handler failed");
                }
            }
            _ = terminate.recv() => {}
        }
    }

    #[cfg(not(unix))]
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::warn!(%error, "Ctrl-C handler failed");
    }

    tracing::info!("shutdown requested");
    api::shutdown(&state).await;
}

#[cfg(test)]
#[path = "../tests/test_main.rs"]
mod tests;

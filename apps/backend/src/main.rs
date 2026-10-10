mod api;
mod app_state;
mod audio;
mod browser;
mod caller_input;
mod debug;
mod decisions;
mod delivery;
mod display;
mod floor;
mod history;
mod hosts;
mod jev;
mod leg_announcer;
mod leg_transitions;
mod lifecycle;
mod models;
mod module_calls;
mod operator;
mod page_controls;
mod pbx;
mod pi_client;
mod prewarm;
mod prompts;
mod protocol;
mod redial;
mod registry;
mod reply;
mod residents;
mod router;
mod routing_view;
mod speech;
mod turns;
mod visual_protocol;

use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;

/// The commit this binary was built from, stamped by `build.rs`: the
/// `SWITCHBOARD_GIT_SHA` the build was given, else `git describe`, else
/// `unknown`. Logged at startup and reported on `/healthz`, so a deploy can be
/// checked against its pin with one request.
pub const GIT_SHA: &str = env!("SWITCHBOARD_GIT_SHA");

/// Everything the service reads from its environment, parsed once.
///
/// Every `SWITCHBOARD_*` name here is interface with the homelab deployment
/// (see `docs/environment.md`); modules take their settings from this struct
/// rather than reading the environment again.
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub env_file: PathBuf,
    pub projects_file: PathBuf,
    /// The per-host tokens of the host link: a JSON object from host id to
    /// token (`SWITCHBOARD_HOST_TOKENS_FILE`). Read once at startup.
    pub host_tokens_file: PathBuf,
    pub operator_prompt: PathBuf,
    pub operator_extension: Option<String>,
    pub persona: String,
    pub stt_command: Option<String>,
    pub stt_stream_command: Option<String>,
    pub bind: String,
    /// Optional read-only listener for the in-memory debug page.
    pub debug_bind: Option<String>,
    pub pi_binary: String,
    pub operator_model: Option<String>,
    pub agent_model: Option<String>,
    pub agent_thinking: String,
    pub model_swaps: bool,
    pub max_spoken_chars: usize,
    pub speech_deadline_ms: u64,
    pub history_limit: usize,
    pub jev_key_file: PathBuf,
    pub jev_url: String,
    pub jev_timeout_ms: u64,
    pub jev_for_current_agent_lower: f64,
    pub jev_for_current_agent_upper: f64,
    pub jev_action_threshold: f64,
    pub jev_summary_token_budget: usize,
    /// How long the caller must be quiet before a held floor request is
    /// released with an announcement.
    pub floor_quiet_threshold_ms: u64,
    /// The ElevenLabs settings (`ELEVENLABS_*`) the speaker uses.
    pub tts: audio::TtsSettings,
    /// Environment values loaded from the deployment env file and inherited
    /// process environment. The operator's process receives them.
    pub environment: HashMap<String, String>,
}

impl Config {
    pub fn speech_deadline(&self) -> std::time::Duration {
        std::time::Duration::from_millis(self.speech_deadline_ms)
    }

    /// The deployment env file merged under the inherited process environment.
    ///
    /// Separated from `from_values` so the log subscriber can be installed from
    /// these values *before* any setting is parsed. Parsing warns about values
    /// it had to reject, and those warnings are worth nothing if they are
    /// emitted before a subscriber exists to record them.
    pub fn values_from_env() -> (HashMap<String, String>, PathBuf) {
        let process: HashMap<String, String> = env::vars().collect();
        let env_file = PathBuf::from(get(
            &process,
            "SWITCHBOARD_ENV_FILE",
            "/etc/switchboard/switchboard.env",
        ));
        let mut values = load_env_file(&env_file);
        values.extend(process);
        (values, env_file)
    }

    pub fn from_values(values: &HashMap<String, String>, env_file: PathBuf) -> Self {
        let config_dir = PathBuf::from(get(values, "SWITCHBOARD_CONFIG_DIR", "/etc/switchboard"));
        let projects_file = PathBuf::from(get(
            values,
            "SWITCHBOARD_PROJECTS_FILE",
            &config_dir.join("projects.json").to_string_lossy(),
        ));
        let host_tokens_file = PathBuf::from(get(
            values,
            "SWITCHBOARD_HOST_TOKENS_FILE",
            &config_dir.join("host-tokens.json").to_string_lossy(),
        ));
        let operator_prompt = PathBuf::from(get(
            values,
            "SWITCHBOARD_OPERATOR_PROMPT",
            &config_dir.join("operator.system.md").to_string_lossy(),
        ));
        let (jev_for_current_agent_lower, jev_for_current_agent_upper) = current_agent_band(values);
        Self {
            env_file,
            projects_file,
            host_tokens_file,
            operator_prompt,
            operator_extension: optional(values, "SWITCHBOARD_OPERATOR_EXTENSION"),
            persona: get(values, "SWITCHBOARD_PERSONA", ""),
            stt_command: optional(values, "SWITCHBOARD_STT_COMMAND"),
            stt_stream_command: optional(values, "SWITCHBOARD_STT_STREAM_COMMAND"),
            bind: get(values, "SWITCHBOARD_BIND", "0.0.0.0:8765"),
            debug_bind: optional(values, "SWITCHBOARD_DEBUG_BIND"),
            pi_binary: get(values, "SWITCHBOARD_PI_BINARY", "pi"),
            operator_model: optional(values, "SWITCHBOARD_OPERATOR_MODEL"),
            agent_model: optional(values, "SWITCHBOARD_AGENT_MODEL"),
            agent_thinking: get(values, "SWITCHBOARD_AGENT_THINKING", "medium"),
            model_swaps: !matches!(
                get(values, "SWITCHBOARD_MODEL_SWAPS", "1")
                    .to_ascii_lowercase()
                    .as_str(),
                "0" | "false" | "no"
            ),
            max_spoken_chars: usize_value(values, "SWITCHBOARD_MAX_SPOKEN_CHARS", 700, false),
            speech_deadline_ms: bounded_ms(values, "SWITCHBOARD_SPEECH_DEADLINE_MS", 25_000),
            history_limit: usize_value(values, "SWITCHBOARD_HISTORY_LIMIT", 200, true),
            jev_key_file: PathBuf::from(get(
                values,
                "SWITCHBOARD_JEV_KEY_FILE",
                "/etc/switchboard/secrets/typesafe-api-key",
            )),
            jev_url: get(
                values,
                "SWITCHBOARD_JEV_URL",
                "https://api.typesafe.ai/v1/systemone",
            ),
            jev_timeout_ms: ms_value(values, "SWITCHBOARD_JEV_TIMEOUT_MS", 2_000),
            jev_for_current_agent_lower,
            jev_for_current_agent_upper,
            jev_action_threshold: fraction_value(values, "SWITCHBOARD_JEV_ACTION_THRESHOLD", 0.6),
            jev_summary_token_budget: usize_value(
                values,
                "SWITCHBOARD_JEV_SUMMARY_TOKEN_BUDGET",
                8_000,
                false,
            )
            .min(32_000),
            floor_quiet_threshold_ms: ms_value(
                values,
                "SWITCHBOARD_FLOOR_QUIET_THRESHOLD_MS",
                10_000,
            ),
            tts: audio::TtsSettings {
                api_key: get(values, "ELEVENLABS_API_KEY", ""),
                voice_id: get(values, "ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"),
                model_id: get(values, "ELEVENLABS_MODEL_ID", "eleven_multilingual_v2"),
                stability: f32_value(values, "ELEVENLABS_STABILITY", 0.5),
                similarity_boost: f32_value(values, "ELEVENLABS_SIMILARITY_BOOST", 0.75),
                style: f32_value(values, "ELEVENLABS_STYLE", 0.0),
                speed: f32_value(values, "ELEVENLABS_SPEED", 1.0),
            },
            environment: values.clone(),
        }
    }
}

#[cfg(test)]
impl Config {
    /// A configuration parsed from `values` alone, the way the service parses
    /// its env file: tests name only the settings they depend on.
    pub(crate) fn for_tests(values: &[(&str, &str)]) -> Self {
        let values = values
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect();
        Self::from_values(&values, PathBuf::from("/nonexistent/switchboard.env"))
    }
}

/// The one lookup every setting goes through, so `docs/environment.md`'s
/// "Blank means unset" has a single owner: a missing value and one that is
/// blank after trimming are both `None`, and a present value comes back
/// trimmed.
fn setting<'a>(values: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    values
        .get(name)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
}
fn get(values: &HashMap<String, String>, name: &str, default: &str) -> String {
    setting(values, name).unwrap_or(default).to_owned()
}
fn optional(values: &HashMap<String, String>, name: &str) -> Option<String> {
    setting(values, name).map(str::to_owned)
}
/// The longest duration a millisecond setting accepts.
const MAX_MS: u64 = 120_000;

/// A whole number of milliseconds from 1 to `MAX_MS`, or `None`.
fn parse_ms(raw: &str) -> Option<u64> {
    raw.parse::<u64>()
        .ok()
        .filter(|value| (1..=MAX_MS).contains(value))
}
/// A deadline the host agent also enforces (only
/// `SWITCHBOARD_SPEECH_DEADLINE_MS`): a value the service silently replaced
/// with its default would leave the two sides disagreeing, so a malformed one
/// stops startup instead.
fn bounded_ms(values: &HashMap<String, String>, name: &str, default: u64) -> u64 {
    setting(values, name).map_or(default, |raw| {
        parse_ms(raw)
            .unwrap_or_else(|| panic!("{name} must be a positive integer from 1 to {MAX_MS} ms"))
    })
}
/// A duration only this service uses: a value that is not a whole number of
/// milliseconds from 1 to `MAX_MS` is logged and replaced by the default.
fn ms_value(values: &HashMap<String, String>, name: &str, default: u64) -> u64 {
    let Some(raw) = setting(values, name) else {
        return default;
    };
    parse_ms(raw).unwrap_or_else(|| {
        tracing::warn!(setting = name, value = raw, %default, "setting is not a whole number of milliseconds from 1 to {MAX_MS}; using the default");
        default
    })
}
/// `SWITCHBOARD_JEV_FOR_CURRENT_AGENT_LOWER` and `_UPPER`, each a fraction.
/// A band whose lower bound exceeds its upper one is logged and replaced by
/// both defaults: either bound may be the one that is wrong (setting only one
/// can cross the other's default), so neither is kept.
fn current_agent_band(values: &HashMap<String, String>) -> (f64, f64) {
    const DEFAULT: (f64, f64) = (0.3, 0.7);
    let lower = fraction_value(values, "SWITCHBOARD_JEV_FOR_CURRENT_AGENT_LOWER", DEFAULT.0);
    let upper = fraction_value(values, "SWITCHBOARD_JEV_FOR_CURRENT_AGENT_UPPER", DEFAULT.1);
    if lower <= upper {
        return (lower, upper);
    }
    let (default_lower, default_upper) = DEFAULT;
    tracing::warn!(
        lower,
        upper,
        default_lower,
        default_upper,
        "SWITCHBOARD_JEV_FOR_CURRENT_AGENT_LOWER exceeds UPPER; using the default band"
    );
    DEFAULT
}
fn fraction_value(values: &HashMap<String, String>, name: &str, default: f64) -> f64 {
    let Some(raw) = setting(values, name) else {
        return default;
    };
    match raw.parse::<f64>() {
        Ok(value) if value.is_finite() && (0.0..=1.0).contains(&value) => value,
        _ => {
            tracing::warn!(setting = name, value = raw, %default, "setting is not a fraction from 0 to 1; using the default");
            default
        }
    }
}

/// A setting that must be a finite number. Blank is unset; anything else that
/// is not a finite number is logged and replaced by the default.
fn f32_value(values: &HashMap<String, String>, name: &str, default: f32) -> f32 {
    let Some(raw) = setting(values, name) else {
        return default;
    };
    match raw.parse::<f32>() {
        Ok(value) if value.is_finite() => value,
        _ => {
            tracing::warn!(setting = name, value = raw, %default, "setting is not a finite number; using the default");
            default
        }
    }
}

fn usize_value(
    values: &HashMap<String, String>,
    name: &str,
    default: usize,
    allow_zero: bool,
) -> usize {
    let Some(raw) = setting(values, name) else {
        return default;
    };
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

/// What the service logs when nothing asks for anything else.
///
/// Deliberately not `RUST_LOG`'s own default. `tracing_subscriber::fmt::init()`
/// builds its filter with `EnvFilter::from_default_env()`, whose default
/// directive is `error` — and this service has almost no `error!` sites, so an
/// unset `RUST_LOG` produced a process that ran an entire call, dropped legs,
/// and said nothing at all. The deployment env file is owned by homelab and
/// cannot be assumed to set anything, so the useful level has to be the one
/// you get for free.
const DEFAULT_LOG_FILTER: &str = "switchboard=info,warn";

/// Install the log subscriber, reading its filter from the deployment env file
/// as well as the process environment.
///
/// `SWITCHBOARD_LOG` takes precedence over `RUST_LOG` because the env file is
/// the only configuration surface this repository shares with the deployment,
/// and `RUST_LOG` cannot be set there without leaking into every other process
/// the unit starts. Returns a description of what it installed so the caller
/// can log it once the subscriber is live.
fn init_tracing(
    values: &HashMap<String, String>,
    debug_bus: debug::DebugBus,
) -> (String, Option<String>) {
    let requested = setting(values, "SWITCHBOARD_LOG")
        .or_else(|| setting(values, "RUST_LOG"))
        .map(str::to_owned);
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
    use tracing_subscriber::prelude::*;
    if json {
        tracing_subscriber::registry()
            .with(filter)
            .with(debug::DebugLogLayer::new(debug_bus.clone()))
            .with(
                tracing_subscriber::fmt::layer()
                    .json()
                    .flatten_event(true)
                    .with_target(true),
            )
            .init();
    } else {
        tracing_subscriber::registry()
            .with(filter)
            .with(debug::DebugLogLayer::new(debug_bus))
            .with(tracing_subscriber::fmt::layer().with_target(true))
            .init();
    }
    (describe, rejected)
}

/// Binds the optional debug listener and, once it is bound, starts `bus`
/// recording. It is read-only and optional, so a failure is reported and the
/// phone line keeps running without it, and with the bus off.
async fn bind_debug_listener(
    debug_bind: Option<&str>,
    bus: &debug::DebugBus,
    config: debug::DebugConfig,
) -> Option<tokio::net::TcpListener> {
    let debug_bind = debug_bind?;
    match tokio::net::TcpListener::bind(debug_bind).await {
        Ok(listener) => {
            bus.enable(config);
            tracing::info!(%debug_bind, "switchboard debug listener listening");
            Some(listener)
        }
        Err(error) => {
            tracing::error!(%debug_bind, %error, "debug listener not started");
            None
        }
    }
}

#[tokio::main]
async fn main() {
    let (values, env_file) = Config::values_from_env();
    // Off until the debug listener is bound: with no listener, nothing is
    // recorded and the log copy does nothing.
    let debug_bus = debug::DebugBus::off();
    let (filter, rejected_filter) = init_tracing(&values, debug_bus.clone());
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
        git = GIT_SHA,
        env_file = %config.env_file.display(),
        bind = %config.bind,
        debug_bind = config.debug_bind.as_deref().unwrap_or("<off>"),
        projects_file = %config.projects_file.display(),
        host_tokens_file = %config.host_tokens_file.display(),
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
        max_spoken_chars = config.max_spoken_chars,
        speech_deadline_ms = config.speech_deadline_ms,
        history_limit = config.history_limit,
        jev_key_file = %config.jev_key_file.display(),
        jev_timeout_ms = config.jev_timeout_ms,
        jev_for_current_agent_lower = config.jev_for_current_agent_lower,
        jev_for_current_agent_upper = config.jev_for_current_agent_upper,
        jev_action_threshold = config.jev_action_threshold,
        jev_summary_token_budget = config.jev_summary_token_budget,
        floor_quiet_threshold_ms = config.floor_quiet_threshold_ms,
        log_filter = %filter,
        "switchboard configuration"
    );
    let registry = registry::Registry::load(&config.projects_file);
    let hosts = hosts::Hosts::load(&config.host_tokens_file, hosts::Heartbeat::default());
    // Startup work for every project -- catalogs and prepare commands, run
    // by each host agent as soon as it links -- begins now; a transfer waits
    // on it rather than doing any of it itself.
    let prewarm = std::sync::Arc::new(prewarm::Prewarm::start(&registry, hosts));
    let board = pbx::Switchboard::new(&config, registry, prewarm);
    let state = app_state::AppState::new_with_debug(
        board,
        history::TranscriptLog::new(config.history_limit),
        audio::Speaker::new(
            config.max_spoken_chars,
            config.speech_deadline(),
            config.tts.clone(),
        ),
        audio::SttAdapter::from_command(config.stt_command.clone()),
        audio::SttStreamAdapter::from_command(config.stt_stream_command.clone()),
        debug_bus.clone(),
    );
    app_state::spawn_workers(state.clone());
    let bind = config.bind.clone();
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .expect("bind switchboard listener");
    tracing::info!(%bind, "switchboard listening");
    let debug_listener = bind_debug_listener(
        config.debug_bind.as_deref(),
        &debug_bus,
        debug::DebugConfig::from_config(&config),
    )
    .await;
    let debug_task = if let Some(debug_listener) = debug_listener {
        let debug_state = state.clone();
        Some(tokio::spawn(async move {
            let debug_router = debug_state.debug_router();
            let shutdown_state = debug_state.clone();
            let result = axum::serve(debug_listener, debug_router)
                .with_graceful_shutdown(shutdown_state.wait_for_shutdown())
                .await;
            if let Err(error) = result {
                tracing::error!(%error, "switchboard debug listener stopped");
            }
        }))
    } else {
        None
    };
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
    app_state::shutdown(&state).await;
    if let Some(debug_task) = debug_task {
        let _ = debug_task.await;
    }
    if let Err(error) = result {
        tracing::error!(%error, "switchboard server stopped");
    }
}

async fn shutdown_signal(state: app_state::AppState) {
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
    app_state::shutdown(&state).await;
}

#[cfg(test)]
#[path = "../tests/test_main.rs"]
mod tests;

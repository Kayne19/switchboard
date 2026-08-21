//! Call routing and Pi session lifecycle.
use crate::lifecycle::{CandidateLeg, Coordinator};
use crate::models::{
    fetch_catalog, normalize_thinking, pin_thinking, ModelCatalog, ModelChoice, ModelError,
    THINKING_LEVELS,
};
use crate::pi_client::{
    local_argv, remote_argv_with_program, ActivityCallback, PiSession, PiSessionError, Signal,
    Turn, ValidatedSshTarget, RETURN_TOOL, SET_MODEL_TOOL, TRANSFER_TOOL,
};
use crate::registry::{Project, Registry};
use futures_util::FutureExt;
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex, RwLock as StdRwLock};
use std::time::Instant;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

pub const OPERATOR: &str = "operator";
pub type RouteCallback =
    Arc<dyn Fn(serde_json::Value) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

#[derive(Clone, Debug)]
pub struct ActivityClock(Arc<StdMutex<Instant>>);
impl ActivityClock {
    fn new() -> Self {
        Self(Arc::new(StdMutex::new(Instant::now())))
    }

    pub fn touch(&self) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Instant::now();
    }

    fn elapsed(&self) -> f64 {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .elapsed()
            .as_secs_f64()
    }
}

#[derive(Clone, Debug)]
pub struct LiveLegState(Arc<StdRwLock<LiveLegSnapshot>>);
#[derive(Debug)]
struct LiveLegSnapshot {
    route: String,
    session_token: String,
    effective_thinking: String,
}
impl LiveLegState {
    fn new() -> Self {
        Self(Arc::new(StdRwLock::new(LiveLegSnapshot {
            route: OPERATOR.to_owned(),
            session_token: String::new(),
            effective_thinking: String::new(),
        })))
    }

    pub fn route(&self) -> String {
        self.0
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .route
            .clone()
    }

    pub(crate) fn set_session(&self, route: &str, token: &str) {
        let mut state = self
            .0
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.route = route.to_owned();
        state.session_token = token.to_owned();
        state.effective_thinking.clear();
    }

    fn set_route(&self, route: &str) {
        self.set_session(route, "");
    }

    fn effective_thinking(&self) -> String {
        self.0
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .effective_thinking
            .clone()
    }

    pub fn report_thinking(&self, token: &str, thinking: &str) -> bool {
        if !THINKING_LEVELS.contains(&thinking) {
            return false;
        }
        let mut state = self
            .0
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.route == OPERATOR
            || state.session_token.is_empty()
            || state.session_token != token
            || state.effective_thinking == thinking
        {
            return false;
        }
        state.effective_thinking = thinking.to_owned();
        true
    }
}
const RETURN_SENTINEL: &str = "[[SWITCHBOARD:RETURN]]";
const AGENT_BRIEF_HEADER: &str =
    "You are on a voice call in the {project} project, in its own directory.\n\n";
const SPEAK_BRIEF: &str = "Use the configured speak tool for spoken updates; written output is kept for the caller's screen and is not read aloud.";
const FALLBACK_BRIEF: &str = "No speak extension is available on this host. Write a short spoken reply; the switchboard reads it aloud once your turn settles.";
const PREPARE_OUTPUT_LIMIT: usize = 64 * 1024;
const CHILD_ERROR_LIMIT: usize = 64 * 1024;
const STAGE_OUTPUT_LIMIT: usize = 64 * 1024;

/// A remote extension copy is provisional until its candidate is adopted.
/// Rollback is explicit because Drop cannot await an SSH cleanup.
pub struct ExtensionStageTxn {
    ssh_program: String,
    host: ValidatedSshTarget,
    path: String,
    committed: bool,
}
impl ExtensionStageTxn {
    pub fn new(
        ssh_program: impl Into<String>,
        host: ValidatedSshTarget,
        path: impl Into<String>,
    ) -> Self {
        Self {
            ssh_program: ssh_program.into(),
            host,
            path: path.into(),
            committed: false,
        }
    }
    pub fn path(&self) -> &str {
        &self.path
    }
    pub fn commit(mut self) {
        self.committed = true;
    }
    pub async fn rollback(self) -> Result<(), String> {
        if self.committed {
            return Ok(());
        }
        let command = format!("rm -f -- {}", crate::pi_client::shell_quote(&self.path));
        let options = crate::pi_client::SshClientOptions::new(&self.ssh_program, self.host);
        let mut child_cmd = options.remote_command(&command);
        child_cmd.stdin(std::process::Stdio::null());
        child_cmd.stdout(std::process::Stdio::piped());
        child_cmd.stderr(std::process::Stdio::piped());
        crate::pi_client::isolate_process(&mut child_cmd);

        let mut child = match child_cmd.spawn() {
            Ok(child) => child,
            Err(error) => return Err(format!("rollback could not start: {error}")),
        };
        let process_guard = crate::pi_client::ProcessTreeGuard::new(&child);

        let stdout_task = child.stdout.take().map(|mut output| {
            tokio::spawn(async move {
                crate::pi_client::drain_bounded(&mut output, STAGE_OUTPUT_LIMIT).await
            })
        });
        let stderr_task = child.stderr.take().map(|mut output| {
            tokio::spawn(async move {
                crate::pi_client::drain_bounded(&mut output, CHILD_ERROR_LIMIT).await
            })
        });

        let status = match timeout(Duration::from_secs(10), child.wait()).await {
            Ok(Ok(status)) => {
                process_guard.disarm();
                status
            }
            Ok(Err(error)) => {
                crate::pi_client::terminate_process(&mut child).await;
                process_guard.disarm();
                abort_output(stdout_task);
                abort_output(stderr_task);
                return Err(format!("rollback wait failed: {error}"));
            }
            Err(_) => {
                crate::pi_client::terminate_process(&mut child).await;
                process_guard.disarm();
                abort_output(stdout_task);
                abort_output(stderr_task);
                return Err("rollback timed out".to_string());
            }
        };

        let _ = join_output(stdout_task).await;
        let _ = join_output(stderr_task).await;

        if status.success() {
            Ok(())
        } else {
            Err(format!("remote cleanup exited with status {status}"))
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Utterance {
    pub text: String,
    pub synthesize: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct Reply {
    pub text: String,
    pub route: String,
    pub route_label: String,
    pub error: Option<String>,
    pub to_speak: Vec<String>,
    #[serde(skip)]
    pub(crate) delivery_generation: Option<u64>,
}
impl Reply {
    fn new(route: &str, label: &str, utterances: Vec<Utterance>, error: Option<String>) -> Self {
        let text = utterances
            .iter()
            .filter(|u| !u.text.is_empty())
            .map(|u| u.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let to_speak = utterances
            .iter()
            .filter(|u| u.synthesize && !u.text.is_empty())
            .map(|u| u.text.clone())
            .collect();
        Self {
            text,
            route: route.into(),
            route_label: label.into(),
            error,
            to_speak,
            delivery_generation: None,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct TransferContext {
    pub exact_caller_transcript: String,
    pub derived_intent: String,
    pub direct_page_transfer_context: Option<String>,
    pub selected_project_id: Option<String>,
    pub return_operator_note: Option<String>,
    pub project_summary: Option<String>,
}

fn build_intro_prompt(
    context: &TransferContext,
    project: &Project,
    prepare_report: Option<&crate::prewarm::PrepareReport>,
) -> String {
    let mut prompt = String::new();
    prompt.push_str("Address the request immediately. Do not greet the caller and do not mention tool or connection details.\n\n");

    prompt.push_str("[PROJECT METADATA]\n");
    prompt.push_str(&format!("ID: {}\n", project.id));
    if !project.description.is_empty() {
        prompt.push_str(&format!("Description: {}\n", project.description));
    }

    if let Some(page_ctx) = &context.direct_page_transfer_context {
        prompt.push_str("\n[DIRECT PAGE TRANSFER]\n");
        prompt.push_str("No caller transcript was supplied.\n");
        prompt.push_str(&format!("Context: {page_ctx}\n"));
    } else {
        prompt.push_str("\n[CALLER TRANSCRIPT]\n");
        if context.exact_caller_transcript.is_empty() {
            prompt.push_str("No caller transcript was supplied.\n");
        } else {
            prompt.push_str(&format!(
                "Bytes: {}\n",
                context.exact_caller_transcript.len()
            ));
            prompt.push_str(&context.exact_caller_transcript);
            prompt.push('\n');
        }
    }

    if !context.derived_intent.is_empty() {
        prompt.push_str("\n[DERIVED INTENT]\n");
        prompt.push_str(&context.derived_intent);
        prompt.push('\n');
    }

    if let Some(rep) = prepare_report {
        prompt.push_str("\n[STARTUP PREPARE REPORT (TIMESTAMPED SNAPSHOT)]\n");
        prompt.push_str(&format!("Timestamp Unix Ms: {}\n", rep.timestamp_unix_ms));
        prompt.push_str(&format!("Source: {:?}\n", rep.source));
        prompt.push_str(&format!("Outcome: {:?}\n", rep.outcome));
        prompt.push_str(&format!("Duration Ms: {}\n", rep.duration_ms));
        if let Some(code) = rep.exit_code {
            prompt.push_str(&format!("Exit Code: {code}\n"));
        }
        if !rep.stdout.is_empty() {
            prompt.push_str(&format!("Stdout: {}\n", rep.stdout));
        }
        if !rep.stderr.is_empty() {
            prompt.push_str(&format!("Stderr: {}\n", rep.stderr));
        }
    }

    prompt
}

pub struct Switchboard {
    pub registry: Registry,
    pub pi_binary: String,
    pub ssh_program: String,
    pub operator_model: Option<String>,
    pub operator_system_prompt: String,
    pub operator_extension: Option<String>,
    pub agent_extension_file: Option<String>,
    pub agent_model: Option<String>,
    pub agent_thinking: String,
    pub remote_cache_dir: String,
    pub model_swaps: bool,
    pub speak_url: String,
    pub state_url: String,
    pub diagram_url: String,
    pub persona: String,
    pub env: HashMap<String, String>,
    speech_deadline_ms: u64,
    activity_callback: Option<ActivityCallback>,
    route_callback: Option<RouteCallback>,
    active_session: Arc<Mutex<Option<PiSession>>>,
    route: String,
    project: Option<Project>,
    operator: Option<PiSession>,
    agent: Option<PiSession>,
    model_spec: String,
    session_id: String,
    live_leg: LiveLegState,
    catalogs: HashMap<String, ModelCatalog>,
    staged_extensions: Mutex<HashMap<String, Option<String>>>,
    operator_note: Option<String>,
    last_activity: ActivityClock,
    coordinator: Option<Coordinator>,
    pub prewarm: Option<Arc<crate::prewarm::Prewarm>>,
}
impl Switchboard {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        registry: Registry,
        pi_binary: String,
        operator_model: Option<String>,
        operator_system_prompt: String,
        operator_extension: Option<String>,
        agent_extension_file: Option<String>,
        agent_model: Option<String>,
        agent_thinking: String,
        remote_cache_dir: String,
        model_swaps: bool,
        speak_url: String,
        state_url: String,
        diagram_url: String,
        persona: String,
        env: HashMap<String, String>,
    ) -> Self {
        let speech_deadline_ms = match env.get("SWITCHBOARD_SPEECH_DEADLINE_MS") {
            None => 25_000,
            Some(raw) => raw
                .trim()
                .parse::<u64>()
                .ok()
                .filter(|value| (1..=120_000).contains(value))
                .unwrap_or_else(|| {
                    panic!("SWITCHBOARD_SPEECH_DEADLINE_MS must be a positive integer from 1 to 120000 ms")
                }),
        };
        let ssh_program = env
            .get("SWITCHBOARD_SSH_PROGRAM")
            .map(String::as_str)
            .unwrap_or("ssh")
            .trim()
            .to_owned();
        Self {
            registry,
            pi_binary,
            ssh_program,
            operator_model,
            operator_system_prompt,
            operator_extension,
            agent_extension_file,
            agent_model,
            agent_thinking,
            remote_cache_dir,
            model_swaps,
            speak_url,
            state_url,
            diagram_url,
            persona,
            env,
            speech_deadline_ms,
            activity_callback: None,
            route_callback: None,
            active_session: Arc::new(Mutex::new(None)),
            route: OPERATOR.into(),
            project: None,
            operator: None,
            agent: None,
            model_spec: String::new(),
            session_id: String::new(),
            live_leg: LiveLegState::new(),
            catalogs: HashMap::new(),
            staged_extensions: Mutex::new(HashMap::new()),
            operator_note: None,
            last_activity: ActivityClock::new(),
            coordinator: None,
            prewarm: None,
        }
    }
    pub fn set_prewarm(&mut self, prewarm: Arc<crate::prewarm::Prewarm>) {
        self.prewarm = Some(prewarm);
    }
    pub fn set_coordinator(&mut self, coordinator: Coordinator) {
        self.coordinator = Some(coordinator);
    }
    pub fn set_activity_callback(&mut self, callback: Option<ActivityCallback>) {
        self.activity_callback = callback;
    }

    pub fn set_route_callback(&mut self, callback: Option<RouteCallback>) {
        self.route_callback = callback;
    }

    async fn announce_route(&self) {
        if let Some(callback) = &self.route_callback {
            let callback = Arc::clone(callback);
            let status = self.status();
            if let Err(panic) = AssertUnwindSafe(callback(status)).catch_unwind().await {
                tracing::error!(
                    route = %self.route,
                    panic = %crate::pi_client::panic_message(&panic),
                    "route callback panicked; the page may show a stale leg"
                );
            }
        }
    }

    fn rollback_startup(&self, reason: impl Into<String>) {
        let Some(coordinator) = &self.coordinator else {
            return;
        };
        if !coordinator.rollback_startup(reason) {
            return;
        }
        let status = coordinator.status_json();
        let route = status["route"].as_str().unwrap_or(OPERATOR);
        let identity = coordinator.current_identity();
        self.live_leg.set_session(
            route,
            if route == OPERATOR {
                ""
            } else {
                &identity.token
            },
        );
    }

    pub fn session_control(&self) -> Arc<Mutex<Option<PiSession>>> {
        Arc::clone(&self.active_session)
    }

    async fn set_active_session(&self, session: Option<PiSession>) {
        *self.active_session.lock().await = session;
    }

    pub fn route(&self) -> &str {
        &self.route
    }
    pub fn activity_clock(&self) -> ActivityClock {
        self.last_activity.clone()
    }
    pub fn live_leg_state(&self) -> LiveLegState {
        self.live_leg.clone()
    }
    pub fn touch_activity(&self) {
        self.last_activity.touch();
    }
    pub fn status(&self) -> serde_json::Value {
        let spec = if self.route == OPERATOR {
            self.operator_model.clone().unwrap_or_default()
        } else {
            self.model_spec.clone()
        };
        let (provider, model, requested) = crate::models::parse_spec(&spec);
        let model_name = if provider.is_empty() {
            model.clone()
        } else {
            format!("{provider}/{model}")
        };
        let effective = self.live_leg.effective_thinking();
        let (models, models_available, models_diagnostic) = if self.route == OPERATOR {
            (Vec::new(), true, None)
        } else if let Some(project) = &self.project {
            let key = crate::models::CatalogKey::for_project(project).to_key_string();
            self.catalogs
                .get(&key)
                .map(|catalog| {
                    (
                        catalog
                            .entries
                            .iter()
                            .map(|entry| {
                                serde_json::json!({
                                    "provider": entry.provider,
                                    "model": entry.model,
                                    "thinks": entry.thinks,
                                })
                            })
                            .collect::<Vec<_>>(),
                        catalog.available,
                        catalog.diagnostic.clone(),
                    )
                })
                .unwrap_or_else(|| {
                    (
                        Vec::new(),
                        false,
                        Some("model catalog has not been loaded".into()),
                    )
                })
        } else {
            (Vec::new(), false, Some("no project is connected".into()))
        };
        serde_json::json!({"type":"status", "route":self.route, "label":self.route_label(), "model":spec, "model_name":model_name, "thinking":if effective.is_empty() { requested.clone() } else { effective.clone() }, "thinking_requested":requested, "thinking_confirmed":!effective.is_empty(), "thinking_default":self.agent_thinking, "levels":THINKING_LEVELS, "models":models, "models_available":models_available, "models_diagnostic":models_diagnostic, "model_swaps":self.model_swaps, "projects":self.registry.ids()})
    }
    pub fn route_label(&self) -> String {
        if self.route == OPERATOR {
            "Operator".into()
        } else {
            self.project
                .as_ref()
                .map(|p| p.id.clone())
                .unwrap_or_else(|| self.route.clone())
        }
    }
    pub fn report_leg_state(&self, token: &str, thinking: &str) -> bool {
        self.live_leg.report_thinking(token, thinking)
    }
    pub async fn shutdown(&mut self) {
        if let Some(session) = self.agent.take() {
            session.close().await;
        }
        if let Some(session) = self.operator.take() {
            session.close().await;
        }
        self.set_active_session(None).await;
        if let Some(prewarm) = self.prewarm.take() {
            prewarm.shutdown().await;
        }
    }
    fn active(&self) -> Option<&PiSession> {
        if self.route == OPERATOR {
            self.operator.as_ref()
        } else {
            self.agent.as_ref()
        }
    }

    pub async fn handle(&mut self, text: &str) -> Reply {
        let context = TransferContext {
            exact_caller_transcript: text.to_owned(),
            derived_intent: String::new(),
            direct_page_transfer_context: None,
            selected_project_id: None,
            return_operator_note: None,
            project_summary: None,
        };
        self.handle_ctx(&context).await
    }

    pub async fn handle_ctx(&mut self, context: &TransferContext) -> Reply {
        self.touch_activity();
        let reply = if self.route == OPERATOR {
            self.handle_operator_ctx(context).await
        } else {
            self.handle_agent_ctx(context).await
        };
        self.touch_activity();
        reply
    }
    pub async fn steer_if_busy(&self, text: &str) -> bool {
        let Some(session) = self.active() else {
            return false;
        };
        if !session.busy() || !session.alive().await {
            return false;
        }
        let steered = match session.steer(text).await {
            Ok(()) => true,
            Err(error) => {
                tracing::info!(route = %self.route, %error, "could not steer; queueing the utterance");
                false
            }
        };
        if steered {
            self.touch_activity();
        }
        steered
    }
    async fn ensure_operator(&mut self) -> Result<&PiSession, PiSessionError> {
        let alive = match self.operator.as_ref() {
            Some(session) => session.alive().await,
            None => false,
        };
        if !alive {
            if let Some(session) = self.operator.take() {
                // The operator is the home base and is meant to outlive every
                // project leg, so it dying between calls is worth a line even
                // though the restart below hides it from the caller.
                tracing::warn!(
                    stderr_lines = session.stderr_tail(5).lines().count(),
                    "operator process died; restarting"
                );
                session.close().await;
            }
        }
        if self.operator.is_none() {
            let catalog = self.registry.operator_prompt_catalog();
            let argv = local_argv(
                &self.pi_binary,
                self.operator_model.as_deref(),
                Some(std::path::Path::new(&self.operator_system_prompt)).filter(|p| p.exists()),
                Some(&catalog),
                self.operator_extension.as_deref(),
                &["--no-builtin-tools".into(), "--no-session".into()],
            )?;
            let session = PiSession::start(
                argv,
                OPERATOR,
                None,
                Some(self.env.clone()),
                Duration::from_secs(180),
                self.activity_callback.clone(),
            )
            .await?;
            self.operator = Some(session);
            self.set_active_session(self.operator.clone()).await;
        }
        self.operator
            .as_ref()
            .ok_or_else(|| PiSessionError("operator session was not created".into()))
    }
    async fn handle_operator_ctx(&mut self, context: &TransferContext) -> Reply {
        let session = match self.ensure_operator().await {
            Ok(session) => session.clone(),
            Err(e) => {
                tracing::error!(error = %e, "operator unavailable");
                return self.reply(
                    [format!("The operator is not answering: {e}")],
                    Some(e.to_string()),
                );
            }
        };
        let message = self.operator_note.take().map_or_else(
            || context.exact_caller_transcript.clone(),
            |note| {
                format!(
                    "[switchboard] {note}\n\n{}",
                    context.exact_caller_transcript
                )
            },
        );
        let turn = match session.prompt(&message).await {
            Ok(turn) => turn,
            Err(error) => {
                tracing::warn!(route = %self.route, %error, "the operator leg failed mid-prompt");
                return self.recover_operator(error.to_string()).await;
            }
        };
        if turn.failed && turn.text.is_empty() {
            let error = if turn.error.is_empty() {
                let tail = session.stderr_tail(5);
                if tail.is_empty() {
                    "operator turn failed".to_owned()
                } else {
                    tail
                }
            } else {
                turn.error
            };
            return self.recover_operator(error).await;
        }
        if let Some(signal) = turn.signals.iter().find(|s| s.name == TRANSFER_TOOL) {
            let mut onward_ctx = context.clone();
            onward_ctx.derived_intent = arg(signal, "intent");
            onward_ctx.selected_project_id = Some(arg(signal, "project"));
            return self
                .transfer_ctx(
                    &onward_ctx,
                    &arg(signal, "project"),
                    &arg(signal, "model"),
                    &arg(signal, "thinking"),
                )
                .await;
        }
        self.reply([turn.text], None)
    }

    async fn handle_agent_ctx(&mut self, context: &TransferContext) -> Reply {
        let Some(session) = self.agent.clone() else {
            tracing::warn!(route = %self.route, "the project leg is gone; returning to the operator");
            return self
                .return_operator_ctx(context, "project session is gone")
                .await;
        };
        let turn = match session.prompt(&context.exact_caller_transcript).await {
            Ok(t) => t,
            Err(error) => {
                let detail = error.to_string();
                let name = self.route_label();
                tracing::warn!(route = %self.route, %error, "the project leg failed mid-prompt; returning to the operator");
                self.drop_agent().await;
                self.operator_note = Some(format!("The call to {name} ended: {detail}"));
                return self.reply(
                    [format!(
                        "{name} stopped responding: {detail}. You're back with the operator."
                    )],
                    Some(detail),
                );
            }
        };
        let returning = turn.signals.iter().any(|s| s.name == RETURN_TOOL);
        let transfer = turn.signals.iter().find(|s| s.name == TRANSFER_TOOL);
        if turn.failed && turn.text.is_empty() && !returning && transfer.is_none() {
            let detail = if turn.error.is_empty() {
                session.stderr_tail(5)
            } else {
                turn.error.clone()
            };
            let detail = if detail.is_empty() {
                "agent turn failed".to_owned()
            } else {
                detail
            };
            let name = self.route_label();
            tracing::warn!(route = %self.route, %detail, "the project leg failed its turn; returning to the operator");
            self.drop_agent().await;
            self.operator_note = Some(format!("The call to {name} ended: {detail}"));
            return self.reply(
                [format!(
                    "{name} stopped responding: {detail}. You're back with the operator."
                )],
                Some(detail),
            );
        }
        if let Some(signal) = transfer {
            let mut onward_ctx = context.clone();
            onward_ctx.derived_intent = arg(signal, "intent");
            onward_ctx.selected_project_id = Some(arg(signal, "project"));
            let onward = self
                .transfer_ctx(
                    &onward_ctx,
                    &arg(signal, "project"),
                    &arg(signal, "model"),
                    &arg(signal, "thinking"),
                )
                .await;
            if onward.error.is_none() && onward.route != OPERATOR {
                return onward;
            }
            return self.prepend(turn, onward);
        }
        if !returning {
            if let Some(signal) = turn.signals.iter().find(|s| s.name == SET_MODEL_TOOL) {
                let mut reply = if self.model_swaps {
                    self.redial(
                        &arg(signal, "model"),
                        &arg(signal, "thinking"),
                        &arg(signal, "intent"),
                        arg_bool(signal, "keep_context", true),
                    )
                    .await
                } else {
                    self.reply(["Model swapping is turned off on this switchboard."], None)
                };
                self.prepend_utterance(&turn.text, false, &mut reply);
                return reply;
            }
        }
        if returning {
            let text = turn.text.clone();
            let synthesize = !turn.agent_spoke();
            let summary = turn
                .signals
                .iter()
                .find(|signal| signal.name == RETURN_TOOL)
                .map(|signal| arg(signal, "summary"))
                .filter(|summary| !summary.trim().is_empty())
                .map(|summary| format!(" Summary from that agent: {summary}"))
                .unwrap_or_default();
            let mut reply = self
                .return_operator_ctx(
                    context,
                    &format!(
                        "The caller was handed back from {}.{summary}",
                        self.route_label()
                    ),
                )
                .await;
            self.prepend_utterance(&text, synthesize && reply.route == OPERATOR, &mut reply);
            return reply;
        }
        self.reply_with_turn(turn)
    }
    pub async fn transfer_direct_page(&mut self, spoken: &str, page_context: &str) -> Reply {
        let context = TransferContext {
            exact_caller_transcript: String::new(),
            derived_intent: String::new(),
            direct_page_transfer_context: Some(page_context.to_owned()),
            selected_project_id: Some(spoken.to_owned()),
            return_operator_note: None,
            project_summary: None,
        };
        self.transfer_ctx(&context, spoken, "", "").await
    }

    pub async fn transfer(
        &mut self,
        spoken: &str,
        intent: &str,
        _handoff: String,
        requested_model: &str,
        requested_thinking: &str,
    ) -> Reply {
        let context = TransferContext {
            exact_caller_transcript: String::new(),
            derived_intent: intent.to_owned(),
            direct_page_transfer_context: None,
            selected_project_id: Some(spoken.to_owned()),
            return_operator_note: None,
            project_summary: None,
        };
        self.transfer_ctx(&context, spoken, requested_model, requested_thinking)
            .await
    }

    pub async fn transfer_ctx(
        &mut self,
        context: &TransferContext,
        spoken: &str,
        requested_model: &str,
        requested_thinking: &str,
    ) -> Reply {
        let project = match self.registry.resolve_detailed(spoken) {
            crate::registry::ResolveResult::Exact(project) => project.clone(),
            crate::registry::ResolveResult::Ambiguous(candidates) => {
                let candidates_text = candidates.join(", ");
                let from = (self.route != OPERATOR).then(|| self.route_label());
                if from.is_some() {
                    self.drop_agent().await;
                }
                self.operator_note = Some(format!(
                    "Transfer to {spoken:?} was ambiguous. Candidates: {candidates_text}.{}",
                    from.map(|name| format!(" The caller was on {name}."))
                        .unwrap_or_default()
                ));
                return self.reply_transfer_error(
                    format!(
                        "Which project did you mean by {spoken}? Candidates: {candidates_text}."
                    ),
                    Some(format!("ambiguous project {spoken:?}: {candidates_text}")),
                );
            }
            crate::registry::ResolveResult::Unknown => {
                let known = self.registry.ids();
                let known_text = if known.is_empty() {
                    "nothing yet".to_owned()
                } else {
                    known.join(", ")
                };
                let from = (self.route != OPERATOR).then(|| self.route_label());
                if from.is_some() {
                    self.drop_agent().await;
                }
                self.operator_note = Some(format!(
                    "Transfer to {spoken:?} failed. Known projects: {known_text}.{}",
                    from.map(|name| format!(" The caller was on {name}."))
                        .unwrap_or_default()
                ));
                return self.reply_transfer_error(
                    format!("I don't have a project called {spoken}. I know: {known_text}."),
                    Some(format!("unknown project {spoken:?}")),
                );
            }
        };

        tracing::info!(
            from = %self.route,
            to = %project.id,
            host = project.canonical_host().unwrap_or("<local>"),
            cwd = %project.cwd,
            transcript_len = context.exact_caller_transcript.len(),
            "transferring caller"
        );

        let previous_agent = self.agent.clone();

        let (readiness, _prepared_legacy) = if let Some(prewarm) = &self.prewarm {
            match prewarm.await_project(&project).await {
                Ok(r) => (Some(r), String::new()),
                Err(err) => {
                    tracing::warn!(project = %project.id, error = %err, "prewarm readiness failed");
                    self.operator_note = Some(format!("Transfer to {} failed: {err}", project.id));
                    return self.reply_transfer_error(
                        format!("I couldn't get {} on the line: {err}", project.id),
                        Some(err),
                    );
                }
            }
        } else {
            let prepared = self.run_prepare(&project).await;
            self.load_catalog(&project).await;
            (None, prepared)
        };

        let catalog_ref = readiness.as_ref().and_then(|r| r.catalog.as_ref());
        let model = match self
            .select_transfer_model_resolved(
                &project,
                catalog_ref,
                requested_model,
                requested_thinking,
            )
            .await
        {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(project = %project.id, error = %e, "transfer model selection failed");
                self.operator_note = Some(format!("Transfer to {} failed: {e}", project.id));
                return self.reply_transfer_error(
                    format!("I couldn't get {} on the line: {e}", project.id),
                    Some(e),
                );
            }
        };

        let session_id = uuid_like();
        let leg_token = uuid_like();

        if let Some(coordinator) = &self.coordinator {
            let candidate = CandidateLeg::new(
                project.id.clone(),
                project.id.clone(),
                session_id.clone(),
                leg_token.clone(),
                model.clone(),
                self.agent_thinking.clone(),
            );
            let candidate = match catalog_ref {
                Some(catalog) => candidate.with_catalog(catalog.clone()),
                None => candidate,
            };
            if let Err(error) = coordinator.begin_candidate(candidate) {
                tracing::warn!(project = %project.id, %error, "candidate startup was refused");
                return self.reply_transfer_error(
                    format!("I couldn't get {} on the line: {error}", project.id),
                    Some(error.to_string()),
                );
            }
        }

        let client_options = if let Some(r) = &readiness {
            if project.is_remote() {
                let prewarm = self.prewarm.as_ref().unwrap();
                match prewarm.client_for(project.canonical_host().unwrap(), r.transport_generation)
                {
                    Ok(opts) => Some(opts),
                    Err(e) => {
                        self.rollback_startup(format!("transport options failed: {e}"));
                        self.operator_note =
                            Some(format!("Transfer to {} failed: {e}", project.id));
                        return self.reply_transfer_error(
                            format!("I couldn't get {} on the line: {e}", project.id),
                            Some(e),
                        );
                    }
                }
            } else {
                None
            }
        } else {
            None
        };

        // A prewarm artifact decision only overrides remote staging. Local
        // projects still use the configured local extension file selected by
        // `start_agent_with_options`.
        let extension_override: Option<Option<&str>> = if project.is_remote() {
            readiness.as_ref().map(|r| match &r.artifact_decision {
                crate::prewarm::ArtifactDecision::Ready(p) => Some(p.as_str()),
                crate::prewarm::ArtifactDecision::Sentinel(_)
                | crate::prewarm::ArtifactDecision::None => None,
            })
        } else {
            None
        };

        let session = match self
            .start_agent_with_options(
                &project,
                &model,
                &session_id,
                &leg_token,
                client_options.as_ref(),
                extension_override,
            )
            .await
        {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(
                    project = %project.id,
                    host = project.canonical_host().unwrap_or("<local>"),
                    error = %e,
                    "could not connect to project"
                );
                if readiness.is_none() && project.is_remote() {
                    self.rollback_staged_extension(
                        project.canonical_host().unwrap_or_default(),
                        &leg_token,
                    )
                    .await;
                }
                self.rollback_startup(format!("startup failed: {e}"));
                self.set_active_session(previous_agent.clone()).await;
                self.operator_note = Some(format!("Transfer to {} failed: {e}", project.id));
                return self.reply_transfer_error(
                    format!("I couldn't get {} on the line: {e}", project.id),
                    Some(e.to_string()),
                );
            }
        };

        self.set_active_session(Some(session.clone())).await;

        let prepare_rep = readiness.as_ref().and_then(|r| r.prepare_report.as_ref());
        let intro_prompt = build_intro_prompt(context, &project, prepare_rep);

        let turn = match session.prompt(&intro_prompt).await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(project = %project.id, error = %e, "intro prompt to project failed");
                Turn {
                    text: String::new(),
                    signals: vec![],
                    failed: true,
                    error: e.to_string(),
                }
            }
        };

        if turn.failed && turn.text.is_empty() {
            let detail = if !turn.error.trim().is_empty() {
                turn.error
            } else {
                let tail = session.stderr_tail(5);
                if tail.is_empty() {
                    "the agent never answered".to_owned()
                } else {
                    tail
                }
            };
            tracing::error!(project = %project.id, %detail, "project intro turn failed");
            session.close().await;
            if readiness.is_none() && project.is_remote() {
                self.rollback_staged_extension(
                    project.canonical_host().unwrap_or_default(),
                    &leg_token,
                )
                .await;
            }
            self.set_active_session(previous_agent.clone()).await;
            self.rollback_startup(format!("intro failed: {detail}"));
            self.operator_note = Some(format!("Transfer to {} failed: {detail}", project.id));
            return self.reply_transfer_error(
                format!("{} didn't pick up: {detail}", project.id),
                Some(detail),
            );
        }

        if let Some(coordinator) = &self.coordinator {
            if coordinator.is_candidate() {
                if let Err(error) = coordinator.adopt_candidate() {
                    session.close().await;
                    self.set_active_session(previous_agent.clone()).await;
                    if readiness.is_none() && project.is_remote() {
                        self.rollback_staged_extension(
                            project.canonical_host().unwrap_or_default(),
                            &leg_token,
                        )
                        .await;
                    }
                    self.rollback_startup(format!("adoption failed: {error}"));
                    return self.reply_transfer_error(
                        format!("{} did not come up.", project.id),
                        Some(error.to_string()),
                    );
                }
            }
            coordinator.finish_intro();
        }

        if readiness.is_none() && project.is_remote() {
            self.commit_staged_extension(project.canonical_host().unwrap_or_default(), &leg_token)
                .await;
        }

        if let Some(previous) = self.agent.take() {
            previous.close().await;
        }
        self.project = Some(project.clone());
        self.route = project.id.clone();
        self.live_leg.set_session(&self.route, &leg_token);
        self.model_spec = model.clone();
        self.session_id = session_id.clone();
        self.agent = Some(session);
        self.set_active_session(self.agent.clone()).await;
        self.announce_route().await;
        self.reply_with_transfer_turn(turn)
    }
    async fn start_agent_with_options(
        &self,
        project: &Project,
        model: &str,
        session_id: &str,
        leg_token: &str,
        client_options: Option<&crate::pi_client::SshClientOptions>,
        extension_override: Option<Option<&str>>,
    ) -> Result<PiSession, PiSessionError> {
        let mut env = self.env.clone();
        let agent_env = self.agent_env(leg_token);
        env.extend(agent_env.clone());
        let extension = if let Some(ext) = extension_override {
            ext.map(str::to_owned)
        } else if project.is_remote() {
            if project.stage_extension {
                self.stage_extension(project.canonical_host().unwrap_or_default(), leg_token)
                    .await
            } else {
                None
            }
        } else {
            self.agent_extension_file
                .as_deref()
                .filter(|path| Path::new(path).is_file())
                .map(str::to_owned)
        };
        // If staging is unavailable, omit -e deliberately. The brief then
        // instructs the runtime to use the RETURN sentinel rather than lying
        // about a tool that never loaded.
        let brief = self.agent_brief(project, extension.is_some());
        let argv = if project.is_remote() {
            if let Some(opts) = client_options {
                opts.remote_argv(
                    &project.cwd,
                    &project.runtime,
                    (!model.is_empty()).then_some(model),
                    extension.as_deref(),
                    Some(&brief),
                    Some(session_id),
                    &project.extra_args,
                    &agent_env,
                )
            } else {
                remote_argv_with_program(
                    &self.ssh_program,
                    project.canonical_host().unwrap_or_default(),
                    &project.cwd,
                    &project.runtime,
                    (!model.is_empty()).then_some(model),
                    extension.as_deref(),
                    Some(&brief),
                    Some(session_id),
                    &project.extra_args,
                    &agent_env,
                )
            }
        } else {
            let mut a = vec![project.runtime.clone(), "--mode".into(), "rpc".into()];
            if !model.is_empty() {
                a.extend(["--model".into(), model.into()]);
            }
            a.extend([
                "--session-id".into(),
                session_id.into(),
                "--append-system-prompt".into(),
                brief,
            ]);
            if let Some(ext) = extension {
                a.extend(["-e".into(), ext]);
            }
            a.extend(project.extra_args.clone());
            a
        };
        PiSession::start(
            argv,
            project.id.clone(),
            (!project.is_remote())
                .then(|| project.cwd.clone())
                .filter(|p| !p.is_empty()),
            Some(env),
            Duration::from_secs(600),
            self.activity_callback.clone(),
        )
        .await
    }
    fn agent_brief(&self, project: &Project, has_tool: bool) -> String {
        let mut brief = AGENT_BRIEF_HEADER.replace("{project}", &project.id);
        brief.push_str(if has_tool {
            SPEAK_BRIEF
        } else {
            FALLBACK_BRIEF
        });
        if has_tool {
            brief.push_str(" When the caller asks for the operator, call return_to_operator; if the extension cannot be used, end with ");
            brief.push_str(RETURN_SENTINEL);
            brief.push_str(". If they ask for another project, use transfer_to_project and pass their request as intent. Known direct transfer targets:\n");
            let others = self
                .registry
                .projects
                .iter()
                .filter(|candidate| candidate.id != project.id)
                .map(|candidate| {
                    format!(
                        "- {} — {}",
                        candidate.id,
                        if candidate.description.is_empty() {
                            "no description"
                        } else {
                            candidate.description.as_str()
                        }
                    )
                })
                .collect::<Vec<_>>();
            brief.push_str(
                if others.is_empty() {
                    "- none".to_owned()
                } else {
                    others.join("\n")
                }
                .as_str(),
            );
            brief.push_str(". If the requested project is not listed, return to the operator rather than guessing.");
            if self.model_swaps {
                brief.push_str(" If the caller asks to change model or thinking level, use set_model; pass the provider/model when known and keep_context unless they ask to start over. Do not claim a swap happened beside that tool call.");
            }
        } else {
            brief.push_str(" When the caller asks for the operator, end with ");
            brief.push_str(RETURN_SENTINEL);
            brief.push_str(". Do not claim that a switchboard tool is available.");
        }
        brief.push_str(" Keep spoken updates brief and plain; leave code, paths, and detail in written output.");
        brief
    }

    async fn run_prepare(&self, project: &Project) -> String {
        if project.prepare.is_empty() {
            return String::new();
        }
        let mut command = if project.is_remote() {
            let host = match ValidatedSshTarget::new(project.canonical_host().unwrap_or_default()) {
                Ok(host) => host,
                Err(error) => {
                    tracing::warn!(project = %project.id, %error, "refusing invalid SSH target");
                    return "could not be refreshed (invalid SSH target)".into();
                }
            };
            let remote = format!(
                "cd {} && {}",
                crate::pi_client::shell_quote(&project.cwd),
                project.prepare
            );
            let options = crate::pi_client::SshClientOptions::new(&self.ssh_program, host);
            options.remote_command(&remote)
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", project.prepare.as_str()]);
            if !project.cwd.is_empty() {
                command.current_dir(&project.cwd);
            }
            command
        };
        command
            .envs(&self.env)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        crate::pi_client::isolate_process(&mut command);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                tracing::warn!(project = %project.id, %error, "prepare could not start");
                return String::new();
            }
        };
        let process_guard = crate::pi_client::ProcessTreeGuard::new(&child);
        let stdout_task = child.stdout.take().map(|mut output| {
            tokio::spawn(async move {
                crate::pi_client::drain_bounded(&mut output, PREPARE_OUTPUT_LIMIT).await
            })
        });
        let stderr_task = child.stderr.take().map(|mut output| {
            tokio::spawn(async move {
                crate::pi_client::drain_bounded(&mut output, CHILD_ERROR_LIMIT).await
            })
        });
        let status = match timeout(Duration::from_secs(120), child.wait()).await {
            Ok(Ok(status)) => {
                process_guard.disarm();
                status
            }
            Ok(Err(error)) => {
                tracing::warn!(project = %project.id, %error, "prepare failed");
                crate::pi_client::terminate_process(&mut child).await;
                process_guard.disarm();
                abort_output(stdout_task);
                abort_output(stderr_task);
                return String::new();
            }
            Err(_) => {
                tracing::warn!(project = %project.id, "prepare timed out");
                crate::pi_client::terminate_process(&mut child).await;
                process_guard.disarm();
                abort_output(stdout_task);
                abort_output(stderr_task);
                return String::new();
            }
        };
        let stdout = join_output(stdout_task).await;
        let stderr = join_output(stderr_task).await;
        if stdout.truncated {
            tracing::warn!(project = %project.id, "prepare output exceeded the size limit");
            return "workspace refresh output was too large".into();
        }
        let report = String::from_utf8_lossy(&stdout.bytes).trim().to_owned();
        if !status.success() {
            tracing::warn!(
                project = %project.id,
                code = ?status.code(),
                stderr_bytes = stderr.bytes.len(),
                "prepare exited unsuccessfully"
            );
            return if report.is_empty() {
                "could not be refreshed (prepare command failed)".into()
            } else {
                report
            };
        }
        if !report.is_empty() {
            tracing::info!(project = %project.id, bytes = report.len(), "prepare reported the state of the working copy");
        }
        report
    }

    async fn stage_extension(&self, host: &str, candidate_token: &str) -> Option<String> {
        // Each candidate gets a private remote path. Never reuse an adopted
        // leg's artifact, because rollback of a failed candidate must not
        // remove the live extension.
        let key = format!("{host}\0{candidate_token}");
        let staged = self.upload_extension(&key, host).await;
        self.staged_extensions
            .lock()
            .await
            .insert(key, staged.clone());
        staged
    }

    async fn upload_extension(&self, key: &str, host: &str) -> Option<String> {
        self.upload_extension_with_key(&self.ssh_program, key, host)
            .await
    }

    async fn commit_staged_extension(&self, host: &str, candidate_token: &str) {
        let key = format!("{host}\0{candidate_token}");
        let path = self.staged_extensions.lock().await.remove(&key).flatten();
        let Some(path) = path else { return };
        let Ok(target) = ValidatedSshTarget::new(host) else {
            return;
        };
        ExtensionStageTxn::new(&self.ssh_program, target, path).commit();
    }

    async fn rollback_staged_extension(&self, host: &str, candidate_token: &str) {
        let key = format!("{host}\0{candidate_token}");
        let path = self.staged_extensions.lock().await.remove(&key).flatten();
        let Some(path) = path else { return };
        let Ok(target) = ValidatedSshTarget::new(host) else {
            return;
        };
        let txn = ExtensionStageTxn::new(&self.ssh_program, target, path);
        if let Err(error) = txn.rollback().await {
            tracing::warn!(host, %error, "stage cleanup is unverified");
        }
    }

    #[cfg(test)]
    async fn upload_extension_with(&self, ssh_program: &str, host: &str) -> Option<String> {
        self.upload_extension_with_key(ssh_program, host, host)
            .await
    }

    async fn upload_extension_with_key(
        &self,
        ssh_program: &str,
        key: &str,
        host: &str,
    ) -> Option<String> {
        let host = match ValidatedSshTarget::new(host) {
            Ok(host) => host,
            Err(error) => {
                tracing::warn!(%error, "refusing invalid SSH target for extension staging");
                return None;
            }
        };
        // Silently returning None here costs the agent its `speak` and
        // `diagram` tools and quietly rewrites its system prompt to use the
        // sentinel instead — a large behavior change from one unset path.
        let Some(source) = self.agent_extension_file.as_deref() else {
            tracing::warn!(
                host = host.as_str(),
                "no agent extension file to stage; using sentinel fallback"
            );
            return None;
        };
        let contents = match tokio::fs::read(source).await {
            Ok(contents) => contents,
            Err(error) => {
                tracing::warn!(%error, source, host = host.as_str(), "could not read project extension; using sentinel fallback");
                return None;
            }
        };
        let source_path = Path::new(source);
        let key_safe = key.replace('\0', "-");
        let cache = self.remote_cache_dir.trim_end_matches('/');
        let target = match (source_path.file_stem(), source_path.extension()) {
            (Some(stem), Some(ext)) if !ext.is_empty() => {
                format!(
                    "{cache}/{}.{key_safe}.{}",
                    stem.to_string_lossy(),
                    ext.to_string_lossy()
                )
            }
            _ => {
                let name = source_path.file_name()?.to_string_lossy();
                format!("{cache}/{name}.{key_safe}")
            }
        };
        let cache_path = if cache.starts_with('/') {
            crate::pi_client::shell_quote(cache)
        } else {
            format!("\"$HOME\"/{}", crate::pi_client::shell_quote(cache))
        };
        let target_path = if target.starts_with('/') {
            crate::pi_client::shell_quote(&target)
        } else {
            format!("\"$HOME\"/{}", crate::pi_client::shell_quote(&target))
        };
        let command = format!(
            "set -e; mkdir -p {cache_path}; cat > {target_path}; printf '%s' {target_path}"
        );
        let options = crate::pi_client::SshClientOptions::new(ssh_program, host.clone());
        let mut stage_command = options.remote_command(&command);
        stage_command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        crate::pi_client::isolate_process(&mut stage_command);
        let mut child = match stage_command.spawn() {
            Ok(child) => child,
            Err(error) => {
                tracing::warn!(%error, host = host.as_str(), "could not stage project extension; using sentinel fallback");
                return None;
            }
        };
        let process_guard = crate::pi_client::ProcessTreeGuard::new(&child);
        let mut stdin = child.stdin.take();
        let stdout_task = child.stdout.take().map(|mut output| {
            tokio::spawn(async move {
                crate::pi_client::drain_bounded(&mut output, STAGE_OUTPUT_LIMIT).await
            })
        });
        let stderr_task = child.stderr.take().map(|mut output| {
            tokio::spawn(async move {
                crate::pi_client::drain_bounded(&mut output, CHILD_ERROR_LIMIT).await
            })
        });
        let interaction = async {
            if let Some(mut input) = stdin.take() {
                match input.write_all(&contents).await {
                    Ok(()) => {}
                    // The remote stopped reading, which normally means the
                    // staging command already failed. Its exit status and
                    // stderr name the real cause -- a missing directory, a
                    // permission denial -- and that is what the warning below
                    // should carry, not the broken pipe it caused.
                    Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => {}
                    Err(error) => return Err(error),
                }
                drop(input);
            }
            child.wait().await
        };
        let status = match timeout(Duration::from_secs(30), interaction).await {
            Ok(Ok(status)) => {
                process_guard.disarm();
                status
            }
            Ok(Err(error)) => {
                tracing::warn!(%error, host = host.as_str(), "remote extension staging failed; using sentinel fallback");
                crate::pi_client::terminate_process(&mut child).await;
                process_guard.disarm();
                abort_output(stdout_task);
                abort_output(stderr_task);
                return None;
            }
            Err(_) => {
                tracing::warn!(
                    host = host.as_str(),
                    "remote extension staging timed out; using sentinel fallback"
                );
                crate::pi_client::terminate_process(&mut child).await;
                process_guard.disarm();
                abort_output(stdout_task);
                abort_output(stderr_task);
                return None;
            }
        };
        let stdout = join_output(stdout_task).await;
        let stderr = join_output(stderr_task).await;
        if !status.success() || stdout.truncated {
            let detail = String::from_utf8_lossy(&stderr.bytes)
                .trim()
                .chars()
                .take(300)
                .collect::<String>();
            tracing::warn!(
                ?detail,
                host = host.as_str(),
                code = ?status.code(),
                truncated = stdout.truncated,
                "remote extension staging failed; using sentinel fallback"
            );
            return None;
        }
        let staged = String::from_utf8_lossy(&stdout.bytes).trim().to_owned();
        if staged.is_empty() {
            tracing::warn!(
                host = host.as_str(),
                "remote extension staging reported no path; using sentinel fallback"
            );
            return None;
        }
        tracing::info!(host = host.as_str(), path = %staged, "staged the switchboard tool");
        Some(staged)
    }

    fn agent_env(&self, session_token: &str) -> HashMap<String, String> {
        let mut e = HashMap::from([
            (String::from("SWITCHBOARD_SESSION"), String::from("1")),
            (
                String::from("SWITCHBOARD_SESSION_TOKEN"),
                session_token.to_owned(),
            ),
            (
                String::from("SWITCHBOARD_SPEECH_DEADLINE_MS"),
                self.speech_deadline_ms.to_string(),
            ),
        ]);
        for (key, value) in [
            ("SWITCHBOARD_SPEAK_URL", &self.speak_url),
            ("SWITCHBOARD_STATE_URL", &self.state_url),
            ("SWITCHBOARD_DIAGRAM_URL", &self.diagram_url),
            ("SWITCHBOARD_PERSONA", &self.persona),
        ] {
            if !value.is_empty() {
                e.insert(key.into(), value.clone());
            }
        }
        e
    }
    async fn load_catalog(&mut self, project: &Project) {
        let key = crate::models::CatalogKey::for_project(project).to_key_string();
        if let std::collections::hash_map::Entry::Vacant(e) = self.catalogs.entry(key) {
            let catalog = fetch_catalog(&crate::pi_client::list_models_argv_with_program(
                &self.ssh_program,
                &project.runtime,
                project.canonical_host().unwrap_or(""),
            ))
            .await;
            e.insert(catalog);
        }
    }

    async fn resolve_model(
        &mut self,
        project: &Project,
        model: &str,
        thinking: &str,
    ) -> Result<ModelChoice, ModelError> {
        let requested = if model.is_empty() {
            project
                .model
                .as_deref()
                .or(self.agent_model.as_deref())
                .unwrap_or("")
                .to_owned()
        } else {
            model.to_owned()
        };
        self.load_catalog(project).await;
        let key = crate::models::CatalogKey::for_project(project).to_key_string();
        self.catalogs
            .get(&key)
            .ok_or_else(|| ModelError("the model catalog was unavailable".into()))?
            .resolve(&requested, thinking)
    }

    async fn select_transfer_model_resolved(
        &mut self,
        project: &Project,
        catalog: Option<&ModelCatalog>,
        requested_model: &str,
        requested_thinking: &str,
    ) -> Result<String, String> {
        if !self.model_swaps {
            let fallback = pin_thinking(
                project
                    .model
                    .as_deref()
                    .or(self.agent_model.as_deref())
                    .unwrap_or(""),
                &self.agent_thinking,
            );
            return Ok(fallback);
        }

        self.resolve_model_with_catalog(project, catalog, requested_model, requested_thinking)
            .map(|choice| pin_thinking(&choice.spec(), &self.agent_thinking))
    }

    fn resolve_model_with_catalog(
        &self,
        project: &Project,
        catalog: Option<&ModelCatalog>,
        model: &str,
        thinking: &str,
    ) -> Result<ModelChoice, String> {
        let requested = if model.trim().is_empty() {
            project
                .model
                .as_deref()
                .or(self.agent_model.as_deref())
                .unwrap_or("")
                .to_owned()
        } else {
            model.to_owned()
        };

        if let Some(cat) = catalog {
            cat.resolve(&requested, thinking).map_err(|e| e.to_string())
        } else {
            let (wanted_provider, wanted_model, spec_thinking) =
                crate::models::parse_spec(&requested);
            let level = if thinking.trim().is_empty() {
                spec_thinking
            } else {
                thinking.trim().to_string()
            };
            let level = if level.is_empty() {
                self.agent_thinking.clone()
            } else {
                normalize_thinking(&level).map_err(|e| e.to_string())?
            };
            if requested.is_empty() {
                return Ok(ModelChoice {
                    provider: String::new(),
                    model: String::new(),
                    thinking: level,
                });
            }
            if !wanted_provider.is_empty() {
                Ok(ModelChoice {
                    provider: wanted_provider,
                    model: wanted_model,
                    thinking: level,
                })
            } else {
                Err(format!(
                    "catalog unavailable to resolve bare model {requested:?}"
                ))
            }
        }
    }

    pub async fn select_transfer_model(
        &mut self,
        project: &Project,
        requested_model: &str,
        requested_thinking: &str,
    ) -> (String, String) {
        if self.prewarm.is_none() {
            self.load_catalog(project).await;
        }
        let catalog_key = crate::models::CatalogKey::for_project(project);
        let catalog_ref = if let Some(prewarm) = &self.prewarm {
            prewarm.catalog_snapshot(project)
        } else {
            self.catalogs.get(&catalog_key.to_key_string()).cloned()
        };
        match self
            .select_transfer_model_resolved(
                project,
                catalog_ref.as_ref(),
                requested_model,
                requested_thinking,
            )
            .await
        {
            Ok(m) => (m, String::new()),
            Err(e) => (
                pin_thinking(
                    project
                        .model
                        .as_deref()
                        .or(self.agent_model.as_deref())
                        .unwrap_or(""),
                    &self.agent_thinking,
                ),
                format!("About the model: {e}"),
            ),
        }
    }

    async fn redial(
        &mut self,
        model: &str,
        thinking: &str,
        intent: &str,
        keep_context: bool,
    ) -> Reply {
        let Some(project) = self.project.clone() else {
            return self.reply(["There is no project on the line."], None);
        };
        if !self.model_swaps {
            return self.reply(["Model swapping is turned off on this switchboard."], None);
        }
        // The remote adapter can reap only the local ssh process. With no
        // verified remote shutdown protocol, reusing a persistent session ID
        // could attach to work that is still running on the far host.
        if project.is_remote() && keep_context {
            let name = project.id.clone();
            tracing::warn!(project = %name, "refusing same-session remote redial; remote shutdown is unverified");
            self.drop_agent().await;
            let detail = "remote_shutdown_unverified".to_owned();
            self.operator_note = Some(format!(
                "The call to {name} was closed; I could not verify the remote session stopped."
            ));
            return self.reply(
                [format!("I couldn't safely restart {name}: the remote session could not be verified as stopped. You're back with the operator.")],
                Some(detail),
            );
        }
        let requested_model = if model.is_empty() && !self.model_spec.is_empty() {
            self.model_spec.clone()
        } else {
            model.to_owned()
        };
        let (_, _, current_thinking) = crate::models::parse_spec(&self.model_spec);
        let level = if thinking.is_empty() {
            if !current_thinking.is_empty() {
                current_thinking
            } else {
                self.agent_thinking.clone()
            }
        } else {
            match normalize_thinking(thinking) {
                Ok(v) => v,
                Err(e) => return self.reply([e.to_string()], Some(e.to_string())),
            }
        };
        let choice = match self.resolve_model(&project, &requested_model, &level).await {
            Ok(choice) => choice,
            Err(error) => {
                // Refusing is the safe outcome — the live leg keeps running —
                // but it looks identical to a swap that never happened.
                tracing::info!(project = %project.id, requested = %requested_model, %error, "refusing a model swap");
                return self.reply(
                    [format!("I didn't switch: {error}")],
                    Some(error.to_string()),
                );
            }
        };
        let spec = choice.spec();
        if keep_context && spec == self.model_spec {
            return self.reply([format!("Already on {}.", choice.spoken())], None);
        }
        let session_id = if keep_context {
            self.session_id.clone()
        } else {
            uuid_like()
        };
        tracing::info!(
            project = %project.id,
            from = %self.model_spec,
            to = %spec,
            context = if keep_context { "kept" } else { "cleared" },
            "swapping the model on the live leg"
        );
        let leg_token = uuid_like();
        let _previous_agent = self.agent.clone();
        if let Some(coordinator) = &self.coordinator {
            let catalog_key = crate::models::CatalogKey::for_project(&project).to_key_string();
            let candidate = CandidateLeg::new(
                project.id.clone(),
                project.id.clone(),
                session_id.clone(),
                leg_token.clone(),
                spec.clone(),
                level.clone(),
            );
            let candidate = match self.catalogs.get(&catalog_key).cloned() {
                Some(catalog) => candidate.with_catalog(catalog),
                None => candidate,
            };
            if let Err(error) = coordinator.begin_candidate(candidate) {
                tracing::warn!(project = %project.id, %error, "candidate startup for redial was refused");
                return self.reply(
                    [format!("I couldn't restart {}: {error}", project.id)],
                    Some(error.to_string()),
                );
            }
        }
        let (client_options, extension_override) = if let Some(prewarm) = &self.prewarm {
            match prewarm.await_project(&project).await {
                Ok(readiness) => {
                    let opts = if project.is_remote() {
                        prewarm
                            .client_for(
                                project.canonical_host().unwrap_or_default(),
                                readiness.transport_generation,
                            )
                            .ok()
                    } else {
                        None
                    };
                    let ext = if project.is_remote() {
                        match &readiness.artifact_decision {
                            crate::prewarm::ArtifactDecision::Ready(p) => Some(Some(p.clone())),
                            _ => None,
                        }
                    } else {
                        None
                    };
                    (opts, ext)
                }
                Err(_) => (None, None),
            }
        } else {
            (None, None)
        };

        let session = match self
            .start_agent_with_options(
                &project,
                &spec,
                &session_id,
                &leg_token,
                client_options.as_ref(),
                extension_override.as_ref().map(|opt| opt.as_deref()),
            )
            .await
        {
            Ok(session) => session,
            Err(error) => {
                tracing::error!(project = %project.id, %spec, %error, "could not restart the leg on the new model");
                if project.is_remote() && extension_override.is_none() {
                    self.rollback_staged_extension(
                        project.canonical_host().unwrap_or_default(),
                        &leg_token,
                    )
                    .await;
                }
                self.rollback_startup(format!("startup failed: {error}"));
                self.drop_agent().await;
                let note = format!("{} could not be restarted on {}: {error}", project.id, spec);
                self.operator_note = Some(note);
                return self.reply(
                    [format!(
                        "I couldn't bring {} back on {}: {error}",
                        project.id, spec
                    )],
                    Some(error.to_string()),
                );
            }
        };

        self.set_active_session(Some(session.clone())).await;
        let prompt = if keep_context {
            format!(
                "You are now running on {spec}. Continue the conversation.{}",
                if intent.trim().is_empty() {
                    String::new()
                } else {
                    format!(" The caller also asked: {}.", intent.trim())
                }
            )
        } else {
            format!(
                "You are now running on {spec}. The earlier conversation was deliberately cleared; start fresh.{}",
                if intent.trim().is_empty() {
                    String::new()
                } else {
                    format!(" The caller asked: {}.", intent.trim())
                }
            )
        };

        let turn = match session.prompt(&prompt).await {
            Ok(turn) => turn,
            Err(error) => Turn {
                text: String::new(),
                signals: vec![],
                failed: true,
                error: error.to_string(),
            },
        };
        if turn.failed && turn.text.is_empty() {
            let detail = if turn.error.is_empty() {
                session.stderr_tail(5)
            } else {
                turn.error.clone()
            };
            let detail = if detail.is_empty() {
                "the agent never answered".to_owned()
            } else {
                detail
            };
            tracing::error!(project = %project.id, %spec, %detail, "the swapped leg never answered");
            session.close().await;
            if project.is_remote() && extension_override.is_none() {
                self.rollback_staged_extension(
                    project.canonical_host().unwrap_or_default(),
                    &leg_token,
                )
                .await;
            }
            self.rollback_startup(format!("prompt failed: {detail}"));
            self.drop_agent().await;
            self.operator_note = Some(format!(
                "{} could not be restarted on {spec}: {detail}",
                project.id
            ));
            return self.reply(
                [format!(
                    "{} didn't come back on {spec}: {detail}",
                    project.id
                )],
                Some(detail),
            );
        }

        if let Some(coordinator) = &self.coordinator {
            if coordinator.is_candidate() {
                if let Err(error) = coordinator.adopt_candidate() {
                    session.close().await;
                    if project.is_remote() && extension_override.is_none() {
                        self.rollback_staged_extension(
                            project.canonical_host().unwrap_or_default(),
                            &leg_token,
                        )
                        .await;
                    }
                    self.rollback_startup(format!("adoption failed: {error}"));
                    self.drop_agent().await;
                    return self.reply(
                        [format!("{} did not come up.", project.id)],
                        Some(error.to_string()),
                    );
                }
            }
            coordinator.finish_intro();
        }
        if project.is_remote() && extension_override.is_none() {
            self.commit_staged_extension(project.canonical_host().unwrap_or_default(), &leg_token)
                .await;
        }
        if let Some(previous) = self.agent.take() {
            previous.close().await;
        }
        self.project = Some(project.clone());
        self.route = project.id.clone();
        self.live_leg.set_session(&self.route, &leg_token);
        self.session_id = session_id.clone();
        self.model_spec = spec.clone();
        self.agent = Some(session);
        self.set_active_session(self.agent.clone()).await;
        self.announce_route().await;
        self.reply_with_turn(turn)
    }
    #[allow(dead_code)]
    async fn return_operator(&mut self, note: &str) -> Reply {
        let context = TransferContext {
            exact_caller_transcript: String::new(),
            derived_intent: String::new(),
            direct_page_transfer_context: None,
            selected_project_id: None,
            return_operator_note: Some(note.to_owned()),
            project_summary: None,
        };
        self.return_operator_ctx(&context, note).await
    }

    async fn return_operator_ctx(&mut self, context: &TransferContext, note: &str) -> Reply {
        self.drop_agent().await;
        let note = note.to_owned();
        let reply = self.handle_operator_ctx(context).await;
        if reply.error.is_some() {
            self.operator_note = Some(note);
        }
        if reply.text.is_empty() {
            self.reply(["You're back with the operator."], reply.error)
        } else {
            reply
        }
    }
    async fn recover_operator(&mut self, error: String) -> Reply {
        tracing::warn!(%error, "dropping and rebuilding the operator leg");
        if let Some(s) = self.operator.take() {
            s.close().await;
        }
        self.set_active_session(None).await;
        self.reply(
            ["The operator dropped the line. Say that again and I'll pick it back up."],
            Some(error),
        )
    }
    async fn drop_agent(&mut self) {
        let was = self.route.clone();
        if let Some(s) = self.agent.take() {
            s.close().await;
        }
        self.set_active_session(self.operator.clone()).await;
        self.project = None;
        self.route = OPERATOR.into();
        self.live_leg.set_route(OPERATOR);
        self.model_spec.clear();
        self.session_id.clear();
        if was != OPERATOR {
            self.announce_route().await;
        }
    }
    fn reply<I, S>(&self, texts: I, error: Option<String>) -> Reply
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Reply::new(
            &self.route,
            &self.route_label(),
            texts
                .into_iter()
                .map(|text| Utterance {
                    text: text.into(),
                    synthesize: true,
                })
                .collect(),
            error,
        )
    }
    fn reply_with_turn(&self, turn: Turn) -> Reply {
        let spoke = turn.agent_spoke();
        let failed = turn.failed;
        let error = turn.error;
        let mut reply = Reply::new(
            &self.route,
            &self.route_label(),
            vec![Utterance {
                text: turn.text,
                synthesize: !spoke,
            }],
            failed.then_some(error),
        );
        if let Some(coordinator) = &self.coordinator {
            reply.delivery_generation = Some(coordinator.generation());
        }
        reply
    }
    fn reply_transfer_error(&self, message: String, error: Option<String>) -> Reply {
        Reply::new(
            &self.route,
            &self.route_label(),
            vec![Utterance {
                text: message,
                synthesize: true,
            }],
            error,
        )
    }

    fn reply_with_transfer_turn(&self, turn: Turn) -> Reply {
        let spoke = turn.agent_spoke();
        let failed = turn.failed;
        let error = turn.error;
        let mut reply = Reply::new(
            &self.route,
            &self.route_label(),
            vec![Utterance {
                text: turn.text,
                synthesize: !spoke,
            }],
            failed.then_some(error),
        );
        if let Some(coordinator) = &self.coordinator {
            reply.delivery_generation = Some(coordinator.generation());
        }
        reply
    }
    fn prepend(&self, turn: Turn, mut reply: Reply) -> Reply {
        let synthesize = !turn.agent_spoke() && reply.route == OPERATOR;
        self.prepend_utterance(&turn.text, synthesize, &mut reply);
        reply
    }

    fn prepend_utterance(&self, text: &str, synthesize: bool, reply: &mut Reply) {
        if text.is_empty() {
            return;
        }
        reply.text = if reply.text.is_empty() {
            text.to_owned()
        } else {
            format!("{text}\n\n{}", reply.text)
        };
        if synthesize {
            reply.to_speak.insert(0, text.to_owned());
        }
    }
    pub async fn dial(&mut self, project: &str, intent: &str) -> Reply {
        self.force_hangup().await;
        if project.eq_ignore_ascii_case(OPERATOR) {
            return self.reply(["You're back with the operator."], None);
        }
        self.transfer(project, intent, String::new(), "", "").await
    }
    pub async fn force_hangup(&mut self) -> Option<String> {
        self.touch_activity();
        if self.route == OPERATOR {
            if let Some(session) = self.operator.take() {
                tracing::info!("caller hung up a wedged operator turn from the page");
                session.close().await;
                self.set_active_session(None).await;
                return Some(OPERATOR.into());
            }
            return None;
        }
        let left = self.route.clone();
        tracing::info!(%left, "caller hung up the project leg from the page");
        self.drop_agent().await;
        self.operator_note = Some(format!("The caller dropped the line to {left}."));
        Some(left)
    }
    pub async fn return_if_idle(&mut self, seconds: f64) -> Option<String> {
        if seconds <= 0.0 || self.route == OPERATOR || self.last_activity.elapsed() < seconds {
            return None;
        }
        let left = self.route.clone();
        tracing::info!(%left, idle_seconds = self.last_activity.elapsed(), "dropping the idle leg");
        self.drop_agent().await;
        self.operator_note = Some(format!(
            "The caller went quiet, so the line to {left} was dropped."
        ));
        self.touch_activity();
        Some(left)
    }
    pub async fn set_model(&mut self, model: &str) -> Reply {
        if self.route == OPERATOR {
            return self.reply(
                ["Model changes are only available on a project leg."],
                Some("Model changes are only available on a project leg.".into()),
            );
        }
        self.redial(model, "", "", true).await
    }

    pub async fn set_thinking(&mut self, level: &str) -> Reply {
        match normalize_thinking(level) {
            Ok(value) if !value.is_empty() => {
                self.agent_thinking = value.clone();
                if self.route == OPERATOR {
                    return self.reply(
                        [format!(
                            "Thinking is set to {value} for the next project call."
                        )],
                        None,
                    );
                }
                self.redial("", &value, "", true).await
            }
            Ok(_) => self.reply(["Name a thinking level and I'll set it."], None),
            Err(e) => self.reply([e.to_string()], Some(e.to_string())),
        }
    }
}

fn abort_output(task: Option<tokio::task::JoinHandle<crate::pi_client::BoundedOutput>>) {
    if let Some(task) = task {
        task.abort();
    }
}

async fn join_output(
    task: Option<tokio::task::JoinHandle<crate::pi_client::BoundedOutput>>,
) -> crate::pi_client::BoundedOutput {
    match task {
        Some(task) => task.await.unwrap_or_default(),
        None => crate::pi_client::BoundedOutput::default(),
    }
}

fn arg_bool(signal: &Signal, name: &str, default: bool) -> bool {
    signal
        .args
        .get(name)
        .and_then(|value| value.as_bool())
        .unwrap_or(default)
}

fn arg(signal: &Signal, name: &str) -> String {
    signal
        .args
        .get(name)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_owned()
}
pub(crate) fn uuid_like() -> String {
    format!(
        "{:x}-{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id()
    )
}

#[cfg(test)]
#[path = "../tests/test_pbx.rs"]
mod tests;

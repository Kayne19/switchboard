//! Call routing and Pi session lifecycle.
//!
//! The switchboard owns the processes: the operator's and the project leg's
//! `PiSession`s, the session control rescues close, and launching. Which leg
//! is on the line -- route, project, model, session -- belongs to the
//! coordinator (`lifecycle.rs`); the switchboard reads it there and changes it
//! only through the coordinator's transitions. A model or thinking change is
//! decided by `RedialPlanner`, which needs no PBX lock; the switchboard runs
//! the ones that go ahead.
use crate::lifecycle::{CandidateLeg, Coordinator, LifecycleError, ProjectLeg, StatusConfig};
use crate::models::{normalize_thinking, parse_spec, pin_thinking, ModelCatalog};
use crate::pi_client::{
    local_argv, ActivityCallback, PiSession, PiSessionError, Signal, Turn, RETURN_SENTINEL,
    RETURN_TOOL, SET_MODEL_TOOL, TRANSFER_TOOL,
};
use crate::prewarm::{LaunchPlan, Prewarm};
use crate::registry::{Project, Registry};
use futures_util::FutureExt;
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::Duration;

pub const OPERATOR: &str = "operator";
/// Told the switchboard has settled on a leg; it reads which one from the
/// coordinator.
pub type RouteCallback = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

const AGENT_BRIEF_HEADER: &str =
    "You are on a voice call in the {project} project, in its own directory.\n\n";
const SPEAK_BRIEF: &str = "Use the configured speak tool for spoken updates; written output is kept for the caller's screen and is not read aloud.";
const FALLBACK_BRIEF: &str = "No speak extension is available on this host. Write a short spoken reply; the switchboard reads it aloud once your turn settles.";
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

/// What the incoming project leg is told about why the caller is arriving.
#[derive(Clone, Debug, Default)]
pub struct TransferContext {
    /// The caller's words, verbatim; empty when the page connected them.
    pub exact_caller_transcript: String,
    /// The transferring agent's reading of what the caller wants.
    pub derived_intent: String,
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

/// A model or thinking change on the project leg, decided before anything is
/// torn down.
pub enum Redial {
    /// Answered without touching the live leg: a refusal, or, on the
    /// operator, a setting recorded for the next project call.
    Answered(Reply),
    /// A redial that will go ahead; `Switchboard::redial` runs it.
    Planned(Box<RedialPlan>),
}

/// Everything a redial launches with, and the leg it replaces.
pub struct RedialPlan {
    leg: ProjectLeg,
    project: Project,
    spec: String,
    session_id: String,
    keep_context: bool,
    intent: String,
    launch: LaunchPlan,
}

impl RedialPlan {
    /// The leg this redial replaces.
    pub fn leg(&self) -> &ProjectLeg {
        &self.leg
    }

    /// The same redial, for its leg as the rescue that makes way for it left
    /// it (`Coordinator::begin_rescue_of`).
    pub fn rescued(self, leg: ProjectLeg) -> Self {
        Self { leg, ..self }
    }
}

/// Decides model and thinking changes on the project leg without the PBX
/// lock. Everything it reads is the coordinator's leg, a launch plan from
/// prewarm, or a deployment setting, so a page control can refuse a redial
/// without waiting for the turn in flight or cancelling it. The switchboard
/// uses it for the agent's own `set_model`, and the application shares it
/// for the pickers: one set of checks for both.
#[derive(Clone)]
pub struct RedialPlanner {
    coordinator: Coordinator,
    registry: Arc<Registry>,
    prewarm: Arc<Prewarm>,
    agent_model: Option<String>,
    model_swaps: bool,
}

impl RedialPlanner {
    /// The model a leg asks for when the caller named none: the project's
    /// own, else the deployment default.
    fn default_model<'a>(&'a self, project: &'a Project) -> &'a str {
        project
            .model
            .as_deref()
            .or(self.agent_model.as_deref())
            .unwrap_or("")
    }

    fn answer<I, S>(&self, texts: I, error: Option<String>) -> Redial
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Redial::Answered(spoken_reply(&self.coordinator, texts, error))
    }

    /// `/model`: a change of model that keeps the conversation.
    pub async fn model_change(&self, model: &str) -> Redial {
        if self.coordinator.route() == OPERATOR {
            return self.answer(
                ["Model changes are only available on a project leg."],
                Some("Model changes are only available on a project leg.".into()),
            );
        }
        self.plan(model, "", "", true).await
    }

    /// `/thinking`: the level the next project call is asked for, and on a
    /// project leg a redial onto it that keeps the conversation. The level is
    /// recorded whether or not that redial goes ahead.
    pub async fn thinking_change(&self, level: &str) -> Redial {
        match normalize_thinking(level) {
            Ok(value) if !value.is_empty() => {
                self.coordinator.set_thinking_default(&value);
                if self.coordinator.route() == OPERATOR {
                    return self.answer(
                        [format!(
                            "Thinking is set to {value} for the next project call."
                        )],
                        None,
                    );
                }
                self.plan("", &value, "", true).await
            }
            Ok(_) => self.answer(["Name a thinking level and I'll set it."], None),
            Err(e) => self.answer([e.to_string()], Some(e.to_string())),
        }
    }

    /// Decides a redial of the project leg on the line. Every refusal is made
    /// here, before anything is torn down, and leaves the live leg running.
    pub async fn plan(
        &self,
        model: &str,
        thinking: &str,
        intent: &str,
        keep_context: bool,
    ) -> Redial {
        // Read in one piece: the leg the plan replaces, its model, and its
        // session all belong to the same leg.
        let on_the_line = self.coordinator.project_leg().and_then(|leg| {
            let project = self.registry.get(&leg.project).cloned()?;
            Some((leg, project))
        });
        let Some((leg, project)) = on_the_line else {
            return self.answer(["There is no project on the line."], None);
        };
        if !self.model_swaps {
            return self.answer(["Model swapping is turned off on this switchboard."], None);
        }
        // The remote adapter can reap only the local ssh process. With no
        // verified remote shutdown protocol, reusing a persistent session ID
        // could attach to work that is still running on the far host. That is
        // a refusal like any other here: the live leg keeps running.
        if project.is_remote() && keep_context {
            let name = &project.id;
            tracing::warn!(project = %name, "refusing same-session remote redial; remote shutdown is unverified");
            return self.answer(
                [format!("I can't restart {name} on that and keep this conversation: I can't confirm the old session on its host has stopped. Ask for a fresh start to switch anyway.")],
                Some("remote_shutdown_unverified".to_owned()),
            );
        }
        let requested_model = if model.is_empty() && !leg.model.is_empty() {
            leg.model.clone()
        } else {
            model.to_owned()
        };
        let (_, _, current_thinking) = parse_spec(&leg.model);
        let level = if thinking.is_empty() {
            if !current_thinking.is_empty() {
                current_thinking
            } else {
                self.coordinator.thinking_default()
            }
        } else {
            match normalize_thinking(thinking) {
                Ok(v) => v,
                Err(e) => return self.answer([e.to_string()], Some(e.to_string())),
            }
        };
        // Everything the new leg launches with, before anything is torn down:
        // a host that is not ready is a refusal, and the live leg keeps
        // running exactly as a refused model would leave it.
        let launch = match self.prewarm.launch_plan(&project).await {
            Ok(launch) => launch,
            Err(error) => {
                tracing::info!(project = %project.id, %error, "refusing a model swap: the host is not ready");
                return self.answer([format!("I didn't switch: {error}")], Some(error));
            }
        };
        let requested = if requested_model.is_empty() {
            self.default_model(&project).to_owned()
        } else {
            requested_model
        };
        let choice = match launch.catalog.resolve(&requested, &level) {
            Ok(choice) => choice,
            Err(error) => {
                // Refusing is the safe outcome — the live leg keeps running —
                // but it looks identical to a swap that never happened.
                tracing::info!(project = %project.id, %requested, %error, "refusing a model swap");
                return self.answer(
                    [format!("I didn't switch: {error}")],
                    Some(error.to_string()),
                );
            }
        };
        let spec = choice.spec();
        if keep_context && spec == leg.model {
            return self.answer([format!("Already on {}.", choice.spoken())], None);
        }
        let session_id = if keep_context {
            leg.persistent_session_id.clone()
        } else {
            uuid_like()
        };
        Redial::Planned(Box::new(RedialPlan {
            leg,
            project,
            spec,
            session_id,
            keep_context,
            intent: intent.to_owned(),
            launch,
        }))
    }
}

pub struct Switchboard {
    pub registry: Arc<Registry>,
    pi_binary: String,
    operator_model: Option<String>,
    operator_system_prompt: String,
    operator_extension: Option<String>,
    speak_url: String,
    state_url: String,
    display_url: String,
    persona: String,
    env: HashMap<String, String>,
    speech_deadline_ms: u64,
    activity_callback: Option<ActivityCallback>,
    route_callback: Option<RouteCallback>,
    active_session: Arc<Mutex<Option<PiSession>>>,
    operator: Option<PiSession>,
    agent: Option<PiSession>,
    operator_note: Option<String>,
    /// The one owner of the leg on the line, and of the status the page is
    /// shown.
    coordinator: Coordinator,
    /// The only owner of launch setup: transports, catalogs, staged
    /// extensions, and prepare reports are all settled here at startup.
    prewarm: Arc<Prewarm>,
    /// Decides model and thinking changes, and which model a leg asks for.
    planner: RedialPlanner,
}
impl Switchboard {
    pub fn new(config: &crate::Config, registry: Registry, prewarm: Arc<Prewarm>) -> Self {
        let coordinator = Coordinator::new(
            StatusConfig {
                operator_model: config.operator_model.clone().unwrap_or_default(),
                model_swaps: config.model_swaps,
                projects: registry.ids(),
            },
            config.agent_thinking.clone(),
        );
        let registry = Arc::new(registry);
        let planner = RedialPlanner {
            coordinator: coordinator.clone(),
            registry: Arc::clone(&registry),
            prewarm: Arc::clone(&prewarm),
            agent_model: config.agent_model.clone(),
            model_swaps: config.model_swaps,
        };
        Self {
            registry,
            pi_binary: config.pi_binary.clone(),
            operator_model: config.operator_model.clone(),
            operator_system_prompt: config.operator_prompt.to_string_lossy().into_owned(),
            operator_extension: config.operator_extension.clone(),
            speak_url: config.speak_url.clone(),
            state_url: config.state_url.clone(),
            display_url: config.display_url.clone(),
            persona: config.persona.clone(),
            env: config.environment.clone(),
            speech_deadline_ms: config.speech_deadline_ms,
            activity_callback: None,
            route_callback: None,
            active_session: Arc::new(Mutex::new(None)),
            operator: None,
            agent: None,
            operator_note: None,
            coordinator,
            prewarm,
            planner,
        }
    }
    /// The coordinator this switchboard reports to; the application shares it.
    pub fn coordinator(&self) -> Coordinator {
        self.coordinator.clone()
    }
    /// The planner this switchboard decides redials with; the application
    /// shares it, so the pickers decide without the PBX lock.
    pub fn redial_planner(&self) -> RedialPlanner {
        self.planner.clone()
    }
    pub fn set_activity_callback(&mut self, callback: Option<ActivityCallback>) {
        self.activity_callback = callback;
    }

    pub fn set_route_callback(&mut self, callback: Option<RouteCallback>) {
        self.route_callback = callback;
    }

    pub async fn announce_route(&self) {
        if let Some(callback) = &self.route_callback {
            let callback = Arc::clone(callback);
            if let Err(panic) = AssertUnwindSafe(callback()).catch_unwind().await {
                tracing::error!(
                    route = %self.coordinator.route(),
                    panic = %crate::pi_client::panic_message(&panic),
                    "route callback panicked; the page may show a stale leg"
                );
            }
        }
    }

    fn rollback_startup(&self, reason: impl Into<String>) {
        self.coordinator.rollback_startup(reason);
    }

    pub fn session_control(&self) -> Arc<Mutex<Option<PiSession>>> {
        Arc::clone(&self.active_session)
    }

    async fn set_active_session(&self, session: Option<PiSession>) {
        *self.active_session.lock().await = session;
    }

    pub fn route_label(&self) -> String {
        self.coordinator.route_label()
    }
    pub async fn shutdown(&mut self) {
        if let Some(session) = self.agent.take() {
            session.close().await;
        }
        if let Some(session) = self.operator.take() {
            session.close().await;
        }
        self.set_active_session(None).await;
        // Idempotent: the service's shutdown path may reach here twice.
        self.prewarm.shutdown().await;
    }

    pub async fn handle(&mut self, text: &str) -> Reply {
        let context = TransferContext {
            exact_caller_transcript: text.to_owned(),
            derived_intent: String::new(),
        };
        self.handle_ctx(&context).await
    }

    pub async fn handle_ctx(&mut self, context: &TransferContext) -> Reply {
        if self.coordinator.route() == OPERATOR {
            self.handle_operator_ctx(context).await
        } else {
            self.handle_agent_ctx(context).await
        }
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
                tracing::warn!(%error, "the operator leg failed mid-prompt");
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
            tracing::warn!(route = %self.coordinator.route(), "the project leg is gone; returning to the operator");
            return self
                .return_operator_ctx(context, "project session is gone")
                .await;
        };
        let turn = match session.prompt(&context.exact_caller_transcript).await {
            Ok(t) => t,
            Err(error) => {
                let detail = error.to_string();
                let name = self.route_label();
                tracing::warn!(route = %name, %error, "the project leg failed mid-prompt; returning to the operator");
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
            tracing::warn!(route = %name, %detail, "the project leg failed its turn; returning to the operator");
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
                let decided = self
                    .planner
                    .plan(
                        &arg(signal, "model"),
                        &arg(signal, "thinking"),
                        &arg(signal, "intent"),
                        arg_bool(signal, "keep_context", true),
                    )
                    .await;
                let mut reply = match decided {
                    Redial::Answered(reply) => reply,
                    Redial::Planned(plan) => match self.redial(*plan).await {
                        Ok(reply) => reply,
                        // While this turn holds the PBX lock only a rescue
                        // replaces the leg, and a rescue cancels the turn.
                        Err(error) => self.reply(
                            ["I didn't switch: the line moved first."],
                            Some(error.to_string()),
                        ),
                    },
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
                let from = (self.coordinator.route() != OPERATOR).then(|| self.route_label());
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
                let from = (self.coordinator.route() != OPERATOR).then(|| self.route_label());
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
            from = %self.coordinator.route(),
            to = %project.id,
            host = project.canonical_host().unwrap_or("<local>"),
            cwd = %project.cwd,
            transcript_len = context.exact_caller_transcript.len(),
            "transferring caller"
        );

        let previous_agent = self.agent.clone();

        let plan = match self.prewarm.launch_plan(&project).await {
            Ok(plan) => plan,
            Err(err) => {
                tracing::warn!(project = %project.id, error = %err, "prewarm readiness failed");
                self.operator_note = Some(format!("Transfer to {} failed: {err}", project.id));
                return self.reply_transfer_error(
                    format!("I couldn't get {} on the line: {err}", project.id),
                    Some(err),
                );
            }
        };

        let model = match self.select_transfer_model(
            &project,
            &plan.catalog,
            requested_model,
            requested_thinking,
        ) {
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

        let candidate = CandidateLeg::new(
            project.id.clone(),
            project.id.clone(),
            session_id.clone(),
            leg_token.clone(),
            model.clone(),
            thinking_in_spec(&model),
        )
        .with_catalog(plan.catalog.clone());
        if let Err(error) = self.coordinator.begin_candidate(candidate) {
            tracing::warn!(project = %project.id, %error, "candidate startup was refused");
            return self.reply_transfer_error(
                format!("I couldn't get {} on the line: {error}", project.id),
                Some(error.to_string()),
            );
        }

        let session = match self
            .start_agent(&project, &model, &session_id, &leg_token, &plan)
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

        let intro_prompt = build_intro_prompt(context, &project, plan.prepare_report.as_ref());

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
            self.set_active_session(previous_agent.clone()).await;
            self.rollback_startup(format!("intro failed: {detail}"));
            self.operator_note = Some(format!("Transfer to {} failed: {detail}", project.id));
            return self.reply_transfer_error(
                format!("{} didn't pick up: {detail}", project.id),
                Some(detail),
            );
        }

        // The leg may be adopted already: a candidate is promoted on its first
        // sign of life, which usually arrives during the intro turn. Either
        // way the coordinator names it from here on; the switchboard only
        // swaps the process handles.
        if self.coordinator.is_candidate() {
            if let Err(error) = self.coordinator.adopt_candidate(&leg_token) {
                session.close().await;
                self.set_active_session(previous_agent.clone()).await;
                self.rollback_startup(format!("adoption failed: {error}"));
                return self.reply_transfer_error(
                    format!("{} did not come up.", project.id),
                    Some(error.to_string()),
                );
            }
        }
        self.coordinator.finish_intro();

        if let Some(previous) = self.agent.take() {
            previous.close().await;
        }
        self.agent = Some(session);
        self.set_active_session(self.agent.clone()).await;
        self.announce_route().await;
        self.reply_with_turn(turn)
    }

    /// Starts a project leg from its launch plan. Nothing here reaches the
    /// host except the launch itself: the transport, extension, and catalog
    /// were all settled by prewarm.
    async fn start_agent(
        &self,
        project: &Project,
        model: &str,
        session_id: &str,
        leg_token: &str,
        plan: &LaunchPlan,
    ) -> Result<PiSession, PiSessionError> {
        let mut env = self.env.clone();
        let agent_env = self.agent_env(leg_token);
        env.extend(agent_env.clone());
        // Without an extension the leg is launched without -e, and the brief
        // tells the runtime to use the return sentinel rather than lying about
        // a tool that never loaded.
        let brief = self.agent_brief(project, plan.extension.is_some());
        let model = (!model.is_empty()).then_some(model);
        let argv = match &plan.ssh {
            Some(ssh) => ssh.remote_argv(
                &project.cwd,
                &project.runtime,
                model,
                plan.extension.as_deref(),
                Some(&brief),
                Some(session_id),
                &project.extra_args,
                &agent_env,
            ),
            None => {
                let mut argv = vec![project.runtime.clone(), "--mode".into(), "rpc".into()];
                if let Some(model) = model {
                    argv.extend(["--model".into(), model.into()]);
                }
                argv.extend([
                    "--session-id".into(),
                    session_id.into(),
                    "--append-system-prompt".into(),
                    brief,
                ]);
                if let Some(extension) = &plan.extension {
                    argv.extend(["-e".into(), extension.clone()]);
                }
                argv.extend(project.extra_args.clone());
                argv
            }
        };
        PiSession::start(
            argv,
            project.id.clone(),
            leg_token,
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
            if self.planner.model_swaps {
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

    pub fn agent_env(&self, session_token: &str) -> HashMap<String, String> {
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
            ("SWITCHBOARD_DISPLAY_URL", &self.display_url),
            ("SWITCHBOARD_PERSONA", &self.persona),
        ] {
            if !value.is_empty() {
                e.insert(key.into(), value.clone());
            }
        }
        e
    }
    fn select_transfer_model(
        &self,
        project: &Project,
        catalog: &ModelCatalog,
        requested_model: &str,
        requested_thinking: &str,
    ) -> Result<String, String> {
        if !self.planner.model_swaps {
            return Ok(pin_thinking(
                self.planner.default_model(project),
                &self.coordinator.thinking_default(),
            ));
        }
        let requested = if requested_model.trim().is_empty() {
            self.planner.default_model(project)
        } else {
            requested_model
        };
        catalog
            .resolve(requested, requested_thinking)
            .map(|choice| pin_thinking(&choice.spec(), &self.coordinator.thinking_default()))
            .map_err(|error| error.to_string())
    }

    /// Runs a redial `RedialPlanner::plan` decided on. The leg it replaces
    /// must still be the leg on the line: a caller who has left it since (a
    /// transfer, a return, a rescue that did not make way for this redial) is
    /// not redialed back onto it, and nothing is touched.
    pub async fn redial(&mut self, plan: RedialPlan) -> Result<Reply, LifecycleError> {
        if self.coordinator.project_leg().as_ref() != Some(&plan.leg) {
            tracing::info!(project = %plan.project.id, "not redialing: the caller has left the leg it was planned for");
            return Err(LifecycleError::StaleLeg);
        }
        Ok(self.relaunch(plan).await)
    }

    /// Replaces the leg on the line with the one `plan` describes.
    async fn relaunch(&mut self, plan: RedialPlan) -> Reply {
        let RedialPlan {
            leg,
            project,
            spec,
            session_id,
            keep_context,
            intent,
            launch,
        } = plan;
        tracing::info!(
            project = %project.id,
            from = %leg.model,
            to = %spec,
            context = if keep_context { "kept" } else { "cleared" },
            "swapping the model on the live leg"
        );
        let leg_token = uuid_like();
        let candidate = CandidateLeg::new(
            project.id.clone(),
            project.id.clone(),
            session_id.clone(),
            leg_token.clone(),
            spec.clone(),
            thinking_in_spec(&spec),
        )
        .with_catalog(launch.catalog.clone());
        if let Err(error) = self.coordinator.begin_candidate(candidate) {
            tracing::warn!(project = %project.id, %error, "candidate startup for redial was refused");
            return self.reply(
                [format!("I couldn't restart {}: {error}", project.id)],
                Some(error.to_string()),
            );
        }

        let session = match self
            .start_agent(&project, &spec, &session_id, &leg_token, &launch)
            .await
        {
            Ok(session) => session,
            Err(error) => {
                tracing::error!(project = %project.id, %spec, %error, "could not restart the leg on the new model");
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

        if self.coordinator.is_candidate() {
            if let Err(error) = self.coordinator.adopt_candidate(&leg_token) {
                session.close().await;
                self.rollback_startup(format!("adoption failed: {error}"));
                self.drop_agent().await;
                return self.reply(
                    [format!("{} did not come up.", project.id)],
                    Some(error.to_string()),
                );
            }
        }
        self.coordinator.finish_intro();
        if let Some(previous) = self.agent.take() {
            previous.close().await;
        }
        self.agent = Some(session);
        self.set_active_session(self.agent.clone()).await;
        self.announce_route().await;
        self.reply_with_turn(turn)
    }

    async fn return_operator_ctx(&mut self, context: &TransferContext, note: &str) -> Reply {
        self.drop_agent().await;
        let note = note.to_owned();
        self.operator_note = Some(note.clone());
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
        let was_on_a_project = self.coordinator.route() != OPERATOR;
        if let Some(s) = self.agent.take() {
            s.close().await;
        }
        self.set_active_session(self.operator.clone()).await;
        self.coordinator.return_to_operator();
        if was_on_a_project {
            self.announce_route().await;
        }
    }
    fn reply<I, S>(&self, texts: I, error: Option<String>) -> Reply
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        spoken_reply(&self.coordinator, texts, error)
    }
    fn reply_with_turn(&self, turn: Turn) -> Reply {
        let spoke = turn.agent_spoke();
        let failed = turn.failed;
        let error = turn.error;
        let status = self.coordinator.status();
        let mut reply = Reply::new(
            &status.route,
            &status.label,
            vec![Utterance {
                text: turn.text,
                synthesize: !spoke,
            }],
            failed.then_some(error),
        );
        reply.delivery_generation = Some(self.coordinator.generation());
        reply
    }
    fn reply_transfer_error(&self, message: String, error: Option<String>) -> Reply {
        let status = self.coordinator.status();
        Reply::new(
            &status.route,
            &status.label,
            vec![Utterance {
                text: message,
                synthesize: true,
            }],
            error,
        )
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
        let context = TransferContext {
            derived_intent: intent.to_owned(),
            ..TransferContext::default()
        };
        self.transfer_ctx(&context, project, "", "").await
    }
    pub async fn force_hangup(&mut self) -> Option<String> {
        let route = self.coordinator.route();
        if route == OPERATOR {
            if let Some(session) = self.operator.take() {
                tracing::info!("caller hung up a wedged operator turn from the page");
                session.close().await;
                self.set_active_session(None).await;
                return Some(OPERATOR.into());
            }
            return None;
        }
        let left = route;
        tracing::info!(%left, "caller hung up the project leg from the page");
        self.drop_agent().await;
        self.operator_note = Some(format!("The caller dropped the line to {left}."));
        Some(left)
    }
}

/// A reply the switchboard speaks itself, labelled with the leg the
/// coordinator names now.
fn spoken_reply<I, S>(coordinator: &Coordinator, texts: I, error: Option<String>) -> Reply
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let status = coordinator.status();
    Reply::new(
        &status.route,
        &status.label,
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

/// The thinking level a model spec asks for: its suffix, empty for none.
fn thinking_in_spec(spec: &str) -> String {
    parse_spec(spec).2
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

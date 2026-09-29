//! Call routing and leg lifecycle.
//!
//! The switchboard owns the legs: the operator's local `PiSession`, the
//! project leg's `ProjectSession` on its host, the session control rescues
//! interrupt, and launching. Which leg
//! is on the line -- route, project, model, session -- belongs to the
//! coordinator (`lifecycle.rs`); the switchboard reads it there and changes it
//! only through the coordinator's transitions. A model or thinking change is
//! decided by `RedialPlanner`, which needs no PBX lock; the switchboard runs
//! the ones that go ahead.
use crate::history::TranscriptEntry;
use crate::hosts::Hosts;
use crate::lifecycle::{CandidateLeg, Coordinator, LifecycleError, ProjectLeg, StatusConfig};
use crate::models::{normalize_thinking, parse_spec, pin_thinking, ModelCatalog};
use crate::pi_client::{
    local_argv, ActivityCallback, LegSession, ModuleCallback, PiSession, PiSessionError,
    ProjectLaunch, ProjectSession, SessionState, Signal, Turn, ROUTE_TOOL,
};
use crate::prewarm::{LaunchPlan, Prewarm};
use crate::registry::{Project, Registry};
use crate::router::{utility_decision, CallSummary, Decision, Router, UtilityDecision};
use futures_util::FutureExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::Duration;

pub const OPERATOR: &str = "operator";
/// How long a project leg may go silent inside one turn, its intro included,
/// before it is dropped as wedged.
const PROJECT_TURN_TIMEOUT: Duration = Duration::from_secs(600);
/// Told the switchboard has settled on a leg; it reads which one from the
/// coordinator.
pub type RouteCallback = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;
/// Reports resident project-agent lifecycle transitions to the application
/// presentation layer. The PBX remains the lifecycle owner; this is only a
/// projection callback.
#[derive(Clone, Debug)]
pub struct AgentStateNotice {
    pub project: String,
    pub state: String,
}
pub type AgentStateCallback =
    Arc<dyn Fn(AgentStateNotice) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// The voice brief's opening. The brief rides at the start of the first
/// prompt a project session gets for the caller, and again on the first after
/// a compaction; it is never a message of its own.
const AGENT_BRIEF_HEADER: &str = "[SWITCHBOARD VOICE BRIEF]\nYou are on a voice call in the {project} project, in its own directory. The caller hears only what you pass to the `switchboard` module in your Python REPL (already imported); your written output goes to their screen and is not read aloud.\n";
const AGENT_BRIEF_TOOLS: &str = "- switchboard.speak(text): say a sentence or two of plain speech. Use it to answer, and before and during long work. No code, paths or lists.\n- switchboard.request_to_speak(message, reason) asks the caller to bring a background session forward; use it when finished, blocked or needing a decision.\n- switchboard.display(...) shows things on their screen; switchboard.view() tells you what they see.\n- Routing is handled by the switchboard before your turn. Do not try to transfer, return, or change models; answer the caller or explain what you completed.\n";
const AGENT_BRIEF_SWAPS: &str = "";
const AGENT_BRIEF_END: &str = "[END OF VOICE BRIEF]";
/// Instructions for the separate, stateless process. This is code-owned so
/// deploying the utility never requires another environment setting.
const UTILITY_SYSTEM_PROMPT: &str = r#"You are the switchboard's stateless routing utility. You never speak to the caller and you never answer general questions. Inspect the supplied caller utterance and call exactly one tool. For a single target, call second_opinion with an exact registered project id, mode (continue or fresh), and confident true only when it is safe to route without asking. If unclear, call second_opinion with no target and confident false. If the utterance clearly addresses several projects, call dispatch_parts with one exact project id and a short caller-worded part for each target. Never invent projects, never call tools not provided, and never emit a prose answer."#;
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
/// touched.
pub enum Redial {
    /// Answered without touching the live leg: a refusal, or, on the
    /// operator, a setting recorded for the next project call.
    Answered(Reply),
    /// A redial that will go ahead; `Switchboard::redial` runs it.
    Planned(Box<RedialPlan>),
}

/// A model or thinking change that will go ahead, and the leg it changes.
pub struct RedialPlan {
    leg: ProjectLeg,
    project: Project,
    spec: String,
    /// How the new model is said aloud.
    spoken: String,
    keep_context: bool,
    intent: String,
    launch: LaunchPlan,
}

impl RedialPlan {
    /// The leg this redial replaces.
    pub fn leg(&self) -> &ProjectLeg {
        &self.leg
    }

    /// True when the change is made on the live session, which the rescue
    /// that makes way for it must therefore not end.
    pub fn keeps_session(&self) -> bool {
        self.keep_context
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
        // The host's catalog, before anything is touched: a host that is not
        // ready is a refusal, and the live leg keeps running exactly as a
        // refused model would leave it.
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
        Redial::Planned(Box::new(RedialPlan {
            leg,
            project,
            spec,
            spoken: choice.spoken(),
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
    persona: String,
    env: HashMap<String, String>,
    speech_deadline_ms: u64,
    activity_callback: Option<ActivityCallback>,
    route_callback: Option<RouteCallback>,
    agent_state_callback: Option<AgentStateCallback>,
    module_callback: Option<ModuleCallback>,
    active_session: Arc<Mutex<Option<LegSession>>>,
    operator: Option<PiSession>,
    /// A separate process for second opinions and split dispatch. It must not
    /// share the operator's turn lock or conversation history.
    utility: Option<PiSession>,
    agent: Option<ProjectSession>,
    /// Resident project sessions not currently carrying the caller.
    background_agents: HashMap<String, ProjectSession>,
    operator_note: Option<String>,
    /// Project awaiting a caller confirmation before it is stopped.
    pending_stop: Option<String>,
    /// Projects explicitly stopped by the caller must start fresh once.
    resume_blocked: HashSet<String>,
    /// The one owner of the leg on the line, and of the status the page is
    /// shown.
    coordinator: Coordinator,
    /// The project hosts' links; project legs run over them.
    hosts: Hosts,
    /// The only owner of launch setup: catalogs and prepare reports are
    /// settled here at startup.
    prewarm: Arc<Prewarm>,
    /// Decides model and thinking changes, and which model a leg asks for.
    planner: RedialPlanner,
    /// The sole utterance routing decider. The operator remains the fallback
    /// conversation when this client is unavailable or unsure.
    router: Router,
    /// `PROJECT_TURN_TIMEOUT`, held per switchboard so a test can wait out a
    /// silent leg without waiting ten minutes.
    project_turn_timeout: Duration,
}
impl Switchboard {
    pub fn new(config: &crate::Config, registry: Registry, prewarm: Arc<Prewarm>) -> Self {
        let hosts = prewarm.hosts();
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
        let jev = crate::jev::JevClient::new(
            config.jev_url.clone(),
            config.jev_key_file.clone(),
            Duration::from_millis(config.jev_timeout_ms),
        )
        .expect("build Jev HTTP client");
        let router = Router::new(
            jev,
            Arc::clone(&registry),
            coordinator.clone(),
            config.jev_summary_token_budget,
            config.jev_for_current_agent_lower,
            config.jev_for_current_agent_upper,
            config.jev_action_threshold,
        );
        Self {
            registry,
            pi_binary: config.pi_binary.clone(),
            operator_model: config.operator_model.clone(),
            operator_system_prompt: config.operator_prompt.to_string_lossy().into_owned(),
            operator_extension: config.operator_extension.clone(),
            persona: config.persona.clone(),
            env: config.environment.clone(),
            speech_deadline_ms: config.speech_deadline_ms,
            activity_callback: None,
            route_callback: None,
            agent_state_callback: None,
            module_callback: None,
            active_session: Arc::new(Mutex::new(None)),
            operator: None,
            utility: None,
            agent: None,
            background_agents: HashMap::new(),
            operator_note: None,
            pending_stop: None,
            resume_blocked: HashSet::new(),
            coordinator,
            hosts,
            prewarm,
            planner,
            router,
            project_turn_timeout: PROJECT_TURN_TIMEOUT,
        }
    }
    /// The project hosts' links; the application serves them on `/host`.
    pub fn hosts(&self) -> Hosts {
        self.hosts.clone()
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

    pub fn set_agent_state_callback(&mut self, callback: Option<AgentStateCallback>) {
        self.agent_state_callback = callback;
    }

    async fn announce_agent_state(&self, project: &str, state: &str) {
        if let Some(callback) = &self.agent_state_callback {
            callback(AgentStateNotice {
                project: project.to_owned(),
                state: state.to_owned(),
            })
            .await;
        }
    }

    /// What answers a project session's `speak`, `display` and `view`.
    pub fn set_module_callback(&mut self, callback: Option<ModuleCallback>) {
        self.module_callback = callback;
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

    pub fn session_control(&self) -> Arc<Mutex<Option<LegSession>>> {
        Arc::clone(&self.active_session)
    }

    async fn set_active_session(&self, session: Option<LegSession>) {
        *self.active_session.lock().await = session;
    }

    fn operator_leg(&self) -> Option<LegSession> {
        self.operator.clone().map(LegSession::Operator)
    }

    fn agent_leg(&self) -> Option<LegSession> {
        self.agent.clone().map(LegSession::Project)
    }

    pub fn route_label(&self) -> String {
        self.coordinator.route_label()
    }
    pub async fn shutdown(&mut self) {
        if let Some(session) = self.agent.take() {
            session.close();
        }
        for (_, session) in self.background_agents.drain() {
            session.close();
        }
        if let Some(session) = self.operator.take() {
            session.close().await;
        }
        if let Some(session) = self.utility.take() {
            session.close().await;
        }
        self.set_active_session(None).await;
        // Idempotent: the service's shutdown path may reach here twice.
        self.prewarm.shutdown();
    }

    pub fn router(&self) -> Router {
        self.router.clone()
    }

    pub fn call_summary(
        &self,
        transcript: &[TranscriptEntry],
        screen: Value,
        utterance: impl Into<String>,
    ) -> CallSummary {
        CallSummary::from_runtime(
            &self.coordinator.status(),
            &self.registry,
            transcript,
            screen,
            utterance,
        )
    }

    /// Dispatch an utterance after Jev has made the routing decision. An
    /// unsure or unsupported action deliberately goes through the existing
    /// operator LLM path; project agents never mutate the route themselves.
    pub async fn handle_decision(&mut self, text: &str, decision: &Decision) -> Reply {
        // These actions are owned by the PBX, not by an agent. A stop decision
        // is deliberately confirmation-only here; the next utterance must
        // confirm before a resident session is closed.
        if let Some(target) = self.pending_stop.take() {
            if is_confirmation(text) {
                return self.stop_project(&target).await;
            }
        }
        if matches!(decision.action, crate::router::Action::Stop) {
            let target = decision.target.clone().or_else(|| {
                (self.coordinator.route() != OPERATOR).then(|| self.coordinator.route())
            });
            let Some(target) = target else {
                return self.reply(["There is no project agent to stop."], None);
            };
            self.pending_stop = Some(target.clone());
            return self.reply(
                [format!(
                    "Do you want me to stop {target}? Say yes to confirm."
                )],
                None,
            );
        }
        if matches!(decision.action, crate::router::Action::AnswerWaiting) {
            if let Some(target) = decision.target.as_deref() {
                return self
                    .route_project_part(text, target, crate::router::ConversationMode::Continue)
                    .await;
            }
        }

        // Jev's outage is the conversational LLM fallback. A healthy Jev
        // decision that is unsure (or addresses multiple projects) gets one
        // isolated utility call before the caller is asked to clarify.
        let jev_unavailable = decision.reason.starts_with("Jev unavailable:");
        if decision.multi_target || (decision.unsure && !jev_unavailable) {
            match self.utility_decision(text).await {
                Ok(Some(UtilityDecision::DispatchParts(parts))) => {
                    // A split returned for an unsure Jev decision is still a
                    // useful utility verdict. Jev's multi_target flag is a
                    // hint to consult the utility, not permission to discard
                    // the utility's structured dispatch.
                    return self.dispatch_parts(text, parts).await;
                }
                Ok(Some(UtilityDecision::SecondOpinion {
                    target: Some(target),
                    mode,
                    confident: true,
                })) if decision.unsure => {
                    return self.route_project_part(text, &target, mode).await;
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(%error, "routing utility unavailable; asking the conversational operator");
                }
            }
        }

        if matches!(decision.action, crate::router::Action::GoToProject)
            && !decision.sends_to_operator()
        {
            if let Some(target) = decision.target.as_deref() {
                let context = TransferContext {
                    exact_caller_transcript: text.to_owned(),
                    // Jev's reason is an internal routing record, not caller
                    // intent. Do not leak it into the target's prompt.
                    derived_intent: String::new(),
                };
                return self.transfer_ctx(&context, target, "", "").await;
            }
        }
        if matches!(decision.action, crate::router::Action::Continue)
            && !decision.sends_to_operator()
            && self.coordinator.route() != OPERATOR
        {
            return self
                .handle_agent_ctx(&TransferContext {
                    exact_caller_transcript: text.to_owned(),
                    derived_intent: String::new(),
                })
                .await;
        }
        let context = TransferContext {
            exact_caller_transcript: text.to_owned(),
            derived_intent: String::new(),
        };
        self.handle_operator_ctx(&context).await
    }

    async fn route_project_part(
        &mut self,
        text: &str,
        target: &str,
        mode: crate::router::ConversationMode,
    ) -> Reply {
        let context = TransferContext {
            exact_caller_transcript: text.to_owned(),
            derived_intent: String::new(),
        };
        if target != OPERATOR
            && self.coordinator.route() == target
            && matches!(mode, crate::router::ConversationMode::Fresh)
        {
            return self.reply_transfer_error(
                format!("{target} is already running. Say continue to use it, or stop it first."),
                Some("project is busy".into()),
            );
        }
        if target != OPERATOR && self.coordinator.route() != target {
            if self.remove_dead_background(target) {
                self.announce_agent_state(target, "finished").await;
            }
            if matches!(mode, crate::router::ConversationMode::Fresh)
                && self.background_agents.contains_key(target)
            {
                return self.reply_transfer_error(
                    format!(
                        "{target} is already running. Say continue to use it, or stop it first."
                    ),
                    Some("project is busy".into()),
                );
            }
            if self.background_agents.contains_key(target) {
                let session = self
                    .background_agents
                    .remove(target)
                    .expect("background session exists");
                return self.promote_background(session, context).await;
            }
        }
        if target == OPERATOR {
            // The utility may explicitly choose the operator. Do not send
            // that target through the project handler: it has no project
            // session and would manufacture a spurious "project session is
            // gone" recovery. Returning from a project also drops that leg
            // before the operator answers.
            if self.coordinator.route() != OPERATOR {
                self.drop_agent().await;
            }
            return Box::pin(self.handle_operator_ctx(&context)).await;
        }
        if self.coordinator.route() == target
            && matches!(mode, crate::router::ConversationMode::Continue)
        {
            // The utility's opinion can confirm that an unsure utterance is
            // for the project already on the line. Box this back-edge because
            // a missing project session may legitimately fall through to the
            // operator handler.
            return Box::pin(self.handle_agent_ctx(&context)).await;
        }
        self.transfer_ctx(
            &TransferContext {
                exact_caller_transcript: text.to_owned(),
                derived_intent: String::new(),
            },
            target,
            "",
            "",
        )
        .await
    }

    /// Dispatch every part of a split. The part for the agent already on the
    /// line remains foreground; otherwise the first part is foreground and all
    /// other parts become resident background sessions.
    async fn dispatch_parts(
        &mut self,
        original: &str,
        parts: Vec<crate::router::DispatchPart>,
    ) -> Reply {
        let current = self.coordinator.route();
        let foreground_index = parts
            .iter()
            .position(|part| part.agent == current)
            .unwrap_or(0);
        let Some(foreground) = parts.get(foreground_index).cloned() else {
            return self
                .handle_operator_ctx(&TransferContext {
                    exact_caller_transcript: original.to_owned(),
                    ..TransferContext::default()
                })
                .await;
        };

        // Start resident background work before awaiting the foreground turn.
        // A slow foreground model must not serialize unrelated project parts.
        for (index, part) in parts.iter().enumerate() {
            if index == foreground_index || part.agent == foreground.agent {
                continue;
            }
            if let Err(error) = self.start_background_part(&part.agent, &part.text).await {
                tracing::warn!(project = %part.agent, %error, "background split part failed");
            }
        }
        self.route_project_part(
            &foreground.text,
            &foreground.agent,
            crate::router::ConversationMode::Continue,
        )
        .await
    }

    /// Removes a resident whose host session has already closed. The map is
    /// otherwise enough to enforce one live session per project, but a closed
    /// handle would make later work prompt a dead session and reject a fresh
    /// start forever.
    fn remove_dead_background(&mut self, project: &str) -> bool {
        let dead = self
            .background_agents
            .get(project)
            .is_some_and(|session| !session.alive());
        if !dead {
            return false;
        }
        if let Some(session) = self.background_agents.remove(project) {
            self.coordinator.remove_background(&session.token());
        }
        true
    }

    /// Start one split part without changing the caller's foreground route.
    async fn start_background_part(&mut self, target: &str, text: &str) -> Result<(), String> {
        let project = match self.registry.resolve_detailed(target) {
            crate::registry::ResolveResult::Exact(project) => project.clone(),
            _ => return Err(format!("unknown project {target}")),
        };
        if self
            .agent
            .as_ref()
            .is_some_and(|agent| agent.label() == project.id)
        {
            return Err(format!("project {} is already busy", project.id));
        }
        if self.remove_dead_background(&project.id) {
            self.announce_agent_state(&project.id, "finished").await;
        }
        // A resident background session can be idle after its prior turn. Keep
        // its history and address it instead of treating existence as busy.
        if let Some(session) = self.background_agents.get(&project.id).cloned() {
            if session.busy() {
                return Err(format!("project {} is already busy", project.id));
            }
            self.announce_agent_state(&project.id, "busy").await;
            let callback = self.agent_state_callback.clone();
            let project_id = project.id.clone();
            let text = text.to_owned();
            tokio::spawn(async move {
                if let Err(error) = session.prompt(&text).await {
                    tracing::warn!(%error, "background agent prompt failed");
                }
                if let Some(callback) = callback {
                    if session.alive() {
                        callback(AgentStateNotice {
                            project: project_id,
                            state: "idle".into(),
                        })
                        .await;
                    }
                }
            });
            return Ok(());
        }
        let plan = self
            .prewarm
            .launch_plan(&project)
            .await
            .map_err(|error| error.to_string())?;
        let model = self
            .select_transfer_model(&project, &plan.catalog, "", "")
            .map_err(|error| error.to_string())?;
        let token = uuid_like();
        let session = self
            .start_agent_mode(&project, &model, &token, &plan, "background")
            .await
            .map_err(|error| error.to_string())?;
        let intro = build_intro_prompt(
            &TransferContext {
                exact_caller_transcript: text.to_owned(),
                ..TransferContext::default()
            },
            &project,
            plan.prepare_report.as_ref(),
        );
        self.coordinator
            .register_background(project.id.clone(), token.clone());
        self.background_agents
            .insert(project.id.clone(), session.clone());
        self.announce_agent_state(&project.id, "busy").await;
        let callback = self.agent_state_callback.clone();
        let project_id = project.id.clone();
        tokio::spawn(async move {
            if let Err(error) = session.prompt(&intro).await {
                tracing::warn!(%error, "background agent prompt failed");
            }
            if let Some(callback) = callback {
                if session.alive() {
                    callback(AgentStateNotice {
                        project: project_id,
                        state: "idle".into(),
                    })
                    .await;
                }
            }
        });
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn handle(&mut self, text: &str) -> Reply {
        let context = TransferContext {
            exact_caller_transcript: text.to_owned(),
            derived_intent: String::new(),
        };
        self.handle_ctx(&context).await
    }

    #[allow(dead_code)]
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
            let catalog = self
                .registry
                .operator_prompt_catalog()
                .replace("transfer_to_project", "route");
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
            self.set_active_session(self.operator_leg()).await;
        }
        self.operator
            .as_ref()
            .ok_or_else(|| PiSessionError("operator session was not created".into()))
    }
    async fn ensure_utility(&mut self) -> Result<&PiSession, PiSessionError> {
        let alive = match self.utility.as_ref() {
            Some(session) => session.alive().await,
            None => false,
        };
        if !alive {
            if let Some(session) = self.utility.take() {
                tracing::warn!("routing utility process died; restarting");
                session.close().await;
            }
        }
        if self.utility.is_none() {
            let utility_prompt = format!(
                "{UTILITY_SYSTEM_PROMPT}\n\n[REGISTERED PROJECTS]\n{}",
                self.registry.operator_prompt_catalog().replace(
                    "Available projects for transfer. Use the exact project id with transfer_to_project; aliases are included for recognition.",
                    "Available projects for the routing utility. Use the exact project id with second_opinion or dispatch_parts; aliases are included for recognition.",
                )
            );
            let argv = local_argv(
                &self.pi_binary,
                self.operator_model.as_deref(),
                None,
                Some(&utility_prompt),
                self.operator_extension.as_deref(),
                &[
                    "--no-builtin-tools".into(),
                    "--no-session".into(),
                    "--switchboard-utility".into(),
                ],
            )?;
            let session = PiSession::start(
                argv,
                "routing utility",
                "utility",
                None,
                Some(self.env.clone()),
                Duration::from_secs(180),
                None,
            )
            .await?;
            self.utility = Some(session);
        }
        self.utility
            .as_ref()
            .ok_or_else(|| PiSessionError("utility process was not created".into()))
    }

    /// Ask the isolated utility process. This call never touches the
    /// conversational operator session, so an operator turn cannot block it.
    async fn utility_decision(
        &mut self,
        text: &str,
    ) -> Result<Option<UtilityDecision>, PiSessionError> {
        let session = self.ensure_utility().await?.clone();
        let turn = session.prompt(text).await?;
        if turn.failed {
            return Err(PiSessionError(if turn.error.is_empty() {
                "routing utility failed".into()
            } else {
                turn.error
            }));
        }
        Ok(utility_decision(&turn.signals))
    }

    async fn handle_operator_ctx(&mut self, context: &TransferContext) -> Reply {
        let session = match self.ensure_operator().await {
            Ok(session) => session.clone(),
            Err(e) => {
                tracing::error!(error = %e, "operator unavailable");
                tracing::error!(error = %e, "operator unavailable for routing");
                return self.routing_unavailable();
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
        if let Some(signal) = turn.signals.iter().find(|s| s.name == ROUTE_TOOL) {
            let target = arg_first(signal, &["target", "project"]);
            let mode = conversation_mode(signal);
            if target.is_empty() {
                return self.reply([turn.text], None);
            }
            return self
                .route_project_part(&context.exact_caller_transcript, &target, mode)
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
        if turn.failed && turn.text.is_empty() {
            let detail = if turn.error.is_empty() {
                "agent turn failed".to_owned()
            } else {
                turn.error.clone()
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

        // The leg the caller is on now, which every failure below hands the
        // line back to: the project leg on an agent-to-agent transfer, else
        // the operator, as in `drop_agent`.
        let live_session = self.agent_leg().or_else(|| self.operator_leg());

        let plan = match self.prewarm.launch_plan(&project).await {
            Ok(plan) => plan,
            Err(err) => {
                tracing::warn!(project = %project.id, error = %err, "the project's host is not ready");
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

        // At most one session per project: one the caller is on is ended
        // before another is made for the same project.
        if self
            .agent
            .as_ref()
            .is_some_and(|agent| agent.label() == project.id)
        {
            if let Some(previous) = self.agent.take() {
                previous.close();
            }
        }

        let session = match self.start_agent(&project, &model, &leg_token, &plan).await {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(
                    project = %project.id,
                    host = %plan.host,
                    error = %e,
                    "could not connect to project"
                );
                self.rollback_startup(format!("startup failed: {e}"));
                self.set_active_session(live_session.clone()).await;
                self.operator_note = Some(format!("Transfer to {} failed: {e}", project.id));
                return self.reply_transfer_error(
                    format!("I couldn't get {} on the line: {e}", project.id),
                    Some(e.to_string()),
                );
            }
        };

        self.set_active_session(Some(LegSession::Project(session.clone())))
            .await;

        let intro_prompt = build_intro_prompt(context, &project, plan.prepare_report.as_ref());

        self.announce_agent_state(&project.id, "busy").await;
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
            let detail = if turn.error.trim().is_empty() {
                "the agent never answered".to_owned()
            } else {
                turn.error
            };
            tracing::error!(project = %project.id, %detail, "project intro turn failed");
            session.close();
            self.set_active_session(live_session.clone()).await;
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
        // swaps the session handles.
        if self.coordinator.is_candidate() {
            if let Err(error) = self.coordinator.adopt_candidate(&leg_token) {
                session.close();
                self.set_active_session(live_session.clone()).await;
                self.rollback_startup(format!("adoption failed: {error}"));
                return self.reply_transfer_error(
                    format!("{} did not come up.", project.id),
                    Some(error.to_string()),
                );
            }
        }
        self.coordinator.finish_intro();

        if let Some(previous) = self.agent.take() {
            if previous.label() == project.id {
                previous.close();
            } else {
                let previous_label = previous.label().to_owned();
                if let Err(error) = previous.set_mode("background").await {
                    tracing::warn!(project = %previous_label, %error, "could not mark previous foreground agent background");
                }
                if previous.busy() {
                    let _ = previous
                        .steer("[switchboard] The caller is now listening to another agent. Continue your work quietly; use request_to_speak when you need the caller.")
                        .await;
                }
                self.coordinator
                    .register_background(previous_label.clone(), previous.token());
                let state = if previous.busy() { "busy" } else { "idle" };
                self.announce_agent_state(&previous_label, state).await;
                self.background_agents.insert(previous_label, previous);
            }
        }
        self.announce_agent_state(&project.id, "idle").await;
        self.agent = Some(session);
        self.set_active_session(self.agent_leg()).await;
        self.announce_route().await;
        self.reply_with_turn(turn)
    }

    async fn promote_background(
        &mut self,
        session: ProjectSession,
        context: TransferContext,
    ) -> Reply {
        let project = match self.registry.resolve_detailed(session.label()) {
            crate::registry::ResolveResult::Exact(project) => project.clone(),
            _ => {
                session.close();
                return self.reply_transfer_error(
                    "The background project is no longer registered.".into(),
                    Some("project is no longer registered".into()),
                );
            }
        };
        let token = uuid_like();
        let old_token = session.token();
        if let Err(error) = session.set_mode("foreground").await {
            return self.reply_transfer_error(
                format!("I couldn't bring {} forward: {error}", project.id),
                Some(error.to_string()),
            );
        }
        if let Err(error) = session
            .join_call_mode(&token, &self.persona, self.speech_deadline_ms, "foreground")
            .await
        {
            session.close();
            return self.reply_transfer_error(
                format!("I couldn't bring {} forward: {error}", project.id),
                Some(error.to_string()),
            );
        }
        self.announce_agent_state(&project.id, "busy").await;
        self.coordinator.remove_background(&old_token);
        let candidate = CandidateLeg::new(
            project.id.clone(),
            project.id.clone(),
            session.session_id(),
            token.clone(),
            "",
            self.coordinator.thinking_default(),
        );
        if let Err(error) = self.coordinator.begin_candidate(candidate) {
            return self.reply_transfer_error(
                format!("I couldn't bring {} forward: {error}", project.id),
                Some(error.to_string()),
            );
        }
        let turn = match session.prompt(&context.exact_caller_transcript).await {
            Ok(turn) => turn,
            Err(error) => Turn {
                text: String::new(),
                signals: vec![],
                failed: true,
                error: error.to_string(),
            },
        };
        if turn.failed && turn.text.is_empty() {
            session.set_mode("background").await.ok();
            self.rollback_startup(format!("background promotion failed: {}", turn.error));
            return self.reply_transfer_error(
                format!("{} did not answer: {}", project.id, turn.error),
                Some(turn.error),
            );
        }
        if self.coordinator.is_candidate() {
            if let Err(error) = self.coordinator.adopt_candidate(&token) {
                return self.reply_transfer_error(
                    format!("{} did not come up.", project.id),
                    Some(error.to_string()),
                );
            }
        }
        self.coordinator.finish_intro();
        if let Some(previous) = self.agent.take() {
            let previous_label = previous.label().to_owned();
            previous.set_mode("background").await.ok();
            if previous.busy() {
                let _ = previous
                    .steer("[switchboard] The caller is now listening to another agent. Continue your work quietly; use request_to_speak when you need the caller.")
                    .await;
            }
            self.coordinator
                .register_background(previous_label.clone(), previous.token());
            let state = if previous.busy() { "busy" } else { "idle" };
            self.announce_agent_state(&previous_label, state).await;
            self.background_agents.insert(previous_label, previous);
        }
        self.announce_agent_state(&project.id, "idle").await;
        self.agent = Some(session);
        self.set_active_session(self.agent_leg()).await;
        self.announce_route().await;
        self.reply_with_turn(turn)
    }

    /// Starts a project leg on its host from its launch plan and puts it on
    /// the call with `leg_token`. Nothing here sets anything up: the host's
    /// catalog and the prepare report were settled by prewarm.
    async fn start_agent(
        &mut self,
        project: &Project,
        model: &str,
        leg_token: &str,
        plan: &LaunchPlan,
    ) -> Result<ProjectSession, PiSessionError> {
        self.start_agent_mode(project, model, leg_token, plan, "foreground")
            .await
    }

    async fn start_agent_mode(
        &mut self,
        project: &Project,
        model: &str,
        leg_token: &str,
        plan: &LaunchPlan,
        mode: &str,
    ) -> Result<ProjectSession, PiSessionError> {
        let launch = ProjectLaunch {
            host: plan.host.clone(),
            project: project.id.clone(),
            cwd: project.cwd.clone(),
            spec: model.to_owned(),
            brief: self.agent_brief(project),
            turn_timeout: self.project_turn_timeout,
            on_activity: self.activity_callback.clone(),
            on_module: self.module_callback.clone(),
        };
        // A host-agent restart keeps resident sessions alive. Prefer the
        // matching service-created session rather than creating a duplicate.
        let resume_blocked = self.resume_blocked.remove(&project.id);
        let resumed_id = if !resume_blocked && self.hosts.link_epoch(&plan.host).is_some() {
            self.hosts
                .command(
                    &plan.host,
                    "list_sessions",
                    json!({}),
                    std::time::Duration::from_secs(5),
                )
                .await
                .ok()
                .and_then(|reply| {
                    reply.result["sessions"].as_array().and_then(|sessions| {
                        sessions.iter().find_map(|session| {
                            (session["project"].as_str() == Some(project.id.as_str())
                                && session["cwd"].as_str() == Some(project.cwd.as_str())
                                && session["provenance"].as_str().unwrap_or("created") == "created")
                                .then(|| {
                                    session["session_id"]
                                        .as_str()
                                        .unwrap_or_default()
                                        .to_owned()
                                })
                                .filter(|id| !id.is_empty())
                        })
                    })
                })
        } else {
            None
        };
        let (session, state) = if let Some(session_id) = resumed_id {
            ProjectSession::open(&self.hosts, launch.clone(), &session_id).await?
        } else {
            ProjectSession::create(&self.hosts, launch).await?
        };
        if let Err(error) = session
            .join_call_mode(leg_token, &self.persona, self.speech_deadline_ms, mode)
            .await
        {
            session.close();
            return Err(error);
        }
        self.confirm_thinking(leg_token, &state);
        self.announce_agent_state(&project.id, "idle").await;
        Ok(session)
    }

    /// Records the thinking level the host reports for the leg `token` names,
    /// as the leg's own report of it.
    fn confirm_thinking(&self, token: &str, state: &SessionState) {
        if state.thinking.is_empty() {
            return;
        }
        if let Err(error) = self
            .coordinator
            .accept_thinking_callback(token, &state.thinking)
        {
            tracing::debug!(%error, thinking = %state.thinking, "the reported thinking level was not recorded");
        }
    }

    /// The voice brief: how to reach the caller through the `switchboard`
    /// module, and where they can be sent.
    fn agent_brief(&self, project: &Project) -> String {
        let mut brief = AGENT_BRIEF_HEADER.replace("{project}", &project.id);
        brief.push_str(AGENT_BRIEF_TOOLS);
        let others = self
            .registry
            .projects
            .iter()
            .filter(|candidate| candidate.id != project.id)
            .map(|candidate| {
                format!(
                    "  - {}: {}\n",
                    candidate.id,
                    if candidate.description.is_empty() {
                        "no description"
                    } else {
                        candidate.description.as_str()
                    }
                )
            })
            .collect::<String>();
        if others.is_empty() {
            brief.push_str("  - none\n");
        } else {
            brief.push_str(&others);
        }
        brief.push_str("  If the project they want is not listed, return to the operator rather than guessing.\n");
        if self.planner.model_swaps {
            brief.push_str(AGENT_BRIEF_SWAPS);
        }
        brief.push_str(AGENT_BRIEF_END);
        brief
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

    /// Runs a redial `RedialPlanner::plan` decided on. The leg it changes
    /// must still be the leg on the line: a caller who has left it since (a
    /// transfer, a return, a rescue that did not make way for this redial) is
    /// not redialed back onto it, and nothing is touched.
    pub async fn redial(&mut self, plan: RedialPlan) -> Result<Reply, LifecycleError> {
        if self.coordinator.project_leg().as_ref() != Some(&plan.leg) {
            tracing::info!(project = %plan.project.id, "not redialing: the caller has left the leg it was planned for");
            return Err(LifecycleError::StaleLeg);
        }
        Ok(self.swap(plan).await)
    }

    /// Changes the leg on the line to what `plan` describes. A change that
    /// keeps the conversation is made on the live session (`set_model`,
    /// `set_thinking`); a fresh start ends the session and creates a new one.
    /// Either way the leg is staged and adopted like any new leg, under a new
    /// call token.
    async fn swap(&mut self, plan: RedialPlan) -> Reply {
        let RedialPlan {
            leg,
            project,
            spec,
            spoken,
            keep_context,
            intent,
            launch,
        } = plan;
        tracing::info!(
            project = %project.id,
            from = %leg.model,
            to = %spec,
            context = if keep_context { "kept" } else { "cleared" },
            "changing the model of the live leg"
        );
        let leg_token = uuid_like();
        let session_id = if keep_context {
            leg.persistent_session_id.clone()
        } else {
            uuid_like()
        };
        let candidate = CandidateLeg::new(
            project.id.clone(),
            project.id.clone(),
            session_id,
            leg_token.clone(),
            spec.clone(),
            thinking_in_spec(&spec),
        )
        .with_catalog(launch.catalog.clone());
        if let Err(error) = self.coordinator.begin_candidate(candidate) {
            tracing::warn!(project = %project.id, %error, "candidate startup for the model change was refused");
            return self.reply(
                [format!("I couldn't switch {}: {error}", project.id)],
                Some(error.to_string()),
            );
        }

        let switched = if keep_context {
            self.switch_live(&leg.model, &spec, &leg_token).await
        } else {
            // At most one live session per project: the old one ends first.
            if let Some(previous) = self.agent.take() {
                previous.close();
            }
            self.set_active_session(None).await;
            self.start_agent(&project, &spec, &leg_token, &launch).await
        };
        let session = match switched {
            Ok(session) => session,
            Err(error) => {
                tracing::error!(project = %project.id, %spec, %error, "could not change the leg's model");
                self.rollback_startup(format!("model change failed: {error}"));
                self.drop_agent().await;
                self.operator_note = Some(format!(
                    "{} could not be switched to {spec}: {error}",
                    project.id
                ));
                return self.reply(
                    [format!(
                        "I couldn't bring {} back on {spoken}: {error}",
                        project.id
                    )],
                    Some(error.to_string()),
                );
            }
        };
        self.set_active_session(Some(LegSession::Project(session.clone())))
            .await;

        // A fresh session knows nothing, and a kept one may have been asked
        // for more than the change: either way the caller's request goes on
        // as a turn. With nothing to pass on, no turn is started; the voice
        // brief of a fresh session rides on the caller's next line.
        let turn = if intent.trim().is_empty() {
            None
        } else {
            let prompt = format!(
                "[switchboard] You are now on {spec}.{} The caller asked: {}.",
                if keep_context {
                    ""
                } else {
                    " The earlier conversation was deliberately cleared."
                },
                intent.trim()
            );
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
                    "the agent never answered".to_owned()
                } else {
                    turn.error.clone()
                };
                tracing::error!(project = %project.id, %spec, %detail, "the switched leg never answered");
                session.close();
                self.rollback_startup(format!("prompt failed: {detail}"));
                self.drop_agent().await;
                self.operator_note = Some(format!(
                    "{} could not be switched to {spec}: {detail}",
                    project.id
                ));
                return self.reply(
                    [format!(
                        "{} didn't come back on {spoken}: {detail}",
                        project.id
                    )],
                    Some(detail),
                );
            }
            Some(turn)
        };

        if self.coordinator.is_candidate() {
            if let Err(error) = self.coordinator.adopt_candidate(&leg_token) {
                session.close();
                self.rollback_startup(format!("adoption failed: {error}"));
                self.drop_agent().await;
                return self.reply(
                    [format!("{} did not come up.", project.id)],
                    Some(error.to_string()),
                );
            }
        }
        self.coordinator.finish_intro();
        self.agent = Some(session);
        self.set_active_session(self.agent_leg()).await;
        self.announce_route().await;
        match turn {
            Some(turn) => self.reply_with_turn(turn),
            None => {
                let mut reply = self.reply(
                    [if keep_context {
                        format!("Now on {spoken}.")
                    } else {
                        format!("Now on {spoken}, starting fresh.")
                    }],
                    None,
                );
                reply.delivery_generation = Some(self.coordinator.generation());
                reply
            }
        }
    }

    /// Changes the live session's model and thinking level from `from` to
    /// `to`, and puts it on the call under `leg_token`. The session keeps its
    /// history.
    async fn switch_live(
        &self,
        from: &str,
        to: &str,
        leg_token: &str,
    ) -> Result<ProjectSession, PiSessionError> {
        let Some(session) = self.agent.clone() else {
            return Err(PiSessionError("the project session is gone".into()));
        };
        let (from_provider, from_model, from_thinking) = parse_spec(from);
        let (provider, model, thinking) = parse_spec(to);
        let mut state = SessionState::default();
        let model_changed = (&provider, &model) != (&from_provider, &from_model);
        if model_changed {
            state = session.set_model(&provider, &model).await?;
        }
        // A new model may come up at its own level, so the level asked for is
        // set again after it.
        if !thinking.is_empty() && (model_changed || thinking != from_thinking) {
            state = session.set_thinking(&thinking).await?;
        }
        session
            .join_call(leg_token, &self.persona, self.speech_deadline_ms)
            .await?;
        self.confirm_thinking(leg_token, &state);
        Ok(session)
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
        tracing::error!(%error, "operator unavailable after a failed turn");
        self.routing_unavailable()
    }
    async fn drop_agent(&mut self) {
        let was_on_a_project = self.coordinator.route() != OPERATOR;
        let project = self
            .agent
            .as_ref()
            .map(|session| session.label().to_owned());
        if let Some(s) = self.agent.take() {
            s.close();
        }
        if let Some(project) = project {
            self.announce_agent_state(&project, "finished").await;
        }
        self.set_active_session(self.operator_leg()).await;
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

    /// A routing outage is a page error, not a sentence synthesized into the
    /// call. `api.rs` turns this marker into `routing_unavailable`.
    fn routing_unavailable(&self) -> Reply {
        self.reply(
            std::iter::empty::<String>(),
            Some("routing_unavailable".into()),
        )
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
    async fn stop_project(&mut self, target: &str) -> Reply {
        if self.coordinator.route() == target {
            self.resume_blocked.insert(target.to_owned());
            self.drop_agent().await;
            return self.reply(
                [format!("Stopped {target}. You are back with the operator.")],
                None,
            );
        }
        if let Some(session) = self.background_agents.remove(target) {
            self.resume_blocked.insert(target.to_owned());
            self.coordinator.remove_background(&session.token());
            session.close();
            self.announce_agent_state(target, "finished").await;
            return self.reply([format!("Stopped {target}.")], None);
        }
        self.reply([format!("{target} is not running.")], None)
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

fn is_confirmation(text: &str) -> bool {
    matches!(
        text.trim().to_ascii_lowercase().as_str(),
        "yes" | "yeah" | "yep" | "confirm" | "do it" | "stop it"
    )
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

fn arg(signal: &Signal, name: &str) -> String {
    signal
        .args
        .get(name)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_owned()
}

fn arg_first(signal: &Signal, names: &[&str]) -> String {
    names
        .iter()
        .map(|name| arg(signal, name))
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

fn conversation_mode(signal: &Signal) -> crate::router::ConversationMode {
    match arg(signal, "mode").as_str() {
        "continue" => crate::router::ConversationMode::Continue,
        _ => crate::router::ConversationMode::Fresh,
    }
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

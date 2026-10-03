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
use crate::hosts::Hosts;
#[cfg(test)]
use crate::hosts::{FakeHostAgent, FakeLog, OnPrompt, Step};
#[cfg(test)]
use crate::lifecycle::CandidateLeg;
use crate::lifecycle::{Coordinator, StatusConfig};
#[cfg(test)]
use crate::models::ModelCatalog;
#[cfg(test)]
use crate::pi_client::ProjectLaunch;
use crate::pi_client::{
    ActivityCallback, LegSession, ModuleCallback, PiSession, ProjectSession, SessionClosedCallback,
    Signal, TurnCallback, ROUTE_TOOL,
};
use crate::prewarm::Prewarm;
#[cfg(test)]
use crate::redial::thinking_in_spec;
use crate::redial::RedialPlanner;
#[cfg(test)]
use crate::registry::Project;
use crate::registry::Registry;
use crate::reply::Reply;
use crate::residents::BackgroundRegistry;
use crate::router::{Decision, Router, UtilityDecision};
use futures_util::FutureExt;
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};
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
/// Told when a session that is not a background resident closes on its host:
/// project, session id and instance. The API retires it from the line.
pub type ForegroundClosedCallback =
    Arc<dyn Fn(String, String, u64) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;
pub type AgentStateCallback =
    Arc<dyn Fn(AgentStateNotice) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// What the incoming project leg is told about why the caller is arriving.
#[derive(Clone, Debug, Default)]
pub struct TransferContext {
    /// The caller's words, verbatim; empty when the page connected them.
    pub exact_caller_transcript: String,
    /// The transferring agent's reading of what the caller wants.
    pub derived_intent: String,
}

/// Marks the caller line a decision is handling, for the debug trace, and
/// clears it when dropped: at the end of the decision or when a rescue
/// aborts it.
struct UtteranceScope(Arc<StdMutex<Option<String>>>);

impl UtteranceScope {
    fn enter(slot: &Arc<StdMutex<Option<String>>>, utterance_id: &str) -> Self {
        *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) =
            Some(utterance_id.to_owned());
        Self(Arc::clone(slot))
    }
}

impl Drop for UtteranceScope {
    fn drop(&mut self) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}

pub struct Switchboard {
    pub registry: Arc<Registry>,
    pub(crate) pi_binary: String,
    pub(crate) operator_model: Option<String>,
    pub(crate) operator_system_prompt: String,
    pub(crate) operator_extension: Option<String>,
    pub(crate) persona: String,
    pub(crate) env: HashMap<String, String>,
    pub(crate) speech_deadline_ms: u64,
    pub(crate) activity_callback: Option<ActivityCallback>,
    route_callback: Option<RouteCallback>,
    pub(crate) agent_state_callback: Option<AgentStateCallback>,
    foreground_closed_callback: Option<ForegroundClosedCallback>,
    pub(crate) module_callback: Option<ModuleCallback>,
    pub(crate) turn_callback: Option<TurnCallback>,
    pub(crate) active_session: Arc<Mutex<Option<LegSession>>>,
    pub(crate) operator: Option<PiSession>,
    /// A separate process for second opinions and split dispatch. It must not
    /// share the operator's turn lock or conversation history.
    pub(crate) utility: Option<PiSession>,
    pub(crate) agent: Option<ProjectSession>,
    /// Resident project sessions and their guarded background prompts.
    pub(crate) background_agents: BackgroundRegistry,
    pub(crate) operator_note: Option<String>,
    /// The last request each project agent was given on this call. Routing
    /// shows it as the agent's task. Shared with `RoutingView`, which reads it
    /// without the PBX lock.
    pub(crate) agent_tasks: Arc<StdMutex<HashMap<String, String>>>,
    /// The call as Jev saw it for the utterance being handled, in plain text.
    /// The operator and the routing utility get the same facts.
    pub(crate) call_state: String,
    /// The caller line being handled, for the debug trace only. Set for one
    /// decision by `handle_decision_with_takeover`, and cleared when that
    /// decision ends or is cancelled; routing never reads it.
    trace_utterance: Arc<StdMutex<Option<String>>>,
    /// Project awaiting a caller confirmation before it is stopped.
    pub(crate) pending_stop: Option<String>,
    /// Projects explicitly stopped by the caller must start fresh once.
    pub(crate) resume_blocked: HashSet<String>,
    /// The one owner of the leg on the line, and of the status the page is
    /// shown.
    pub(crate) coordinator: Coordinator,
    /// The project hosts' links; project legs run over them.
    pub(crate) hosts: Hosts,
    /// The only owner of launch setup: catalogs and prepare reports are
    /// settled here at startup.
    pub(crate) prewarm: Arc<Prewarm>,
    /// Decides model and thinking changes, and which model a leg asks for.
    pub(crate) planner: RedialPlanner,
    /// The sole utterance routing decider. The operator remains the fallback
    /// conversation when this client is unavailable or unsure.
    pub(crate) router: Router,
    /// `PROJECT_TURN_TIMEOUT`, held per switchboard so a test can wait out a
    /// silent leg without waiting ten minutes.
    pub(crate) project_turn_timeout: Duration,
    floor_quiet_threshold: Duration,
    /// Read-only debug observer; never part of call control.
    pub(crate) debug: crate::debug::DebugBus,
}
impl Switchboard {
    pub fn new(config: &crate::Config, registry: Registry, prewarm: Arc<Prewarm>) -> Self {
        let jev = crate::jev::JevClient::new(
            config.jev_url.clone(),
            config.jev_key_file.clone(),
            Duration::from_millis(config.jev_timeout_ms),
        )
        .expect("build Jev HTTP client");
        Self::new_with_router(config, registry, prewarm, jev)
    }

    #[cfg(test)]
    pub(crate) fn new_with_jev(
        config: &crate::Config,
        registry: Registry,
        prewarm: Arc<Prewarm>,
        jev: crate::jev::JevClient,
    ) -> Self {
        Self::new_with_router(config, registry, prewarm, jev)
    }

    fn new_with_router(
        config: &crate::Config,
        registry: Registry,
        prewarm: Arc<Prewarm>,
        jev: crate::jev::JevClient,
    ) -> Self {
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
            foreground_closed_callback: None,
            module_callback: None,
            turn_callback: None,
            active_session: Arc::new(Mutex::new(None)),
            operator: None,
            utility: None,
            agent: None,
            background_agents: BackgroundRegistry::default(),
            operator_note: None,
            agent_tasks: Arc::new(StdMutex::new(HashMap::new())),
            call_state: String::new(),
            trace_utterance: Arc::new(StdMutex::new(None)),
            pending_stop: None,
            resume_blocked: HashSet::new(),
            coordinator,
            hosts,
            prewarm,
            planner,
            router,
            project_turn_timeout: PROJECT_TURN_TIMEOUT,
            floor_quiet_threshold: Duration::from_millis(config.floor_quiet_threshold_ms),
            debug: crate::debug::DebugBus::off(),
        }
    }

    pub fn floor_quiet_threshold(&self) -> Duration {
        self.floor_quiet_threshold
    }
    pub fn set_debug_bus(&mut self, bus: crate::debug::DebugBus) {
        self.debug = bus;
    }
    /// The project hosts' links; the application serves them on `/host`.
    pub fn hosts(&self) -> Hosts {
        self.hosts.clone()
    }
    /// The coordinator this switchboard reports to; the application shares it.
    pub fn coordinator(&self) -> Coordinator {
        self.coordinator.clone()
    }
    #[cfg(test)]
    pub(crate) fn foreground_busy_for_test(&self, project: &str) -> bool {
        self.agent
            .as_ref()
            .is_some_and(|session| session.label() == project && session.busy())
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

    pub(crate) async fn announce_agent_state(&self, project: &str, state: &str) {
        if let Some(callback) = &self.agent_state_callback {
            callback(AgentStateNotice {
                project: project.to_owned(),
                state: state.to_owned(),
            })
            .await;
        }
    }

    /// Evicts a resident as soon as its host reports session death. A callback
    /// from an old session cannot remove a replacement because the persistent
    /// id and unique live-handle instance are checked by the shared registry.
    pub(crate) fn session_closed_callback(&self) -> SessionClosedCallback {
        let registry = self.background_agents.clone();
        let coordinator = self.coordinator.clone();
        let state_callback = self.agent_state_callback.clone();
        let foreground_closed = self.foreground_closed_callback.clone();
        Arc::new(
            move |project: String, session_id: String, instance_id: u64| {
                let registry = registry.clone();
                let coordinator = coordinator.clone();
                let state_callback = state_callback.clone();
                let foreground_closed = foreground_closed.clone();
                Box::pin(async move {
                    let Some(session) = registry.remove_closed(&project, &session_id, instance_id)
                    else {
                        // Not a resident: it may be the agent on the line or
                        // a taken-over desk session. The PBX checks and
                        // retires it under its own lock.
                        if let Some(callback) = foreground_closed {
                            callback(project, session_id, instance_id).await;
                        }
                        return;
                    };
                    {
                        // Retire the call token before releasing the shared
                        // resident handle, so no request/display can pass the
                        // lifecycle check while cleanup is in flight.
                        coordinator.remove_background(&session.token());
                        if let Some(callback) = state_callback {
                            callback(AgentStateNotice {
                                project,
                                state: "finished".into(),
                            })
                            .await;
                        }
                    }
                })
            },
        )
    }

    pub fn set_foreground_closed_callback(&mut self, callback: Option<ForegroundClosedCallback>) {
        self.foreground_closed_callback = callback;
    }

    /// Retire the agent on the line when its host session has closed, so the
    /// route, status and routing state stop naming a dead agent before the
    /// caller speaks again. Only the exact closed session is retired.
    pub async fn retire_closed_foreground(
        &mut self,
        project: &str,
        session_id: &str,
        instance_id: u64,
    ) -> bool {
        let matches = self.agent.as_ref().is_some_and(|session| {
            session.label() == project
                && session.session_id() == session_id
                && session.instance_id() == instance_id
        });
        if !matches {
            return false;
        }
        tracing::warn!(%project, "the agent on the line closed on its host; returning to the operator");
        self.drop_agent().await;
        self.operator_note = Some(format!(
            "Work on {project} stopped: its session closed on the host."
        ));
        true
    }

    /// Receives project turn boundaries from host agents.
    pub fn set_turn_callback(&mut self, callback: Option<TurnCallback>) {
        self.turn_callback = callback;
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

    pub(crate) fn rollback_startup(&self, reason: impl Into<String>) {
        self.coordinator.rollback_startup(reason);
    }

    pub fn session_control(&self) -> Arc<Mutex<Option<LegSession>>> {
        Arc::clone(&self.active_session)
    }

    pub(crate) async fn set_active_session(&self, session: Option<LegSession>) {
        *self.active_session.lock().await = session;
    }

    pub(crate) fn operator_leg(&self) -> Option<LegSession> {
        self.operator.clone().map(LegSession::Operator)
    }

    pub(crate) fn agent_leg(&self) -> Option<LegSession> {
        self.agent.clone().map(LegSession::Project)
    }

    pub fn route_label(&self) -> String {
        self.coordinator.route_label()
    }
    pub async fn shutdown(&mut self) {
        if let Some(session) = self.agent.take() {
            session.close();
        }
        self.background_agents.cancel_all_tasks().await;
        for session in self.background_agents.drain_sessions() {
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

    pub(crate) fn set_agent_task(&self, project: &str, text: &str) {
        self.agent_tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(project.to_owned(), text.to_owned());
    }

    /// Dispatch an utterance after Jev has made the routing decision. An
    /// unsure or unsupported action deliberately goes through the existing
    /// operator LLM path; project agents never mutate the route themselves.
    /// Dispatches a decision from a direct caller. Takeover discovery happens
    /// before this switchboard can be held by an outer request lock.
    #[cfg(test)]
    pub async fn handle_decision(&mut self, text: &str, decision: &Decision) -> Reply {
        let takeover = match (
            matches!(decision.action, crate::router::Action::TakeOver),
            decision.target.as_deref(),
        ) {
            (true, Some(target)) => Some(self.desk_session_for_takeover_target(target).await),
            _ => None,
        };
        self.handle_decision_with_takeover("utterance", text, decision, takeover)
            .await
    }

    /// Applies a decision after any host-owned takeover lookup has completed.
    /// The API worker uses this entry point so the PBX mutex is not held while
    /// `list_sessions` waits on a host link.
    pub(crate) async fn handle_decision_with_takeover(
        &mut self,
        utterance_id: &str,
        text: &str,
        decision: &Decision,
        takeover: Option<Result<Option<Value>, String>>,
    ) -> Reply {
        // Dropped when the decision ends or a rescue aborts it part way, so
        // a cancelled utterance's id never labels later work.
        let _scope = UtteranceScope::enter(&self.trace_utterance, utterance_id);
        let reply = self
            .handle_decision_for_state(text, decision, takeover)
            .await;
        // The call state belongs to this utterance only.
        self.call_state.clear();
        reply
    }

    /// The caller line this decision is handling; `None` outside one.
    pub(crate) fn current_utterance(&self) -> Option<String> {
        self.trace_utterance
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Publish one hop of the current utterance's routing trace. Outside a
    /// caller decision there is no utterance, and nothing is published.
    pub(crate) fn trace(&self, event: impl FnOnce(String) -> crate::debug::DebugEvent) {
        if let Some(utterance_id) = self.current_utterance() {
            self.debug.publish(event(utterance_id));
        }
    }

    fn trace_branch(&self, branch: &str, reason: String) {
        self.trace(|utterance_id| crate::debug::DebugEvent::PbxBranch {
            utterance_id,
            branch: branch.to_owned(),
            reason,
        });
    }

    fn trace_routed(&self, to_agent: &str, text_part: &str, mode: &str, via: &str) {
        self.trace(|utterance_id| crate::debug::DebugEvent::Routed {
            utterance_id,
            to_agent: to_agent.to_owned(),
            text_part: text_part.to_owned(),
            mode: mode.to_owned(),
            via: via.to_owned(),
        });
    }

    /// A destination that is not a registered project: the switchboard
    /// refuses it and answers the caller itself.
    fn trace_refused(&self, target: &str, text: &str, via: &str) {
        self.trace_branch(
            "refused_unknown_target",
            format!("{via} chose {target:?}, which is not a registered project, so the switchboard refused it"),
        );
        self.trace_routed(OPERATOR, text, "continue", "pbx");
    }

    async fn handle_decision_for_state(
        &mut self,
        text: &str,
        decision: &Decision,
        takeover: Option<Result<Option<Value>, String>>,
    ) -> Reply {
        // These actions are owned by the PBX, not by an agent. A stop decision
        // is deliberately confirmation-only here; the next utterance must
        // confirm before a resident session is closed.
        let mut note = String::new();
        if let Some(target) = self.pending_stop.take() {
            if is_confirmation(text) {
                self.trace_branch(
                    "stop_confirmed",
                    format!("the caller confirmed stopping {target}"),
                );
                self.trace_routed(OPERATOR, text, "continue", "pbx");
                return self.stop_project(&target).await;
            }
            note = format!("the pending stop of {target} was not confirmed, so it was dropped; ");
        }
        if matches!(decision.action, crate::router::Action::Stop) {
            let target = decision.target.clone().or_else(|| {
                (self.coordinator.route() != OPERATOR).then(|| self.coordinator.route())
            });
            let Some(target) = target else {
                self.trace_branch(
                    "stop_asked",
                    format!("{note}Jev chose stop, but nothing is running to stop"),
                );
                self.trace_routed(OPERATOR, text, "continue", "pbx");
                return self.reply(["Nothing is running to stop."], None);
            };
            self.trace_branch(
                "stop_asked",
                format!(
                    "{note}Jev chose stop for {target}; a stop always asks the caller to confirm"
                ),
            );
            self.trace_routed(OPERATOR, text, "continue", "pbx");
            self.pending_stop = Some(target.clone());
            return self.reply(
                [format!(
                    "Do you want me to stop {target}? Say yes to confirm."
                )],
                None,
            );
        }
        if matches!(decision.action, crate::router::Action::TakeOver) {
            if let Some(target) = decision.target.as_deref() {
                self.trace_branch(
                    "take_over",
                    format!("{note}Jev chose take_over of the desk session for {target}"),
                );
                let Some(takeover) = takeover else {
                    self.trace_routed(OPERATOR, text, "continue", "pbx");
                    return self.reply_failure(
                        "I couldn't check what's open at your desk, so I didn't take it over."
                            .into(),
                        "takeover lookup was not prepared",
                    );
                };
                if self.registry.get(target).is_some() {
                    self.trace_routed(target, text, "take_over", "jev");
                } else {
                    self.trace_refused(target, text, "jev");
                }
                return self.take_over(text, target, takeover).await;
            }
            self.trace_branch(
                "take_over",
                format!("{note}Jev chose take_over without a target, so the caller is asked which"),
            );
            self.trace_routed(OPERATOR, text, "continue", "pbx");
            return self.reply(
                ["Tell me which project you want to take over."],
                Some("takeover target missing".into()),
            );
        }
        if matches!(decision.action, crate::router::Action::AnswerWaiting) {
            if let Some(target) = decision.target.as_deref() {
                self.trace_branch(
                    "answer_waiting",
                    format!("{note}the caller answered {target}, which is waiting to speak"),
                );
                return self
                    .route_project_part(
                        text,
                        target,
                        crate::router::ConversationMode::Continue,
                        Some("jev"),
                    )
                    .await;
            }
        }

        // Jev's outage is the conversational LLM fallback. A healthy or
        // unavailable Jev decision that is unsure (or addresses multiple
        // projects) gets an isolated utility call before the caller is asked
        // to clarify. Jev is still called exactly once by the API worker;
        // this is only a second routing opinion from the stateless utility.
        let utility_required = decision.multi_target || decision.unsure;
        if utility_required {
            self.trace_branch(
                "utility",
                if decision.multi_target {
                    format!("{note}Jev found several targets (multi_target), so the routing utility splits the utterance")
                } else {
                    format!(
                        "{note}Jev was unsure, so the routing utility gives a second opinion ({})",
                        decision.reason
                    )
                },
            );
            let request = self.utility_routing_request(text, decision, false);
            let first = self.utility_decision(&request, "first").await;
            if decision.multi_target {
                match first {
                    Ok(Some(UtilityDecision::DispatchParts(parts))) => {
                        return self.dispatch_parts(text, parts).await;
                    }
                    Ok(_) => {
                        // Jev found several targets. A one-target or empty
                        // utility answer is not permission to send the whole
                        // utterance to the current agent, so ask once with an
                        // explicit split instruction.
                        let retry = self
                            .utility_decision(
                                &self.utility_routing_request(text, decision, true),
                                "split_retry",
                            )
                            .await;
                        match retry {
                            Ok(Some(UtilityDecision::DispatchParts(parts))) => {
                                return self.dispatch_parts(text, parts).await;
                            }
                            Ok(_) => {}
                            Err(error) => {
                                tracing::warn!(%error, "routing utility retry unavailable; asking the conversational operator");
                            }
                        }
                    }
                    Err(error) => {
                        tracing::warn!(%error, "routing utility unavailable; asking the conversational operator");
                    }
                }
            } else {
                match first {
                    Ok(Some(UtilityDecision::DispatchParts(parts))) => {
                        return self.dispatch_parts(text, parts).await;
                    }
                    Ok(Some(UtilityDecision::SecondOpinion {
                        target: Some(target),
                        mode,
                        confident: true,
                    })) => {
                        return self
                            .route_project_part(text, &target, mode, Some("utility"))
                            .await;
                    }
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!(%error, "routing utility unavailable; asking the conversational operator");
                    }
                }
            }
        }

        // A Jev multi-target verdict that the utility could not split must
        // never fall through to the current project with the whole utterance.
        // Let the conversational operator ask the caller instead.
        if decision.multi_target {
            self.trace_branch(
                "multi_unresolved",
                "the routing utility could not split a multi-target utterance, so the operator asks the caller".into(),
            );
            let context = TransferContext {
                exact_caller_transcript: text.to_owned(),
                derived_intent: String::new(),
            };
            return self.handle_operator_ctx(&context).await;
        }

        if matches!(decision.action, crate::router::Action::GoToProject)
            && !decision.sends_to_operator()
        {
            if let Some(target) = decision.target.as_deref() {
                // Jev's reason is an internal routing record, not caller
                // intent, so only the caller's words go to the target. The
                // shared path validates the id, brings a live agent on this
                // call forward, and starts one otherwise.
                let mode = decision
                    .continue_or_fresh
                    .clone()
                    .unwrap_or(crate::router::ConversationMode::Continue);
                self.trace_branch(
                    "go_to_project",
                    format!(
                        "{note}Jev chose go_to_project to {target} ({}): {}",
                        mode.as_str(),
                        decision.reason
                    ),
                );
                return self
                    .route_project_part(text, target, mode, Some("jev"))
                    .await;
            }
        }
        if matches!(decision.action, crate::router::Action::Continue)
            && !decision.sends_to_operator()
            && self.coordinator.route() != OPERATOR
        {
            let route = self.coordinator.route();
            self.trace_branch(
                "continue_current",
                format!(
                    "{note}Jev chose continue, so {route} keeps the line: {}",
                    decision.reason
                ),
            );
            // With its leg gone, the operator takes the line and records
            // its own destination.
            if self.agent.is_some() {
                self.trace_routed(&route, text, "continue", "jev");
            }
            return self
                .handle_agent_ctx(&TransferContext {
                    exact_caller_transcript: text.to_owned(),
                    derived_intent: String::new(),
                })
                .await;
        }
        self.trace_branch(
            "operator",
            if utility_required {
                format!("{note}the routing utility gave no confident destination, so the operator handles it")
            } else {
                format!(
                    "{note}Jev chose {} on {}, which the operator handles: {}",
                    decision.action.as_str(),
                    self.coordinator.route(),
                    decision.reason
                )
            },
        );
        let context = TransferContext {
            exact_caller_transcript: text.to_owned(),
            derived_intent: String::new(),
        };
        self.handle_operator_ctx(&context).await
    }

    /// Sends `text` to `target`. `via` names who chose the target, for the
    /// `routed` event, which goes out only once the target is known to be
    /// registered; `None` when the caller already traced it. The operator,
    /// and a line whose leg turns out to be gone, are traced by the
    /// operator's own hop.
    async fn route_project_part(
        &mut self,
        text: &str,
        target: &str,
        mode: crate::router::ConversationMode,
        via: Option<&str>,
    ) -> Reply {
        let context = TransferContext {
            exact_caller_transcript: text.to_owned(),
            derived_intent: String::new(),
        };
        // Targets from Jev, the utility and the operator are exact ids. An
        // unknown one must not move the caller or drop the leg on the line.
        if target != OPERATOR && self.registry.get(target).is_none() {
            tracing::warn!(%target, "refusing a route to an unregistered project");
            self.trace_refused(target, text, via.unwrap_or("routing"));
            return self.reply_transfer_error(
                self.unknown_project_line(target),
                Some(format!("unknown project {target:?}")),
            );
        }
        if let Some(via) = via {
            let leg_gone = self.coordinator.route() == target && self.agent.is_none();
            if target != OPERATOR && !leg_gone {
                self.trace_routed(target, text, mode.as_str(), via);
            }
        }
        if target != OPERATOR {
            self.set_agent_task(target, text);
        }
        // An agent already on this call (on the line or in the background)
        // is brought forward whatever the mode: a live agent is never
        // refused or silently replaced. Stopping it is the way to start over.
        if matches!(mode, crate::router::ConversationMode::Fresh)
            && target != OPERATOR
            && (self.coordinator.route() == target || self.background_agents.contains_key(target))
        {
            tracing::info!(%target, "fresh was asked for a live agent on this call; bringing it forward");
        }
        if target != OPERATOR && self.coordinator.route() != target {
            if self.remove_dead_background(target).await {
                self.announce_agent_state(target, "finished").await;
            }
            if self.background_agents.contains_key(target) {
                let session = self
                    .take_background(target)
                    .await
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
        if self.coordinator.route() == target {
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
        let (parts, unknown): (Vec<_>, Vec<_>) = parts
            .into_iter()
            .partition(|part| self.registry.get(&part.agent).is_some());
        for part in &unknown {
            tracing::warn!(project = %part.agent, "dropping a split part for an unregistered project");
            self.trace_branch(
                "refused_unknown_target",
                format!(
                    "the routing utility sent a part to {:?}, which is not a registered project; that part was dropped",
                    part.agent
                ),
            );
        }
        // One utterance fans out to every part's agent.
        for part in &parts {
            self.trace_routed(&part.agent, &part.text, "continue", "utility");
        }
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
            None,
        )
        .await
    }

    /// The tests' way onto the line without a routing decision: the words go
    /// to whichever leg holds the route. Production always arrives through
    /// `handle_decision` with Jev's verdict, so this is test-only; the
    /// `allow(dead_code)` that used to sit here only hid that.
    #[cfg(test)]
    pub(crate) async fn handle(&mut self, text: &str) -> Reply {
        let context = TransferContext {
            exact_caller_transcript: text.to_owned(),
            derived_intent: String::new(),
        };
        if self.coordinator.route() == OPERATOR {
            self.handle_operator_ctx(&context).await
        } else {
            self.handle_agent_ctx(&context).await
        }
    }
    pub(crate) async fn handle_operator_ctx(&mut self, context: &TransferContext) -> Reply {
        let session = match self.ensure_operator().await {
            Ok(session) => session.clone(),
            Err(e) => {
                tracing::error!(error = %e, "operator unavailable");
                tracing::error!(error = %e, "operator unavailable for routing");
                self.trace_operator_hop(context, &context.exact_caller_transcript, "unavailable");
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
        // The operator keeps a conversation, but the call changes under it:
        // give it the same current facts Jev saw, once per turn.
        let operator_text = message.clone();
        let call_state = std::mem::take(&mut self.call_state);
        let message = if call_state.is_empty() {
            message
        } else {
            format!("[CALL STATE]\n{call_state}\n[END CALL STATE]\n\n{message}")
        };
        let utterance = self.current_utterance();
        let turn = match session.prompt_for(&message, utterance.as_deref()).await {
            Ok(turn) => turn,
            Err(error) => {
                tracing::warn!(%error, "the operator leg failed mid-prompt");
                self.trace_operator_hop(context, &operator_text, "failed");
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
            self.trace_operator_hop(context, &operator_text, "failed");
            return self.recover_operator(error).await;
        }
        if let Some(signal) = turn.signals.iter().find(|s| s.name == ROUTE_TOOL) {
            let target = arg_first(signal, &["target", "project"]);
            let mode = conversation_mode(signal);
            if target.is_empty() {
                self.trace_operator_hop(context, &operator_text, "route_tool_without_target");
                return self.reply([turn.text], None);
            }
            self.trace_operator_hop(context, &operator_text, "route_tool");
            let action = if target == OPERATOR {
                "return_to_operator"
            } else if target == self.coordinator.route() {
                "continue"
            } else {
                "transfer"
            };
            self.trace(|utterance_id| crate::debug::DebugEvent::OperatorRouteTool {
                utterance_id,
                target: target.clone(),
                mode: mode.as_str().into(),
                action: action.into(),
            });
            return self
                .route_project_part(
                    &context.exact_caller_transcript,
                    &target,
                    mode,
                    Some("operator"),
                )
                .await;
        }
        self.trace_operator_hop(context, &operator_text, "answered");
        self.reply([turn.text], None)
    }

    /// The operator's part in an utterance's trace. Unless it handed the
    /// caller on with its route tool, the operator is the destination: it
    /// answered (or its recovery did), so the trace ends in a `routed` to it.
    fn trace_operator_hop(&self, context: &TransferContext, text: &str, outcome: &str) {
        self.trace(|utterance_id| crate::debug::DebugEvent::OperatorHop {
            utterance_id,
            text: text.to_owned(),
            outcome: outcome.to_owned(),
        });
        if outcome != "route_tool" {
            self.trace_routed(
                OPERATOR,
                &context.exact_caller_transcript,
                "continue",
                "operator",
            );
        }
    }

    async fn handle_agent_ctx(&mut self, context: &TransferContext) -> Reply {
        let Some(session) = self.agent.clone() else {
            tracing::warn!(route = %self.coordinator.route(), "the project leg is gone; returning to the operator");
            let note = stopped_note(&self.route_label(), "it is no longer running");
            return self.return_operator_ctx(context, &note).await;
        };
        // A synthetic/background token can coexist in lifecycle tests while
        // the foreground handle is still being drained. In production a
        // promoted resident is removed first; avoid clearing its waiting
        // request in that transitional case.
        if !self.coordinator.project_is_background(session.label()) {
            self.announce_agent_state(session.label(), "busy").await;
        }
        self.set_agent_task(session.label(), &context.exact_caller_transcript);
        let utterance = self.current_utterance();
        let turn = match session
            .prompt_as(
                &context.exact_caller_transcript,
                "caller",
                utterance.as_deref(),
            )
            .await
        {
            Ok(t) => t,
            Err(error) => {
                let detail = error.to_string();
                let name = self.route_label();
                tracing::warn!(route = %name, %error, "the project leg failed mid-prompt; returning to the operator");
                self.drop_agent().await;
                self.operator_note = Some(stopped_note(&name, &detail));
                return self.reply_failure(
                    format!("{name} stopped responding, so I closed it."),
                    detail,
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
            self.operator_note = Some(stopped_note(&name, &detail));
            return self.reply_failure(
                format!("{name} stopped responding, so I closed it."),
                detail,
            );
        }
        self.reply_with_turn(turn)
    }
}

fn is_confirmation(text: &str) -> bool {
    matches!(
        text.trim().to_ascii_lowercase().as_str(),
        "yes" | "yeah" | "yep" | "confirm" | "do it" | "stop it"
    )
}

/// The operator's note when work on `name` stopped under the caller.
fn stopped_note(name: &str, detail: &str) -> String {
    format!("Work on {name} stopped: {}.", detail.trim_end_matches('.'))
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
        "fresh" => crate::router::ConversationMode::Fresh,
        // Omitted or unknown: never treat it as a request to start over.
        _ => crate::router::ConversationMode::Continue,
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

/// The host every project in these tests runs on.
#[cfg(test)]
pub(crate) const HOST: &str = "scriptorium";

#[cfg(test)]
pub(crate) fn board_with(projects: Vec<Project>, model_swaps: bool) -> Switchboard {
    let swaps = if model_swaps { "1" } else { "0" };
    board_on(
        projects,
        &[("SWITCHBOARD_MODEL_SWAPS", swaps)],
        two_model_catalog(),
    )
}

/// A switchboard over a prewarm that has already settled, every host's
/// catalog being `catalog`.
#[cfg(test)]
pub(crate) fn board_on(
    projects: Vec<Project>,
    settings: &[(&str, &str)],
    catalog: ModelCatalog,
) -> Switchboard {
    let config = crate::Config::for_tests(settings);
    let registry = Registry::new(projects);
    let prewarm = crate::prewarm::Prewarm::settled(&config, &registry, catalog);
    let mut board = Switchboard::new(&config, registry, Arc::new(prewarm));
    board.set_debug_bus(crate::debug::DebugBus::new());
    board
}

/// Links `HOST` to `board` with a fake host agent that runs `on_prompt` for
/// every prompt.
#[cfg(test)]
pub(crate) fn serve(board: &Switchboard, on_prompt: OnPrompt) -> FakeLog {
    FakeHostAgent::new(on_prompt).serve(board.hosts().connect_fake(HOST))
}

/// A turn that says `text` and settles.
#[cfg(test)]
pub(crate) fn says(text: &str) -> Vec<Step> {
    vec![Step::Event(json!({"kind": "text", "text": text}))]
}

/// A project on `HOST`.
#[cfg(test)]
pub(crate) fn project(id: &str, description: &str) -> Project {
    Project {
        id: id.into(),
        description: description.into(),
        aliases: vec![],
        host: Some(HOST.into()),
        cwd: format!("/srv/{id}"),
        model: Some("anthropic/current".into()),
        prepare: String::new(),
    }
}

/// The messages `log`'s host agent was prompted with, oldest first.
#[cfg(test)]
pub(crate) fn prompts(log: &FakeLog) -> Vec<String> {
    log.named("prompt")
        .iter()
        .map(|args| args["message"].as_str().unwrap().to_owned())
        .collect()
}

/// Waits until `log`'s host agent was sent a `name` command.
#[cfg(test)]
pub(crate) async fn until_named(log: &FakeLog, name: &str) -> Vec<Value> {
    for _ in 0..500 {
        let named = log.named(name);
        if !named.is_empty() {
            return named;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the host agent was never sent {name}: {:?}", log.names());
}

#[cfg(unix)]
#[cfg(test)]
pub(crate) fn scratch_dir(label: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("switchboard-{label}-{}", uuid_like()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// Puts the call on `project` the way a transfer leaves it, without launching
/// anything: a candidate on `spec` and `catalog`, adopted, its intro finished.
#[cfg(test)]
pub(crate) fn put_on(board: &Switchboard, project: &str, spec: &str, catalog: ModelCatalog) {
    board
        .coordinator
        .begin_candidate(
            CandidateLeg::new(
                project,
                project,
                "live-session",
                "live-leg",
                spec,
                thinking_in_spec(spec),
            )
            .with_catalog(catalog),
        )
        .unwrap();
    board.coordinator.adopt_candidate("live-leg").unwrap();
    assert!(board.coordinator.finish_intro());
}

#[cfg(test)]
pub(crate) fn two_model_catalog() -> ModelCatalog {
    ModelCatalog {
        entries: ["current", "next"]
            .into_iter()
            .map(|model| crate::models::CatalogEntry {
                provider: "anthropic".into(),
                model: model.into(),
                thinks: true,
            })
            .collect(),
        available: true,
        diagnostic: None,
    }
}

#[cfg(test)]
pub(crate) fn transcript(text: &str) -> TransferContext {
    TransferContext {
        exact_caller_transcript: text.into(),
        ..TransferContext::default()
    }
}

/// A switchboard with the caller on alpha, whose host agent runs `on_prompt`.
#[cfg(test)]
pub(crate) async fn on_alpha(
    settings: &[(&str, &str)],
    on_prompt: OnPrompt,
) -> (Switchboard, FakeLog) {
    let mut board = board_on(vec![project("alpha", "")], settings, two_model_catalog());
    let log = serve(&board, on_prompt);
    let reply = board
        .transfer_ctx(&transcript("look at alpha"), "alpha", "", "")
        .await;
    assert_eq!(reply.route, "alpha", "{reply:?}");
    (board, log)
}

#[cfg(test)]
pub(crate) fn decision(
    action: crate::router::Action,
    target: Option<&str>,
    mode: Option<crate::router::ConversationMode>,
) -> Decision {
    Decision {
        action,
        target: target.map(str::to_owned),
        continue_or_fresh: mode,
        confidence: 0.9,
        for_current_agent: 0.1,
        multi_target: false,
        unsure: false,
        confirm: false,
        reason: "test".into(),
    }
}

#[cfg(test)]
#[path = "../tests/test_pbx.rs"]
mod tests;

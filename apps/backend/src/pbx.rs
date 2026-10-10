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
//!
//! This file holds the `Switchboard`'s state, its construction, callbacks and
//! shutdown, and the types the rest of it shares. The methods live with their
//! concern, each an `impl Switchboard` of its own: `decisions.rs`,
//! `leg_transitions.rs`, `redial.rs`, `residents.rs`, `operator.rs` and
//! `routing_view.rs`; the prompt text is in `prompts.rs` and the reply shape
//! in `reply.rs`.
use crate::decisions::DecisionState;
use crate::hosts::Hosts;
#[cfg(test)]
use crate::hosts::{FakeHostAgent, FakeLog, OnPrompt, Step};
use crate::leg_transitions::LegLaunch;
#[cfg(test)]
use crate::lifecycle::CandidateLeg;
use crate::lifecycle::{Coordinator, StatusConfig};
#[cfg(test)]
use crate::models::ModelCatalog;
use crate::operator::OperatorLaunch;
use crate::pi_client::{
    ActivityCallback, LegSession, PiSession, ProjectSession, SessionClosedCallback,
};
use crate::prewarm::Prewarm;
#[cfg(test)]
use crate::redial::thinking_in_spec;
use crate::redial::RedialPlanner;
#[cfg(test)]
use crate::registry::Project;
use crate::registry::Registry;
use crate::residents::BackgroundRegistry;
#[cfg(test)]
use crate::router::Decision;
use crate::router::Router;
use futures_util::FutureExt;
#[cfg(test)]
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex;
use tokio::time::Duration;

pub const OPERATOR: &str = "operator";
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

pub struct Switchboard {
    pub registry: Arc<Registry>,
    /// How the operator and utility processes are launched; `operator.rs`
    /// owns it.
    pub(crate) launch: OperatorLaunch,
    pub(crate) persona: String,
    pub(crate) speech_deadline_ms: u64,
    pub(crate) activity_callback: Option<ActivityCallback>,
    route_callback: Option<RouteCallback>,
    pub(crate) agent_state_callback: Option<AgentStateCallback>,
    foreground_closed_callback: Option<ForegroundClosedCallback>,
    /// What a project leg is launched with; `leg_transitions.rs` owns it.
    pub(crate) legs: LegLaunch,
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
    /// What decision handling carries between decisions; `decisions.rs` owns it.
    pub(crate) decisions: DecisionState,
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
        let planner = RedialPlanner::new(
            coordinator.clone(),
            Arc::clone(&registry),
            Arc::clone(&prewarm),
            config.agent_model.clone(),
            config.model_swaps,
        );
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
            launch: OperatorLaunch::from_config(config),
            persona: config.persona.clone(),
            speech_deadline_ms: config.speech_deadline_ms,
            activity_callback: None,
            route_callback: None,
            agent_state_callback: None,
            foreground_closed_callback: None,
            legs: LegLaunch::default(),
            active_session: Arc::new(Mutex::new(None)),
            operator: None,
            utility: None,
            agent: None,
            background_agents: BackgroundRegistry::default(),
            operator_note: None,
            agent_tasks: Arc::new(StdMutex::new(HashMap::new())),
            call_state: String::new(),
            decisions: DecisionState::default(),
            coordinator,
            hosts,
            prewarm,
            planner,
            router,
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

    /// Empties the guard only if the operator holds it: a project on the
    /// line keeps the guard while the operator answers for it.
    pub(crate) async fn release_operator_guard(&self) {
        let mut guard = self.active_session.lock().await;
        if matches!(*guard, Some(LegSession::Operator(_))) {
            *guard = None;
        }
    }

    pub(crate) fn operator_leg(&self) -> Option<LegSession> {
        self.operator.clone().map(LegSession::Operator)
    }

    pub(crate) fn agent_leg(&self) -> Option<LegSession> {
        self.agent.clone().map(LegSession::Project)
    }

    /// The PBX's project session, if it is the session of the project leg
    /// the coordinator names; `None` otherwise. Work done on the leg on the
    /// line (a caller turn, a redial) goes to this session only: a session
    /// of another project must never answer under that leg's name (#236).
    pub(crate) fn agent_on_the_line(&self) -> Option<ProjectSession> {
        let leg = self.coordinator.project_leg()?;
        self.agent
            .clone()
            .filter(|agent| agent.label() == leg.project)
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

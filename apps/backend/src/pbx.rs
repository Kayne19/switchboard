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
use crate::floor::FloorRewriteInput;
use crate::history::TranscriptEntry;
use crate::hosts::Hosts;
use crate::lifecycle::{CandidateLeg, Coordinator, LifecycleError, ProjectLeg, StatusConfig};
use crate::models::{normalize_thinking, parse_spec, pin_thinking, ModelCatalog};
use crate::pi_client::{
    local_argv, ActivityCallback, LegSession, ModuleCallback, PiSession, PiSessionError,
    ProjectLaunch, ProjectSession, SessionClosedCallback, SessionState, Signal, Turn, TurnCallback,
    ROUTE_TOOL,
};
use crate::prewarm::{LaunchPlan, Prewarm};
use crate::registry::{Project, Registry};
use crate::router::{
    utility_decision, CallSummary, Decision, DeskSession, Router, UtilityDecision,
};
use futures_util::{future::join_all, FutureExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
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

/// How anyone on the call talks. One code-owned text, followed by the
/// persona: the operator's and the utility's system prompts and every voice
/// brief carry the same two, so the caller hears one person all call.
const CALL_VOICE: &str = "[HOW YOU TALK ON THE CALL]
The caller hears one person for the whole call: you. Whatever part of the work you are on, it is the same character and the same voice. Treat all of the work as your own. Do not talk about other agents, sessions, an operator, models, tools or processes. If you have help, keep it out of sight, or at most mention it in passing, in character.

Match the moment. Most of the call is work. When the caller asks for something, acknowledge it and do it. Don't repeat the request, recite the plan or keep up a running commentary. Speak again when something changed, when you need a decision, or when you're asked. Never tell them what they already know or expect.

When the caller wants to talk something through, be a real partner in it, not a voice waiting for the next order. Bring substance: your own read, opinions, tradeoffs, pushback, ideas they haven't raised, and the question that moves it forward. Take the time the topic needs, and help steer where the discussion goes. Keep status short. Thinking out loud together gets as much room as it needs.

Show, don't tell. When you can put things on the caller's screen, say the short version out loud and put the detail on the screen. Keep the screen as clean as your speech. Take things down once they have done their job, when the topic moves on or the decision is made. Don't take them down as soon as your turn ends, because the caller may still be reading.

Give bad news straight: say what broke and what it means, with no apologies as padding. If the caller cuts in, drop what you were saying and answer the new thing.";

/// The voice brief's opening. The brief rides at the start of the first
/// prompt a project session gets for the caller, and again on the first after
/// a compaction; it is never a message of its own.
const AGENT_BRIEF_HEADER: &str = "[SWITCHBOARD VOICE BRIEF]\nYou are on a voice call, working in the {project} project in its own directory. The caller hears only what you pass to the `switchboard` module in your Python REPL (already imported). Your written replies go to a screen they may not be watching. They are never read aloud.\n";
/// The brief's job text, after the shared voice block.
const AGENT_BRIEF_BODY: &str = "Reaching the caller:\n- switchboard.speak(text): say it out loud, in plain spoken words. Anything that needs code, paths, lists or many numbers goes on the screen.\n- switchboard.display(...): put something on their screen. The types, data shapes and layout are in the switchboard skill's SKILL.md. Read it before your first display.\n- switchboard.view(): see what is on their screen now.\n- switchboard.request_to_speak(message, reason): how you get their attention while they are on other work. reason is finished, needs_decision or problem. message is what they should hear, said the way you would say it: the result, the question with its options, or what broke and what you need from them. Not a teaser.\n\nReport the things the caller asked for when they are done or stuck. Keep the steps along the way to yourself. While the caller is on other work, your displays wait until they come back to you. So in that time never say something is on screen; say it is ready.\n\nDecisions while the caller is quiet or away: make the calls that are cheap to undo, carry on, and say what you chose when you next report. Wait for the caller on decisions that set direction, that they would want to own, or that are expensive to reverse. While you wait, keep going on whatever does not depend on the answer.\n\nKeep yourself free to talk. You are the one the caller deals with. Give hands-on work (edits, builds, test runs, long investigations) to subagents that run your own model, several at once when the work splits. For brute-force searching and reading, use a cheaper, faster model, so that the big contexts stay small. Subagents cannot reach the caller. What they find comes to you, and you say it.\n\nYour context is this project's working memory for the call, and it costs. Keep it lean: subagents carry the detail and you keep the results. When a piece of work is truly finished and nothing for it is still running, write down what should outlast it, in an issue, a doc or a commit, and then compact yourself. Don't compact while work is in flight or in the middle of a discussion. When you compact, make sure the summary keeps what is still open and what was decided. After a compaction, when you need something from earlier in the call, search your own conversation log (its path is in your system prompt) instead of guessing. A session nobody uses is ended, and the next call starts fresh, so anything you did not write down is gone.\n\nMoving the caller to other work, model changes and hanging up happen before your turn, and you have no tools for them. If the caller asks for something that belongs to another project, say so briefly. When they name that project, the call takes them there.\n";
const AGENT_BRIEF_END: &str = "[END OF VOICE BRIEF]";

/// Steered into a busy session when the caller moves on to other work.
const BACKGROUND_NOTICE: &str = "[switchboard] The caller has moved on to other work. Keep going quietly. They cannot hear speak() now, and your displays wait until they come back to you. When something they asked for is done or stuck, or you need a decision, send it with request_to_speak in the words they should hear.";
/// Sent with the first caller words after a background agent is brought
/// forward, so its background instructions stop applying.
const FOREGROUND_NOTICE: &str = "[switchboard] The caller came back to you: you are in the foreground now. speak() is heard directly, and anything you held is on the screen. Do not repeat what you already sent them unless they ask. Their words follow.";
/// Instructions for the separate, stateless process. This is code-owned so
/// deploying the utility never requires another environment setting.
const UTILITY_SYSTEM_PROMPT: &str = "You are a background helper on a voice call. You never talk to the caller and never answer questions. Each request needs exactly one tool call. Make it and write nothing else.

[ROUTING REQUEST]: decide where the caller's words go. If one registered project fits, call second_opinion. Set confident only when both the project and the intent are clear. Leave target empty when the caller should be asked. If the caller asks several projects for things at once, call dispatch_parts with one part per project, each part in the caller's own words. If the caller wants to hear or see something a project has waiting, that project is the target. Use mode fresh only when the caller asks to start over. Never invent a project.

[FLOOR REWRITE]: call rewrite with the message the way the caller should hear it next. The message comes from the person they have been talking to all call. Keep its voice and its first person, and never pass it on as news from someone else. Keep every fact and add none. Smooth it so it follows from what was just said, and vary how you start. If the caller has been quiet a while, ease in so they know which work it is about. Never say something is on screen. If a display is held, say it is ready when they want it.";
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
    /// Whether this reply contains text synthesized for the caller.
    pub voiced: bool,
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
            .collect::<Vec<_>>();
        let voiced = !to_speak.is_empty();
        Self {
            text,
            route: route.into(),
            route_label: label.into(),
            error,
            to_speak,
            voiced,
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
    let mut prompt = String::from("The caller was just put through to you with this request. They know where they are, so skip greetings and do not restate it. Just pick it up.\n\n");

    prompt.push_str("[CALLER REQUEST]\n");
    if context.exact_caller_transcript.is_empty() {
        prompt.push_str("(none yet: the caller opened this project from the page. Say nothing now. Their words come next. Answer them right away and keep it short.)\n");
    } else {
        prompt.push_str(&context.exact_caller_transcript);
        prompt.push('\n');
    }

    if !context.derived_intent.is_empty() {
        prompt.push_str("[WHAT THEY SEEM TO WANT]\n");
        prompt.push_str(&context.derived_intent);
        prompt.push('\n');
    }

    prompt.push_str("[PROJECT]\n");
    if project.description.is_empty() {
        prompt.push_str(&project.id);
    } else {
        prompt.push_str(&format!("{} - {}", project.id, project.description));
    }
    prompt.push('\n');

    if let Some(rep) = prepare_report {
        prompt.push_str("[STARTUP CHECK]\n");
        prompt.push_str(&format!("{:?} {:?}", rep.source, rep.outcome));
        if let Some(code) = rep.exit_code {
            prompt.push_str(&format!(", exit {code}"));
        }
        prompt.push_str(&format!(", {} ms.", rep.duration_ms));
        for output in [&rep.stdout, &rep.stderr] {
            if !output.is_empty() {
                prompt.push(' ');
                prompt.push_str(output);
            }
        }
        prompt.push_str("\nFor you only. Mention it only if it matters to the request.\n");
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
                ["I can only change the model while we're on a project."],
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
                            "Thinking is set to {value} for the next project I open."
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
            return self.answer(["We're not on a project right now."], None);
        };
        if !self.model_swaps {
            return self.answer(["Model changes are turned off."], None);
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
                return Redial::Answered(failure_reply(
                    &self.coordinator,
                    "I couldn't change the model.".into(),
                    error,
                ));
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
                return Redial::Answered(failure_reply(
                    &self.coordinator,
                    "I couldn't change the model.".into(),
                    error.to_string(),
                ));
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

/// Owns resident sessions and the task reservations that may write their
/// lifecycle projection. Callers never mutate the resident map directly: every
/// removal invalidates the task epoch first, so a late completion cannot make a
/// replaced or promoted session look idle.
#[derive(Clone)]
struct BackgroundRegistry {
    // Session membership is shared with the closed-session reaper. The PBX
    // still owns lifecycle decisions, while a host death can evict its
    // resident immediately from the pump task.
    sessions: Arc<StdMutex<HashMap<String, ProjectSession>>>,
    tasks: Arc<StdMutex<HashMap<String, JoinHandle<()>>>>,
    epochs: Arc<StdMutex<HashMap<String, Arc<AtomicU64>>>>,
    next_epoch: Arc<AtomicU64>,
}

impl Default for BackgroundRegistry {
    fn default() -> Self {
        Self {
            sessions: Arc::new(StdMutex::new(HashMap::new())),
            tasks: Arc::new(StdMutex::new(HashMap::new())),
            epochs: Arc::new(StdMutex::new(HashMap::new())),
            next_epoch: Arc::new(AtomicU64::new(1)),
        }
    }
}

impl BackgroundRegistry {
    #[cfg(test)]
    pub(crate) fn sessions_snapshot_for_test(&self) -> Vec<(String, ProjectSession)> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|(project, session)| (project.clone(), session.clone()))
            .collect()
    }

    fn projects(&self) -> Vec<String> {
        let mut projects = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        projects.sort();
        projects
    }

    fn contains_key(&self, project: &str) -> bool {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(project)
    }

    fn get(&self, project: &str) -> Option<ProjectSession> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(project)
            .cloned()
    }

    fn insert(&self, project: String, session: ProjectSession) {
        self.epochs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(project.clone())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)));
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(project, session);
    }

    fn remove(&self, project: &str) -> Option<ProjectSession> {
        self.invalidate(project);
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(project)
    }

    fn remove_closed(
        &self,
        project: &str,
        session_id: &str,
        instance_id: u64,
    ) -> Option<ProjectSession> {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if sessions.get(project).is_some_and(|session| {
            session.session_id() == session_id && session.instance_id() == instance_id
        }) {
            self.invalidate(project);
            sessions.remove(project)
        } else {
            None
        }
    }

    fn invalidate(&self, project: &str) {
        if let Some(epoch) = self
            .epochs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(project)
        {
            epoch.fetch_add(1, Ordering::AcqRel);
        }
    }

    fn begin_task(&self, project: &str) -> (Arc<AtomicU64>, u64) {
        let mut epochs = self
            .epochs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let epoch = epochs
            .entry(project.to_owned())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)))
            .clone();
        let generation = self.next_epoch.fetch_add(1, Ordering::Relaxed);
        epoch.store(generation, Ordering::Release);
        (epoch, generation)
    }

    fn set_task(&self, project: String, task: JoinHandle<()>) {
        if let Some(previous) = self
            .tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(project, task)
        {
            previous.abort();
        }
    }

    fn take_task(&self, project: &str) -> Option<JoinHandle<()>> {
        self.invalidate(project);
        self.tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(project)
    }

    async fn cancel_task(&self, project: &str) {
        if let Some(task) = self.take_task(project) {
            task.abort();
            let _ = task.await;
        }
    }

    fn drain_sessions(&self) -> Vec<ProjectSession> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .map(|(_, session)| session)
            .collect()
    }

    async fn cancel_all_tasks(&self) {
        let tasks = self
            .tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .map(|(_, task)| task)
            .collect::<Vec<_>>();
        for task in tasks {
            task.abort();
            let _ = task.await;
        }
    }
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

/// What routing reads about the call, without the PBX lock. The turn worker
/// holds that lock for a whole prompt; a caller utterance that arrives during
/// the prompt must still be routed while it runs, or it can never be steered
/// into it (#108). Every field is shared with the switchboard, not copied.
#[derive(Clone)]
pub struct RoutingView {
    hosts: Hosts,
    registry: Arc<Registry>,
    router: Router,
    coordinator: Coordinator,
    background_agents: BackgroundRegistry,
    agent_tasks: Arc<StdMutex<HashMap<String, String>>>,
}

impl RoutingView {
    pub fn hosts(&self) -> Hosts {
        self.hosts.clone()
    }

    pub fn registry(&self) -> Arc<Registry> {
        Arc::clone(&self.registry)
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
        let background = self.background_agents.projects();
        let agent_tasks = self
            .agent_tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        CallSummary::from_runtime(
            &self.coordinator.status(),
            &self.registry,
            transcript,
            screen,
            utterance,
            &background,
            &agent_tasks,
        )
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
    foreground_closed_callback: Option<ForegroundClosedCallback>,
    module_callback: Option<ModuleCallback>,
    turn_callback: Option<TurnCallback>,
    active_session: Arc<Mutex<Option<LegSession>>>,
    operator: Option<PiSession>,
    /// A separate process for second opinions and split dispatch. It must not
    /// share the operator's turn lock or conversation history.
    utility: Option<PiSession>,
    agent: Option<ProjectSession>,
    /// Resident project sessions and their guarded background prompts.
    background_agents: BackgroundRegistry,
    operator_note: Option<String>,
    /// The last request each project agent was given on this call. Routing
    /// shows it as the agent's task. Shared with `RoutingView`, which reads it
    /// without the PBX lock.
    agent_tasks: Arc<StdMutex<HashMap<String, String>>>,
    /// The call as Jev saw it for the utterance being handled, in plain text.
    /// The operator and the routing utility get the same facts.
    call_state: String,
    /// The caller line being handled, for the debug trace only. Set for one
    /// decision by `handle_decision_with_takeover`, and cleared when that
    /// decision ends or is cancelled; routing never reads it.
    trace_utterance: Arc<StdMutex<Option<String>>>,
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
    floor_quiet_threshold: Duration,
    /// Read-only debug observer; never part of call control.
    debug: crate::debug::DebugBus,
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
    #[allow(dead_code)]
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

    #[cfg(test)]
    pub(crate) fn residents_for_test(&self) -> Vec<(String, bool, bool)> {
        self.background_agents
            .sessions_snapshot_for_test()
            .into_iter()
            .map(|(project, session)| (project, session.alive(), session.busy()))
            .collect()
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

    /// Evicts a resident as soon as its host reports session death. A callback
    /// from an old session cannot remove a replacement because the persistent
    /// id and unique live-handle instance are checked by the shared registry.
    fn session_closed_callback(&self) -> SessionClosedCallback {
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

    /// What routing reads about this call, readable without the PBX lock.
    pub fn routing_view(&self) -> RoutingView {
        RoutingView {
            hosts: self.hosts.clone(),
            registry: Arc::clone(&self.registry),
            router: self.router.clone(),
            coordinator: self.coordinator.clone(),
            background_agents: self.background_agents.clone(),
            agent_tasks: Arc::clone(&self.agent_tasks),
        }
    }

    pub fn call_summary(
        &self,
        transcript: &[TranscriptEntry],
        screen: Value,
        utterance: impl Into<String>,
    ) -> CallSummary {
        self.routing_view()
            .call_summary(transcript, screen, utterance)
    }

    fn set_agent_task(&self, project: &str, text: &str) {
        self.agent_tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(project.to_owned(), text.to_owned());
    }

    /// List foreign live sessions in registered project folders. The service
    /// labels a session as `taken_over` in the routing summary because that is
    /// the provenance it will record if the caller selects it.
    #[cfg(test)]
    pub async fn live_desk_sessions(&self) -> Vec<DeskSession> {
        Self::live_desk_sessions_from(self.hosts.clone(), Arc::clone(&self.registry)).await
    }

    /// Host I/O for the desk-session summary. Keep this outside the PBX lock:
    /// a slow host must not stall unrelated caller turns or lifecycle actions.
    pub(crate) async fn live_desk_sessions_from(
        hosts: Hosts,
        registry: Arc<Registry>,
    ) -> Vec<DeskSession> {
        let mut projects_by_host: HashMap<String, Vec<&Project>> = HashMap::new();
        for project in &registry.projects {
            if let Some(host) = project.canonical_host() {
                projects_by_host
                    .entry(host.to_owned())
                    .or_default()
                    .push(project);
            }
        }
        let replies = join_all(projects_by_host.into_iter().map(|(host, projects)| {
            let hosts = hosts.clone();
            async move {
                let reply = hosts
                    .command(&host, "list_sessions", json!({}), Duration::from_secs(5))
                    .await;
                (host, projects, reply)
            }
        }))
        .await;
        let mut result = Vec::new();
        let mut seen = HashSet::new();
        for (host, projects, reply) in replies {
            let reply = match reply {
                Ok(reply) => reply,
                Err(error) => {
                    tracing::debug!(%host, %error, "could not list desk sessions for routing summary");
                    continue;
                }
            };
            let Some(sessions) = reply.result["sessions"].as_array() else {
                continue;
            };
            for session in sessions {
                if !session["provenance"].is_null() {
                    continue;
                }
                let Some(cwd) = session["cwd"].as_str() else {
                    continue;
                };
                let Some(project) = projects.iter().find(|project| project.cwd == cwd) else {
                    continue;
                };
                let key = session["session"].as_str().unwrap_or_default();
                if key.is_empty() || !seen.insert((host.clone(), key.to_owned())) {
                    continue;
                }
                result.push(DeskSession {
                    project: project.id.clone(),
                    state: if session["busy"] == true || session["turn_open"] == true {
                        "busy".into()
                    } else {
                        "idle".into()
                    },
                    provenance: "taken_over".into(),
                });
            }
        }
        result.sort_by(|left, right| {
            left.project
                .cmp(&right.project)
                .then(left.state.cmp(&right.state))
        });
        result
    }

    /// The call as Jev saw it for the utterance about to be handled. The
    /// operator and the routing utility get it with their prompt.
    pub fn set_call_state(&mut self, call_state: String) {
        self.call_state = call_state;
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
    fn current_utterance(&self) -> Option<String> {
        self.trace_utterance
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Publish one hop of the current utterance's routing trace. Outside a
    /// caller decision there is no utterance, and nothing is published.
    fn trace(&self, event: impl FnOnce(String) -> crate::debug::DebugEvent) {
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

    /// Removes a resident whose host session has already closed. The map is
    /// otherwise enough to enforce one live session per project, but a closed
    /// handle would make later work prompt a dead session and reject a fresh
    /// start forever.
    async fn remove_dead_background(&mut self, project: &str) -> bool {
        let dead = self
            .background_agents
            .get(project)
            .is_some_and(|session| !session.alive());
        if !dead {
            return false;
        }
        self.background_agents.cancel_task(project).await;
        if let Some(session) = self.background_agents.remove(project) {
            self.coordinator.remove_background(&session.token());
        }
        true
    }

    /// Removes a resident for a foreground promotion only after its detached
    /// prompt has been cancelled and joined. This is the reservation boundary:
    /// mode and token cannot change while the old background task is running.
    async fn take_background(&mut self, project: &str) -> Option<ProjectSession> {
        let session = self.background_agents.remove(project)?;
        self.background_agents.cancel_task(project).await;
        self.coordinator.remove_background(&session.token());
        Some(session)
    }

    /// Shelves the former foreground leg when another project takes the line.
    /// Foreign desk sessions are released, never made resident: the service
    /// owns only sessions it created.
    async fn shelve_previous_foreground(&mut self, next_project: &str) {
        let Some(previous) = self.agent.take() else {
            return;
        };
        let previous_label = previous.label().to_owned();
        if previous_label == next_project || previous.is_taken_over() {
            previous.close();
            self.announce_agent_state(&previous_label, "finished").await;
            return;
        }
        if let Err(error) = previous.set_mode("background").await {
            // The host still treats it as foreground, so its speech and
            // displays would not follow background rules. Do not keep a
            // resident whose host and service disagree about its mode.
            tracing::warn!(project = %previous_label, %error, "could not move the previous agent to the background; closing it");
            previous.close();
            self.announce_agent_state(&previous_label, "finished").await;
            return;
        }
        if previous.busy() {
            let _ = previous.steer(BACKGROUND_NOTICE).await;
        }
        let state = if previous.busy() { "busy" } else { "idle" };
        let registered = self.register_background_session(previous_label.clone(), previous);
        self.announce_agent_state(&previous_label, if registered { state } else { "finished" })
            .await;
    }

    /// Registers a resident and rechecks the host handle after insertion. A
    /// host can report death between the token registration and map insertion;
    /// the final check closes that gap without leaving a dead token resident.
    fn register_background_session(&self, project: String, session: ProjectSession) -> bool {
        self.register_background_session_with(project, session, || {})
    }

    fn register_background_session_with(
        &self,
        project: String,
        session: ProjectSession,
        before_insert: impl FnOnce(),
    ) -> bool {
        let token = session.token();
        self.coordinator.register_background(project.clone(), token);
        before_insert();
        self.background_agents
            .insert(project.clone(), session.clone());
        let still_registered = session.alive()
            && self
                .background_agents
                .get(&project)
                .is_some_and(|current| current.same_session(&session));
        if !still_registered {
            if let Some(removed) = self.background_agents.remove(&project) {
                self.coordinator.remove_background(&removed.token());
            }
        }
        still_registered
    }

    #[cfg(test)]
    fn register_background_session_with_fake_death(
        &self,
        project: String,
        session: ProjectSession,
    ) -> bool {
        self.register_background_session_with(project, session.clone(), || session.close())
    }

    /// Prompts a background agent without waiting for its turn. `source` is
    /// what the prompt is for the debug page (`caller` or `intro`); the
    /// caller line it carries is read now, before the task leaves the
    /// decision that set it.
    fn spawn_background_prompt(
        &mut self,
        project: &str,
        session: ProjectSession,
        text: String,
        source: &'static str,
    ) {
        let (epoch, generation) = self.background_agents.begin_task(project);
        let utterance = self.current_utterance();
        let token = session.token();
        let callback = self.agent_state_callback.clone();
        let closed_callback = self.session_closed_callback();
        let project_id = project.to_owned();
        let session_id = session.session_id().to_owned();
        let instance_id = session.instance_id();
        let task = tokio::spawn(async move {
            let result = session.prompt_as(&text, source, utterance.as_deref()).await;
            if let Err(error) = result {
                tracing::warn!(%error, project = %project_id, "background agent prompt failed");
                // Prompt transport failure is terminal for this resident. Do
                // not leave a dead token reusable or publish an idle notice.
                session.close();
                closed_callback(project_id.clone(), session_id, instance_id).await;
                return;
            }
            if let Some(callback) = callback {
                if session.alive()
                    && !session.busy()
                    && epoch.load(Ordering::Acquire) == generation
                    && session.token() == token
                {
                    callback(AgentStateNotice {
                        project: project_id,
                        state: "idle".into(),
                    })
                    .await;
                }
            }
        });
        self.background_agents.set_task(project.to_owned(), task);
    }

    /// Start one split part without changing the caller's foreground route.
    async fn start_background_part(&mut self, target: &str, text: &str) -> Result<(), String> {
        let project = match self.registry.resolve_detailed(target) {
            crate::registry::ResolveResult::Exact(project) => project.clone(),
            _ => return Err(format!("unknown project {target}")),
        };
        self.set_agent_task(&project.id, text);
        if self
            .agent
            .as_ref()
            .is_some_and(|agent| agent.label() == project.id)
        {
            return Err(format!("project {} is already busy", project.id));
        }
        if self.remove_dead_background(&project.id).await {
            self.announce_agent_state(&project.id, "finished").await;
        }
        // A resident background session can be idle after its prior turn. Keep
        // its history and address it instead of treating existence as busy.
        if let Some(session) = self.background_agents.get(&project.id) {
            if session.busy() {
                return Err(format!("project {} is already busy", project.id));
            }
            self.announce_agent_state(&project.id, "busy").await;
            self.spawn_background_prompt(&project.id, session, text.to_owned(), "caller");
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
        if !self.register_background_session(project.id.clone(), session.clone()) {
            self.announce_agent_state(&project.id, "finished").await;
            return Err(format!(
                "project {} ended before background registration",
                project.id
            ));
        }
        self.announce_agent_state(&project.id, "busy").await;
        self.spawn_background_prompt(&project.id, session, intro, "intro");
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
            let appended = self.operator_prompt_suffix();
            let argv = local_argv(
                &self.pi_binary,
                self.operator_model.as_deref(),
                Some(std::path::Path::new(&self.operator_system_prompt)).filter(|p| p.exists()),
                Some(&appended),
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
            session.observe(self.debug.clone());
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
            // The registry is fixed for the life of the service, so the
            // catalog lives in the system prompt once.
            let utility_prompt = self.utility_system_prompt();
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
            session.observe(self.debug.clone());
            self.utility = Some(session);
        }
        self.utility
            .as_ref()
            .ok_or_else(|| PiSessionError("utility process was not created".into()))
    }

    /// What the service appends to the operator's system prompt: the shared
    /// voice block with the persona, then the catalog.
    fn operator_prompt_suffix(&self) -> String {
        format!(
            "{}\n\n{}",
            self.voice_block(),
            self.registry.prompt_catalog()
        )
    }

    /// The utility's system prompt: its standing rules, then the voice block
    /// and the catalog in the same order the operator gets them.
    /// Requests carry only data.
    fn utility_system_prompt(&self) -> String {
        format!(
            "{UTILITY_SYSTEM_PROMPT}\n\n{}\n\n{}",
            self.voice_block(),
            self.registry.prompt_catalog()
        )
    }

    /// A routing request is data only: Jev's first read, the call state and
    /// the caller's words. The rules and the catalog are in the utility's
    /// system prompt.
    fn utility_routing_request(&self, text: &str, decision: &Decision, retry: bool) -> String {
        let target = decision.target.as_deref().unwrap_or("(none)");
        let call_state = if self.call_state.is_empty() {
            String::new()
        } else {
            format!("[CALL STATE]\n{}\n", self.call_state)
        };
        let retry = if retry {
            "\nThis names more than one project. Split it with dispatch_parts, unless it really names only one."
        } else {
            ""
        };
        format!(
            "[ROUTING REQUEST]\nFirst read: action={}, target={}, several projects={}, unsure={}.\n{}[CALLER WORDING]\n{}{}",
            decision.action.as_str(),
            target,
            decision.multi_target,
            decision.unsure,
            call_state,
            text,
            retry,
        )
    }

    /// Ask the isolated utility process. This call never touches the
    /// conversational operator session, so an operator turn cannot block it.
    async fn utility_decision(
        &mut self,
        request: &str,
        attempt: &str,
    ) -> Result<Option<UtilityDecision>, PiSessionError> {
        self.trace(|utterance_id| crate::debug::DebugEvent::UtilityRequest {
            utterance_id,
            attempt: attempt.to_owned(),
            prompt: request.to_owned(),
        });
        let started = std::time::Instant::now();
        let decision = self.ask_utility(request).await;
        let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.trace(|utterance_id| crate::debug::DebugEvent::UtilityDecision {
            utterance_id,
            attempt: attempt.to_owned(),
            decision: match &decision {
                Ok(Some(decision)) => decision.debug_value(),
                Ok(None) => json!({"kind": "none"}),
                Err(error) => json!({"kind": "error", "error": error.to_string()}),
            },
            latency_ms,
        });
        decision
    }

    async fn ask_utility(
        &mut self,
        request: &str,
    ) -> Result<Option<UtilityDecision>, PiSessionError> {
        let session = self.ensure_utility().await?.clone();
        let turn = session.prompt(request).await?;
        if turn.failed {
            return Err(PiSessionError(if turn.error.is_empty() {
                "routing utility failed".into()
            } else {
                turn.error
            }));
        }
        Ok(utility_decision(&turn.signals))
    }

    /// Take a clone of the utility session while the PBX lock is held. The
    /// caller must prompt the clone after releasing that lock: utility work is
    /// allowed to take seconds and must not block caller turns.
    pub async fn floor_rewrite_session(&mut self) -> Result<PiSession, PiSessionError> {
        Ok(self.ensure_utility().await?.clone())
    }

    pub async fn rewrite_floor_with_session(
        session: &PiSession,
        input: &FloorRewriteInput,
    ) -> Result<Option<String>, PiSessionError> {
        let context = if input.context.trim().is_empty() {
            "(none)"
        } else {
            input.context.trim()
        };
        let prompt = format!(
            "[FLOOR REWRITE]\nWork: {project}\nKind: {reason}\nCaller quiet a while: {quiet}\nDisplay held: {held_display}\n[RECENT CONVERSATION]\n{context}\n[MESSAGE]\n{message}",
            project = input.project,
            reason = input.reason,
            quiet = if input.quiet { "yes" } else { "no" },
            held_display = if input.held_display { "yes" } else { "no" },
            message = input.message,
        );
        let turn = session.prompt(&prompt).await?;
        if turn.failed {
            return Err(PiSessionError(if turn.error.is_empty() {
                "floor rewrite utility failed".into()
            } else {
                turn.error
            }));
        }
        Ok(turn
            .signals
            .iter()
            .find(|signal| signal.name == crate::pi_client::REWRITE_TOOL)
            .and_then(|signal| {
                signal
                    .args
                    .get("text")
                    .or_else(|| signal.args.get("message"))
                    .or_else(|| signal.args.get("rewrite"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(str::to_owned)
            }))
    }

    async fn handle_operator_ctx(&mut self, context: &TransferContext) -> Reply {
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
                    "Couldn't tell which project {spoken:?} meant: {candidates_text}.{}",
                    from.map(|name| format!(" The caller was on {name}."))
                        .unwrap_or_default()
                ));
                return self.reply_transfer_error(
                    format!(
                        "Which project did you mean by {spoken}? It could be {candidates_text}."
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
                    "No project matches {spoken:?}. Registered: {known_text}.{}",
                    from.map(|name| format!(" The caller was on {name}."))
                        .unwrap_or_default()
                ));
                return self.reply_transfer_error(
                    self.unknown_project_line(spoken),
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

        // Reuse a resident before creating a candidate. This is the direct
        // transfer/dial path, which otherwise only checked the foreground
        // handle and could create a second live session for this project.
        if self.coordinator.route() != project.id {
            if self.remove_dead_background(&project.id).await {
                self.announce_agent_state(&project.id, "finished").await;
            }
            if self.background_agents.contains_key(&project.id) {
                let session = self
                    .take_background(&project.id)
                    .await
                    .expect("background session exists");
                return self.promote_background(session, context.clone()).await;
            }
        }

        // The leg the caller is on now, which every failure below hands the
        // line back to: the project leg on an agent-to-agent transfer, else
        // the operator, as in `drop_agent`.
        let live_session = self.agent_leg().or_else(|| self.operator_leg());

        let plan = match self.prewarm.launch_plan(&project).await {
            Ok(plan) => plan,
            Err(err) => {
                tracing::warn!(project = %project.id, error = %err, "the project's host is not ready");
                self.operator_note = Some(open_failed_note(&project.id, &err));
                return self.couldnt_open(&project.id, err);
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
                self.operator_note = Some(open_failed_note(&project.id, &e.to_string()));
                return self.couldnt_open(&project.id, e);
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
            return self.couldnt_open(&project.id, error.to_string());
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
                self.operator_note = Some(open_failed_note(&project.id, &e.to_string()));
                return self.couldnt_open(&project.id, e.to_string());
            }
        };

        self.set_active_session(Some(LegSession::Project(session.clone())))
            .await;

        let intro_prompt = build_intro_prompt(context, &project, plan.prepare_report.as_ref());

        self.announce_agent_state(&project.id, "busy").await;
        let utterance = self.current_utterance();
        let turn = match session
            .prompt_as(&intro_prompt, "intro", utterance.as_deref())
            .await
        {
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
            self.announce_agent_state(&project.id, "finished").await;
            self.set_active_session(live_session.clone()).await;
            self.rollback_startup(format!("intro failed: {detail}"));
            self.operator_note = Some(open_failed_note(&project.id, &detail));
            return self.couldnt_open(&project.id, detail);
        }

        // The leg may be adopted already: a candidate is promoted on its first
        // sign of life, which usually arrives during the intro turn. Either
        // way the coordinator names it from here on; the switchboard only
        // swaps the session handles.
        if self.coordinator.is_candidate() {
            if let Err(error) = self.coordinator.adopt_candidate(&leg_token) {
                session.close();
                self.announce_agent_state(&project.id, "finished").await;
                self.set_active_session(live_session.clone()).await;
                self.rollback_startup(format!("adoption failed: {error}"));
                return self.couldnt_open(&project.id, error.to_string());
            }
        }
        self.coordinator.finish_intro();

        self.shelve_previous_foreground(&project.id).await;
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
                let project = session.label().to_owned();
                session.close();
                self.announce_agent_state(&project, "finished").await;
                return self.reply_transfer_error(
                    format!("{project} isn't registered any more."),
                    Some("project is no longer registered".into()),
                );
            }
        };
        let token = uuid_like();
        if let Err(error) = session.set_mode("foreground").await {
            session.close();
            self.announce_agent_state(&project.id, "finished").await;
            return self.couldnt_bring_back(&project.id, error.to_string());
        }
        if let Err(error) = session
            .join_call_mode(&token, &self.persona, self.speech_deadline_ms, "foreground")
            .await
        {
            session.close();
            self.announce_agent_state(&project.id, "finished").await;
            return self.couldnt_bring_back(&project.id, error.to_string());
        }
        self.announce_agent_state(&project.id, "busy").await;
        let candidate = CandidateLeg::new(
            project.id.clone(),
            project.id.clone(),
            session.session_id(),
            token.clone(),
            "",
            self.coordinator.thinking_default(),
        );
        if let Err(error) = self.coordinator.begin_candidate(candidate) {
            session.close();
            self.announce_agent_state(&project.id, "finished").await;
            return self.couldnt_bring_back(&project.id, error.to_string());
        }
        // The agent was told background rules when it was shelved. Tell it
        // they no longer apply before it answers the caller.
        let prompt = format!("{FOREGROUND_NOTICE}\n\n{}", context.exact_caller_transcript);
        let utterance = self.current_utterance();
        let turn = match session
            .prompt_as(&prompt, "foreground", utterance.as_deref())
            .await
        {
            Ok(turn) => turn,
            Err(error) => Turn {
                text: String::new(),
                signals: vec![],
                failed: true,
                error: error.to_string(),
            },
        };
        if turn.failed && turn.text.is_empty() {
            session.close();
            self.announce_agent_state(&project.id, "finished").await;
            self.rollback_startup(format!("background promotion failed: {}", turn.error));
            return self.couldnt_bring_back(&project.id, turn.error);
        }
        if self.coordinator.is_candidate() {
            if let Err(error) = self.coordinator.adopt_candidate(&token) {
                session.close();
                self.announce_agent_state(&project.id, "finished").await;
                return self.couldnt_bring_back(&project.id, error.to_string());
            }
        }
        self.coordinator.finish_intro();
        self.shelve_previous_foreground(&project.id).await;
        self.announce_agent_state(&project.id, "idle").await;
        self.agent = Some(session);
        self.set_active_session(self.agent_leg()).await;
        self.announce_route().await;
        self.reply_with_turn(turn)
    }

    /// Find one untracked top-level desk session for a registered project.
    /// Service-created sessions are returned as a refusal, not silently reused
    /// by takeover: only their original lifecycle may own them.
    #[cfg(test)]
    async fn desk_session_for_takeover(&self, project: &Project) -> Result<Option<Value>, String> {
        Self::desk_session_for_takeover_from_project(self.hosts.clone(), project).await
    }

    #[cfg(test)]
    async fn desk_session_for_takeover_target(
        &self,
        target: &str,
    ) -> Result<Option<Value>, String> {
        let Some(project) = self.registry.get(target).cloned() else {
            return Err(format!("unknown project {target:?}"));
        };
        self.desk_session_for_takeover(&project).await
    }

    /// Performs the host-owned part of takeover discovery without requiring a
    /// switchboard lock. The caller must validate the returned handle and
    /// provenance again before attaching it.
    pub(crate) async fn desk_session_for_takeover_from(
        hosts: Hosts,
        registry: Arc<Registry>,
        target: &str,
    ) -> Result<Option<Value>, String> {
        let Some(project) = registry.get(target).cloned() else {
            return Err(format!("unknown project {target:?}"));
        };
        Self::desk_session_for_takeover_from_project(hosts, &project).await
    }

    async fn desk_session_for_takeover_from_project(
        hosts: Hosts,
        project: &Project,
    ) -> Result<Option<Value>, String> {
        let Some(host) = project.canonical_host() else {
            return Err(format!("{} has no project host configured", project.id));
        };
        let reply = hosts
            .command(host, "list_sessions", json!({}), Duration::from_secs(5))
            .await
            .map_err(|error| format!("could not inspect {} sessions: {error}", project.id))?;
        let sessions = reply.result["sessions"]
            .as_array()
            .ok_or_else(|| format!("host {host} returned no session list"))?;
        if sessions.iter().any(|session| {
            session["cwd"] == project.cwd
                && session["provenance"].as_str() == Some("created")
                && (session["project"].is_null()
                    || session["project"].as_str() == Some(project.id.as_str()))
        }) {
            return Err(format!(
                "{} already has a live service-created agent; stop it first",
                project.id
            ));
        }
        Ok(sessions
            .iter()
            .find(|session| session["cwd"] == project.cwd && session["provenance"].is_null())
            .cloned())
    }

    /// Route the caller onto a live desk session without creating a second
    /// agent. The takeover request is the first routed line, so `prompt`
    /// carries the normal voice brief in front of it.
    async fn take_over(
        &mut self,
        text: &str,
        target: &str,
        takeover: Result<Option<Value>, String>,
    ) -> Reply {
        let Some(project) = self.registry.get(target).cloned() else {
            return self.reply_transfer_error(
                self.unknown_project_line(target),
                Some(format!("unknown project {target:?}")),
            );
        };
        // Keep the exact foreground owner across a failed takeover. The
        // coordinator rolls its route back, but the active-session guard is a
        // separate lifecycle handoff and must follow the same previous leg.
        let previous_foreground = self.active_session.lock().await.clone();
        if self
            .agent
            .as_ref()
            .is_some_and(|agent| agent.label() == project.id)
            || self.background_agents.contains_key(&project.id)
        {
            return self.reply_transfer_error(
                format!(
                    "{} is already open on the call. Stop it before I take over the one at your desk.",
                    project.id
                ),
                Some("project already has a live switchboard agent".into()),
            );
        }
        let desk = match takeover {
            Ok(Some(session)) => session,
            Ok(None) => {
                return self.reply_transfer_error(
                    format!("Nothing is open at your desk for {}.", project.id),
                    Some("no matching desk session".into()),
                )
            }
            Err(error) => return self.couldnt_take_over(&project.id, error),
        };
        // This is the lock-held recheck after the host listing. A stale
        // discovery result must never be attached to another project or a
        // session the host has already registered for the service.
        if desk["cwd"].as_str() != Some(project.cwd.as_str()) || !desk["provenance"].is_null() {
            return self.reply_transfer_error(
                format!(
                    "What's open at your desk for {} changed before I could take it over. Try again.",
                    project.id
                ),
                Some("desk session changed during takeover".into()),
            );
        }
        let Some(session_handle) = desk["session"].as_str() else {
            return self.couldnt_take_over(&project.id, "desk session had no handle");
        };
        let model = desk["model"].as_str().unwrap_or_default().to_owned();
        let thinking = desk["thinking"].as_str().unwrap_or_default().to_owned();
        let spec = if model.is_empty() {
            String::new()
        } else if thinking.is_empty() {
            model.clone()
        } else {
            format!("{model}:{thinking}")
        };
        let leg_token = uuid_like();
        let candidate = CandidateLeg::new(
            project.id.clone(),
            project.id.clone(),
            desk["session_id"].as_str().unwrap_or_default(),
            leg_token.clone(),
            spec.clone(),
            if thinking.is_empty() {
                self.coordinator.thinking_default()
            } else {
                thinking.clone()
            },
        );
        if let Err(error) = self.coordinator.begin_candidate(candidate) {
            return self.couldnt_take_over(&project.id, error.to_string());
        }
        let host = match project.canonical_host() {
            Some(host) => host.to_owned(),
            None => unreachable!("desk_session_for_takeover checked project host"),
        };
        let launch = ProjectLaunch {
            host,
            project: project.id.clone(),
            cwd: project.cwd.clone(),
            spec,
            brief: self.agent_brief(&project),
            turn_timeout: self.project_turn_timeout,
            on_activity: self.activity_callback.clone(),
            on_module: self.module_callback.clone(),
            on_turn: self.turn_callback.clone(),
            on_closed: Some(self.session_closed_callback()),
            debug: Some(self.debug.clone()),
        };
        let session = match ProjectSession::attach(&self.hosts, launch, session_handle).await {
            Ok((session, state)) => {
                self.confirm_thinking(&leg_token, &state);
                session
            }
            Err(error) => {
                self.rollback_startup(format!("takeover failed: {error}"));
                return self.couldnt_take_over(&project.id, error.to_string());
            }
        };
        if let Err(error) = session
            .join_call_mode(
                &leg_token,
                &self.persona,
                self.speech_deadline_ms,
                "foreground",
            )
            .await
        {
            session.close();
            self.rollback_startup(format!("takeover call registration failed: {error}"));
            return self.couldnt_take_over(&project.id, error.to_string());
        }
        self.set_active_session(Some(LegSession::Project(session.clone())))
            .await;
        self.announce_agent_state(&project.id, "busy").await;
        let utterance = self.current_utterance();
        let turn = match session
            .prompt_as(text, "caller", utterance.as_deref())
            .await
        {
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
                "the desk session did not answer".to_owned()
            } else {
                turn.error.clone()
            };
            session.close();
            self.announce_agent_state(&project.id, "finished").await;
            self.rollback_startup(format!("takeover turn failed: {detail}"));
            self.set_active_session(previous_foreground.clone()).await;
            return self.couldnt_take_over(&project.id, detail);
        }
        if self.coordinator.is_candidate() {
            if let Err(error) = self.coordinator.adopt_candidate(&leg_token) {
                session.close();
                self.announce_agent_state(&project.id, "finished").await;
                self.rollback_startup(format!("takeover adoption failed: {error}"));
                self.set_active_session(previous_foreground).await;
                return self.couldnt_take_over(&project.id, error.to_string());
            }
        }
        self.coordinator.finish_intro();
        self.shelve_previous_foreground(&project.id).await;
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
            on_turn: self.turn_callback.clone(),
            on_closed: Some(self.session_closed_callback()),
            debug: Some(self.debug.clone()),
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

    /// The shared voice block with the persona after it. An empty persona
    /// leaves the character part out.
    fn voice_block(&self) -> String {
        voice_block(&self.persona)
    }

    /// The voice brief: the shared voice block with the persona, how to
    /// reach the caller through the `switchboard` module, and how to run the
    /// work and its context.
    fn agent_brief(&self, project: &Project) -> String {
        let mut brief = AGENT_BRIEF_HEADER.replace("{project}", &project.id);
        brief.push('\n');
        brief.push_str(&self.voice_block());
        brief.push_str("\n\n");
        brief.push_str(AGENT_BRIEF_BODY);
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
            return self.reply_failure(
                format!("I couldn't change the model on {}.", project.id),
                error.to_string(),
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
                    "Couldn't move {} to {spec}: {}.",
                    project.id,
                    error.to_string().trim_end_matches('.')
                ));
                return self.couldnt_bring_up_on(&project.id, &spoken, error.to_string());
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
                "[switchboard] This session now runs on {spec}.{} The caller made the change, so do not announce it. Their request: {}.",
                if keep_context {
                    ""
                } else {
                    " The earlier conversation was cleared on purpose."
                },
                intent.trim().trim_end_matches('.')
            );
            let turn = match session.prompt_as(&prompt, "model_change", None).await {
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
                    "Couldn't move {} to {spec}: {}.",
                    project.id,
                    detail.trim_end_matches('.')
                ));
                return self.couldnt_bring_up_on(&project.id, &spoken, detail);
            }
            Some(turn)
        };

        if self.coordinator.is_candidate() {
            if let Err(error) = self.coordinator.adopt_candidate(&leg_token) {
                session.close();
                self.announce_agent_state(&project.id, "finished").await;
                self.rollback_startup(format!("adoption failed: {error}"));
                self.drop_agent().await;
                return self.couldnt_bring_up_on(&project.id, &spoken, error.to_string());
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
            self.reply(["That work stopped."], reply.error)
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
        let failed = turn.failed;
        let error = turn.error;
        let status = self.coordinator.status();
        let mut reply = Reply::new(
            &status.route,
            &status.label,
            vec![Utterance {
                text: turn.text,
                synthesize: false,
            }],
            failed.then_some(error),
        );
        reply.delivery_generation = Some(self.coordinator.generation());
        reply
    }
    /// A failure said aloud in plain words. The raw `detail` goes only to
    /// the screen text and the reply's error; it is never spoken.
    fn reply_failure(&self, spoken: String, detail: impl Into<String>) -> Reply {
        failure_reply(&self.coordinator, spoken, detail.into())
    }

    /// Every way opening a project for the caller can fail says the same.
    fn couldnt_open(&self, project: &str, detail: impl Into<String>) -> Reply {
        self.reply_failure(format!("I couldn't open {project}."), detail)
    }

    /// Bringing work back from the background failed.
    fn couldnt_bring_back(&self, project: &str, detail: impl Into<String>) -> Reply {
        self.reply_failure(format!("I couldn't pick {project} back up."), detail)
    }

    /// A model change could not bring the project back up on the new model.
    fn couldnt_bring_up_on(&self, project: &str, spoken: &str, detail: impl Into<String>) -> Reply {
        self.reply_failure(
            format!("I couldn't bring {project} back up on {spoken}."),
            detail,
        )
    }

    /// Taking over a session open at the caller's desk failed.
    fn couldnt_take_over(&self, project: &str, detail: impl Into<String>) -> Reply {
        self.reply_failure(format!("I couldn't take over {project}."), detail)
    }

    /// The caller named a project the registry does not have.
    fn unknown_project_line(&self, spoken: &str) -> String {
        let known = self.registry.ids();
        if known.is_empty() {
            format!("I don't have a project called {spoken}, and none are set up yet.")
        } else {
            format!(
                "I don't have a project called {spoken}. The ones I have are {}.",
                known.join(", ")
            )
        }
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
            return self.reply(["Back at the front desk."], None);
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
            return self.reply([format!("Stopped {target}.")], None);
        }
        if self.background_agents.contains_key(target) {
            self.resume_blocked.insert(target.to_owned());
            self.background_agents.cancel_task(target).await;
            let session = self
                .background_agents
                .remove(target)
                .expect("background session exists");
            self.coordinator.remove_background(&session.token());
            session.close();
            self.announce_agent_state(target, "finished").await;
            return self.reply([format!("Stopped {target}.")], None);
        }
        self.reply([format!("{target} isn't running.")], None)
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
        self.operator_note = Some(format!("The caller hung up {left} from the page."));
        Some(left)
    }
}

fn is_confirmation(text: &str) -> bool {
    matches!(
        text.trim().to_ascii_lowercase().as_str(),
        "yes" | "yeah" | "yep" | "confirm" | "do it" | "stop it"
    )
}

/// A failure the switchboard says itself: `spoken` is read aloud, and the
/// raw `detail` is screen text and the reply's error, never speech.
fn failure_reply(coordinator: &Coordinator, spoken: String, detail: String) -> Reply {
    let status = coordinator.status();
    Reply::new(
        &status.route,
        &status.label,
        vec![
            Utterance {
                text: spoken,
                synthesize: true,
            },
            Utterance {
                text: detail.clone(),
                synthesize: false,
            },
        ],
        Some(detail),
    )
}

/// The operator's note when work on `name` stopped under the caller.
fn stopped_note(name: &str, detail: &str) -> String {
    format!("Work on {name} stopped: {}.", detail.trim_end_matches('.'))
}

/// The operator's note when `project` could not be opened for the caller.
fn open_failed_note(project: &str, error: &str) -> String {
    format!("Couldn't open {project}: {}.", error.trim_end_matches('.'))
}

/// `CALL_VOICE` joined with the persona, or alone when there is none.
fn voice_block(persona: &str) -> String {
    let persona = persona.trim();
    if persona.is_empty() {
        CALL_VOICE.to_owned()
    } else {
        format!("{CALL_VOICE}\n\nCharacter:\n{persona}")
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

#[cfg(test)]
#[path = "../tests/test_pbx.rs"]
mod tests;

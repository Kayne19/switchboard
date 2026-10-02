//! Jev-backed call routing policy and the compact call summary.

use crate::history::{TranscriptEntry, CALLER};
use crate::jev::{JevAnswer, JevClient, JevError, JevRequest, JevResponse, Question};
use crate::lifecycle::Coordinator;
use crate::pi_client::Signal;
use crate::protocol::Status;
use crate::registry::Registry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

pub const MAX_STATE_TOKENS: usize = 32_000;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AgentSummary {
    pub state: String,
    pub model: String,
    pub thinking: String,
    pub task: String,
    pub pending_request_to_speak: bool,
    /// The agent holds a display the caller has not seen yet. It appears when
    /// the caller brings that agent forward.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub display_ready: bool,
}

/// A background agent's queued spoken update, judged by the floor gate. It is
/// its own field so `caller_just_said` always means the caller's words.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct QueuedUpdate {
    pub from_agent: String,
    pub message: String,
}

/// What the presentation side knows about one agent on the call.
#[derive(Clone, Debug, PartialEq)]
pub struct LiveAgent {
    pub project: String,
    /// `busy`, `idle`, `waiting`, or `finished`.
    pub state: String,
    pub pending_request: bool,
    pub display_ready: bool,
}

/// Longest task text kept per agent in the routing summary.
const MAX_TASK_CHARS: usize = 400;

fn task_text(tasks: &HashMap<String, String>, project: &str) -> String {
    tasks
        .get(project)
        .map(|task| task.chars().take(MAX_TASK_CHARS).collect())
        .unwrap_or_default()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DeskSession {
    pub project: String,
    pub state: String,
    pub provenance: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ConversationTurn {
    pub speaker: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RegisteredProject {
    pub id: String,
    pub description: String,
    pub aliases: Vec<String>,
}

/// The named state sent to Jev. Keeping each field explicit avoids the
/// accuracy loss from burying the utterance in an unstructured summary.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CallSummary {
    pub caller_is_talking_to: String,
    pub agents: BTreeMap<String, AgentSummary>,
    pub live_desk_sessions: Vec<DeskSession>,
    pub recent_conversation: Vec<ConversationTurn>,
    pub screen: Value,
    pub caller_just_said: String,
    pub registered_projects: Vec<RegisteredProject>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_update: Option<QueuedUpdate>,
}

impl CallSummary {
    pub fn new(
        caller_is_talking_to: impl Into<String>,
        agents: BTreeMap<String, AgentSummary>,
        live_desk_sessions: Vec<DeskSession>,
        recent_conversation: Vec<ConversationTurn>,
        screen: Value,
        caller_just_said: impl Into<String>,
        registered_projects: Vec<RegisteredProject>,
    ) -> Self {
        Self {
            caller_is_talking_to: caller_is_talking_to.into(),
            agents,
            live_desk_sessions,
            recent_conversation,
            screen,
            caller_just_said: caller_just_said.into(),
            registered_projects,
            queued_update: None,
        }
    }

    /// Build the production summary from the state currently owned by the
    /// coordinator. The background/takeover slices can add desk sessions and
    /// agent task provenance without changing the Jev wire contract.
    pub fn from_runtime(
        status: &Status,
        registry: &Registry,
        transcript: &[TranscriptEntry],
        screen: Value,
        utterance: impl Into<String>,
        background: &[String],
        tasks: &HashMap<String, String>,
    ) -> Self {
        let mut agents = BTreeMap::new();
        let active_route = status.route.clone();
        agents.insert(
            "operator".into(),
            AgentSummary {
                state: if active_route == "operator" {
                    "busy"
                } else {
                    "idle"
                }
                .into(),
                model: if active_route == "operator" {
                    status.model.clone()
                } else {
                    String::new()
                },
                thinking: if active_route == "operator" {
                    status.thinking.clone()
                } else {
                    String::new()
                },
                task: String::new(),
                pending_request_to_speak: false,
                display_ready: false,
            },
        );
        if active_route != "operator" {
            agents.insert(
                active_route.clone(),
                AgentSummary {
                    state: "busy".into(),
                    model: status.model.clone(),
                    thinking: status.thinking.clone(),
                    task: task_text(tasks, &active_route),
                    pending_request_to_speak: false,
                    display_ready: false,
                },
            );
        }
        // Background agents are on the call too. Their live state (busy,
        // idle, waiting) is owned by the presentation side and merged by
        // `merge_live_agents`; list every known one here so a resident is
        // never invisible to routing.
        for project in background
            .iter()
            .filter(|project| **project != active_route)
        {
            agents
                .entry(project.clone())
                .or_insert_with(|| AgentSummary {
                    state: "busy".into(),
                    model: String::new(),
                    thinking: String::new(),
                    task: task_text(tasks, project),
                    pending_request_to_speak: false,
                    display_ready: false,
                });
        }
        let recent_conversation = transcript
            .iter()
            .map(|entry| ConversationTurn {
                speaker: if entry.role == CALLER {
                    "caller".into()
                } else if entry.route == "operator" {
                    "operator".into()
                } else {
                    entry.route.clone()
                },
                text: entry.text.clone(),
            })
            .collect();
        Self::new(
            if active_route == "operator" {
                "the operator (no project agent)".into()
            } else {
                active_route
            },
            agents,
            Vec::new(),
            recent_conversation,
            screen,
            utterance,
            registry
                .projects
                .iter()
                .map(|project| RegisteredProject {
                    id: project.id.clone(),
                    description: project.description.clone(),
                    aliases: project.aliases.clone(),
                })
                .collect(),
        )
    }

    /// Merge the presentation side's live agent states: busy, idle, waiting
    /// to speak, and held displays. Finished agents are not on the call.
    pub fn merge_live_agents(&mut self, live: &[LiveAgent]) {
        for agent in live {
            if agent.state == "finished" {
                if agent.project != self.caller_is_talking_to {
                    self.agents.remove(&agent.project);
                }
                continue;
            }
            let entry = self
                .agents
                .entry(agent.project.clone())
                .or_insert_with(|| AgentSummary {
                    state: String::new(),
                    model: String::new(),
                    thinking: String::new(),
                    task: String::new(),
                    pending_request_to_speak: false,
                    display_ready: false,
                });
            entry.state = agent.state.clone();
            entry.pending_request_to_speak = agent.pending_request;
            entry.display_ready = agent.display_ready;
        }
    }

    /// The one agent with something for the caller: a queued request to
    /// speak or a display the caller has not seen. `None` when there is no
    /// such agent or more than one.
    pub fn single_waiting_agent(&self) -> Option<String> {
        let mut waiting = self.agents.iter().filter(|(name, agent)| {
            name.as_str() != "operator" && (agent.pending_request_to_speak || agent.display_ready)
        });
        let first = waiting.next()?;
        waiting.next().is_none().then(|| first.0.clone())
    }

    /// A short plain-text view of the call for the operator and the routing
    /// utility, so their decisions use the same facts Jev saw.
    pub fn render_for_llm(&self) -> String {
        // The words describe work, not parties, so the reader can talk about
        // it in the first person without repeating "operator" or "agent".
        let on = if self.caller_is_talking_to == "operator" {
            "the front desk"
        } else {
            self.caller_is_talking_to.as_str()
        };
        let mut lines = vec![format!("The caller is on: {on}.")];
        let agents = self
            .agents
            .iter()
            .filter(|(name, _)| name.as_str() != "operator")
            .collect::<Vec<_>>();
        if agents.is_empty() {
            lines.push("No project work is open.".into());
        } else {
            lines.push("Open work:".into());
            for (name, agent) in agents {
                let mut facts = vec![agent.state.clone()];
                if name.as_str() == self.caller_is_talking_to {
                    facts.push("in front".into());
                } else {
                    facts.push("in the background".into());
                }
                if agent.pending_request_to_speak {
                    facts.push("has something to say".into());
                }
                if agent.display_ready {
                    facts.push("has a display the caller has not seen".into());
                }
                let task = if agent.task.is_empty() {
                    String::new()
                } else {
                    format!("; last asked: {:?}", agent.task)
                };
                lines.push(format!("- {name}: {}{task}", facts.join(", ")));
            }
        }
        if !self.live_desk_sessions.is_empty() {
            let desk = self
                .live_desk_sessions
                .iter()
                .map(|session| format!("{} ({})", session.project, session.state))
                .collect::<Vec<_>>()
                .join(", ");
            lines.push(format!("Desk sessions the caller can take over: {desk}."));
        }
        let recent = self
            .recent_conversation
            .iter()
            .rev()
            .take(6)
            .rev()
            .map(|turn| format!("{}: {}", turn.speaker, turn.text))
            .collect::<Vec<_>>();
        if !recent.is_empty() {
            lines.push("Recent conversation:".into());
            lines.extend(recent);
        }
        lines.join("\n")
    }

    /// Return the state after enforcing the summary budget. Turns are removed
    /// oldest first; all named non-conversation fields remain present.
    pub fn state_with_budget(&self, token_budget: usize) -> Value {
        let budget = token_budget.clamp(1, MAX_STATE_TOKENS);
        let mut value = serde_json::to_value(self).expect("call summary is serializable");
        while estimate_tokens(&value) > budget {
            let has_turns = value
                .get("recent_conversation")
                .and_then(Value::as_array)
                .is_some_and(|turns| !turns.is_empty());
            if !has_turns {
                break;
            }
            value["recent_conversation"]
                .as_array_mut()
                .expect("conversation array")
                .remove(0);
        }
        value
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Continue,
    GoToProject,
    AnswerWaiting,
    Stop,
    SetModel,
    SetThinking,
    Status,
    General,
    Unclear,
    TakeOver,
}

impl Action {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Continue => "continue",
            Self::GoToProject => "go_to_project",
            Self::AnswerWaiting => "answer_waiting",
            Self::Stop => "stop",
            Self::SetModel => "set_model",
            Self::SetThinking => "set_thinking",
            Self::Status => "status",
            Self::General => "general",
            Self::Unclear => "unclear",
            Self::TakeOver => "take_over",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "continue" => Self::Continue,
            "go_to_project" => Self::GoToProject,
            "answer_waiting" => Self::AnswerWaiting,
            "stop" => Self::Stop,
            "set_model" => Self::SetModel,
            "set_thinking" => Self::SetThinking,
            "status" => Self::Status,
            "general" => Self::General,
            "unclear" => Self::Unclear,
            "take_over" => Self::TakeOver,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConversationMode {
    Continue,
    Fresh,
}

impl ConversationMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Continue => "continue",
            Self::Fresh => "fresh",
        }
    }
}

/// A part returned by the stateless routing utility. The background-agent
/// slice may fan these out; this slice keeps the foreground choice explicit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DispatchPart {
    pub agent: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum UtilityDecision {
    SecondOpinion {
        target: Option<String>,
        mode: ConversationMode,
        confident: bool,
    },
    DispatchParts(Vec<DispatchPart>),
}

/// Interpret only the utility process's signal calls. A missing or malformed
/// call is deliberately treated as no opinion, never as permission to guess.
pub fn utility_decision(signals: &[Signal]) -> Option<UtilityDecision> {
    if let Some(signal) = signals
        .iter()
        .find(|signal| signal.name == crate::pi_client::ROUTE_TOOL)
    {
        // A utility that raises `route` has loaded the conversational tool set.
        // Preserve its useful target rather than letting the whole utterance
        // fall through to the current agent.
        tracing::warn!("routing utility raised route; treating it as a second opinion");
        let target = signal
            .args
            .get("target")
            .or_else(|| signal.args.get("project"))
            .or_else(|| signal.args.get("agent"))
            .and_then(Value::as_str)
            .filter(|target| !target.trim().is_empty())
            .map(str::to_owned);
        let mode = match signal.args.get("mode").and_then(Value::as_str) {
            // A missing mode never replaces a live agent: continue is the
            // safe reading, and fresh must be asked for.
            Some("continue") | None => ConversationMode::Continue,
            Some("fresh") => ConversationMode::Fresh,
            Some(_) => return None,
        };
        let confident = signal
            .args
            .get("confident")
            .and_then(Value::as_bool)
            .or_else(|| {
                signal
                    .args
                    .get("confidence")
                    .and_then(Value::as_f64)
                    .map(|value| value >= 0.5)
            })
            // `route` has no confidence flag; naming one target is its claim.
            .unwrap_or(target.is_some());
        return Some(UtilityDecision::SecondOpinion {
            target,
            mode,
            confident,
        });
    }
    if let Some(signal) = signals
        .iter()
        .find(|signal| signal.name == SECOND_OPINION_TOOL)
    {
        let target = signal
            .args
            .get("target")
            .or_else(|| signal.args.get("project"))
            .or_else(|| signal.args.get("agent"))
            .and_then(Value::as_str)
            .filter(|target| !target.trim().is_empty())
            .map(str::to_owned);
        let mode = match signal.args.get("mode").and_then(Value::as_str) {
            // A missing mode never replaces a live agent: continue is the
            // safe reading, and fresh must be asked for.
            Some("continue") | None => ConversationMode::Continue,
            Some("fresh") => ConversationMode::Fresh,
            Some(_) => return None,
        };
        let confident = signal
            .args
            .get("confident")
            .and_then(Value::as_bool)
            .or_else(|| {
                signal
                    .args
                    .get("confidence")
                    .and_then(Value::as_f64)
                    .map(|value| value >= 0.5)
            })
            // An omitted flag is not a claim of confidence.
            .unwrap_or(false);
        return Some(UtilityDecision::SecondOpinion {
            target,
            mode,
            confident,
        });
    }
    let signal = signals
        .iter()
        .find(|signal| signal.name == DISPATCH_PARTS_TOOL)?;
    let parts = signal.args.get("parts")?.as_array()?;
    let mut parsed = Vec::with_capacity(parts.len());
    for part in parts {
        let object = part.as_object()?;
        let agent = object
            .get("agent")
            .or_else(|| object.get("project"))
            .or_else(|| object.get("target"))
            .and_then(Value::as_str)
            .filter(|agent| !agent.trim().is_empty())?;
        let text = object
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())?;
        parsed.push(DispatchPart {
            agent: agent.to_owned(),
            text: text.to_owned(),
        });
    }
    (!parsed.is_empty()).then_some(UtilityDecision::DispatchParts(parsed))
}

impl UtilityDecision {
    /// The decision as the debug page shows it: `kind` and its fields.
    pub fn debug_value(&self) -> Value {
        match self {
            Self::SecondOpinion {
                target,
                mode,
                confident,
            } => serde_json::json!({
                "kind": "second_opinion",
                "target": target,
                "mode": mode,
                "confident": confident,
            }),
            Self::DispatchParts(parts) => serde_json::json!({
                "kind": "dispatch_parts",
                "parts": parts
                    .iter()
                    .map(|part| serde_json::json!({"project": part.agent, "text": part.text}))
                    .collect::<Vec<_>>(),
            }),
        }
    }
}

const SECOND_OPINION_TOOL: &str = "second_opinion";
const DISPATCH_PARTS_TOOL: &str = "dispatch_parts";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Decision {
    pub action: Action,
    pub target: Option<String>,
    pub continue_or_fresh: Option<ConversationMode>,
    pub confidence: f64,
    pub for_current_agent: f64,
    pub multi_target: bool,
    pub unsure: bool,
    pub confirm: bool,
    pub reason: String,
}

impl Decision {
    pub fn fallback(reason: impl Into<String>) -> Self {
        Self {
            action: Action::General,
            target: None,
            continue_or_fresh: None,
            confidence: 0.0,
            for_current_agent: 0.0,
            multi_target: false,
            unsure: true,
            confirm: false,
            reason: reason.into(),
        }
    }

    pub fn sends_to_operator(&self) -> bool {
        self.unsure
            || self.multi_target
            || matches!(
                self.action,
                Action::AnswerWaiting
                    | Action::Stop
                    | Action::SetModel
                    | Action::SetThinking
                    | Action::Status
                    | Action::General
                    | Action::Unclear
                    | Action::TakeOver
            )
    }
}

/// The threshold rule that chose a routing decision. Reported to the debug
/// page only; the decision itself is what routing acts on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteRule {
    /// Stop always goes to the caller for confirmation.
    StopConfirms,
    /// On a project, `for_current_agent` reached the upper threshold.
    StayedWithCurrent,
    /// On a project, `for_current_agent` fell between the two thresholds.
    CurrentAgentUnsure,
    /// Jev's action confidence was below the action threshold.
    ActionBelowThreshold,
    /// Jev's action confidence met the action threshold.
    JevAction,
    /// Jev did not answer usably; the operator path decides.
    JevUnavailable,
}

impl RouteRule {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StopConfirms => "stop_confirms",
            Self::StayedWithCurrent => "stayed_with_current",
            Self::CurrentAgentUnsure => "current_agent_unsure",
            Self::ActionBelowThreshold => "action_below_threshold",
            Self::JevAction => "jev_action",
            Self::JevUnavailable => "jev_unavailable",
        }
    }
}

/// One routing call to Jev: its raw answers (when it answered), how long it
/// took, and the mapped decision with the rule that fired.
#[derive(Clone, Debug)]
pub struct RouteTrace {
    pub latency_ms: u64,
    pub response: Option<JevResponse>,
    pub result: Result<(Decision, RouteRule), JevError>,
}

/// One good-moment call to Jev, kept the same way as `RouteTrace`.
#[derive(Clone, Debug)]
pub struct GateTrace {
    pub latency_ms: u64,
    pub response: Option<JevResponse>,
    pub result: Result<bool, JevError>,
}

/// How a Jev call ended, in the debug page's words.
pub fn jev_outcome(response: Option<&JevResponse>, error: Option<&JevError>) -> &'static str {
    match (response, error) {
        (_, None) => "ok",
        (Some(_), Some(_)) => "invalid",
        (None, Some(error)) if error.is_timeout() => "timeout",
        (None, Some(_)) => "error",
    }
}

#[derive(Clone)]
pub struct Router {
    client: JevClient,
    registry: Arc<Registry>,
    coordinator: Coordinator,
    summary_token_budget: usize,
    for_current_agent_lower: f64,
    for_current_agent_upper: f64,
    action_threshold: f64,
}

impl Router {
    pub fn new(
        client: JevClient,
        registry: Arc<Registry>,
        coordinator: Coordinator,
        summary_token_budget: usize,
        for_current_agent_lower: f64,
        for_current_agent_upper: f64,
        action_threshold: f64,
    ) -> Self {
        Self {
            client,
            registry,
            coordinator,
            summary_token_budget,
            for_current_agent_lower,
            for_current_agent_upper,
            action_threshold,
        }
    }

    pub fn build_request(&self, summary: &CallSummary) -> JevRequest {
        let questions = build_router_questions(&self.registry);
        // Leave room for Jev's longest question so state + question remains
        // below its 32,000-token per-question limit.
        let longest_question = questions
            .values()
            .map(|question| {
                estimate_tokens(&serde_json::to_value(question).expect("question serializes"))
            })
            .max()
            .unwrap_or_default();
        let budget = self
            .summary_token_budget
            .min(MAX_STATE_TOKENS.saturating_sub(longest_question).max(1));
        JevRequest {
            model: self.client.model().to_owned(),
            state: summary.state_with_budget(budget),
            questions,
        }
    }

    /// Ask Jev once for `summary` and map its answers. Test helper: the
    /// service uses `route_request`, which keeps Jev's raw answers.
    #[cfg(test)]
    pub async fn route(&self, summary: &CallSummary) -> Result<Decision, JevError> {
        self.route_request(self.build_request(summary))
            .await
            .result
            .map(|(decision, _)| decision)
    }

    /// Ask Jev once with a request built by `build_request`. The trace keeps
    /// Jev's raw answers, the time it took and the threshold rule that fired,
    /// for the debug page only; routing reads only the decision.
    pub async fn route_request(&self, request: JevRequest) -> RouteTrace {
        let (latency_ms, response) = self.ask(request).await;
        let result = response
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|response| self.map_response_with_rule(response));
        if let Ok((decision, rule)) = &result {
            tracing::info!(
                action = decision.action.as_str(),
                target = decision.target.as_deref().unwrap_or(""),
                confidence = decision.confidence,
                for_current_agent = decision.for_current_agent,
                multi_target = decision.multi_target,
                unsure = decision.unsure,
                rule = rule.as_str(),
                latency_ms,
                reason = %decision.reason,
                "Jev routing decision"
            );
        }
        RouteTrace {
            latency_ms,
            response: response.ok(),
            result,
        }
    }

    /// The one Jev round trip, timed.
    async fn ask(&self, request: JevRequest) -> (u64, Result<JevResponse, JevError>) {
        let started = std::time::Instant::now();
        let response = self.client.decide(request.state, request.questions).await;
        let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        (latency_ms, response)
    }

    /// The one-question request asking whether the caller is in a good moment
    /// for one queued floor message. It is separate from routing so a routing
    /// answer cannot accidentally release speech.
    pub fn good_moment_request(&self, summary: &CallSummary) -> JevRequest {
        let mut questions = BTreeMap::new();
        questions.insert(
            "good_moment".into(),
            Question::new(
                "choice",
                "Is this a good moment to briefly announce the queued_update from a background agent to the caller?",
                [
                    ("yes", "The caller is quiet or the update should be heard now."),
                    ("no", "The caller is speaking, listening to another response, or should not be interrupted now."),
                ],
            ),
        );
        let longest_question = questions
            .values()
            .map(|question| {
                estimate_tokens(&serde_json::to_value(question).expect("question serializes"))
            })
            .max()
            .unwrap_or_default();
        let budget = self
            .summary_token_budget
            .min(MAX_STATE_TOKENS.saturating_sub(longest_question).max(1));
        JevRequest {
            model: self.client.model().to_owned(),
            state: summary.state_with_budget(budget),
            questions,
        }
    }

    /// Ask Jev the good-moment question built by `good_moment_request`.
    pub async fn good_moment(&self, request: JevRequest) -> GateTrace {
        let (latency_ms, response) = self.ask(request).await;
        let result = response
            .as_ref()
            .map_err(Clone::clone)
            .and_then(good_moment_answer);
        GateTrace {
            latency_ms,
            response: response.ok(),
            result,
        }
    }

    #[cfg(test)]
    fn map_response(&self, response: JevResponse) -> Result<Decision, JevError> {
        self.map_response_with_rule(&response)
            .map(|(decision, _)| decision)
    }

    /// Apply the confidence policy to Jev's answers. Returns the decision and
    /// the threshold rule that chose it.
    fn map_response_with_rule(
        &self,
        response: &JevResponse,
    ) -> Result<(Decision, RouteRule), JevError> {
        let action_answer = required_answer(response, "action")?;
        let current = required_answer(response, "for_current_agent")?;
        let target = required_answer(response, "target")?;
        let fresh = required_answer(response, "continue_or_fresh")?;
        let multi = required_answer(response, "multi_target")?;
        let action_name = action_answer
            .choice
            .as_deref()
            .ok_or_else(|| missing("action.choice"))?;
        let action = Action::parse(action_name)
            .ok_or_else(|| JevError::InvalidAnswer(format!("unknown action {action_name:?}")))?;
        let confidence = finite_unit(action_answer.confidence, "action.confidence")?;
        if action_answer.probabilities.is_none() {
            return Err(JevError::InvalidAnswer(
                "action.probabilities is missing".into(),
            ));
        }
        finite_unit(target.confidence, "target.confidence")?;
        if target.probabilities.is_none() {
            return Err(JevError::InvalidAnswer(
                "target.probabilities is missing".into(),
            ));
        }
        finite_unit(fresh.confidence, "continue_or_fresh.confidence")?;
        if fresh.probabilities.is_none() {
            return Err(JevError::InvalidAnswer(
                "continue_or_fresh.probabilities is missing".into(),
            ));
        }
        let for_current_agent = finite_unit(current.noul, "for_current_agent.noul")?;
        let multi_target = finite_unit(multi.noul, "multi_target.noul")? >= 0.5;
        let current_route = self.coordinator.route();
        let on_project = current_route != "operator";
        let mut chosen = action;
        let target_name = target.choice.clone().filter(|name| name != "none");
        let known_targets: HashSet<&str> = self
            .registry
            .projects
            .iter()
            .map(|project| project.id.as_str())
            .collect();
        if let Some(target_name) = target_name.as_deref() {
            if !known_targets.contains(target_name) {
                return Err(JevError::InvalidAnswer(format!(
                    "target {target_name:?} is not registered"
                )));
            }
        }
        let mut notes = Vec::new();
        if matches!(chosen, Action::GoToProject)
            && target_name.as_deref() == Some(current_route.as_str())
        {
            chosen = Action::Continue;
            notes.push(format!(
                "go_to_project named {current_route}, the agent already on the line, so it is continue"
            ));
        }
        let fresh_choice = fresh.choice.as_deref().unwrap_or("not_applicable");
        let continue_or_fresh = match fresh_choice {
            "continue" => Some(ConversationMode::Continue),
            "fresh" => Some(ConversationMode::Fresh),
            "not_applicable" => None,
            _ => {
                return Err(JevError::InvalidAnswer(format!(
                    "unknown continue_or_fresh choice {fresh_choice:?}"
                )))
            }
        };
        // This is the exact ask-when-unsure policy measured by the spike,
        // except that stopping a project always goes to the operator for
        // caller confirmation.
        let stop_always_confirms = matches!(chosen, Action::Stop);
        let jev_action = chosen.as_str();
        let lower = self.for_current_agent_lower;
        let upper = self.for_current_agent_upper;
        let threshold = self.action_threshold;
        let (rule, unsure) = if stop_always_confirms {
            (RouteRule::StopConfirms, false)
        } else if on_project && for_current_agent >= upper {
            chosen = Action::Continue;
            (RouteRule::StayedWithCurrent, false)
        } else if on_project && for_current_agent > lower {
            (RouteRule::CurrentAgentUnsure, true)
        } else if confidence < threshold {
            (RouteRule::ActionBelowThreshold, true)
        } else {
            (RouteRule::JevAction, false)
        };
        let mut reason = match rule {
            RouteRule::StopConfirms => format!(
                "stop always requires caller confirmation (action_conf={confidence:.3})"
            ),
            RouteRule::StayedWithCurrent => format!(
                "stayed with {current_route}: for_current_agent={for_current_agent:.3} >= upper {upper:.3} (Jev said action={jev_action}, action_conf={confidence:.3})"
            ),
            RouteRule::CurrentAgentUnsure => format!(
                "confidence policy requested top-level LLM: on {current_route}, for_current_agent={for_current_agent:.3} is between lower {lower:.3} and upper {upper:.3} (action={jev_action}, action_conf={confidence:.3})"
            ),
            RouteRule::ActionBelowThreshold => format!(
                "confidence policy requested top-level LLM: action_conf={confidence:.3} < threshold {threshold:.3} (action={jev_action}, for_current_agent={for_current_agent:.3})"
            ),
            RouteRule::JevAction | RouteRule::JevUnavailable => format!(
                "Jev action {jev_action}: action_conf={confidence:.3} >= threshold {threshold:.3}"
            ),
        };
        if multi_target {
            notes.push("multi_target is yes, so the routing utility splits it".into());
        }
        for note in notes {
            reason.push_str("; ");
            reason.push_str(&note);
        }
        let confirm = matches!(chosen, Action::Stop);
        Ok((
            Decision {
                action: chosen,
                target: target_name,
                continue_or_fresh,
                confidence,
                for_current_agent,
                multi_target,
                unsure,
                confirm,
                reason,
            },
            rule,
        ))
    }

    /// Used when a caller is routed while no Jev response is available. This
    /// method makes the fallback explicit and keeps the one-decider boundary in
    /// the router rather than in the PBX.
    pub fn fallback(&self, error: &JevError) -> Decision {
        Decision::fallback(format!("Jev unavailable: {error}"))
    }
}

fn build_router_questions(registry: &Registry) -> BTreeMap<String, Question> {
    let action_criteria = [
        ("continue", "The caller is talking to a project agent, and the utterance is meant for that same agent: work, questions about its work, answers, feedback, or small talk."),
        ("go_to_project", "The caller wants a project agent other than the one they are talking to (or any project agent, when they are talking to the operator). Use target and continue_or_fresh."),
        ("answer_waiting", "The caller answers, accepts, or lets through a project agent that is waiting to speak."),
        ("stop", "The caller wants a project agent to stop its work or end its session. This is not hanging up the call."),
        ("set_model", "The caller wants the current project agent to use a different model."),
        ("set_thinking", "The caller wants the current project agent to use a different thinking level."),
        ("status", "The caller asks the switchboard which agents are running, busy, finished, or waiting, or asks about the call itself. A question to an agent about its own work is continue."),
        ("general", "The utterance is for the operator, not a project agent: the caller leaves the current agent (for example 'take me back' or 'I'm done here'), or asks or says something general while talking to the operator."),
        ("unclear", "It is not safe to tell what the caller wants: noise, a fragment, or garbled speech-to-text."),
        ("take_over", "The caller wants to join a project session that is already running at the desk."),
    ];
    let target_criteria = registry
        .projects
        .iter()
        .map(|project| {
            (
                project.id.clone(),
                format!(
                    "{}{}",
                    if project.description.is_empty() {
                        "Registered project"
                    } else {
                        &project.description
                    },
                    if project.aliases.is_empty() {
                        String::new()
                    } else {
                        format!("; aliases: {}", project.aliases.join(", "))
                    },
                ),
            )
        })
        .chain(std::iter::once((
            "none".into(),
            "No project target is requested or the utterance is not a project transfer.".into(),
        )));
    let mut questions = BTreeMap::new();
    questions.insert(
        "action".into(),
        Question::new(
            "choice",
            "The caller is on a voice call and is speaking to `caller_is_talking_to`. Most of what a caller says is simply part of that conversation. Which one action fits what the caller just said (`caller_just_said`)?",
            action_criteria,
        ),
    );
    questions.insert(
        "for_current_agent".into(),
        Question::new(
            "noul",
            "Is `caller_just_said` meant for the project agent the caller is talking to now: work, questions, answers, feedback, or small talk for that agent? Answer no if the caller wants to leave that agent, go to another project, or control the call or the agents (stop, change model, ask which agents are running).",
            [("true", "Meant for the current project agent."), ("false", "Meant for the switchboard or operator, or not usable.")],
        ),
    );
    questions.insert(
        "target".into(),
        Question::new(
            "choice",
            "Which registered project is the target of what the caller just said? Choose none when no project is targeted.",
            target_criteria,
        ),
    );
    questions.insert(
        "continue_or_fresh".into(),
        Question::new(
            "choice",
            "If what the caller just said sends them to a project, should it continue the existing conversation or start a fresh conversation? Choose not_applicable when no project transfer or takeover is requested.",
            [("continue", "Keep the existing project conversation and context."), ("fresh", "Start a new project conversation without the old context."), ("not_applicable", "No project conversation choice applies.")],
        ),
    );
    questions.insert(
        "multi_target".into(),
        Question::new(
            "noul",
            "Does `caller_just_said` address more than one project or agent at the same time?",
            [("true", "The caller clearly addresses multiple targets and the request should be split."), ("false", "The caller addresses one target or no project agent.")],
        ),
    );
    questions
}

fn good_moment_answer(response: &JevResponse) -> Result<bool, JevError> {
    let answer = response
        .answers
        .get("good_moment")
        .ok_or_else(|| missing("good_moment"))?;
    if let Some(choice) = answer.choice.as_deref() {
        return match choice {
            "yes" | "true" | "good" | "now" => Ok(true),
            "no" | "false" | "hold" => Ok(false),
            _ => Err(JevError::InvalidAnswer(format!(
                "unknown good_moment choice {choice:?}"
            ))),
        };
    }
    finite_unit(answer.noul, "good_moment.noul").map(|value| value >= 0.5)
}

fn required_answer<'a>(response: &'a JevResponse, name: &str) -> Result<&'a JevAnswer, JevError> {
    response.answers.get(name).ok_or_else(|| missing(name))
}
fn missing(name: &str) -> JevError {
    JevError::InvalidAnswer(format!("response is missing answer {name}"))
}
fn finite_unit(value: Option<f64>, name: &str) -> Result<f64, JevError> {
    value
        .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
        .ok_or_else(|| {
            JevError::InvalidAnswer(format!("{name} must be a finite number from 0 to 1"))
        })
}
fn estimate_tokens(value: &Value) -> usize {
    value.to_string().len().div_ceil(4)
}

#[cfg(test)]
#[path = "../tests/test_router.rs"]
mod tests;

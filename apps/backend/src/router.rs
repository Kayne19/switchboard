//! Jev-backed call routing policy and the compact call summary.

use crate::history::{TranscriptEntry, CALLER};
use crate::jev::{JevAnswer, JevClient, JevError, JevRequest, JevResponse, Question};
use crate::lifecycle::Coordinator;
use crate::pi_client::Signal;
use crate::protocol::Status;
use crate::registry::Registry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

pub const MAX_STATE_TOKENS: usize = 32_000;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AgentSummary {
    pub state: String,
    pub model: String,
    pub thinking: String,
    pub task: String,
    pub pending_request_to_speak: bool,
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
            },
        );
        if active_route != "operator" {
            agents.insert(
                active_route.clone(),
                AgentSummary {
                    state: "busy".into(),
                    model: status.model.clone(),
                    thinking: status.thinking.clone(),
                    task: String::new(),
                    pending_request_to_speak: false,
                },
            );
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
            Some("continue") => ConversationMode::Continue,
            Some("fresh") | None => ConversationMode::Fresh,
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
            Some("continue") => ConversationMode::Continue,
            Some("fresh") | None => ConversationMode::Fresh,
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
            .unwrap_or(target.is_some());
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

    pub async fn route(&self, summary: &CallSummary) -> Result<Decision, JevError> {
        let request = self.build_request(summary);
        let response = self
            .client
            .decide(request.state.clone(), request.questions.clone())
            .await?;
        let decision = self.map_response(response)?;
        tracing::info!(
            action = decision.action.as_str(),
            target = decision.target.as_deref().unwrap_or(""),
            confidence = decision.confidence,
            for_current_agent = decision.for_current_agent,
            multi_target = decision.multi_target,
            unsure = decision.unsure,
            reason = %decision.reason,
            "Jev routing decision"
        );
        Ok(decision)
    }

    /// Ask Jev whether the caller is in a good moment for one queued floor
    /// message. This is a separate one-question request so a routing answer
    /// cannot accidentally release speech.
    pub async fn good_moment(&self, summary: &CallSummary) -> Result<bool, JevError> {
        let mut questions = BTreeMap::new();
        questions.insert(
            "good_moment".into(),
            Question::new(
                "choice",
                "Is this a good moment to briefly announce one queued background-agent update to the caller?",
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
        let response = self
            .client
            .decide(summary.state_with_budget(budget), questions)
            .await?;
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

    fn map_response(&self, response: JevResponse) -> Result<Decision, JevError> {
        let action_answer = required_answer(&response, "action")?;
        let current = required_answer(&response, "for_current_agent")?;
        let target = required_answer(&response, "target")?;
        let fresh = required_answer(&response, "continue_or_fresh")?;
        let multi = required_answer(&response, "multi_target")?;
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
        if matches!(chosen, Action::GoToProject)
            && target_name.as_deref() == Some(current_route.as_str())
        {
            chosen = Action::Continue;
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
        let unsure = if stop_always_confirms {
            false
        } else if on_project && for_current_agent >= self.for_current_agent_upper {
            chosen = Action::Continue;
            false
        } else if on_project && for_current_agent > self.for_current_agent_lower {
            true
        } else {
            confidence < self.action_threshold
        };
        let reason = if unsure {
            format!("confidence policy requested top-level LLM (action={}, action_conf={confidence:.3}, for_current_agent={for_current_agent:.3})", chosen.as_str())
        } else if matches!(chosen, Action::Stop) {
            "stop always requires caller confirmation".into()
        } else {
            format!("Jev action confidence {confidence:.3} met threshold")
        };
        let confirm = matches!(chosen, Action::Stop);
        Ok(Decision {
            action: chosen,
            target: target_name,
            continue_or_fresh,
            confidence,
            for_current_agent,
            multi_target,
            unsure,
            confirm,
            reason,
        })
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

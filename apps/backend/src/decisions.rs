//! What the switchboard does with a caller's line once Jev has read it. A
//! confident decision is applied: continue with the agent on the line, go to
//! a project, split the line between projects, take over a desk session, or
//! stop a project once the caller confirms. An unsure one gets a second
//! opinion from the routing utility, and anything still unresolved goes to the
//! operator. Each hop is recorded on the debug bus under the line's utterance
//! id; routing never reads that trace.
use crate::pbx::{Switchboard, TransferContext, OPERATOR};
use crate::pi_client::{Signal, ROUTE_TOOL};
use crate::reply::Reply;
use crate::router::{Decision, UtilityDecision};
use serde_json::Value;
use std::sync::{Arc, Mutex as StdMutex};

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

/// What decision handling carries from one caller decision to the next: the
/// line being handled, for the debug trace only (set for one decision by
/// `handle_decision_with_takeover`, cleared when it ends or is cancelled;
/// routing never reads it), and the project awaiting the caller's
/// confirmation before it is stopped. Only this module reads it;
/// `Switchboard` holds one.
#[derive(Default)]
pub(crate) struct DecisionState {
    trace_utterance: Arc<StdMutex<Option<String>>>,
    pending_stop: Option<PendingStop>,
}

/// A stop the caller was asked to confirm, and the generation it was asked
/// at. Only the next decision in that generation can confirm it: a hangup,
/// a page control or any other rescue retires the generation, and with it
/// the question the caller never answered.
struct PendingStop {
    target: String,
    generation: u64,
}

impl DecisionState {
    /// Puts a project in the "stop me?" state a test wants to answer, asked
    /// at `generation`.
    #[cfg(test)]
    pub(crate) fn set_pending_stop_for_test(&mut self, project: &str, generation: u64) {
        self.pending_stop = Some(PendingStop {
            target: project.to_owned(),
            generation,
        });
    }
}

impl Switchboard {
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
        let _scope = UtteranceScope::enter(&self.decisions.trace_utterance, utterance_id);
        let reply = self
            .handle_decision_for_state(text, decision, takeover)
            .await;
        // The call state belongs to this utterance only.
        self.call_state.clear();
        reply
    }

    /// The caller line this decision is handling; `None` outside one.
    pub(crate) fn current_utterance(&self) -> Option<String> {
        self.decisions
            .trace_utterance
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
        if let Some(PendingStop { target, generation }) = self.decisions.pending_stop.take() {
            if generation != self.coordinator.generation() {
                note = format!(
                    "the pending stop of {target} was asked before a rescue, so it was dropped; "
                );
            } else if is_confirmation(text) {
                self.trace_branch(
                    "stop_confirmed",
                    format!("the caller confirmed stopping {target}"),
                );
                self.trace_routed(OPERATOR, text, "continue", "pbx");
                return self.stop_project(&target).await;
            } else {
                note =
                    format!("the pending stop of {target} was not confirmed, so it was dropped; ");
            }
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
            self.decisions.pending_stop = Some(PendingStop {
                target: target.clone(),
                generation: self.coordinator.generation(),
            });
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
        // Targets from Jev, the utility and the operator are exact ids. An
        // unknown one must not move the caller or drop the leg on the line.
        let Some(project) = self.registry.get(target).cloned() else {
            tracing::warn!(%target, "refusing a route to an unregistered project");
            self.trace_refused(target, text, via.unwrap_or("routing"));
            return self.reply_transfer_error(
                self.unknown_project_line(target),
                Some(format!("unknown project {target:?}")),
            );
        };
        if let Some(via) = via {
            let leg_gone = self.coordinator.route() == target && self.agent.is_none();
            if !leg_gone {
                self.trace_routed(target, text, mode.as_str(), via);
            }
        }
        self.set_agent_task(target, text);
        // An agent already on this call (on the line or in the background)
        // is brought forward whatever the mode: a live agent is never
        // refused or silently replaced. Stopping it is the way to start over.
        if matches!(mode, crate::router::ConversationMode::Fresh)
            && (self.coordinator.route() == target || self.background_agents.contains_key(target))
        {
            tracing::info!(%target, "fresh was asked for a live agent on this call; bringing it forward");
        }
        if self.coordinator.route() == target {
            // The utility's opinion can confirm that an unsure utterance is
            // for the project already on the line. Box this back-edge because
            // a missing project session may legitimately fall through to the
            // operator handler.
            return Box::pin(self.handle_agent_ctx(&context)).await;
        }
        // A resident of `target` is promoted, not started again
        // (`transfer_ctx`).
        self.transfer_ctx(&context, &project, "", "").await
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
        let Some(session) = self.agent_on_the_line() else {
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

/// Whether the caller's answer to "Say yes to confirm" says yes. Speech to
/// text punctuates ("Yes.", "Yes, stop it."), so case and punctuation are
/// ignored, and a yes that leads a longer answer counts.
fn is_confirmation(text: &str) -> bool {
    let lowered = text.to_lowercase();
    let words: Vec<&str> = lowered
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|word| !word.is_empty())
        .collect();
    matches!(
        words.as_slice(),
        ["yes" | "yeah" | "yep" | "confirm", ..] | ["do" | "stop", "it", ..]
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

#[cfg(test)]
#[path = "../tests/test_decisions.rs"]
mod tests;

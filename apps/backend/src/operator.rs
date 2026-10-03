//! The operator leg and the routing utility. The operator is the local Pi
//! process the caller talks to when no project is on the line; the utility is
//! a separate, stateless process for routing second opinions, split dispatch
//! and floor rewrites, so it never shares the operator's turn lock or history.
//! Both are started on first use and rebuilt after a failure.
use crate::floor::FloorRewriteInput;
use crate::pbx::{Switchboard, OPERATOR};
use crate::pi_client::{local_argv, PiSession, PiSessionError};
use crate::reply::Reply;
use crate::router::{utility_decision, Decision, UtilityDecision};
use serde_json::{json, Value};
use tokio::time::Duration;

impl Switchboard {
    /// The call as Jev saw it for the utterance about to be handled. The
    /// operator and the routing utility get it with their prompt.
    pub fn set_call_state(&mut self, call_state: String) {
        self.call_state = call_state;
    }

    pub(crate) async fn ensure_operator(&mut self) -> Result<&PiSession, PiSessionError> {
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

    /// A routing request is data only: Jev's first read, the call state and
    /// the caller's words. The rules and the catalog are in the utility's
    /// system prompt.
    pub(crate) fn utility_routing_request(
        &self,
        text: &str,
        decision: &Decision,
        retry: bool,
    ) -> String {
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
    pub(crate) async fn utility_decision(
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

    pub(crate) async fn recover_operator(&mut self, error: String) -> Reply {
        tracing::warn!(%error, "dropping and rebuilding the operator leg");
        if let Some(s) = self.operator.take() {
            s.close().await;
        }
        self.set_active_session(None).await;
        tracing::error!(%error, "operator unavailable after a failed turn");
        self.routing_unavailable()
    }
}

/// A local pi stand-in that emits one structured utility verdict. Its
/// non-utility branch is configurable so tests can hold the conversational
/// operator's turn lock without involving a real process.
#[cfg(unix)]
#[cfg(test)]
pub(crate) fn fake_routing_process(
    root: &std::path::Path,
    utility_event: &str,
    operator_event: Option<&str>,
) -> std::path::PathBuf {
    let path = root.join("fake-routing-process");
    let operator_branch = operator_event.map_or_else(
        || "while IFS= read -r _line; do sleep 60; done".to_owned(),
        |event| {
            format!(
                "while IFS= read -r _line; do printf '%s\n' '{event}'; printf '%s\n' '{{\"type\":\"agent_settled\"}}'; done"
            )
        },
    );
    let body = format!(
        r#"is_utility=0
for arg in "$@"; do
  if [ "$arg" = "--switchboard-utility" ]; then is_utility=1; fi
done
if [ "$is_utility" -eq 1 ]; then
  while IFS= read -r _line; do
    printf '%s\n' '{utility_event}'
    printf '%s\n' '{{"type":"agent_settled"}}'
  done
else
  {operator_branch}
fi
"#,
        utility_event = utility_event,
        operator_branch = operator_branch,
    );
    crate::pi_client::write_executable_script(&path, &body);
    path
}

/// An operator stand-in: its first prompt puts the caller through to alpha
/// (with `intent` "inspect it"), later ones answer "Operator has you again.",
/// or "NOTE_DELIVERED" when the prompt carries "work complete".
#[cfg(unix)]
#[cfg(test)]
pub(crate) fn fake_operator(root: &std::path::Path) -> std::path::PathBuf {
    let operator = root.join("fake-operator");
    crate::pi_client::write_executable_script(
        &operator,
        r##"count=0
while IFS= read -r line; do
count=$((count + 1))
if [ "$count" -eq 1 ]; then
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Connecting now."}}'
    printf '%s\n' '{"type":"tool_execution_start","toolName":"route","args":{"target":"alpha","mode":"fresh"}}'
else
    case "$line" in
        *"work complete"*) printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"NOTE_DELIVERED"}}' ;;
        *) printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Operator has you again."}}' ;;
    esac
fi
printf '%s\n' '{"type":"agent_settled"}'
done
"##,
    );
    operator
}

#[cfg(test)]
#[path = "../tests/test_operator.rs"]
mod tests;

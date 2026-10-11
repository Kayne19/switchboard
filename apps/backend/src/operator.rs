//! The operator leg and the routing utility. The operator is the local Pi
//! process the caller talks to when no project is on the line; the utility is
//! a separate, stateless process for routing second opinions, split dispatch
//! and floor rewrites, so it never shares the operator's turn lock or history.
//! Both are started on first use and rebuilt after a failure.
use crate::debug::DebugBus;
use crate::floor::FloorRewriteInput;
use crate::pbx::{Switchboard, OPERATOR};
use crate::pi_client::{local_argv, ActivityCallback, PiSession, PiSessionError};
use crate::reply::Reply;
use crate::router::{utility_decision, Decision, UtilityDecision};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use tokio::time::Duration;

/// What the switchboard launches the operator and the routing utility with:
/// the `pi` binary, the model, the operator's system prompt file, the
/// extension, and the environment the processes inherit. Read from `Config`
/// once; only this module uses it.
pub(crate) struct OperatorLaunch {
    pi_binary: String,
    model: Option<String>,
    system_prompt: String,
    extension: Option<String>,
    env: HashMap<String, String>,
}

impl OperatorLaunch {
    pub(crate) fn from_config(config: &crate::Config) -> Self {
        Self {
            pi_binary: config.pi_binary.clone(),
            model: config.operator_model.clone(),
            system_prompt: config.operator_prompt.to_string_lossy().into_owned(),
            extension: config.operator_extension.clone(),
            env: config.environment.clone(),
        }
    }

    /// Starts the operator: its system prompt file, when there is one,
    /// with `appended` after it. The file is read at each start.
    async fn start_operator(
        &self,
        appended: String,
        on_activity: Option<ActivityCallback>,
        debug: DebugBus,
    ) -> Result<PiSession, PiSessionError> {
        let argv = local_argv(
            &self.pi_binary,
            self.model.as_deref(),
            Some(Path::new(&self.system_prompt)).filter(|path| path.exists()),
            Some(&appended),
            self.extension.as_deref(),
            &["--no-builtin-tools".into(), "--no-session".into()],
        )?;
        self.start(argv, OPERATOR, OPERATOR, on_activity, debug)
            .await
    }

    /// Starts the routing utility on `system_prompt` alone.
    async fn start_utility(
        &self,
        system_prompt: String,
        debug: DebugBus,
    ) -> Result<PiSession, PiSessionError> {
        let argv = local_argv(
            &self.pi_binary,
            self.model.as_deref(),
            None,
            Some(&system_prompt),
            self.extension.as_deref(),
            &[
                "--no-builtin-tools".into(),
                "--no-session".into(),
                "--switchboard-utility".into(),
            ],
        )?;
        self.start(argv, "routing utility", "utility", None, debug)
            .await
    }

    async fn start(
        &self,
        argv: Vec<String>,
        label: &str,
        leg: &str,
        on_activity: Option<ActivityCallback>,
        debug: DebugBus,
    ) -> Result<PiSession, PiSessionError> {
        let session = PiSession::start(
            argv,
            label,
            leg,
            None,
            Some(self.env.clone()),
            Duration::from_secs(180),
            on_activity,
        )
        .await?;
        session.observe(debug);
        Ok(session)
    }
}

/// A local pi process the switchboard starts on first use and replaces
/// after it dies: the operator, and the routing utility. The slot is empty,
/// or holds a process that is live or has died. Nothing reports a death:
/// `ensure` finds it when the process is next needed. `ensure` is the one
/// place a process is started, and a dead one closed and replaced; `close`
/// is the one end.
pub(crate) struct LocalProcess {
    /// The process's name in the log.
    name: &'static str,
    session: Option<PiSession>,
}

/// What `ensure` did: kept the live process, or started one.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ensured {
    Kept,
    Started,
}

impl LocalProcess {
    pub(crate) fn new(name: &'static str) -> Self {
        Self {
            name,
            session: None,
        }
    }

    /// The process the slot holds, live or not.
    pub(crate) fn session(&self) -> Option<&PiSession> {
        self.session.as_ref()
    }

    /// The live process: the one held, or else what `start` starts. A
    /// process that died is closed first. `start` is polled only when a
    /// process is started; a failed start leaves the slot empty.
    async fn ensure(
        &mut self,
        start: impl Future<Output = Result<PiSession, PiSessionError>>,
    ) -> Result<(PiSession, Ensured), PiSessionError> {
        if let Some(session) = &self.session {
            if session.alive().await {
                return Ok((session.clone(), Ensured::Kept));
            }
            // The operator is the home base and is meant to outlive every
            // project leg, so a death is worth a line even though the
            // restart below hides it from the caller.
            tracing::warn!(
                stderr_lines = session.stderr_tail(5).lines().count(),
                "{} process died; restarting",
                self.name
            );
            self.close().await;
        }
        let session = start.await?;
        self.session = Some(session.clone());
        Ok((session, Ensured::Started))
    }

    /// Closes the process, if the slot holds one, and empties the slot.
    /// True when there was one.
    pub(crate) async fn close(&mut self) -> bool {
        let Some(session) = self.session.take() else {
            return false;
        };
        session.close().await;
        true
    }
}

impl Switchboard {
    /// The call as Jev saw it for the utterance about to be handled. The
    /// operator and the routing utility get it with their prompt.
    pub fn set_call_state(&mut self, call_state: String) {
        self.call_state = call_state;
    }

    /// The operator, started if it is absent or has died. A new operator
    /// renames the session guard.
    pub(crate) async fn ensure_operator(&mut self) -> Result<PiSession, PiSessionError> {
        let start = self.launch.start_operator(
            self.operator_prompt_suffix(),
            self.activity_callback.clone(),
            self.debug.clone(),
        );
        let (session, ensured) = self.operator.ensure(start).await?;
        if ensured == Ensured::Started {
            // The guard names the leg on the line: this operator only while
            // the operator is on it. It also answers some lines while a
            // project stays on the line (status, an unresolved split), and
            // that project keeps the guard: steering and every rescue act on it.
            self.name_leg_on_line(None, || {}).await;
        }
        Ok(session)
    }

    async fn ensure_utility(&mut self) -> Result<PiSession, PiSessionError> {
        // The registry is fixed for the life of the service, so the
        // catalog lives in the system prompt once.
        let start = self
            .launch
            .start_utility(self.utility_system_prompt(), self.debug.clone());
        let (session, _) = self.utility.ensure(start).await?;
        Ok(session)
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
        let session = self.ensure_utility().await?;
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
        self.ensure_utility().await
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
        self.operator.close().await;
        self.name_leg_on_line(None, || {}).await;
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

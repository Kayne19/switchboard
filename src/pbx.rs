//! Call routing and Pi session lifecycle.
use crate::models::{
    fetch_catalog, normalize_thinking, pin_thinking, ModelCatalog, ModelChoice, ModelError,
    THINKING_LEVELS,
};
use crate::pi_client::{
    local_argv, remote_argv, ActivityCallback, PiSession, PiSessionError, Signal, Turn,
    RETURN_TOOL, SET_MODEL_TOOL, TRANSFER_TOOL,
};
use crate::registry::{Project, Registry};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

pub const OPERATOR: &str = "operator";
const RETURN_SENTINEL: &str = "[[SWITCHBOARD:RETURN]]";
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
        }
    }
}

pub struct Switchboard {
    pub registry: Registry,
    pub pi_binary: String,
    pub operator_model: Option<String>,
    pub operator_system_prompt: String,
    pub operator_extension: Option<String>,
    pub agent_extension_file: Option<String>,
    pub agent_model: Option<String>,
    pub agent_thinking: String,
    pub remote_cache_dir: String,
    pub model_swaps: bool,
    pub speak_url: String,
    pub state_url: String,
    pub diagram_url: String,
    pub persona: String,
    pub env: HashMap<String, String>,
    activity_callback: Option<ActivityCallback>,
    active_session: Arc<Mutex<Option<PiSession>>>,
    route: String,
    project: Option<Project>,
    operator: Option<PiSession>,
    agent: Option<PiSession>,
    model_spec: String,
    session_id: String,
    effective_thinking: String,
    catalogs: HashMap<String, ModelCatalog>,
    operator_note: Option<String>,
    last_activity: Instant,
}
impl Switchboard {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        registry: Registry,
        pi_binary: String,
        operator_model: Option<String>,
        operator_system_prompt: String,
        operator_extension: Option<String>,
        agent_extension_file: Option<String>,
        agent_model: Option<String>,
        agent_thinking: String,
        remote_cache_dir: String,
        model_swaps: bool,
        speak_url: String,
        state_url: String,
        diagram_url: String,
        persona: String,
        env: HashMap<String, String>,
    ) -> Self {
        Self {
            registry,
            pi_binary,
            operator_model,
            operator_system_prompt,
            operator_extension,
            agent_extension_file,
            agent_model,
            agent_thinking,
            remote_cache_dir,
            model_swaps,
            speak_url,
            state_url,
            diagram_url,
            persona,
            env,
            activity_callback: None,
            active_session: Arc::new(Mutex::new(None)),
            route: OPERATOR.into(),
            project: None,
            operator: None,
            agent: None,
            model_spec: String::new(),
            session_id: String::new(),
            effective_thinking: String::new(),
            catalogs: HashMap::new(),
            operator_note: None,
            last_activity: Instant::now(),
        }
    }
    pub fn set_activity_callback(&mut self, callback: Option<ActivityCallback>) {
        self.activity_callback = callback;
    }

    pub fn session_control(&self) -> Arc<Mutex<Option<PiSession>>> {
        Arc::clone(&self.active_session)
    }

    async fn set_active_session(&self, session: Option<PiSession>) {
        *self.active_session.lock().await = session;
    }

    pub fn route(&self) -> &str {
        &self.route
    }
    pub fn status(&self) -> serde_json::Value {
        let spec = if self.route == OPERATOR {
            self.operator_model.clone().unwrap_or_default()
        } else {
            self.model_spec.clone()
        };
        let (provider, model, requested) = crate::models::parse_spec(&spec);
        let model_name = if provider.is_empty() {
            model.clone()
        } else {
            format!("{provider}/{model}")
        };
        serde_json::json!({"type":"status", "route":self.route, "label":self.route_label(), "model":spec, "model_name":model_name, "thinking":if self.effective_thinking.is_empty() { requested.clone() } else { self.effective_thinking.clone() }, "thinking_requested":requested, "thinking_confirmed":!self.effective_thinking.is_empty(), "thinking_default":self.agent_thinking, "levels":THINKING_LEVELS, "model_swaps":self.model_swaps, "projects":self.registry.catalog()})
    }
    pub fn route_label(&self) -> String {
        if self.route == OPERATOR {
            "Operator".into()
        } else {
            self.project
                .as_ref()
                .map(|p| p.id.clone())
                .unwrap_or_else(|| self.route.clone())
        }
    }
    pub fn report_leg_state(&mut self, thinking: &str) -> bool {
        if self.route == OPERATOR
            || !THINKING_LEVELS.contains(&thinking)
            || thinking == self.effective_thinking
        {
            return false;
        }
        self.effective_thinking = thinking.into();
        true
    }
    pub async fn shutdown(&mut self) {
        if let Some(session) = self.agent.take() {
            session.close().await;
        }
        if let Some(session) = self.operator.take() {
            session.close().await;
        }
        self.set_active_session(None).await;
    }
    fn active(&self) -> Option<&PiSession> {
        if self.route == OPERATOR {
            self.operator.as_ref()
        } else {
            self.agent.as_ref()
        }
    }

    pub async fn handle(&mut self, text: &str) -> Reply {
        self.last_activity = Instant::now();
        if self.route == OPERATOR {
            self.handle_operator(text).await
        } else {
            self.handle_agent(text).await
        }
    }
    pub async fn steer_if_busy(&self, text: &str) -> bool {
        let Some(session) = self.active() else {
            return false;
        };
        if !session.busy() || !session.alive().await {
            return false;
        }
        let steered = session.steer(text).await.is_ok();
        if steered { /* a steered utterance is caller activity */ }
        steered
    }
    async fn ensure_operator(&mut self) -> Result<&PiSession, PiSessionError> {
        let alive = match self.operator.as_ref() {
            Some(session) => session.alive().await,
            None => false,
        };
        if !alive {
            self.operator = None;
        }
        if self.operator.is_none() {
            let argv = local_argv(
                &self.pi_binary,
                self.operator_model.as_deref(),
                Some(std::path::Path::new(&self.operator_system_prompt)).filter(|p| p.exists()),
                self.operator_extension.as_deref(),
                &["--no-builtin-tools".into(), "--no-session".into()],
            )?;
            let session = PiSession::start(
                argv,
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
    async fn handle_operator(&mut self, text: &str) -> Reply {
        let message = self.operator_note.take().map_or_else(
            || text.to_owned(),
            |note| format!("[switchboard] {note}\n\n{text}"),
        );
        let turn = match self.ensure_operator().await {
            Ok(s) => match s.prompt(&message).await {
                Ok(t) => t,
                Err(e) => return self.recover_operator(e.to_string()).await,
            },
            Err(e) => {
                return self.reply(
                    [format!("The operator is not answering: {e}")],
                    Some(e.to_string()),
                )
            }
        };
        if turn.failed && turn.text.is_empty() {
            return self.recover_operator(turn.error).await;
        }
        if let Some(signal) = turn.signals.iter().find(|s| s.name == TRANSFER_TOOL) {
            return self
                .transfer(
                    &arg(signal, "project"),
                    &arg(signal, "intent"),
                    turn.text.clone(),
                    &arg(signal, "model"),
                    &arg(signal, "thinking"),
                )
                .await;
        }
        self.reply([turn.text], None)
    }
    async fn handle_agent(&mut self, text: &str) -> Reply {
        let Some(session) = self.agent.as_ref() else {
            return self.return_operator("project session is gone").await;
        };
        let turn = match session.prompt(text).await {
            Ok(t) => t,
            Err(e) => return self.return_operator(&e.to_string()).await,
        };
        if let Some(signal) = turn.signals.iter().find(|s| s.name == TRANSFER_TOOL) {
            let onward = self
                .transfer(
                    &arg(signal, "project"),
                    &arg(signal, "intent"),
                    String::new(),
                    &arg(signal, "model"),
                    &arg(signal, "thinking"),
                )
                .await;
            return self.prepend(turn, onward);
        }
        if let Some(signal) = turn.signals.iter().find(|s| s.name == SET_MODEL_TOOL) {
            if self.model_swaps {
                return self
                    .redial(
                        &arg(signal, "model"),
                        &arg(signal, "thinking"),
                        arg_bool(signal, "keep_context", true),
                    )
                    .await;
            }
        }
        if turn.signals.iter().any(|s| s.name == RETURN_TOOL) {
            let text = turn.text.clone();
            let synthesize = !turn.agent_spoke();
            let mut reply = self
                .return_operator(&format!(
                    "The caller was handed back from {}.",
                    self.route_label()
                ))
                .await;
            self.prepend_utterance(&text, synthesize, &mut reply);
            return reply;
        }
        self.reply_with_turn(turn)
    }
    async fn transfer(
        &mut self,
        spoken: &str,
        intent: &str,
        handoff: String,
        requested_model: &str,
        requested_thinking: &str,
    ) -> Reply {
        let Some(project) = self.registry.resolve(spoken).cloned() else {
            self.operator_note = Some(format!("Transfer to {spoken:?} failed."));
            return self.reply(
                [handoff, format!("I don't have a project called {spoken}.")],
                Some("unknown project".into()),
            );
        };
        self.drop_agent().await;
        let fallback_model = pin_thinking(
            project
                .model
                .as_deref()
                .or(self.agent_model.as_deref())
                .unwrap_or(""),
            &self.agent_thinking,
        );
        let (model, model_note) = match self
            .resolve_model(&project, requested_model, requested_thinking)
            .await
        {
            Ok(choice) => (choice.spec(), String::new()),
            Err(error) if !requested_model.is_empty() || !requested_thinking.is_empty() => {
                (fallback_model.clone(), format!("About the model: {error}"))
            }
            Err(_) => (fallback_model, String::new()),
        };
        let session_id = uuid_like();
        let session = match self.start_agent(&project, &model, &session_id).await {
            Ok(s) => s,
            Err(e) => {
                self.operator_note = Some(format!("Transfer to {} failed: {e}", project.id));
                return self.reply(
                    [
                        handoff,
                        format!("I couldn't get {} on the line: {e}", project.id),
                    ],
                    Some(e.to_string()),
                );
            }
        };
        self.agent = Some(session);
        self.set_active_session(self.agent.clone()).await;
        self.project = Some(project.clone());
        self.route = project.id.clone();
        self.model_spec = model;
        self.session_id = session_id;
        self.effective_thinking.clear();
        let intro = format!("The switchboard has just connected a caller to you.\nThey asked for: {}\nGreet them in one short sentence and start if appropriate.", if intent.is_empty() { "nothing specific" } else { intent });
        let Some(session) = self.agent.as_ref() else {
            return self.reply(
                [handoff, format!("{} did not come up.", project.id)],
                Some("project session was not created".into()),
            );
        };
        let turn = match session.prompt(&intro).await {
            Ok(t) => t,
            Err(e) => Turn {
                text: String::new(),
                signals: vec![],
                failed: true,
                error: e.to_string(),
            },
        };
        if turn.failed && turn.text.is_empty() {
            self.drop_agent().await;
            self.operator_note = Some(format!("{} did not answer", project.id));
            return self.reply(
                [handoff, format!("{} didn't pick up.", project.id)],
                Some(turn.error),
            );
        }
        let prefix = [handoff, model_note]
            .into_iter()
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        self.reply_with_turn_prefixed(turn, prefix)
    }
    async fn start_agent(
        &self,
        project: &Project,
        model: &str,
        session_id: &str,
    ) -> Result<PiSession, PiSessionError> {
        let mut env = self.env.clone();
        let agent_env = self.agent_env();
        env.extend(agent_env.clone());
        let extension = if project.is_remote() {
            if project.stage_extension {
                self.stage_extension(project.host.as_deref().unwrap_or_default())
                    .await
            } else {
                None
            }
        } else {
            self.agent_extension_file
                .as_deref()
                .filter(|path| Path::new(path).is_file())
                .map(str::to_owned)
        };
        // If staging is unavailable, omit -e deliberately. The brief then
        // instructs the runtime to use the RETURN sentinel rather than lying
        // about a tool that never loaded.
        let brief = self.agent_brief(project, extension.is_some());
        let argv = if project.is_remote() {
            remote_argv(
                project.host.as_deref().unwrap_or_default(),
                &project.cwd,
                &project.runtime,
                (!model.is_empty()).then_some(model),
                extension.as_deref(),
                Some(&brief),
                Some(session_id),
                &project.extra_args,
                &agent_env,
            )
        } else {
            let mut a = vec![project.runtime.clone(), "--mode".into(), "rpc".into()];
            if !model.is_empty() {
                a.extend(["--model".into(), model.into()]);
            }
            a.extend([
                "--session-id".into(),
                session_id.into(),
                "--append-system-prompt".into(),
                brief,
            ]);
            if let Some(ext) = extension {
                a.extend(["-e".into(), ext]);
            }
            a.extend(project.extra_args.clone());
            a
        };
        PiSession::start(
            argv,
            project.id.clone(),
            (!project.is_remote())
                .then(|| project.cwd.clone())
                .filter(|p| !p.is_empty()),
            Some(env),
            Duration::from_secs(300),
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
            brief.push_str(". Other projects available for direct transfer: ");
            let others = self
                .registry
                .projects
                .iter()
                .filter(|candidate| candidate.id != project.id)
                .map(|candidate| candidate.id.as_str())
                .collect::<Vec<_>>();
            let other_names = if others.is_empty() {
                "none".to_owned()
            } else {
                others.join(", ")
            };
            brief.push_str(&other_names);
        } else {
            brief.push_str(" When the caller asks for the operator, end with ");
            brief.push_str(RETURN_SENTINEL);
            brief.push_str(". Do not claim that a switchboard tool is available.");
        }
        brief.push_str(" Keep spoken updates brief and plain; leave code, paths, and detail in written output.");
        brief
    }

    async fn stage_extension(&self, host: &str) -> Option<String> {
        let source = self.agent_extension_file.as_deref()?;
        let contents = match tokio::fs::read(source).await {
            Ok(contents) => contents,
            Err(error) => {
                tracing::warn!(%error, source, "could not read project extension; using sentinel fallback");
                return None;
            }
        };
        let name = Path::new(source).file_name()?.to_string_lossy();
        let cache = self.remote_cache_dir.trim_end_matches('/');
        let target = format!("{cache}/{name}");
        let cache_path = if cache.starts_with('/') {
            crate::pi_client::shell_quote(cache)
        } else {
            format!("\"$HOME\"/{}", crate::pi_client::shell_quote(cache))
        };
        let target_path = if target.starts_with('/') {
            crate::pi_client::shell_quote(&target)
        } else {
            format!("\"$HOME\"/{}", crate::pi_client::shell_quote(&target))
        };
        let command = format!(
            "set -e; mkdir -p {cache_path}; cat > {target_path}; printf '%s' {target_path}"
        );
        let mut child = match Command::new("ssh")
            .args([
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                host,
                &command,
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                tracing::warn!(%error, host, "could not stage project extension; using sentinel fallback");
                return None;
            }
        };
        if let Some(mut stdin) = child.stdin.take() {
            if let Err(error) = stdin.write_all(&contents).await {
                tracing::warn!(%error, host, "could not upload project extension; using sentinel fallback");
                let _ = child.kill().await;
                return None;
            }
        }
        let output = match timeout(Duration::from_secs(30), child.wait_with_output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => {
                tracing::warn!(%error, host, "remote extension staging failed; using sentinel fallback");
                return None;
            }
            Err(_) => {
                tracing::warn!(
                    host,
                    "remote extension staging timed out; using sentinel fallback"
                );
                return None;
            }
        };
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr)
                .trim()
                .chars()
                .take(300)
                .collect::<String>();
            tracing::warn!(
                ?detail,
                host,
                "remote extension staging failed; using sentinel fallback"
            );
            return None;
        }
        let staged = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        (!staged.is_empty()).then_some(staged)
    }

    fn agent_env(&self) -> HashMap<String, String> {
        let mut e = HashMap::from([(String::from("SWITCHBOARD_SESSION"), String::from("1"))]);
        for (key, value) in [
            ("SWITCHBOARD_SPEAK_URL", &self.speak_url),
            ("SWITCHBOARD_STATE_URL", &self.state_url),
            ("SWITCHBOARD_DIAGRAM_URL", &self.diagram_url),
            ("SWITCHBOARD_PERSONA", &self.persona),
        ] {
            if !value.is_empty() {
                e.insert(key.into(), value.clone());
            }
        }
        e
    }
    async fn resolve_model(
        &mut self,
        project: &Project,
        model: &str,
        thinking: &str,
    ) -> Result<ModelChoice, ModelError> {
        let requested = if model.is_empty() {
            project
                .model
                .as_deref()
                .or(self.agent_model.as_deref())
                .unwrap_or("")
        } else {
            model
        };
        let key = format!(
            "{}\0{}",
            project.host.as_deref().unwrap_or(""),
            project.runtime
        );
        if !self.catalogs.contains_key(&key) {
            let catalog = fetch_catalog(&crate::pi_client::list_models_argv(
                &project.runtime,
                project.host.as_deref().unwrap_or(""),
            ))
            .await;
            self.catalogs.insert(key.clone(), catalog);
        }
        self.catalogs
            .get(&key)
            .ok_or_else(|| ModelError("the model catalog was unavailable".into()))?
            .resolve(requested, thinking)
    }

    async fn redial(&mut self, model: &str, thinking: &str, keep_context: bool) -> Reply {
        let Some(project) = self.project.clone() else {
            return self.reply(["There is no project on the line."], None);
        };
        let level = if thinking.is_empty() {
            self.agent_thinking.clone()
        } else {
            match normalize_thinking(thinking) {
                Ok(v) => v,
                Err(e) => return self.reply([e.to_string()], Some(e.to_string())),
            }
        };
        let choice = match self.resolve_model(&project, model, &level).await {
            Ok(choice) => choice,
            Err(error) => {
                return self.reply(
                    [format!("I didn't switch: {error}")],
                    Some(error.to_string()),
                )
            }
        };
        let spec = choice.spec();
        let session_id = if keep_context {
            self.session_id.clone()
        } else {
            uuid_like()
        };
        self.drop_agent().await;
        match self.start_agent(&project, &spec, &session_id).await {
            Ok(session) => {
                self.agent = Some(session);
                self.set_active_session(self.agent.clone()).await;
                self.route = project.id.clone();
                self.project = Some(project);
                self.session_id = session_id;
                self.model_spec = spec.clone();
                self.effective_thinking.clear();
                let prompt = if keep_context {
                    format!("You are now running on {spec}. Continue the conversation.")
                } else {
                    format!("You are now running on {spec}. The earlier conversation was deliberately cleared; start fresh.")
                };
                let turn = self
                    .agent
                    .as_ref()
                    .unwrap()
                    .prompt(&prompt)
                    .await
                    .unwrap_or(Turn {
                        text: String::new(),
                        signals: vec![],
                        failed: true,
                        error: String::new(),
                    });
                self.reply_with_turn(turn)
            }
            Err(e) => {
                self.return_operator(&format!("The project could not be restarted: {e}"))
                    .await
            }
        }
    }
    async fn return_operator(&mut self, note: &str) -> Reply {
        self.drop_agent().await;
        // Prompt the operator immediately so an onward destination in the note
        // is acted on now, not stapled onto the caller's next utterance.
        let note = note.to_owned();
        let reply = self.handle_operator(&note).await;
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
        if let Some(s) = self.agent.take() {
            s.close().await;
        }
        self.set_active_session(self.operator.clone()).await;
        self.project = None;
        self.route = OPERATOR.into();
        self.model_spec.clear();
        self.session_id.clear();
        self.effective_thinking.clear();
    }
    fn reply<I, S>(&self, texts: I, error: Option<String>) -> Reply
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Reply::new(
            &self.route,
            &self.route_label(),
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
    fn reply_with_turn(&self, turn: Turn) -> Reply {
        let spoke = turn.agent_spoke();
        let failed = turn.failed;
        let error = turn.error;
        Reply::new(
            &self.route,
            &self.route_label(),
            vec![Utterance {
                text: turn.text,
                synthesize: !spoke,
            }],
            failed.then_some(error),
        )
    }
    fn reply_with_turn_prefixed(&self, turn: Turn, prefix: String) -> Reply {
        let mut texts = Vec::new();
        if !prefix.trim().is_empty() {
            texts.push(Utterance {
                text: prefix,
                synthesize: false,
            });
        }
        let spoke = turn.agent_spoke();
        let failed = turn.failed;
        let error = turn.error;
        texts.push(Utterance {
            text: turn.text,
            synthesize: !spoke,
        });
        Reply::new(
            &self.route,
            &self.route_label(),
            texts,
            failed.then_some(error),
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
        self.transfer(project, intent, String::new(), "", "").await
    }
    pub async fn force_hangup(&mut self) -> Option<String> {
        self.last_activity = Instant::now();
        if self.route == OPERATOR {
            if let Some(session) = self.operator.take() {
                session.close().await;
                self.set_active_session(None).await;
                return Some(OPERATOR.into());
            }
            return None;
        }
        let left = self.route.clone();
        self.drop_agent().await;
        self.operator_note = Some(format!("The caller dropped the line to {left}."));
        Some(left)
    }
    pub async fn return_if_idle(&mut self, seconds: f64) -> Option<String> {
        if seconds <= 0.0
            || self.route == OPERATOR
            || self.last_activity.elapsed().as_secs_f64() < seconds
        {
            return None;
        }
        let left = self.route.clone();
        self.drop_agent().await;
        self.operator_note = Some(format!(
            "The caller went quiet, so the line to {left} was dropped."
        ));
        self.last_activity = Instant::now();
        Some(left)
    }
    pub async fn set_thinking(&mut self, level: &str) -> Reply {
        match normalize_thinking(level) {
            Ok(value) if !value.is_empty() => {
                self.agent_thinking = value.clone();
                if self.route == OPERATOR {
                    return self.reply(
                        [format!(
                            "Thinking is set to {value} for the next project call."
                        )],
                        None,
                    );
                }
                self.redial("", &value, true).await
            }
            Ok(_) => self.reply(["Name a thinking level and I'll set it."], None),
            Err(e) => self.reply([e.to_string()], Some(e.to_string())),
        }
    }
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
fn uuid_like() -> String {
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
mod tests {
    use super::*;
    #[test]
    fn state_starts_on_operator() {
        let board = Switchboard::new(
            Registry::new(vec![]),
            "pi".into(),
            None,
            "".into(),
            None,
            None,
            None,
            "medium".into(),
            ".cache".into(),
            true,
            "".into(),
            "".into(),
            "".into(),
            "".into(),
            HashMap::new(),
        );
        assert_eq!(board.route(), OPERATOR);
        assert_eq!(board.status()["route"], OPERATOR);
    }
}

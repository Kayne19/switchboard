//! Leg transitions: every way a project leg comes onto the line or leaves it.
//! A transfer, a background promotion, a takeover of a desk session and a
//! redial (`redial.rs`) each bring a leg up through one `Startup`, which
//! commits it onto the line or abandons it, so each takes the same steps in
//! the same order; an abandoned bring-up leaves the caller where they were.
//! Dropping the agent, hanging up, stopping a project and returning to the
//! operator end a leg.
use crate::hosts::Hosts;
use crate::lifecycle::{CandidateLeg, LegIdentity, LifecycleError};
use crate::pbx::{uuid_like, Switchboard, TransferContext, OPERATOR};
use crate::pi_client::{LegSession, PiSessionError, Turn};
use crate::prewarm::LaunchPlan;
use crate::project_session::{ModuleCallback, ProjectLaunch, ProjectSession, TurnCallback};
use crate::prompts::{build_intro_prompt, FOREGROUND_NOTICE};
use crate::redial::thinking_in_spec;
use crate::registry::{Project, Registry};
use crate::reply::Reply;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::time::Duration;

/// How long a project leg may go silent inside one turn, its intro included,
/// before it is dropped as wedged.
const PROJECT_TURN_TIMEOUT: Duration = Duration::from_secs(600);

/// What a project leg is launched with: the callbacks it reports turns and
/// module calls through, the projects the caller stopped (which must start
/// fresh once), and the silent-turn deadline. Only this module reads it;
/// `Switchboard` holds one.
pub(crate) struct LegLaunch {
    module_callback: Option<ModuleCallback>,
    turn_callback: Option<TurnCallback>,
    /// Projects explicitly stopped by the caller must start fresh once.
    resume_blocked: HashSet<String>,
    /// `PROJECT_TURN_TIMEOUT`, held per switchboard so a test can wait out a
    /// silent leg without waiting ten minutes.
    turn_timeout: Duration,
}

impl Default for LegLaunch {
    fn default() -> Self {
        Self {
            module_callback: None,
            turn_callback: None,
            resume_blocked: HashSet::new(),
            turn_timeout: PROJECT_TURN_TIMEOUT,
        }
    }
}

impl Switchboard {
    /// Receives project turn boundaries from host agents.
    pub fn set_turn_callback(&mut self, callback: Option<TurnCallback>) {
        self.legs.turn_callback = callback;
    }

    /// What answers a project session's `speak`, `display` and `view`.
    pub fn set_module_callback(&mut self, callback: Option<ModuleCallback>) {
        self.legs.module_callback = callback;
    }

    /// Shortens the silent-turn deadline so a test can wait it out.
    #[cfg(test)]
    pub(crate) fn set_project_turn_timeout_for_test(&mut self, timeout: Duration) {
        self.legs.turn_timeout = timeout;
    }
}

impl Switchboard {
    pub async fn transfer_ctx(
        &mut self,
        context: &TransferContext,
        spoken: &str,
        requested_model: &str,
        requested_thinking: &str,
    ) -> Reply {
        let project = match self.registry.resolve_detailed(spoken) {
            crate::registry::ResolveResult::Exact(project) => project.clone(),
            // A refused transfer leaves the caller on the leg they are on.
            crate::registry::ResolveResult::Ambiguous(candidates) => {
                let candidates_text = candidates.join(", ");
                self.operator_note = Some(format!(
                    "Couldn't tell which project {spoken:?} meant: {candidates_text}."
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
                self.operator_note = Some(format!(
                    "No project matches {spoken:?}. Registered: {known_text}."
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
        let mut startup = match self.begin_startup(candidate, LegChange::NewAgent) {
            Ok(startup) => startup,
            Err(error) => {
                tracing::warn!(project = %project.id, %error, "candidate startup was refused");
                return self.couldnt_open(&project.id, error.to_string());
            }
        };

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
                startup.abandon(self, format!("startup failed: {e}")).await;
                self.operator_note = Some(open_failed_note(&project.id, &e.to_string()));
                return self.couldnt_open(&project.id, e.to_string());
            }
        };
        startup.attach(self, &session).await;

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
                failed_turn(e)
            }
        };

        if turn.failed && turn.text.is_empty() {
            let detail = if turn.error.trim().is_empty() {
                "the agent never answered".to_owned()
            } else {
                turn.error
            };
            tracing::error!(project = %project.id, %detail, "project intro turn failed");
            startup
                .abandon(self, format!("intro failed: {detail}"))
                .await;
            self.operator_note = Some(open_failed_note(&project.id, &detail));
            return self.couldnt_open(&project.id, detail);
        }

        match startup.commit(self).await {
            Ok(leg) => self.reply_with_turn_on(turn, &leg),
            Err(error) => self.couldnt_open(&project.id, error.to_string()),
        }
    }

    pub(crate) async fn promote_background(
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
        let joined = async {
            session.set_mode("foreground").await?;
            session
                .join_call_mode(&token, &self.persona, self.speech_deadline_ms, "foreground")
                .await
        }
        .await;
        let begun = match joined {
            Ok(_) => {
                self.announce_agent_state(&project.id, "busy").await;
                let candidate = CandidateLeg::new(
                    project.id.clone(),
                    project.id.clone(),
                    session.session_id(),
                    token.clone(),
                    "",
                    self.coordinator.thinking_default(),
                );
                self.begin_startup(candidate, LegChange::NewAgent)
                    .map_err(|error| error.to_string())
            }
            Err(error) => Err(error.to_string()),
        };
        let mut startup = match begun {
            Ok(startup) => startup,
            Err(error) => {
                session.close();
                self.announce_agent_state(&project.id, "finished").await;
                return self.couldnt_bring_back(&project.id, error);
            }
        };
        // Steering and a page rescue reach the leg being brought up, as they
        // do on a transfer or a takeover.
        startup.attach(self, &session).await;
        // The agent was told background rules when it was shelved. Tell it
        // they no longer apply before it answers the caller.
        let prompt = format!("{FOREGROUND_NOTICE}\n\n{}", context.exact_caller_transcript);
        let utterance = self.current_utterance();
        let turn = session
            .prompt_as(&prompt, "foreground", utterance.as_deref())
            .await
            .unwrap_or_else(failed_turn);
        if turn.failed && turn.text.is_empty() {
            let detail = if turn.error.trim().is_empty() {
                "the agent never answered".to_owned()
            } else {
                turn.error
            };
            startup
                .abandon(self, format!("background promotion failed: {detail}"))
                .await;
            return self.couldnt_bring_back(&project.id, detail);
        }
        match startup.commit(self).await {
            Ok(leg) => self.reply_with_turn_on(turn, &leg),
            Err(error) => self.couldnt_bring_back(&project.id, error.to_string()),
        }
    }

    /// Find one untracked top-level desk session for a registered project.
    /// Service-created sessions are returned as a refusal, not silently reused
    /// by takeover: only their original lifecycle may own them.
    #[cfg(test)]
    async fn desk_session_for_takeover(&self, project: &Project) -> Result<Option<Value>, String> {
        Self::desk_session_for_takeover_from_project(self.hosts.clone(), project).await
    }

    #[cfg(test)]
    pub(crate) async fn desk_session_for_takeover_target(
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
    pub(crate) async fn take_over(
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
        let mut startup = match self.begin_startup(candidate, LegChange::NewAgent) {
            Ok(startup) => startup,
            Err(error) => return self.couldnt_take_over(&project.id, error.to_string()),
        };
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
            turn_timeout: self.legs.turn_timeout,
            on_activity: self.activity_callback.clone(),
            on_module: self.legs.module_callback.clone(),
            on_turn: self.legs.turn_callback.clone(),
            on_closed: Some(self.session_closed_callback()),
            debug: Some(self.debug.clone()),
        };
        // The desk session, attached and on the call under the leg's token.
        // One that attaches but cannot join is released here: it never
        // reached the guard.
        let joined = async {
            let (session, state) =
                ProjectSession::attach(&self.hosts, launch, session_handle).await?;
            self.confirm_thinking(&leg_token, &state);
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
                return Err(error);
            }
            Ok(session)
        }
        .await;
        let session = match joined {
            Ok(session) => session,
            Err(error) => {
                startup
                    .abandon(self, format!("takeover failed: {error}"))
                    .await;
                return self.couldnt_take_over(&project.id, error.to_string());
            }
        };
        startup.attach(self, &session).await;
        self.announce_agent_state(&project.id, "busy").await;
        let utterance = self.current_utterance();
        let turn = session
            .prompt_as(text, "caller", utterance.as_deref())
            .await
            .unwrap_or_else(failed_turn);
        if turn.failed && turn.text.is_empty() {
            let detail = if turn.error.is_empty() {
                "the desk session did not answer".to_owned()
            } else {
                turn.error.clone()
            };
            startup
                .abandon(self, format!("takeover turn failed: {detail}"))
                .await;
            return self.couldnt_take_over(&project.id, detail);
        }
        match startup.commit(self).await {
            Ok(leg) => self.reply_with_turn_on(turn, &leg),
            Err(error) => self.couldnt_take_over(&project.id, error.to_string()),
        }
    }

    /// Stages `candidate` for a bring-up that makes `change`. The startup it
    /// returns owns the bring-up until it commits the leg onto the line or
    /// abandons it.
    pub(crate) fn begin_startup(
        &self,
        candidate: CandidateLeg,
        change: LegChange,
    ) -> Result<Startup, LifecycleError> {
        let project = candidate.project.clone();
        let identity = self.coordinator.begin_candidate(candidate)?;
        Ok(Startup {
            project,
            identity,
            change,
            attached: None,
        })
    }

    /// Starts a project leg on its host from its launch plan and puts it on
    /// the call with `leg_token`. Nothing here sets anything up: the host's
    /// catalog and the prepare report were settled by prewarm.
    pub(crate) async fn start_agent(
        &mut self,
        project: &Project,
        model: &str,
        leg_token: &str,
        plan: &LaunchPlan,
    ) -> Result<ProjectSession, PiSessionError> {
        self.start_agent_mode(project, model, leg_token, plan, "foreground")
            .await
    }

    pub(crate) async fn start_agent_mode(
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
            turn_timeout: self.legs.turn_timeout,
            on_activity: self.activity_callback.clone(),
            on_module: self.legs.module_callback.clone(),
            on_turn: self.legs.turn_callback.clone(),
            on_closed: Some(self.session_closed_callback()),
            debug: Some(self.debug.clone()),
        };
        // A host-agent restart keeps resident sessions alive. Prefer the
        // matching service-created session rather than creating a duplicate.
        let resume_blocked = self.legs.resume_blocked.remove(&project.id);
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

    pub(crate) async fn return_operator_ctx(
        &mut self,
        context: &TransferContext,
        note: &str,
    ) -> Reply {
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

    pub(crate) async fn drop_agent(&mut self) {
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

    pub(crate) async fn stop_project(&mut self, target: &str) -> Reply {
        if self.coordinator.route() == target {
            self.legs.resume_blocked.insert(target.to_owned());
            self.drop_agent().await;
            return self.reply([format!("Stopped {target}.")], None);
        }
        if self.background_agents.contains_key(target) {
            self.legs.resume_blocked.insert(target.to_owned());
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

/// What a committed leg does to the foreground it takes the line from
/// (`Startup::commit`).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum LegChange {
    /// Another agent takes the line: a transfer, a background promotion, a
    /// takeover. The previous foreground is shelved, and the incoming agent
    /// settles to idle after its first turn.
    NewAgent,
    /// The project on the line is redialed onto another model or thinking
    /// level. There is no other foreground to shelve: a session that keeps
    /// its context is the one already on the line, and shelving it would
    /// close it. Its state was never published busy, so it is left alone.
    Redial,
}

/// A project leg being brought up, from the candidate it staged until it is
/// committed onto the line or abandoned. Every transition that brings a
/// project leg up (a transfer, a background promotion, a takeover, a
/// redial) holds one: it stages the candidate (`Switchboard::begin_startup`),
/// puts its session on the active-session guard (`attach`), runs its first
/// turn, then ends with `commit` or `abandon`. Each ending is written once,
/// so no bring-up can skip a step of it or take one out of order.
pub(crate) struct Startup {
    project: String,
    /// The identity the candidate is staged under. Adoption puts it on the
    /// line, and the bring-up's reply is delivered at its generation.
    identity: LegIdentity,
    change: LegChange,
    /// The session, once it is on the guard; `None` while only the
    /// candidate is staged.
    attached: Option<Attached>,
}

/// A bring-up's session on the active-session guard, and what it took the
/// guard from: the leg an abandoned bring-up hands the guard back to.
struct Attached {
    session: ProjectSession,
    displaced: Option<LegSession>,
}

impl Startup {
    /// Puts `session` on the active-session guard, so steering and a page
    /// rescue reach the leg being brought up.
    pub(crate) async fn attach(&mut self, board: &Switchboard, session: &ProjectSession) {
        let displaced = board
            .active_session
            .lock()
            .await
            .replace(LegSession::Project(session.clone()));
        self.attached = Some(Attached {
            session: session.clone(),
            displaced,
        });
    }

    /// Makes the attached leg the one on the line:
    ///
    /// 1. adopt the candidate. It may be adopted already: a candidate is
    ///    promoted on its first sign of life, which usually arrives during
    ///    its first turn. Either way the coordinator names it from here on;
    ///    the switchboard only swaps the session handles;
    /// 2. end the intro;
    /// 3. on a [`LegChange::NewAgent`], shelve the previous foreground and
    ///    settle the incoming agent, published busy for its first turn, to
    ///    idle;
    /// 4. name the session on the PBX and on the active-session guard;
    /// 5. announce the route.
    ///
    /// Returns the identity the leg is on the line under. A failed adoption
    /// commits nothing: the startup is abandoned and the error returned.
    pub(crate) async fn commit(
        mut self,
        board: &mut Switchboard,
    ) -> Result<LegIdentity, LifecycleError> {
        if board.coordinator.is_candidate() {
            if let Err(error) = board.coordinator.adopt_candidate(&self.identity.token) {
                self.abandon(board, format!("adoption failed: {error}"))
                    .await;
                return Err(error);
            }
        }
        let Some(attached) = self.attached.take() else {
            unreachable!("a bring-up commits the session it attached");
        };
        board.coordinator.finish_intro();
        if self.change == LegChange::NewAgent {
            board.shelve_previous_foreground(&self.project).await;
            board.announce_agent_state(&self.project, "idle").await;
        }
        board.agent = Some(attached.session);
        board.set_active_session(board.agent_leg()).await;
        board.announce_route().await;
        Ok(self.identity)
    }

    /// Ends a bring-up that failed, in one order whichever step it failed
    /// at: the session it attached is ended, a new agent is published
    /// finished (it was published busy around its attach), and the guard
    /// and the call line go back to the leg before it together. A rescue
    /// takes the guard under the same lock, so it finds either the
    /// bring-up's session on a line still starting, or the leg before it
    /// on the line it is back on.
    pub(crate) async fn abandon(mut self, board: &Switchboard, reason: String) {
        let attached = self.attached.take();
        if let Some(Attached { session, .. }) = &attached {
            session.close();
            if self.change == LegChange::NewAgent {
                board.announce_agent_state(&self.project, "finished").await;
            }
        }
        let mut guard = board.active_session.lock().await;
        board.coordinator.rollback_startup(reason);
        if let Some(Attached { displaced, .. }) = attached {
            *guard = displaced;
        }
    }
}

/// A prompt that could not be sent, as the failed turn the leg transitions
/// check for: no text, no signals, and the error as its detail.
fn failed_turn(error: PiSessionError) -> Turn {
    Turn {
        text: String::new(),
        signals: vec![],
        failed: true,
        error: error.to_string(),
    }
}

/// The operator's note when `project` could not be opened for the caller.
fn open_failed_note(project: &str, error: &str) -> String {
    format!("Couldn't open {project}: {}.", error.trim_end_matches('.'))
}

#[cfg(test)]
#[path = "../tests/test_leg_transitions.rs"]
mod tests;

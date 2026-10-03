//! Model and thinking changes on the project leg. `RedialPlanner` decides one
//! without the PBX lock, from the coordinator's leg and prewarm's launch plan,
//! so a refused page swap never rescues the live leg; `Switchboard::redial`
//! runs a plan only while the leg it was made for is still on the line, either
//! on the live session (`switch_live`) or on a fresh one.
use crate::lifecycle::{CandidateLeg, Coordinator, LifecycleError, ProjectLeg};
use crate::models::{normalize_thinking, parse_spec, pin_thinking, ModelCatalog};
use crate::pbx::{failed_turn, uuid_like, LegChange, Switchboard, OPERATOR};
use crate::pi_client::{LegSession, PiSessionError, ProjectSession, SessionState};
use crate::prewarm::{LaunchPlan, Prewarm};
use crate::registry::{Project, Registry};
use crate::reply::{failure_reply, spoken_reply, Reply};
use std::sync::Arc;

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
    pub(crate) coordinator: Coordinator,
    pub(crate) registry: Arc<Registry>,
    pub(crate) prewarm: Arc<Prewarm>,
    pub(crate) agent_model: Option<String>,
    pub(crate) model_swaps: bool,
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

impl Switchboard {
    /// Records the thinking level the host reports for the leg `token` names,
    /// as the leg's own report of it.
    pub(crate) fn confirm_thinking(&self, token: &str, state: &SessionState) {
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

    pub(crate) fn select_transfer_model(
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
                self.abandon_swap(
                    &project.id,
                    keep_context,
                    format!("model change failed: {error}"),
                )
                .await;
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
            let turn = session
                .prompt_as(&prompt, "model_change", None)
                .await
                .unwrap_or_else(failed_turn);
            if turn.failed && turn.text.is_empty() {
                let detail = if turn.error.is_empty() {
                    "the agent never answered".to_owned()
                } else {
                    turn.error.clone()
                };
                tracing::error!(project = %project.id, %spec, %detail, "the switched leg never answered");
                session.close();
                self.abandon_swap(
                    &project.id,
                    keep_context,
                    format!("prompt failed: {detail}"),
                )
                .await;
                self.operator_note = Some(format!(
                    "Couldn't move {} to {spec}: {}.",
                    project.id,
                    detail.trim_end_matches('.')
                ));
                return self.couldnt_bring_up_on(&project.id, &spoken, detail);
            }
            Some(turn)
        };

        if let Err(error) = self
            .commit_leg(&project.id, &leg_token, &session, LegChange::Redial)
            .await
        {
            session.close();
            self.abandon_swap(
                &project.id,
                keep_context,
                format!("adoption failed: {error}"),
            )
            .await;
            return self.couldnt_bring_up_on(&project.id, &spoken, error.to_string());
        }
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

    /// Ends a model change that failed, with exactly one `finished` for the
    /// leg that is gone. `drop_agent` announces it for the session it holds,
    /// which a kept-context change still has; a fresh-context change took the
    /// old session out when it started, so that one is announced here. Before
    /// this, a fresh change announced nothing and the page kept a state for a
    /// leg that no longer existed, and a kept change's adoption failure
    /// announced twice.
    async fn abandon_swap(&mut self, project: &str, keep_context: bool, rollback: String) {
        if !keep_context {
            self.announce_agent_state(project, "finished").await;
        }
        self.rollback_startup(rollback);
        self.drop_agent().await;
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
}

/// The thinking level a model spec asks for: its suffix, empty for none.
pub(crate) fn thinking_in_spec(spec: &str) -> String {
    parse_spec(spec).2
}

#[cfg(test)]
#[path = "../tests/test_redial.rs"]
mod tests;

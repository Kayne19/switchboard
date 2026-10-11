//! Model and thinking changes on the project leg. `RedialPlanner` decides one
//! without the PBX lock, from the coordinator's leg and prewarm's launch plan,
//! so a refused page swap never rescues the live leg; `Switchboard::redial`
//! runs a plan only while the leg it was made for is still on the line, on
//! the live session (`switch_live`).
use crate::leg_transitions::LegChange;
use crate::lifecycle::{CandidateLeg, Coordinator, LifecycleError, ProjectLeg};
use crate::models::{normalize_thinking, parse_spec, pin_thinking, ModelCatalog};
use crate::pbx::{uuid_like, Switchboard, OPERATOR};
use crate::pi_client::PiSessionError;
use crate::prewarm::{LaunchPlan, Prewarm};
use crate::project_session::{ProjectSession, SessionState};
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
    launch: LaunchPlan,
}

impl RedialPlan {
    /// The leg this redial replaces.
    pub fn leg(&self) -> &ProjectLeg {
        &self.leg
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
/// without waiting for the turn in flight or cancelling it. Its callers are
/// the page's pickers (`/model`, `/thinking`).
#[derive(Clone)]
pub struct RedialPlanner {
    coordinator: Coordinator,
    registry: Arc<Registry>,
    prewarm: Arc<Prewarm>,
    agent_model: Option<String>,
    model_swaps: bool,
}

impl RedialPlanner {
    pub(crate) fn new(
        coordinator: Coordinator,
        registry: Arc<Registry>,
        prewarm: Arc<Prewarm>,
        agent_model: Option<String>,
        model_swaps: bool,
    ) -> Self {
        Self {
            coordinator,
            registry,
            prewarm,
            agent_model,
            model_swaps,
        }
    }

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
        self.plan(model, "").await
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
                self.plan("", &value).await
            }
            Ok(_) => self.answer(["Name a thinking level and I'll set it."], None),
            Err(e) => self.answer([e.to_string()], Some(e.to_string())),
        }
    }

    /// Decides a redial of the project leg on the line, which keeps its
    /// conversation. Every refusal is made here, before anything is torn down,
    /// and leaves the live leg running.
    async fn plan(&self, model: &str, thinking: &str) -> Redial {
        // Read in one piece: the leg the plan replaces, its model, and its
        // session all belong to the same leg.
        let on_the_line = self.coordinator.project_leg().and_then(|leg| {
            let project = self.registry.get(&leg.project).cloned()?;
            Some((leg, project))
        });
        let Some((leg, project)) = on_the_line else {
            return self.answer(["We're not on a project right now."], None);
        };
        // A leg still coming up is not the PBX's yet: its startup commits it
        // when its intro ends. `begin_rescue_of` refuses it too, in case one
        // begins after this check.
        if self.coordinator.startup_in_flight() {
            return self.answer(
                ["I'm still connecting. Change the model once they answer."],
                Some("The leg on the line is still starting.".into()),
            );
        }
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
        if spec == leg.model {
            return self.answer([format!("Already on {}.", choice.spoken())], None);
        }
        Redial::Planned(Box::new(RedialPlan {
            leg,
            project,
            spec,
            spoken: choice.spoken(),
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

    /// Changes the leg on the line to what `plan` describes, on the live
    /// session (`set_model`, `set_thinking`), which keeps its history. The leg
    /// is staged and adopted like any new leg, under a new call token.
    async fn swap(&mut self, plan: RedialPlan) -> Reply {
        let RedialPlan {
            leg,
            project,
            spec,
            spoken,
            launch,
        } = plan;
        tracing::info!(
            project = %project.id,
            from = %leg.model,
            to = %spec,
            "changing the model of the live leg"
        );
        let leg_token = uuid_like();
        let candidate = CandidateLeg::new(
            project.id.clone(),
            project.id.clone(),
            leg.persistent_session_id.clone(),
            leg_token.clone(),
            spec.clone(),
            thinking_in_spec(&spec),
        )
        .with_catalog(launch.catalog.clone());
        let mut startup = match self.begin_startup(candidate, LegChange::Redial) {
            Ok(startup) => startup,
            Err(error) => {
                tracing::warn!(project = %project.id, %error, "candidate startup for the model change was refused");
                return self.reply_failure(
                    format!("I couldn't change the model on {}.", project.id),
                    error.to_string(),
                );
            }
        };

        // A change the host refused before anything changed keeps the leg
        // as it was (#423, #327); any other failed change loses the leg.
        let switched = match self.switch_live(&leg.model, &spec, &leg_token).await {
            Ok(switched) => switched,
            Err(SwitchFailed::Unchanged { session, error }) => {
                tracing::warn!(project = %project.id, %spec, %error, "the host refused the change; the leg stays as it was");
                startup
                    .abandon(self, format!("model change refused: {error}"))
                    .await;
                let Err(rejoin) = self.rejoin_the_line(&session).await else {
                    return self.reply_failure(
                        format!(
                            "I couldn't move {} to {spoken}, so it stays as it was.",
                            project.id
                        ),
                        error.to_string(),
                    );
                };
                tracing::error!(project = %project.id, error = %rejoin, "the kept leg could not rejoin the call");
                return self.lose_the_leg(&project.id, &spec, &spoken, rejoin).await;
            }
            Err(SwitchFailed::Lost(error)) => {
                tracing::error!(project = %project.id, %spec, %error, "could not change the leg's model");
                startup
                    .abandon(self, format!("model change failed: {error}"))
                    .await;
                return self.lose_the_leg(&project.id, &spec, &spoken, error).await;
            }
        };
        let Switched {
            session,
            level_refused,
        } = switched;
        startup.attach(self, &session).await;

        match startup.commit(self).await {
            Ok(leg) => {
                let mut reply = match level_refused {
                    None => self.reply([format!("Now on {spoken}.")], None),
                    Some(level) => {
                        let (provider, model, _) = parse_spec(&spec);
                        tracing::warn!(project = %project.id, %spec, error = %level.error, "the host refused the level; the leg is on the new model at its own level");
                        self.reply(
                            [format!("Now on {model} on {provider}{}", level.spoken())],
                            Some(level.error.to_string()),
                        )
                    }
                };
                reply.delivery_generation = Some(leg.generation);
                reply
            }
            Err(error) => {
                self.drop_agent().await;
                self.couldnt_bring_up_on(&project.id, &spoken, error.to_string())
            }
        }
    }

    /// Changes the live session's model and thinking level from `from` to
    /// `to`, and puts it on the call under `leg_token`. The session keeps its
    /// history. A level the host refuses after the model changed is not a
    /// failed switch: `Switched::level_refused` says so.
    async fn switch_live(
        &self,
        from: &str,
        to: &str,
        leg_token: &str,
    ) -> Result<Switched, SwitchFailed> {
        let Some(session) = self.agent_on_the_line() else {
            return Err(SwitchFailed::Lost(PiSessionError(
                "the project session is gone".into(),
            )));
        };
        let (from_provider, from_model, from_thinking) = parse_spec(from);
        let (provider, model, thinking) = parse_spec(to);
        let mut state = SessionState::default();
        let mut level_refused = None;
        let model_changed = (&provider, &model) != (&from_provider, &from_model);
        if model_changed {
            state = session
                .set_model(&provider, &model)
                .await
                .map_err(|error| SwitchFailed::before_any_change(&session, error))?;
        }
        // A new model may come up at its own level, so the level asked for is
        // set again after it.
        if !thinking.is_empty() && (model_changed || thinking != from_thinking) {
            match session.set_thinking(&thinking).await {
                Ok(set) => state = set,
                // The model changed and the host refused only the level: the
                // leg goes on to the new model at the level the host reports
                // for it (#423). A session is not ended over a level.
                Err(error) if model_changed && session.alive() => {
                    level_refused = Some(LevelRefused {
                        asked: thinking.clone(),
                        running: state.thinking.clone(),
                        error,
                    });
                }
                Err(error) if model_changed => return Err(SwitchFailed::Lost(error)),
                Err(error) => return Err(SwitchFailed::before_any_change(&session, error)),
            }
        }
        session
            .join_call(leg_token, &self.persona, self.speech_deadline_ms)
            .await
            .map_err(SwitchFailed::Lost)?;
        self.confirm_thinking(leg_token, &state);
        Ok(Switched {
            session,
            level_refused,
        })
    }

    /// Ends a leg whose change failed: the session it kept is still the
    /// switchboard's agent, so `drop_agent` ends it and announces its
    /// `finished`, exactly once, and the caller is back on the operator.
    async fn lose_the_leg(
        &mut self,
        project: &str,
        spec: &str,
        spoken: &str,
        error: PiSessionError,
    ) -> Reply {
        self.drop_agent().await;
        self.operator_note = Some(format!(
            "Couldn't move {project} to {spec}: {}.",
            error.to_string().trim_end_matches('.')
        ));
        self.couldnt_bring_up_on(project, spoken, error.to_string())
    }

    /// Puts `session` back on the call under the token of the leg on the
    /// line: a redial the host refused rolled back to the leg its rescue
    /// left, which carries a token the session was never told.
    async fn rejoin_the_line(&self, session: &ProjectSession) -> Result<(), PiSessionError> {
        let token = self.coordinator.current_identity().token;
        session
            .join_call(&token, &self.persona, self.speech_deadline_ms)
            .await
    }
}

/// A live switch that went through.
struct Switched {
    session: ProjectSession,
    /// The host refused the level asked for after the model changed: the
    /// leg is on the new model at the level the model came up at.
    level_refused: Option<LevelRefused>,
}

/// A level the host would not set on a model it had just switched to.
struct LevelRefused {
    /// The level asked for.
    asked: String,
    /// The level the host reported for the new model; empty if it named none.
    running: String,
    error: PiSessionError,
}

impl LevelRefused {
    /// What the caller hears after `Now on <model>`.
    fn spoken(&self) -> String {
        if self.running.is_empty() {
            format!(
                ", but it would not take thinking {}, so it keeps the model's own level.",
                self.asked
            )
        } else {
            format!(
                ", but it would not take thinking {}, so it runs at {}.",
                self.asked, self.running
            )
        }
    }
}

/// Why a live switch did not go through.
enum SwitchFailed {
    /// The host refused the first change it was asked for, so the session
    /// still runs the leg's model and level and is still usable (#423).
    Unchanged {
        session: ProjectSession,
        error: PiSessionError,
    },
    /// The session is gone, failed on the link, or was left part-changed:
    /// the leg cannot be kept.
    Lost(PiSessionError),
}

impl SwitchFailed {
    /// A failure of the first command a switch sends: the leg is kept only
    /// if the host refused it and the session is still usable.
    fn before_any_change(session: &ProjectSession, error: PiSessionError) -> Self {
        if session.alive() {
            Self::Unchanged {
                session: session.clone(),
                error,
            }
        } else {
            Self::Lost(error)
        }
    }
}

/// The thinking level a model spec asks for: its suffix, empty for none.
pub(crate) fn thinking_in_spec(spec: &str) -> String {
    parse_spec(spec).2
}

#[cfg(test)]
#[path = "../tests/test_redial.rs"]
mod tests;

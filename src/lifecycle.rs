//! Synchronous ownership for call identity, operations, and status publication.
//!
//! The coordinator deliberately contains no async code. Callers take a short
//! linearization point here, then perform PBX, process, or callback work after
//! releasing it.

use crate::models::ModelCatalog;
use serde_json::{json, Value};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

const OPERATOR: &str = "operator";

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct LegIdentity {
    pub token: String,
    pub generation: u64,
}

impl LegIdentity {
    pub fn new(token: impl Into<String>, generation: u64) -> Self {
        Self {
            token: token.into(),
            generation,
        }
    }

    pub fn matches(&self, other: &Self) -> bool {
        self == other
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Operator,
    Starting,
    Intro,
    Active,
    TurnRunning,
    Quiescing,
    Shutdown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperationKind {
    Prompt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OperationIdentity {
    pub id: u64,
    pub leg: LegIdentity,
    pub kind: OperationKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LifecycleSnapshot {
    pub route: String,
    pub project: Option<String>,
    pub persistent_session_id: String,
    pub leg: LegIdentity,
    pub phase: Phase,
    pub model: String,
    pub thinking_requested: String,
    pub thinking_effective: String,
    pub operation: Option<OperationIdentity>,
    pub terminal_reason: Option<String>,
}

#[derive(Clone, Debug)]
pub struct CandidateLeg {
    pub route: String,
    pub project: String,
    pub persistent_session_id: String,
    pub identity: LegIdentity,
    pub model: String,
    pub thinking: String,
    pub startup_thinking: String,
    pub catalog: Option<Arc<ModelCatalog>>,
}

impl CandidateLeg {
    pub fn new(
        route: impl Into<String>,
        project: impl Into<String>,
        persistent_session_id: impl Into<String>,
        token: impl Into<String>,
        model: impl Into<String>,
        thinking: impl Into<String>,
    ) -> Self {
        Self {
            route: route.into(),
            project: project.into(),
            persistent_session_id: persistent_session_id.into(),
            identity: LegIdentity::new(token, 0),
            model: model.into(),
            thinking: thinking.into(),
            startup_thinking: String::new(),
            catalog: None,
        }
    }

    pub fn with_catalog(mut self, catalog: ModelCatalog) -> Self {
        self.catalog = Some(Arc::new(catalog));
        self
    }
}

#[derive(Clone, Debug)]
pub struct CatalogPublication {
    pub project: String,
    pub generation: u64,
    pub catalog: Arc<ModelCatalog>,
}

#[derive(Clone, Debug)]
pub struct StatusProjection {
    pub lifecycle: LifecycleSnapshot,
    pub catalog: Option<CatalogPublication>,
    value: Value,
}

impl StatusProjection {
    pub fn json(&self) -> Value {
        self.value.clone()
    }

    pub fn is_catalog_current(&self) -> bool {
        match (&self.catalog, &self.lifecycle.project) {
            (Some(catalog), Some(project)) => {
                catalog.project == *project && catalog.generation == self.lifecycle.leg.generation
            }
            (None, _) => true,
            _ => false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LifecycleError {
    StaleLeg,
    WrongPhase,
    OperationActive,
    NoActiveOperation,
    Shutdown,
    NoCandidate,
    CandidateTokenMismatch,
    CandidateSideEffect,
    CandidateActive,
}

impl fmt::Display for LifecycleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::StaleLeg => "leg is stale",
            Self::WrongPhase => "operation is not valid in this phase",
            Self::OperationActive => "a prompt operation is already active",
            Self::NoActiveOperation => "no prompt operation is active",
            Self::Shutdown => "switchboard is shutting down",
            Self::NoCandidate => "no candidate leg is staged",
            Self::CandidateTokenMismatch => "candidate token does not match",
            Self::CandidateSideEffect => "candidate side effects are private",
            Self::CandidateActive => "a candidate leg is already staged",
        })
    }
}
impl std::error::Error for LifecycleError {}

pub struct CallLifecycle {
    route: String,
    project: Option<String>,
    persistent_session_id: String,
    leg: LegIdentity,
    phase: Phase,
    model: String,
    thinking_requested: String,
    thinking_effective: String,
    last_activity: Instant,
    operation: Option<OperationIdentity>,
    terminal_reason: Option<String>,
    candidate: Option<CandidateLeg>,
    catalog: Option<CatalogPublication>,
    status_value: Value,
}

impl CallLifecycle {
    pub fn operator(status: Value) -> Self {
        Self {
            route: OPERATOR.into(),
            project: None,
            persistent_session_id: String::new(),
            leg: LegIdentity::new("operator", 0),
            phase: Phase::Operator,
            model: String::new(),
            thinking_requested: String::new(),
            thinking_effective: String::new(),
            last_activity: Instant::now(),
            operation: None,
            terminal_reason: None,
            candidate: None,
            catalog: None,
            status_value: status,
        }
    }

    fn snapshot(&self) -> LifecycleSnapshot {
        LifecycleSnapshot {
            route: self.route.clone(),
            project: self.project.clone(),
            persistent_session_id: self.persistent_session_id.clone(),
            leg: self.leg.clone(),
            phase: self.phase,
            model: self.model.clone(),
            thinking_requested: self.thinking_requested.clone(),
            thinking_effective: self.thinking_effective.clone(),
            operation: self.operation.clone(),
            terminal_reason: self.terminal_reason.clone(),
        }
    }

    fn publish_projection(&self) -> StatusProjection {
        let mut value = self.status_value.clone();
        if !value.is_object() {
            value = json!({"type":"status"});
        }
        value["type"] = json!("status");
        value["route"] = json!(self.route);
        if !self.model.is_empty() {
            value["model"] = json!(self.model);
        }
        let thinking = if self.thinking_effective.is_empty() {
            &self.thinking_requested
        } else {
            &self.thinking_effective
        };
        value["thinking"] = json!(thinking);
        value["thinking_requested"] = json!(self.thinking_requested);
        value["thinking_confirmed"] = json!(!self.thinking_effective.is_empty());
        if let Some(catalog) = &self.catalog {
            if self.project.as_deref() == Some(catalog.project.as_str())
                && catalog.generation == self.leg.generation
            {
                value["models"] = Value::Array(
                    catalog
                        .catalog
                        .entries
                        .iter()
                        .map(|entry| {
                            json!({
                                "provider": entry.provider,
                                "model": entry.model,
                                "thinks": entry.thinks,
                            })
                        })
                        .collect(),
                );
                value["models_available"] = json!(catalog.catalog.available);
                value["models_diagnostic"] = catalog
                    .catalog
                    .diagnostic
                    .clone()
                    .map_or(Value::Null, Value::String);
            }
        } else if self.project.is_some() && value.get("models").is_none() {
            // Older/page-redial paths publish a complete status projection
            // before attaching a CandidateLeg catalog. Preserve that
            // provider-qualified snapshot instead of disabling the picker just
            // because the lifecycle cache is empty.
            value["models"] = json!([]);
            value["models_available"] = json!(false);
            value["models_diagnostic"] = json!("model catalog has not been loaded");
        } else if self.catalog.is_some() {
            // A rescue advances the generation before old resources are closed.
            // Never expose a catalog from that retired leg as current status.
            value["models"] = json!([]);
            value["models_available"] = json!(false);
            value["models_diagnostic"] = json!("model catalog is stale");
        }
        StatusProjection {
            lifecycle: self.snapshot(),
            catalog: self.catalog.clone(),
            value,
        }
    }
}

#[derive(Clone)]
pub struct Coordinator {
    state: Arc<Mutex<CallLifecycle>>,
    projection: Arc<RwLock<Arc<StatusProjection>>>,
    next_operation: Arc<AtomicU64>,
}

impl Coordinator {
    pub fn new(status: Value) -> Self {
        let lifecycle = CallLifecycle::operator(status);
        let projection = Arc::new(RwLock::new(Arc::new(lifecycle.publish_projection())));
        Self {
            state: Arc::new(Mutex::new(lifecycle)),
            projection,
            next_operation: Arc::new(AtomicU64::new(1)),
        }
    }

    pub fn linearize<R>(&self, operation: impl FnOnce(&mut CallLifecycle) -> R) -> R {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        operation(&mut state)
    }

    fn refresh_locked(&self, state: &CallLifecycle) {
        let projection = Arc::new(state.publish_projection());
        *self
            .projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = projection;
    }

    pub fn status_snapshot(&self) -> Arc<StatusProjection> {
        self.projection
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn status_json(&self) -> Value {
        self.status_snapshot().json()
    }

    pub fn current_identity(&self) -> LegIdentity {
        self.linearize(|state| state.leg.clone())
    }

    pub fn generation(&self) -> u64 {
        self.current_identity().generation
    }

    pub fn begin_prompt(&self, leg: &LegIdentity) -> Result<OperationIdentity, LifecycleError> {
        let id = self.next_operation.fetch_add(1, Ordering::Relaxed);
        self.linearize(|state| {
            if state.leg != *leg {
                return Err(LifecycleError::StaleLeg);
            }
            if matches!(state.phase, Phase::Quiescing | Phase::Shutdown) {
                return Err(if state.phase == Phase::Shutdown {
                    LifecycleError::Shutdown
                } else {
                    LifecycleError::WrongPhase
                });
            }
            if state.operation.is_some() {
                return Err(LifecycleError::OperationActive);
            }
            let operation = OperationIdentity {
                id,
                leg: leg.clone(),
                kind: OperationKind::Prompt,
            };
            state.operation = Some(operation.clone());
            state.phase = Phase::TurnRunning;
            self.refresh_locked(state);
            Ok(operation)
        })
    }

    pub fn attach_steer(&self, leg: &LegIdentity) -> Result<OperationIdentity, LifecycleError> {
        self.linearize(|state| {
            if state.leg != *leg {
                return Err(LifecycleError::StaleLeg);
            }
            if !matches!(state.phase, Phase::TurnRunning | Phase::Active) {
                return Err(LifecycleError::WrongPhase);
            }
            state
                .operation
                .clone()
                .ok_or(LifecycleError::NoActiveOperation)
        })
    }

    pub fn finish_operation(&self, operation: &OperationIdentity) -> bool {
        self.linearize(|state| {
            if state.operation.as_ref() != Some(operation) {
                return false;
            }
            state.operation = None;
            if state.phase == Phase::TurnRunning {
                state.phase = if state.route == OPERATOR {
                    Phase::Operator
                } else {
                    Phase::Active
                };
            }
            self.refresh_locked(state);
            true
        })
    }

    pub fn accept_callback(&self, leg: &LegIdentity, operation: &OperationIdentity) -> bool {
        self.linearize(|state| {
            state.leg == *leg
                && state.operation.as_ref() == Some(operation)
                && matches!(state.phase, Phase::TurnRunning | Phase::Active)
        })
    }

    pub fn rotate_leg_token(&self, token: impl Into<String>) -> LegIdentity {
        self.linearize(|state| {
            state.operation = None;
            state.leg = LegIdentity::new(token, state.leg.generation + 1);
            self.refresh_locked(state);
            state.leg.clone()
        })
    }

    pub fn begin_rescue(&self, reason: impl Into<String>) -> LegIdentity {
        let trace = crate::diagnostic::DiagnosticTrace::global();
        let next = self.linearize(|state| {
            if state.phase == Phase::Shutdown {
                state.leg = LegIdentity::new(state.leg.token.clone(), state.leg.generation + 1);
                self.refresh_locked(state);
                return state.leg.clone();
            }
            state.phase = Phase::Quiescing;
            state.operation = None;
            state.terminal_reason = Some(reason.into());
            state.leg = LegIdentity::new(state.leg.token.clone(), state.leg.generation + 1);
            self.refresh_locked(state);
            state.leg.clone()
        });
        trace.record("lifecycle", "rescue", next.generation, "");
        next
    }

    pub fn touch_activity(&self) {
        self.linearize(|state| state.last_activity = Instant::now());
    }

    pub fn publish_status(&self, status: Value) {
        self.linearize(|state| {
            if let Some(route) = status.get("route").and_then(Value::as_str) {
                state.route = route.to_owned();
                if state.phase == Phase::Quiescing {
                    state.phase = if route == OPERATOR {
                        Phase::Operator
                    } else {
                        Phase::Active
                    };
                }
            }
            state.status_value = status;
            self.refresh_locked(state);
        });
    }

    pub fn begin_candidate(&self, mut candidate: CandidateLeg) -> Result<(), LifecycleError> {
        self.linearize(|state| {
            if state.phase == Phase::Shutdown {
                return Err(LifecycleError::Shutdown);
            }
            if state.candidate.is_some() || matches!(state.phase, Phase::Starting | Phase::Intro) {
                return Err(LifecycleError::CandidateActive);
            }
            if candidate.identity.token.trim().is_empty() {
                return Err(LifecycleError::CandidateTokenMismatch);
            }
            candidate.identity.generation = state.leg.generation + 1;
            state.phase = Phase::Starting;
            state.candidate = Some(candidate);
            Ok(())
        })
    }

    pub fn is_candidate(&self) -> bool {
        self.linearize(|state| matches!(state.phase, Phase::Starting | Phase::Intro))
    }

    pub fn reject_candidate_side_effect(&self) -> Result<(), LifecycleError> {
        self.linearize(|state| {
            if matches!(state.phase, Phase::Starting | Phase::Intro) {
                Err(LifecycleError::CandidateSideEffect)
            } else {
                Ok(())
            }
        })
    }

    pub fn accept_side_effect(&self, token: &str) -> Result<(), LifecycleError> {
        self.linearize(|state| {
            if matches!(state.phase, Phase::Starting | Phase::Intro) {
                return Err(LifecycleError::CandidateSideEffect);
            }
            if token.is_empty() {
                if state.route == OPERATOR {
                    return Ok(());
                }
                return Err(LifecycleError::StaleLeg);
            }
            if state.route == OPERATOR
                || state.leg.token != token
                || state.operation.is_none()
                || matches!(state.phase, Phase::Quiescing | Phase::Shutdown)
            {
                return Err(LifecycleError::StaleLeg);
            }
            Ok(())
        })
    }

    pub fn accept_thinking_callback(
        &self,
        token: &str,
        thinking: &str,
    ) -> Result<bool, LifecycleError> {
        self.linearize(|state| {
            if !crate::models::THINKING_LEVELS.contains(&thinking) {
                return Err(LifecycleError::WrongPhase);
            }
            if let Some(candidate) = state.candidate.as_mut() {
                if candidate.identity.token == token
                    && matches!(state.phase, Phase::Starting | Phase::Intro)
                {
                    candidate.startup_thinking = thinking.to_owned();
                    return Ok(false);
                }
            }
            if state.leg.token != token || matches!(state.phase, Phase::Quiescing | Phase::Shutdown)
            {
                return Err(LifecycleError::StaleLeg);
            }
            state.thinking_effective = thinking.to_owned();
            self.refresh_locked(state);
            Ok(true)
        })
    }

    pub fn accept_startup_thinking(
        &self,
        token: &str,
        thinking: &str,
    ) -> Result<(), LifecycleError> {
        self.linearize(|state| {
            let candidate = state
                .candidate
                .as_mut()
                .ok_or(LifecycleError::NoCandidate)?;
            if candidate.identity.token != token {
                return Err(LifecycleError::CandidateTokenMismatch);
            }
            if !matches!(state.phase, Phase::Starting | Phase::Intro) {
                return Err(LifecycleError::WrongPhase);
            }
            if !crate::models::THINKING_LEVELS.contains(&thinking) {
                return Err(LifecycleError::WrongPhase);
            }
            candidate.startup_thinking = thinking.to_owned();
            Ok(())
        })
    }

    pub fn candidate_identity(&self) -> Option<LegIdentity> {
        self.linearize(|state| {
            state
                .candidate
                .as_ref()
                .map(|candidate| candidate.identity.clone())
        })
    }

    pub fn rollback_candidate(&self, reason: impl Into<String>) -> bool {
        self.linearize(|state| {
            if state.candidate.take().is_none() {
                return false;
            }
            state.terminal_reason = Some(reason.into());
            if state.phase == Phase::Starting || state.phase == Phase::Intro {
                state.phase = if state.route == OPERATOR {
                    Phase::Operator
                } else {
                    Phase::Active
                };
            }
            self.refresh_locked(state);
            true
        })
    }

    pub fn adopt_candidate(&self) -> Result<LegIdentity, LifecycleError> {
        self.linearize(|state| {
            let candidate = state.candidate.take().ok_or(LifecycleError::NoCandidate)?;
            let identity = candidate.identity.clone();
            state.route = candidate.route;
            state.project = Some(candidate.project.clone());
            state.persistent_session_id = candidate.persistent_session_id;
            state.leg = identity.clone();
            state.phase = Phase::Active;
            state.model = candidate.model;
            state.thinking_requested = candidate.thinking;
            state.thinking_effective = candidate.startup_thinking;
            state.operation = None;
            state.terminal_reason = None;
            state.catalog = candidate.catalog.map(|catalog| CatalogPublication {
                project: candidate.project,
                generation: identity.generation,
                catalog,
            });
            self.refresh_locked(state);
            Ok(identity)
        })
    }

    pub fn return_if_idle(&self, timeout: std::time::Duration) -> Option<LegIdentity> {
        self.linearize(|state| {
            if state.route == OPERATOR
                || state.operation.is_some()
                || state.candidate.is_some()
                || state.last_activity.elapsed() < timeout
                || matches!(state.phase, Phase::Quiescing | Phase::Shutdown)
            {
                return None;
            }
            state.phase = Phase::Quiescing;
            state.operation = None;
            state.leg = LegIdentity::new(state.leg.token.clone(), state.leg.generation + 1);
            self.refresh_locked(state);
            Some(state.leg.clone())
        })
    }

    pub fn begin_shutdown(&self) -> bool {
        self.linearize(|state| {
            if state.phase == Phase::Shutdown {
                false
            } else {
                state.phase = Phase::Shutdown;
                state.operation = None;
                state.leg = LegIdentity::new(state.leg.token.clone(), state.leg.generation + 1);
                self.refresh_locked(state);
                true
            }
        })
    }

    pub fn finish_shutdown(&self) {
        self.linearize(|state| state.terminal_reason = Some("shutdown".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CatalogEntry, ModelCatalog};
    use std::sync::Arc;
    use std::thread;

    fn coordinator() -> Coordinator {
        Coordinator::new(json!({
            "type": "status",
            "route": "operator",
            "models": [],
            "models_available": true
        }))
    }

    #[test]
    fn prompt_and_steer_share_one_operation_identity() {
        let coordinator = coordinator();
        let leg = coordinator.current_identity();
        let operation = coordinator.begin_prompt(&leg).unwrap();
        assert_eq!(coordinator.attach_steer(&leg).unwrap(), operation);
        assert!(coordinator.accept_callback(&leg, &operation));
        assert!(coordinator.finish_operation(&operation));
        assert!(!coordinator.finish_operation(&operation));
    }

    #[test]
    fn stale_generation_and_concurrent_prompt_are_rejected() {
        let coordinator = coordinator();
        let old = coordinator.current_identity();
        let operation = coordinator.begin_prompt(&old).unwrap();
        assert_eq!(
            coordinator.begin_prompt(&old),
            Err(LifecycleError::OperationActive)
        );
        let current = coordinator.begin_rescue("page rescue");
        assert_eq!(current.generation, old.generation + 1);
        assert!(!coordinator.finish_operation(&operation));
        assert_eq!(
            coordinator.begin_prompt(&old),
            Err(LifecycleError::StaleLeg)
        );
    }

    #[test]
    fn startup_thinking_is_private_until_candidate_adoption() {
        let coordinator = coordinator();
        let candidate = CandidateLeg::new(
            "alpha",
            "alpha",
            "pi-session",
            "candidate",
            "anthropic/opus",
            "medium",
        );
        coordinator.begin_candidate(candidate).unwrap();
        assert!(coordinator
            .accept_startup_thinking("candidate", "not-a-level")
            .is_err());
        assert_eq!(coordinator.status_json()["thinking"], "");
        coordinator
            .accept_startup_thinking("candidate", "high")
            .unwrap();
        assert_eq!(coordinator.status_json()["route"], "operator");
        let identity = coordinator.adopt_candidate().unwrap();
        assert_eq!(identity.generation, 1);
        assert_eq!(coordinator.status_json()["route"], "alpha");
        assert_eq!(coordinator.status_json()["thinking"], "high");
    }

    #[test]
    fn rescue_reopens_only_after_a_new_status_projection() {
        let coordinator = coordinator();
        let old = coordinator.current_identity();
        coordinator.begin_rescue("page rescue");
        assert_eq!(
            coordinator.begin_prompt(&coordinator.current_identity()),
            Err(LifecycleError::WrongPhase)
        );
        coordinator.publish_status(json!({"type":"status", "route":"operator"}));
        let operation = coordinator
            .begin_prompt(&coordinator.current_identity())
            .unwrap();
        assert_eq!(operation.leg.generation, old.generation + 1);
    }

    #[test]
    fn candidate_failure_rolls_back_private_state_and_side_effects_are_rejected() {
        let coordinator = coordinator();
        coordinator
            .begin_candidate(CandidateLeg::new(
                "alpha",
                "alpha",
                "session",
                "candidate",
                "model",
                "medium",
            ))
            .unwrap();
        assert_eq!(
            coordinator.reject_candidate_side_effect(),
            Err(LifecycleError::CandidateSideEffect)
        );
        assert_eq!(
            coordinator.accept_thinking_callback("candidate", "high"),
            Ok(false)
        );
        assert!(coordinator.rollback_candidate("intro failed"));
        assert_eq!(coordinator.status_json()["route"], "operator");
        assert!(coordinator.candidate_identity().is_none());
        assert!(!coordinator.is_candidate());
    }

    #[test]
    fn callbacks_require_the_current_leg_token_and_stale_work_is_rejected() {
        let coordinator = coordinator();
        assert_eq!(
            coordinator.accept_thinking_callback("wrong", "high"),
            Err(LifecycleError::StaleLeg)
        );
        let candidate =
            CandidateLeg::new("alpha", "alpha", "session", "candidate", "model", "medium");
        coordinator.begin_candidate(candidate).unwrap();
        assert_eq!(
            coordinator.accept_thinking_callback("old", "high"),
            Err(LifecycleError::StaleLeg)
        );
        coordinator.adopt_candidate().unwrap();
        assert_eq!(
            coordinator.accept_side_effect("candidate"),
            Err(LifecycleError::StaleLeg)
        );
        let operation = coordinator
            .begin_prompt(&coordinator.current_identity())
            .unwrap();
        assert!(coordinator.accept_side_effect("candidate").is_ok());
        coordinator.finish_operation(&operation);
        assert_eq!(
            coordinator.accept_thinking_callback("candidate", "high"),
            Ok(true)
        );
        assert_eq!(
            coordinator.accept_thinking_callback("candidate-old", "high"),
            Err(LifecycleError::StaleLeg)
        );
    }

    #[test]
    fn catalog_publication_matches_adoption_generation() {
        let catalog = ModelCatalog {
            entries: vec![CatalogEntry {
                provider: "anthropic".into(),
                model: "opus".into(),
                thinks: true,
            }],
            available: true,
            diagnostic: None,
        };
        let coordinator = coordinator();
        coordinator
            .begin_candidate(
                CandidateLeg::new(
                    "alpha",
                    "alpha",
                    "session",
                    "token",
                    "anthropic/opus",
                    "medium",
                )
                .with_catalog(catalog),
            )
            .unwrap();
        coordinator.adopt_candidate().unwrap();
        let status = coordinator.status_snapshot();
        assert!(status.is_catalog_current());
        assert_eq!(status.json()["models"][0]["model"], "opus");
    }

    #[test]
    fn populated_status_keeps_picker_catalog_when_lifecycle_cache_is_empty() {
        let coordinator = coordinator();
        coordinator.publish_status(json!({
            "type": "status",
            "route": "alpha",
            "models": [{"provider": "openai", "model": "gpt-5.6", "thinks": true}],
            "models_available": true
        }));
        assert_eq!(coordinator.status_json()["models"][0]["model"], "gpt-5.6");
        assert_eq!(coordinator.status_json()["models_available"], true);
    }

    #[test]
    fn status_read_does_not_wait_for_lifecycle_linearization() {
        let coordinator = Arc::new(coordinator());
        let held = Arc::clone(&coordinator);
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let entered_thread = Arc::clone(&entered);
        let release_thread = Arc::clone(&release);
        let worker = thread::spawn(move || {
            held.linearize(|_| {
                entered_thread.wait();
                release_thread.wait();
            });
        });
        entered.wait();
        assert_eq!(coordinator.status_json()["route"], "operator");
        release.wait();
        worker.join().unwrap();
    }
}

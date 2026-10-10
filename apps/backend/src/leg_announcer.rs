//! Announces each new leg to the browser: candidate promotion, pi activity,
//! and the route callback, with the once-per-leg scene reset they share.
use crate::app_state::AgentProjection;
use crate::delivery::{DeliveryState, Event};
use crate::display::{ConfirmState, DisplayGateState, SceneLeg};
use crate::lifecycle::{ActivityDisposition, Coordinator};
use crate::pi_client::Activity;
use crate::protocol::ServerMessage;
use crate::speech::{SpeechContinuity, SpeechGroup};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{broadcast, watch, Mutex};

/// Tells the browser the call has moved to a new leg.
///
/// A transfer is announced from two places: candidate promotion, when the
/// incoming agent first shows life or acts, and the route callback, when the
/// PBX finishes the transfer after the intro turn. Both hold one of these, and
/// both announce the leg the coordinator names. They are built before
/// `AppInner` exists, which is why this holds clones rather than the state.
#[derive(Clone)]
pub(crate) struct LegAnnouncer {
    pub(crate) coordinator: Coordinator,
    pub(crate) events: broadcast::Sender<Event>,
    pub(crate) delivery: DeliveryState,
    pub(crate) display_gate: Arc<Mutex<DisplayGateState>>,
    pub(crate) display_confirm: watch::Sender<ConfirmState>,
    pub(crate) last_display: Arc<Mutex<Option<Value>>>,
    pub(crate) projection: AgentProjection,
    pub(crate) continuity: Arc<StdMutex<SpeechContinuity>>,
    pub(crate) active_speech_group: Arc<StdMutex<Option<SpeechGroup>>>,
    pub(crate) foreground_audio_generation: Arc<StdMutex<Option<u64>>>,
}

impl LegAnnouncer {
    fn publish(&self, message: ServerMessage) {
        let event = Event::Json(message.to_value());
        let _ = self.events.send(event.clone());
        self.delivery.publish(event);
    }

    /// Adopts the candidate leg `token` names and announces it. False when
    /// that leg is not the one staged.
    pub(crate) async fn promote_candidate(&self, token: &str) -> bool {
        // Held from adoption until the epoch is out, so a display from the
        // new leg cannot be applied ahead of its own scene reset.
        let mut gate = self.display_gate.lock().await;
        let Ok(identity) = self.coordinator.adopt_candidate(token) else {
            return false;
        };
        let status = self.coordinator.status();
        self.begin_scene(
            &mut gate,
            SceneLeg {
                route: status.route.clone(),
                generation: identity.generation,
            },
        )
        .await;
        self.publish(ServerMessage::Status(status));
        true
    }

    /// RPC activity from a pi process. Only the leg on the line is shown, and
    /// only the starting candidate's own activity promotes it; anything else
    /// comes from a leg the call has left, or never joined, and is dropped.
    pub(crate) async fn on_activity(&self, activity: Activity) {
        let disposition = self.coordinator.classify_activity(&activity.leg);
        let current = match disposition {
            ActivityDisposition::Promote => self.promote_candidate(&activity.leg).await,
            ActivityDisposition::Publish => true,
            ActivityDisposition::Discard => false,
        };
        if !current {
            tracing::debug!(
                leg = %activity.leg,
                label = %activity.label,
                state = %activity.state,
                tool = %activity.tool,
                ?disposition,
                "dropping activity from a leg that is not on the line"
            );
            return;
        }
        if activity.state == "life" {
            return;
        }
        self.publish(ServerMessage::Activity {
            state: activity.state,
            tool: activity.tool,
            detail: activity.detail,
            label: activity.label,
        });
    }

    /// The route callback: the PBX has settled on a leg, which the
    /// coordinator names.
    pub(crate) async fn announce_route(&self) {
        let mut gate = self.display_gate.lock().await;
        let (route, generation) = self.coordinator.route_and_generation();
        self.begin_scene(&mut gate, SceneLeg { route, generation })
            .await;
        self.publish(ServerMessage::Status(self.coordinator.status()));
    }

    /// Clears the scene for `leg` and sends the epoch that tells the browser
    /// to do the same, once per leg. Whichever announcement arrives second
    /// finds the scene already belongs to that leg and leaves it alone: by
    /// then it may hold the new agent's first drawing, and the browser may be
    /// playing its first words.
    pub(crate) async fn begin_scene(&self, gate: &mut DisplayGateState, leg: SceneLeg) {
        if gate.scene_leg.as_ref() == Some(&leg) {
            tracing::debug!(route = %leg.route, generation = leg.generation, "leg already announced; restating its status only");
            return;
        }
        tracing::info!(route = %leg.route, generation = leg.generation, "the caller's screen moves to a new leg");
        let model = self.coordinator.status().model;
        self.continuity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear(leg.generation, &model);
        *self
            .active_speech_group
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .foreground_audio_generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        gate.projection.clear();
        gate.screen_state["stale"] = json!(true);
        gate.report_epoch = None;
        gate.report_generation = None;
        *self.last_display.lock().await = None;
        self.display_confirm
            .send_modify(|confirm| confirm.begin_generation(leg.generation));
        self.publish(ServerMessage::Epoch {
            generation: leg.generation,
        });
        gate.scene_leg = Some(leg.clone());
        if leg.route != crate::pbx::OPERATOR {
            if let Some(action) = self.projection.take_display(&leg.route) {
                let event = Event::Json(
                    ServerMessage::Display {
                        action: action.clone(),
                        seq: None,
                    }
                    .to_value(),
                );
                let (delivered, sequence) = self.delivery.publish_sequenced(event.clone());
                let _ = self.events.send(event);
                gate.projection.apply(&action, sequence);
                gate.watermark = sequence;
                *self.last_display.lock().await =
                    Some(ServerMessage::Display { action, seq: None }.to_value());
                tracing::info!(route = %leg.route, delivered, "released the final background display on foreground");
            }
        }
    }
}

#[cfg(test)]
#[path = "../tests/test_leg_announcer.rs"]
mod tests;

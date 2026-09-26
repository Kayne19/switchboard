//! The stage projection and its gate.
//!
//! `DisplayProjection` folds the agent's `display` actions into the objects,
//! order, focus, and speech a reconnecting browser replays; `DisplayGateState`
//! is what `api.rs` holds the projection behind, alongside the confirmation
//! channel (`ConfirmState`) and the leg a scene belongs to (`SceneLeg`). None
//! of it is async or generation-aware on its own -- `api.rs` checks the
//! coordinator's generation at the boundary and holds the gate's lock around
//! each apply.
use crate::delivery::Event;
use serde_json::{json, Value};
use std::collections::HashMap;

/// The most metrics the primary cluster holds; `MAX_PRIMARY_METRICS` in
/// apps/frontend/src/controller/reducer.ts. Keep the two equal.
pub(crate) const MAX_PRIMARY_METRICS: usize = 9;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct SceneObject {
    pub(crate) id: String,
    #[serde(rename = "type")]
    pub(crate) object_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) role: Option<String>,
    pub(crate) data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) primary_claimed_at: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct DisplaySpeech {
    pub(crate) text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) at: Option<Value>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct DisplayProjection {
    pub(crate) objects: HashMap<String, SceneObject>,
    pub(crate) order: Vec<String>,
    pub(crate) focus_id: Option<String>,
    pub(crate) speech: Option<DisplaySpeech>,
    pub(crate) watermark: u64,
}

impl DisplayProjection {
    pub(crate) fn apply(&mut self, action: &Value, sequence: u64) {
        self.watermark = sequence;
        let Some(op) = action.get("op").and_then(Value::as_str) else {
            return;
        };
        match op {
            "show" => {
                let Some(id) = action.get("id").and_then(Value::as_str) else {
                    return;
                };
                let Some(object_type) = action.get("type").and_then(Value::as_str) else {
                    return;
                };
                let role = action.get("role").and_then(Value::as_str).map(String::from);
                let data = action.get("data").cloned().unwrap_or(Value::Null);

                // Primary claimant semantics (#38), the same rule as the
                // browser's reducer (`withPrimaryClaimedBy`):
                // A metric claiming primary while metrics hold it joins them in a cluster.
                // A non-metric claim demotes all primary metrics.
                // A metric claim while a non-metric holds primary demotes the non-metric.
                // A metric claim that would grow the cluster past
                // MAX_PRIMARY_METRICS demotes its earliest claimant.
                // A primary that changes type claims the role again under its new type.
                // Removing one metric leaves the rest primary.
                // Cluster order is stable (claim order).
                let changes_primary_type = role.is_none()
                    && self.objects.get(id).is_some_and(|existing| {
                        existing.role.as_deref() == Some("primary")
                            && existing.object_type != object_type
                    });
                if role.as_deref() == Some("primary") || changes_primary_type {
                    self.demote_for_primary_claim(id, object_type == "metric");
                }

                if let Some(existing) = self.objects.get_mut(id) {
                    existing.object_type = object_type.to_string();
                    let was_primary = existing.role.as_deref() == Some("primary");
                    if let Some(ref new_role) = role {
                        if new_role == "primary" {
                            if !was_primary || existing.primary_claimed_at.is_none() {
                                existing.primary_claimed_at = Some(sequence);
                            }
                        } else {
                            existing.primary_claimed_at = None;
                        }
                        existing.role = role;
                    }
                    existing.data = data;
                } else {
                    let primary_claimed_at = if role.as_deref() == Some("primary") {
                        Some(sequence)
                    } else {
                        None
                    };
                    self.objects.insert(
                        id.to_string(),
                        SceneObject {
                            id: id.to_string(),
                            object_type: object_type.to_string(),
                            role,
                            data,
                            primary_claimed_at,
                        },
                    );
                    self.order.push(id.to_string());
                }
            }
            "hide" => {
                let Some(id) = action.get("id").and_then(Value::as_str) else {
                    return;
                };
                if self.objects.remove(id).is_some() {
                    self.order.retain(|item| item != id);
                    if self.focus_id.as_deref() == Some(id) {
                        self.focus_id = None;
                    }
                    if self.speech.as_ref().and_then(|s| s.target.as_deref()) == Some(id) {
                        self.speech = None;
                    }
                }
            }
            "focus" => {
                let Some(id) = action.get("id").and_then(Value::as_str) else {
                    return;
                };
                if self.objects.contains_key(id) {
                    self.focus_id = Some(id.to_string());
                } else {
                    self.focus_id = None;
                }
            }
            "say" => {
                let Some(text) = action.get("text").and_then(Value::as_str) else {
                    return;
                };
                let target = action
                    .get("target")
                    .and_then(Value::as_str)
                    .map(String::from);
                let at = action.get("at").filter(|v| !v.is_null()).cloned();
                self.speech = Some(DisplaySpeech {
                    text: text.to_string(),
                    target,
                    at,
                });
            }
            "clear" => self.clear(),
            _ => {}
        }
    }

    /// Demotes every primary the claim displaces to secondary: all of them
    /// for a non-metric claimant; for a metric, only non-metrics, plus the
    /// earliest cluster members when the cluster would exceed
    /// `MAX_PRIMARY_METRICS`.
    fn demote_for_primary_claim(&mut self, claimant: &str, is_metric: bool) {
        let mut displaced = Vec::new();
        let mut cluster = Vec::new();
        for object in self.objects.values() {
            if object.id == claimant || object.role.as_deref() != Some("primary") {
                continue;
            }
            if is_metric && object.object_type == "metric" {
                cluster.push(object);
            } else {
                displaced.push(object.id.clone());
            }
        }
        cluster.sort_by_key(|object| self.claim_order_key(object));
        let overflow = cluster.len().saturating_sub(MAX_PRIMARY_METRICS - 1);
        displaced.extend(cluster[..overflow].iter().map(|object| object.id.clone()));
        for id in displaced {
            if let Some(object) = self.objects.get_mut(&id) {
                object.role = Some("secondary".to_string());
                object.primary_claimed_at = None;
            }
        }
    }

    fn claim_order_key(&self, object: &SceneObject) -> (u64, usize) {
        (
            object.primary_claimed_at.unwrap_or(u64::MAX),
            self.order
                .iter()
                .position(|id| id == &object.id)
                .unwrap_or(usize::MAX),
        )
    }

    /// The primary objects, earliest claim first.
    fn primaries_in_claim_order(&self) -> Vec<&SceneObject> {
        let mut primaries: Vec<&SceneObject> = self
            .objects
            .values()
            .filter(|object| object.role.as_deref() == Some("primary"))
            .collect();
        primaries.sort_by_key(|object| self.claim_order_key(object));
        primaries
    }

    pub(crate) fn clear(&mut self) {
        self.objects.clear();
        self.order.clear();
        self.focus_id = None;
        self.speech = None;
    }

    pub(crate) fn snapshot_actions(&self) -> Vec<Value> {
        let mut actions = Vec::new();
        let show = |obj: &SceneObject, role: Option<&str>| {
            let mut map = serde_json::Map::new();
            map.insert("op".into(), "show".into());
            map.insert("id".into(), obj.id.clone().into());
            map.insert("type".into(), obj.object_type.clone().into());
            if let Some(r) = role {
                map.insert("role".into(), r.into());
            }
            map.insert("data".into(), obj.data.clone());
            Value::Object(map)
        };

        // A reconnecting browser rebuilds its stage from these shows, so they
        // must reproduce two orders: the show order (its `agentOrder`, which
        // lays out the rail and picks the fallback primary) and the claim
        // order of the primaries (the metric cluster's order). Every object
        // is replayed in show order. A primary carries its role there only
        // while the primaries met so far are also in claim order; the rest
        // are replayed without a role and then claim it, in claim order.
        let claim_order = self.primaries_in_claim_order();
        let mut claimed_inline = 0;
        for id in &self.order {
            let Some(obj) = self.objects.get(id) else {
                continue;
            };
            if obj.role.as_deref() != Some("primary") {
                actions.push(show(obj, obj.role.as_deref()));
            } else if claim_order.get(claimed_inline).map(|next| &next.id) == Some(id) {
                claimed_inline += 1;
                actions.push(show(obj, Some("primary")));
            } else {
                actions.push(show(obj, None));
            }
        }
        for obj in &claim_order[claimed_inline..] {
            actions.push(show(obj, Some("primary")));
        }
        if let Some(focus_id) = &self.focus_id {
            actions.push(json!({"op": "focus", "id": focus_id}));
        }
        if let Some(speech) = &self.speech {
            let mut map = serde_json::Map::new();
            map.insert("op".into(), "say".into());
            map.insert("text".into(), speech.text.clone().into());
            if let Some(t) = &speech.target {
                map.insert("target".into(), t.clone().into());
            }
            if let Some(at) = &speech.at {
                map.insert("at".into(), at.clone());
            } else {
                map.insert("at".into(), Value::Null);
            }
            actions.push(Value::Object(map));
        }
        actions
    }

    // Mirrors the browser's `buildCompositionModel` in
    // apps/frontend/src/app/sceneModel.ts exactly: the reporting object is
    // the focused object if one is set and still on stage, else the
    // composition primary -- the earliest claimant among the objects with
    // role:"primary" (`apply` leaves either one non-metric or a cluster of
    // metrics holding it), else the first non-ambient object, else the first
    // object overall. Keep the two in lockstep; see docs/visual-channel.md.
    fn composition_primary(&self) -> Option<&SceneObject> {
        if let Some(first) = self.primaries_in_claim_order().first() {
            return Some(first);
        }
        self.order
            .iter()
            .filter_map(|id| self.objects.get(id))
            .find(|object| object.role.as_deref() != Some("ambient"))
            .or_else(|| self.order.iter().find_map(|id| self.objects.get(id)))
    }

    pub(crate) fn summary(&self) -> (bool, Option<String>, Option<String>, Vec<String>) {
        let has_visual = !self.order.is_empty();
        let focused = self.focus_id.as_ref().and_then(|id| self.objects.get(id));
        let primary = focused.or_else(|| self.composition_primary());
        let kind = primary.map(|o| o.object_type.clone());
        let title = primary.and_then(|o| {
            o.data
                .get("title")
                .or_else(|| o.data.get("subject"))
                .or_else(|| o.data.get("label"))
                .and_then(Value::as_str)
                .map(String::from)
        });
        (has_visual, kind, title, self.order.clone())
    }
}

/// The leg a scene belongs to. A transfer changes the generation; a return
/// to the operator keeps it and changes the route, so neither alone names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SceneLeg {
    pub(crate) route: String,
    pub(crate) generation: u64,
}

pub(crate) struct DisplayGateState {
    pub(crate) projection: DisplayProjection,
    pub(crate) screen_state: Value,
    pub(crate) active_epoch: Option<u64>,
    pub(crate) report_epoch: Option<u64>,
    pub(crate) report_generation: Option<u64>,
    /// The leg the projection was last reset for; `None` until one is
    /// announced.
    pub(crate) scene_leg: Option<SceneLeg>,
    pub(crate) watermark: u64,
}

#[derive(Clone, Default)]
pub(crate) struct ConfirmState {
    pub(crate) generation: u64,
    // `None` means "the browser has not confirmed anything in this
    // generation yet" -- distinct from confirming sequence 0, which is a
    // real, reachable sequence number.
    pub(crate) watermark: Option<u64>,
    pub(crate) rejection: Option<(u64, String)>,
}

pub(crate) const DISPLAY_CONFIRM_DEADLINE_MS: u64 = 2500;

pub(crate) fn is_display_event(event: &Event) -> bool {
    match event {
        Event::Json(v) => v.get("type").and_then(Value::as_str) == Some("display"),
        _ => false,
    }
}

pub(crate) fn stamp_display_seq(event: Event, sequence: u64) -> Event {
    match event {
        Event::Json(mut value) => {
            if value.get("type").and_then(Value::as_str) == Some("display") {
                if let Some(map) = value.as_object_mut() {
                    map.insert("seq".into(), json!(sequence));
                }
            }
            Event::Json(value)
        }
        other => other,
    }
}

#[cfg(test)]
#[path = "../tests/test_display.rs"]
mod tests;

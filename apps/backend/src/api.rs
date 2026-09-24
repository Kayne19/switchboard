//! HTTP, WebSocket and application workers.
use crate::audio::{Speaker, StreamResult, SttAdapter, SttStreamAdapter};
use crate::history::{TranscriptLog, AGENT, CALLER};
use crate::lifecycle::Coordinator;
use crate::pbx::{ActivityClock, LiveLegState, RouteCallback, Switchboard};
use crate::pi_client::{Activity, ActivityCallback, PiSession};
use axum::extract::ws::{Message, WebSocket};
use axum::{
    extract::{DefaultBodyLimit, State, WebSocketUpgrade},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
use tokio::sync::{broadcast, mpsc, oneshot, watch, Mutex};
use tokio::task::{AbortHandle, Id as TaskId, JoinHandle};
use tower_http::services::ServeDir;

const MAX_WEBSOCKET_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// The most metrics the primary cluster holds; `MAX_PRIMARY_METRICS` in
/// apps/frontend/src/controller/reducer.ts. Keep the two equal.
pub const MAX_PRIMARY_METRICS: usize = 6;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SceneObject {
    pub id: String,
    #[serde(rename = "type")]
    pub object_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    pub data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_claimed_at: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DisplaySpeech {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<Value>,
}

#[derive(Debug, Clone, Default)]
pub struct DisplayProjection {
    pub objects: HashMap<String, SceneObject>,
    pub order: Vec<String>,
    pub focus_id: Option<String>,
    pub speech: Option<DisplaySpeech>,
    pub watermark: u64,
}

impl DisplayProjection {
    pub fn apply(&mut self, action: &Value, sequence: u64) {
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

    pub fn clear(&mut self) {
        self.objects.clear();
        self.order.clear();
        self.focus_id = None;
        self.speech = None;
    }

    pub fn snapshot_actions(&self) -> Vec<Value> {
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

    pub fn summary(&self) -> (bool, Option<String>, Option<String>, Vec<String>) {
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
pub struct SceneLeg {
    pub route: String,
    pub generation: u64,
}

pub struct DisplayGateState {
    pub projection: DisplayProjection,
    pub screen_state: Value,
    pub active_epoch: Option<u64>,
    pub report_epoch: Option<u64>,
    pub report_generation: Option<u64>,
    /// The leg the projection was last reset for; `None` until one is
    /// announced.
    pub scene_leg: Option<SceneLeg>,
    pub watermark: u64,
}

#[derive(Clone, Default)]
pub struct ConfirmState {
    pub generation: u64,
    // `None` means "the browser has not confirmed anything in this
    // generation yet" -- distinct from confirming sequence 0, which is a
    // real, reachable sequence number.
    pub watermark: Option<u64>,
    pub rejection: Option<(u64, String)>,
}

const DISPLAY_CONFIRM_DEADLINE_MS: u64 = 2500;

fn is_display_event(event: &Event) -> bool {
    match event {
        Event::Json(v) => v.get("type").and_then(Value::as_str) == Some("display"),
        _ => false,
    }
}

fn stamp_display_seq(event: Event, sequence: u64) -> Event {
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

/// Tells the browser the call has moved to a new leg.
///
/// A transfer is announced from two places: candidate promotion, when the
/// incoming agent first shows life or acts, and the route callback, when the
/// PBX finishes the transfer after the intro turn. Both hold one of these.
/// They are built before `AppInner` exists, which is why this holds clones
/// rather than the state.
#[derive(Clone)]
struct LegAnnouncer {
    coordinator: Coordinator,
    live_leg: LiveLegState,
    events: broadcast::Sender<Event>,
    delivery: DeliveryState,
    display_gate: Arc<Mutex<DisplayGateState>>,
    display_confirm: watch::Sender<ConfirmState>,
    last_display: Arc<Mutex<Option<Value>>>,
}

impl LegAnnouncer {
    fn publish(&self, event: Event) {
        let _ = self.events.send(event.clone());
        self.delivery.publish(event);
    }

    /// Adopts the candidate leg and announces it. False when there was no
    /// candidate to adopt.
    async fn promote_candidate(&self) -> bool {
        // Held from adoption until the epoch is out, so a display from the
        // new leg cannot be applied ahead of its own scene reset.
        let mut gate = self.display_gate.lock().await;
        let Ok(identity) = self.coordinator.adopt_candidate() else {
            return false;
        };
        let status = self.coordinator.status_json();
        let route = status["route"]
            .as_str()
            .unwrap_or(crate::pbx::OPERATOR)
            .to_owned();
        self.live_leg.set_session(
            &route,
            if route == crate::pbx::OPERATOR {
                ""
            } else {
                &identity.token
            },
        );
        self.begin_scene(
            &mut gate,
            SceneLeg {
                route,
                generation: identity.generation,
            },
        )
        .await;
        self.publish(Event::Json(status));
        true
    }

    /// The route callback: the PBX has settled on a leg.
    async fn announce_route(&self, status: Value) {
        let route = status["route"]
            .as_str()
            .unwrap_or(crate::pbx::OPERATOR)
            .to_owned();
        let mut gate = self.display_gate.lock().await;
        let generation = self.coordinator.generation();
        self.begin_scene(&mut gate, SceneLeg { route, generation })
            .await;
        self.coordinator.publish_status(status.clone());
        self.publish(Event::Json(status));
    }

    /// Clears the scene for `leg` and sends the epoch that tells the browser
    /// to do the same, once per leg. Whichever announcement arrives second
    /// finds the scene already belongs to that leg and leaves it alone: by
    /// then it may hold the new agent's first drawing, and the browser may be
    /// playing its first words.
    async fn begin_scene(&self, gate: &mut DisplayGateState, leg: SceneLeg) {
        if gate.scene_leg.as_ref() == Some(&leg) {
            tracing::debug!(route = %leg.route, generation = leg.generation, "leg already announced; restating its status only");
            return;
        }
        tracing::info!(route = %leg.route, generation = leg.generation, "the caller's screen moves to a new leg");
        gate.projection.clear();
        gate.screen_state["stale"] = json!(true);
        gate.report_epoch = None;
        gate.report_generation = None;
        *self.last_display.lock().await = None;
        self.display_confirm.send_modify(|confirm| {
            confirm.generation = leg.generation;
            confirm.watermark = None;
            confirm.rejection = None;
        });
        self.publish(Event::Json(json!({
            "type": "epoch",
            "generation": leg.generation,
        })));
        gate.scene_leg = Some(leg);
    }
}

#[derive(Clone)]
pub struct AppState(pub Arc<AppInner>);
pub struct AppInner {
    pub switchboard: Mutex<Switchboard>,
    delivery: DeliveryState,
    pub transcript_log: Mutex<TranscriptLog>,
    pub speaker: Speaker,
    pub stt: SttAdapter,
    pub stt_stream: SttStreamAdapter,
    pub events: broadcast::Sender<Event>,
    pub coordinator: Coordinator,
    speech: mpsc::Sender<SpeechRequest>,
    speech_rx: Mutex<Option<mpsc::Receiver<SpeechRequest>>>,
    clips: mpsc::Sender<Clip>,
    clip_rx: Mutex<Option<mpsc::Receiver<Clip>>>,
    pub turns: mpsc::Sender<(String, String, u64)>,
    turn_rx: Mutex<Option<mpsc::Receiver<(String, String, u64)>>>,
    pub accepted_clips: Mutex<(HashSet<String>, VecDeque<String>)>,
    stream_clips: Mutex<HashMap<String, StreamClipState>>,
    pub last_display: Arc<Mutex<Option<Value>>>,
    pub screen_state: Mutex<Value>,
    pub display_gate: Arc<Mutex<DisplayGateState>>,
    pub display_confirm: watch::Sender<ConfirmState>,
    pub active_session: Arc<Mutex<Option<PiSession>>>,
    activity_clock: ActivityClock,
    live_leg: LiveLegState,
    leg_announcer: LegAnnouncer,
    operation_transition: Mutex<()>,
    active_operations: Mutex<HashMap<TaskId, AbortHandle>>,
    pub queued_turns: AtomicU64,
    pub turn_in_flight: AtomicBool,
    shutdown: watch::Sender<bool>,
    audio: Mutex<AudioQueue>,
    speech_deadline: std::time::Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StreamClipState {
    Open {
        generation: u64,
        next_sequence: u64,
        connection: u64,
    },
    Ended {
        generation: u64,
        connection: u64,
    },
    Cancelled,
    Abandoned,
    Finalized,
}

#[derive(Clone, Debug)]
pub enum Event {
    Json(Value),
    AudioStart {
        generation: u64,
        sequence: u64,
        mime: String,
        format: String,
    },
    AudioChunk {
        audio: Vec<u8>,
        generation: u64,
        sequence: u64,
    },
    AudioDone {
        generation: u64,
        sequence: u64,
    },
}
struct SpeechRequest {
    text: String,
    generation: u64,
    sequence: u64,
    deadline: std::time::Instant,
    result: oneshot::Sender<Result<(), String>>,
}

const DELIVERY_QUEUE: usize = 256;

#[derive(Clone)]
struct DeliveryState {
    next_epoch: Arc<AtomicU64>,
    next_sequence: Arc<AtomicU64>,
    active_epoch: Arc<AtomicU64>,
    connections: Arc<std::sync::Mutex<HashMap<u64, mpsc::Sender<DeliveryFrame>>>>,
}

#[derive(Debug)]
pub enum DeliveryFrame {
    Event { sequence: u64, event: Event },
    Message(Message),
}

pub struct DeliveryConnection {
    pub epoch: u64,
    pub receiver: mpsc::Receiver<DeliveryFrame>,
}

impl DeliveryState {
    fn new() -> Self {
        Self {
            next_epoch: Arc::new(AtomicU64::new(1)),
            next_sequence: Arc::new(AtomicU64::new(0)),
            active_epoch: Arc::new(AtomicU64::new(0)),
            connections: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    fn register(&self) -> DeliveryConnection {
        let epoch = self.next_epoch.fetch_add(1, Ordering::Relaxed);
        self.active_epoch.store(epoch, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel(DELIVERY_QUEUE);
        self.connections.lock().unwrap().insert(epoch, sender);
        DeliveryConnection { epoch, receiver }
    }

    fn retire(&self, epoch: u64) {
        self.connections.lock().unwrap().remove(&epoch);
        let _ = self
            .active_epoch
            .compare_exchange(epoch, 0, Ordering::Relaxed, Ordering::Relaxed);
    }

    fn active_epoch(&self) -> Option<u64> {
        let ep = self.active_epoch.load(Ordering::Relaxed);
        if ep == 0 {
            None
        } else {
            Some(ep)
        }
    }

    fn publish_sequenced(&self, event: Event) -> (bool, u64) {
        let sequence = self.next_sequence.fetch_add(1, Ordering::Relaxed);
        let mut delivered = false;
        let mut dead = Vec::new();
        let connections = self.connections.lock().unwrap();
        for (&epoch, sender) in connections.iter() {
            match sender.try_send(DeliveryFrame::Event {
                sequence,
                event: event.clone(),
            }) {
                Ok(()) => delivered = true,
                Err(_) => dead.push(epoch),
            }
        }
        drop(connections);
        if !dead.is_empty() {
            let mut connections = self.connections.lock().unwrap();
            for epoch in dead {
                connections.remove(&epoch);
            }
        }
        (delivered, sequence)
    }

    fn publish(&self, event: Event) -> bool {
        self.publish_sequenced(event).0
    }

    fn send(&self, epoch: u64, message: Message) -> bool {
        self.connections
            .lock()
            .unwrap()
            .get(&epoch)
            .is_some_and(|sender| sender.try_send(DeliveryFrame::Message(message)).is_ok())
    }

    fn connected(&self) -> bool {
        !self.connections.lock().unwrap().is_empty()
    }
}
struct AudioSlot {
    generation: u64,
    events: Vec<Event>,
    started: bool,
    done: bool,
}
struct AudioQueue {
    next: u64,
    emit: u64,
    slots: BTreeMap<u64, AudioSlot>,
}
impl AudioQueue {
    fn new() -> Self {
        Self {
            next: 0,
            emit: 0,
            slots: BTreeMap::new(),
        }
    }
    fn reserve(&mut self, generation: u64) -> u64 {
        let sequence = self.next;
        self.next += 1;
        self.slots.insert(
            sequence,
            AudioSlot {
                generation,
                events: Vec::new(),
                started: false,
                done: false,
            },
        );
        sequence
    }
    fn start(&mut self, sequence: u64, generation: u64) -> Vec<Event> {
        let Some(slot) = self.slots.get_mut(&sequence) else {
            return Vec::new();
        };
        if slot.generation == generation && !slot.started {
            slot.started = true;
            slot.events.push(Event::AudioStart {
                generation,
                sequence,
                mime: "audio/mpeg".into(),
                format: "mp3".into(),
            });
        }
        self.drain_ready()
    }
    fn append(&mut self, sequence: u64, generation: u64, audio: Vec<u8>) -> Vec<Event> {
        let Some(slot) = self.slots.get_mut(&sequence) else {
            return Vec::new();
        };
        if slot.generation == generation && !audio.is_empty() {
            slot.events.push(Event::AudioChunk {
                audio,
                generation,
                sequence,
            });
        }
        self.drain_ready()
    }
    fn cancel(&mut self, sequence: u64, generation: u64) -> Vec<Event> {
        self.finish(sequence, generation)
    }
    fn barrier(&mut self, sequence: u64, generation: u64, value: Value) -> Vec<Event> {
        let Some(slot) = self.slots.get_mut(&sequence) else {
            return Vec::new();
        };
        if slot.generation == generation && !slot.done {
            slot.events.push(Event::Json(value));
            slot.done = true;
        }
        self.drain_ready()
    }
    fn finish(&mut self, sequence: u64, generation: u64) -> Vec<Event> {
        let Some(slot) = self.slots.get_mut(&sequence) else {
            return Vec::new();
        };
        if slot.generation == generation {
            if !slot.started {
                slot.started = true;
                slot.events.push(Event::AudioStart {
                    generation,
                    sequence,
                    mime: "audio/mpeg".into(),
                    format: "mp3".into(),
                });
            }
            if !slot.done {
                slot.events.push(Event::AudioDone {
                    generation,
                    sequence,
                });
            }
        }
        slot.done = true;
        self.drain_ready()
    }
    fn drain_ready(&mut self) -> Vec<Event> {
        let mut ready = Vec::new();
        while self.slots.contains_key(&self.emit) {
            let done = {
                let slot = self.slots.get_mut(&self.emit).expect("audio slot exists");
                ready.append(&mut slot.events);
                slot.done
            };
            if !done {
                break;
            }
            self.slots.remove(&self.emit);
            self.emit += 1;
        }
        ready
    }
    fn clear(&mut self) {
        self.slots.clear();
        self.emit = self.next;
    }
}

#[derive(Debug)]
pub struct Clip {
    id: String,
    audio: Vec<u8>,
    _mime: String,
    // Stamped when the clip is accepted, not when its transcript comes back.
    // Transcription is a sidecar round trip, and a page transfer can land
    // inside it; without this the reply epoch would be read after the rescue
    // and pre-rescue speech would count as current.
    generation: u64,
}

impl AppState {
    pub async fn register_connection(&self) -> (DeliveryConnection, Vec<Value>, u64) {
        let mut gate = self.0.display_gate.lock().await;
        let connection = self.0.delivery.register();
        let epoch = connection.epoch;
        gate.active_epoch = Some(epoch);
        gate.screen_state["stale"] = json!(true);
        *self.0.screen_state.lock().await = gate.screen_state.clone();
        let snapshot_actions = gate.projection.snapshot_actions();
        let watermark = gate.watermark;
        (connection, snapshot_actions, watermark)
    }

    pub async fn retire_connection(&self, epoch: u64) {
        {
            let mut gate = self.0.display_gate.lock().await;
            if gate.active_epoch == Some(epoch) || gate.active_epoch.is_none() {
                gate.active_epoch = None;
                gate.screen_state["stale"] = json!(true);
                *self.0.screen_state.lock().await = gate.screen_state.clone();
            }
        }
        self.0.delivery.retire(epoch);
    }

    pub fn new(
        switchboard: Switchboard,
        transcript_log: TranscriptLog,
        speaker: Speaker,
        stt: SttAdapter,
    ) -> Self {
        Self::new_with_stream(
            switchboard,
            transcript_log,
            speaker,
            stt,
            SttStreamAdapter::from_env(),
        )
    }

    pub fn new_with_stream(
        switchboard: Switchboard,
        transcript_log: TranscriptLog,
        speaker: Speaker,
        stt: SttAdapter,
        stt_stream: SttStreamAdapter,
    ) -> Self {
        let (events, _) = broadcast::channel(256);
        let (speech, speech_rx) = mpsc::channel(64);
        // Audio frames may be up to the WebSocket limit. A small bounded queue
        // prevents a stalled decoder from retaining roughly a gigabyte of
        // accepted clips while still leaving ample room for one caller's
        // retransmit/burst behavior.
        let (clips, clip_rx) = mpsc::channel(8);
        let (turns, turn_rx) = mpsc::channel(64);
        let (shutdown, _) = watch::channel(false);
        let last_display = Arc::new(Mutex::new(None));
        let delivery = DeliveryState::new();
        let speech_deadline = speaker.speech_deadline;
        let mut coordinator = Coordinator::new(switchboard.status());
        let live_leg = switchboard.live_leg_state();
        let display_gate = Arc::new(Mutex::new(DisplayGateState {
            projection: DisplayProjection::default(),
            screen_state: json!({
                "view": "auto",
                "pinned": false,
                "has_visual": false,
                "visual_kind": Value::Null,
                "object_ids": [],
                "title": "",
                "stale": false,
                "generation": 0,
            }),
            active_epoch: None,
            report_epoch: None,
            report_generation: None,
            scene_leg: None,
            watermark: 0,
        }));
        let (display_confirm_tx, _) = watch::channel(ConfirmState::default());
        let leg_announcer = LegAnnouncer {
            coordinator: coordinator.clone(),
            live_leg: live_leg.clone(),
            events: events.clone(),
            delivery: delivery.clone(),
            display_gate: display_gate.clone(),
            display_confirm: display_confirm_tx.clone(),
            last_display: last_display.clone(),
        };
        let activity_events = events.clone();
        let activity_delivery = delivery.clone();
        let activity_announcer = leg_announcer.clone();
        let activity_callback: ActivityCallback = Arc::new(move |activity: Activity| {
            let events = activity_events.clone();
            let delivery = activity_delivery.clone();
            let announcer = activity_announcer.clone();
            Box::pin(async move {
                if announcer.coordinator.is_candidate() {
                    let _ = announcer.promote_candidate().await;
                }
                if activity.state == "life" {
                    return;
                }
                let event = Event::Json(json!({
                    "type": "activity",
                    "state": activity.state,
                    "tool": activity.tool,
                    "detail": activity.detail,
                    "label": activity.label,
                }));
                let _ = events.send(event.clone());
                delivery.publish(event);
            })
        });
        let candidate_events = events.clone();
        let candidate_delivery = delivery.clone();
        coordinator.set_candidate_callback(Arc::new(
            move |notice: &crate::lifecycle::CandidateNotice| {
                // The callback fires under the coordinator's lock: publish
                // non-blockingly and never re-enter the coordinator here.
                let event = Event::Json(if notice.active {
                    json!({
                        "type": "candidate",
                        "route": notice.route,
                        "generation": notice.generation,
                    })
                } else {
                    json!({
                        "type": "candidate_cleared",
                        "generation": notice.generation,
                    })
                });
                let _ = candidate_events.send(event.clone());
                candidate_delivery.publish(event);
            },
        ));
        let route_announcer = leg_announcer.clone();
        let route_callback: RouteCallback = Arc::new(move |status| {
            let announcer = route_announcer.clone();
            Box::pin(async move { announcer.announce_route(status).await })
        });
        let active_session = switchboard.session_control();
        let activity_clock = switchboard.activity_clock();
        let mut switchboard = switchboard;
        switchboard.set_coordinator(coordinator.clone());
        switchboard.set_activity_callback(Some(activity_callback));
        switchboard.set_route_callback(Some(route_callback));
        Self(Arc::new(AppInner {
            switchboard: Mutex::new(switchboard),
            delivery,
            transcript_log: Mutex::new(transcript_log),
            speaker,
            stt,
            stt_stream,
            events,
            coordinator,
            speech,
            speech_rx: Mutex::new(Some(speech_rx)),
            clips,
            clip_rx: Mutex::new(Some(clip_rx)),
            turns,
            turn_rx: Mutex::new(Some(turn_rx)),
            accepted_clips: Mutex::new((HashSet::new(), VecDeque::new())),
            stream_clips: Mutex::new(HashMap::new()),
            last_display,
            screen_state: Mutex::new(json!({
                "view": "auto",
                "pinned": false,
                "has_visual": false,
                "visual_kind": Value::Null,
                "object_ids": [],
                "title": "",
                "stale": false,
                "generation": 0,
            })),
            display_gate,
            display_confirm: display_confirm_tx,
            active_session,
            activity_clock,
            live_leg,
            leg_announcer,
            operation_transition: Mutex::new(()),
            active_operations: Mutex::new(HashMap::new()),
            queued_turns: AtomicU64::new(0),
            turn_in_flight: AtomicBool::new(false),
            shutdown,
            audio: Mutex::new(AudioQueue::new()),
            speech_deadline,
        }))
    }
    pub fn router(self, static_dir: Option<ServeDir>) -> Router {
        let router = Router::new()
            .route("/healthz", get(healthz))
            .route("/status", get(status))
            .route("/hangup", post(hangup))
            .route("/connect", post(connect))
            .route("/thinking", post(thinking))
            .route("/model", post(model))
            .route("/leg-state", post(leg_state))
            .route("/speak", post(speak))
            .route(
                "/display",
                post(display).layer(DefaultBodyLimit::max(64 * 1024)),
            )
            .route("/view", post(view).layer(DefaultBodyLimit::max(16 * 1024)))
            .route("/ws", get(ws))
            .with_state(self);
        if let Some(service) = static_dir {
            router.fallback_service(service)
        } else {
            router
        }
    }
}

pub fn spawn_workers(state: AppState) {
    let stream_state = state.clone();
    tokio::spawn(async move {
        process_stream_results(stream_state).await;
    });
    let speech_state = state.clone();
    tokio::spawn(async move {
        process_speech(speech_state).await;
    });
    let clip_state = state.clone();
    tokio::spawn(async move {
        process_clips(clip_state).await;
    });
    tokio::spawn(async move {
        process_turns(state).await;
    });
}
pub async fn shutdown(state: &AppState) {
    // Linearize shutdown before cancellation so late callbacks and deliveries
    // fail closed while the process resources are being reaped.
    if !state.0.coordinator.begin_shutdown() {
        return;
    }
    // Close upgraded WebSockets as well as the PBX children. Axum's graceful
    // shutdown waits for upgraded connections, so merely stopping the listener
    // can otherwise leave systemd waiting on a browser tab indefinitely.
    state.0.shutdown.send_replace(true);
    interrupt_active_turn(state).await;
    state.0.switchboard.lock().await.shutdown().await;
    state.0.coordinator.finish_shutdown();
}
pub fn spawn_idle_worker(state: AppState, idle_timeout: f64, poll_seconds: f64) {
    if idle_timeout <= 0.0 {
        return;
    }
    tokio::spawn(async move {
        let poll = tokio::time::Duration::from_secs_f64(poll_seconds.max(1.0));
        let mut shutdown = state.0.shutdown.subscribe();
        loop {
            tokio::select! {
                _ = tokio::time::sleep(poll) => {}
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        return;
                    }
                    continue;
                }
            }
            if state
                .0
                .coordinator
                .return_if_idle(std::time::Duration::from_secs_f64(idle_timeout))
                .is_some()
            {
                let mut board = state.0.switchboard.lock().await;
                let left = board.force_hangup().await;
                let route = board.route().to_owned();
                drop(board);
                let Some(left) = left else { continue };
                let minutes = (idle_timeout / 60.0).floor() as u64;
                emit_json(
                    &state,
                    json!({"type":"epoch", "generation":state.0.coordinator.generation()}),
                );
                if let Some(entry) = state.0.transcript_log.lock().await.add(AGENT, &format!("Nothing was said for {minutes} minutes, so the line to {left} was dropped. You're back with the operator."), route) {
                    emit_json(&state, json!({"type":"spoken", "entry":entry}));
                }
                publish_status(&state, current_status(&state));
            }
        }
    });
}
fn emit(state: &AppState, event: Event) -> bool {
    let browser_delivered = state.0.delivery.publish(event.clone());
    let _ = state.0.events.send(event);
    browser_delivered
}
fn emit_json(state: &AppState, value: Value) -> bool {
    emit(state, Event::Json(value))
}
fn current_status(state: &AppState) -> Value {
    state.0.coordinator.status_json()
}
fn publish_status(state: &AppState, status: Value) {
    state.0.coordinator.publish_status(status.clone());
    emit_json(state, status);
}

async fn promote_candidate_for_token(state: &AppState, token: &str) {
    if state
        .0
        .coordinator
        .candidate_identity()
        .is_some_and(|candidate| candidate.token == token)
    {
        let _ = state.0.leg_announcer.promote_candidate().await;
    }
}

async fn spawn_active_operation<F, T>(
    state: &AppState,
    future: F,
) -> Option<(JoinHandle<T>, TaskId, u64)>
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let generation = state.0.coordinator.generation();
    let (task, id) = spawn_registered_operation(state, generation, future).await?;
    Some((task, id, generation))
}
async fn spawn_registered_operation<F, T>(
    state: &AppState,
    generation: u64,
    future: F,
) -> Option<(JoinHandle<T>, TaskId)>
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    // The generation check and registry insertion share the registry lock. A
    // rescue that bumps the generation before this point rejects spawning;
    // one that races after the check waits for the inserted abort handle.
    let mut active = state.0.active_operations.lock().await;
    if state.0.coordinator.generation() != generation {
        return None;
    }
    let task = tokio::spawn(future);
    let abort = task.abort_handle();
    let id = abort.id();
    active.insert(id, abort);
    Some((task, id))
}
async fn clear_active_operation(state: &AppState, id: TaskId) {
    state.0.active_operations.lock().await.remove(&id);
}

async fn reserve_audio(state: &AppState, generation: u64) -> Option<u64> {
    let mut audio = state.0.audio.lock().await;
    if generation != state.0.coordinator.generation() || audio.slots.len() >= 64 {
        return None;
    }
    Some(audio.reserve(generation))
}
async fn publish_audio_events(state: &AppState, events: Vec<Event>) -> bool {
    let mut delivered = false;
    for event in events {
        delivered |= emit(state, event);
    }
    delivered
}
async fn start_audio(state: &AppState, sequence: u64, generation: u64) -> bool {
    let events = {
        let mut audio = state.0.audio.lock().await;
        audio.start(sequence, generation)
    };
    publish_audio_events(state, events).await
}
async fn append_audio(state: &AppState, sequence: u64, generation: u64, bytes: Vec<u8>) -> bool {
    let events = {
        let mut audio = state.0.audio.lock().await;
        audio.append(sequence, generation, bytes)
    };
    publish_audio_events(state, events).await
}
async fn finish_audio(state: &AppState, sequence: u64, generation: u64, bytes: Vec<u8>) -> bool {
    let (events, current) = {
        let mut audio = state.0.audio.lock().await;
        let current = generation == state.0.coordinator.generation();
        let events = if current {
            let mut events = audio.append(sequence, generation, bytes);
            events.extend(audio.finish(sequence, generation));
            events
        } else {
            audio.cancel(sequence, generation)
        };
        (events, current)
    };
    publish_audio_events(state, events).await && current
}

async fn synthesize_audio_stream(
    state: &AppState,
    text: &str,
    sequence: u64,
    generation: u64,
    deadline: std::time::Instant,
) -> Result<(usize, bool), crate::audio::AudioError> {
    let mut delivered = start_audio(state, sequence, generation).await;
    let mut bytes = 0usize;
    let mut stream = state.0.speaker.stream_until(text, deadline).await?;
    while let Some(chunk) = stream.next().await {
        if generation != state.0.coordinator.generation() {
            return Err(crate::audio::AudioError::Tts(
                "speech generation was superseded".into(),
            ));
        }
        let chunk = chunk?;
        bytes = bytes.saturating_add(chunk.len());
        for part in chunk.chunks(32 * 1024) {
            delivered |= append_audio(state, sequence, generation, part.to_vec()).await;
        }
    }
    delivered |= finish_audio(state, sequence, generation, Vec::new()).await;
    Ok((bytes, delivered))
}

async fn process_speech(state: AppState) {
    let mut receiver = state
        .0
        .speech_rx
        .lock()
        .await
        .take()
        .expect("speech worker started once");
    while let Some(request) = receiver.recv().await {
        let SpeechRequest {
            text,
            generation,
            sequence,
            deadline,
            result,
        } = request;
        state.0.coordinator.touch_activity();
        let started = std::time::Instant::now();
        let operation_state = state.clone();
        let operation_text = text.clone();
        let synthesized = match spawn_registered_operation(&state, generation, async move {
            synthesize_audio_stream(
                &operation_state,
                &operation_text,
                sequence,
                generation,
                deadline,
            )
            .await
        })
        .await
        {
            Some((task, id)) => {
                let result = match task.await {
                    Ok(result) => result,
                    Err(error) if error.is_cancelled() => {
                        Err(crate::audio::AudioError::Tts("speech was cancelled".into()))
                    }
                    Err(error) => Err(crate::audio::AudioError::Tts(format!(
                        "speech worker failed: {error}"
                    ))),
                };
                clear_active_operation(&state, id).await;
                result
            }
            None => Err(crate::audio::AudioError::Tts(
                "speech generation was superseded".into(),
            )),
        };
        match synthesized {
            Ok((bytes, delivered)) => {
                tracing::info!(chars = text.chars().count(), bytes, elapsed = ?started.elapsed(), "synthesized a mid-turn line");
                if delivered {
                    let route = state.0.live_leg.route();
                    if let Some(entry) =
                        state.0.transcript_log.lock().await.add(AGENT, &text, route)
                    {
                        emit_json(&state, json!({"type":"spoken", "entry":entry}));
                    }
                    let _ = result.send(Ok(()));
                } else {
                    let _ = result.send(Err(
                        "no browser connected or the writer rejected audio".into()
                    ));
                }
            }
            Err(error) => {
                finish_audio(&state, sequence, generation, Vec::new()).await;
                let _ = result.send(Err(error.to_string()));
                tracing::error!(%error, chars = text.chars().count(), "synthesis failed for an agent-spoken line");
                emit_json(&state, json!({"type":"error", "message":error.to_string()}));
            }
        }
    }
    tracing::warn!("the speech worker stopped; agent-spoken lines will not be voiced");
}

async fn process_stream_results(state: AppState) {
    let Some(mut results) = state.0.stt_stream.take_results().await else {
        return;
    };
    while let Some(result) = results.recv().await {
        match result {
            StreamResult::Partial(partial) => {
                let valid = {
                    let clips = state.0.stream_clips.lock().await;
                    matches!(clips.get(&partial.clip_id), Some(StreamClipState::Open { generation, next_sequence, .. }) if *generation == partial.generation && partial.sequence <= *next_sequence)
                };
                if valid && partial.generation == state.0.coordinator.generation() {
                    emit_json(
                        &state,
                        json!({"type":"partial", "id":partial.clip_id, "generation":partial.generation, "sequence":partial.sequence, "text":partial.text}),
                    );
                }
            }
            StreamResult::Final(final_result) => {
                let claim = {
                    let mut clips = state.0.stream_clips.lock().await;
                    match clips.get(&final_result.clip_id).copied() {
                        Some(StreamClipState::Ended { generation, .. })
                            if generation == final_result.generation =>
                        {
                            clips.insert(final_result.clip_id.clone(), StreamClipState::Finalized);
                            true
                        }
                        _ => false,
                    }
                };
                if claim {
                    route_final_transcript(
                        &state,
                        &final_result.clip_id,
                        final_result.generation,
                        final_result.text,
                    )
                    .await;
                }
            }
            StreamResult::WorkerError(error) => {
                tracing::error!(%error, "streaming STT worker failed");
                let abandoned = {
                    let mut clips = state.0.stream_clips.lock().await;
                    let mut abandoned = Vec::new();
                    for (id, clip) in clips.iter_mut() {
                        match *clip {
                            StreamClipState::Open { connection, .. }
                            | StreamClipState::Ended { connection, .. } => {
                                *clip = StreamClipState::Abandoned;
                                abandoned.push((id.clone(), connection));
                            }
                            _ => {}
                        }
                    }
                    abandoned
                };
                for (id, connection) in abandoned {
                    let _ = send_json(
                        &state,
                        connection,
                        json!({"type":"abandoned", "id":id, "reason":"stream worker unavailable"}),
                    )
                    .await;
                }
            }
        }
    }
}

async fn route_final_transcript(state: &AppState, id: &str, generation: u64, transcript: String) {
    if transcript.trim().is_empty() {
        emit_json(
            state,
            json!({"type":"error", "id":id, "message":"I didn't catch that — say it again."}),
        );
        return;
    }
    let _transition = state.0.operation_transition.lock().await;
    if generation != state.0.coordinator.generation() {
        emit_stale_clip(state, id);
        return;
    }
    let route = state.0.live_leg.route();
    state.0.transcript_log.lock().await.add_with_id(
        CALLER,
        &transcript,
        route.clone(),
        Some(id.to_owned()),
    );
    emit_json(
        state,
        json!({"type":"transcript", "id":id, "text":transcript}),
    );
    drop(_transition);
    let steer_operation = state
        .0
        .coordinator
        .attach_steer(&state.0.coordinator.current_identity())
        .ok();
    let active = state.0.active_session.lock().await;
    let steered = match active.as_ref().cloned() {
        None => false,
        Some(session) if steer_operation.is_none() || !session.busy() || !session.alive().await => {
            false
        }
        Some(session) => match session.steer(&transcript).await {
            Ok(()) => active
                .as_ref()
                .is_some_and(|current| current.same_session(&session)),
            Err(error) => {
                tracing::warn!(%error, clip = id, "steering failed; queueing streamed utterance");
                false
            }
        },
    };
    drop(active);
    if steered {
        state.0.activity_clock.touch();
        emit_json(
            state,
            json!({"type":"queued", "id":id, "waiting":0, "steered":true}),
        );
    } else {
        let waiting = state.0.queued_turns.fetch_add(1, Ordering::AcqRel) + 1;
        if state
            .0
            .turns
            .send((id.to_owned(), transcript, generation))
            .await
            .is_ok()
        {
            if waiting > 1 || state.0.turn_in_flight.load(Ordering::Acquire) {
                emit_json(
                    state,
                    json!({"type":"queued", "id":id, "waiting":waiting, "steered":false}),
                );
            }
        } else {
            state.0.queued_turns.fetch_sub(1, Ordering::AcqRel);
            emit_json(
                state,
                json!({"type":"error", "id":id, "message":"The call worker is unavailable."}),
            );
        }
    }
}

async fn process_clips(state: AppState) {
    let mut receiver = state
        .0
        .clip_rx
        .lock()
        .await
        .take()
        .expect("clip worker started once");
    while let Some(clip) = receiver.recv().await {
        // The clip id is the one identifier that spans the whole call path —
        // the browser minted it, the transcript carries it, and every error
        // frame quotes it. Logging it at each stage is what makes a caller's
        // "it broke when I said X" answerable from the journal.
        let started = std::time::Instant::now();
        state.0.coordinator.touch_activity();
        tracing::info!(clip = %clip.id, bytes = clip.audio.len(), "transcribing clip");
        let transcript = match state.0.stt.transcribe(&clip.audio).await {
            Ok(text) => text,
            Err(error) => {
                tracing::error!(clip = %clip.id, bytes = clip.audio.len(), %error, "transcription failed");
                emit_json(
                    &state,
                    json!({"type":"error", "id":clip.id, "message":format!("Transcription failed: {error}")}),
                );
                continue;
            }
        };
        if transcript.trim().is_empty() {
            tracing::info!(clip = %clip.id, elapsed = ?started.elapsed(), "transcription returned nothing");
            emit_json(
                &state,
                json!({"type":"error", "id":clip.id, "message":"I didn't catch that — say it again."}),
            );
            continue;
        }
        let _transition = state.0.operation_transition.lock().await;
        if clip.generation != state.0.coordinator.generation() {
            tracing::info!(clip = %clip.id, "discarding stale transcript before persistence");
            emit_stale_clip(&state, &clip.id);
            continue;
        }
        let route = state.0.live_leg.route();
        tracing::info!(
            clip = %clip.id,
            %route,
            chars = transcript.chars().count(),
            elapsed = ?started.elapsed(),
            "transcribed clip"
        );
        state.0.transcript_log.lock().await.add_with_id(
            CALLER,
            &transcript,
            route.clone(),
            Some(clip.id.clone()),
        );
        emit_json(
            &state,
            json!({"type":"transcript", "id":clip.id, "text":transcript}),
        );
        drop(_transition);
        // Steering is deliberately performed through the shared session handle,
        // not while holding the PBX mutex. The turn worker keeps that mutex for
        // the duration of handle(), so awaiting here would deadlock it.
        let steered = {
            // Steering attaches to the prompt operation already registered by
            // the turn worker. PiSession::steer has its own wire path and is
            // intentionally not serialized by the prompt mutex.
            let steer_operation = state
                .0
                .coordinator
                .attach_steer(&state.0.coordinator.current_identity())
                .ok();
            // Hold the session-control guard across the write so a hangup or
            // redial cannot replace the child between the identity check and
            // the steer. The PBX mutex is intentionally not held here.
            let active = state.0.active_session.lock().await;
            // Speech captured before a page rescue is discarded rather than
            // acted on. Checked under the session guard because a rescue bumps
            // the generation before it closes the session, so a steer that wins
            // this lock still observes the new epoch.
            let current = state.0.coordinator.generation();
            if clip.generation != current {
                tracing::info!(
                    clip = %clip.id,
                    stamped = clip.generation,
                    %current,
                    "discarding speech captured before a page rescue"
                );
                emit_stale_clip(&state, &clip.id);
                continue;
            }
            match active.as_ref().cloned() {
                None => false,
                Some(session)
                    if steer_operation.is_none() || !session.busy() || !session.alive().await =>
                {
                    false
                }
                Some(session) => match session.steer(&transcript).await {
                    Ok(()) => {
                        // A session swapped out under us means the steer landed
                        // in a leg the caller has already left.
                        let same = active
                            .as_ref()
                            .is_some_and(|current| current.same_session(&session));
                        if !same {
                            tracing::warn!(clip = %clip.id, "the leg was replaced mid-steer; queueing the utterance");
                        }
                        same
                    }
                    Err(error) => {
                        tracing::warn!(clip = %clip.id, %error, "steering failed; queueing the utterance");
                        false
                    }
                },
            }
        };
        if steered {
            tracing::info!(clip = %clip.id, %route, "steered the live turn");
            state.0.activity_clock.touch();
            emit_json(
                &state,
                json!({"type":"queued", "id":clip.id, "waiting":0, "steered":true}),
            );
        } else {
            let waiting = state.0.queued_turns.fetch_add(1, Ordering::AcqRel) + 1;
            if state
                .0
                .turns
                .send((clip.id.clone(), transcript, clip.generation))
                .await
                .is_ok()
            {
                if waiting > 1 || state.0.turn_in_flight.load(Ordering::Acquire) {
                    emit_json(
                        &state,
                        json!({"type":"queued", "id":clip.id, "waiting":waiting, "steered":false}),
                    );
                }
            } else {
                tracing::error!(clip = %clip.id, "the turn worker is gone; the utterance was dropped");
                state.0.queued_turns.fetch_sub(1, Ordering::AcqRel);
            }
        }
    }
    tracing::warn!("the clip worker stopped; no further speech will be transcribed");
}
fn emit_stale_clip(state: &AppState, id: &str) {
    emit_json(
        state,
        json!({
            "type":"error",
            "id":id,
            "code":"stale_epoch",
            "message":"that recording belongs to the previous leg"
        }),
    );
}

async fn process_turns(state: AppState) {
    let mut receiver = state
        .0
        .turn_rx
        .lock()
        .await
        .take()
        .expect("turn worker started once");
    while let Some((id, transcript, generation)) = receiver.recv().await {
        state.0.queued_turns.fetch_sub(1, Ordering::AcqRel);
        let turn_state = state.clone();
        let started = std::time::Instant::now();
        // Register the abort handle before awaiting the task. Page-level rescue
        // endpoints can now cancel work even while transfer setup has no
        // PiSession yet.
        let (operation, _status) = {
            let _transition = state.0.operation_transition.lock().await;
            let current = state.0.coordinator.generation();
            if generation != current {
                tracing::info!(clip = %id, stamped = generation, %current, "dropping a queued turn from before a page rescue");
                emit_stale_clip(&state, &id);
                continue;
            }
            state.0.turn_in_flight.store(true, Ordering::Release);
            let status = current_status(&state);
            let waiting = state.0.queued_turns.load(Ordering::Acquire);
            tracing::info!(clip = %id, route = %status["route"], waiting, "dispatching a turn");
            emit_json(
                &state,
                json!({"type":"thinking", "route":status["route"], "waiting":waiting}),
            );
            let operation = state
                .0
                .coordinator
                .begin_prompt(&state.0.coordinator.current_identity())
                .ok();
            (operation, status)
        };
        let Some((task, task_id)) = spawn_registered_operation(&state, generation, async move {
            let mut board = turn_state.0.switchboard.lock().await;
            let reply = board.handle(&transcript).await;
            let status = board.status();
            (reply, status)
        })
        .await
        else {
            tracing::info!(clip = %id, stamped = generation, "dropping turn because rescue occurred before registration");
            if let Some(operation) = &operation {
                state.0.coordinator.finish_operation(operation);
            }
            state.0.turn_in_flight.store(false, Ordering::Release);
            continue;
        };
        let (reply, status) = match task.await {
            Ok(result) => result,
            Err(error) if error.is_cancelled() => {
                tracing::info!(clip = %id, elapsed = ?started.elapsed(), "the turn was cancelled by a page rescue");
                clear_active_operation(&state, task_id).await;
                if let Some(operation) = &operation {
                    state.0.coordinator.finish_operation(operation);
                }
                state.0.turn_in_flight.store(false, Ordering::Release);
                continue;
            }
            Err(error) => {
                // A panic inside `handle()` arrives here. Without this line the
                // caller hears a generic apology and the journal holds nothing.
                tracing::error!(clip = %id, %error, elapsed = ?started.elapsed(), "the turn worker failed");
                clear_active_operation(&state, task_id).await;
                if let Some(operation) = &operation {
                    state.0.coordinator.finish_operation(operation);
                }
                state.0.turn_in_flight.store(false, Ordering::Release);
                emit_json(
                    &state,
                    json!({"type":"error", "message":format!("The call worker failed on that turn: {error}")}),
                );
                continue;
            }
        };
        clear_active_operation(&state, task_id).await;
        if let Some(operation) = &operation {
            state.0.coordinator.finish_operation(operation);
        }
        if let Some(error) = &reply.error {
            // The caller was answered and recovered, so this is not an error
            // level — but a turn that carried a failure is worth an audit trail.
            tracing::warn!(clip = %id, route = %reply.route, %error, "the turn reported a failure");
        }
        tracing::info!(clip = %id, route = %reply.route, elapsed = ?started.elapsed(), "turn settled");
        deliver_turn_if_current(
            &state,
            &reply,
            status,
            reply.delivery_generation.unwrap_or(generation),
            &id,
        )
        .await;
        state.0.turn_in_flight.store(false, Ordering::Release);
    }
    tracing::warn!("the turn worker stopped; no further turns will be dispatched");
}

async fn healthz(State(state): State<AppState>) -> impl IntoResponse {
    let status = current_status(&state);
    Json(
        json!({"status":"ok", "whisper_model":"sidecar", "stt_configured":state.0.stt.command.is_some(), "stt_stream_configured":state.0.stt_stream.configured(), "stt_adapter":"sidecar", "elevenlabs_configured":state.0.speaker.configured(), "route":status["route"], "model":status["model"], "thinking":status["thinking"], "model_swaps":status["model_swaps"], "projects":status["projects"]}),
    )
}
async fn status(State(state): State<AppState>) -> impl IntoResponse {
    Json(current_status(&state))
}
async fn interrupt_active_turn(state: &AppState) -> Option<String> {
    cancel_active_operations(state).await
}
async fn cancel_active_operations(state: &AppState) -> Option<String> {
    let generation = state
        .0
        .coordinator
        .begin_rescue("operation interrupted")
        .generation;
    state.0.audio.lock().await.clear();
    // Tell the browser at once, so speech it starts recording after this point
    // is stamped with the new epoch rather than the one being retired.
    emit_json(state, json!({"type":"epoch", "generation":generation}));
    let operations = std::mem::take(&mut *state.0.active_operations.lock().await);
    for operation in operations.into_values() {
        operation.abort();
    }
    let active = state.0.active_session.lock().await.clone();
    let label = active.as_ref().map(|session| session.label().to_owned());
    if let Some(session) = active {
        session.close().await;
    }
    label
}
async fn spawn_replacing_operation<F, T>(
    state: &AppState,
    future: F,
) -> Option<(JoinHandle<T>, TaskId, u64)>
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    cancel_active_operations(state).await;
    let generation = state.0.coordinator.generation();
    let (task, id) = spawn_registered_operation(state, generation, future).await?;
    Some((task, id, generation))
}
async fn hangup(State(state): State<AppState>) -> impl IntoResponse {
    let interrupted = interrupt_active_turn(&state).await;
    let mut board = state.0.switchboard.lock().await;
    let left = board.force_hangup().await.or(interrupted);
    let status = board.status();
    drop(board);
    if let Some(left) = &left {
        if let Some(entry) = state.0.transcript_log.lock().await.add(
            AGENT,
            &format!("You hung up the line to {left}. You're back with the operator."),
            status["route"].as_str().unwrap_or("operator"),
        ) {
            emit_json(&state, json!({"type":"spoken", "entry":entry}));
        }
        publish_status(&state, status);
    }
    match left {
        Some(left) => Json(json!({"hungup":true, "left":left})),
        None => Json(json!({"hungup":false, "reason":"already on the operator"})),
    }
}
#[derive(Deserialize)]
struct Connect {
    project: String,
    #[serde(default)]
    intent: String,
}
async fn connect(State(state): State<AppState>, Json(req): Json<Connect>) -> Response {
    // The picker is also an escape hatch. Cancel setup or a wedged live turn
    // before taking the PBX lock; otherwise a direct connection can wait for
    // the very leg the caller is trying to leave.
    let operation_state = state.clone();
    let Some((task, task_id, _generation)) = spawn_replacing_operation(&state, async move {
        let mut board = operation_state.0.switchboard.lock().await;
        let reply = board.dial(&req.project, &req.intent).await;
        let status = board.status();
        (reply, status)
    })
    .await
    else {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"detail":"connection attempt was cancelled"})),
        )
            .into_response();
    };
    let (reply, status) = match task.await {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => {
            clear_active_operation(&state, task_id).await;
            return (
                axum::http::StatusCode::CONFLICT,
                Json(json!({"detail":"connection attempt was cancelled"})),
            )
                .into_response();
        }
        Err(error) => {
            clear_active_operation(&state, task_id).await;
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"detail":format!("connection attempt failed: {error}")})),
            )
                .into_response();
        }
    };
    clear_active_operation(&state, task_id).await;
    if !deliver_page_reply_if_current(
        &state,
        &reply,
        status,
        reply.delivery_generation.unwrap_or(_generation),
    )
    .await
    {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"detail":"connection attempt was superseded"})),
        )
            .into_response();
    }
    Json(json!({"route":reply.route, "error":reply.error.clone()})).into_response()
}
#[derive(Deserialize)]
struct Thinking {
    level: String,
}
async fn thinking(State(state): State<AppState>, Json(req): Json<Thinking>) -> Response {
    let operation_state = state.clone();
    let operation = async move {
        let mut board = operation_state.0.switchboard.lock().await;
        let reply = board.set_thinking(&req.level).await;
        let status = board.status();
        (reply, status)
    };
    let Some((task, task_id, _generation)) = (if state.0.live_leg.route() == crate::pbx::OPERATOR {
        spawn_active_operation(&state, operation).await
    } else {
        spawn_replacing_operation(&state, operation).await
    }) else {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"detail":"thinking change was cancelled"})),
        )
            .into_response();
    };
    let (reply, status) = match task.await {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => {
            clear_active_operation(&state, task_id).await;
            return (
                axum::http::StatusCode::CONFLICT,
                Json(json!({"detail":"thinking change was cancelled"})),
            )
                .into_response();
        }
        Err(error) => {
            clear_active_operation(&state, task_id).await;
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"detail":format!("thinking change failed: {error}")})),
            )
                .into_response();
        }
    };
    clear_active_operation(&state, task_id).await;
    if !deliver_page_reply_if_current(
        &state,
        &reply,
        status,
        reply.delivery_generation.unwrap_or(_generation),
    )
    .await
    {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"detail":"thinking change was superseded"})),
        )
            .into_response();
    }
    Json(json!({"thinking":current_status(&state)["thinking"], "error":reply.error.clone()}))
        .into_response()
}
#[derive(Deserialize)]
struct Model {
    model: String,
}
async fn model(State(state): State<AppState>, Json(req): Json<Model>) -> Response {
    let operation_state = state.clone();
    let operation = async move {
        let mut board = operation_state.0.switchboard.lock().await;
        let reply = board.set_model(&req.model).await;
        let status = board.status();
        (reply, status)
    };
    let Some((task, task_id, _generation)) = (if state.0.live_leg.route() == crate::pbx::OPERATOR {
        spawn_active_operation(&state, operation).await
    } else {
        spawn_replacing_operation(&state, operation).await
    }) else {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"detail":"model change was cancelled"})),
        )
            .into_response();
    };
    let (reply, status) = match task.await {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => {
            clear_active_operation(&state, task_id).await;
            return (
                axum::http::StatusCode::CONFLICT,
                Json(json!({"detail":"model change was cancelled"})),
            )
                .into_response();
        }
        Err(error) => {
            clear_active_operation(&state, task_id).await;
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"detail":format!("model change failed: {error}")})),
            )
                .into_response();
        }
    };
    clear_active_operation(&state, task_id).await;
    if !deliver_page_reply_if_current(
        &state,
        &reply,
        status,
        reply.delivery_generation.unwrap_or(_generation),
    )
    .await
    {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"detail":"model change was superseded"})),
        )
            .into_response();
    }
    Json(json!({"model":current_status(&state)["model_name"], "error":reply.error.clone()}))
        .into_response()
}
#[derive(Deserialize)]
struct LegState {
    #[serde(default)]
    thinking: String,
    #[serde(default)]
    token: String,
}
async fn leg_state(State(state): State<AppState>, Json(req): Json<LegState>) -> impl IntoResponse {
    let accepted = match state
        .0
        .coordinator
        .accept_thinking_callback(&req.token, &req.thinking)
    {
        Ok(public) => {
            if public {
                let _ = state.0.live_leg.report_thinking(&req.token, &req.thinking);
                let mut status = current_status(&state);
                status["thinking"] = Value::String(req.thinking.clone());
                status["thinking_confirmed"] = Value::Bool(true);
                publish_status(&state, status);
            }
            true
        }
        Err(_) => false,
    };
    Json(json!({"accepted":accepted}))
}
#[derive(Deserialize)]
struct Speak {
    text: String,
    #[serde(default)]
    token: String,
}
async fn speak(State(state): State<AppState>, Json(req): Json<Speak>) -> Response {
    if req.text.trim().is_empty() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"detail":"text must not be empty"})),
        )
            .into_response();
    }
    promote_candidate_for_token(&state, &req.token).await;
    if let Err(error) = state.0.coordinator.accept_side_effect(&req.token) {
        let (code, detail) = match error {
            crate::lifecycle::LifecycleError::CandidateSideEffect => (
                axum::http::StatusCode::CONFLICT,
                "the line is not live until this transfer completes: put it in your written reply instead and the switchboard will read it out",
            ),
            _ => (
                axum::http::StatusCode::CONFLICT,
                "this leg is no longer on the call: stop retrying, nothing you send reaches the caller",
            ),
        };
        return (
            code,
            Json(json!({"delivered":false, "code":"invalid_leg", "detail":detail})),
        )
            .into_response();
    }
    if !state.0.delivery.connected() {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"delivered":false, "reason":"no browser connected", "detail":"no browser connected"})),
        )
            .into_response();
    }
    if !state.0.speaker.configured() {
        return (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(json!({"detail":"ELEVENLABS_API_KEY is not set"})),
        )
            .into_response();
    }

    let spoken = state.0.speaker.clip_for_speech(&req.text);
    let speech_permit = if spoken.is_empty() {
        return Json(json!({"delivered":false, "reason":"text contained no speakable audio", "detail":"text contained no speakable audio"})).into_response();
    } else {
        match state.0.speech.try_reserve() {
            Ok(permit) => Some(permit),
            Err(_) => {
                return (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"delivered":false, "reason":"speech worker is unavailable or busy", "detail":"speech worker is unavailable or busy"})),
                )
                    .into_response()
            }
        }
    };

    if let Some(permit) = speech_permit {
        let generation = state.0.coordinator.generation();
        let sequence = match reserve_audio(&state, generation).await {
            Some(sequence) => sequence,
            None => return Json(json!({"delivered":false, "reason":"no browser connected", "detail":"no browser connected"})).into_response(),
        };
        let (result_tx, result_rx) = oneshot::channel();
        permit.send(SpeechRequest {
            text: spoken,
            generation,
            sequence,
            deadline: std::time::Instant::now() + state.0.speech_deadline,
            result: result_tx,
        });
        match result_rx.await {
            Ok(Ok(())) => return Json(delivery_response(true)).into_response(),
            Ok(Err(detail)) => {
                return (
                    axum::http::StatusCode::BAD_GATEWAY,
                    Json(json!({"delivered":false, "reason":detail.clone(), "detail":detail})),
                )
                    .into_response();
            }
            Err(_) => {
                return (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"delivered":false, "reason":"speech worker stopped", "detail":"speech worker stopped"})),
                )
                    .into_response();
            }
        }
    }

    Json(json!({"delivered":false, "reason":"no browser connected", "detail":"no browser connected"})).into_response()
}
async fn display(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    let raw: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({"delivered":false, "detail":"invalid JSON payload"})),
            )
                .into_response();
        }
    };
    let Some(map) = raw.as_object() else {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"delivered":false, "detail":"request must be an object"})),
        )
            .into_response();
    };

    for k in map.keys() {
        if k != "token" && k != "action" {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(
                    json!({"delivered":false, "detail":format!("unknown field in envelope: {k}")}),
                ),
            )
                .into_response();
        }
    }

    let Some(action_val) = map.get("action") else {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"delivered":false, "detail":"action is required"})),
        )
            .into_response();
    };

    let token = map.get("token").and_then(Value::as_str).unwrap_or("");

    let normalized_action = match crate::visual_protocol::validate_action(action_val) {
        Ok(act) => act,
        Err(detail) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({"delivered":false, "detail":detail})),
            )
                .into_response();
        }
    };

    promote_candidate_for_token(&state, token).await;
    if let Err(error) = state.0.coordinator.accept_side_effect(token) {
        let detail = match error {
            crate::lifecycle::LifecycleError::CandidateSideEffect => {
                "the caller's screen is not live until this transfer completes: draw it again on your next turn"
            }
            _ => "this leg is no longer on the call: stop retrying, nothing you send reaches the caller",
        };
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"delivered":false, "code":"invalid_leg", "detail":detail})),
        )
            .into_response();
    }
    let permit_generation = state.0.coordinator.generation();

    let mut gate = state.0.display_gate.lock().await;
    if state.0.coordinator.generation() != permit_generation
        || state.0.coordinator.accept_side_effect(token).is_err()
    {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({
                "delivered": false,
                "code": "invalid_leg",
                "detail": "this leg is no longer on the call: stop retrying, nothing you send reaches the caller"
            })),
        )
            .into_response();
    }

    let value = json!({"type":"display", "action": normalized_action});
    let event = Event::Json(value.clone());
    let _ = state.0.events.send(event.clone());
    let (delivered, sequence) = state.0.delivery.publish_sequenced(event);

    gate.projection.apply(&normalized_action, sequence);
    gate.watermark = sequence;
    *state.0.last_display.lock().await = Some(value);
    drop(gate);

    if !delivered {
        return Json(json!({"delivered": false, "reason": "no browser connected"})).into_response();
    }

    let mut confirm_rx = state.0.display_confirm.subscribe();
    let deadline = tokio::time::sleep(std::time::Duration::from_millis(
        DISPLAY_CONFIRM_DEADLINE_MS,
    ));
    tokio::pin!(deadline);
    loop {
        {
            let c = confirm_rx.borrow_and_update();
            if c.generation == permit_generation {
                if let Some((rseq, reason)) = &c.rejection {
                    if *rseq == sequence {
                        return Json(json!({
                            "delivered": true, "rendered": false,
                            "rejected": true, "reason": reason
                        }))
                        .into_response();
                    }
                }
                if c.watermark.is_some_and(|w| w >= sequence) {
                    return Json(json!({"delivered": true, "rendered": true})).into_response();
                }
            } else if c.generation > permit_generation {
                return Json(json!({
                    "delivered": true, "rendered": false,
                    "reason": "the caller's screen moved to a new leg before this was confirmed"
                }))
                .into_response();
            }
        }
        tokio::select! {
            changed = confirm_rx.changed() => { if changed.is_err() { break; } }
            _ = &mut deadline => { break; }
        }
    }
    Json(json!({
        "delivered": true, "rendered": false,
        "reason": "no confirmation from the browser"
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ViewRequest {
    #[serde(default)]
    target: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    token: String,
}

async fn view(State(state): State<AppState>, Json(req): Json<ViewRequest>) -> Response {
    promote_candidate_for_token(&state, &req.token).await;
    if let Err(error) = state.0.coordinator.accept_side_effect(&req.token) {
        let detail = match error {
            crate::lifecycle::LifecycleError::CandidateSideEffect => {
                "the caller's screen is not live until this transfer completes: switch view again on your next turn"
            }
            _ => "this leg is no longer on the call: stop retrying, nothing you send reaches the caller",
        };
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({"delivered":false, "code":"invalid_leg", "detail":detail})),
        )
            .into_response();
    }
    let permit_generation = state.0.coordinator.generation();
    let target = req.target.trim().to_ascii_lowercase();

    let gate = state.0.display_gate.lock().await;
    if state.0.coordinator.generation() != permit_generation
        || state.0.coordinator.accept_side_effect(&req.token).is_err()
    {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({
                "delivered": false,
                "code": "invalid_leg",
                "detail": "this leg is no longer on the call: stop retrying, nothing you send reaches the caller"
            })),
        )
            .into_response();
    }

    if target.is_empty() {
        let (has_visual, kind, title, object_ids) = gate.projection.summary();
        let view = gate
            .screen_state
            .get("view")
            .and_then(Value::as_str)
            .unwrap_or("auto")
            .to_string();
        let connected = state.0.delivery.connected();
        let confirm = state.0.display_confirm.borrow().clone();
        // Nothing is on screen, so there is nothing outstanding to confirm:
        // a fresh call or an emptied stage is trivially "confirmed" without
        // ever having heard from the browser in this generation.
        let confirmed = !has_visual
            || (confirm.generation == permit_generation
                && confirm.watermark.is_some_and(|w| w >= gate.watermark));
        let screen = json!({
            "view": view,
            "has_visual": has_visual,
            "visual_kind": kind,
            "title": title.unwrap_or_default(),
            "object_ids": object_ids,
            "confirmed": confirmed,
            "connected": connected,
            "stale": !confirmed,
        });
        return Json(json!({"delivered": true, "screen": screen})).into_response();
    }

    if !matches!(
        target.as_str(),
        "auto"
            | "stage"
            | "bay2"
            | "visual"
            | "comms"
            | "transcript"
            | "bay3"
            | "system"
            | "magi"
            | "routing"
            | "bay1"
            | "overview"
            | "grid"
            | "split"
            | "theater"
    ) {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({
                "delivered": false,
                "detail": "target must be one of: auto, visual, comms, system, theater"
            })),
        )
            .into_response();
    }

    drop(gate);
    let value = json!({
        "type": "view",
        "target": target,
        "reason": req.reason,
    });
    let delivered = emit_json(&state, value);
    Json(delivery_response(delivered)).into_response()
}

fn delivery_response(delivered: bool) -> Value {
    if delivered {
        json!({"delivered":true})
    } else {
        json!({"delivered":false, "reason":"no browser connected"})
    }
}
async fn deliver_page_reply_if_current(
    state: &AppState,
    reply: &crate::pbx::Reply,
    status: Value,
    generation: u64,
) -> bool {
    let _transition = state.0.operation_transition.lock().await;
    if generation != state.0.coordinator.generation() {
        return false;
    }
    if !reply.text.is_empty() {
        if let Some(entry) =
            state
                .0
                .transcript_log
                .lock()
                .await
                .add(AGENT, &reply.text, reply.route.clone())
        {
            emit_json(state, json!({"type":"spoken", "entry":entry}));
        }
    }
    publish_status(state, status);
    drop(_transition);
    let _ = synthesize_reply_if_current(
        state,
        &reply.to_speak,
        generation,
        std::time::Instant::now() + state.0.speech_deadline,
    )
    .await;
    generation == state.0.coordinator.generation()
}

async fn deliver_turn_if_current(
    state: &AppState,
    reply: &crate::pbx::Reply,
    status: Value,
    generation: u64,
    response_id: &str,
) -> bool {
    let _transition = state.0.operation_transition.lock().await;
    if generation != state.0.coordinator.generation() {
        return false;
    }
    if !reply.text.is_empty() {
        state
            .0
            .transcript_log
            .lock()
            .await
            .add(AGENT, &reply.text, reply.route.clone());
    }
    emit_json(
        state,
        json!({"type":"reply", "text":reply.text, "route":reply.route}),
    );
    publish_status(state, status);
    drop(_transition);
    let success = synthesize_reply_if_current(
        state,
        &reply.to_speak,
        generation,
        std::time::Instant::now() + state.0.speech_deadline,
    )
    .await;
    if generation != state.0.coordinator.generation() {
        return false;
    }
    let Some(sequence) = reserve_audio(state, generation).await else {
        return false;
    };
    let barrier = json!({
        "type": "final_response_audio_closed",
        "response_id": response_id,
        "generation": generation,
        "success": success,
    });
    let events = {
        let mut audio = state.0.audio.lock().await;
        audio.barrier(sequence, generation, barrier)
    };
    let _ = publish_audio_events(state, events).await;
    success
}

async fn synthesize_reply_if_current(
    state: &AppState,
    utterances: &[String],
    generation: u64,
    deadline: std::time::Instant,
) -> bool {
    let mut success = true;
    for text in utterances {
        let spoken = state.0.speaker.clip_for_speech(text);
        if spoken.is_empty() {
            continue;
        }
        let Some(sequence) = reserve_audio(state, generation).await else {
            success = false;
            break;
        };
        let started = std::time::Instant::now();
        let synthesized =
            synthesize_audio_stream(state, &spoken, sequence, generation, deadline).await;
        match synthesized {
            Ok((bytes, _delivered)) => {
                tracing::info!(chars = spoken.chars().count(), bytes, elapsed = ?started.elapsed(), "synthesized a reply");
            }
            Err(error) => {
                finish_audio(state, sequence, generation, Vec::new()).await;
                tracing::error!(%error, chars = spoken.chars().count(), "synthesis failed; the caller hears nothing for this reply");
                emit_json(state, json!({"type":"error", "message":error.to_string()}));
                success = false;
            }
        }
    }
    success && generation == state.0.coordinator.generation()
}

async fn ws(State(state): State<AppState>, upgrade: WebSocketUpgrade) -> impl IntoResponse {
    upgrade
        .max_message_size(MAX_WEBSOCKET_MESSAGE_BYTES)
        .max_frame_size(MAX_WEBSOCKET_MESSAGE_BYTES)
        .on_upgrade(move |socket| websocket(socket, state))
}
async fn websocket(socket: WebSocket, state: AppState) {
    let (connection, snapshot_actions, watermark) = state.register_connection().await;
    let epoch = connection.epoch;
    let (mut sink, mut incoming) = socket.split();
    let mut frames = connection.receiver;
    let writer_state = state.clone();
    let mut writer = Box::pin(tokio::spawn(async move {
        send_snapshot_sink(&mut sink, &writer_state, &snapshot_actions, watermark).await?;
        while let Some(frame) = frames.recv().await {
            match frame {
                DeliveryFrame::Event { sequence, event } => {
                    if sequence <= watermark && is_display_event(&event) {
                        tracing::trace!(
                            sequence,
                            epoch,
                            "discarding replayed display event <= watermark"
                        );
                        continue;
                    }
                    tracing::trace!(sequence, epoch, "delivering sequenced event");
                    send_event_sink(&mut sink, stamp_display_seq(event, sequence)).await?
                }
                DeliveryFrame::Message(message) => sink.send(message).await?,
            }
        }
        Ok::<(), axum::Error>(())
    }));
    let writer_id = writer.id();
    let mut shutdown = state.0.shutdown.subscribe();
    let mut pending_header: Option<ClipHeader> = None;
    let mut pending_stream_chunk: Option<StreamChunkHeader> = None;
    loop {
        tokio::select! {
            result = &mut writer => {
                if let Ok(Err(error)) = result { tracing::warn!(%error, "could not deliver an event to the browser"); }
                break;
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() { break; }
            }
            received = incoming.next() => match received {
                Some(Ok(Message::Text(text))) => {
                    if handle_text_frame(&state, epoch, &mut pending_header, &mut pending_stream_chunk, text.as_ref()).await.is_err() { break; }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    if handle_audio_frame(&state, epoch, &mut pending_header, &mut pending_stream_chunk, bytes.to_vec()).await.is_err() { break; }
                }
                Some(Ok(Message::Ping(bytes))) => {
                    if !state.0.delivery.send(epoch, Message::Pong(bytes)) { break; }
                }
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Close(frame))) => {
                    tracing::info!(code = ?frame.as_ref().map(|frame| frame.code), "browser disconnected");
                    break;
                }
                Some(Err(error)) => { tracing::warn!(%error, "the websocket reader failed"); break; }
                None => break,
            },
        }
    }
    state.retire_connection(epoch).await;
    // The writer owns the only sink. Retiring first prevents new events from
    // being accepted while its final send is being canceled.
    writer.abort();
    tracing::debug!(?writer_id, epoch, "browser connection retired");
}

async fn send_snapshot_sink(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    state: &AppState,
    snapshot_actions: &[Value],
    watermark: u64,
) -> Result<(), axum::Error> {
    let initial = [
        Event::Json(json!({"type":"epoch", "generation":state.0.coordinator.generation()})),
        Event::Json(current_status(state)),
        Event::Json(
            serde_json::to_value(state.0.transcript_log.lock().await.payload()).unwrap_or_default(),
        ),
    ];
    for event in initial {
        send_event_sink(sink, event).await?;
    }
    for action in snapshot_actions {
        send_event_sink(
            sink,
            stamp_display_seq(
                Event::Json(json!({"type":"display", "action":action})),
                watermark,
            ),
        )
        .await?;
    }
    Ok(())
}

/// A clip header: its id, its mime type, and the turn epoch the browser held
/// when it began recording.
///
/// The epoch is optional because a browser that predates it must keep working;
/// such a clip falls back to being stamped on arrival, which is what every
/// client did before. A value the browser cannot have learned yet simply fails
/// the equality check later and the clip is dropped, so a wrong number can only
/// discard speech, never route it somewhere it does not belong.
type ClipHeader = (String, String, Option<u64>);
type StreamChunkHeader = (String, u64, u64);

fn parse_clip_header(command: &serde_json::Map<String, Value>) -> Option<ClipHeader> {
    let id = command
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.chars().count() <= 128)?;
    let mime = command
        .get("mime")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(100)
        .collect();
    let generation = command.get("generation").and_then(Value::as_u64);
    Some((id.to_owned(), mime, generation))
}

/// The longest turn a caller may type, the same bound `/speak` puts on text.
const MAX_TYPED_TURN_CHARS: usize = 16 * 1024;

/// A turn the caller typed: `(id, generation, text)`.
///
/// Unlike a clip header, the generation is required. Every browser that can
/// send a typed turn also stamps its epoch, so there is no older client to
/// fall back for, and a turn without one could not be checked against a
/// transfer that landed after the caller sent it.
fn parse_typed_turn(command: &serde_json::Map<String, Value>) -> Option<(String, u64, String)> {
    let id = command
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.chars().count() <= 128)?;
    let generation = command.get("generation").and_then(Value::as_u64)?;
    let text = command
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.chars().count() <= MAX_TYPED_TURN_CHARS)?;
    Some((id.to_owned(), generation, text.to_owned()))
}

async fn handle_text_frame(
    state: &AppState,
    epoch: u64,
    pending_header: &mut Option<ClipHeader>,
    pending_stream_chunk: &mut Option<StreamChunkHeader>,
    text: &str,
) -> Result<(), ()> {
    let command: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => {
            return send_json(
                state,
                epoch,
                json!({"type":"error", "message":"Invalid JSON frame."}),
            )
            .await
        }
    };
    let Some(command) = command.as_object() else {
        return send_json(
            state,
            epoch,
            json!({"type":"error", "message":"Invalid command shape."}),
        )
        .await;
    };

    match command.get("type").and_then(Value::as_str) {
        Some("hello") => {
            let version = command.get("version").and_then(Value::as_u64).unwrap_or(0);
            let capabilities = command.get("capabilities").and_then(Value::as_object);
            let stream_requested = capabilities
                .and_then(|caps| caps.get("stt_streaming"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mse_requested = capabilities
                .and_then(|caps| caps.get("mse_mp3"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mse_selected = version == 1 && mse_requested;
            send_json(state, epoch, json!({"type":"hello_ack", "version":1, "stt_streaming": version == 1 && stream_requested && state.0.stt_stream.configured(), "audio_streaming":mse_selected, "mse_mp3":mse_selected})).await
        }
        Some("stt_start") => {
            pending_header.take();
            let Some(id) = command
                .get("clip_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 128)
            else {
                return send_json(
                    state,
                    epoch,
                    json!({"type":"error", "message":"Invalid streaming clip id."}),
                )
                .await;
            };
            let generation = command
                .get("generation")
                .and_then(Value::as_u64)
                .unwrap_or_else(|| state.0.coordinator.generation());
            let mime = command.get("mime").and_then(Value::as_str).unwrap_or("");
            if mime != "audio/webm;codecs=opus" || !state.0.stt_stream.configured() {
                return send_json(state, epoch, json!({"type":"abandoned", "id":id, "reason":"streaming STT is unavailable for this clip"})).await;
            }
            let mut clips = state.0.stream_clips.lock().await;
            match clips.get(id).copied() {
                Some(StreamClipState::Open { connection, .. }) if connection == epoch => {
                    return send_json(
                        state,
                        epoch,
                        json!({"type":"accepted", "id":id, "streaming":true}),
                    )
                    .await;
                }
                Some(StreamClipState::Ended {
                    generation: _,
                    connection,
                }) if connection == epoch => {
                    return send_json(
                        state,
                        epoch,
                        json!({"type":"accepted", "id":id, "streaming":true}),
                    )
                    .await;
                }
                Some(StreamClipState::Ended { generation, .. }) => {
                    clips.insert(
                        id.to_owned(),
                        StreamClipState::Open {
                            generation,
                            next_sequence: 0,
                            connection: epoch,
                        },
                    );
                    drop(clips);
                    if let Err(reason) =
                        state
                            .0
                            .stt_stream
                            .try_start(id.to_owned(), generation, mime.to_owned())
                    {
                        state
                            .0
                            .stream_clips
                            .lock()
                            .await
                            .insert(id.to_owned(), StreamClipState::Abandoned);
                        return send_json(
                            state,
                            epoch,
                            json!({"type":"abandoned", "id":id, "reason":reason}),
                        )
                        .await;
                    }
                    return send_json(
                        state,
                        epoch,
                        json!({"type":"accepted", "id":id, "streaming":true}),
                    )
                    .await;
                }
                Some(
                    StreamClipState::Abandoned
                    | StreamClipState::Cancelled
                    | StreamClipState::Finalized,
                ) => {
                    return send_json(state, epoch, json!({"type":"abandoned", "id":id, "reason":"clip is no longer resumable"})).await;
                }
                _ => {}
            }
            if clips.len() >= 512 {
                let retired = clips
                    .iter()
                    .find(|(_, state)| {
                        matches!(
                            state,
                            StreamClipState::Cancelled
                                | StreamClipState::Abandoned
                                | StreamClipState::Finalized
                        )
                    })
                    .map(|(id, _)| id.clone());
                if let Some(retired) = retired {
                    clips.remove(&retired);
                }
            }
            if clips.len() >= 512 {
                return send_json(state, epoch, json!({"type":"abandoned", "id":id, "reason":"too many active streaming clips"})).await;
            }
            clips.insert(
                id.to_owned(),
                StreamClipState::Open {
                    generation,
                    next_sequence: 0,
                    connection: epoch,
                },
            );
            drop(clips);
            if let Err(reason) =
                state
                    .0
                    .stt_stream
                    .try_start(id.to_owned(), generation, mime.to_owned())
            {
                state
                    .0
                    .stream_clips
                    .lock()
                    .await
                    .insert(id.to_owned(), StreamClipState::Abandoned);
                return send_json(
                    state,
                    epoch,
                    json!({"type":"abandoned", "id":id, "reason":reason}),
                )
                .await;
            }
            send_json(
                state,
                epoch,
                json!({"type":"accepted", "id":id, "streaming":true}),
            )
            .await
        }
        Some("stt_chunk") => {
            let Some(id) = command
                .get("clip_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 128)
            else {
                return send_json(
                    state,
                    epoch,
                    json!({"type":"error", "message":"Invalid streaming clip id."}),
                )
                .await;
            };
            let generation = command
                .get("generation")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let sequence = command
                .get("sequence")
                .and_then(Value::as_u64)
                .unwrap_or(u64::MAX);
            *pending_stream_chunk = Some((id.to_owned(), generation, sequence));
            Ok(())
        }
        Some("stt_end") => {
            let Some(id) = command.get("clip_id").and_then(Value::as_str) else {
                return Ok(());
            };
            let generation = command
                .get("generation")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let valid = {
                let mut clips = state.0.stream_clips.lock().await;
                match clips.get(id).copied() {
                    Some(StreamClipState::Open {
                        generation: current,
                        connection,
                        ..
                    }) if current == generation && connection == epoch => {
                        clips.insert(
                            id.to_owned(),
                            StreamClipState::Ended {
                                generation,
                                connection,
                            },
                        );
                        true
                    }
                    Some(StreamClipState::Ended { .. })
                    | Some(StreamClipState::Cancelled)
                    | Some(StreamClipState::Abandoned)
                    | Some(StreamClipState::Finalized) => false,
                    _ => false,
                }
            };
            if valid {
                if let Err(reason) = state.0.stt_stream.try_end(id.to_owned(), generation) {
                    state
                        .0
                        .stream_clips
                        .lock()
                        .await
                        .insert(id.to_owned(), StreamClipState::Abandoned);
                    return send_json(
                        state,
                        epoch,
                        json!({"type":"abandoned", "id":id, "reason":reason}),
                    )
                    .await;
                }
            }
            Ok(())
        }
        Some("stt_cancel") => {
            let Some(id) = command.get("clip_id").and_then(Value::as_str) else {
                return Ok(());
            };
            let generation = command
                .get("generation")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let should_cancel = {
                let mut clips = state.0.stream_clips.lock().await;
                match clips.get(id).copied() {
                    Some(StreamClipState::Cancelled)
                    | Some(StreamClipState::Finalized)
                    | Some(StreamClipState::Abandoned)
                    | None => false,
                    Some(_) => {
                        clips.insert(id.to_owned(), StreamClipState::Cancelled);
                        true
                    }
                }
            };
            if should_cancel {
                let _ = state.0.stt_stream.try_cancel(id.to_owned(), generation);
            }
            Ok(())
        }
        Some("screen_state") => {
            let Some(view) = command
                .get("view")
                .and_then(Value::as_str)
                .filter(|view| matches!(*view, "auto" | "system" | "visual" | "comms" | "theater"))
            else {
                return send_json(
                    state,
                    epoch,
                    json!({"type":"error", "message":"Invalid screen view."}),
                )
                .await;
            };
            let title = command
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(200)
                .collect::<String>();
            let visual_kind = match command.get("visual_kind") {
                Some(Value::String(s)) => {
                    if matches!(
                        s.as_str(),
                        "chart" | "metric" | "progress" | "diagram" | "document" | "code" | "note"
                    ) {
                        Value::String(s.clone())
                    } else {
                        Value::Null
                    }
                }
                _ => Value::Null,
            };
            let object_ids = command
                .get("object_ids")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let pinned = command
                .get("pinned")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let has_visual = command
                .get("has_visual")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let stale = command
                .get("stale")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let report_gen = command
                .get("generation")
                .and_then(Value::as_u64)
                .unwrap_or_else(|| state.0.coordinator.generation());

            let current_gen = state.0.coordinator.generation();
            let active_ep = state.0.delivery.active_epoch();
            if active_ep != Some(epoch) || report_gen != current_gen {
                return Ok(());
            }
            let mut gate = state.0.display_gate.lock().await;

            let report = json!({
                "view": view,
                "pinned": pinned,
                "has_visual": has_visual,
                "visual_kind": visual_kind,
                "object_ids": object_ids,
                "title": title,
                "stale": stale,
                "generation": current_gen,
            });
            gate.screen_state = report.clone();
            gate.report_epoch = Some(epoch);
            gate.report_generation = Some(current_gen);
            *state.0.screen_state.lock().await = report;
            drop(gate);

            let applied_seq = command.get("applied_seq").and_then(Value::as_u64);
            let rejected = command
                .get("rejected")
                .and_then(Value::as_object)
                .and_then(|m| {
                    let seq = m.get("seq").and_then(Value::as_u64)?;
                    let reason = m
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("the caller's screen could not render it")
                        .to_string();
                    Some((seq, reason))
                });
            state.0.display_confirm.send_modify(|c| {
                if c.generation != current_gen {
                    c.generation = current_gen;
                    c.watermark = None;
                }
                if let Some(seq) = applied_seq {
                    if c.watermark.is_none_or(|w| seq > w) {
                        c.watermark = Some(seq);
                    }
                }
                c.rejection = rejected.clone();
            });

            send_json(state, epoch, json!({"type":"screen_state_ack"})).await
        }
        Some("ping") => {
            send_json(
                state,
                epoch,
                json!({"type":"pong", "nonce":command.get("nonce"), "time":command.get("time")}),
            )
            .await
        }
        Some("typed_turn") => {
            let Some((id, generation, text)) = parse_typed_turn(command) else {
                return send_json(
                    state,
                    epoch,
                    json!({"type":"error", "id":command.get("id"), "message":"That message could not be sent."}),
                )
                .await;
            };
            tracing::info!(turn = %id, generation, chars = text.chars().count(), "typed turn");
            // A typed turn is a transcript that needs no transcription, so it
            // takes the same path as a streamed one: epoch check, log, echo,
            // then steer or queue. It runs off this reader because that path
            // waits on `operation_transition`, which a transfer can hold for
            // seconds, and the reader must keep answering pings meanwhile.
            let state = state.clone();
            tokio::spawn(
                async move { route_final_transcript(&state, &id, generation, text).await },
            );
            Ok(())
        }
        Some("clip") => {
            let Some(header) = parse_clip_header(command) else {
                pending_header.take();
                return send_json(
                    state,
                    epoch,
                    json!({"type":"error", "message":"Invalid clip id."}),
                )
                .await;
            };
            *pending_header = Some(header);
            Ok(())
        }
        _ => {
            send_json(
                state,
                epoch,
                json!({"type":"error", "message":"Unknown websocket command."}),
            )
            .await
        }
    }
}

async fn handle_audio_frame(
    state: &AppState,
    epoch: u64,
    pending_header: &mut Option<ClipHeader>,
    pending_stream_chunk: &mut Option<StreamChunkHeader>,
    audio: Vec<u8>,
) -> Result<(), ()> {
    if let Some((id, generation, sequence)) = pending_stream_chunk.take() {
        let admitted = {
            let mut clips = state.0.stream_clips.lock().await;
            match clips.get_mut(&id) {
                Some(StreamClipState::Open {
                    generation: current,
                    next_sequence,
                    connection,
                }) if *current == generation
                    && *connection == epoch
                    && *next_sequence == sequence =>
                {
                    *next_sequence += 1;
                    true
                }
                _ => false,
            }
        };
        if !admitted {
            return send_json(state, epoch, json!({"type":"error", "id":id, "message":"Invalid or out-of-order streaming chunk."})).await;
        }
        if let Err(reason) = state
            .0
            .stt_stream
            .try_chunk(id.clone(), generation, sequence, audio)
        {
            state
                .0
                .stream_clips
                .lock()
                .await
                .insert(id.clone(), StreamClipState::Abandoned);
            return send_json(
                state,
                epoch,
                json!({"type":"abandoned", "id":id, "reason":reason}),
            )
            .await;
        }
        return Ok(());
    }
    let Some((id, mime, generation)) = pending_header.take() else {
        tracing::warn!(bytes = audio.len(), "audio arrived without a clip header");
        return send_json(
            state,
            epoch,
            json!({"type":"error", "message":"Audio arrived without a clip header."}),
        )
        .await;
    };

    let fresh = {
        let mut accepted = state.0.accepted_clips.lock().await;
        let fresh = accepted.0.insert(id.clone());
        if fresh {
            accepted.1.push_back(id.clone());
            while accepted.1.len() > 512 {
                if let Some(old) = accepted.1.pop_front() {
                    accepted.0.remove(&old);
                }
            }
        } else {
            // A reconnect retransmits the oldest unacknowledged clip first.
            // Keep that id recent just like the Python OrderedDict baseline so
            // a live retry cannot fall out of the bounded idempotency window.
            accepted.1.retain(|accepted_id| accepted_id != &id);
            accepted.1.push_back(id.clone());
        }
        fresh
    };
    if fresh
        && state
            .0
            .clips
            .send(Clip {
                id: id.clone(),
                audio,
                _mime: mime,
                // The browser's stamp is taken when recording starts, which is
                // earlier than anything this side can observe and therefore
                // closes the upload window too. Arrival time is the fallback
                // for clients that do not send one.
                generation: generation.unwrap_or_else(|| state.0.coordinator.generation()),
            })
            .await
            .is_err()
    {
        // Do not acknowledge ownership the application did not actually take.
        // A reconnect must be allowed to retry this id.
        let mut accepted = state.0.accepted_clips.lock().await;
        accepted.0.remove(&id);
        accepted.1.retain(|accepted_id| accepted_id != &id);
        return send_json(
            state,
            epoch,
            json!({"type":"error", "id":id, "message":"The call worker is unavailable."}),
        )
        .await;
    }
    send_json(state, epoch, json!({"type":"accepted", "id":id})).await
}

async fn send_json(state: &AppState, epoch: u64, value: Value) -> Result<(), ()> {
    state
        .0
        .delivery
        .send(epoch, Message::Text(value.to_string().into()))
        .then_some(())
        .ok_or(())
}
async fn send_event_sink(
    socket: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    event: Event,
) -> Result<(), axum::Error> {
    match event {
        Event::Json(value) => socket.send(Message::Text(value.to_string().into())).await,
        Event::AudioStart { generation, sequence, mime, format } => {
            socket.send(Message::Text(json!({"type":"audio_start", "generation":generation, "sequence":sequence, "mime":mime, "format":format}).to_string().into())).await
        }
        Event::AudioChunk { audio, .. } => socket.send(Message::Binary(audio.into())).await,
        Event::AudioDone { generation, sequence } => {
            socket.send(Message::Text(json!({"type":"audio_done", "generation":generation, "sequence":sequence, "done":true}).to_string().into())).await
        }
    }
}

#[cfg(test)]
#[path = "../tests/test_api.rs"]
mod tests;

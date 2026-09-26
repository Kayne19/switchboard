//! Ordered browser delivery: the event envelope, per-connection framing, and
//! the audio queue that orders synthesized speech ahead of the browser.
//!
//! `api.rs` is the only caller: it registers and retires connections, drives
//! the audio queue around every speech/reply path, and matches `Event` to
//! build the message the socket writer sends. Nothing here knows about routes,
//! generations, or the coordinator; a caller checks the generation before it
//! reserves or finishes a slot.
use axum::extract::ws::Message;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tokio::sync::mpsc;

#[derive(Clone, Debug)]
pub(crate) enum Event {
    Json(Value),
    AudioStart {
        generation: u64,
        sequence: u64,
        mime: String,
        format: String,
    },
    /// Belongs to the utterance of the last `AudioStart`; the browser gets
    /// it as a bare binary frame.
    AudioChunk {
        audio: Vec<u8>,
    },
    AudioDone {
        generation: u64,
        sequence: u64,
    },
}

const DELIVERY_QUEUE: usize = 256;

#[derive(Clone)]
pub(crate) struct DeliveryState {
    next_epoch: Arc<AtomicU64>,
    next_sequence: Arc<AtomicU64>,
    active_epoch: Arc<AtomicU64>,
    connections: Arc<std::sync::Mutex<HashMap<u64, mpsc::Sender<DeliveryFrame>>>>,
}

#[derive(Debug)]
pub(crate) enum DeliveryFrame {
    Event { sequence: u64, event: Event },
    Message(Message),
}

pub(crate) struct DeliveryConnection {
    pub(crate) epoch: u64,
    pub(crate) receiver: mpsc::Receiver<DeliveryFrame>,
}

impl DeliveryState {
    pub(crate) fn new() -> Self {
        Self {
            next_epoch: Arc::new(AtomicU64::new(1)),
            next_sequence: Arc::new(AtomicU64::new(0)),
            active_epoch: Arc::new(AtomicU64::new(0)),
            connections: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    /// The connection table. Held only for map operations with no await and no
    /// callback, so a panic cannot leave it half-updated; like every other
    /// lock in the service, a poisoned one is recovered rather than allowed to
    /// take every later delivery down with it.
    fn connections(&self) -> std::sync::MutexGuard<'_, HashMap<u64, mpsc::Sender<DeliveryFrame>>> {
        self.connections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn register(&self) -> DeliveryConnection {
        let epoch = self.next_epoch.fetch_add(1, Ordering::Relaxed);
        self.active_epoch.store(epoch, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel(DELIVERY_QUEUE);
        self.connections().insert(epoch, sender);
        DeliveryConnection { epoch, receiver }
    }

    pub(crate) fn retire(&self, epoch: u64) {
        self.connections().remove(&epoch);
        let _ = self
            .active_epoch
            .compare_exchange(epoch, 0, Ordering::Relaxed, Ordering::Relaxed);
    }

    pub(crate) fn active_epoch(&self) -> Option<u64> {
        let ep = self.active_epoch.load(Ordering::Relaxed);
        if ep == 0 {
            None
        } else {
            Some(ep)
        }
    }

    pub(crate) fn publish_sequenced(&self, event: Event) -> (bool, u64) {
        let sequence = self.next_sequence.fetch_add(1, Ordering::Relaxed);
        let mut delivered = false;
        let mut dead = Vec::new();
        let connections = self.connections();
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
            let mut connections = self.connections();
            for epoch in dead {
                connections.remove(&epoch);
            }
        }
        (delivered, sequence)
    }

    pub(crate) fn publish(&self, event: Event) -> bool {
        self.publish_sequenced(event).0
    }

    pub(crate) fn send(&self, epoch: u64, message: Message) -> bool {
        self.connections()
            .get(&epoch)
            .is_some_and(|sender| sender.try_send(DeliveryFrame::Message(message)).is_ok())
    }

    pub(crate) fn connected(&self) -> bool {
        !self.connections().is_empty()
    }
}

pub(crate) struct AudioSlot {
    generation: u64,
    events: Vec<Event>,
    started: bool,
    done: bool,
}

pub(crate) struct AudioQueue {
    next: u64,
    emit: u64,
    pub(crate) slots: BTreeMap<u64, AudioSlot>,
}

impl AudioQueue {
    pub(crate) fn new() -> Self {
        Self {
            next: 0,
            emit: 0,
            slots: BTreeMap::new(),
        }
    }
    pub(crate) fn reserve(&mut self, generation: u64) -> u64 {
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
    pub(crate) fn start(&mut self, sequence: u64, generation: u64) -> Vec<Event> {
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
    pub(crate) fn append(&mut self, sequence: u64, generation: u64, audio: Vec<u8>) -> Vec<Event> {
        let Some(slot) = self.slots.get_mut(&sequence) else {
            return Vec::new();
        };
        if slot.generation == generation && !audio.is_empty() {
            slot.events.push(Event::AudioChunk { audio });
        }
        self.drain_ready()
    }
    pub(crate) fn cancel(&mut self, sequence: u64, generation: u64) -> Vec<Event> {
        self.finish(sequence, generation)
    }
    pub(crate) fn barrier(&mut self, sequence: u64, generation: u64, value: Value) -> Vec<Event> {
        let Some(slot) = self.slots.get_mut(&sequence) else {
            return Vec::new();
        };
        if slot.generation == generation && !slot.done {
            slot.events.push(Event::Json(value));
            slot.done = true;
        }
        self.drain_ready()
    }
    pub(crate) fn finish(&mut self, sequence: u64, generation: u64) -> Vec<Event> {
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
    pub(crate) fn clear(&mut self) {
        self.slots.clear();
        self.emit = self.next;
    }
}

#[cfg(test)]
#[path = "../tests/test_delivery.rs"]
mod tests;

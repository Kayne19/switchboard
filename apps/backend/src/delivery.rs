//! Ordered browser delivery: the event envelope, per-connection framing, and
//! the audio queue that orders synthesized speech ahead of the browser.
//!
//! The application files are the only callers: `browser.rs` registers and
//! retires connections and matches `Event` to build the message the socket
//! writer sends, and `speech.rs` drives the audio queue around every
//! speech/reply path. Nothing here knows about routes,
//! generations, or the coordinator; a caller checks the generation before it
//! reserves or finishes a slot.
use axum::extract::ws::Message;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tokio::sync::{mpsc, oneshot};

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

pub(crate) const DELIVERY_QUEUE: usize = 256;

#[derive(Clone)]
pub(crate) struct DeliveryState {
    next_epoch: Arc<AtomicU64>,
    next_sequence: Arc<AtomicU64>,
    active_epoch: Arc<AtomicU64>,
    connections: Arc<std::sync::Mutex<HashMap<u64, Peer>>>,
}

/// A registered connection as the table holds it. Dropping it closes the
/// queue and resolves the connection's `dropped` signal.
struct Peer {
    sender: mpsc::Sender<DeliveryFrame>,
    _dropped: oneshot::Sender<()>,
}

#[derive(Debug)]
pub(crate) enum DeliveryFrame {
    Event { sequence: u64, event: Event },
    Message(Message),
}

pub(crate) struct DeliveryConnection {
    pub(crate) epoch: u64,
    pub(crate) receiver: mpsc::Receiver<DeliveryFrame>,
    /// Resolves when the table lets the connection go. `browser.rs` closes
    /// the socket on it at once: a writer still sending what was queued
    /// before would hold a lagging page on a stream with a hole in it.
    pub(crate) dropped: oneshot::Receiver<()>,
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
    fn connections(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Peer>> {
        self.connections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn register(&self) -> DeliveryConnection {
        let epoch = self.next_epoch.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel(DELIVERY_QUEUE);
        let (dropped_sender, dropped) = oneshot::channel();
        // The active connection changes only under the table's lock, so a
        // retirement promotes from the table as it stands.
        let mut connections = self.connections();
        connections.insert(
            epoch,
            Peer {
                sender,
                _dropped: dropped_sender,
            },
        );
        self.active_epoch.store(epoch, Ordering::Relaxed);
        drop(connections);
        DeliveryConnection {
            epoch,
            receiver,
            dropped,
        }
    }

    /// Lets `epoch` go. When it was the active connection, the newest one
    /// still open takes over (none when it was the last): two tabs are two
    /// connections, and closing the newer must not leave the other unheard.
    pub(crate) fn retire(&self, epoch: u64) {
        let mut connections = self.connections();
        connections.remove(&epoch);
        let next = connections.keys().max().copied().unwrap_or(0);
        let _ =
            self.active_epoch
                .compare_exchange(epoch, next, Ordering::Relaxed, Ordering::Relaxed);
    }

    pub(crate) fn active_epoch(&self) -> Option<u64> {
        let ep = self.active_epoch.load(Ordering::Relaxed);
        if ep == 0 {
            None
        } else {
            Some(ep)
        }
    }

    /// Queues `event` for every connection. A connection whose queue is full
    /// has fallen `DELIVERY_QUEUE` frames behind and has lost this event, so
    /// it is dropped, which closes its socket (see `DeliveryConnection`); the
    /// page reconnects and gets a whole snapshot. One whose queue is closed
    /// has already gone and is only removed.
    pub(crate) fn publish_sequenced(&self, event: Event) -> (bool, u64) {
        let sequence = self.next_sequence.fetch_add(1, Ordering::Relaxed);
        let mut delivered = false;
        let mut lagging = Vec::new();
        let mut gone = Vec::new();
        let connections = self.connections();
        for (&epoch, peer) in connections.iter() {
            match peer.sender.try_send(DeliveryFrame::Event {
                sequence,
                event: event.clone(),
            }) {
                Ok(()) => delivered = true,
                Err(mpsc::error::TrySendError::Full(_)) => lagging.push(epoch),
                Err(mpsc::error::TrySendError::Closed(_)) => gone.push(epoch),
            }
        }
        drop(connections);
        if !lagging.is_empty() || !gone.is_empty() {
            let mut connections = self.connections();
            for &epoch in lagging.iter().chain(&gone) {
                connections.remove(&epoch);
            }
        }
        for connection in lagging {
            tracing::warn!(
                connection,
                sequence,
                queue = DELIVERY_QUEUE,
                "a browser connection fell a full queue behind; closing it"
            );
        }
        for connection in gone {
            tracing::debug!(connection, "removed a closed browser connection");
        }
        (delivered, sequence)
    }

    pub(crate) fn publish(&self, event: Event) -> bool {
        self.publish_sequenced(event).0
    }

    pub(crate) fn send(&self, epoch: u64, message: Message) -> bool {
        self.connections().get(&epoch).is_some_and(|peer| {
            peer.sender
                .try_send(DeliveryFrame::Message(message))
                .is_ok()
        })
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

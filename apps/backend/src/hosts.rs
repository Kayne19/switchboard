//! The service side of the host link (`docs/host-link.md`).
//!
//! Each project host runs a host agent that dials out to `/host` and keeps
//! one WebSocket open. This module owns those links: it checks the hello
//! (per-host token, host-link protocol version), gives each accepted link of a
//! host a larger link epoch and fences the older link, runs the heartbeat, and
//! keeps the registry of hosts that `/healthz` reports.
//!
//! The per-host tokens come from one JSON file, read once at startup. A token
//! is never logged; logs name hosts and counts only.
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, watch};

/// The host-link protocol version this service speaks.
pub const HOST_LINK_PROTOCOL: u64 = 1;
/// The oldest host-link protocol version this service still accepts. A host
/// between this and `HOST_LINK_PROTOCOL` links but is reported as outdated.
pub const OLDEST_HOST_LINK_PROTOCOL: u64 = 1;

/// Largest frame a host may send; a snapshot is the biggest one.
const MAX_HOST_FRAME_BYTES: usize = 16 * 1024 * 1024;
/// Close code for a link a newer link of the same host replaced.
const CLOSE_FENCED: u16 = 4001;
/// Close code for a link that missed too many pongs.
const CLOSE_HEARTBEAT: u16 = 4000;
/// Close codes from RFC 6455.
const CLOSE_GOING_AWAY: u16 = 1001;
const CLOSE_PROTOCOL_ERROR: u16 = 1002;
const CLOSE_POLICY: u16 = 1008;

/// The link heartbeat: a JSON `ping` every `interval`; a link with
/// `missed_pong_limit` pings unanswered is dropped. A socket that sends no
/// hello within the same window is dropped too.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Heartbeat {
    pub interval: Duration,
    pub missed_pong_limit: u32,
}

impl Default for Heartbeat {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(10),
            missed_pong_limit: 3,
        }
    }
}

impl Heartbeat {
    fn hello_timeout(&self) -> Duration {
        self.interval * self.missed_pong_limit.max(1)
    }
}

/// Every host the service expects, and the link of each that is connected.
#[derive(Clone)]
pub struct Hosts(Arc<HostsInner>);

struct HostsInner {
    tokens: HashMap<String, String>,
    heartbeat: Heartbeat,
    hosts: Mutex<HashMap<String, HostState>>,
}

#[derive(Default)]
struct HostState {
    /// The epoch of the last accepted link; the next one gets a larger one.
    last_epoch: u64,
    link: Option<Link>,
    /// The last hello from an authenticated host, kept after it disconnects.
    hello: Option<HelloInfo>,
    /// Per session handle, the last event cursor received from this host.
    cursors: HashMap<String, String>,
}

/// The connected link of a host. It owns the sender for the socket's frames.
struct Link {
    epoch: u64,
    outbound: mpsc::UnboundedSender<Message>,
    /// The host agent said `synced` for this epoch.
    synced: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct PrimeAgentVersions {
    client_version: Option<String>,
    daemon_version: Option<String>,
    daemon_protocol: Option<u64>,
}

#[derive(Clone, Debug)]
struct HelloInfo {
    protocol: Option<u64>,
    git_sha: Option<String>,
    prime_agent: Option<PrimeAgentVersions>,
}

#[derive(Deserialize)]
struct Hello {
    #[serde(rename = "type")]
    kind: String,
    host_id: String,
    token: String,
    #[serde(default)]
    protocol: Value,
    #[serde(default)]
    git_sha: Option<String>,
    #[serde(default)]
    prime_agent: Option<PrimeAgentVersions>,
}

/// Why a hello was refused; `reason` is the wire value.
#[derive(Debug, PartialEq, Eq)]
enum Refusal {
    BadToken,
    IncompatibleProtocol(String),
}

impl Refusal {
    fn frame(&self) -> Value {
        match self {
            Refusal::BadToken => json!({
                "type": "refused",
                "reason": "bad_token",
                "message": "unknown host or token",
            }),
            Refusal::IncompatibleProtocol(protocol) => json!({
                "type": "refused",
                "reason": "incompatible_protocol",
                "message": format!("host-link protocol {protocol} is not supported"),
            }),
        }
    }
}

/// Where a host's protocol stands against this service's.
fn protocol_status(protocol: Option<u64>) -> &'static str {
    protocol_status_within(protocol, OLDEST_HOST_LINK_PROTOCOL, HOST_LINK_PROTOCOL)
}

fn protocol_status_within(protocol: Option<u64>, oldest: u64, current: u64) -> &'static str {
    match protocol {
        Some(version) if version == current => "compatible",
        Some(version) if (oldest..current).contains(&version) => "outdated",
        _ => "incompatible",
    }
}

/// Compares two tokens without stopping at the first differing byte.
fn same_token(expected: &str, given: &str) -> bool {
    let (expected, given) = (expected.as_bytes(), given.as_bytes());
    expected.len() == given.len()
        && expected
            .iter()
            .zip(given)
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

fn text(value: Value) -> Message {
    Message::Text(value.to_string().into())
}

fn close(code: u16, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }))
}

impl Hosts {
    /// A registry expecting the hosts in `tokens` (host id to token).
    pub fn new(tokens: HashMap<String, String>, heartbeat: Heartbeat) -> Self {
        Self(Arc::new(HostsInner {
            tokens,
            heartbeat,
            hosts: Mutex::new(HashMap::new()),
        }))
    }

    /// Reads the host tokens file: a JSON object from host id to token.
    ///
    /// A missing or malformed file leaves no host able to link; the service
    /// still runs. Invalid entries are skipped by host id.
    pub fn load(path: &Path, heartbeat: Heartbeat) -> Self {
        let tokens = match std::fs::read_to_string(path) {
            Ok(raw) => parse_tokens(path, &raw),
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "no host tokens file; no host can link");
                HashMap::new()
            }
        };
        let mut ids: Vec<&str> = tokens.keys().map(String::as_str).collect();
        ids.sort_unstable();
        tracing::info!(path = %path.display(), count = ids.len(), hosts = ?ids, "host tokens loaded");
        Self::new(tokens, heartbeat)
    }

    /// Upgrades a `/host` request into a host link.
    pub fn accept(&self, upgrade: WebSocketUpgrade, shutdown: watch::Receiver<bool>) -> Response {
        let hosts = self.clone();
        upgrade
            .max_message_size(MAX_HOST_FRAME_BYTES)
            .max_frame_size(MAX_HOST_FRAME_BYTES)
            .on_upgrade(move |socket| hosts.serve(socket, shutdown))
    }

    /// The state of every expected host, for `/healthz`, sorted by host id.
    pub fn status(&self) -> Value {
        let hosts = self.0.hosts.lock().unwrap();
        let mut ids: Vec<&String> = self.0.tokens.keys().collect();
        ids.sort_unstable();
        let entries: Vec<Value> = ids
            .into_iter()
            .map(|id| {
                let state = hosts.get(id);
                let link = state.and_then(|state| state.link.as_ref());
                let hello = state.and_then(|state| state.hello.as_ref());
                json!({
                    "host": id,
                    "connected": link.is_some(),
                    "epoch": link.map(|link| link.epoch),
                    "synced": link.is_some_and(|link| link.synced),
                    "protocol": hello.and_then(|hello| hello.protocol),
                    "protocol_status": hello.map(|hello| protocol_status(hello.protocol)),
                    "git_sha": hello.and_then(|hello| hello.git_sha.clone()),
                    "prime_agent": hello.and_then(|hello| hello.prime_agent.clone()),
                })
            })
            .collect();
        Value::Array(entries)
    }

    async fn serve(self, socket: WebSocket, shutdown: watch::Receiver<bool>) {
        let (mut sink, mut incoming) = socket.split();
        let first = tokio::time::timeout(self.0.heartbeat.hello_timeout(), incoming.next()).await;
        let Ok(Some(Ok(Message::Text(first)))) = first else {
            tracing::info!("host link closed before a hello");
            let _ = sink
                .send(close(CLOSE_PROTOCOL_ERROR, "expected hello"))
                .await;
            return;
        };
        let Ok(hello) = serde_json::from_str::<Hello>(first.as_str()) else {
            tracing::info!("host link sent no valid hello");
            let _ = sink
                .send(close(CLOSE_PROTOCOL_ERROR, "expected hello"))
                .await;
            return;
        };
        if hello.kind != "hello" {
            tracing::info!(frame = %hello.kind, "host link sent no valid hello");
            let _ = sink
                .send(close(CLOSE_PROTOCOL_ERROR, "expected hello"))
                .await;
            return;
        }
        let host = hello.host_id.clone();
        let (outbound, frames) = mpsc::unbounded_channel();
        let epoch = match self.admit(hello, outbound) {
            Ok(epoch) => epoch,
            Err(refusal) => {
                tracing::warn!(%host, ?refusal, "host link refused");
                let _ = sink.send(text(refusal.frame())).await;
                let _ = sink.send(close(CLOSE_POLICY, "refused")).await;
                return;
            }
        };
        let reason = self
            .run(&host, epoch, sink, incoming, frames, shutdown)
            .await;
        self.release(&host, epoch, reason);
    }

    /// Checks a hello and, if it passes, makes its link the host's current
    /// one: a larger epoch, the welcome queued, and any older link fenced.
    fn admit(
        &self,
        hello: Hello,
        outbound: mpsc::UnboundedSender<Message>,
    ) -> Result<u64, Refusal> {
        let Some(expected) = self.0.tokens.get(&hello.host_id) else {
            return Err(Refusal::BadToken);
        };
        if !same_token(expected, &hello.token) {
            return Err(Refusal::BadToken);
        }
        let protocol = hello.protocol.as_u64();
        let mut hosts = self.0.hosts.lock().unwrap();
        let state = hosts.entry(hello.host_id.clone()).or_default();
        let info = HelloInfo {
            protocol,
            git_sha: hello.git_sha,
            prime_agent: hello.prime_agent,
        };
        if protocol_status(protocol) == "incompatible" {
            // Reported unless a compatible link of the host is still up.
            if state.link.is_none() {
                state.hello = Some(info);
            }
            return Err(Refusal::IncompatibleProtocol(hello.protocol.to_string()));
        }
        state.hello = Some(info);
        state.last_epoch += 1;
        let epoch = state.last_epoch;
        let cursors: BTreeMap<&String, &String> = state.cursors.iter().collect();
        // Queued before the link is registered, so it is the first frame out.
        let _ = outbound.send(text(json!({
            "type": "welcome",
            "epoch": epoch,
            "protocol": HOST_LINK_PROTOCOL,
            "cursors": cursors,
        })));
        let replaced = state.link.replace(Link {
            epoch,
            outbound,
            synced: false,
        });
        if let Some(older) = replaced {
            tracing::info!(host = %hello.host_id, epoch = older.epoch, newer = epoch, "host link fenced by a newer link");
            let _ = older.outbound.send(close(CLOSE_FENCED, "fenced"));
        }
        tracing::info!(
            host = %hello.host_id,
            epoch,
            protocol,
            protocol_status = protocol_status(protocol),
            git_sha = state.hello.as_ref().and_then(|hello| hello.git_sha.as_deref()).unwrap_or("unknown"),
            "host linked"
        );
        Ok(epoch)
    }

    /// Serves one accepted link until it ends; returns why it ended.
    async fn run(
        &self,
        host: &str,
        epoch: u64,
        mut sink: futures_util::stream::SplitSink<WebSocket, Message>,
        mut incoming: futures_util::stream::SplitStream<WebSocket>,
        mut frames: mpsc::UnboundedReceiver<Message>,
        mut shutdown: watch::Receiver<bool>,
    ) -> &'static str {
        let heartbeat = self.0.heartbeat;
        let mut beat = tokio::time::interval_at(
            tokio::time::Instant::now() + heartbeat.interval,
            heartbeat.interval,
        );
        beat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut missed = 0u32;
        loop {
            tokio::select! {
                frame = frames.recv() => match frame {
                    Some(frame @ Message::Close(_)) => {
                        let _ = sink.send(frame).await;
                        return "fenced";
                    }
                    Some(frame) => {
                        if sink.send(frame).await.is_err() {
                            return "write failed";
                        }
                    }
                    None => return "released",
                },
                _ = beat.tick() => {
                    if missed >= heartbeat.missed_pong_limit {
                        let _ = sink.send(close(CLOSE_HEARTBEAT, "heartbeat")).await;
                        return "heartbeat";
                    }
                    missed += 1;
                    if sink.send(text(json!({"type": "ping"}))).await.is_err() {
                        return "write failed";
                    }
                }
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        let _ = sink.send(close(CLOSE_GOING_AWAY, "shutdown")).await;
                        return "shutdown";
                    }
                }
                received = incoming.next() => match received {
                    Some(Ok(Message::Text(frame))) => match self.on_frame(host, epoch, frame.as_str()) {
                        Answer::Pong => {
                            if sink.send(text(json!({"type": "pong"}))).await.is_err() {
                                return "write failed";
                            }
                        }
                        Answer::GotPong => missed = 0,
                        Answer::Nothing => {}
                    },
                    Some(Ok(Message::Close(_))) | None => return "disconnected",
                    Some(Ok(_)) => {}
                    Some(Err(_)) => return "read failed",
                },
            }
        }
    }

    /// Applies one frame from the link at `epoch`. Frames from a link that is
    /// no longer the host's current one change nothing.
    fn on_frame(&self, host: &str, epoch: u64, frame: &str) -> Answer {
        let Ok(frame) = serde_json::from_str::<Value>(frame) else {
            tracing::debug!(%host, epoch, "host sent a frame that is not JSON");
            return Answer::Nothing;
        };
        match frame["type"].as_str() {
            Some("ping") => return Answer::Pong,
            Some("pong") => return Answer::GotPong,
            _ => {}
        }
        let mut hosts = self.0.hosts.lock().unwrap();
        let Some(state) = hosts.get_mut(host) else {
            return Answer::Nothing;
        };
        if state.link.as_ref().map(|link| link.epoch) != Some(epoch) {
            tracing::debug!(%host, epoch, "frame from a fenced host link ignored");
            return Answer::Nothing;
        }
        match frame["type"].as_str() {
            Some("event") | Some("snapshot") => {
                let (Some(session), Some(cursor)) =
                    (frame["session"].as_str(), frame["cursor"].as_str())
                else {
                    return Answer::Nothing;
                };
                if frame["event"]["kind"] == "session_closed" {
                    state.cursors.remove(session);
                } else {
                    state.cursors.insert(session.to_owned(), cursor.to_owned());
                }
            }
            Some("synced") if frame["epoch"].as_u64() == Some(epoch) => {
                if let Some(link) = state.link.as_mut() {
                    link.synced = true;
                }
                tracing::info!(%host, epoch, sessions = state.cursors.len(), "host synced");
            }
            // A stale `synced`, replies, module calls and anything newer are
            // not acted on yet.
            _ => {}
        }
        Answer::Nothing
    }

    /// Forgets the link at `epoch` if it is still the host's current one.
    fn release(&self, host: &str, epoch: u64, reason: &str) {
        let mut hosts = self.0.hosts.lock().unwrap();
        if let Some(state) = hosts.get_mut(host) {
            if state.link.as_ref().map(|link| link.epoch) == Some(epoch) {
                state.link = None;
            }
        }
        tracing::info!(%host, epoch, reason, "host link closed");
    }
}

/// What the link loop does after a frame.
enum Answer {
    Pong,
    GotPong,
    Nothing,
}

fn parse_tokens(path: &Path, raw: &str) -> HashMap<String, String> {
    let entries = match serde_json::from_str::<serde_json::Map<String, Value>>(raw) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::error!(path = %path.display(), %error, "host tokens file is not a JSON object; no host can link");
            return HashMap::new();
        }
    };
    let mut tokens = HashMap::new();
    for (host, token) in entries {
        match token.as_str().map(str::trim) {
            Some(token) if !host.trim().is_empty() && !token.is_empty() => {
                tokens.insert(host, token.to_owned());
            }
            _ => {
                tracing::warn!(path = %path.display(), %host, "host tokens entry skipped: the token must be a non-empty string")
            }
        }
    }
    tokens
}

#[cfg(test)]
#[path = "../tests/test_hosts.rs"]
mod tests;

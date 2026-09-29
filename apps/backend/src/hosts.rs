//! The service side of the host link (`docs/host-link.md`).
//!
//! Each project host runs a host agent that dials out to `/host` and keeps
//! one WebSocket open. This module owns those links: it checks the hello
//! (per-host token, host-link protocol version), gives each accepted link of a
//! host a larger link epoch and fences the older link, runs the heartbeat, and
//! keeps the registry of hosts that `/healthz` reports. Over the current link
//! of a host it sends commands and matches their replies, hands each session's
//! events, snapshots and module calls to whoever subscribed to that session,
//! and answers module calls nobody subscribed to.
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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};

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
/// How long a module call may wait for the service's answer before the host
/// agent is told it failed. The host agent gives up sooner (the speech
/// deadline for `speak`, 30 s otherwise); this only bounds a lost answer.
const MODULE_REPLY_LIMIT: Duration = Duration::from_secs(150);

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
    /// Moves on every link that comes up or goes away.
    changes: watch::Sender<u64>,
    next_command: AtomicU64,
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
    /// Counts the frames the current links delivered, so a reply and the
    /// events around it can be put in the order the host sent them.
    seq: u64,
    /// Commands sent and not yet answered, by command id.
    pending: HashMap<String, Pending>,
    /// Per session handle, where its events and module calls go.
    subscribers: HashMap<String, mpsc::UnboundedSender<SessionFrame>>,
}

/// A command waiting for its reply on the link at `epoch`.
struct Pending {
    epoch: u64,
    reply: oneshot::Sender<Result<CommandReply, CommandError>>,
}

/// A command's result, and where its reply fell among the host's frames.
#[derive(Clone, Debug, PartialEq)]
pub struct CommandReply {
    pub result: Value,
    /// Frames of this host delivered before the reply have a smaller `seq`.
    pub seq: u64,
}

/// A command on its way to a host; `reply` waits for the answer.
pub struct SentCommand {
    hosts: Hosts,
    host: String,
    name: String,
    id: String,
    answer: oneshot::Receiver<Result<CommandReply, CommandError>>,
}

impl SentCommand {
    /// Waits, at most `wait`, for the host's reply.
    pub async fn reply(self, wait: Duration) -> Result<CommandReply, CommandError> {
        let Self {
            hosts,
            host,
            name,
            id,
            answer,
        } = self;
        match tokio::time::timeout(wait, answer).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err(CommandError::new(
                "link_lost",
                format!("the link to host {host} closed before it answered"),
            )),
            Err(_) => {
                if let Some(state) = hosts.0.hosts.lock().unwrap().get_mut(&host) {
                    state.pending.remove(&id);
                }
                Err(CommandError::new(
                    "timeout",
                    format!("host {host} did not answer {name} in time"),
                ))
            }
        }
    }
}

/// Why a command did not succeed: the host agent's error code and message,
/// or `not_connected`, `link_lost` or `timeout` from this side.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl CommandError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// What a host says about one session, in the order it said it.
#[derive(Debug)]
pub enum SessionFrame {
    /// A session event; `event` is its body (`kind` and its fields).
    Event { seq: u64, event: Value },
    /// A snapshot; `info` replaces what is known about the session.
    Snapshot { seq: u64, info: Value },
    /// A call from the session's skill module, to be answered.
    ModuleCall(ModuleCall),
}

/// A module call relayed by a host agent. Answer it once; one dropped
/// unanswered is answered `failed`.
#[derive(Debug)]
pub struct ModuleCall {
    pub token: String,
    pub call: String,
    pub args: Value,
    reply: Option<oneshot::Sender<Value>>,
}

impl ModuleCall {
    /// Answers the call: `reply` carries `status`, `reason` and, optionally,
    /// `result` (`docs/host-link.md`, "Module calls").
    pub fn answer(mut self, reply: Value) {
        if let Some(sender) = self.reply.take() {
            let _ = sender.send(reply);
        }
    }
}

impl Drop for ModuleCall {
    fn drop(&mut self) {
        if let Some(sender) = self.reply.take() {
            let _ = sender.send(json!({"status": "failed", "reason": "failed"}));
        }
    }
}

/// The frame a module reply goes out as.
fn module_reply(id: &str, reply: Value) -> Value {
    let mut frame = json!({
        "type": "module_reply",
        "id": id,
        "status": reply.get("status").cloned().unwrap_or_else(|| json!("failed")),
        "reason": reply.get("reason").cloned().unwrap_or(Value::Null),
    });
    if let Some(result) = reply.get("result").filter(|result| !result.is_null()) {
        frame["result"] = result.clone();
    }
    frame
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
            changes: watch::channel(0).0,
            next_command: AtomicU64::new(1),
        }))
    }

    /// The epoch of `host`'s current link; `None` while it is not connected.
    pub fn link_epoch(&self, host: &str) -> Option<u64> {
        let hosts = self.0.hosts.lock().unwrap();
        hosts
            .get(host)
            .and_then(|state| state.link.as_ref())
            .map(|link| link.epoch)
    }

    /// Changes whenever a host's link comes up or goes away.
    pub fn changes(&self) -> watch::Receiver<u64> {
        self.0.changes.subscribe()
    }

    /// Sends command `name` over `host`'s current link and waits, at most
    /// `wait`, for its reply.
    pub async fn command(
        &self,
        host: &str,
        name: &str,
        args: Value,
        wait: Duration,
    ) -> Result<CommandReply, CommandError> {
        self.send_command(host, name, args)?.reply(wait).await
    }

    /// Queues command `name` on `host`'s current link now; its reply can be
    /// awaited later. Commands to one host go out in the order they are
    /// queued.
    pub fn send_command(
        &self,
        host: &str,
        name: &str,
        args: Value,
    ) -> Result<SentCommand, CommandError> {
        let id = format!("c{}", self.0.next_command.fetch_add(1, Ordering::Relaxed));
        let (reply, answer) = oneshot::channel();
        let not_connected =
            || CommandError::new("not_connected", format!("host {host} is not connected"));
        let mut hosts = self.0.hosts.lock().unwrap();
        let state = hosts.get_mut(host).ok_or_else(not_connected)?;
        let link = state.link.as_ref().ok_or_else(not_connected)?;
        let epoch = link.epoch;
        let frame = json!({
            "type": "command",
            "id": id,
            "epoch": epoch,
            "name": name,
            "args": args,
        });
        link.outbound
            .send(text(frame))
            .map_err(|_| not_connected())?;
        state.pending.insert(id.clone(), Pending { epoch, reply });
        tracing::debug!(%host, command = name, %id, "host command sent");
        Ok(SentCommand {
            hosts: self.clone(),
            host: host.to_owned(),
            name: name.to_owned(),
            id,
            answer,
        })
    }

    /// Where session `session` of `host` sends its events, snapshots and
    /// module calls from now on. A later subscription replaces this one.
    pub fn subscribe(&self, host: &str, session: &str) -> mpsc::UnboundedReceiver<SessionFrame> {
        let (sender, frames) = mpsc::unbounded_channel();
        self.0
            .hosts
            .lock()
            .unwrap()
            .entry(host.to_owned())
            .or_default()
            .subscribers
            .insert(session.to_owned(), sender);
        frames
    }

    /// Stops delivering `session`'s frames; its module calls are refused.
    pub fn unsubscribe(&self, host: &str, session: &str) {
        if let Some(state) = self.0.hosts.lock().unwrap().get_mut(host) {
            state.subscribers.remove(session);
        }
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
        let info = HelloInfo {
            protocol,
            git_sha: hello.git_sha,
            prime_agent: hello.prime_agent,
        };
        if protocol_status(protocol) == "incompatible" {
            let mut hosts = self.0.hosts.lock().unwrap();
            let state = hosts.entry(hello.host_id.clone()).or_default();
            // Reported unless a compatible link of the host is still up.
            if state.link.is_none() {
                state.hello = Some(info);
            }
            return Err(Refusal::IncompatibleProtocol(hello.protocol.to_string()));
        }
        Ok(self.link_up(&hello.host_id, info, outbound))
    }

    /// Makes `outbound` the host's current link: a larger epoch, the welcome
    /// queued, any older link fenced and its unanswered commands failed.
    fn link_up(
        &self,
        host: &str,
        info: HelloInfo,
        outbound: mpsc::UnboundedSender<Message>,
    ) -> u64 {
        let protocol = info.protocol;
        let mut hosts = self.0.hosts.lock().unwrap();
        let state = hosts.entry(host.to_owned()).or_default();
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
        // A command sent on the fenced link is never answered on this one.
        state.pending.clear();
        if let Some(older) = replaced {
            tracing::info!(%host, epoch = older.epoch, newer = epoch, "host link fenced by a newer link");
            let _ = older.outbound.send(close(CLOSE_FENCED, "fenced"));
        }
        tracing::info!(
            %host,
            epoch,
            protocol,
            protocol_status = protocol_status(protocol),
            git_sha = state.hello.as_ref().and_then(|hello| hello.git_sha.as_deref()).unwrap_or("unknown"),
            "host linked"
        );
        drop(hosts);
        self.0.changes.send_modify(|count| *count += 1);
        epoch
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
                        // What was queued before the shutdown (a session's
                        // `kill`) still goes out.
                        while let Ok(frame) = frames.try_recv() {
                            if matches!(frame, Message::Close(_)) || sink.send(frame).await.is_err() {
                                break;
                            }
                        }
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
        state.seq += 1;
        let seq = state.seq;
        match frame["type"].as_str() {
            Some("event") | Some("snapshot") => {
                let (Some(session), Some(cursor)) =
                    (frame["session"].as_str(), frame["cursor"].as_str())
                else {
                    return Answer::Nothing;
                };
                let closed = frame["event"]["kind"] == "session_closed";
                if closed {
                    state.cursors.remove(session);
                } else {
                    state.cursors.insert(session.to_owned(), cursor.to_owned());
                }
                if let Some(subscriber) = state.subscribers.get(session) {
                    let delivered = subscriber.send(if frame["type"] == "event" {
                        SessionFrame::Event {
                            seq,
                            event: frame["event"].clone(),
                        }
                    } else {
                        SessionFrame::Snapshot {
                            seq,
                            info: frame["info"].clone(),
                        }
                    });
                    if delivered.is_err() || closed {
                        state.subscribers.remove(session);
                    }
                }
            }
            Some("reply") => {
                let Some(id) = frame["id"].as_str() else {
                    return Answer::Nothing;
                };
                if frame["epoch"].as_u64() != Some(epoch) {
                    tracing::debug!(%host, epoch, %id, "reply for another link epoch ignored");
                    return Answer::Nothing;
                }
                let Some(pending) = state.pending.remove(id) else {
                    tracing::debug!(%host, epoch, %id, "reply for no pending command ignored");
                    return Answer::Nothing;
                };
                let outcome = if frame["ok"] == true {
                    Ok(CommandReply {
                        result: frame["result"].clone(),
                        seq,
                    })
                } else {
                    Err(CommandError::new(
                        frame["error"]["code"].as_str().unwrap_or("failed"),
                        frame["error"]["message"]
                            .as_str()
                            .unwrap_or("the host agent reported a failure"),
                    ))
                };
                let _ = pending.reply.send(outcome);
            }
            Some("module_call") => {
                let Some(id) = frame["id"].as_str().map(str::to_owned) else {
                    return Answer::Nothing;
                };
                let outbound = state.link.as_ref().map(|link| link.outbound.clone());
                let Some(outbound) = outbound else {
                    return Answer::Nothing;
                };
                let session = frame["session"].as_str().unwrap_or_default();
                let call = frame["call"].as_str().unwrap_or_default().to_owned();
                let Some(subscriber) = state.subscribers.get(session) else {
                    tracing::info!(%host, %call, "module call from a session not on a call refused");
                    let _ = outbound.send(text(module_reply(
                        &id,
                        json!({"status": "refused", "reason": "not_on_call"}),
                    )));
                    return Answer::Nothing;
                };
                let (reply, answer) = oneshot::channel();
                let delivered = subscriber.send(SessionFrame::ModuleCall(ModuleCall {
                    token: frame["token"].as_str().unwrap_or_default().to_owned(),
                    call,
                    args: frame["args"].clone(),
                    reply: Some(reply),
                }));
                if delivered.is_err() {
                    state.subscribers.remove(session);
                }
                // Answered on the link the call came from, whenever the answer
                // is ready; a call nobody answers in time failed.
                tokio::spawn(async move {
                    let reply = match tokio::time::timeout(MODULE_REPLY_LIMIT, answer).await {
                        Ok(Ok(reply)) => reply,
                        _ => json!({"status": "failed", "reason": "failed"}),
                    };
                    let _ = outbound.send(text(module_reply(&id, reply)));
                });
            }
            Some("synced") if frame["epoch"].as_u64() == Some(epoch) => {
                if let Some(link) = state.link.as_mut() {
                    link.synced = true;
                }
                tracing::info!(%host, epoch, sessions = state.cursors.len(), "host synced");
            }
            // A stale `synced` and anything newer are not acted on.
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
            state.pending.retain(|_, pending| pending.epoch != epoch);
        }
        tracing::info!(%host, epoch, reason, "host link closed");
        self.0.changes.send_modify(|count| *count += 1);
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

/// A host link without a socket, for tests of the modules that use the host
/// link: frames go through the same `on_frame` a real link's frames do.
#[cfg(test)]
pub(crate) struct FakeLink {
    hosts: Hosts,
    host: String,
    pub(crate) epoch: u64,
    frames: mpsc::UnboundedReceiver<Message>,
}

#[cfg(test)]
impl Hosts {
    /// Links `host` as if its host agent had said hello.
    pub(crate) fn connect_fake(&self, host: &str) -> FakeLink {
        let (outbound, frames) = mpsc::unbounded_channel();
        let info = HelloInfo {
            protocol: Some(HOST_LINK_PROTOCOL),
            git_sha: Some("fake".into()),
            prime_agent: None,
        };
        let epoch = self.link_up(host, info, outbound);
        FakeLink {
            hosts: self.clone(),
            host: host.to_owned(),
            epoch,
            frames,
        }
    }

    /// Drops `host`'s current link, as a disconnect would.
    pub(crate) fn disconnect_fake(&self, host: &str) {
        if let Some(epoch) = self.link_epoch(host) {
            self.release(host, epoch, "disconnected");
        }
    }
}

#[cfg(test)]
impl FakeLink {
    /// Delivers `frame` as the host agent sending it.
    pub(crate) fn send(&self, frame: Value) {
        self.hosts
            .on_frame(&self.host, self.epoch, &frame.to_string());
    }

    /// The next JSON frame the service sent, the welcome skipped; `None` once
    /// the link is closed or fenced.
    pub(crate) async fn recv(&mut self) -> Option<Value> {
        loop {
            match self.frames.recv().await? {
                Message::Text(frame) => {
                    let value: Value = serde_json::from_str(frame.as_str()).ok()?;
                    if value["type"] != "welcome" {
                        return Some(value);
                    }
                }
                Message::Close(_) => return None,
                _ => {}
            }
        }
    }
}

/// What a fake host agent does after a prompt: send session events, and
/// relay module calls the way the skill module makes them, one at a time,
/// each waiting for the service's answer.
#[cfg(test)]
#[derive(Clone, Debug)]
pub(crate) enum Step {
    /// A session event body (`kind` and its fields).
    Event(Value),
    /// A module call with the session's current call token.
    Call(&'static str, Value),
    /// A module call with a token of its own.
    CallWithToken(String, &'static str, Value),
    /// The turn goes on and never settles: no further steps, no `turn_end`.
    Hold,
    /// The turn waits until the service sends this command (a `steer`, say),
    /// which is answered as usual.
    WaitFor(&'static str),
}

/// How a fake host agent answers a command: `None` for its default answer,
/// `Some(None)` for no answer at all, `Some(Some(Ok/Err))` for this one.
#[cfg(test)]
pub(crate) type Override =
    Box<dyn FnMut(&str, &Value) -> Option<Option<Result<Value, (String, String)>>> + Send>;
#[cfg(test)]
pub(crate) type OnPrompt = Box<dyn FnMut(&str, &str) -> Vec<Step> + Send>;

/// Everything a fake host agent saw and said, for a test to check.
#[cfg(test)]
#[derive(Clone, Default)]
pub(crate) struct FakeLog(Arc<Mutex<FakeRecord>>);

#[cfg(test)]
#[derive(Default)]
pub(crate) struct FakeRecord {
    /// Every command, as `{name, args}`.
    pub(crate) commands: Vec<Value>,
    /// Every module reply the service sent.
    pub(crate) module_replies: Vec<Value>,
}

#[cfg(test)]
impl FakeLog {
    pub(crate) fn commands(&self) -> Vec<Value> {
        self.0.lock().unwrap().commands.clone()
    }
    pub(crate) fn names(&self) -> Vec<String> {
        self.commands()
            .iter()
            .map(|command| command["name"].as_str().unwrap_or_default().to_owned())
            .collect()
    }
    pub(crate) fn named(&self, name: &str) -> Vec<Value> {
        self.commands()
            .into_iter()
            .filter(|command| command["name"] == name)
            .map(|command| command["args"].clone())
            .collect()
    }
    pub(crate) fn module_replies(&self) -> Vec<Value> {
        self.0.lock().unwrap().module_replies.clone()
    }
}

/// An in-process host agent on a `FakeLink`: it creates sessions, remembers
/// their call tokens, and answers every command as `docs/host-link.md` says,
/// with `turn_start`/`turn_end` around each prompt's steps.
#[cfg(test)]
pub(crate) struct FakeHostAgent {
    pub(crate) on_prompt: OnPrompt,
    pub(crate) on_command: Option<Override>,
    pub(crate) models: Value,
}

#[cfg(test)]
impl FakeHostAgent {
    pub(crate) fn new(on_prompt: OnPrompt) -> Self {
        Self {
            on_prompt,
            on_command: None,
            models: json!([
                {"provider": "anthropic", "id": "current", "name": "Current", "reasoning": true},
                {"provider": "anthropic", "id": "next", "name": "Next", "reasoning": true},
            ]),
        }
    }

    /// Serves `link` until it closes; returns what it saw.
    pub(crate) fn serve(self, link: FakeLink) -> FakeLog {
        let log = FakeLog::default();
        tokio::spawn(self.run(link, log.clone()));
        log
    }

    async fn run(mut self, mut link: FakeLink, log: FakeLog) {
        let mut sessions = 0u32;
        let mut tokens: HashMap<String, String> = HashMap::new();
        let mut modes: HashMap<String, String> = HashMap::new();
        let mut cursor = 0u64;
        let mut calls = 0u64;
        let mut stash: std::collections::VecDeque<Value> = Default::default();
        loop {
            let frame = match stash.pop_front() {
                Some(frame) => frame,
                None => match link.recv().await {
                    Some(frame) => frame,
                    None => return,
                },
            };
            if frame["type"] == "module_reply" {
                log.0.lock().unwrap().module_replies.push(frame);
                continue;
            }
            if frame["type"] != "command" {
                continue;
            }
            let (id, name, args) = (
                frame["id"].clone(),
                frame["name"].as_str().unwrap_or_default().to_owned(),
                frame["args"].clone(),
            );
            log.0
                .lock()
                .unwrap()
                .commands
                .push(json!({"name": name, "args": args}));
            let session = args["session"].as_str().unwrap_or_default().to_owned();
            let mut event = |link: &FakeLink, session: &str, event: Value| {
                cursor += 1;
                link.send(json!({"type": "event", "session": session, "cursor": format!("boot:{cursor}"), "event": event}));
            };
            let answer = self
                .on_command
                .as_mut()
                .and_then(|answer| answer(&name, &args));
            let reply = match answer {
                Some(None) => continue,
                Some(Some(reply)) => reply,
                None => match name.as_str() {
                    "create_session" => {
                        sessions += 1;
                        let config = &args["config"];
                        let model = match (config["provider"].as_str(), config["model"].as_str()) {
                            (Some(provider), Some(model)) => json!(format!("{provider}/{model}")),
                            _ => Value::Null,
                        };
                        Ok(json!({
                            "session": format!("s{sessions}"),
                            "session_id": format!("saved-{sessions}"),
                            "name": format!("sb-{}-{sessions:08x}", args["project"].as_str().unwrap_or_default()),
                            "project": args["project"],
                            "cwd": config["cwd"],
                            "provenance": "created",
                            "busy": false,
                            "turn_open": false,
                            "model": model,
                            "thinking": config["thinking"].as_str().unwrap_or("medium"),
                            "call_mode": null,
                            "last_text": null,
                        }))
                    }
                    "join_call" => {
                        tokens.insert(
                            session.clone(),
                            args["token"].as_str().unwrap_or_default().to_owned(),
                        );
                        let mode = args["mode"].as_str().unwrap_or("foreground").to_owned();
                        modes.insert(session.clone(), mode.clone());
                        Ok(json!({"on_call": true, "mode": mode}))
                    }
                    "set_mode" => {
                        let mode = args["mode"].as_str().unwrap_or("foreground").to_owned();
                        modes.insert(session.clone(), mode.clone());
                        Ok(json!({"mode": mode}))
                    }
                    "set_model" => Ok(
                        json!({"model": format!("{}/{}", args["provider"].as_str().unwrap_or_default(), args["model"].as_str().unwrap_or_default()), "thinking": "medium"}),
                    ),
                    "set_thinking" => Ok(json!({"model": null, "thinking": args["level"]})),
                    "list_models" => Ok(json!({"models": self.models})),
                    "run_prepare" => Ok(
                        json!({"outcome": "succeeded", "exit_code": 0, "signal": null, "stdout": "", "stderr": "", "truncated": false, "duration_ms": 1}),
                    ),
                    "prompt" => Ok(json!({"sent_as": "prompt"})),
                    "steer" => Ok(json!({"sent_as": "steer"})),
                    "abort" => Ok(json!({"aborted": true})),
                    "kill" => Ok(json!({"killed": true})),
                    _ => Ok(json!({})),
                },
            };
            let ok = reply.is_ok();
            let mut frame = json!({"type": "reply", "id": id, "epoch": link.epoch, "ok": ok});
            match reply {
                Ok(result) => frame["result"] = result,
                Err((code, message)) => frame["error"] = json!({"code": code, "message": message}),
            }
            link.send(frame);
            if !ok {
                continue;
            }
            match name.as_str() {
                "prompt" => {
                    event(
                        &link,
                        &session,
                        json!({"kind": "turn_start", "cause": "input"}),
                    );
                    let message = args["message"].as_str().unwrap_or_default().to_owned();
                    let mut settles = true;
                    for step in (self.on_prompt)(&session, &message) {
                        let (token, call, call_args) = match step {
                            Step::Event(body) => {
                                event(&link, &session, body);
                                continue;
                            }
                            Step::Hold => {
                                settles = false;
                                break;
                            }
                            Step::WaitFor(wanted) => {
                                loop {
                                    let Some(frame) = link.recv().await else {
                                        return;
                                    };
                                    if frame["type"] == "command" && frame["name"] == wanted {
                                        log.0
                                            .lock()
                                            .unwrap()
                                            .commands
                                            .push(json!({"name": wanted, "args": frame["args"]}));
                                        link.send(json!({"type": "reply", "id": frame["id"], "epoch": link.epoch, "ok": true, "result": {"sent_as": wanted}}));
                                        break;
                                    }
                                    stash.push_back(frame);
                                }
                                continue;
                            }
                            Step::Call(call, call_args) => (
                                tokens.get(&session).cloned().unwrap_or_default(),
                                call,
                                call_args,
                            ),
                            Step::CallWithToken(token, call, call_args) => (token, call, call_args),
                        };
                        calls += 1;
                        let call_id = format!("m{calls}");
                        link.send(json!({"type": "module_call", "id": call_id, "session": session, "token": token, "call": call, "args": call_args}));
                        // The cell that made the call waits for its answer.
                        loop {
                            let Some(frame) = link.recv().await else {
                                return;
                            };
                            if frame["type"] == "module_reply" && frame["id"] == call_id.as_str() {
                                log.0.lock().unwrap().module_replies.push(frame);
                                break;
                            }
                            stash.push_back(frame);
                        }
                    }
                    if settles {
                        event(&link, &session, json!({"kind": "turn_end"}));
                    }
                }
                "set_model" | "set_thinking" => {
                    event(
                        &link,
                        &session,
                        json!({"kind": "state", "model": null, "thinking": args["level"]}),
                    );
                }
                "kill" => {
                    event(
                        &link,
                        &session,
                        json!({"kind": "session_closed", "reason": "killed"}),
                    );
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
#[path = "../tests/test_hosts.rs"]
mod tests;

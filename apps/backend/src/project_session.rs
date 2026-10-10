//! A project leg: a resident prime-agent session on a project host, reached
//! through its host agent (`docs/host-link.md`). `ProjectSession` sends the
//! session's commands and prompts; its `pump` reads the session's frames, hands
//! turn events to the caller turn being collected, reports self-woken turns to
//! the application, and answers module calls. The local pi process is in
//! `pi_client.rs`.
use crate::debug::{DebugBus, DebugEvent};
use crate::hosts::Subscription;
use crate::pi_client::{
    panic_message, spoken_error, tool_error_text, Activity, ActivityCallback, PiSessionError, Turn,
    SPEAK_TOOL, STREAM_LIMIT,
};
use futures_util::FutureExt;
use serde_json::{json, Value};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, PoisonError};
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

/// Distinguishes live handles that reopen the same persistent daemon session.
static NEXT_PROJECT_INSTANCE_ID: AtomicU64 = AtomicU64::new(1);

/// A module call from a project session that only the application can
/// answer (`speak`, `display`, `view`): the call, its arguments, and the call
/// token it carried. The answer is a module reply body: `status`, `reason`,
/// and optionally `result`.
#[derive(Clone, Debug)]
pub struct AgentCall {
    pub call: String,
    pub token: String,
    pub turn_id: Option<String>,
    pub cause: Option<String>,
    pub args: Value,
}
pub type ModuleCallback =
    Arc<dyn Fn(AgentCall) -> Pin<Box<dyn Future<Output = Value> + Send>> + Send + Sync>;

/// A project session turn boundary reported by the host agent. The callback
/// runs in the session pump, so a start is admitted before its module calls.
#[derive(Clone, Debug)]
pub struct ProjectTurn {
    pub instance_id: u64,
    pub token: String,
    pub turn_id: Option<String>,
    pub cause: String,
    pub ended: bool,
    pub text: String,
}
/// Answers whether the application admitted a self-woken turn's start as an
/// operation of its own; false for every other report.
pub type TurnCallback =
    Arc<dyn Fn(ProjectTurn) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;
/// Called once when the host reports that a project session closed. The PBX
/// uses this to evict a background resident without waiting for another call.
pub type SessionClosedCallback =
    Arc<dyn Fn(String, String, u64) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// How long a host agent has to answer a session command.
const SESSION_COMMAND_WAIT: Duration = Duration::from_secs(30);

/// What starts a project session: where it runs and what it is told.
#[derive(Clone)]
pub struct ProjectLaunch {
    pub host: String,
    pub project: String,
    pub cwd: String,
    /// Model spec, `provider/model:thinking`; any part may be empty.
    pub spec: String,
    /// The voice brief, put at the start of the first prompt and again on
    /// the first prompt after a compaction.
    pub brief: String,
    pub turn_timeout: Duration,
    pub on_activity: Option<ActivityCallback>,
    pub on_module: Option<ModuleCallback>,
    pub on_turn: Option<TurnCallback>,
    pub on_closed: Option<SessionClosedCallback>,
    /// Where the session's conversation is mirrored for the debug page.
    pub debug: Option<DebugBus>,
}

/// The model and effective thinking level a host agent reports for a
/// session.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionState {
    pub model: String,
    pub thinking: String,
}

impl SessionState {
    fn from_info(info: &Value) -> Self {
        Self {
            model: info["model"].as_str().unwrap_or_default().to_owned(),
            thinking: info["thinking"].as_str().unwrap_or_default().to_owned(),
        }
    }
}

/// What reaches a turn while it is being collected.
enum TurnFrame {
    Event { seq: u64, event: Value },
    Snapshot { seq: u64, info: Value },
}

struct AutonomousTurn {
    turn_id: Option<String>,
    cause: String,
    text: Vec<String>,
}

/// How the service came to hold a session, which decides its release: one
/// it created is killed, one it took over from a desk is aborted and then
/// detached, never killed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Provenance {
    Created,
    TakenOver,
}

impl Provenance {
    /// The host's word for it (`docs/host-link.md`); any word but
    /// `taken_over` is a session the service created.
    fn from_host(word: &str) -> Self {
        if word == "taken_over" {
            Self::TakenOver
        } else {
            Self::Created
        }
    }
}

/// Where a project session is in its end of life. `ProjectInner::end` is
/// its only writer, and `Lifecycle::after` its table (`docs/architecture.md`,
/// "A project session's end"). The phases that still read the session's
/// frames hold its subscription, so leaving them, or dropping the last
/// handle, ends it.
enum Lifecycle {
    /// In use: commands go out and the pump reads its frames. The
    /// subscription is held for its drop.
    Open { _subscription: Subscription },
    /// A command to it failed. The handle is not used again, but the
    /// session may still run on its host, so its release is still owed
    /// (#291), and its frames are still read so a turn already running can
    /// settle.
    Unusable { _subscription: Subscription },
    /// The host reported it closed (`session_closed`, the service's own
    /// `host_link_closed` included), and its frames are no longer read.
    /// Nothing is left to kill; a session taken over from a desk is still
    /// owed its abort and detach.
    EndedOnHost,
    /// Its release went out: a kill, or an abort and a detach. Final.
    Released,
}

/// What moves a project session through its end of life.
#[derive(Clone, Copy, Debug)]
enum LifecycleEvent {
    /// A command to the session failed (any error, the command's wait
    /// included).
    CommandFailed,
    /// The host reported the session closed.
    HostEnded,
    /// Its owner closed the handle, or the handle's last clone dropped.
    Closed,
}

/// What entering a phase leaves to do once the lifecycle lock is released.
enum Entry {
    Nothing,
    /// The handle stopped being usable without its owner closing it: the
    /// application is told (`on_closed`), so it can evict it.
    ReportClosed,
    /// The session's release goes out on its host.
    Release,
}

impl Lifecycle {
    /// The end-of-life table: the phase `event` moves this one to, and what
    /// entering it does. A phase an event does not move comes back as it
    /// was, with `Entry::Nothing`.
    fn after(self, event: LifecycleEvent, provenance: Provenance) -> (Self, Entry) {
        use LifecycleEvent::{Closed, CommandFailed, HostEnded};
        // A subscription not carried into the next phase drops here.
        match (self, event) {
            (Self::Open { _subscription }, CommandFailed) => {
                (Self::Unusable { _subscription }, Entry::ReportClosed)
            }
            (Self::Open { .. }, HostEnded) => (Self::EndedOnHost, Entry::ReportClosed),
            (Self::Open { .. } | Self::Unusable { .. }, Closed) => (Self::Released, Entry::Release),
            (Self::Unusable { .. }, HostEnded) => (Self::EndedOnHost, Entry::Nothing),
            (Self::EndedOnHost, Closed) if provenance == Provenance::TakenOver => {
                (Self::Released, Entry::Release)
            }
            (phase @ (Self::Unusable { .. } | Self::EndedOnHost | Self::Released), _) => {
                (phase, Entry::Nothing)
            }
        }
    }
}

struct ProjectInner {
    hosts: crate::hosts::Hosts,
    host: String,
    /// The daemon's live handle for the session.
    session: String,
    /// The persisted id used to reopen the resident session.
    persistent_session_id: String,
    /// Unique for each live service handle, even when it resumes the same id.
    instance_id: u64,
    label: String,
    /// Whether a release kills the session or detaches it.
    provenance: Provenance,
    /// The call token the session was last joined with; module calls must
    /// carry it.
    token: StdMutex<String>,
    turn_timeout: Duration,
    on_activity: Option<ActivityCallback>,
    on_module: Option<ModuleCallback>,
    on_turn: Option<TurnCallback>,
    on_closed: Option<SessionClosedCallback>,
    /// Observation only: nothing here waits on it.
    debug: Option<DebugBus>,
    turn_lock: Mutex<()>,
    busy: AtomicBool,
    /// Where the session is in its end of life; written only by `end`.
    lifecycle: StdMutex<Lifecycle>,
    brief: String,
    brief_due: AtomicBool,
    /// Where the events of the caller turn being collected go.
    turn: StdMutex<Option<tokio::sync::mpsc::UnboundedSender<TurnFrame>>>,
    /// An autonomous turn has no prompt collector, so keep its text and
    /// authority until the host reports turn_end.
    autonomous_turn: StdMutex<Option<AutonomousTurn>>,
    /// Turn id (empty for legacy hosts) of an autonomous turn refused because
    /// a caller operation already owned the leg. Its events must not enter the
    /// caller's collector.
    ignored_autonomous: StdMutex<Option<String>>,
}

impl ProjectInner {
    fn token(&self) -> String {
        self.token
            .lock()
            .map(|token| token.clone())
            .unwrap_or_default()
    }

    /// Hands `frame` to the turn being collected; false when there is none.
    fn to_turn(&self, frame: TurnFrame) -> bool {
        self.turn
            .lock()
            .ok()
            .and_then(|turn| turn.as_ref().map(|turn| turn.send(frame).is_ok()))
            .unwrap_or(false)
    }

    fn start_autonomous(&self, turn_id: Option<String>, cause: String) -> bool {
        let Ok(mut turn) = self.autonomous_turn.lock() else {
            return false;
        };
        if turn.is_some() {
            return false;
        }
        *turn = Some(AutonomousTurn {
            turn_id,
            cause,
            text: Vec::new(),
        });
        self.busy.store(true, Ordering::Release);
        true
    }

    fn append_autonomous_text(&self, turn_id: Option<&str>, text: &str) -> bool {
        let Ok(mut turn) = self.autonomous_turn.lock() else {
            return false;
        };
        let Some(turn) = turn.as_mut() else {
            return false;
        };
        // Modern hosts stamp every text event. A mismatched or missing id is
        // stale once this turn has an authority; legacy turns have no
        // authority and are refused by the API callback instead.
        if turn.turn_id.as_deref() != turn_id {
            return false;
        }
        let collected = turn.text.iter().map(String::len).sum::<usize>();
        if collected.saturating_add(text.len()) <= STREAM_LIMIT {
            turn.text.push(text.to_owned());
        }
        true
    }

    fn finish_autonomous(&self, turn_id: Option<&str>) -> Option<(Option<String>, String, String)> {
        let Ok(mut turn) = self.autonomous_turn.lock() else {
            return None;
        };
        let current = turn.as_ref()?;
        if current.turn_id.as_deref() != turn_id {
            return None;
        }
        let current = turn.take()?;
        self.busy.store(false, Ordering::Release);
        Some((
            current.turn_id,
            current.cause,
            current.text.join("\n").trim().to_owned(),
        ))
    }

    fn autonomous_authority(&self) -> Option<(Option<String>, String)> {
        self.autonomous_turn.lock().ok().and_then(|turn| {
            turn.as_ref()
                .map(|turn| (turn.turn_id.clone(), turn.cause.clone()))
        })
    }

    fn has_turn_collector(&self) -> bool {
        self.turn.lock().ok().is_some_and(|turn| turn.is_some())
    }

    fn ignore_autonomous(&self, turn_id: Option<&str>) {
        if let Ok(mut ignored) = self.ignored_autonomous.lock() {
            *ignored = Some(turn_id.unwrap_or_default().to_owned());
        }
    }

    fn ignored_autonomous(&self, turn_id: Option<&str>) -> bool {
        self.ignored_autonomous
            .lock()
            .ok()
            .and_then(|ignored| ignored.clone())
            .is_some_and(|ignored| ignored == turn_id.unwrap_or_default())
    }

    fn clear_ignored_autonomous(&self) {
        if let Ok(mut ignored) = self.ignored_autonomous.lock() {
            *ignored = None;
        }
    }

    /// Reports a turn boundary to the application; true when it admitted a
    /// self-woken start as an operation of its own.
    async fn report_turn(&self, event: ProjectTurn) -> bool {
        let Some(callback) = &self.on_turn else {
            return false;
        };
        let callback = Arc::clone(callback);
        match AssertUnwindSafe(callback(event)).catch_unwind().await {
            Ok(admitted) => admitted,
            Err(panic) => {
                tracing::error!(label = %self.label, panic = %panic_message(&panic), "turn callback panicked");
                false
            }
        }
    }

    fn alive(&self) -> bool {
        matches!(
            *self
                .lifecycle
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
            Lifecycle::Open { .. }
        )
    }

    /// Moves the session's end of life on `event`: the only writer of
    /// `lifecycle`. Entering `Released` queues the release here; true when
    /// the application is to be told the session closed (`lose`). A
    /// subscription the phase left drops under the lock, and takes the hosts
    /// lock to end; nothing takes this lock under that one.
    fn end(&self, event: LifecycleEvent) -> bool {
        let entry = {
            let mut lifecycle = self
                .lifecycle
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let phase = std::mem::replace(&mut *lifecycle, Lifecycle::Released);
            let (next, entry) = phase.after(event, self.provenance);
            *lifecycle = next;
            entry
        };
        match entry {
            Entry::Nothing => false,
            Entry::ReportClosed => true,
            Entry::Release => {
                self.release_in_background();
                false
            }
        }
    }

    /// Ends the handle's use for a reason other than its owner's close, and
    /// tells the application the first time.
    async fn lose(&self, event: LifecycleEvent) {
        if self.end(event) {
            self.report_closed().await;
        }
    }

    /// Queues the session's release on its host, on entry to `Released`. A
    /// session taken over from a desk is never killed: abort its active
    /// turn first, then detach it so the desk can keep owning it.
    fn release_in_background(&self) {
        let host = self.host.clone();
        let session = self.session.clone();
        let label = self.label.clone();
        let taken_over = self.provenance == Provenance::TakenOver;
        let hosts = self.hosts.clone();
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        tracing::info!(%label, "closing the project session");
        runtime.spawn(async move {
            if taken_over {
                if let Ok(abort) = hosts.send_command(&host, "abort", json!({"session": session})) {
                    if let Err(error) = abort.reply(SESSION_COMMAND_WAIT).await {
                        tracing::warn!(%label, %host, %error, "could not abort the taken-over project session");
                    }
                } else {
                    tracing::warn!(%label, %host, "could not queue abort for the taken-over project session");
                }
                match hosts.send_command(&host, "detach", json!({"session": session})) {
                    Ok(sent) => match sent.reply(SESSION_COMMAND_WAIT).await {
                        Ok(_) => tracing::info!(%label, %host, "taken-over project session detached"),
                        Err(error) => tracing::warn!(%label, %host, %error, "could not detach the taken-over project session"),
                    },
                    Err(error) => tracing::warn!(%label, %host, %error, "could not detach the taken-over project session"),
                }
            } else {
                match hosts.send_command(&host, "kill", json!({"session": session})) {
                    Ok(sent) => match sent.reply(SESSION_COMMAND_WAIT).await {
                        Ok(_) => tracing::info!(%label, %host, "project session ended"),
                        Err(error) => tracing::warn!(%label, %host, %error, "could not end the project session"),
                    },
                    Err(error) => tracing::warn!(%label, %host, %error, "could not end the project session"),
                }
            }
        });
    }

    async fn report_closed(&self) {
        if let Some(callback) = &self.on_closed {
            let callback = Arc::clone(callback);
            if let Err(panic) = AssertUnwindSafe(callback(
                self.label.clone(),
                self.persistent_session_id.clone(),
                self.instance_id,
            ))
            .catch_unwind()
            .await
            {
                tracing::error!(label = %self.label, panic = %panic_message(&panic), "session closed callback panicked");
            }
        }
    }

    fn publish(&self, event: DebugEvent) {
        if let Some(bus) = &self.debug {
            bus.publish(event);
        }
    }

    /// Mirrors a host event to the debug page: tool calls with the
    /// arguments and results new hosts send, and each assistant message.
    /// Every event is mirrored, whichever turn it belongs to.
    fn mirror_event(&self, event: &Value) {
        if !self.debug.as_ref().is_some_and(DebugBus::enabled) {
            return;
        }
        let call_id = || event["call_id"].as_str().map(str::to_owned);
        let tool = || event["tool"].as_str().unwrap_or_default().to_owned();
        let turn_id = || event["turn_id"].as_str().map(str::to_owned);
        match event["kind"].as_str() {
            Some("tool_start") => self.publish(DebugEvent::ToolStart {
                agent: self.label.clone(),
                call_id: call_id(),
                tool: tool(),
                args: event.get("args").filter(|v| !v.is_null()).cloned(),
                turn_id: turn_id(),
            }),
            Some("tool_end") => {
                let result = event.get("result").filter(|value| !value.is_null());
                self.publish(DebugEvent::ToolEnd {
                    agent: self.label.clone(),
                    call_id: call_id(),
                    tool: tool(),
                    result: result.cloned(),
                    error: (event["error"] == true).then(|| tool_error_text(result)),
                    turn_id: turn_id(),
                });
            }
            Some("text") => {
                if let Some(text) = event["text"]
                    .as_str()
                    .filter(|text| !text.trim().is_empty())
                {
                    self.publish(DebugEvent::AgentText {
                        agent: self.label.clone(),
                        turn_id: turn_id(),
                        text: text.to_owned(),
                        final_: false,
                    });
                }
            }
            _ => {}
        }
    }

    /// The whole reply of a settled turn, for the debug page.
    fn publish_final(&self, turn_id: Option<String>, text: &str) {
        if !text.trim().is_empty() {
            self.publish(DebugEvent::AgentText {
                agent: self.label.clone(),
                turn_id,
                text: text.to_owned(),
                final_: true,
            });
        }
    }

    /// What the service sent the session, for the debug page.
    fn publish_input(&self, text: &str, source: &str, utterance_id: Option<&str>) {
        self.publish(DebugEvent::AgentInput {
            agent: self.label.clone(),
            turn_id: None,
            text: text.to_owned(),
            source: source.into(),
            utterance_id: utterance_id.map(str::to_owned),
        });
    }

    async fn report_activity(&self, state: &str, tool: &str) {
        if let Some(callback) = &self.on_activity {
            let activity = Activity {
                state: state.into(),
                tool: tool.into(),
                detail: String::new(),
                label: self.label.clone(),
                leg: self.token(),
            };
            if let Err(panic) = AssertUnwindSafe(callback(activity)).catch_unwind().await {
                tracing::error!(label = %self.label, tool, panic = %panic_message(&panic), "activity callback panicked");
            }
        }
    }
}

impl Drop for ProjectInner {
    /// A session the service created dies with its last handle, so one whose
    /// transfer was cancelled half way is not left running on its host.
    fn drop(&mut self) {
        self.end(LifecycleEvent::Closed);
    }
}

/// A project leg: a resident prime-agent session on a project host, reached
/// through its host agent. Turns end on the host link's settled `turn_end`;
/// the session's module calls arrive as frames and are answered here.
#[derive(Clone)]
pub struct ProjectSession {
    inner: Arc<ProjectInner>,
}

/// Marks a turn as being collected, and clears the mark however the turn
/// ends, cancellation included.
struct Collecting<'a>(&'a ProjectInner);

impl Drop for Collecting<'_> {
    fn drop(&mut self) {
        if let Ok(mut turn) = self.0.turn.lock() {
            turn.take();
        }
        // A run the host started right behind this turn keeps the session
        // busy. Checked under the lock its start and finish set `busy` under,
        // so neither can land between the check and the store.
        let Ok(autonomous) = self.0.autonomous_turn.lock() else {
            self.0.busy.store(false, Ordering::Release);
            return;
        };
        if autonomous.is_none() {
            self.0.busy.store(false, Ordering::Release);
        }
    }
}

impl ProjectSession {
    /// Creates a resident session for `launch` on its host and starts
    /// listening to it. The session is not on the call until `join_call`.
    pub async fn create(
        hosts: &crate::hosts::Hosts,
        launch: ProjectLaunch,
    ) -> Result<(Self, SessionState), PiSessionError> {
        let (provider, model, thinking) = crate::models::parse_spec(&launch.spec);
        let mut config = json!({"cwd": launch.cwd});
        for (key, value) in [
            ("provider", provider),
            ("model", model),
            ("thinking", thinking),
        ] {
            if !value.is_empty() {
                config[key] = Value::String(value);
            }
        }
        tracing::info!(project = %launch.project, host = %launch.host, "creating a project session");
        let reply = hosts
            .command(
                &launch.host,
                "create_session",
                json!({"project": launch.project, "config": config}),
                SESSION_COMMAND_WAIT,
            )
            .await
            .map_err(|error| PiSessionError(format!("could not start a session: {error}")))?;
        Self::from_open_reply(hosts, launch, reply, None, "created", None).await
    }

    /// Reopens a saved resident session after a service restart. The host
    /// validates the cwd and project provenance before returning the live
    /// handle; this path never creates a second session.
    pub async fn open(
        hosts: &crate::hosts::Hosts,
        launch: ProjectLaunch,
        session_id: &str,
    ) -> Result<(Self, SessionState), PiSessionError> {
        if session_id.trim().is_empty() {
            return Err(PiSessionError("a saved session id is required".into()));
        }
        tracing::info!(project = %launch.project, host = %launch.host, session_id, "opening a project session");
        let reply = hosts
            .command(
                &launch.host,
                "open_session",
                json!({"session_id": session_id, "cwd": launch.cwd, "project": launch.project}),
                SESSION_COMMAND_WAIT,
            )
            .await
            .map_err(|error| PiSessionError(format!("could not open a session: {error}")))?;
        Self::from_open_reply(hosts, launch, reply, Some(session_id), "opened", None).await
    }

    /// Attaches to a live desk session in the registered folder. This never
    /// creates or reopens a daemon session; its `taken_over` provenance makes
    /// close release it with abort followed by detach.
    pub async fn attach(
        hosts: &crate::hosts::Hosts,
        launch: ProjectLaunch,
        session: &str,
    ) -> Result<(Self, SessionState), PiSessionError> {
        if session.trim().is_empty() {
            return Err(PiSessionError("a live session handle is required".into()));
        }
        tracing::info!(project = %launch.project, host = %launch.host, session, "taking over a desk session");
        let reply = hosts
            .command(
                &launch.host,
                "attach",
                json!({"session": session, "project": launch.project, "cwd": launch.cwd}),
                SESSION_COMMAND_WAIT,
            )
            .await
            .map_err(|error| PiSessionError(format!("could not take over a session: {error}")))?;
        let result = Self::from_open_reply(
            hosts,
            launch.clone(),
            reply,
            None,
            "attached",
            Some(Provenance::TakenOver),
        )
        .await;
        if result.is_err() {
            // The host persists taken_over provenance before replying. A
            // malformed success must therefore undo the attach even though no
            // session handle could be built for the pump.
            match hosts
                .command(
                    &launch.host,
                    "detach",
                    json!({"session": session}),
                    SESSION_COMMAND_WAIT,
                )
                .await
            {
                Ok(_) => {
                    tracing::info!(host = %launch.host, session, "rolled back malformed desk takeover")
                }
                Err(error) => {
                    tracing::warn!(host = %launch.host, session, %error, "could not roll back malformed desk takeover")
                }
            }
        }
        result
    }

    async fn from_open_reply(
        hosts: &crate::hosts::Hosts,
        launch: ProjectLaunch,
        reply: crate::hosts::CommandReply,
        requested_session_id: Option<&str>,
        verb: &str,
        forced_provenance: Option<Provenance>,
    ) -> Result<(Self, SessionState), PiSessionError> {
        let Some(session) = reply.result["session"].as_str().map(str::to_owned) else {
            return Err(PiSessionError(
                "the host agent did not name the new session".into(),
            ));
        };
        let (subscription, frames) = hosts.subscribe(&launch.host, &session);
        let inner = Arc::new(ProjectInner {
            hosts: hosts.clone(),
            host: launch.host,
            session,
            persistent_session_id: requested_session_id
                .map(str::to_owned)
                .or_else(|| reply.result["session_id"].as_str().map(str::to_owned))
                .unwrap_or_default(),
            instance_id: NEXT_PROJECT_INSTANCE_ID.fetch_add(1, Ordering::Relaxed),
            label: launch.project,
            provenance: forced_provenance
                .or_else(|| {
                    reply.result["provenance"]
                        .as_str()
                        .map(Provenance::from_host)
                })
                .unwrap_or(Provenance::Created),
            token: StdMutex::new(String::new()),
            turn_timeout: launch.turn_timeout,
            on_activity: launch.on_activity,
            on_module: launch.on_module,
            on_turn: launch.on_turn,
            on_closed: launch.on_closed,
            debug: launch.debug,
            turn_lock: Mutex::new(()),
            busy: AtomicBool::new(false),
            lifecycle: StdMutex::new(Lifecycle::Open {
                _subscription: subscription,
            }),
            brief: launch.brief,
            brief_due: AtomicBool::new(true),
            turn: StdMutex::new(None),
            autonomous_turn: StdMutex::new(None),
            ignored_autonomous: StdMutex::new(None),
        });
        tokio::spawn(pump(Arc::downgrade(&inner), frames));
        tracing::info!(label = %inner.label, host = %inner.host, name = reply.result["name"].as_str().unwrap_or_default(), %verb, "project session ready");
        Ok((Self { inner }, SessionState::from_info(&reply.result)))
    }

    pub fn label(&self) -> &str {
        &self.inner.label
    }

    pub fn token(&self) -> String {
        self.inner.token()
    }

    pub fn session_id(&self) -> &str {
        &self.inner.persistent_session_id
    }

    pub fn is_taken_over(&self) -> bool {
        self.inner.provenance == Provenance::TakenOver
    }

    pub fn instance_id(&self) -> u64 {
        self.inner.instance_id
    }

    pub fn busy(&self) -> bool {
        self.inner.busy.load(Ordering::Acquire)
    }
    pub fn alive(&self) -> bool {
        self.inner.alive()
    }
    pub fn same_session(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    async fn command(
        &self,
        name: &str,
        args: Value,
    ) -> Result<crate::hosts::CommandReply, PiSessionError> {
        self.send(name, args).await?.reply().await
    }

    /// Queues command `name` for this session on the host link now, ahead
    /// of anything queued after it; `HostCommand::reply` waits for the
    /// host's answer.
    async fn send(&self, name: &str, mut args: Value) -> Result<HostCommand, PiSessionError> {
        if !self.alive() {
            return Err(PiSessionError("the project session has ended".into()));
        }
        args["session"] = Value::String(self.inner.session.clone());
        match self.inner.hosts.send_command(&self.inner.host, name, args) {
            Ok(sent) => Ok(HostCommand {
                session: self.clone(),
                sent,
            }),
            Err(error) => {
                self.inner.lose(LifecycleEvent::CommandFailed).await;
                Err(PiSessionError(error.to_string()))
            }
        }
    }

    /// Puts the session on the call with `token`: module calls must carry it
    /// from now on, and any carrying an earlier one are refused.
    pub async fn join_call(
        &self,
        token: &str,
        persona: &str,
        speech_deadline_ms: u64,
    ) -> Result<(), PiSessionError> {
        self.join_call_mode(token, persona, speech_deadline_ms, "foreground")
            .await
    }

    /// Puts the session on the call in an explicit delivery mode. Background
    /// sessions stay live but the host agent refuses their speech.
    pub async fn join_call_mode(
        &self,
        token: &str,
        persona: &str,
        speech_deadline_ms: u64,
        mode: &str,
    ) -> Result<(), PiSessionError> {
        if let Ok(mut current) = self.inner.token.lock() {
            *current = token.to_owned();
        }
        self.command(
            "join_call",
            json!({"token": token, "persona": persona, "speech_deadline_ms": speech_deadline_ms, "mode": mode}),
        )
        .await
        .map(|_| ())
    }

    /// Changes delivery mode without replacing the resident session.
    pub async fn set_mode(&self, mode: &str) -> Result<(), PiSessionError> {
        self.command("set_mode", json!({"mode": mode}))
            .await
            .map(|_| ())
    }

    /// Switches the live session to `provider/model`; it keeps its history.
    pub async fn set_model(
        &self,
        provider: &str,
        model: &str,
    ) -> Result<SessionState, PiSessionError> {
        let reply = self
            .command("set_model", json!({"provider": provider, "model": model}))
            .await?;
        Ok(SessionState::from_info(&reply.result))
    }

    /// Sets the live session's thinking level; the reply has the level the
    /// model actually runs at.
    pub async fn set_thinking(&self, level: &str) -> Result<SessionState, PiSessionError> {
        let reply = self
            .command("set_thinking", json!({"level": level}))
            .await?;
        Ok(SessionState::from_info(&reply.result))
    }

    /// Ends the session on its host. Idempotent; nothing waits for the host.
    pub fn close(&self) {
        self.inner.end(LifecycleEvent::Closed);
    }

    /// Aborts the running turn, if any; the session stays. The abort is
    /// queued now, ahead of anything sent after it; nothing waits for the
    /// host.
    pub fn interrupt(&self) {
        if !self.alive() {
            return;
        }
        let inner = &self.inner;
        let sent =
            inner
                .hosts
                .send_command(&inner.host, "abort", json!({"session": inner.session}));
        let label = inner.label.clone();
        match sent {
            Ok(sent) => {
                tokio::spawn(async move {
                    if let Err(error) = sent.reply(SESSION_COMMAND_WAIT).await {
                        tracing::info!(%label, %error, "could not abort the project turn");
                    }
                });
            }
            Err(error) => tracing::info!(%label, %error, "could not abort the project turn"),
        }
    }

    pub async fn steer(
        &self,
        message: &str,
        utterance_id: Option<&str>,
    ) -> Result<(), PiSessionError> {
        self.queue_steer(message, utterance_id).await?.sent().await
    }

    /// Queues `message` as a steer of the running turn on the host link, and
    /// returns without waiting for the host. A steer is checked and queued
    /// under the caller's guards; its answer can take the host's whole
    /// command wait, and nothing needs the guards held for that.
    pub async fn queue_steer(
        &self,
        message: &str,
        utterance_id: Option<&str>,
    ) -> Result<QueuedSteer, PiSessionError> {
        let queued = if self.busy() {
            self.send("steer", json!({"message": message})).await
        } else {
            Err(PiSessionError("agent turn is no longer running".into()))
        };
        match queued {
            Ok(command) => Ok(QueuedSteer {
                command,
                message: message.to_owned(),
                utterance_id: utterance_id.map(str::to_owned),
            }),
            Err(error) => {
                tracing::info!(label = %self.inner.label, %error, "could not steer the running turn");
                Err(error)
            }
        }
    }

    /// `prompt_as` for a caller line with no utterance id. Production code
    /// always names the source; tests use this shorthand.
    #[cfg(test)]
    pub async fn prompt(&self, message: &str) -> Result<Turn, PiSessionError> {
        self.prompt_as(message, "caller", None).await
    }

    /// Sends `message` and collects the turn until the host link says it has
    /// settled. The voice brief goes first when it is due: on the first
    /// prompt, and on the first after a compaction. `source` says for the
    /// debug page what the message is (`caller`, `intro`, `foreground`), and
    /// `utterance_id` names the caller line it carries, if any.
    pub async fn prompt_as(
        &self,
        message: &str,
        source: &str,
        utterance_id: Option<&str>,
    ) -> Result<Turn, PiSessionError> {
        let _turn = self.inner.turn_lock.lock().await;
        if !self.alive() {
            return Err(PiSessionError("the project session has ended".into()));
        }
        let (sender, mut frames) = tokio::sync::mpsc::unbounded_channel();
        if let Ok(mut turn) = self.inner.turn.lock() {
            *turn = Some(sender);
        }
        self.inner.busy.store(true, Ordering::Release);
        let _collecting = Collecting(&self.inner);
        let briefed = self.inner.brief_due.swap(false, Ordering::AcqRel);
        // Published as the prompt goes out: the host's first events can be
        // read before its reply to the prompt is. The page shows the brief as
        // an input of its own, so the pane can fold it away.
        if briefed {
            self.inner.publish_input(&self.inner.brief, "brief", None);
        }
        self.inner.publish_input(message, source, utterance_id);
        let message = if briefed {
            format!("{}\n\n{message}", self.inner.brief)
        } else {
            message.to_owned()
        };
        let sent = match self.command("prompt", json!({"message": message})).await {
            Ok(reply) => reply,
            Err(error) => {
                if briefed {
                    self.inner.brief_due.store(true, Ordering::Release);
                }
                return Err(error);
            }
        };
        Ok(self.collect(&mut frames, sent.seq).await)
    }

    /// Collects the turn's text and signals until `turn_end`. Frames the
    /// host sent before the prompt's reply (`from`) belong to an earlier
    /// turn, such as the tail of one that was aborted, and are skipped.
    async fn collect(
        &self,
        frames: &mut tokio::sync::mpsc::UnboundedReceiver<TurnFrame>,
        from: u64,
    ) -> Turn {
        let label = &self.inner.label;
        let mut texts: Vec<String> = Vec::new();
        let signals = Vec::new();
        let mut error = String::new();
        let mut settled_turn = None;
        loop {
            let frame = match timeout(self.inner.turn_timeout, frames.recv()).await {
                Ok(Some(frame)) => frame,
                Ok(None) | Err(_) => {
                    tracing::warn!(%label, timeout = ?self.inner.turn_timeout, "the project agent went silent past the turn deadline");
                    self.interrupt();
                    return Turn {
                        text: String::new(),
                        signals,
                        failed: true,
                        error: "the agent stopped responding".into(),
                    };
                }
            };
            let (seq, event) = match frame {
                TurnFrame::Snapshot { seq, info } => {
                    // A host that lost track of the turn settles it here: a
                    // snapshot of an idle session is a turn that has ended.
                    if seq < from || info["turn_open"] != false || info["busy"] == true {
                        continue;
                    }
                    if texts.is_empty() {
                        if let Some(last) = info["last_text"]
                            .as_str()
                            .filter(|text| !text.trim().is_empty())
                        {
                            texts.push(last.trim().to_owned());
                        }
                    }
                    break;
                }
                TurnFrame::Event { seq, event } => (seq, event),
            };
            if seq < from {
                continue;
            }
            match event["kind"].as_str() {
                Some("text") => {
                    let Some(text) = event["text"]
                        .as_str()
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                    else {
                        continue;
                    };
                    let collected = texts.iter().map(String::len).sum::<usize>();
                    if collected.saturating_add(text.len()) > STREAM_LIMIT {
                        tracing::error!(%label, collected, limit = STREAM_LIMIT, "agent produced too much text in one turn");
                        self.interrupt();
                        return Turn {
                            text: String::new(),
                            signals,
                            failed: true,
                            error: "the agent produced too much text in one turn".into(),
                        };
                    }
                    texts.push(text.to_owned());
                }
                Some("error") => {
                    error = spoken_error(event.get("message"));
                    tracing::error!(%label, error = %error, "the agent's model call failed");
                }
                Some("turn_end") => {
                    if let Some(failure) = event.get("error").filter(|value| !value.is_null()) {
                        if error.is_empty() {
                            error = spoken_error(Some(failure));
                        }
                    }
                    settled_turn = event["turn_id"].as_str().map(str::to_owned);
                    break;
                }
                Some("session_closed") => {
                    tracing::warn!(%label, reason = event["reason"].as_str().unwrap_or_default(), "the project session closed mid-turn");
                    return Turn {
                        text: texts.join("\n"),
                        signals,
                        failed: true,
                        error: "the project session ended".into(),
                    };
                }
                _ => {}
            }
        }
        let text = texts.join("\n").trim().to_owned();
        self.inner.publish_final(settled_turn, &text);
        Turn {
            text,
            signals,
            failed: !error.is_empty(),
            error,
        }
    }
}

/// Reads a project session's frames for as long as its handle lives: turn
/// events go to the turn being collected, activity to the page, and module
/// calls are answered.
async fn pump(
    inner: std::sync::Weak<ProjectInner>,
    mut frames: tokio::sync::mpsc::UnboundedReceiver<crate::hosts::SessionFrame>,
) {
    use crate::hosts::SessionFrame;
    while let Some(frame) = frames.recv().await {
        let Some(inner) = inner.upgrade() else {
            return;
        };
        match frame {
            SessionFrame::Event { seq, event } => {
                inner.mirror_event(&event);
                let kind = event["kind"].as_str().unwrap_or_default();
                if kind == "turn_start" {
                    let cause = event["cause"].as_str().unwrap_or("unknown").to_owned();
                    let turn_id = event["turn_id"].as_str().map(str::to_owned);
                    if matches!(cause.as_str(), "autonomous" | "unknown") {
                        let start = ProjectTurn {
                            instance_id: inner.instance_id,
                            token: inner.token(),
                            turn_id: turn_id.clone(),
                            cause: cause.clone(),
                            ended: false,
                            text: String::new(),
                        };
                        if inner.has_turn_collector() {
                            // The host opens a turn only once the one before
                            // it settled. So a self-woken start seen while the
                            // caller's prompt is collected either carries that
                            // prompt (it reached a session that had just woken
                            // itself), and the collector keeps it, or it follows
                            // the caller's turn straight away: a run resumed
                            // after an external abort, or a wake queued behind
                            // the turn. The application tells them apart: it
                            // admits the start only once the caller's operation
                            // has closed, which the host's settle report of
                            // that turn does (`settle_turn`).
                            if inner.autonomous_authority().is_none()
                                && inner.report_turn(start).await
                            {
                                inner.start_autonomous(turn_id, cause);
                                inner.clear_ignored_autonomous();
                            } else {
                                inner.to_turn(TurnFrame::Event { seq, event });
                            }
                            continue;
                        }
                        if inner.start_autonomous(turn_id.clone(), cause.clone()) {
                            inner.clear_ignored_autonomous();
                            inner.report_turn(start).await;
                        } else {
                            inner.ignore_autonomous(turn_id.as_deref());
                        }
                        // With no prompt being collected, an autonomous
                        // start, admitted or refused, is no caller's turn.
                        continue;
                    } else {
                        inner.clear_ignored_autonomous();
                        inner
                            .report_turn(ProjectTurn {
                                instance_id: inner.instance_id,
                                token: inner.token(),
                                turn_id,
                                cause,
                                ended: false,
                                text: String::new(),
                            })
                            .await;
                    }
                }
                match kind {
                    "compaction" if event["phase"] == "end" => {
                        tracing::info!(label = %inner.label, "the project session compacted; the brief goes out again");
                        inner.brief_due.store(true, Ordering::Release);
                    }
                    "session_closed" => {
                        inner.lose(LifecycleEvent::HostEnded).await;
                        // A closed session never sends the `turn_end` of a
                        // self-woken run it had open, and that run's
                        // operation would keep every later caller turn
                        // waiting. End it here. Its words stay off the
                        // caller's transcript: the run was cut short, and
                        // the leg it spoke for is being retired.
                        if let Some((turn_id, _)) = inner.autonomous_authority() {
                            if let Some((turn_id, cause, text)) =
                                inner.finish_autonomous(turn_id.as_deref())
                            {
                                inner.publish_final(turn_id.clone(), &text);
                                inner
                                    .report_turn(ProjectTurn {
                                        instance_id: inner.instance_id,
                                        token: inner.token(),
                                        turn_id,
                                        cause,
                                        ended: true,
                                        text: String::new(),
                                    })
                                    .await;
                            }
                        }
                    }
                    "tool_start" => {
                        inner.report_activity("life", "").await;
                        inner
                            .report_activity("start", event["tool"].as_str().unwrap_or_default())
                            .await;
                    }
                    "tool_end" => {
                        inner
                            .report_activity("end", event["tool"].as_str().unwrap_or_default())
                            .await;
                    }
                    "text" => {
                        inner.report_activity("life", "").await;
                        let event_turn_id = event["turn_id"].as_str();
                        if inner.ignored_autonomous(event_turn_id)
                            || inner.append_autonomous_text(
                                event["turn_id"].as_str(),
                                event["text"].as_str().unwrap_or_default(),
                            )
                        {
                            continue;
                        }
                    }
                    "turn_end" => {
                        let event_turn_id = event["turn_id"].as_str();
                        if inner.ignored_autonomous(event_turn_id) {
                            inner.clear_ignored_autonomous();
                            continue;
                        }
                        if let Some((turn_id, cause, text)) = inner.finish_autonomous(event_turn_id)
                        {
                            inner.publish_final(turn_id.clone(), &text);
                            inner
                                .report_turn(ProjectTurn {
                                    instance_id: inner.instance_id,
                                    token: inner.token(),
                                    turn_id,
                                    cause,
                                    ended: true,
                                    text,
                                })
                                .await;
                            continue;
                        }
                    }
                    _ => {}
                }
                if inner.autonomous_authority().is_some() {
                    continue;
                }
                let settled = (kind == "turn_end")
                    .then(|| event["turn_id"].as_str().map(str::to_owned))
                    .flatten();
                inner.to_turn(TurnFrame::Event { seq, event });
                if let Some(turn_id) = settled {
                    // The caller's turn settled on the host. Its operation
                    // closes on this report, not when the prompt returns, so
                    // a run the host starts right behind it is admitted.
                    inner
                        .report_turn(ProjectTurn {
                            instance_id: inner.instance_id,
                            token: inner.token(),
                            turn_id: Some(turn_id),
                            cause: "input".into(),
                            ended: true,
                            text: String::new(),
                        })
                        .await;
                }
            }
            SessionFrame::Snapshot { seq, info } => {
                if inner.autonomous_authority().is_some() && info["turn_open"] == false {
                    if let Some((turn_id, cause, text)) =
                        inner.finish_autonomous(info["turn_id"].as_str())
                    {
                        let text = if text.is_empty() {
                            info["last_text"].as_str().unwrap_or_default().to_owned()
                        } else {
                            text
                        };
                        inner.publish_final(turn_id.clone(), &text);
                        inner
                            .report_turn(ProjectTurn {
                                instance_id: inner.instance_id,
                                token: inner.token(),
                                turn_id,
                                cause,
                                ended: true,
                                text,
                            })
                            .await;
                        continue;
                    }
                }
                if !inner.has_turn_collector()
                    && inner.autonomous_authority().is_none()
                    && info["turn_open"] == true
                {
                    let cause = info["cause"].as_str().unwrap_or("unknown").to_owned();
                    let turn_id = info["turn_id"].as_str().map(str::to_owned);
                    if inner.start_autonomous(turn_id.clone(), cause.clone()) {
                        inner
                            .report_turn(ProjectTurn {
                                instance_id: inner.instance_id,
                                token: inner.token(),
                                turn_id,
                                cause,
                                ended: false,
                                text: String::new(),
                            })
                            .await;
                        continue;
                    }
                }
                inner.to_turn(TurnFrame::Snapshot { seq, info });
            }
            SessionFrame::ModuleCall(call) => {
                // Keep side effects before the matching turn_end. The daemon
                // waits for this response, so awaiting here preserves turn
                // authority without introducing another lifecycle owner.
                answer_module_call(inner, call).await;
            }
        }
    }
}

/// Answers one module call. A call must carry the session's current call
/// token; routing signals become signals of the turn being collected, and
/// the rest go to the application. The call and its answer are mirrored to
/// the debug page, refusals included, after the answer is sent: the mirror
/// takes the call's fields instead of copying them, and never delays the
/// answer.
async fn answer_module_call(inner: Arc<ProjectInner>, mut call: crate::hosts::ModuleCall) {
    let reply = module_reply(&inner, &call).await;
    let ok = matches!(reply["status"].as_str(), Some("delivered" | "accepted"));
    let detail = reply.clone();
    let call_id = std::mem::take(&mut call.id);
    let name = std::mem::take(&mut call.call);
    let args = std::mem::take(&mut call.args);
    let turn_id = call.turn_id.take();
    call.answer(reply);
    inner.publish(DebugEvent::ModuleCall {
        agent: inner.label.clone(),
        call_id: call_id.clone(),
        name,
        args,
        turn_id,
    });
    inner.publish(DebugEvent::ModuleResult {
        agent: inner.label.clone(),
        call_id,
        ok,
        detail,
    });
}

/// The answer to one module call (`answer_module_call`).
async fn module_reply(inner: &ProjectInner, call: &crate::hosts::ModuleCall) -> Value {
    let label = inner.label.clone();
    if call.token.is_empty() || call.token != inner.token() {
        tracing::info!(%label, call = %call.call, "module call with a stale call token refused");
        return json!({"status": "refused", "reason": "not_on_call"});
    }
    match call.call.as_str() {
        SPEAK_TOOL | "request_to_speak" | "display" | "view" => {
            let Some(callback) = inner.on_module.clone() else {
                return json!({"status": "failed", "reason": "failed"});
            };
            let mut args = call.args.clone();
            if call.call == "request_to_speak" {
                if let Some(object) = args.as_object_mut() {
                    object.insert("_project".into(), Value::String(label.clone()));
                }
            }
            let (turn_id, cause) = match (call.turn_id.clone(), call.cause.clone()) {
                (Some(turn_id), cause) => (Some(turn_id), cause),
                (None, Some(cause)) => (None, Some(cause)),
                (None, None) => inner
                    .autonomous_authority()
                    .map(|(_, cause)| (None, Some(cause)))
                    .unwrap_or((None, None)),
            };
            let request = AgentCall {
                call: call.call.clone(),
                token: call.token.clone(),
                turn_id,
                cause,
                args,
            };
            match AssertUnwindSafe(callback(request)).catch_unwind().await {
                Ok(reply) => reply,
                Err(panic) => {
                    tracing::error!(%label, call = %call.call, panic = %panic_message(&panic), "module call handler panicked");
                    json!({"status": "failed", "reason": "failed"})
                }
            }
        }
        _ => json!({"status": "refused", "reason": "unknown_call"}),
    }
}

/// A command queued for a project session on its host link.
struct HostCommand {
    session: ProjectSession,
    sent: crate::hosts::SentCommand,
}

impl HostCommand {
    /// Waits, at most `SESSION_COMMAND_WAIT`, for the host's answer.
    async fn reply(self) -> Result<crate::hosts::CommandReply, PiSessionError> {
        match self.sent.reply(SESSION_COMMAND_WAIT).await {
            Ok(reply) => Ok(reply),
            Err(error) => {
                // A failed host command means this resident is no longer
                // usable. Mark it closed before returning so its owner can
                // evict it instead of publishing a misleading idle state.
                self.session.inner.lose(LifecycleEvent::CommandFailed).await;
                Err(PiSessionError(error.to_string()))
            }
        }
    }
}

/// A steer on the host link, not yet answered.
pub struct QueuedSteer {
    command: HostCommand,
    message: String,
    utterance_id: Option<String>,
}

impl QueuedSteer {
    /// Waits for the host to take the steer.
    pub async fn sent(self) -> Result<(), PiSessionError> {
        let Self {
            command,
            message,
            utterance_id,
        } = self;
        let session = command.session.clone();
        let label = &session.inner.label;
        match command.reply().await {
            Ok(_) => {
                tracing::info!(%label, chars = message.chars().count(), "steered the running turn");
                session
                    .inner
                    .publish_input(&message, "steer", utterance_id.as_deref());
                Ok(())
            }
            Err(error) => {
                tracing::info!(%label, %error, "could not steer the running turn");
                Err(error)
            }
        }
    }
}

#[cfg(test)]
#[path = "../tests/test_project_session.rs"]
mod tests;

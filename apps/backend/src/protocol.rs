//! The WebSocket protocol between the service and the browser, both
//! directions, one variant per `type`.
//!
//! `ServerMessage` is every message the page can receive. Its browser half is
//! `ServerMessage` in `apps/frontend/src/protocol.ts`. Both halves are held to
//! the examples in `apps/frontend/tests/fixtures/server-messages.json`: each
//! one must serialize back to itself here and decode to itself there, and a
//! variant without an example fails on both sides.
//!
//! `ClientMessage` is every command the page sends. Its browser half is the
//! builders in `protocol.ts`, one per command. Both halves are held to the
//! examples in `apps/frontend/tests/fixtures/client-messages.json`: each one
//! must be exactly what its builder sends there, and read back to itself
//! here (null fields aside, which read as absent). The round trip here is
//! what catches a renamed or wrong-kind field, in every command. The check
//! there catches a rename only in a field its builder maps by name; the
//! `screen_state` builder passes the report through, so that command is held
//! to `ScreenStateReport` by type instead. A variant without an example
//! fails here.
use crate::history::TranscriptEntry;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// The answer to `hello`: the protocol version, and which optional
    /// transports this socket uses.
    HelloAck {
        version: u64,
        stt_streaming: bool,
        audio_streaming: bool,
        mse_mp3: bool,
    },
    /// The answer to `ping`, echoing its `nonce` and `time` as they came, or
    /// null for one it did not carry.
    Pong { nonce: Value, time: Value },
    /// The turn epoch. Sent in every connection's snapshot and whenever a
    /// rescue or a new leg moves it; the browser stamps clips with it.
    Epoch { generation: u64 },
    /// A transfer began starting a leg on `route`. Clips recorded until the
    /// next `epoch` are addressed to that leg.
    Candidate { route: String, generation: u64 },
    /// The candidate leg on `route` ended, and `reason` says how. Only an
    /// adopted candidate's clips are carried to its epoch; the others stay on
    /// the stamp they were recorded under. A connection's snapshot starts
    /// with an `adopted` one when the leg on the line was adopted at the
    /// current epoch, so a tab that missed the live one still knows.
    CandidateCleared {
        route: String,
        generation: u64,
        reason: CandidateEnd,
    },
    /// The line's status: who is on it, their model and thinking level, and
    /// which of those the caller may change. The coordinator builds it from
    /// its own state (`Coordinator::status`).
    Status(Status),
    /// A clip was taken: whole, or opened as a stream (`streaming`).
    Accepted {
        id: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        streaming: bool,
    },
    /// A streaming clip cannot continue as a stream; the browser sends it
    /// whole instead.
    Abandoned { id: String, reason: String },
    /// The final transcript of a clip, or the echo of a typed turn.
    Transcript { id: String, text: String },
    /// A transcript was steered into the turn in progress, or queued behind
    /// `waiting` turns.
    Queued {
        id: String,
        waiting: u64,
        steered: bool,
    },
    /// Something the caller should see went wrong. `id` names the clip or
    /// typed turn it answers, when there is one.
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<ErrorCode>,
        message: String,
    },
    /// Jev and the conversational top-level LLM were both unavailable. This
    /// is a page error, not a spoken error, so the caller is not left hearing
    /// a synthesized apology from a failed route.
    RoutingUnavailable { message: String },
    /// A turn was dispatched to the leg on `route`.
    Thinking { route: String, waiting: u64 },
    /// A tool call on the live leg started or ended (`state` is `start` or
    /// `end`); `label` names the leg.
    Activity {
        state: String,
        tool: String,
        detail: String,
        label: String,
    },
    /// A turn settled with this reply; `voiced` says whether its text was
    /// synthesized for the caller. `sequence` names the audio utterance its
    /// speech starts with, so the page shows the line when that utterance
    /// starts to play rather than when the reply arrives (#112). It is absent
    /// when no audio carries the reply.
    Reply {
        text: String,
        route: String,
        voiced: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sequence: Option<u64>,
    },
    /// A line was spoken to the caller and kept in the transcript.
    /// `sequence` names the audio utterance that voices it, as on `reply`;
    /// absent for a line no audio carries.
    Spoken {
        entry: TranscriptEntry,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sequence: Option<u64>,
    },
    /// The transcript so far, in every connection's snapshot.
    History { entries: Vec<TranscriptEntry> },
    /// An utterance of synthesized speech begins; its audio follows as
    /// binary frames.
    AudioStart {
        generation: u64,
        sequence: u64,
        mime: String,
        format: String,
    },
    /// The utterance `sequence` has no more audio.
    AudioDone {
        generation: u64,
        sequence: u64,
        done: bool,
    },
    /// All audio for the reply to `response_id` has been sent; `success` is
    /// false when some of it could not be synthesized.
    FinalResponseAudioClosed {
        response_id: String,
        generation: u64,
        success: bool,
    },
    /// A display action for the stage. `action` is validated and normalized
    /// by `visual_protocol` and pinned by `display-actions.json`. `seq` is the
    /// delivery sequence the browser confirms it by: the socket writer stamps
    /// it on a live action (`stamp_display_seq`), and a snapshot replay
    /// carries the watermark.
    Display {
        action: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seq: Option<u64>,
    },
    /// The agent asked for a view of the workspace.
    View { target: String, reason: String },
    /// The browser's `screen_state` report was applied.
    ScreenStateAck,
    /// State of every service-tracked project agent.
    AgentsState { agents: Vec<AgentState> },
}

/// The fields of a `status` message.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
pub struct Status {
    /// `operator`, or the id of the project on the line.
    pub route: String,
    /// Display name for whoever is on the line.
    pub label: String,
    /// The model spec the leg was started with, thinking suffix included.
    pub model: String,
    /// `provider/model`, without the thinking suffix.
    pub model_name: String,
    /// The level the leg reported, else the one it was asked for.
    pub thinking: String,
    pub thinking_requested: String,
    /// Whether the leg has reported its level.
    pub thinking_confirmed: bool,
    /// The level the next project call is asked for when the caller names
    /// none.
    pub thinking_default: String,
    pub levels: Vec<String>,
    /// The models the picker offers: the catalog the leg launched with.
    pub models: Vec<ModelEntry>,
    pub models_available: bool,
    /// Why the catalog is unavailable, when it is.
    pub models_diagnostic: Option<String>,
    pub model_swaps: bool,
    pub projects: Vec<String>,
}

/// State of one resident project agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
pub struct AgentState {
    pub project: String,
    /// `busy`, `idle`, `finished`, or `waiting`.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_request: Option<AgentRequest>,
}

/// A background agent's spoken message queued for a good moment on the floor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
pub struct AgentRequest {
    pub message: String,
    pub reason: String,
}

/// One model the picker offers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
pub struct ModelEntry {
    pub provider: String,
    pub model: String,
    pub thinks: bool,
}

/// How a candidate leg ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(rename_all = "snake_case")]
pub enum CandidateEnd {
    /// It became the leg on the line; the `epoch` that follows is its own.
    Adopted,
    /// Its startup failed and the call stayed on the leg it was on.
    RolledBack,
    /// A rescue retired the call's leg, candidate and all: a hangup or a
    /// page control while it was connecting.
    Rescued,
}

/// Why an `error` needs handling beyond showing its message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The clip or typed turn was recorded for a leg the call has since left;
    /// the browser drops it rather than retrying.
    StaleEpoch,
}

impl ServerMessage {
    /// An `error` that answers no particular clip or turn.
    pub fn error(message: impl Into<String>) -> Self {
        Self::Error {
            id: None,
            code: None,
            message: message.into(),
        }
    }

    /// An `error` that answers the clip or typed turn `id`.
    pub fn error_for(id: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Error {
            id: Some(id.into()),
            code: None,
            message: message.into(),
        }
    }

    /// The message as the JSON the browser receives.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self)
            .expect("a server message holds only string-keyed JSON, so it always serializes")
    }
}

/// A command the browser sends over the WebSocket, one variant per `type`.
///
/// Reading one is lenient, as the service has always been: a field that is
/// missing or of the wrong kind is read as absent rather than refusing the
/// frame, and a field no command declares is ignored. What an absent field
/// means is up to the handler (`handle_text_frame` in `api.rs`), so every
/// field here is optional except where a command has no other reading.
#[derive(Debug, PartialEq, Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// The first frame on a socket: the protocol version, and which optional
    /// transports the page can use.
    Hello {
        #[serde(default, deserialize_with = "lenient")]
        version: Option<u64>,
        #[serde(default, deserialize_with = "lenient_object")]
        capabilities: Option<Capabilities>,
    },
    /// The page's heartbeat. `nonce` and `time` are echoed in the `pong` as
    /// they came, whatever they are, or as null when absent.
    Ping {
        #[serde(default)]
        nonce: Value,
        #[serde(default)]
        time: Value,
    },
    /// The header of a whole clip; its audio is the next binary frame.
    /// `generation` is the epoch the page held when recording started.
    Clip {
        #[serde(default, deserialize_with = "lenient")]
        id: Option<String>,
        #[serde(default, deserialize_with = "lenient")]
        mime: Option<String>,
        #[serde(default, deserialize_with = "lenient")]
        generation: Option<u64>,
    },
    /// A turn the caller typed, stamped with the epoch the page held.
    TypedTurn {
        #[serde(default, deserialize_with = "lenient")]
        id: Option<String>,
        #[serde(default, deserialize_with = "lenient")]
        generation: Option<u64>,
        #[serde(default, deserialize_with = "lenient")]
        text: Option<String>,
    },
    /// Opens (or resumes) a streaming clip.
    SttStart {
        #[serde(default, deserialize_with = "lenient")]
        clip_id: Option<String>,
        #[serde(default, deserialize_with = "lenient")]
        generation: Option<u64>,
        #[serde(default, deserialize_with = "lenient")]
        mime: Option<String>,
    },
    /// The header of a streaming clip's chunk; its audio is the next binary
    /// frame.
    SttChunk {
        #[serde(default, deserialize_with = "lenient")]
        clip_id: Option<String>,
        #[serde(default, deserialize_with = "lenient")]
        generation: Option<u64>,
        #[serde(default, deserialize_with = "lenient")]
        sequence: Option<u64>,
    },
    /// A streaming clip has no more audio.
    SttEnd {
        #[serde(default, deserialize_with = "lenient")]
        clip_id: Option<String>,
        #[serde(default, deserialize_with = "lenient")]
        generation: Option<u64>,
    },
    /// A streaming clip was abandoned by the page.
    SttCancel {
        #[serde(default, deserialize_with = "lenient")]
        clip_id: Option<String>,
        #[serde(default, deserialize_with = "lenient")]
        generation: Option<u64>,
    },
    /// What the page is showing, and which display actions it applied.
    ScreenState(ScreenState),
}

/// The transports a `hello` says the page can use.
#[derive(Debug, PartialEq, Deserialize)]
#[cfg_attr(test, derive(Serialize))]
pub struct Capabilities {
    #[serde(default, deserialize_with = "lenient")]
    pub stt_streaming: Option<bool>,
    /// The page can play synthesized speech as it streams in.
    #[serde(default, deserialize_with = "lenient")]
    pub audio_streaming: Option<bool>,
    /// The page can play `audio/mpeg` through Media Source Extensions.
    #[serde(default, deserialize_with = "lenient")]
    pub mse_mp3: Option<bool>,
}

/// The fields of a `screen_state` report.
#[derive(Debug, PartialEq, Deserialize)]
#[cfg_attr(test, derive(Serialize))]
pub struct ScreenState {
    #[serde(default, deserialize_with = "lenient")]
    pub view: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub pinned: Option<bool>,
    #[serde(default, deserialize_with = "lenient")]
    pub has_visual: Option<bool>,
    #[serde(default, deserialize_with = "lenient")]
    pub visual_kind: Option<String>,
    /// The ids of the objects on the stage, kept as the page sent them.
    #[serde(default, deserialize_with = "lenient")]
    pub object_ids: Option<Vec<Value>>,
    #[serde(default, deserialize_with = "lenient")]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub stale: Option<bool>,
    /// The epoch the report was made under.
    #[serde(default, deserialize_with = "lenient")]
    pub generation: Option<u64>,
    /// The newest display `seq` the page has applied.
    #[serde(default, deserialize_with = "lenient")]
    pub applied_seq: Option<u64>,
    #[serde(default, deserialize_with = "lenient_object")]
    pub rejected: Option<Rejection>,
}

/// A display action the page could not apply. Without a `seq` it names no
/// action and is read as absent.
#[derive(Debug, PartialEq, Deserialize)]
#[cfg_attr(test, derive(Serialize))]
pub struct Rejection {
    pub seq: u64,
    #[serde(default, deserialize_with = "lenient")]
    pub reason: Option<String>,
}

/// Why a text frame is no command at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnreadableFrame {
    /// The frame is not JSON.
    NotJson,
    /// The frame is JSON but not an object.
    NotAnObject,
    /// The object has no `type`, or one no command has.
    UnknownType,
}

impl ClientMessage {
    /// Reads a text frame from the browser.
    ///
    /// The frame is read as JSON before it is read as a command, for two
    /// reasons: the three ways a frame can be unreadable are answered
    /// differently, and a key the frame repeats keeps its last value (which
    /// reading a command straight from the text would refuse as a duplicate
    /// field). Every field is lenient, so a known type always reads.
    pub fn parse(text: &str) -> Result<Self, UnreadableFrame> {
        let value: Value = serde_json::from_str(text).map_err(|_| UnreadableFrame::NotJson)?;
        if !value.is_object() {
            return Err(UnreadableFrame::NotAnObject);
        }
        Self::deserialize(value).map_err(|_| UnreadableFrame::UnknownType)
    }
}

/// A field read as `T` when it is one, and as absent when it is anything
/// else, null included: what `Value::as_str`, `as_u64` and friends did.
fn lenient<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    Ok(T::deserialize(Value::deserialize(deserializer)?).ok())
}

/// `lenient` for a field that is an object of its own: anything but an
/// object (an array included, which serde would otherwise read as the
/// struct's fields in order) is absent.
fn lenient_object<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    Ok(match Value::deserialize(deserializer)? {
        value @ Value::Object(_) => T::deserialize(value).ok(),
        _ => None,
    })
}

#[cfg(test)]
#[path = "../tests/test_protocol.rs"]
mod tests;

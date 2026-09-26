//! The WebSocket protocol from the service to the browser: every message the
//! page can receive, one variant per `type`.
//!
//! The browser's half is `ServerMessage` in `apps/frontend/src/protocol.ts`,
//! beside the commands the page sends this way. Both halves are held to the
//! examples in `apps/frontend/tests/fixtures/server-messages.json`: each one
//! must serialize back to itself here and decode to itself there, and a
//! variant without an example fails on both sides.
use crate::history::TranscriptEntry;
use serde::Serialize;
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
    /// The candidate leg was adopted, rolled back, or rescued away.
    CandidateCleared { generation: u64 },
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
    /// A turn settled with this written reply.
    Reply { text: String, route: String },
    /// A line was spoken to the caller and kept in the transcript.
    Spoken { entry: TranscriptEntry },
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

/// One model the picker offers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
pub struct ModelEntry {
    pub provider: String,
    pub model: String,
    pub thinks: bool,
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

#[cfg(test)]
#[path = "../tests/test_protocol.rs"]
mod tests;

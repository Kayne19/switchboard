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
use serde_json::{Map, Value};

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
    /// which of those the caller may change. Carried as the PBX and the
    /// coordinator build it (see [`ServerMessage::status`]); its fields are
    /// typed in the browser and pinned by the fixture, and are typed here
    /// once the status projection itself is (#60).
    Status(Map<String, Value>),
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
    /// The status message for a status projection, from
    /// `Coordinator::status_json` or `Switchboard::status`. The projection
    /// names its own `type`, which the tag replaces.
    pub fn status(projection: Value) -> Self {
        let mut fields = match projection {
            Value::Object(fields) => fields,
            _ => Map::new(),
        };
        fields.remove("type");
        Self::Status(fields)
    }

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

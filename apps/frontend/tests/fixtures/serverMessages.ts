// Whole server messages for tests that drive the page with backend frames.
//
// The page admits a frame only as a complete message of the protocol
// (`decodeServerMessage` in src/protocol.ts), so a test names the fields it
// cares about and takes neutral values for the rest. The shapes themselves are
// pinned by server-messages.json, beside this file.
import type {
  HelloAckMessage,
  StatusMessage,
  TranscriptEntry,
} from "../../src/protocol";

export function helloAck(fields: Partial<HelloAckMessage> = {}): HelloAckMessage {
  return {
    type: "hello_ack",
    version: 1,
    stt_streaming: false,
    audio_streaming: false,
    mse_mp3: false,
    ...fields,
  };
}

export function statusMessage(fields: Partial<StatusMessage> = {}): StatusMessage {
  return {
    type: "status",
    route: "operator",
    label: "Operator",
    model: "",
    model_name: "",
    thinking: "",
    thinking_requested: "",
    thinking_confirmed: false,
    thinking_default: "",
    levels: [],
    models: [],
    models_available: true,
    models_diagnostic: null,
    model_swaps: true,
    projects: [],
    ...fields,
  };
}

// A transcript line; `route` and `ts` default to the operator and a fixed
// time, which nothing on the page shows.
export function transcriptEntry(
  fields: Pick<TranscriptEntry, "role" | "text"> & Partial<TranscriptEntry>,
): TranscriptEntry {
  return { route: "operator", ts: 1758844800, ...fields };
}

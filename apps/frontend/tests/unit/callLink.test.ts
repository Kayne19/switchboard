import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HandsFreeController,
  HandsFreeControllerOptions,
} from "../../src/hands_free";
import type { ScreenStateReport } from "../../src/controller/types";
import { CallRuntime, IDLE_TEXT } from "../../src/runtime/callRuntime";
import { helloAck } from "../fixtures/serverMessages";
import { FakeSocket } from "./fakeSocket";

/**
 * The call socket's link, phase by event, through `CallRuntime`'s public
 * API: connect, the greeting (`hello`, `hello_ack`, the snapshot `epoch`),
 * the keepalive, a dropped socket and the reconnect 1.5 s later, `retry()`,
 * and `dispose()`. Each row builds a fresh runtime over a fake socket, a fake
 * microphone and a hands-free stub that records how it was stopped, walks it
 * into a phase, applies one event, and checks everything the page and the
 * server can see: the sockets made, the frames sent, `connected` and the
 * status line, whether a clip or a typed turn may go (the snapshot), whether
 * an open socket carries a report, how hands-free was stopped, whether
 * push-to-talk still records, and whether a reconnect follows 1.5 s later.
 *
 * Timers are vitest's fake ones.
 */

type Phase =
  /** Made, not started. */
  | "idle"
  /** Started; the socket has not opened. */
  | "connecting"
  /** Open and `hello` sent; no snapshot `epoch` yet. */
  | "open"
  /** The snapshot `epoch` arrived: clips and typed turns may go. */
  | "ready"
  /** Ready, and the backend chose streaming speech-to-text. */
  | "ready, streaming"
  /** Ready; a ping is out and its pong has not come. */
  | "awaiting pong"
  /** Ready, push-to-talk recording. */
  | "recording"
  /** Ready, push-to-talk recording on a recorder that reports its stop later, as a browser's does. */
  | "recording, slow recorder"
  /** A ready socket dropped; the reconnect timer runs. */
  | "waiting"
  /** The first socket closed before it opened; the reconnect timer runs. */
  | "waiting, never open"
  /** Ready, then `retry()`: a fresh socket connects, the old one is closed. */
  | "replacing"
  /** Ready and streaming, then `retry()`. */
  | "replacing, streaming"
  /** Ready, then `retry()` whose socket cannot be made. */
  | "replace failed"
  | "disposed";

type Trigger =
  | "start"
  | "opens"
  | "opens, hello fails"
  | "hello_ack, streaming"
  | "epoch"
  | "drops"
  | "error"
  | "retry"
  | "retry, socket cannot be made"
  | "1.5 s"
  | "1.5 s, socket cannot be made"
  | "20 s"
  | "20 s, ping fails"
  | "pong"
  | "pong, other nonce"
  | "pong, 8 s"
  | "8 s"
  | "clip send fails"
  | "talk"
  | "talk, send"
  | "talk, send, new socket greeted"
  | "old socket opens"
  | "old socket closes"
  | "old socket says epoch"
  | "dispose";

interface Seen {
  /** Sockets made during the event. */
  sockets: number;
  /** The JSON frame types sent during the event, on any socket. */
  frames: string[];
  connected: boolean;
  status: string;
  error: boolean;
  /**
   * Whether a clip may go: the snapshot `epoch` has arrived
   * (`isSnapshotReady`). Null after `dispose()`: the page holds no runtime
   * then, and nothing asks.
   */
  ready: boolean | null;
  /** Whether an open socket takes a screen-state report. */
  open: boolean;
  /** Hands-free `stop` reasons during the event. */
  stops: string[];
  recording: boolean;
  /** Sockets made in the 1.5 s after the event. */
  reconnects: number;
}

interface Row {
  from: Phase;
  event: Trigger;
  seen: Seen;
}

const STREAMING_MIME = "audio/webm;codecs=opus";
const DISCONNECTED = "Disconnected. Reconnecting...";
const RETRYING = "Forcing a fresh connection and retrying...";
const KEEPALIVE = "Keepalive missed. Reconnecting...";
const CANNOT_CONNECT = "Connection error: refused";
const RECORDING = "Recording... Send when you are done, Discard to throw it away.";

const report: ScreenStateReport = {
  view: "auto",
  pinned: false,
  has_visual: false,
  visual_kind: null,
  object_ids: [],
  title: "",
  stale: false,
  generation: 1,
  applied_seq: 0,
};

/** Stops at once, handing over one chunk first; a slow one stops a moment later. */
class FakeRecorder {
  static mimeType = "audio/webm";
  static slow = false;
  state: RecordingState = "inactive";
  mimeType = FakeRecorder.mimeType;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: { error: unknown }) => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    const report = () => {
      this.ondataavailable?.({ data: new Blob(["speech"]) });
      this.onstop?.();
    };
    if (FakeRecorder.slow) queueMicrotask(report);
    else report();
  }
}

function fakePlayer() {
  return {
    addEventListener() {},
    removeEventListener() {},
    pause() {},
    removeAttribute() {},
    load() {},
    play: () => Promise.resolve(),
    src: "",
    currentTime: 0,
  } as unknown as HTMLAudioElement;
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

function harness() {
  const made: FakeSocket[] = [];
  const stops: string[] = [];
  let refuse = false;
  let handsFree!: HandsFreeControllerOptions;
  const stub = {
    toggle() {},
    stop(reason: string) {
      stops.push(reason);
    },
    epochChanged() {},
    pauseForPtt() {},
    resumeAfterPtt() {},
    replyClosed() {},
    playbackChanged() {},
    clipFailed() {},
    endAwaitedTurn() {},
  };
  const runtime = new CallRuntime({
    socketUrl: "ws://backend/ws",
    onState: () => undefined,
    onServer: () => undefined,
    createSocket: (url) => {
      if (refuse) throw new Error("refused");
      const socket = new FakeSocket(url);
      made.push(socket);
      return socket as unknown as WebSocket;
    },
    postJson: async () => ({ error: null }),
    player: fakePlayer(),
    getUserMedia: async () =>
      ({ getTracks: () => [{ stop: () => undefined }] }) as unknown as MediaStream,
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
    createHandsFree: (options) => {
      handsFree = options;
      return stub as unknown as HandsFreeController;
    },
  });
  const latest = () => made[made.length - 1];
  const refuseSockets = (value: boolean) => {
    refuse = value;
  };
  let disposed = false;
  const dispose = () => {
    disposed = true;
    runtime.dispose();
  };
  return {
    runtime,
    made,
    stops,
    latest,
    refuseSockets,
    dispose,
    disposed: () => disposed,
    handsFree: () => handsFree,
  };
}

type Harness = ReturnType<typeof harness>;

function failSends(socket: FakeSocket) {
  socket.send = () => {
    throw new Error("socket is not open");
  };
}

/** The ping the socket sent last; the test answers it by hand. */
function lastPing(socket: FakeSocket) {
  return socket.sentJson().filter((frame) => frame.type === "ping").at(-1)!;
}

async function greet(socket: FakeSocket, streaming = false) {
  socket.open();
  socket.receive(helloAck({ stt_streaming: streaming }));
  socket.receive({ type: "epoch", generation: 1 });
  await settle();
}

async function walk(h: Harness, phase: Phase): Promise<void> {
  const { runtime } = h;
  switch (phase) {
    case "idle":
      return;
    case "connecting":
      runtime.start();
      return;
    case "open":
      runtime.start();
      h.latest().open();
      await settle();
      return;
    case "ready":
      runtime.start();
      await greet(h.latest());
      return;
    case "ready, streaming":
      FakeRecorder.mimeType = STREAMING_MIME;
      runtime.start();
      await greet(h.latest(), true);
      return;
    case "awaiting pong":
      await walk(h, "ready");
      vi.advanceTimersByTime(20_000);
      return;
    case "recording":
      await walk(h, "ready");
      runtime.talk();
      await settle();
      return;
    case "recording, slow recorder":
      FakeRecorder.slow = true;
      await walk(h, "recording");
      return;
    case "waiting":
      await walk(h, "ready");
      h.latest().drop();
      await settle();
      return;
    case "waiting, never open":
      runtime.start();
      h.latest().drop();
      await settle();
      return;
    case "replacing":
      await walk(h, "ready");
      runtime.retry();
      await settle();
      return;
    case "replacing, streaming":
      await walk(h, "ready, streaming");
      runtime.retry();
      await settle();
      return;
    case "replace failed":
      await walk(h, "ready");
      h.refuseSockets(true);
      runtime.retry();
      await settle();
      h.refuseSockets(false);
      return;
    case "disposed":
      await walk(h, "ready");
      h.dispose();
      await settle();
      return;
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

async function apply(h: Harness, event: Trigger): Promise<void> {
  const { runtime } = h;
  const socket = h.latest();
  switch (event) {
    case "start":
      runtime.start();
      break;
    case "opens":
      socket.open();
      break;
    case "opens, hello fails":
      failSends(socket);
      socket.readyState = 1;
      socket.onopen?.({} as Event);
      break;
    case "hello_ack, streaming":
      socket.receive(helloAck({ stt_streaming: true }));
      break;
    case "epoch":
      socket.receive({ type: "epoch", generation: 1 });
      break;
    case "drops":
      socket.drop();
      break;
    case "error":
      socket.onerror?.({} as Event);
      break;
    case "retry":
      runtime.retry();
      break;
    case "retry, socket cannot be made":
      h.refuseSockets(true);
      runtime.retry();
      h.refuseSockets(false);
      break;
    case "1.5 s":
      vi.advanceTimersByTime(1_500);
      break;
    case "1.5 s, socket cannot be made":
      h.refuseSockets(true);
      vi.advanceTimersByTime(1_500);
      h.refuseSockets(false);
      break;
    case "20 s":
      vi.advanceTimersByTime(20_000);
      break;
    case "20 s, ping fails":
      failSends(socket);
      vi.advanceTimersByTime(20_000);
      break;
    case "pong": {
      const ping = lastPing(socket);
      socket.receive({ type: "pong", nonce: ping.nonce, time: ping.time });
      break;
    }
    case "pong, 8 s": {
      const ping = lastPing(socket);
      socket.receive({ type: "pong", nonce: ping.nonce, time: ping.time });
      vi.advanceTimersByTime(8_000);
      break;
    }
    case "pong, other nonce":
      socket.receive({ type: "pong", nonce: "someone else's", time: 0 });
      break;
    case "8 s":
      vi.advanceTimersByTime(8_000);
      break;
    case "clip send fails":
      failSends(socket);
      h.handsFree().onClip(new Blob(["speech"]), "audio/webm", 1);
      break;
    case "talk":
      runtime.talk();
      break;
    case "talk, send":
      runtime.talk();
      await settle();
      runtime.send();
      break;
    case "talk, send, new socket greeted":
      runtime.talk();
      await settle();
      runtime.send();
      await settle();
      socket.open();
      socket.receive(helloAck());
      socket.receive({ type: "epoch", generation: 1 });
      break;
    case "old socket opens":
      h.made[h.made.length - 2].open();
      break;
    case "old socket closes":
      h.made[h.made.length - 2].drop();
      break;
    case "old socket says epoch":
      h.made[h.made.length - 2].receive({ type: "epoch", generation: 1 });
      break;
    case "dispose":
      h.dispose();
      break;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
  await settle();
}

/** The JSON frame types every socket has sent so far, in the order made. */
function framesSent(made: FakeSocket[]): string[] {
  return made.flatMap((socket) => socket.sentJson().map((frame) => String(frame.type)));
}

async function play(row: Row): Promise<Seen> {
  const h = harness();
  await walk(h, row.from);
  const socketsBefore = h.made.length;
  const framesBefore = framesSent(h.made).length;
  h.stops.length = 0;
  await apply(h, row.event);
  const state = h.runtime.currentState;
  const frames = framesSent(h.made).slice(framesBefore);
  const seen: Omit<Seen, "open" | "reconnects"> = {
    sockets: h.made.length - socketsBefore,
    frames,
    connected: state.connected,
    status: state.status,
    error: state.statusError,
    ready: h.disposed() ? null : h.handsFree().isSnapshotReady(),
    stops: [...h.stops],
    recording: state.recording,
  };
  const open = h.runtime.sendScreenState(report);
  const socketsNow = h.made.length;
  vi.advanceTimersByTime(1_500);
  await settle();
  const reconnects = h.made.length - socketsNow;
  h.runtime.dispose();
  return { ...seen, open, reconnects };
}

const CONNECTING: Seen = {
  sockets: 0,
  frames: [],
  connected: false,
  status: "Connecting…",
  error: false,
  ready: false,
  open: false,
  stops: [],
  recording: false,
  reconnects: 0,
};
const OPEN: Seen = { ...CONNECTING, connected: true, status: IDLE_TEXT, open: true };
const READY: Seen = { ...OPEN, ready: true };
const DROPPED: Seen = {
  ...CONNECTING,
  connected: false,
  status: DISCONNECTED,
  error: true,
  stops: ["disconnected"],
  reconnects: 1,
};
/** A ready socket replaced by `retry()`: the line stays up, the snapshot goes. */
const REPLACING: Seen = { ...CONNECTING, connected: true, status: RETRYING };
const DISPOSED: Seen = { ...READY, ready: null, open: false };

const rows: Row[] = [
  // idle
  { from: "idle", event: "start", seen: { ...CONNECTING, sockets: 1 } },
  { from: "idle", event: "retry", seen: { ...CONNECTING, sockets: 1, status: RETRYING } },
  { from: "idle", event: "dispose", seen: { ...CONNECTING, ready: null, stops: ["dispose"] } },
  { from: "idle", event: "talk", seen: CONNECTING },

  // connecting
  { from: "connecting", event: "start", seen: CONNECTING },
  { from: "connecting", event: "opens", seen: { ...OPEN, frames: ["hello"] } },
  // `hello` cannot go: the socket is closed and its close takes the line down.
  { from: "connecting", event: "opens, hello fails", seen: DROPPED },
  { from: "connecting", event: "drops", seen: DROPPED },
  { from: "connecting", event: "error", seen: { ...CONNECTING, status: "Connection error.", error: true } },
  { from: "connecting", event: "retry", seen: { ...CONNECTING, sockets: 1, status: RETRYING } },
  { from: "connecting", event: "1.5 s", seen: CONNECTING },
  { from: "connecting", event: "talk", seen: CONNECTING },
  { from: "connecting", event: "dispose", seen: { ...CONNECTING, ready: null, stops: ["dispose"] } },

  // open
  { from: "open", event: "hello_ack, streaming", seen: OPEN },
  { from: "open", event: "epoch", seen: READY },
  { from: "open", event: "drops", seen: DROPPED },
  { from: "open", event: "20 s", seen: { ...OPEN, frames: ["ping"] } },
  { from: "open", event: "retry", seen: { ...REPLACING, sockets: 1 } },
  { from: "open", event: "dispose", seen: { ...OPEN, ready: null, open: false, stops: ["dispose"] } },

  // ready
  { from: "ready", event: "epoch", seen: READY },
  { from: "ready", event: "drops", seen: { ...DROPPED, ready: true } },
  { from: "ready", event: "error", seen: { ...READY, status: "Connection error.", error: true } },
  { from: "ready", event: "20 s", seen: { ...READY, frames: ["ping"] } },
  // A ping that cannot go replaces the socket at once, saying nothing.
  { from: "ready", event: "20 s, ping fails", seen: { ...CONNECTING, sockets: 1, connected: true, status: IDLE_TEXT } },
  { from: "ready", event: "clip send fails", seen: { ...DROPPED, ready: true } },
  { from: "ready", event: "retry", seen: { ...REPLACING, sockets: 1 } },
  { from: "ready", event: "retry, socket cannot be made", seen: { ...REPLACING, ready: true, status: CANNOT_CONNECT, error: true, reconnects: 1 } },
  { from: "ready", event: "talk", seen: { ...READY, status: RECORDING, recording: true } },
  { from: "ready", event: "dispose", seen: { ...DISPOSED, stops: ["dispose"] } },

  // ready, streaming: a push-to-talk clip streams.
  { from: "ready, streaming", event: "talk, send", seen: { ...READY, frames: ["stt_start", "stt_chunk", "stt_start", "stt_end"], status: "Transcribing 1 voice clip(s)..." } },

  // awaiting pong
  { from: "awaiting pong", event: "pong", seen: READY },
  { from: "awaiting pong", event: "pong, other nonce", seen: READY },
  { from: "awaiting pong", event: "pong, 8 s", seen: READY },
  { from: "awaiting pong", event: "8 s", seen: { ...REPLACING, sockets: 1, status: KEEPALIVE, error: true } },
  { from: "awaiting pong", event: "drops", seen: { ...DROPPED, ready: true } },

  // recording: a dropped socket finishes the take into the outbox; a replace leaves it recording.
  { from: "recording", event: "drops", seen: { ...DROPPED, ready: true } },
  // The take ends after the line went down, and the snapshot outlives the
  // socket: the clip is said to wait.
  { from: "recording, slow recorder", event: "drops", seen: { ...DROPPED, ready: true, status: "Waiting to send 1 clip(s)..." } },
  { from: "recording", event: "retry", seen: { ...REPLACING, sockets: 1, recording: true } },
  { from: "recording", event: "dispose", seen: { ...DISPOSED, status: IDLE_TEXT, stops: ["dispose"] } },

  // waiting
  { from: "waiting", event: "1.5 s", seen: { ...DROPPED, sockets: 1, stops: [], ready: false, reconnects: 0 } },
  { from: "waiting", event: "1.5 s, socket cannot be made", seen: { ...DROPPED, status: CANNOT_CONNECT, stops: [], ready: true } },
  { from: "waiting", event: "retry", seen: { ...DROPPED, sockets: 1, status: RETRYING, error: false, stops: [], ready: false, reconnects: 0 } },
  { from: "waiting", event: "talk", seen: { ...DROPPED, stops: [], ready: true, reconnects: 1 } },
  { from: "waiting", event: "dispose", seen: { ...DROPPED, stops: ["dispose"], ready: null, reconnects: 0 } },
  { from: "waiting, never open", event: "1.5 s", seen: { ...DROPPED, sockets: 1, stops: [], reconnects: 0 } },

  // replacing: the line stays up until the new socket closes or opens.
  { from: "replacing", event: "opens", seen: { ...OPEN, frames: ["hello"] } },
  { from: "replacing", event: "drops", seen: DROPPED },
  { from: "replacing", event: "talk", seen: { ...REPLACING, status: RECORDING, recording: true } },
  { from: "replacing", event: "old socket opens", seen: REPLACING },
  { from: "replacing", event: "old socket closes", seen: REPLACING },
  { from: "replacing", event: "old socket says epoch", seen: REPLACING },
  { from: "replacing", event: "1.5 s", seen: REPLACING },
  { from: "replacing", event: "dispose", seen: { ...REPLACING, ready: null, stops: ["dispose"] } },
  // The last `hello_ack`'s choice holds until the new socket opens: a take
  // begun meanwhile is a stream, though the new socket's `hello_ack` did not
  // choose streaming.
  { from: "replacing", event: "talk, send, new socket greeted", seen: { ...READY, frames: ["hello", "clip"], status: "Waiting for the server to accept your clip..." } },
  { from: "replacing, streaming", event: "talk, send, new socket greeted", seen: { ...READY, frames: ["hello", "stt_start", "stt_chunk", "stt_end"], status: "Waiting for the server to accept your clip..." } },
  { from: "replace failed", event: "1.5 s", seen: { ...REPLACING, status: CANNOT_CONNECT, error: true, sockets: 1 } },
  { from: "replace failed", event: "talk", seen: { ...REPLACING, ready: true, status: RECORDING, recording: true, reconnects: 1 } },

  // disposed
  { from: "disposed", event: "start", seen: DISPOSED },
  { from: "disposed", event: "retry", seen: { ...DISPOSED, status: RETRYING } },
  { from: "disposed", event: "1.5 s", seen: DISPOSED },
];

beforeEach(() => {
  FakeSocket.instances = [];
  FakeRecorder.mimeType = "audio/webm";
  FakeRecorder.slow = false;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the call socket link, phase by event", () => {
  it.each(rows.map((row) => [`${row.from} | ${row.event}`, row] as const))("%s", async (_name, row) => {
    expect(await play(row)).toEqual(row.seen);
  });
});

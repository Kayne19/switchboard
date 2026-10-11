import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HandsFreeController,
  type SpeechEndpointer,
  type WakeDetector,
} from "../../src/hands_free";
import { AudioPlayback } from "../../src/runtime/audioPlayback";
import { CallRuntime } from "../../src/runtime/callRuntime";
import { stubHandsFreeBrowser } from "../fixtures/handsFreeRuntime";
import { helloAck } from "../fixtures/serverMessages";
import { FakeSocket } from "./fakeSocket";

/**
 * Hands-free as the call runtime runs it, phase by event: the first load of
 * the detectors, the follow-up lease that waits for a reply's audio to drain,
 * the push-to-talk hand-off, and every page event that stops hands-free.
 * Each row builds a fresh runtime over fakes (the socket, the microphone, the
 * 16 kHz graph, the recorder, the two detectors), walks it into a phase,
 * applies one event, and checks what the page sees: the runtime's
 * `handsFree` and `handsFreeStatus`, the error on its status line, how often
 * the detectors were loaded and the microphone asked for during the event,
 * and, where a row says so, whether playback draining now opens the
 * follow-up lease.
 *
 * Timers are vitest's fake ones: a row that needs one to fire says so.
 */

type Callback = () => void;

type Phase =
  /** Connected; hands-free never switched on. */
  | "unloaded"
  /** MODE pressed; the detectors are still loading. */
  | "loading"
  /** MODE pressed; the detectors failed to load. */
  | "load failed"
  /** Loaded, then switched off with MODE. */
  | "off"
  | "armed"
  /** Armed, then push-to-talk pressed and recording. */
  | "paused_ptt"
  /** A hands-free utterance sent; no answer yet. */
  | "awaiting_response"
  /** Armed; a reply closed while its audio still plays. */
  | "reply playing"
  /** Armed; a reply closed and playback drained: the 400 ms debounce runs. */
  | "reply draining"
  /** The follow-up lease is open. */
  | "lease";

type Trigger =
  | "MODE"
  | "MODE twice"
  | "page hidden"
  | "page hidden, shown, MODE"
  | "pagehide"
  | "dispose"
  | "route"
  | "hangup"
  | "socket drops"
  | "retry"
  | "epoch, new generation"
  | "epoch, same generation"
  | "reply closed"
  | "reply failed"
  | "reply closed, old generation"
  | "playback drains"
  | "playback plays"
  | "playback plays, 400 ms"
  | "400 ms"
  | "error for the clip"
  | "error for another clip"
  | "routing unavailable"
  | "ptt press"
  | "ptt press, ptt end"
  | "ptt end"
  | "MODE, ptt end"
  | "load lands"
  | "load fails"
  | "page hidden, load lands"
  | "pagehide, load lands"
  | "dispose, load lands"
  | "route, load lands"
  | "hangup, load lands"
  | "socket drops, load lands"
  | "epoch, load lands"
  | "ptt press, load lands"
  | "reply closed, load lands";

interface Seen {
  handsFree: boolean;
  said: string;
  /** The runtime's status line when it shows an error, else null. */
  error: string | null;
  /** Detector loads started by the event. */
  loads: number;
  /** Microphones hands-free asked for during the event. */
  asked: number;
}

interface Row {
  from: Phase;
  event: Trigger;
  seen: Partial<Seen>;
  /** Whether playback draining after the row opens the follow-up lease. */
  lease?: boolean;
}

const STANDBY = "Standby";
const LOADING = "Loading the local wake-word and speech detectors...";
const LOAD_FAILED = "Hands-free detector could not load (model missing).";
const LISTENING = "Listening locally for “Damocles”.";
const OFF = "Hands-free is off.";
const HIDDEN = "Hands-free stopped while the page is hidden.";
const LEFT = "Hands-free stopped when the page was left.";
const ROUTE = "Hands-free stopped while changing the line.";
const HANGUP = "Hands-free stopped for hangup.";
const DISCONNECTED = "Hands-free stopped while disconnected.";
const CALL_CHANGED = "Hands-free stopped because the call changed.";
const PAUSED = "Hands-free paused for push-to-talk.";
const SENT = "Utterance sent; waiting for the response.";
const NO_REPLY = "No reply is coming; listening locally for “Damocles”.";
const LEASE = "Follow-up listening is open for 8 seconds. No wake word needed.";
const PTT_FIRST = "Finish push-to-talk and keep this page visible first.";
const CLIP_ERROR = "Error: I didn't catch that — say it again.";
const OTHER_ERROR = "Error: something else failed.";
const ROUTING = "Routing is unavailable.";

/** Stops at once, handing over one chunk first, as a short utterance does. */
class FakeRecorder {
  state: RecordingState = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: { error: unknown }) => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["speech"]) });
    this.onstop?.();
  }
}

function fakeContext() {
  return {
    state: "running",
    destination: {},
    audioWorklet: { addModule: async () => undefined },
    resume: async () => undefined,
    close: async () => undefined,
    createMediaStreamSource: () => ({ connect: () => undefined, disconnect: () => undefined }),
    createGain: () => ({ gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined }),
    createAnalyser: () => ({
      fftSize: 0,
      frequencyBinCount: 0,
      connect: () => undefined,
      disconnect: () => undefined,
      getFloatTimeDomainData: () => undefined,
    }),
  } as unknown as AudioContext;
}

const stream = () =>
  ({ getTracks: () => [{ stop: () => undefined }] }) as unknown as MediaStream;

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

/** Lets pending promise work run: a start, a load, a recorder. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
}

function harness() {
  let detect: Callback = () => undefined;
  let speechStart: Callback = () => undefined;
  let speechEnd: Callback = () => undefined;
  const detector: WakeDetector = {
    load: async () => undefined,
    reset: () => undefined,
    process: () => undefined,
    onDetect: (callback) => ((detect = callback), () => undefined),
    onError: () => () => undefined,
  };
  const endpointer: SpeechEndpointer = {
    load: async () => undefined,
    reset: () => undefined,
    process: () => undefined,
    onSpeechStart: (callback) => ((speechStart = callback), () => undefined),
    onSpeechEnd: (callback) => ((speechEnd = callback), () => undefined),
    onError: () => () => undefined,
  };
  const counts = { loads: 0, asked: 0 };
  let load: "lands" | "fails" | "held" = "lands";
  let held: { land: () => void; fail: () => void } | null = null;
  let drained = true;
  vi.spyOn(AudioPlayback.prototype, "isDrained").mockImplementation(() => drained);
  const page = { visibilityState: "visible" as DocumentVisibilityState };
  const documentListeners = new Map<string, EventListener>();
  const windowListeners = new Map<string, EventListener>();
  const runtime = new CallRuntime({
    socketUrl: "ws://backend/ws",
    onState: () => undefined,
    onServer: () => undefined,
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    postJson: async () => ({ error: null }),
    player: fakePlayer(),
    getUserMedia: async () => stream(),
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
    createAudioContext: fakeContext,
    loadWakeDetector: () => {
      counts.loads += 1;
      if (load === "fails") return Promise.reject(new Error("model missing"));
      if (load === "lands") return Promise.resolve(detector);
      return new Promise<WakeDetector>((resolve, reject) => {
        held = {
          land: () => resolve(detector),
          fail: () => reject(new Error("model missing")),
        };
      });
    },
    loadSpeechEndpointer: async () => endpointer,
    createHandsFree: (options) =>
      new HandsFreeController({
        ...options,
        getUserMedia: async () => {
          counts.asked += 1;
          return stream();
        },
        createAudioContext: fakeContext,
        createWorkletNode: () =>
          ({
            port: { onmessage: null, close: () => undefined },
            connect: () => undefined,
            disconnect: () => undefined,
          }) as unknown as AudioWorkletNode,
        createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
        isForeground: () => page.visibilityState === "visible",
      }),
    document: {
      get visibilityState() {
        return page.visibilityState;
      },
      addEventListener: (type: string, listener: EventListener) =>
        documentListeners.set(type, listener),
      removeEventListener: () => undefined,
    },
    window: {
      addEventListener: (type: string, listener: EventListener) =>
        windowListeners.set(type, listener),
      removeEventListener: () => undefined,
    },
  });
  const socket = () => FakeSocket.latest();
  /** Playback is not under test: this is the signal it gives on any change. */
  const playbackChanged = () =>
    (runtime as unknown as { playback: { notifyPlaybackChange(): void } }).playback.notifyPlaybackChange();
  let mark = { ...counts };
  return {
    runtime,
    socket,
    loadHolds: () => (load = "held"),
    loadFails: () => (load = "fails"),
    loadLands: () => (load = "lands"),
    land: async () => {
      held!.land();
      await settle();
    },
    fail: async () => {
      held!.fail();
      await settle();
    },
    hear: () => detect(),
    speechStarts: () => speechStart(),
    speechEnds: () => speechEnd(),
    setVisibility: (state: DocumentVisibilityState) => {
      page.visibilityState = state;
      documentListeners.get("visibilitychange")!({} as Event);
    },
    pageHide: () => windowListeners.get("pagehide")!({} as Event),
    setDrained: (value: boolean) => {
      drained = value;
      playbackChanged();
    },
    replyClosed: (generation: number, success = true) =>
      socket().receive({ type: "final_response_audio_closed", response_id: "r1", generation, success }),
    reset: () => {
      mark = { ...counts };
    },
    seen: (): Seen => {
      const state = runtime.currentState;
      return {
        handsFree: state.handsFree,
        said: state.handsFreeStatus,
        error: state.statusError ? state.status : null,
        loads: counts.loads - mark.loads,
        asked: counts.asked - mark.asked,
      };
    },
  };
}
type Harness = ReturnType<typeof harness>;

/** The page connects at generation 1: open, hello, the snapshot's epoch. */
async function connect(h: Harness): Promise<void> {
  h.runtime.start();
  const socket = h.socket();
  socket.open();
  socket.receive(helloAck());
  socket.receive({ type: "epoch", generation: 1 });
  await settle();
}

async function reach(phase: Phase): Promise<Harness> {
  const h = harness();
  await connect(h);
  switch (phase) {
    case "unloaded":
      return h;
    case "loading":
      h.loadHolds();
      h.runtime.toggleHandsFree();
      await settle();
      return h;
    case "load failed":
      h.loadFails();
      h.runtime.toggleHandsFree();
      await settle();
      h.loadLands();
      return h;
    default:
      break;
  }
  h.runtime.toggleHandsFree();
  await settle();
  expect(h.seen().said).toBe(LISTENING);
  switch (phase) {
    case "off":
      h.runtime.toggleHandsFree();
      break;
    case "armed":
      break;
    case "paused_ptt":
      h.runtime.talk();
      await settle();
      break;
    case "awaiting_response":
      h.hear();
      h.speechStarts();
      h.speechEnds();
      break;
    case "reply playing":
      h.setDrained(false);
      h.replyClosed(1);
      break;
    case "reply draining":
      h.replyClosed(1);
      break;
    case "lease":
      h.replyClosed(1);
      vi.advanceTimersByTime(400);
      break;
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
  await settle();
  return h;
}

async function apply(h: Harness, event: Trigger): Promise<void> {
  const { runtime } = h;
  switch (event) {
    case "MODE":
      runtime.toggleHandsFree();
      break;
    case "MODE twice":
      runtime.toggleHandsFree();
      await settle();
      runtime.toggleHandsFree();
      break;
    case "page hidden":
      h.setVisibility("hidden");
      break;
    case "page hidden, shown, MODE":
      h.setVisibility("hidden");
      h.setVisibility("visible");
      runtime.toggleHandsFree();
      break;
    case "pagehide":
      h.pageHide();
      break;
    case "dispose":
      runtime.dispose();
      break;
    case "route":
      runtime.selectRoute("operator");
      break;
    case "hangup":
      void runtime.hangup();
      break;
    case "socket drops":
      h.socket().drop();
      break;
    case "retry":
      runtime.retry();
      break;
    case "epoch, new generation":
      h.socket().receive({ type: "epoch", generation: 2 });
      break;
    case "epoch, same generation":
      h.socket().receive({ type: "epoch", generation: 1 });
      break;
    case "reply closed":
      h.replyClosed(1);
      break;
    case "reply failed":
      h.replyClosed(1, false);
      break;
    case "reply closed, old generation":
      h.replyClosed(0);
      break;
    case "playback drains":
      h.setDrained(true);
      break;
    case "playback plays":
      h.setDrained(false);
      break;
    case "playback plays, 400 ms":
      h.setDrained(false);
      vi.advanceTimersByTime(400);
      break;
    case "400 ms":
      vi.advanceTimersByTime(400);
      break;
    case "error for the clip": {
      const clip = h.socket()
        .sentJson()
        .filter((frame) => frame.type === "clip")
        .at(-1)?.id;
      expect(clip).toBeDefined();
      h.socket().receive({ type: "error", id: clip, message: "I didn't catch that — say it again." });
      break;
    }
    case "error for another clip":
      h.socket().receive({ type: "error", id: "another", message: "something else failed." });
      break;
    case "routing unavailable":
      h.socket().receive({ type: "routing_unavailable", message: ROUTING });
      break;
    case "ptt press":
      runtime.talk();
      break;
    case "ptt press, ptt end":
      runtime.talk();
      await settle();
      runtime.send();
      break;
    case "ptt end":
      runtime.send();
      break;
    case "MODE, ptt end":
      runtime.toggleHandsFree();
      await settle();
      runtime.send();
      break;
    case "load lands":
      await h.land();
      break;
    case "load fails":
      await h.fail();
      break;
    case "page hidden, load lands":
      h.setVisibility("hidden");
      await h.land();
      break;
    case "pagehide, load lands":
      h.pageHide();
      await h.land();
      break;
    case "dispose, load lands":
      runtime.dispose();
      await h.land();
      break;
    case "route, load lands":
      runtime.selectRoute("operator");
      await h.land();
      break;
    case "hangup, load lands":
      void runtime.hangup();
      await h.land();
      break;
    case "socket drops, load lands":
      h.socket().drop();
      await h.land();
      break;
    case "epoch, load lands":
      h.socket().receive({ type: "epoch", generation: 2 });
      await h.land();
      break;
    case "ptt press, load lands":
      runtime.talk();
      await settle();
      await h.land();
      break;
    case "reply closed, load lands":
      h.replyClosed(1);
      await h.land();
      break;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
  await settle();
}

const ON = { handsFree: true };
const STOPPED = { handsFree: false };

// prettier-ignore
const rows: Row[] = [
  // Nothing is loaded, so nothing stops: the runtime keeps its own line.
  { from: "unloaded", event: "MODE", seen: { ...ON, said: LISTENING, loads: 1, asked: 1 } },
  { from: "unloaded", event: "page hidden", seen: { ...STOPPED, said: STANDBY } },
  { from: "unloaded", event: "pagehide", seen: { ...STOPPED, said: STANDBY } },
  { from: "unloaded", event: "socket drops", seen: { ...STOPPED, said: STANDBY } },
  { from: "unloaded", event: "epoch, new generation", seen: { ...STOPPED, said: STANDBY } },
  { from: "unloaded", event: "ptt press", seen: { ...STOPPED, said: STANDBY } },
  { from: "unloaded", event: "reply closed", seen: { ...STOPPED, said: STANDBY }, lease: false },

  // Loading: MODE waits for it, and a page event does not reach it.
  { from: "loading", event: "MODE", seen: { ...ON, said: LOADING, loads: 0, asked: 0 } },
  { from: "loading", event: "load lands", seen: { ...ON, said: LISTENING, asked: 1 } },
  { from: "loading", event: "load fails", seen: { ...STOPPED, said: LOAD_FAILED, error: LOAD_FAILED, asked: 0 } },
  { from: "loading", event: "page hidden", seen: { ...ON, said: LOADING } },
  { from: "loading", event: "page hidden, load lands", seen: { ...STOPPED, said: PTT_FIRST, error: PTT_FIRST, asked: 0 } },
  { from: "loading", event: "pagehide, load lands", seen: { ...ON, said: LISTENING, asked: 1 } },
  // A disposed page publishes nothing more; what counts is that no microphone opens.
  { from: "loading", event: "dispose, load lands", seen: { asked: 0 } },
  { from: "loading", event: "route, load lands", seen: { ...ON, said: LISTENING, asked: 1 } },
  { from: "loading", event: "hangup, load lands", seen: { ...ON, said: LISTENING, asked: 1 } },
  { from: "loading", event: "socket drops, load lands", seen: { ...ON, said: LISTENING, asked: 1 } },
  { from: "loading", event: "epoch, load lands", seen: { ...ON, said: LISTENING, asked: 1 } },
  { from: "loading", event: "ptt press, load lands", seen: { ...STOPPED, said: PTT_FIRST, error: PTT_FIRST, asked: 0 } },
  { from: "loading", event: "reply closed, load lands", seen: { ...ON, said: LISTENING, asked: 1 }, lease: true },

  // A load that failed is tried again by the next MODE; nothing else reaches it.
  { from: "load failed", event: "MODE", seen: { ...ON, said: LISTENING, loads: 1, asked: 1 } },
  { from: "load failed", event: "page hidden", seen: { ...STOPPED, said: LOAD_FAILED } },
  { from: "load failed", event: "socket drops", seen: { ...STOPPED, said: LOAD_FAILED } },

  // Loaded and off: MODE starts without loading again; a stop says why.
  { from: "off", event: "MODE", seen: { ...ON, said: LISTENING, loads: 0, asked: 1 } },
  { from: "off", event: "page hidden", seen: { ...STOPPED, said: HIDDEN } },
  { from: "off", event: "pagehide", seen: { ...STOPPED, said: LEFT } },
  { from: "off", event: "dispose", seen: { ...STOPPED, said: LEFT } },
  { from: "off", event: "route", seen: { ...STOPPED, said: ROUTE } },
  { from: "off", event: "hangup", seen: { ...STOPPED, said: HANGUP } },
  { from: "off", event: "socket drops", seen: { ...STOPPED, said: DISCONNECTED } },
  { from: "off", event: "epoch, new generation", seen: { ...STOPPED, said: OFF } },
  { from: "off", event: "retry", seen: { ...STOPPED, said: OFF } },
  { from: "off", event: "reply closed", seen: { ...STOPPED, said: OFF }, lease: false },

  // Armed: every page stop turns it off and says why.
  { from: "armed", event: "MODE", seen: { ...STOPPED, said: OFF } },
  { from: "armed", event: "page hidden", seen: { ...STOPPED, said: HIDDEN } },
  { from: "armed", event: "pagehide", seen: { ...STOPPED, said: LEFT } },
  { from: "armed", event: "dispose", seen: { ...STOPPED, said: LEFT } },
  { from: "armed", event: "route", seen: { ...STOPPED, said: ROUTE } },
  { from: "armed", event: "hangup", seen: { ...STOPPED, said: HANGUP } },
  { from: "armed", event: "socket drops", seen: { ...STOPPED, said: DISCONNECTED } },
  { from: "armed", event: "retry", seen: { ...ON, said: LISTENING } },
  { from: "armed", event: "epoch, new generation", seen: { ...STOPPED, said: CALL_CHANGED } },
  { from: "armed", event: "epoch, same generation", seen: { ...STOPPED, said: CALL_CHANGED } },
  // A reply to a push-to-talk turn opens the lease from `armed` too.
  { from: "armed", event: "reply closed", seen: { ...ON, said: LISTENING }, lease: true },
  { from: "armed", event: "reply failed", seen: { ...ON, said: LISTENING }, lease: false },
  { from: "armed", event: "reply closed, old generation", seen: { ...ON, said: LISTENING }, lease: false },
  { from: "armed", event: "error for another clip", seen: { ...ON, said: LISTENING, error: OTHER_ERROR } },
  { from: "armed", event: "routing unavailable", seen: { ...ON, said: LISTENING, error: ROUTING } },
  { from: "armed", event: "ptt press", seen: { ...ON, said: PAUSED } },
  { from: "armed", event: "playback plays", seen: { ...ON, said: LISTENING } },

  // Push-to-talk holds the microphone; its end hands it back.
  { from: "paused_ptt", event: "ptt end", seen: { ...ON, said: LISTENING, asked: 1 } },
  { from: "paused_ptt", event: "MODE", seen: { ...STOPPED, said: OFF } },
  { from: "paused_ptt", event: "MODE, ptt end", seen: { ...STOPPED, said: OFF, asked: 0 } },
  { from: "paused_ptt", event: "page hidden", seen: { ...STOPPED, said: HIDDEN } },
  { from: "paused_ptt", event: "socket drops", seen: { ...STOPPED, said: DISCONNECTED, asked: 0 } },
  { from: "paused_ptt", event: "epoch, new generation", seen: { ...STOPPED, said: CALL_CHANGED } },

  // Waiting on the clip hands-free sent.
  { from: "awaiting_response", event: "error for the clip", seen: { ...ON, said: NO_REPLY, error: CLIP_ERROR } },
  { from: "awaiting_response", event: "error for another clip", seen: { ...ON, said: SENT, error: OTHER_ERROR } },
  { from: "awaiting_response", event: "routing unavailable", seen: { ...ON, said: NO_REPLY, error: ROUTING } },
  { from: "awaiting_response", event: "reply failed", seen: { ...ON, said: NO_REPLY } },
  { from: "awaiting_response", event: "reply closed", seen: { ...ON, said: SENT }, lease: true },
  { from: "awaiting_response", event: "reply closed, old generation", seen: { ...ON, said: SENT }, lease: false },
  { from: "awaiting_response", event: "epoch, new generation", seen: { ...STOPPED, said: CALL_CHANGED } },
  { from: "awaiting_response", event: "socket drops", seen: { ...STOPPED, said: DISCONNECTED } },

  // A reply closed while its audio plays: the lease waits for the drain.
  { from: "reply playing", event: "playback drains", seen: { ...ON, said: LISTENING }, lease: true },
  { from: "reply playing", event: "400 ms", seen: { ...ON, said: LISTENING }, lease: true },
  { from: "reply playing", event: "reply failed", seen: { ...ON, said: LISTENING }, lease: false },
  { from: "reply playing", event: "reply closed, old generation", seen: { ...ON, said: LISTENING }, lease: true },
  // MODE off keeps the waiting reply; a page stop drops it.
  { from: "reply playing", event: "MODE twice", seen: { ...ON, said: LISTENING, asked: 1 }, lease: true },
  { from: "reply playing", event: "page hidden, shown, MODE", seen: { ...ON, said: LISTENING, asked: 1 }, lease: false },
  { from: "reply playing", event: "epoch, same generation", seen: { ...STOPPED, said: CALL_CHANGED }, lease: false },
  // A reconnect waits for the snapshot's epoch, which drops the reply.
  { from: "reply playing", event: "retry", seen: { ...ON, said: LISTENING }, lease: false },
  { from: "reply playing", event: "ptt press", seen: { ...ON, said: PAUSED }, lease: false },
  { from: "reply playing", event: "ptt press, ptt end", seen: { ...ON, said: LISTENING, asked: 1 }, lease: true },

  // Drained: the lease opens 400 ms later unless playback starts again.
  { from: "reply draining", event: "400 ms", seen: { ...ON, said: LEASE } },
  { from: "reply draining", event: "playback plays, 400 ms", seen: { ...ON, said: LISTENING }, lease: true },
  { from: "reply draining", event: "reply closed", seen: { ...ON, said: LISTENING }, lease: true },
  { from: "reply draining", event: "reply failed", seen: { ...ON, said: LISTENING }, lease: false },
  { from: "reply draining", event: "epoch, new generation", seen: { ...STOPPED, said: CALL_CHANGED }, lease: false },
  { from: "reply draining", event: "hangup", seen: { ...STOPPED, said: HANGUP }, lease: false },

  // The lease is open.
  { from: "lease", event: "reply closed", seen: { ...ON, said: LEASE }, lease: true },
  { from: "lease", event: "page hidden", seen: { ...STOPPED, said: HIDDEN } },
  { from: "lease", event: "epoch, new generation", seen: { ...STOPPED, said: CALL_CHANGED } },
];

describe("hands-free in the call runtime, phase by event", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
    stubHandsFreeBrowser();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const row of rows) {
    it(`${row.from} | ${row.event}`, async () => {
      const h = await reach(row.from);
      h.reset();
      await apply(h, row.event);
      const seen = h.seen();
      expect(seen).toMatchObject({ loads: 0, asked: 0, ...row.seen });
      if (row.lease !== undefined) {
        h.setDrained(true);
        vi.advanceTimersByTime(400);
        expect(h.seen().said === LEASE, "the follow-up lease opens").toBe(row.lease);
      }
      h.runtime.dispose();
    });
  }
});

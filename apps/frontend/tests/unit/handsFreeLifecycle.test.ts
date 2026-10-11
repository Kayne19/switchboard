// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HandsFreeController,
  type HandsFreeState,
  type SpeechEndpointer,
  type WakeDetector,
} from "../../src/hands_free";

/**
 * Hands-free's lifecycle, phase by event (#366). Each row builds a fresh
 * controller over fakes, walks it into a phase, applies one event, and checks
 * what the event did as the page sees it: the states published (in order) and
 * the last message, how often each detector was reset, the microphone asked
 * for and released, the 16 kHz contexts closed, the recorder started and
 * stopped, the clips handed to the page, and whether a microphone frame
 * reached the wake detector. Then it checks the phase the row left hands-free
 * in.
 *
 * The recorder's `stop()` does not fire `stop` by itself, so the phase
 * between asking the recorder to stop and its `stop` event (`finishing`) can
 * be seen. Timers fire only when a row fires them, by their length.
 */

type Callback = () => void;
type ErrorCallback = (error: unknown) => void;

type Phase =
  | "off"
  | "error"
  /** The start waits on the worklet module. */
  | "starting"
  | "paused_ptt"
  | "armed"
  | "wake_grace"
  /** Capturing, nothing recorded yet. */
  | "capturing"
  /** A chunk recorded, the recorder asked to stop; its `stop` event has not fired. */
  | "finishing"
  | "awaiting_response"
  | "lease"
  /** A follow-up capture, nothing recorded yet. */
  | "lease_capturing"
  /** A follow-up capture with a chunk recorded, the recorder asked to stop. */
  | "lease_finishing";

type Event =
  | "enable"
  | "enable, ptt held"
  | "disable"
  | "ptt press"
  | "ptt end"
  | "epoch"
  | "follow-up"
  | "follow-up, old generation"
  | "no reply"
  | "wake"
  | "speech start"
  | "speech start, no snapshot"
  | "speech start, no recorder"
  | "speech start, start throws"
  | "speech end"
  | "speech end, stop throws"
  | "detector fails"
  | "grace lapses"
  | "capped"
  | "lease expires"
  | "lease tick"
  | "data"
  | "recorder stops"
  | "recorder stops, clip refused"
  | "recorder error"
  | "late stop"
  | "start completes"
  | "start fails"
  | "frame";

interface Seen {
  /** States published by the event, in order. */
  published: HandsFreeState[];
  /** The last message published, or null when nothing was published. */
  said: string | null;
  /** Wake detector and speech endpointer resets. */
  resets: [number, number];
  /** `getUserMedia` calls. */
  asked: number;
  /** Microphone tracks stopped. */
  released: number;
  /** 16 kHz contexts closed. */
  closed: number;
  /** Recorder `start()` and `stop()` calls. */
  starts: number;
  stops: number;
  /** Clips handed to the page (`onClip` calls). */
  clips: number;
  /** Frames the wake detector was fed. */
  heard: number;
}

interface Row {
  from: Phase;
  event: Event;
  seen: Partial<Seen>;
  then: Phase;
}

const NOTHING: Seen = {
  published: [],
  said: null,
  resets: [0, 0],
  asked: 0,
  released: 0,
  closed: 0,
  starts: 0,
  stops: 0,
  clips: 0,
  heard: 0,
};

const OFF = "Hands-free is off.";
const LISTENING = "Listening locally for “Damocles”.";
const PAUSED = "Hands-free paused for push-to-talk.";
const WAKE = "Wake word heard. Speak now.";
const GRACE_LAPSED = "Wake heard; speak within 2 seconds.";
const CAPTURING = "Capturing speech locally; silence will end it.";
const SENT = "Utterance sent; waiting for the response.";
const NOTHING_KEPT = "No utterance was retained.";
const NOT_SENT = "The utterance could not be sent; say the wake word again.";
const NO_REPLY = "No reply is coming; listening locally for “Damocles”.";
const LEASE = "Follow-up listening is open for 8 seconds. No wake word needed.";
const LEASE_CLOSED = "Follow-up window closed; wake word required again.";
const LEASE_CLOSED_CAPTURING = "Follow-up window closed; finishing the current utterance.";
const CALL_CHANGED = "Hands-free stopped because the call changed.";
const PTT_FIRST = "Finish push-to-talk and keep this page visible first.";
const DETECTOR_FAILED = "Hands-free detector failed (Error).";
const START_FAILED = "Hands-free could not start (Error).";

class TableRecorder {
  static starts = 0;
  static stops = 0;
  state: RecordingState = "inactive";
  mimeType = "audio/webm";
  startThrows = false;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: { error: unknown }) => void) | null = null;
  start() {
    if (this.startThrows) throw new Error("start refused");
    TableRecorder.starts += 1;
    this.state = "recording";
  }
  stop() {
    TableRecorder.stops += 1;
    this.state = "inactive";
  }
}

function stubBrowser() {
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => undefined },
  });
  vi.stubGlobal("AudioContext", class {});
  vi.stubGlobal("AudioWorkletNode", class {});
  vi.stubGlobal("MediaRecorder", {
    isTypeSupported: (mime: string) => mime === "audio/webm;codecs=opus",
  });
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function harness() {
  let detect: Callback = () => undefined;
  let detectorFails: ErrorCallback = () => undefined;
  let speechStart: Callback = () => undefined;
  let speechEnd: Callback = () => undefined;
  const counts = { detectorResets: 0, endpointerResets: 0, heard: 0, asked: 0, released: 0, closed: 0, clips: 0 };
  const detector: WakeDetector = {
    load: async () => undefined,
    reset: () => void (counts.detectorResets += 1),
    process: () => void (counts.heard += 1),
    onDetect: (callback) => ((detect = callback), () => undefined),
    onError: (callback) => ((detectorFails = callback), () => undefined),
  };
  const endpointer: SpeechEndpointer = {
    load: async () => undefined,
    reset: () => void (counts.endpointerResets += 1),
    process: () => undefined,
    onSpeechStart: (callback) => ((speechStart = callback), () => undefined),
    onSpeechEnd: (callback) => ((speechEnd = callback), () => undefined),
    onError: () => () => undefined,
  };
  const recorders: TableRecorder[] = [];
  const timers = new Map<number, { handler: () => void; timeout: number }>();
  let timerIds = 0;
  let ptt = false;
  let snapshotReady = true;
  let acceptClips = true;
  let nextRecorder: "ok" | "create throws" | "start throws" = "ok";
  let module: { resolve: () => void; reject: (error: unknown) => void } | null = null;
  let holdModule = false;
  const published: Array<[HandsFreeState, string]> = [];
  const port = { onmessage: null as ((event: MessageEvent) => void) | null, close: () => undefined };
  const instance = new HandsFreeController({
    getUserMedia: async () => {
      counts.asked += 1;
      return { getTracks: () => [{ stop: () => void (counts.released += 1) }] } as unknown as MediaStream;
    },
    createAudioContext: () =>
      ({
        state: "running",
        destination: {},
        audioWorklet: {
          addModule: () =>
            holdModule
              ? new Promise<void>((resolve, reject) => {
                  module = { resolve, reject };
                })
              : Promise.resolve(),
        },
        resume: async () => undefined,
        close: async () => void (counts.closed += 1),
        createMediaStreamSource: () => ({ connect: () => undefined, disconnect: () => undefined }),
        createGain: () => ({ gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined }),
      }) as unknown as AudioContext,
    createRecorder: () => {
      if (nextRecorder === "create throws") throw new Error("no codec");
      const recorder = new TableRecorder();
      recorder.startThrows = nextRecorder === "start throws";
      recorders.push(recorder);
      return recorder as unknown as MediaRecorder;
    },
    createWorkletNode: () =>
      ({ port, connect: () => undefined, disconnect: () => undefined }) as unknown as AudioWorkletNode,
    wakeDetector: detector,
    speechEndpointer: endpointer,
    now: () => 0,
    setTimeout: (handler, timeout) => {
      const id = ++timerIds;
      timers.set(id, { handler, timeout });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => void timers.delete(timer as unknown as number),
    isForeground: () => true,
    isSnapshotReady: () => snapshotReady,
    currentEpoch: () => 4,
    isPttActive: () => ptt,
    onClip: () => {
      counts.clips += 1;
      return acceptClips ? `clip-${counts.clips}` : null;
    },
    onState: (detail) => published.push([detail.state, detail.message]),
  });
  let mark = { ...counts, published: 0, starts: 0, stops: 0 };
  return {
    instance,
    recorders,
    latest: () => recorders[recorders.length - 1],
    hear: () => detect(),
    failDetector: () => detectorFails(new Error("engine gone")),
    speechStarts: () => speechStart(),
    speechEnds: () => speechEnd(),
    holdModule: () => (holdModule = true),
    module: () => module!,
    holdPtt: (held: boolean) => (ptt = held),
    loseSnapshot: () => (snapshotReady = false),
    refuseClips: () => (acceptClips = false),
    nextRecorder: (how: typeof nextRecorder) => (nextRecorder = how),
    frame: () => port.onmessage?.({ data: { type: "audio", samples: new Float32Array(4) } } as MessageEvent),
    /** Fires the pending timers of this length. */
    fire: (timeout: number) => {
      for (const [id, timer] of [...timers]) {
        if (timer.timeout !== timeout || !timers.has(id)) continue;
        timers.delete(id);
        timer.handler();
      }
    },
    /** Starts counting this row's effects from here. */
    reset: () => {
      mark = { ...counts, published: published.length, starts: TableRecorder.starts, stops: TableRecorder.stops };
    },
    seen: (): Seen => {
      const own = published.slice(mark.published);
      return {
        published: own.map(([state]) => state),
        said: own.length ? own[own.length - 1][1] : null,
        resets: [counts.detectorResets - mark.detectorResets, counts.endpointerResets - mark.endpointerResets],
        asked: counts.asked - mark.asked,
        released: counts.released - mark.released,
        closed: counts.closed - mark.closed,
        starts: TableRecorder.starts - mark.starts,
        stops: TableRecorder.stops - mark.stops,
        clips: counts.clips - mark.clips,
        heard: counts.heard - mark.heard,
      };
    },
  };
}
type Harness = ReturnType<typeof harness>;

async function reach(phase: Phase): Promise<Harness> {
  const h = harness();
  switch (phase) {
    case "off":
      break;
    case "error":
      h.holdPtt(true);
      await h.instance.enable();
      h.holdPtt(false);
      break;
    case "starting":
      h.holdModule();
      void h.instance.enable();
      await settle();
      break;
    default: {
      expect(await h.instance.enable()).toBe(true);
      if (phase === "paused_ptt") {
        h.holdPtt(true);
        h.instance.pauseForPtt();
      }
      if (phase === "wake_grace" || phase === "capturing" || phase === "finishing" || phase === "awaiting_response") {
        h.hear();
        if (phase !== "wake_grace") h.speechStarts();
      }
      if (phase === "finishing" || phase === "awaiting_response") {
        h.latest().ondataavailable!({ data: new Blob(["words"]) });
        h.speechEnds();
      }
      if (phase === "awaiting_response") h.latest().onstop!();
      if (phase === "lease" || phase === "lease_capturing" || phase === "lease_finishing") {
        h.instance.replyClosed(4, true);
        h.fire(400);
      }
      if (phase === "lease_capturing" || phase === "lease_finishing") h.speechStarts();
      if (phase === "lease_finishing") {
        h.latest().ondataavailable!({ data: new Blob(["words"]) });
        h.speechEnds();
      }
    }
  }
  h.reset();
  return h;
}

async function apply(h: Harness, event: Event): Promise<void> {
  switch (event) {
    case "enable":
      void h.instance.enable();
      return settle();
    case "enable, ptt held":
      h.holdPtt(true);
      void h.instance.enable();
      return settle();
    case "disable":
      return h.instance.disable();
    case "ptt press":
      h.holdPtt(true);
      return h.instance.pauseForPtt();
    case "ptt end":
      h.holdPtt(false);
      h.instance.resumeAfterPtt();
      return settle();
    case "epoch":
      return h.instance.epochChanged();
    case "follow-up":
      h.instance.replyClosed(4, true);
      return h.fire(400);
    case "follow-up, old generation":
      h.instance.replyClosed(3, true);
      return h.fire(400);
    case "no reply":
      return h.instance.endAwaitedTurn();
    case "wake":
      return h.hear();
    case "speech start":
      return h.speechStarts();
    case "speech start, no snapshot":
      h.loseSnapshot();
      return h.speechStarts();
    case "speech start, no recorder":
      h.nextRecorder("create throws");
      return h.speechStarts();
    case "speech start, start throws":
      h.nextRecorder("start throws");
      return h.speechStarts();
    case "speech end":
      return h.speechEnds();
    case "speech end, stop throws":
      h.latest().stop = () => {
        throw new Error("stop refused");
      };
      return h.speechEnds();
    case "detector fails":
      return h.failDetector();
    case "grace lapses":
      return h.fire(2_000);
    case "capped":
      return h.fire(30_000);
    case "lease expires":
      return h.fire(8_000);
    case "lease tick":
      return h.fire(250);
    case "data":
      return h.latest().ondataavailable!({ data: new Blob(["more"]) });
    case "recorder stops":
      h.latest().state = "inactive";
      return h.latest().onstop!();
    case "recorder stops, clip refused":
      h.refuseClips();
      h.latest().state = "inactive";
      return h.latest().onstop!();
    case "recorder error":
      h.latest().state = "inactive";
      return h.latest().onerror!({ error: new Error("encoder failed") });
    case "late stop":
      return h.recorders[0].onstop!();
    case "start completes":
      h.module().resolve();
      return settle();
    case "start fails":
      h.module().reject(new Error("worklet missing"));
      return settle();
    case "frame":
      return h.frame();
  }
}

function expectPhase(h: Harness, then: Phase): void {
  const { instance } = h;
  const recorder = h.latest()?.state ?? "inactive";
  const looks: Record<Phase, [HandsFreeState, boolean, boolean, RecordingState | null]> = {
    off: ["off", false, false, null],
    error: ["error", false, false, null],
    starting: ["starting", true, false, null],
    paused_ptt: ["paused_ptt", true, false, null],
    armed: ["armed", true, false, null],
    wake_grace: ["wake_grace", true, false, null],
    capturing: ["capturing", true, true, "recording"],
    finishing: ["capturing", true, true, "inactive"],
    awaiting_response: ["awaiting_response", true, false, null],
    lease: ["lease", true, false, null],
    lease_capturing: ["lease_capturing", true, true, "recording"],
    lease_finishing: ["lease_capturing", true, true, "inactive"],
  };
  const [state, enabled, capturing, recording] = looks[then];
  expect([instance.currentState, instance.isEnabled, instance.isCapturing]).toEqual([state, enabled, capturing]);
  if (recording) expect(recorder, "the capture's recorder").toBe(recording);
}

/** Leaving a phase that holds the 16 kHz graph releases it and resets both detectors. */
const LET_GO = { released: 1, closed: 1, resets: [1, 1] as [number, number] };
const QUIET = { resets: [1, 1] as [number, number] };

const rows: Row[] = [
  { from: "off", event: "enable", seen: { published: ["starting", "armed"], said: LISTENING, asked: 1, ...QUIET }, then: "armed" },
  { from: "off", event: "enable, ptt held", seen: { published: ["error"], said: PTT_FIRST }, then: "error" },
  { from: "off", event: "disable", seen: { published: ["off"], said: OFF, ...QUIET }, then: "off" },
  { from: "off", event: "ptt press", seen: {}, then: "off" },
  { from: "off", event: "ptt end", seen: {}, then: "off" },
  { from: "off", event: "epoch", seen: {}, then: "off" },
  { from: "off", event: "follow-up", seen: {}, then: "off" },
  { from: "off", event: "no reply", seen: {}, then: "off" },
  { from: "off", event: "wake", seen: {}, then: "off" },
  { from: "off", event: "speech start", seen: {}, then: "off" },
  { from: "off", event: "detector fails", seen: {}, then: "off" },

  { from: "error", event: "enable", seen: { published: ["starting", "armed"], said: LISTENING, asked: 1, ...QUIET }, then: "armed" },
  { from: "error", event: "enable, ptt held", seen: { published: ["error"], said: PTT_FIRST }, then: "error" },
  { from: "error", event: "disable", seen: { published: ["off"], said: OFF, ...QUIET }, then: "off" },
  { from: "error", event: "ptt press", seen: {}, then: "error" },
  { from: "error", event: "epoch", seen: {}, then: "error" },
  { from: "error", event: "detector fails", seen: {}, then: "error" },

  // A start holds what it makes until it installs it; a start that is left
  // releases it itself when its last wait ends (#261).
  { from: "starting", event: "start completes", seen: { published: ["armed"], said: LISTENING, ...QUIET }, then: "armed" },
  { from: "starting", event: "start fails", seen: { published: ["error"], said: START_FAILED, released: 1, closed: 1, ...QUIET }, then: "error" },
  { from: "starting", event: "enable", seen: {}, then: "starting" },
  { from: "starting", event: "disable", seen: { published: ["off"], said: OFF, ...QUIET }, then: "off" },
  { from: "starting", event: "ptt press", seen: { published: ["paused_ptt"], said: PAUSED, ...QUIET }, then: "paused_ptt" },
  { from: "starting", event: "epoch", seen: { published: ["off"], said: CALL_CHANGED, ...QUIET }, then: "off" },
  { from: "starting", event: "detector fails", seen: { published: ["error"], said: DETECTOR_FAILED, ...QUIET }, then: "error" },
  // A follow-up lease opens only where hands-free listens and no capture runs.
  { from: "starting", event: "follow-up", seen: {}, then: "starting" },
  { from: "starting", event: "wake", seen: {}, then: "starting" },
  { from: "starting", event: "speech start", seen: {}, then: "starting" },

  { from: "paused_ptt", event: "ptt end", seen: { published: ["starting", "armed"], said: LISTENING, asked: 1, ...QUIET }, then: "armed" },
  { from: "paused_ptt", event: "ptt press", seen: { published: ["paused_ptt"], said: PAUSED, ...QUIET }, then: "paused_ptt" },
  { from: "paused_ptt", event: "disable", seen: { published: ["off"], said: OFF, ...QUIET }, then: "off" },
  { from: "paused_ptt", event: "epoch", seen: { published: ["off"], said: CALL_CHANGED, ...QUIET }, then: "off" },
  { from: "paused_ptt", event: "detector fails", seen: { published: ["error"], said: DETECTOR_FAILED, ...QUIET }, then: "error" },
  { from: "paused_ptt", event: "follow-up", seen: {}, then: "paused_ptt" },
  { from: "paused_ptt", event: "no reply", seen: {}, then: "paused_ptt" },
  { from: "paused_ptt", event: "frame", seen: {}, then: "paused_ptt" },

  { from: "armed", event: "enable", seen: {}, then: "armed" },
  { from: "armed", event: "disable", seen: { published: ["off"], said: OFF, ...LET_GO }, then: "off" },
  { from: "armed", event: "ptt press", seen: { published: ["paused_ptt"], said: PAUSED, ...LET_GO }, then: "paused_ptt" },
  { from: "armed", event: "epoch", seen: { published: ["off"], said: CALL_CHANGED, ...LET_GO }, then: "off" },
  { from: "armed", event: "detector fails", seen: { published: ["error"], said: DETECTOR_FAILED, ...LET_GO }, then: "error" },
  // A reply to a push-to-talk turn opens the follow-up lease from `armed`.
  { from: "armed", event: "follow-up", seen: { published: ["lease"], said: LEASE, resets: [0, 1] }, then: "lease" },
  { from: "armed", event: "follow-up, old generation", seen: {}, then: "armed" },
  { from: "armed", event: "no reply", seen: {}, then: "armed" },
  { from: "armed", event: "wake", seen: { published: ["wake_grace"], said: WAKE, resets: [0, 1] }, then: "wake_grace" },
  { from: "armed", event: "speech start", seen: {}, then: "armed" },
  { from: "armed", event: "speech end", seen: {}, then: "armed" },
  { from: "armed", event: "frame", seen: { heard: 1 }, then: "armed" },

  { from: "wake_grace", event: "speech start", seen: { published: ["capturing"], said: CAPTURING, starts: 1 }, then: "capturing" },
  { from: "wake_grace", event: "speech start, no snapshot", seen: {}, then: "wake_grace" },
  // Today a recorder that cannot be made or started says so, then turns
  // hands-free off over it.
  { from: "wake_grace", event: "speech start, no recorder", seen: { published: ["error", "off"], said: OFF, ...LET_GO }, then: "off" },
  { from: "wake_grace", event: "speech start, start throws", seen: { published: ["error", "off"], said: OFF, ...LET_GO }, then: "off" },
  { from: "wake_grace", event: "grace lapses", seen: { published: ["armed"], said: GRACE_LAPSED, ...QUIET }, then: "armed" },
  { from: "wake_grace", event: "wake", seen: {}, then: "wake_grace" },
  { from: "wake_grace", event: "follow-up", seen: { published: ["lease"], said: LEASE, resets: [0, 1] }, then: "lease" },
  { from: "wake_grace", event: "disable", seen: { published: ["off"], said: OFF, ...LET_GO }, then: "off" },
  { from: "wake_grace", event: "ptt press", seen: { published: ["paused_ptt"], said: PAUSED, ...LET_GO }, then: "paused_ptt" },
  { from: "wake_grace", event: "frame", seen: { heard: 1 }, then: "wake_grace" },

  { from: "capturing", event: "speech end", seen: { stops: 1 }, then: "finishing" },
  { from: "capturing", event: "capped", seen: { stops: 1 }, then: "finishing" },
  // A recorder that cannot stop has failed, as one that reports an error has.
  { from: "capturing", event: "speech end, stop throws", seen: { published: ["error", "off"], said: OFF, ...LET_GO }, then: "off" },
  { from: "capturing", event: "data", seen: {}, then: "capturing" },
  // The recorder stopped by itself before anything was recorded.
  { from: "capturing", event: "recorder stops", seen: { published: ["armed"], said: NOTHING_KEPT, ...QUIET }, then: "armed" },
  { from: "capturing", event: "recorder error", seen: { published: ["error", "off"], said: OFF, ...LET_GO }, then: "off" },
  { from: "capturing", event: "disable", seen: { published: ["off"], said: OFF, stops: 1, ...LET_GO }, then: "off" },
  { from: "capturing", event: "ptt press", seen: { published: ["paused_ptt"], said: PAUSED, stops: 1, ...LET_GO }, then: "paused_ptt" },
  { from: "capturing", event: "epoch", seen: { published: ["off"], said: CALL_CHANGED, stops: 1, ...LET_GO }, then: "off" },
  { from: "capturing", event: "detector fails", seen: { published: ["error"], said: DETECTOR_FAILED, stops: 1, ...LET_GO }, then: "error" },
  { from: "capturing", event: "wake", seen: {}, then: "capturing" },
  { from: "capturing", event: "speech start", seen: {}, then: "capturing" },
  { from: "capturing", event: "no reply", seen: {}, then: "capturing" },
  { from: "capturing", event: "frame", seen: {}, then: "capturing" },
  { from: "capturing", event: "follow-up", seen: {}, then: "capturing" },

  { from: "finishing", event: "recorder stops", seen: { published: ["awaiting_response"], said: SENT, clips: 1 }, then: "awaiting_response" },
  { from: "finishing", event: "recorder stops, clip refused", seen: { published: ["armed"], said: NOT_SENT, clips: 1, ...QUIET }, then: "armed" },
  { from: "finishing", event: "recorder error", seen: { published: ["error", "off"], said: OFF, ...LET_GO }, then: "off" },
  { from: "finishing", event: "disable", seen: { published: ["off"], said: OFF, ...LET_GO }, then: "off" },
  // A second stop before the recorder's `stop` event changes nothing: that
  // event ends the capture and sends its clip.
  { from: "finishing", event: "speech end", seen: {}, then: "finishing" },
  { from: "finishing", event: "capped", seen: {}, then: "finishing" },
  { from: "finishing", event: "follow-up", seen: {}, then: "finishing" },
  { from: "finishing", event: "ptt press", seen: { published: ["paused_ptt"], said: PAUSED, ...LET_GO }, then: "paused_ptt" },

  { from: "awaiting_response", event: "no reply", seen: { published: ["armed"], said: NO_REPLY, ...QUIET }, then: "armed" },
  { from: "awaiting_response", event: "follow-up", seen: { published: ["lease"], said: LEASE, resets: [0, 1] }, then: "lease" },
  { from: "awaiting_response", event: "follow-up, old generation", seen: {}, then: "awaiting_response" },
  { from: "awaiting_response", event: "wake", seen: {}, then: "awaiting_response" },
  { from: "awaiting_response", event: "speech start", seen: {}, then: "awaiting_response" },
  { from: "awaiting_response", event: "late stop", seen: {}, then: "awaiting_response" },
  { from: "awaiting_response", event: "frame", seen: {}, then: "awaiting_response" },
  { from: "awaiting_response", event: "disable", seen: { published: ["off"], said: OFF, ...LET_GO }, then: "off" },
  { from: "awaiting_response", event: "ptt press", seen: { published: ["paused_ptt"], said: PAUSED, ...LET_GO }, then: "paused_ptt" },
  { from: "awaiting_response", event: "epoch", seen: { published: ["off"], said: CALL_CHANGED, ...LET_GO }, then: "off" },

  { from: "lease", event: "speech start", seen: { published: ["lease_capturing"], said: CAPTURING, starts: 1 }, then: "lease_capturing" },
  { from: "lease", event: "lease tick", seen: { published: ["lease"], said: LEASE }, then: "lease" },
  // Every way back to `armed` resets both detectors (#367).
  { from: "lease", event: "lease expires", seen: { published: ["armed"], said: LEASE_CLOSED, ...QUIET }, then: "armed" },
  { from: "lease", event: "follow-up", seen: { published: ["lease"], said: LEASE, resets: [0, 1] }, then: "lease" },
  { from: "lease", event: "no reply", seen: {}, then: "lease" },
  { from: "lease", event: "wake", seen: {}, then: "lease" },
  { from: "lease", event: "speech end", seen: {}, then: "lease" },
  { from: "lease", event: "frame", seen: {}, then: "lease" },
  { from: "lease", event: "disable", seen: { published: ["off"], said: OFF, ...LET_GO }, then: "off" },
  { from: "lease", event: "ptt press", seen: { published: ["paused_ptt"], said: PAUSED, ...LET_GO }, then: "paused_ptt" },
  { from: "lease", event: "epoch", seen: { published: ["off"], said: CALL_CHANGED, ...LET_GO }, then: "off" },

  { from: "lease_capturing", event: "lease expires", seen: { published: ["capturing"], said: LEASE_CLOSED_CAPTURING }, then: "capturing" },
  { from: "lease_capturing", event: "lease tick", seen: {}, then: "lease_capturing" },
  { from: "lease_capturing", event: "speech end", seen: { stops: 1 }, then: "lease_finishing" },
  { from: "lease_capturing", event: "capped", seen: { stops: 1 }, then: "lease_finishing" },
  { from: "lease_finishing", event: "speech end", seen: {}, then: "lease_finishing" },
  { from: "lease_finishing", event: "recorder stops", seen: { published: ["awaiting_response"], said: SENT, clips: 1 }, then: "awaiting_response" },
  { from: "lease_capturing", event: "recorder stops", seen: { published: ["armed"], said: NOTHING_KEPT, ...QUIET }, then: "armed" },
  { from: "lease_capturing", event: "recorder error", seen: { published: ["error", "off"], said: OFF, ...LET_GO }, then: "off" },
  { from: "lease_capturing", event: "follow-up", seen: {}, then: "lease_capturing" },
  { from: "lease_capturing", event: "disable", seen: { published: ["off"], said: OFF, stops: 1, ...LET_GO }, then: "off" },
];

describe("hands-free lifecycle: phase x event", () => {
  beforeEach(() => {
    stubBrowser();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const row of rows) {
    it(`${row.from} | ${row.event}`, async () => {
      const h = await reach(row.from);
      await apply(h, row.event);
      expect(h.seen()).toEqual({ ...NOTHING, ...row.seen });
      expectPhase(h, row.then);
    });
  }
});

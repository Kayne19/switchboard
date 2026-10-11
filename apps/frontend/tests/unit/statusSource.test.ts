// The status line's sources: which status takes down which error (#354).
//
// The call reports status from six writers: the call socket's link, the line
// controls, the caller's turn, playback, push-to-talk and hands-free. Each
// row walks a runtime into a phase -- no error, or one writer's error
// standing -- applies one writer's error or routine status, and checks what
// the page is given to draw (`status`, `statusError`). The runtime runs over a
// fake socket, a fake element, a fake microphone and a hands-free stub that
// reports through the runtime's own `onState`.
//
// Errors are keyed by their source (`statusLine.ts`); push-to-talk and
// hands-free are both the microphone. Before #354 the line was one slot, and
// any routine status took down any error: the rows "X error standing | Y
// routine" with X and Y of different sources showed Y's text then.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HandsFreeController,
  HandsFreeControllerOptions,
} from "../../src/hands_free";
import {
  CallRuntime,
  IDLE_TEXT,
  type RuntimeState,
} from "../../src/runtime/callRuntime";
import type { StatusSource } from "../../src/runtime/statusLine";
import { helloAck } from "../fixtures/serverMessages";
import { FakeSocket } from "./fakeSocket";

type Handler = () => void;

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

async function settle() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

/** A runtime on a greeted socket, and the switches its fakes answer to. */
async function harness() {
  const listeners = new Map<string, Set<Handler>>();
  const fakes = { playBlocked: false, microphoneRefused: false, hangupFails: false };
  const player = {
    addEventListener(name: string, handler: Handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(handler);
    },
    removeEventListener(name: string, handler: Handler) {
      listeners.get(name)?.delete(handler);
    },
    /** The clip on the element plays to its end. */
    end() {
      player.ended = true;
      for (const handler of [...(listeners.get("ended") || [])]) handler();
    },
    pause() {},
    removeAttribute() {},
    load() {},
    paused: false,
    ended: false,
    duration: 10,
    currentTime: 10,
    error: null,
    src: "",
    play: () => {
      player.ended = false;
      return fakes.playBlocked
        ? Promise.reject(namedError("NotAllowedError"))
        : Promise.resolve();
    },
  };
  let given: HandsFreeControllerOptions | null = null;
  const handsFreeStub = {
    stop() {},
    toggle() {},
    pauseForPtt() {},
    resumeAfterPtt() {},
    playbackChanged() {},
    epochChanged() {},
    replyClosed() {},
    clipFailed() {},
    endAwaitedTurn() {},
  };
  const runtime = new CallRuntime({
    socketUrl: "ws://backend/ws",
    onState: () => undefined,
    onServer: () => undefined,
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    postJson: async (url) => {
      if (url === "/hangup" && fakes.hangupFails) throw new Error("refused");
      return { error: null };
    },
    player: player as unknown as HTMLAudioElement,
    getUserMedia: async () => {
      if (fakes.microphoneRefused) throw namedError("NotAllowedError");
      return { getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream;
    },
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
    createHandsFree: (options) => {
      given = options;
      return handsFreeStub as unknown as HandsFreeController;
    },
  });
  runtime.start();
  const socket = FakeSocket.latest();
  socket.open();
  socket.receive(helloAck());
  socket.receive({ type: "epoch", generation: 0 });
  await settle();
  let sequence = 0;
  const handsFree = () => {
    if (!given) throw new Error("the runtime made no hands-free controller");
    return given;
  };
  return {
    runtime,
    socket,
    fakes,
    player,
    handsFree,
    /** One whole replay of the agent's voice arrives. */
    clip: async () => {
      sequence += 1;
      socket.receive({ type: "audio_start", generation: 0, sequence, mime: "audio/mpeg", format: "mp3" });
      socket.onmessage?.({ data: new TextEncoder().encode("speech").buffer } as MessageEvent);
      socket.receive({ type: "audio_done", generation: 0, sequence, done: true });
      await settle();
    },
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Who reports a status. */
type Writer = "connection" | "line" | "turn" | "playback" | "push-to-talk" | "hands-free";

interface Report {
  /** What it does to the runtime. */
  run: (h: Harness) => Promise<void> | void;
  /** The status text it says; null when it says none. */
  text: string | null;
}

/** One error and one routine report for every writer. */
const REPORTS: Record<Writer, { error: Report; routine: Report }> = {
  connection: {
    // The socket reports an error and stays open.
    error: { run: (h) => h.socket.onerror?.({} as Event), text: "Connection error." },
    routine: {
      run: (h) => h.runtime.retry(),
      text: "Forcing a fresh connection and retrying...",
    },
  },
  line: {
    error: {
      run: async (h) => {
        h.fakes.hangupFails = true;
        await h.runtime.hangup();
      },
      text: "Could not hang up: refused",
    },
    routine: {
      run: async (h) => {
        h.runtime.selectModel("big");
        await settle();
      },
      text: "Switching to big...",
    },
  },
  turn: {
    error: {
      run: (h) => h.socket.receive({ type: "error", message: "The model refused." }),
      text: "Error: The model refused.",
    },
    routine: {
      run: (h) => h.socket.receive({ type: "thinking", route: "operator", waiting: 0 }),
      text: "Operator is listening...",
    },
  },
  playback: {
    error: {
      run: async (h) => {
        h.fakes.playBlocked = true;
        await h.clip();
      },
      text: "Audio blocked by the browser — tap or click anywhere on this page once, then it will play (NotAllowedError).",
    },
    // A clip plays to its end, and nothing is left: the idle line. A clip
    // that was blocked plays first.
    routine: {
      run: async (h) => {
        h.fakes.playBlocked = false;
        await h.clip();
        for (let index = 0; index < 4; index += 1) {
          h.player.end();
          await settle();
        }
      },
      text: IDLE_TEXT,
    },
  },
  "push-to-talk": {
    error: {
      run: async (h) => {
        h.fakes.microphoneRefused = true;
        h.runtime.talk();
        await settle();
      },
      text: "Microphone unavailable (NotAllowedError).",
    },
    routine: {
      run: async (h) => {
        h.fakes.microphoneRefused = false;
        h.runtime.talk();
        await settle();
      },
      text: "Recording... Send when you are done, Discard to throw it away.",
    },
  },
  "hands-free": {
    error: {
      run: (h) =>
        h.handsFree().onState({
          state: "error",
          message: "Hands-free detector could not load (model missing).",
          leaseRemainingMs: 0,
        }),
      text: "Hands-free detector could not load (model missing).",
    },
    // MODE turns hands-free on. It says nothing on the status line.
    routine: {
      run: (h) =>
        h.handsFree().onState({
          state: "starting",
          message: "Starting hands-free...",
          leaseRemainingMs: 0,
        }),
      text: null,
    },
  },
};

const WRITERS = Object.keys(REPORTS) as Writer[];

type Shown = Pick<RuntimeState, "status" | "statusError">;

const SOURCE: Record<Writer, StatusSource> = {
  connection: "connection",
  line: "line",
  turn: "turn",
  playback: "playback",
  "push-to-talk": "microphone",
  "hands-free": "microphone",
};

/**
 * An error is shown, and stands. A routine status takes down its own
 * source's error and no other, and is only text while none stands. A report
 * that says nothing leaves the newest status said.
 */
function expected(standing: Writer | null, writer: Writer, kind: "error" | "routine"): Shown {
  const said = REPORTS[writer][kind].text;
  if (kind === "error") return { status: said!, statusError: true };
  const standingText = standing ? REPORTS[standing].error.text! : null;
  if (standing && SOURCE[standing] !== SOURCE[writer])
    return { status: standingText!, statusError: true };
  return { status: said ?? standingText ?? IDLE_TEXT, statusError: false };
}

beforeEach(() => {
  FakeSocket.instances = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the status line, phase x report", () => {
  for (const standing of [null, ...WRITERS]) {
    for (const writer of WRITERS) {
      for (const kind of ["error", "routine"] as const) {
        const phase = standing ? `${standing} error standing` : "no error";
        it(`${phase} | ${writer} ${kind}`, async () => {
          const h = await harness();
          if (standing) {
            await REPORTS[standing].error.run(h);
            await settle();
            expect(h.runtime.currentState, "the phase").toMatchObject({
              status: REPORTS[standing].error.text,
              statusError: true,
            });
          } else {
            expect(h.runtime.currentState, "the phase").toMatchObject({
              status: IDLE_TEXT,
              statusError: false,
            });
          }
          await REPORTS[writer][kind].run(h);
          await settle();
          const { status, statusError } = h.runtime.currentState;
          expect({ status, statusError }).toEqual(expected(standing, writer, kind));
          h.runtime.dispose();
        });
      }
    }
  }
});

/** One writer's error or routine report, by name. */
type Step = [Writer, "error" | "routine"] | ((h: Harness) => Promise<void> | void);

const SEQUENCES: Array<{ name: string; steps: Step[]; shown: Shown }> = [
  {
    name: "two errors stand: the newer is shown",
    steps: [["turn", "error"], ["connection", "error"]],
    shown: { status: "Connection error.", statusError: true },
  },
  {
    name: "the newer is taken down: the older is shown again",
    steps: [["turn", "error"], ["connection", "error"], ["connection", "routine"]],
    shown: { status: "Error: The model refused.", statusError: true },
  },
  {
    name: "the older is taken down: the newer stays",
    steps: [["turn", "error"], ["connection", "error"], ["turn", "routine"]],
    shown: { status: "Connection error.", statusError: true },
  },
  {
    name: "both taken down: the newest status is text",
    steps: [["turn", "error"], ["playback", "error"], ["turn", "routine"], ["playback", "routine"]],
    shown: { status: IDLE_TEXT, statusError: false },
  },
  {
    name: "a source's second error replaces its first",
    steps: [
      ["turn", "error"],
      (h) => h.socket.receive({ type: "routing_unavailable", message: "Routing is unavailable." }),
      ["turn", "routine"],
    ],
    shown: { status: "Operator is listening...", statusError: false },
  },
  {
    name: "a hangup tried again takes down the last one's failure",
    steps: [
      ["line", "error"],
      async (h) => {
        h.fakes.hangupFails = false;
        await h.runtime.hangup();
      },
    ],
    shown: { status: "Could not hang up: refused", statusError: false },
  },
  {
    name: "a hangup tried again leaves another source's error",
    steps: [
      ["turn", "error"],
      async (h) => {
        h.fakes.hangupFails = false;
        await h.runtime.hangup();
      },
    ],
    shown: { status: "Error: The model refused.", statusError: true },
  },
  // The reverse of #354: a pause playback reported is not taken down by
  // another source, so the clip sounding again is what takes it down.
  {
    name: "a playback error outlives a turn, and the clip resuming takes it down",
    steps: [
      ["playback", "error"],
      ["turn", "routine"],
      async (h) => {
        h.fakes.playBlocked = false;
        await h.clip();
      },
    ],
    shown: { status: "Audio resumed.", statusError: false },
  },
];

describe("the status line, in sequence", () => {
  for (const { name, steps, shown } of SEQUENCES) {
    it(name, async () => {
      const h = await harness();
      for (const step of steps) {
        await (typeof step === "function" ? step(h) : REPORTS[step[0]][step[1]].run(h));
        await settle();
      }
      const { status, statusError } = h.runtime.currentState;
      expect({ status, statusError }).toEqual(shown);
      h.runtime.dispose();
    });
  }
});

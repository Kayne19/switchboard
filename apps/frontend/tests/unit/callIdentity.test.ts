import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandsFreeController } from "../../src/hands_free";
import { AudioPlayback } from "../../src/runtime/audioPlayback";
import { CallRuntime, IDLE_TEXT } from "../../src/runtime/callRuntime";
import { ClipOutbox, type Clip } from "../../src/runtime/outbox";
import { helloAck, statusMessage } from "../fixtures/serverMessages";
import { FakeSocket } from "./fakeSocket";

/**
 * The call's identity on the page, phase by event, through `CallRuntime`'s
 * public API: the epoch the page holds, the candidate leg it was told is
 * starting (`candidate`), and the adoption whose epoch has not come yet
 * (`candidate_cleared` with `reason: "adopted"`). The rule they keep is #70's:
 * a clip recorded while a candidate starts is carried to the new leg only on
 * the epoch its adoption names (`docs/concurrency-and-test-hazards.md`).
 *
 * Each row builds a fresh runtime at epoch 3 over a fake socket, a fake
 * microphone and a hands-free stub, walks it into a phase, applies one server
 * message, and checks what the caller and the server see: the status line,
 * the clips sent (by the generation they went out under), how playback was
 * told about the epoch, whether hands-free heard the call change, and the
 * stamp (epoch and candidate mark) a push-to-talk take begun just after the
 * message would carry. Two follow-ups, each on its own fresh runtime, show
 * what the page holds but does not yet show: what an `epoch 4` right after
 * does (the adoption waiting for its epoch), and what alpha's adoption at 4
 * with its epoch carries along (the marks on the clips held).
 *
 * The `away` phases are a reconnect: a take recorded on the old socket is
 * held unsent, and the new socket has said `hello_ack` but not yet its
 * snapshot `epoch`, which is where the snapshot's `candidate_cleared` lands.
 */

type Phase =
  /** At epoch 3, nothing starting. */
  | "steady"
  /** A candidate for alpha is starting. */
  | "alpha starting"
  /** Alpha was adopted at 4; its epoch has not come. */
  | "alpha adopted at 4"
  /** Alpha was adopted at 4, and before its epoch a candidate for beta started. */
  | "alpha adopted at 4, beta starting"
  /** A take recorded at 3 is held; the new socket has no snapshot yet. */
  | "away, clip at 3"
  /** A take recorded for alpha at 3 is held; the new socket has no snapshot yet. */
  | "away, clip for alpha"
  /** As above, and the new socket's snapshot said alpha was adopted at 4. */
  | "away, clip for alpha, alpha adopted at 4";

type Trigger =
  | "epoch 3"
  | "epoch 4"
  | "epoch 5"
  | "candidate alpha"
  | "candidate beta"
  | "candidate operator"
  | "alpha adopted at 4"
  | "alpha rolled back"
  | "alpha rescued at 4"
  | "reply"
  | "status";

interface Stamp {
  epoch: number;
  /** The candidate route the take is marked for, or null. */
  era: string | null;
}

interface Seen {
  status: string;
  error: boolean;
  /** The generations clips went out under during the message. */
  clips: number[];
  /** How playback was told about the epoch: "hand off N" or "reset N". */
  playback: string[];
  /** Whether hands-free was told the call changed. */
  callChanged: boolean;
  /** The stamp of a push-to-talk take begun after the message. */
  stamp: Stamp;
  /**
   * What an `epoch 4` right after the message does: whether it carries a
   * held clip along, and whether playback is handed off. It shows the
   * adoption the page holds and the marks on the clips it holds.
   */
  thenEpoch4: Pick<Seen, "clips" | "playback">;
  /**
   * The clips an adoption of alpha at 4 and its epoch, right after the
   * message, carry along: it shows which held clips are still marked for alpha.
   */
  thenAlphaAdopted: number[];
}

interface Row {
  from: Phase;
  event: Trigger;
  seen: Seen;
}

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
  let callChanges = 0;
  const stub = {
    toggle() {},
    stop() {},
    epochChanged() {
      callChanges += 1;
    },
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
      const socket = new FakeSocket(url);
      made.push(socket);
      return socket as unknown as WebSocket;
    },
    postJson: async () => ({ error: null }),
    player: fakePlayer(),
    getUserMedia: async () =>
      ({ getTracks: () => [{ stop: () => undefined }] }) as unknown as MediaStream,
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
    createHandsFree: () => stub as unknown as HandsFreeController,
  });
  return {
    runtime,
    made,
    latest: () => made[made.length - 1],
    callChanges: () => callChanges,
  };
}

type Harness = ReturnType<typeof harness>;

const cleared = (route: string, generation: number, reason: string) => ({
  type: "candidate_cleared",
  route,
  generation,
  reason,
});

/** The line drops mid-take, and a new socket opens and says `hello_ack`. */
async function goAway(h: Harness): Promise<void> {
  h.runtime.talk();
  await settle();
  h.latest().drop();
  await settle();
  h.runtime.retry();
  h.latest().open();
  h.latest().receive(helloAck());
  await settle();
}

async function walk(h: Harness, phase: Phase): Promise<void> {
  const { runtime } = h;
  runtime.start();
  const socket = h.latest();
  socket.open();
  socket.receive(helloAck());
  socket.receive({ type: "epoch", generation: 3 });
  await settle();
  switch (phase) {
    case "steady":
      return;
    case "alpha starting":
      socket.receive({ type: "candidate", route: "alpha", generation: 3 });
      return;
    case "alpha adopted at 4":
      socket.receive({ type: "candidate", route: "alpha", generation: 3 });
      socket.receive(cleared("alpha", 4, "adopted"));
      return;
    case "alpha adopted at 4, beta starting":
      socket.receive({ type: "candidate", route: "alpha", generation: 3 });
      socket.receive(cleared("alpha", 4, "adopted"));
      socket.receive({ type: "candidate", route: "beta", generation: 3 });
      return;
    case "away, clip at 3":
      await goAway(h);
      return;
    case "away, clip for alpha":
      socket.receive({ type: "candidate", route: "alpha", generation: 3 });
      await goAway(h);
      return;
    case "away, clip for alpha, alpha adopted at 4":
      socket.receive({ type: "candidate", route: "alpha", generation: 3 });
      await goAway(h);
      h.latest().receive(cleared("alpha", 4, "adopted"));
      return;
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

function message(event: Trigger): object {
  switch (event) {
    case "epoch 3":
      return { type: "epoch", generation: 3 };
    case "epoch 4":
      return { type: "epoch", generation: 4 };
    case "epoch 5":
      return { type: "epoch", generation: 5 };
    case "candidate alpha":
      return { type: "candidate", route: "alpha", generation: 3 };
    case "candidate beta":
      return { type: "candidate", route: "beta", generation: 3 };
    case "candidate operator":
      return { type: "candidate", route: "operator", generation: 3 };
    case "alpha adopted at 4":
      return cleared("alpha", 4, "adopted");
    case "alpha rolled back":
      return cleared("alpha", 3, "rolled_back");
    case "alpha rescued at 4":
      return cleared("alpha", 4, "rescued");
    case "reply":
      return { type: "reply", text: "Done.", route: "operator", voiced: false };
    case "status":
      return statusMessage();
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function clipsSent(made: FakeSocket[]): number[] {
  return made.flatMap((socket) =>
    socket.sentJson().filter((frame) => frame.type === "clip").map((frame) => Number(frame.generation)),
  );
}

/** Walks a fresh runtime into `from`, gives it `event`, and runs `then` before disposing it. */
async function given<T>(from: Phase, event: Trigger, then: (h: Harness) => Promise<T>): Promise<T> {
  const h = harness();
  await walk(h, from);
  h.latest().receive(message(event));
  await settle();
  const result = await then(h);
  h.runtime.dispose();
  return result;
}

/** What the next message does, as far as the clips sent and playback show. */
async function watch(h: Harness, receive: () => void): Promise<Pick<Seen, "clips" | "playback">> {
  const playback: string[] = [];
  const handOff = vi
    .spyOn(AudioPlayback.prototype, "handOffToGeneration")
    .mockImplementation((generation: number) => void playback.push(`hand off ${generation}`));
  const reset = vi
    .spyOn(AudioPlayback.prototype, "resetForGeneration")
    .mockImplementation((generation: number) => void playback.push(`reset ${generation}`));
  const before = clipsSent(h.made).length;
  receive();
  await settle();
  handOff.mockRestore();
  reset.mockRestore();
  return { clips: clipsSent(h.made).slice(before), playback };
}

async function play(row: Row): Promise<Seen> {
  // What the message itself does.
  const h = harness();
  await walk(h, row.from);
  const callChangesBefore = h.callChanges();
  const { clips, playback } = await watch(h, () => h.latest().receive(message(row.event)));
  const state = h.runtime.currentState;
  const callChanged = h.callChanges() > callChangesBefore;
  h.runtime.dispose();
  // The stamp a take begun after it carries.
  const stamp = await given(row.from, row.event, async (after) => {
    const added = vi.spyOn(ClipOutbox.prototype, "add");
    after.runtime.talk();
    await settle();
    after.runtime.send();
    await settle();
    const clip = added.mock.calls.at(-1)?.[0] as Clip;
    added.mockRestore();
    return { epoch: clip.epoch, era: clip.transferEra ?? null };
  });
  // What an `epoch 4` after it does.
  const thenEpoch4 = await given(row.from, row.event, (after) =>
    watch(after, () => after.latest().receive({ type: "epoch", generation: 4 })),
  );
  // What an adoption of alpha at 4 and its epoch after it carry along.
  const thenAlphaAdopted = await given(row.from, row.event, async (after) => {
    const seen = await watch(after, () => {
      after.latest().receive(cleared("alpha", 4, "adopted"));
      after.latest().receive({ type: "epoch", generation: 4 });
    });
    return seen.clips;
  });
  return {
    status: state.status,
    error: state.statusError,
    clips,
    playback,
    callChanged,
    stamp,
    thenEpoch4,
    thenAlphaAdopted,
  };
}

const CONNECTING_ALPHA = "Connecting to alpha\u2026";
const CONNECTING_BETA = "Connecting to beta\u2026";
const WAITING_FOR_ACCEPT = "Waiting for the server to accept your clip...";
const NEVER_SENT = "The line changed before 1 clip(s) went out. Please repeat that.";
/** A live epoch 4 that the page was expecting: playback is handed off. */
const HANDS_OFF_4: Seen["thenEpoch4"] = { clips: [], playback: ["hand off 4"] };

const stamp = (epoch: number, era: string | null = null): Stamp => ({ epoch, era });

/** Nothing changes: the idle line, epoch 3, no mark, and an unexpected epoch 4 cuts playback. */
function seen(changed: Partial<Seen>): Seen {
  return {
    status: IDLE_TEXT,
    error: false,
    clips: [],
    playback: [],
    callChanged: false,
    stamp: stamp(3),
    thenEpoch4: { clips: [], playback: ["reset 4"] },
    thenAlphaAdopted: [],
    ...changed,
  };
}

const rows: Row[] = [
  // steady: the page holds epoch 3 and nothing is starting. A same-epoch
  // `epoch` (a return to the operator) hands playback off; any other cuts it.
  { from: "steady", event: "epoch 3", seen: seen({ playback: ["hand off 3"], callChanged: true }) },
  { from: "steady", event: "epoch 4", seen: seen({ playback: ["reset 4"], callChanged: true, stamp: stamp(4), thenEpoch4: HANDS_OFF_4 }) },
  { from: "steady", event: "epoch 5", seen: seen({ playback: ["reset 5"], callChanged: true, stamp: stamp(5) }) },
  { from: "steady", event: "candidate alpha", seen: seen({ status: CONNECTING_ALPHA, stamp: stamp(3, "alpha") }) },
  { from: "steady", event: "candidate beta", seen: seen({ status: CONNECTING_BETA, stamp: stamp(3, "beta") }) },
  { from: "steady", event: "candidate operator", seen: seen({}) },
  { from: "steady", event: "alpha adopted at 4", seen: seen({ thenEpoch4: HANDS_OFF_4 }) },
  { from: "steady", event: "alpha rolled back", seen: seen({}) },
  { from: "steady", event: "alpha rescued at 4", seen: seen({}) },
  { from: "steady", event: "reply", seen: seen({}) },
  { from: "steady", event: "status", seen: seen({}) },

  // alpha starting: a take begun now is marked for alpha. `reply` and
  // `status` clear the mark for later takes, though no notice ended the
  // candidate (lifecycle map finding 10; kept as today). `candidate operator`
  // clears it and leaves the status line.
  { from: "alpha starting", event: "epoch 3", seen: seen({ status: CONNECTING_ALPHA, playback: ["hand off 3"], callChanged: true }) },
  { from: "alpha starting", event: "epoch 4", seen: seen({ status: CONNECTING_ALPHA, playback: ["reset 4"], callChanged: true, stamp: stamp(4), thenEpoch4: HANDS_OFF_4 }) },
  { from: "alpha starting", event: "epoch 5", seen: seen({ status: CONNECTING_ALPHA, playback: ["reset 5"], callChanged: true, stamp: stamp(5) }) },
  { from: "alpha starting", event: "candidate alpha", seen: seen({ status: CONNECTING_ALPHA, stamp: stamp(3, "alpha") }) },
  { from: "alpha starting", event: "candidate beta", seen: seen({ status: CONNECTING_BETA, stamp: stamp(3, "beta") }) },
  { from: "alpha starting", event: "candidate operator", seen: seen({ status: CONNECTING_ALPHA }) },
  { from: "alpha starting", event: "alpha adopted at 4", seen: seen({ thenEpoch4: HANDS_OFF_4 }) },
  { from: "alpha starting", event: "alpha rolled back", seen: seen({}) },
  { from: "alpha starting", event: "alpha rescued at 4", seen: seen({}) },
  { from: "alpha starting", event: "reply", seen: seen({}) },
  { from: "alpha starting", event: "status", seen: seen({ status: CONNECTING_ALPHA }) },

  // alpha adopted at 4: only epoch 4 hands off. Any epoch ends the wait, so
  // after `epoch 3` the adoption is gone and a later epoch 4 cuts playback.
  // A new candidate, `reply` and `status` leave it waiting.
  { from: "alpha adopted at 4", event: "epoch 3", seen: seen({ playback: ["hand off 3"], callChanged: true }) },
  { from: "alpha adopted at 4", event: "epoch 4", seen: seen({ playback: ["hand off 4"], callChanged: true, stamp: stamp(4), thenEpoch4: HANDS_OFF_4 }) },
  { from: "alpha adopted at 4", event: "epoch 5", seen: seen({ playback: ["reset 5"], callChanged: true, stamp: stamp(5) }) },
  { from: "alpha adopted at 4", event: "candidate alpha", seen: seen({ status: CONNECTING_ALPHA, stamp: stamp(3, "alpha"), thenEpoch4: HANDS_OFF_4 }) },
  { from: "alpha adopted at 4", event: "candidate beta", seen: seen({ status: CONNECTING_BETA, stamp: stamp(3, "beta"), thenEpoch4: HANDS_OFF_4 }) },
  { from: "alpha adopted at 4", event: "candidate operator", seen: seen({ thenEpoch4: HANDS_OFF_4 }) },
  { from: "alpha adopted at 4", event: "alpha adopted at 4", seen: seen({ thenEpoch4: HANDS_OFF_4 }) },
  { from: "alpha adopted at 4", event: "alpha rolled back", seen: seen({}) },
  { from: "alpha adopted at 4", event: "alpha rescued at 4", seen: seen({}) },
  { from: "alpha adopted at 4", event: "reply", seen: seen({ thenEpoch4: HANDS_OFF_4 }) },
  { from: "alpha adopted at 4", event: "status", seen: seen({ thenEpoch4: HANDS_OFF_4 }) },

  // alpha adopted at 4, beta starting: the mark and the adoption are
  // independent; each message moves only its own.
  { from: "alpha adopted at 4, beta starting", event: "epoch 3", seen: seen({ status: CONNECTING_BETA, playback: ["hand off 3"], callChanged: true }) },
  { from: "alpha adopted at 4, beta starting", event: "epoch 4", seen: seen({ status: CONNECTING_BETA, playback: ["hand off 4"], callChanged: true, stamp: stamp(4), thenEpoch4: HANDS_OFF_4 }) },
  { from: "alpha adopted at 4, beta starting", event: "epoch 5", seen: seen({ status: CONNECTING_BETA, playback: ["reset 5"], callChanged: true, stamp: stamp(5) }) },
  { from: "alpha adopted at 4, beta starting", event: "candidate alpha", seen: seen({ status: CONNECTING_ALPHA, stamp: stamp(3, "alpha"), thenEpoch4: HANDS_OFF_4 }) },
  { from: "alpha adopted at 4, beta starting", event: "candidate beta", seen: seen({ status: CONNECTING_BETA, stamp: stamp(3, "beta"), thenEpoch4: HANDS_OFF_4 }) },
  { from: "alpha adopted at 4, beta starting", event: "candidate operator", seen: seen({ status: CONNECTING_BETA, thenEpoch4: HANDS_OFF_4 }) },
  { from: "alpha adopted at 4, beta starting", event: "alpha adopted at 4", seen: seen({ thenEpoch4: HANDS_OFF_4 }) },
  { from: "alpha adopted at 4, beta starting", event: "alpha rolled back", seen: seen({}) },
  { from: "alpha adopted at 4, beta starting", event: "alpha rescued at 4", seen: seen({}) },
  { from: "alpha adopted at 4, beta starting", event: "reply", seen: seen({ thenEpoch4: HANDS_OFF_4 }) },
  { from: "alpha adopted at 4, beta starting", event: "status", seen: seen({ status: CONNECTING_BETA, thenEpoch4: HANDS_OFF_4 }) },

  // away, clip at 3: a reconnect's first epoch cuts playback even at the
  // same epoch. A held clip from another epoch that never went out is dropped
  // and the caller is told.
  { from: "away, clip at 3", event: "epoch 3", seen: seen({ status: WAITING_FOR_ACCEPT, clips: [3], playback: ["reset 3"], callChanged: true }) },
  { from: "away, clip at 3", event: "epoch 4", seen: seen({ status: NEVER_SENT, error: true, playback: ["reset 4"], callChanged: true, stamp: stamp(4), thenEpoch4: HANDS_OFF_4 }) },
  { from: "away, clip at 3", event: "epoch 5", seen: seen({ status: NEVER_SENT, error: true, playback: ["reset 5"], callChanged: true, stamp: stamp(5) }) },
  { from: "away, clip at 3", event: "candidate alpha", seen: seen({ status: CONNECTING_ALPHA, stamp: stamp(3, "alpha") }) },
  { from: "away, clip at 3", event: "candidate beta", seen: seen({ status: CONNECTING_BETA, stamp: stamp(3, "beta") }) },
  { from: "away, clip at 3", event: "candidate operator", seen: seen({}) },
  { from: "away, clip at 3", event: "alpha adopted at 4", seen: seen({}) },
  { from: "away, clip at 3", event: "alpha rolled back", seen: seen({}) },
  { from: "away, clip at 3", event: "alpha rescued at 4", seen: seen({}) },
  { from: "away, clip at 3", event: "reply", seen: seen({}) },
  { from: "away, clip at 3", event: "status", seen: seen({}) },

  // away, clip for alpha: the held take is marked for alpha. It is carried to
  // 4 only by alpha's adoption at 4 and its epoch; a rollback or a rescue
  // strips the mark, so a later adoption of alpha does not carry it (#70).
  { from: "away, clip for alpha", event: "epoch 3", seen: seen({ status: WAITING_FOR_ACCEPT, clips: [3], playback: ["reset 3"], callChanged: true }) },
  { from: "away, clip for alpha", event: "epoch 4", seen: seen({ status: NEVER_SENT, error: true, playback: ["reset 4"], callChanged: true, stamp: stamp(4), thenEpoch4: HANDS_OFF_4 }) },
  { from: "away, clip for alpha", event: "epoch 5", seen: seen({ status: NEVER_SENT, error: true, playback: ["reset 5"], callChanged: true, stamp: stamp(5) }) },
  { from: "away, clip for alpha", event: "candidate alpha", seen: seen({ status: CONNECTING_ALPHA, stamp: stamp(3, "alpha"), thenAlphaAdopted: [4] }) },
  { from: "away, clip for alpha", event: "candidate beta", seen: seen({ status: CONNECTING_BETA, stamp: stamp(3, "beta"), thenAlphaAdopted: [4] }) },
  { from: "away, clip for alpha", event: "candidate operator", seen: seen({ thenAlphaAdopted: [4] }) },
  { from: "away, clip for alpha", event: "alpha adopted at 4", seen: seen({ thenEpoch4: { clips: [4], playback: ["reset 4"] }, thenAlphaAdopted: [4] }) },
  { from: "away, clip for alpha", event: "alpha rolled back", seen: seen({}) },
  { from: "away, clip for alpha", event: "alpha rescued at 4", seen: seen({}) },
  { from: "away, clip for alpha", event: "reply", seen: seen({ thenAlphaAdopted: [4] }) },
  { from: "away, clip for alpha", event: "status", seen: seen({ thenAlphaAdopted: [4] }) },

  // away, clip for alpha, alpha adopted at 4: the snapshot's notice came
  // ahead of its epoch. Epoch 4 carries the held take; any other epoch
  // drops or sends it under its own stamp.
  { from: "away, clip for alpha, alpha adopted at 4", event: "epoch 3", seen: seen({ status: WAITING_FOR_ACCEPT, clips: [3], playback: ["reset 3"], callChanged: true }) },
  { from: "away, clip for alpha, alpha adopted at 4", event: "epoch 4", seen: seen({ status: WAITING_FOR_ACCEPT, clips: [4], playback: ["reset 4"], callChanged: true, stamp: stamp(4), thenEpoch4: HANDS_OFF_4 }) },
  { from: "away, clip for alpha, alpha adopted at 4", event: "epoch 5", seen: seen({ status: NEVER_SENT, error: true, playback: ["reset 5"], callChanged: true, stamp: stamp(5) }) },
  { from: "away, clip for alpha, alpha adopted at 4", event: "candidate alpha", seen: seen({ status: CONNECTING_ALPHA, stamp: stamp(3, "alpha"), thenEpoch4: { clips: [4], playback: ["reset 4"] }, thenAlphaAdopted: [4] }) },
  { from: "away, clip for alpha, alpha adopted at 4", event: "candidate beta", seen: seen({ status: CONNECTING_BETA, stamp: stamp(3, "beta"), thenEpoch4: { clips: [4], playback: ["reset 4"] }, thenAlphaAdopted: [4] }) },
  { from: "away, clip for alpha, alpha adopted at 4", event: "candidate operator", seen: seen({ thenEpoch4: { clips: [4], playback: ["reset 4"] }, thenAlphaAdopted: [4] }) },
  { from: "away, clip for alpha, alpha adopted at 4", event: "alpha adopted at 4", seen: seen({ thenEpoch4: { clips: [4], playback: ["reset 4"] }, thenAlphaAdopted: [4] }) },
  { from: "away, clip for alpha, alpha adopted at 4", event: "alpha rolled back", seen: seen({}) },
  { from: "away, clip for alpha, alpha adopted at 4", event: "alpha rescued at 4", seen: seen({}) },
  { from: "away, clip for alpha, alpha adopted at 4", event: "reply", seen: seen({ thenEpoch4: { clips: [4], playback: ["reset 4"] }, thenAlphaAdopted: [4] }) },
  { from: "away, clip for alpha, alpha adopted at 4", event: "status", seen: seen({ thenEpoch4: { clips: [4], playback: ["reset 4"] }, thenAlphaAdopted: [4] }) },
];

beforeEach(() => {
  FakeSocket.instances = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the call's identity, phase by event", () => {
  it.each(rows.map((row) => [`${row.from} | ${row.event}`, row] as const))("%s", async (_name, row) => {
    expect(await play(row)).toEqual(row.seen);
  });
});

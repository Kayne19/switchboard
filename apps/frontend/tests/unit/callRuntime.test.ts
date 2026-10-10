import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HandsFreeController,
  HandsFreeControllerOptions,
  SpeechEndpointer,
  WakeDetector,
} from "../../src/hands_free";
import type { ScreenStateReport } from "../../src/controller/types";
import {
  CallRuntime,
  IDLE_TEXT,
  type CallRuntimeOptions,
  type RuntimeState,
} from "../../src/runtime/callRuntime";
import type { HelloAckMessage, ServerMessage } from "../../src/protocol";
import { AudioPlayback } from "../../src/runtime/audioPlayback";
import { CAPTION_WAIT_MS } from "../../src/runtime/spokenLines";
import { helloAck, statusMessage } from "../fixtures/serverMessages";
import { realHandsFree, stubHandsFreeBrowser } from "../fixtures/handsFreeRuntime";

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  static latest(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1];
  }

  send(data: unknown) {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data);
  }

  // A real socket reports its own close asynchronously.
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({} as CloseEvent));
  }

  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  drop() {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }

  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  sentJson(): Array<Record<string, unknown>> {
    return this.sent
      .filter((frame): frame is string => typeof frame === "string")
      .map((frame) => JSON.parse(frame));
  }
}

class FakeRecorder {
  static latest: FakeRecorder | null = null;
  state: RecordingState = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: { error: unknown }) => void) | null = null;
  constructor() {
    FakeRecorder.latest = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["speech"]) });
    this.onstop?.();
  }
}

const fakeStream = () =>
  ({ getTracks: () => [{ stop: () => {} }] }) as unknown as MediaStream;

function fakePlayer() {
  return {
    addEventListener() {},
    removeEventListener() {},
    pause() {},
    removeAttribute() {},
    load() {},
    play: () => Promise.resolve(),
    src: "",
    // The level is read at the element's own time (#194).
    currentTime: 0,
  } as unknown as HTMLAudioElement;
}

async function settle() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function makeRuntime(overrides: Partial<CallRuntimeOptions> = {}) {
  const states: RuntimeState[] = [];
  const messages: ServerMessage[] = [];
  const runtime = new CallRuntime({
    socketUrl: "ws://backend/ws",
    onState: (state) => states.push(state),
    onServer: (message) => messages.push(message),
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    postJson: async () => ({ error: null }),
    player: fakePlayer(),
    getUserMedia: async () => fakeStream(),
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
    ...overrides,
  });
  const latestState = () => runtime.currentState;
  return { runtime, states, messages, latestState };
}

// Opens the socket and walks the backend's greeting: hello_ack, then the
// snapshot epoch that makes the outbox flushable.
async function connectAt(
  runtime: CallRuntime,
  generation = 1,
  helloAckFields: Partial<HelloAckMessage> = {},
) {
  runtime.start();
  const socket = FakeSocket.latest();
  socket.open();
  socket.receive(helloAck(helloAckFields));
  socket.receive({ type: "epoch", generation });
  await settle();
  return socket;
}

beforeEach(() => {
  FakeSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CallRuntime speaking state", () => {
  it("shows the presence while an agent audio clip is playing", async () => {
    const { runtime, latestState } = makeRuntime();
    const socket = await connectAt(runtime, 0);
    socket.receive({
      type: "audio_start",
      generation: 0,
      sequence: 1,
      mime: "audio/mpeg",
      format: "mp3",
    });
    socket.onmessage?.({ data: new TextEncoder().encode("speech").buffer } as MessageEvent);
    socket.receive({
      type: "audio_done",
      generation: 0,
      sequence: 1,
      done: true,
    });
    await settle();
    expect(latestState().speaking).toBe(true);
    runtime.dispose();
  });
});

describe("CallRuntime blocked audio recovery", () => {
  // iOS Safari does not deliver a click through event delegation for a tap
  // on an ordinary element, so a `click` listener on `document` never saw an
  // iPad tap and blocked audio waited for ever (#189).
  it("retries blocked audio on a touch, a pointer, or a key", async () => {
    const handlers = new Map<string, Set<EventListener>>();
    const document = {
      addEventListener(type: string, listener: EventListener) {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type)!.add(listener);
      },
      removeEventListener(type: string, listener: EventListener) {
        handlers.get(type)?.delete(listener);
      },
    };
    const playCalls: number[] = [];
    let blocked = true;
    const player = {
      addEventListener() {},
      removeEventListener() {},
      pause() {},
      removeAttribute() {},
      load() {},
      currentTime: 0,
      error: null,
      play: () => {
        playCalls.push(playCalls.length);
        if (!blocked) return Promise.resolve();
        const error = new Error("blocked");
        error.name = "NotAllowedError";
        return Promise.reject(error);
      },
      src: "",
    } as unknown as HTMLAudioElement;
    const { runtime, latestState } = makeRuntime({
      player,
      document: document as unknown as Document,
    });
    const socket = await connectAt(runtime, 0);
    socket.receive({
      type: "audio_start",
      generation: 0,
      sequence: 1,
      mime: "audio/mpeg",
      format: "mp3",
    });
    socket.onmessage?.({
      data: new TextEncoder().encode("speech").buffer,
    } as MessageEvent);
    socket.receive({ type: "audio_done", generation: 0, sequence: 1, done: true });
    await settle();
    expect(playCalls.length, "the first attempt is refused").toBe(1);
    expect(latestState().statusError, "the refusal is on screen").toBe(true);

    blocked = false;
    const fire = (type: string) => {
      for (const handler of [...(handlers.get(type) || [])])
        handler({ target: null } as unknown as Event);
    };
    fire("touchend");
    await settle();
    expect(playCalls.length, "a touch is a gesture").toBe(2);

    runtime.dispose();
    for (const type of ["click", "pointerdown", "touchend", "keydown"]) {
      expect(handlers.get(type)?.size ?? 0, `${type} is released`).toBe(0);
    }
  });

  it("listens for every gesture the page can report", async () => {
    const handlers = new Set<string>();
    const document = {
      addEventListener(type: string) {
        handlers.add(type);
      },
      removeEventListener() {},
    };
    const { runtime } = makeRuntime({
      document: document as unknown as Document,
    });
    runtime.start();
    for (const type of ["click", "pointerdown", "touchend", "keydown"]) {
      expect(handlers.has(type), `${type} is a gesture`).toBe(true);
    }
    runtime.dispose();
  });
});

describe("CallRuntime captions when playback fails", () => {
  // A caption waits for the audio that voices it (#112). When that audio is
  // refused, fails, or never comes -- every WebKit playback failure in #189
  // -- the line used to wait for ever: the caption log froze on an old line
  // while the transcript drawer had every later one.
  it("shows a line whose audio never arrives", async () => {
    vi.useFakeTimers();
    const heard: string[] = [];
    const { runtime } = makeRuntime({
      onHeard: (line) => heard.push(line.text),
    });
    const socket = await connectAt(runtime, 0);
    socket.receive({
      type: "spoken",
      entry: {
        role: "agent",
        text: "Putting you through.",
        route: "operator",
        ts: 0,
        voiced: true,
      },
      sequence: 1,
    });
    await settle();
    expect(heard, "the line waits for its audio first").toEqual([]);

    vi.advanceTimersByTime(CAPTION_WAIT_MS);
    await settle();
    expect(heard, "the caller reads what was said").toEqual([
      "Putting you through.",
    ]);
    runtime.dispose();
  });
});

describe("CallRuntime audio levels", () => {
  it("publishes the playback envelope level through currentVoiceLevel", async () => {
    // One reader of the level in every engine (#194): the utterance's own
    // bytes, decoded aside. Nothing routes the element through Web Audio.
    const samples = new Float32Array(1000).fill(0.5);
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData() {
          return Promise.resolve({
            sampleRate: 1000,
            length: samples.length,
            getChannelData: () => samples,
          } as unknown as AudioBuffer);
        }
      },
    );
    vi.stubGlobal("AudioContext", class {
      constructor() {
        throw new Error("playback builds no live context");
      }
    });
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { runtime } = makeRuntime();
    const socket = await connectAt(runtime, 0);
    socket.receive({ type: "audio_start", generation: 0, sequence: 1, mime: "audio/mpeg", format: "mp3" });
    socket.onmessage?.({ data: new TextEncoder().encode("speech").buffer } as MessageEvent);
    socket.receive({ type: "audio_done", generation: 0, sequence: 1, done: true });
    await settle();
    expect(runtime.currentVoiceLevel).toBeGreaterThan(0);
    runtime.dispose();
  });
});

describe("CallRuntime connection", () => {
  it("says hello on open and publishes the connected state once", async () => {
    const { runtime, states, latestState } = makeRuntime();
    runtime.start();
    const socket = FakeSocket.latest();
    expect(socket.url).toBe("ws://backend/ws");
    expect(socket.binaryType).toBe("arraybuffer");
    socket.open();
    expect(socket.sentJson()[0]).toMatchObject({ type: "hello", version: 1 });
    await settle();
    expect(latestState()).toMatchObject({ connected: true, status: IDLE_TEXT, statusError: false });
    expect(states.at(-1)).toMatchObject({ connected: true, status: IDLE_TEXT });
    runtime.dispose();
  });

  it("forwards every decoded message and drops malformed frames", async () => {
    const { runtime, messages } = makeRuntime();
    const socket = await connectAt(runtime);
    socket.onmessage?.({ data: "not json" } as MessageEvent);
    socket.receive({ type: "display", seq: 4, action: { op: "clear" } });
    expect(messages.map((message) => message.type)).toEqual([
      "hello_ack",
      "epoch",
      "display",
    ]);
    runtime.dispose();
  });

  it("reconnects after the backend drops the socket", async () => {
    vi.useFakeTimers();
    const { runtime, latestState } = makeRuntime();
    const socket = await connectAt(runtime);
    socket.drop();
    await settle();
    expect(latestState()).toMatchObject({
      connected: false,
      status: "Disconnected. Reconnecting...",
      statusError: true,
    });
    expect(FakeSocket.instances.length).toBe(1);
    vi.advanceTimersByTime(1_500);
    expect(FakeSocket.instances.length).toBe(2);
    runtime.dispose();
  });

  it("pings every 20 seconds and reconnects when a pong is missed", async () => {
    vi.useFakeTimers();
    const { runtime, latestState } = makeRuntime();
    const socket = await connectAt(runtime);
    vi.advanceTimersByTime(20_000);
    const ping = socket.sentJson().find((frame) => frame.type === "ping");
    expect(ping).toBeDefined();
    socket.receive({ type: "pong", nonce: ping!.nonce, time: ping!.time });
    vi.advanceTimersByTime(8_000);
    expect(FakeSocket.instances.length, "an answered ping keeps the socket").toBe(1);

    vi.advanceTimersByTime(12_000);
    expect(socket.sentJson().filter((frame) => frame.type === "ping").length).toBe(2);
    vi.advanceTimersByTime(8_000);
    await settle();
    expect(latestState().status).toBe("Keepalive missed. Reconnecting...");
    expect(FakeSocket.instances.length).toBe(2);
    await settle();
    expect(FakeSocket.instances.length, "the old socket's close does not stack a reconnect").toBe(2);
    vi.advanceTimersByTime(5_000);
    expect(FakeSocket.instances.length).toBe(2);
    runtime.dispose();
  });

  it("retry opens exactly one fresh socket", async () => {
    vi.useFakeTimers();
    const { runtime } = makeRuntime();
    await connectAt(runtime);
    runtime.retry();
    await settle();
    vi.advanceTimersByTime(5_000);
    expect(FakeSocket.instances.length).toBe(2);
    runtime.dispose();
  });

  it("dispose closes the socket without reconnecting or publishing", async () => {
    vi.useFakeTimers();
    const { runtime, states } = makeRuntime();
    const socket = await connectAt(runtime);
    const published = states.length;
    runtime.dispose();
    await settle();
    vi.advanceTimersByTime(60_000);
    expect(socket.readyState).toBe(3);
    expect(FakeSocket.instances.length).toBe(1);
    expect(states.length).toBe(published);
  });

  it("sends screen-state reports only over an open socket", async () => {
    const { runtime } = makeRuntime();
    const report: ScreenStateReport = {
      view: "auto",
      pinned: false,
      has_visual: true,
      visual_kind: "diagram",
      object_ids: ["flow"],
      title: "Flow",
      stale: false,
      generation: 1,
      applied_seq: 4,
    };
    runtime.start();
    expect(runtime.sendScreenState(report)).toBe(false);
    const socket = FakeSocket.latest();
    socket.open();
    expect(runtime.sendScreenState(report)).toBe(true);
    expect(socket.sentJson().at(-1)).toEqual({ type: "screen_state", ...report });
    runtime.dispose();
  });
});

describe("CallRuntime typed turns", () => {
  it("sends a typed turn stamped with the epoch the server announced", async () => {
    const { runtime } = makeRuntime();
    const socket = await connectAt(runtime, 7);
    expect(runtime.sendText("  deploy the branch  ")).toBe(true);
    const frame = socket.sentJson().at(-1);
    expect(frame).toMatchObject({ type: "typed_turn", generation: 7, text: "deploy the branch" });
    expect(typeof frame?.id).toBe("string");
    expect(runtime.sendText("again")).toBe(true);
    expect(socket.sentJson().at(-1)?.id).not.toBe(frame?.id);
    runtime.dispose();
  });

  it("refuses a typed turn it cannot deliver or that says nothing", async () => {
    const { runtime } = makeRuntime();
    runtime.start();
    expect(runtime.sendText("hello")).toBe(false);
    const socket = FakeSocket.latest();
    socket.open();
    // Open, but the server has not announced the epoch the turn must carry.
    expect(runtime.sendText("hello")).toBe(false);
    socket.receive(helloAck());
    socket.receive({ type: "epoch", generation: 2 });
    await settle();
    expect(runtime.sendText("   ")).toBe(false);
    expect(socket.sentJson().some((frame) => frame.type === "typed_turn")).toBe(false);
    socket.drop();
    expect(runtime.sendText("hello")).toBe(false);
    runtime.dispose();
  });
});

describe("CallRuntime voice clips", () => {
  it("sends a push-to-talk clip once the snapshot epoch arrives", async () => {
    const { runtime, latestState } = makeRuntime();
    const socket = await connectAt(runtime, 3);
    runtime.talk();
    await settle();
    expect(latestState().recording).toBe(true);
    runtime.send();
    await settle();
    expect(latestState().recording).toBe(false);

    const clipFrame = socket.sentJson().find((frame) => frame.type === "clip");
    expect(clipFrame).toMatchObject({ type: "clip", generation: 3 });
    expect(socket.sent.at(-1)).toBeInstanceOf(Blob);
    expect(latestState().status).toBe("Waiting for the server to accept your clip...");

    socket.receive({ type: "accepted", id: clipFrame!.id });
    await settle();
    expect(latestState().status).toBe("Transcribing 1 voice clip(s)...");

    // The transcript completes the clip: a reconnect has nothing to resend.
    socket.receive({ type: "transcript", id: clipFrame!.id, text: "hello" });
    socket.drop();
    runtime.retry();
    const next = FakeSocket.latest();
    next.open();
    next.receive(helloAck());
    next.receive({ type: "epoch", generation: 3 });
    expect(next.sentJson().some((frame) => frame.type === "clip")).toBe(false);
    runtime.dispose();
  });

  it("resends an unacknowledged clip on the next socket", async () => {
    const { runtime } = makeRuntime();
    const socket = await connectAt(runtime, 2);
    runtime.talk();
    await settle();
    runtime.send();
    const first = socket.sentJson().find((frame) => frame.type === "clip");
    socket.drop();
    runtime.retry();
    const next = FakeSocket.latest();
    next.open();
    next.receive(helloAck());
    next.receive({ type: "epoch", generation: 2 });
    const resent = next.sentJson().find((frame) => frame.type === "clip");
    expect(resent?.id).toBe(first?.id);
    runtime.dispose();
  });

  it("carries unsent speech recorded during a transfer onto the new leg", async () => {
    const { runtime, latestState } = makeRuntime();
    const socket = await connectAt(runtime, 3);
    socket.receive({ type: "candidate", route: "alpha", generation: 3 });
    await settle();
    expect(latestState().status).toBe("Connecting to alpha\u2026");
    runtime.talk();
    await settle();
    // The line drops mid-sentence: the recording is finalised into the
    // outbox, still addressed to the incoming leg.
    socket.drop();
    runtime.retry();
    const next = FakeSocket.latest();
    next.open();
    next.receive(helloAck());
    // The snapshot says the epoch is alpha's adoption.
    next.receive({ type: "candidate_cleared", route: "alpha", generation: 4, reason: "adopted" });
    next.receive({ type: "epoch", generation: 4 });
    await settle();
    const clips = next.sentJson().filter((frame) => frame.type === "clip");
    expect(clips.map((frame) => frame.generation)).toEqual([4]);
    runtime.dispose();
  });

  // Issue #70: a hangup while connecting sends the same two signals an
  // adoption does, a clear notice and a new epoch; a tab that was away sees
  // only the epoch. Carried along, the words meant for alpha would have run
  // on the operator.
  it("drops unsent speech for a connecting leg when a reconnect finds it was never adopted", async () => {
    const { runtime, latestState } = makeRuntime();
    const socket = await connectAt(runtime, 3);
    socket.receive({ type: "candidate", route: "alpha", generation: 3 });
    runtime.talk();
    await settle();
    // The line drops mid-sentence, and the caller hangs up while it is down.
    socket.drop();
    runtime.retry();
    const next = FakeSocket.latest();
    next.open();
    next.receive(helloAck());
    next.receive({ type: "epoch", generation: 4 });
    await settle();
    expect(next.sentJson().filter((frame) => frame.type === "clip")).toEqual([]);
    expect(latestState()).toMatchObject({
      status: "The line changed before 1 clip(s) went out. Please repeat that.",
      statusError: true,
    });
    runtime.dispose();
  });

  it("carries speech along only to the adoption of the candidate it was recorded for", async () => {
    const { runtime } = makeRuntime();
    const socket = await connectAt(runtime, 3);
    socket.receive({ type: "candidate", route: "alpha", generation: 3 });
    runtime.talk();
    await settle();
    socket.drop();
    runtime.retry();
    const next = FakeSocket.latest();
    next.open();
    next.receive(helloAck());
    // While the tab was away, alpha was hung up on and beta adopted.
    next.receive({ type: "candidate_cleared", route: "beta", generation: 5, reason: "adopted" });
    next.receive({ type: "epoch", generation: 5 });
    await settle();
    expect(next.sentJson().filter((frame) => frame.type === "clip")).toEqual([]);
    runtime.dispose();
  });

  // Issue #58: a clip recorded while a transfer was connecting, and already
  // sent when the new leg is adopted, went out under the old epoch. The server
  // drops it and says so with a `stale_epoch` error naming it; the browser
  // must neither pretend to carry it along nor send it again under the new
  // epoch, which the server would take as the clip it already has.
  it("leaves a clip already on the wire to the server, which tells the caller it was dropped", async () => {
    const { runtime, latestState } = makeRuntime();
    const socket = await connectAt(runtime, 3);
    socket.receive({ type: "candidate", route: "alpha", generation: 3 });
    runtime.talk();
    await settle();
    runtime.send();
    await settle();
    const clipFrames = () => socket.sentJson().filter((frame) => frame.type === "clip");
    expect(clipFrames().map((frame) => frame.generation)).toEqual([3]);
    const id = clipFrames()[0].id;
    socket.receive({ type: "accepted", id });

    // The incoming leg is adopted.
    socket.receive({ type: "candidate_cleared", route: "alpha", generation: 4, reason: "adopted" });
    socket.receive({ type: "epoch", generation: 4 });
    await settle();
    expect(clipFrames().length, "the clip is not sent again").toBe(1);

    const notice = "The line changed before that got through. Please repeat it.";
    socket.receive({ type: "error", id, code: "stale_epoch", message: notice });
    await settle();
    expect(latestState()).toMatchObject({ status: "Error: " + notice, statusError: true });
    runtime.dispose();
  });

  // #213: a routine status said after an error kept its flag, and the page
  // drew the routine status as the error. Each says whether it is one.
  it("clears the error flag with the routine status of the next turn", async () => {
    const { runtime, latestState } = makeRuntime();
    const socket = await connectAt(runtime);
    socket.receive({ type: "error", message: "The model refused." });
    await settle();
    expect(latestState()).toMatchObject({ status: "Error: The model refused.", statusError: true });
    socket.receive({ type: "thinking", route: "operator", waiting: 0 });
    await settle();
    expect(latestState()).toMatchObject({ status: "Operator is listening...", statusError: false });
    socket.receive({ type: "error", message: "The model refused again." });
    socket.receive({ type: "reply", text: "Done.", route: "operator", voiced: false });
    await settle();
    expect(latestState()).toMatchObject({ status: IDLE_TEXT, statusError: false });
    runtime.dispose();
  });

  // Issue #71: the verdict on a clip that was on the wire can land while the
  // tab is away. The clip is sent again under the stamp it went out with, so
  // the server recognizes it and answers with the verdict the tab missed.
  it("shows routing outages as a page error without a spoken reply", async () => {
    const { runtime, latestState } = makeRuntime();
    const socket = await connectAt(runtime);
    socket.receive({
      type: "routing_unavailable",
      message: "Routing is unavailable. Please try again.",
    });
    await settle();
    expect(latestState()).toMatchObject({
      status: "Routing is unavailable. Please try again.",
      statusError: true,
    });
    runtime.dispose();
  });

  it("asks again about a clip already on the wire, under its own stamp, after a reconnect", async () => {
    const { runtime, latestState } = makeRuntime();
    const socket = await connectAt(runtime, 3);
    socket.receive({ type: "candidate", route: "alpha", generation: 3 });
    runtime.talk();
    await settle();
    runtime.send();
    await settle();
    const first = socket.sentJson().filter((frame) => frame.type === "clip");
    expect(first.length).toBe(1);
    socket.receive({ type: "candidate_cleared", route: "alpha", generation: 4, reason: "adopted" });
    socket.receive({ type: "epoch", generation: 4 });

    // The line drops before the server's verdict on the clip arrives.
    socket.drop();
    runtime.retry();
    const next = FakeSocket.latest();
    next.open();
    next.receive(helloAck());
    next.receive({ type: "candidate_cleared", route: "alpha", generation: 4, reason: "adopted" });
    next.receive({ type: "epoch", generation: 4 });
    await settle();
    const resent = next.sentJson().filter((frame) => frame.type === "clip");
    expect(resent.map((frame) => [frame.id, frame.generation])).toEqual([[first[0].id, 3]]);

    const notice = "The line changed before that got through. Please repeat it.";
    next.receive({ type: "error", id: first[0].id, code: "stale_epoch", message: notice });
    await settle();
    expect(latestState()).toMatchObject({ status: "Error: " + notice, statusError: true });
    // Answered: a further reconnect has nothing to ask about.
    next.drop();
    runtime.retry();
    const last = FakeSocket.latest();
    last.open();
    last.receive(helloAck());
    last.receive({ type: "epoch", generation: 4 });
    await settle();
    expect(last.sentJson().filter((frame) => frame.type === "clip")).toEqual([]);
    runtime.dispose();
  });

  it("tells the caller when a new epoch drops speech that never went out", async () => {
    const { runtime, latestState } = makeRuntime();
    const socket = await connectAt(runtime, 3);
    runtime.talk();
    await settle();
    // The line drops mid-sentence, so the clip is kept but not sent, and the
    // leg changes before the page is back.
    socket.drop();
    runtime.retry();
    const next = FakeSocket.latest();
    next.open();
    next.receive({ type: "hello_ack", version: 1 });
    next.receive({ type: "epoch", generation: 4 });
    await settle();
    expect(next.sentJson().filter((frame) => frame.type === "clip")).toEqual([]);
    expect(latestState()).toMatchObject({
      status: "The line changed before 1 clip(s) went out. Please repeat that.",
      statusError: true,
    });
    runtime.dispose();
  });

  it("drops speech from a retired leg when no transfer was announced", async () => {
    const { runtime } = makeRuntime();
    const socket = await connectAt(runtime, 3);
    runtime.talk();
    await settle();
    runtime.send();
    socket.receive({ type: "epoch", generation: 4 });
    const clips = socket.sentJson().filter((frame) => frame.type === "clip");
    expect(clips.map((frame) => frame.generation)).toEqual([3]);
    runtime.dispose();
  });

  it("lets a handoff's goodbye finish and cuts playback on anything else", async () => {
    const handOff = vi.spyOn(AudioPlayback.prototype, "handOffToGeneration");
    const reset = vi.spyOn(AudioPlayback.prototype, "resetForGeneration");
    const { runtime } = makeRuntime();
    const socket = await connectAt(runtime, 3);
    expect(reset, "a connection's first epoch retires old audio").toHaveBeenCalledWith(3);
    reset.mockClear();

    // A return to the operator: the route moves, the generation does not.
    socket.receive({ type: "epoch", generation: 3 });
    // A transfer this tab saw adopted.
    socket.receive({ type: "candidate", route: "alpha", generation: 3 });
    socket.receive({ type: "candidate_cleared", route: "alpha", generation: 4, reason: "adopted" });
    socket.receive({ type: "epoch", generation: 4 });
    expect(handOff.mock.calls).toEqual([[3], [4]]);
    expect(reset).not.toHaveBeenCalled();

    // A hangup or rescue: a new generation nobody announced.
    socket.receive({ type: "epoch", generation: 5 });
    expect(reset).toHaveBeenCalledWith(5);

    // A reconnect's first epoch cuts off too, even at the same generation.
    reset.mockClear();
    socket.drop();
    runtime.retry();
    const next = FakeSocket.latest();
    next.open();
    next.receive(helloAck());
    next.receive({ type: "epoch", generation: 5 });
    expect(reset).toHaveBeenCalledWith(5);
    expect(handOff.mock.calls.length).toBe(2);
    runtime.dispose();
    handOff.mockRestore();
    reset.mockRestore();
  });

  it("ignores Talk while the line is down", async () => {
    const getUserMedia = vi.fn(async () => fakeStream());
    const { runtime } = makeRuntime({ getUserMedia });
    runtime.start();
    runtime.talk();
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();
    runtime.dispose();
  });
});

describe("CallRuntime line controls", () => {
  it("serializes route, model, and thinking requests and locks every picker", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const completions: Array<{
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: unknown) => void;
    }> = [];
    const { runtime, latestState } = makeRuntime({
      postJson: (url, body) => {
        calls.push({ url, body });
        return new Promise((resolve, reject) => completions.push({ resolve, reject }));
      },
    });
    const socket = await connectAt(runtime);
    socket.receive(
      statusMessage({
        route: "fixture-project",
        label: "fixture-project",
        model_name: "fixture-provider/fixture-model",
        models: [{ provider: "fixture-provider", model: "fixture-model", thinks: true }],
        levels: ["off", "high"],
        model_swaps: true,
        models_available: true,
      }),
    );
    await settle();
    const thinkingBefore = latestState().thinking;

    runtime.selectRoute("fixture-project");
    runtime.selectModel("fixture-provider/fixture-model");
    runtime.selectThinking("high");
    await settle();
    expect(calls.length, "cross-control requests are serialized").toBe(1);
    expect(calls[0]).toEqual({ url: "/connect", body: { project: "fixture-project" } });
    expect(latestState()).toMatchObject({
      routeDisabled: true,
      modelDisabled: true,
      thinkingDisabled: true,
    });

    completions.shift()!.resolve({ error: null });
    await settle();
    expect(calls.length, "model starts only after route settles").toBe(2);
    completions.shift()!.resolve({ error: null });
    await settle();
    expect(calls.length, "thinking starts only after model settles").toBe(3);
    completions.shift()!.reject(new Error("backend refused thinking"));
    await settle();
    expect(latestState()).toMatchObject({
      status: "That did not go through: backend refused thinking",
      statusError: true,
      routeDisabled: false,
      modelDisabled: false,
      thinkingDisabled: false,
    });
    expect(latestState().thinking, "a failed request keeps the committed value").toBe(
      thinkingBefore,
    );
    runtime.dispose();
  });

  it("does not show a failure that a newer status already superseded", async () => {
    let fail: (error: unknown) => void = () => {};
    const { runtime, latestState } = makeRuntime({
      postJson: () => new Promise((_, reject) => (fail = reject)),
    });
    const socket = await connectAt(runtime);
    runtime.selectModel("provider/model");
    await settle();
    socket.receive(statusMessage({ route: "alpha", model_name: "provider/model" }));
    fail(new Error("stale"));
    await settle();
    expect(latestState().status).not.toMatch(/did not go through/);
    runtime.dispose();
  });

  it("hangs up straight through the backend", async () => {
    const postJson = vi.fn(async () => ({ error: null }));
    const { runtime } = makeRuntime({ postJson });
    await connectAt(runtime);
    await runtime.hangup();
    expect(postJson).toHaveBeenCalledWith("/hangup", {});
    runtime.dispose();
  });
});

describe("CallRuntime hands-free", () => {
  function fakeHandsFree() {
    const calls: string[] = [];
    let options: HandsFreeControllerOptions | null = null;
    let enabled = false;
    const controller = {
      get isEnabled() {
        return enabled;
      },
      async enable() {
        enabled = true;
        calls.push("enable");
        options!.onState({ state: "armed", message: "Listening locally.", leaseRemainingMs: 0 });
        return true;
      },
      disable(message = "Hands-free is off.") {
        enabled = false;
        calls.push("disable");
        options!.onState({ state: "off", message, leaseRemainingMs: 0 });
      },
      pauseForPtt: () => calls.push("pause"),
      resumeAfterPtt: () => calls.push("resume"),
      epochChanged: () => calls.push("epochChanged"),
      openFollowUpLease: (generation: number) => calls.push(`lease:${generation}`),
    };
    return {
      calls,
      options: () => options!,
      create: (created: HandsFreeControllerOptions) => {
        options = created;
        return controller as unknown as HandsFreeController;
      },
    };
  }

  it("loads the wake detector once and reports the armed state", async () => {
    const handsFree = fakeHandsFree();
    const loadWakeDetector = vi.fn(async () => ({}) as WakeDetector);
    const loadSpeechEndpointer = vi.fn(async () => ({}) as SpeechEndpointer);
    const { runtime, latestState } = makeRuntime({
      loadWakeDetector,
      loadSpeechEndpointer,
      createHandsFree: handsFree.create,
    });
    await connectAt(runtime, 5);
    runtime.toggleHandsFree();
    await settle();
    expect(loadWakeDetector).toHaveBeenCalledTimes(1);
    expect(loadSpeechEndpointer).toHaveBeenCalledTimes(1);
    expect(handsFree.options().speechEndpointer).toBeTruthy();
    expect(latestState()).toMatchObject({ handsFree: true, handsFreeStatus: "Listening locally." });
    expect(handsFree.options().currentEpoch()).toBe(5);

    runtime.toggleHandsFree();
    await settle();
    expect(latestState().handsFree).toBe(false);
    runtime.toggleHandsFree();
    await settle();
    expect(loadWakeDetector).toHaveBeenCalledTimes(1);
    expect(loadSpeechEndpointer).toHaveBeenCalledTimes(1);
    expect(latestState().handsFree).toBe(true);
    runtime.dispose();
  });

  it("reports a detector that fails to load", async () => {
    const { runtime, latestState } = makeRuntime({
      loadWakeDetector: async () => {
        throw new Error("model missing");
      },
      loadSpeechEndpointer: async () => ({}) as SpeechEndpointer,
    });
    await connectAt(runtime);
    runtime.toggleHandsFree();
    await settle();
    expect(latestState()).toMatchObject({
      handsFree: false,
      handsFreeStatus: "Hands-free detector could not load (model missing).",
    });
    runtime.dispose();
  });

  it("puts a hands-free failure on screen as an error, not only in handsFreeStatus", async () => {
    const handsFree = fakeHandsFree();
    const { runtime, latestState } = makeRuntime({
      loadWakeDetector: async () => ({}) as WakeDetector,
      loadSpeechEndpointer: async () => ({}) as SpeechEndpointer,
      createHandsFree: handsFree.create,
    });
    await connectAt(runtime);
    runtime.toggleHandsFree();
    await settle();
    expect(latestState().handsFree).toBe(true);

    // The speech detector fails after "armed", as it did on every engine.
    handsFree.options().onState({
      state: "error",
      message: "Hands-free speech detector failed (Error).",
      leaseRemainingMs: 0,
    });
    expect(latestState()).toMatchObject({
      handsFree: false,
      status: "Hands-free speech detector failed (Error).",
      statusError: true,
    });
    runtime.dispose();
  });

  it("puts a detector that cannot load on screen as an error", async () => {
    const { runtime, latestState } = makeRuntime({
      loadWakeDetector: async () => {
        throw new Error("model missing");
      },
      loadSpeechEndpointer: async () => ({}) as SpeechEndpointer,
    });
    await connectAt(runtime);
    runtime.toggleHandsFree();
    await settle();
    expect(latestState()).toMatchObject({
      status: "Hands-free detector could not load (model missing).",
      statusError: true,
    });
    runtime.dispose();
  });

  it("stops on a new epoch and opens the follow-up lease once playback drains", async () => {
    vi.useFakeTimers();
    const handsFree = fakeHandsFree();
    const { runtime } = makeRuntime({
      loadWakeDetector: async () => ({}) as WakeDetector,
      loadSpeechEndpointer: async () => ({}) as SpeechEndpointer,
      createHandsFree: handsFree.create,
    });
    const socket = await connectAt(runtime, 5);
    runtime.toggleHandsFree();
    await settle();

    socket.receive({
      type: "final_response_audio_closed",
      response_id: "r1",
      generation: 5,
      success: true,
    });
    vi.advanceTimersByTime(399);
    expect(handsFree.calls).not.toContain("lease:5");
    vi.advanceTimersByTime(1);
    expect(handsFree.calls).toContain("lease:5");

    socket.receive({ type: "epoch", generation: 6 });
    expect(handsFree.calls).toContain("epochChanged");
    runtime.dispose();
  });

  // A false trigger is the normal failure of hands-free: Whisper hears
  // nothing and the server answers the clip with an error, not a reply. The
  // page must listen for the wake word again, not wait for a reply that is
  // never coming (#258).
  const noReply = {
    "an error for the clip": (socket: FakeSocket, clip: string) =>
      socket.receive({
        type: "error",
        id: clip,
        message: "I didn't catch that — say it again.",
      }),
    "a reply that could not be spoken": (socket: FakeSocket) =>
      socket.receive({
        type: "final_response_audio_closed",
        response_id: "r1",
        generation: 1,
        success: false,
      }),
    "routing that is unavailable": (socket: FakeSocket) =>
      socket.receive({
        type: "routing_unavailable",
        message: "Routing is unavailable.",
      }),
  };
  for (const [what, answer] of Object.entries(noReply)) {
    it(`listens for the wake word again after ${what}`, async () => {
      stubHandsFreeBrowser();
      const handsFree = realHandsFree(
        () => new FakeRecorder() as unknown as MediaRecorder,
      );
      const { runtime } = makeRuntime(handsFree.options);
      const socket = await connectAt(runtime);
      runtime.toggleHandsFree();
      await settle();
      expect(handsFree.controller().currentState).toBe("armed");
      handsFree.hear();
      handsFree.speechStarts();
      handsFree.speechEnds();
      expect(handsFree.controller().currentState).toBe("awaiting_response");
      const clip = socket.sentJson().find((frame) => frame.type === "clip");
      expect(clip).toBeDefined();

      answer(socket, String(clip!.id));
      expect(handsFree.controller().currentState).toBe("armed");
      handsFree.hear();
      expect(handsFree.controller().currentState).toBe("wake_grace");
      runtime.dispose();
    });
  }

  it("submits a hands-free clip only for the current epoch", async () => {
    const handsFree = fakeHandsFree();
    const { runtime } = makeRuntime({
      loadWakeDetector: async () => ({}) as WakeDetector,
      loadSpeechEndpointer: async () => ({}) as SpeechEndpointer,
      createHandsFree: handsFree.create,
    });
    const socket = await connectAt(runtime, 7);
    runtime.toggleHandsFree();
    await settle();
    handsFree.options().onClip(new Blob(["old"]), "audio/webm", 6);
    handsFree.options().onClip(new Blob(["now"]), "audio/webm", 7);
    const clips = socket.sentJson().filter((frame) => frame.type === "clip");
    expect(clips.map((frame) => frame.generation)).toEqual([7]);
    runtime.dispose();
  });

  it("pauses hands-free for push-to-talk and resumes after", async () => {
    const handsFree = fakeHandsFree();
    const { runtime } = makeRuntime({
      loadWakeDetector: async () => ({}) as WakeDetector,
      loadSpeechEndpointer: async () => ({}) as SpeechEndpointer,
      createHandsFree: handsFree.create,
    });
    await connectAt(runtime);
    runtime.toggleHandsFree();
    await settle();
    runtime.talk();
    await settle();
    expect(handsFree.options().isPttActive()).toBe(true);
    runtime.send();
    await settle();
    expect(handsFree.calls).toEqual(["enable", "pause", "resume"]);
    runtime.dispose();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HandsFreeController,
  HandsFreeControllerOptions,
  WakeDetector,
} from "../../src/hands_free";
import type { ScreenStateReport } from "../../src/controller/types";
import {
  CallRuntime,
  IDLE_TEXT,
  type CallRuntimeOptions,
  type RuntimeState,
} from "../../src/runtime/callRuntime";

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

  receive(message: Record<string, unknown>) {
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
  } as unknown as HTMLAudioElement;
}

async function settle() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function makeRuntime(overrides: Partial<CallRuntimeOptions> = {}) {
  const states: RuntimeState[] = [];
  const messages: BrowserMessage[] = [];
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
  helloAck: Record<string, unknown> = {},
) {
  runtime.start();
  const socket = FakeSocket.latest();
  socket.open();
  socket.receive({ type: "hello_ack", version: 1, stt_streaming: false, mse_mp3: false, ...helloAck });
  socket.receive({ type: "epoch", generation });
  await settle();
  return socket;
}

beforeEach(() => {
  FakeSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
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
    socket.receive({ type: "pong", nonce: ping!.nonce });
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
    socket.receive({ type: "hello_ack", version: 1 });
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
    next.receive({ type: "hello_ack", version: 1 });
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
    next.receive({ type: "hello_ack", version: 1 });
    next.receive({ type: "epoch", generation: 2 });
    const resent = next.sentJson().find((frame) => frame.type === "clip");
    expect(resent?.id).toBe(first?.id);
    runtime.dispose();
  });

  it("carries unsent speech recorded during a transfer onto the new leg", async () => {
    const { runtime, latestState } = makeRuntime();
    const socket = await connectAt(runtime, 3);
    socket.receive({ type: "candidate", route: "alpha" });
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
    next.receive({ type: "hello_ack", version: 1 });
    next.receive({ type: "epoch", generation: 4 });
    await settle();
    const clips = next.sentJson().filter((frame) => frame.type === "clip");
    expect(clips.map((frame) => frame.generation)).toEqual([4]);
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
    socket.receive({ type: "candidate_cleared", generation: 4 });
    socket.receive({ type: "epoch", generation: 4 });
    await settle();
    expect(clipFrames().length, "the clip is not sent again").toBe(1);

    const notice = "The line changed before that got through. Please repeat it.";
    socket.receive({ type: "error", id, code: "stale_epoch", message: notice });
    await settle();
    expect(latestState()).toMatchObject({ status: "Error: " + notice, statusError: true });
    runtime.dispose();
  });

  it("does not resend a clip already on the wire under the new epoch after a reconnect", async () => {
    const { runtime } = makeRuntime();
    const socket = await connectAt(runtime, 3);
    socket.receive({ type: "candidate", route: "alpha", generation: 3 });
    runtime.talk();
    await settle();
    runtime.send();
    await settle();
    expect(socket.sentJson().filter((frame) => frame.type === "clip").length).toBe(1);
    socket.receive({ type: "candidate_cleared", generation: 4 });
    socket.receive({ type: "epoch", generation: 4 });

    // The line drops before the server's verdict on the clip arrives.
    socket.drop();
    runtime.retry();
    const next = FakeSocket.latest();
    next.open();
    next.receive({ type: "hello_ack", version: 1 });
    next.receive({ type: "epoch", generation: 4 });
    await settle();
    expect(next.sentJson().filter((frame) => frame.type === "clip")).toEqual([]);
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
    socket.receive({
      type: "status",
      route: "fixture-project",
      label: "fixture-project",
      model_name: "fixture-provider/fixture-model",
      models: [{ provider: "fixture-provider", model: "fixture-model", thinks: true }],
      levels: ["off", "high"],
      model_swaps: true,
      models_available: true,
    });
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
    socket.receive({ type: "status", route: "alpha", model_name: "provider/model" });
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
    const { runtime, latestState } = makeRuntime({
      loadWakeDetector,
      createHandsFree: handsFree.create,
    });
    await connectAt(runtime, 5);
    runtime.toggleHandsFree();
    await settle();
    expect(loadWakeDetector).toHaveBeenCalledTimes(1);
    expect(latestState()).toMatchObject({ handsFree: true, handsFreeStatus: "Listening locally." });
    expect(handsFree.options().currentEpoch()).toBe(5);

    runtime.toggleHandsFree();
    await settle();
    expect(latestState().handsFree).toBe(false);
    runtime.toggleHandsFree();
    await settle();
    expect(loadWakeDetector).toHaveBeenCalledTimes(1);
    expect(latestState().handsFree).toBe(true);
    runtime.dispose();
  });

  it("reports a detector that fails to load", async () => {
    const { runtime, latestState } = makeRuntime({
      loadWakeDetector: async () => {
        throw new Error("model missing");
      },
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

  it("stops on a new epoch and opens the follow-up lease once playback drains", async () => {
    vi.useFakeTimers();
    const handsFree = fakeHandsFree();
    const { runtime } = makeRuntime({
      loadWakeDetector: async () => ({}) as WakeDetector,
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

  it("submits a hands-free clip only for the current epoch", async () => {
    const handsFree = fakeHandsFree();
    const { runtime } = makeRuntime({
      loadWakeDetector: async () => ({}) as WakeDetector,
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

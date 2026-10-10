import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip } from "../../src/runtime/outbox";
import { NoCaptureApi, PushToTalk, type PushToTalkOptions } from "../../src/runtime/pushToTalk";

// Ported from the legacy runtime's recorder lifecycle regressions: one
// permission request per press, the microphone is always released, and a
// recorder that finishes late keeps its own chunks and discard choice.

class FakeRecorder {
  static throwOnCreate = false;
  static deferStop = false;
  static latest: FakeRecorder | null = null;
  static created = 0;
  state: RecordingState = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: { error: unknown }) => void) | null = null;

  constructor() {
    if (FakeRecorder.throwOnCreate) throw new Error("codec unavailable");
    FakeRecorder.created += 1;
    FakeRecorder.latest = this;
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    if (!FakeRecorder.deferStop) this.onstop?.();
  }
}

function fakeStream() {
  let stops = 0;
  return {
    getTracks: () => [{ stop: () => (stops += 1) }],
    stops: () => stops,
  };
}


class FakeMeterAnalyser {
  fftSize = 0;
  connect() {}
  disconnect() {}
  getByteTimeDomainData(values: Uint8Array) { values.fill(200); }
}

class FakeMeterContext {
  state = "running";
  destination = {} as AudioNode;
  createMediaStreamSource() { return { connect() {}, disconnect() {} } as unknown as MediaStreamAudioSourceNode; }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } as unknown as GainNode; }
  createAnalyser() { return new FakeMeterAnalyser() as unknown as AnalyserNode; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

/** A WebKit context whose `resume()` promise is never settled. */
class PendingResumeContext extends FakeMeterContext {
  state = "suspended";
  resume() {
    return new Promise<void>(() => {});
  }
}

/** A context that cannot put the microphone into a graph. */
class BrokenGraphContext extends FakeMeterContext {
  createMediaStreamSource(): MediaStreamAudioSourceNode {
    throw new Error("no graph here");
  }
}

function harness(overrides: Partial<PushToTalkOptions> = {}) {
  const outbox: Clip[] = [];
  const status = { text: "", error: false as boolean | undefined };
  const recording: boolean[] = [];
  let getUserMediaCalls = 0;
  let resolveMedia: (stream: unknown) => void = () => {};
  let rejectMedia: (error: unknown) => void = () => {};
  const ptt = new PushToTalk({
    idleText: "idle",
    getUserMedia: () => {
      getUserMediaCalls += 1;
      return new Promise((resolve, reject) => {
        resolveMedia = resolve as (stream: unknown) => void;
        rejectMedia = reject;
      });
    },
    createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
    newClipId: () => `clip-${outbox.length + 1}`,
    context: () => ({ epoch: 0, transferEra: null, streamingSelected: false }),
    openSocket: () => null,
    enqueue: (clip) => {
      outbox.push(clip);
      return true;
    },
    flush: () => {},
    onRecordingChange: (on) => recording.push(on),
    onStatus: (text, error) => {
      status.text = text;
      if (error !== undefined) status.error = error;
    },
    pauseHandsFree: () => {},
    resumeHandsFree: () => {},
    ...overrides,
  });
  return {
    ptt,
    outbox,
    status,
    recording,
    getUserMediaCalls: () => getUserMediaCalls,
    resolveMedia: (stream: unknown) => resolveMedia(stream),
    rejectMedia: (error: unknown) => rejectMedia(error),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("PushToTalk", () => {
  it("keeps one stream, releases the microphone, and keeps late recorders separate", async () => {
    FakeRecorder.created = 0;
    const h = harness();
    const streams: Array<ReturnType<typeof fakeStream>> = [];
    const stream = () => {
      const value = fakeStream();
      streams.push(value);
      return value;
    };

    const firstStart = h.ptt.start();
    const duplicateStart = h.ptt.start();
    expect(h.getUserMediaCalls(), "permission request is deduplicated").toBe(1);
    h.resolveMedia(stream());
    await Promise.all([firstStart, duplicateStart]);
    expect(FakeRecorder.created, "one stream creates one recorder").toBe(1);
    expect(h.ptt.isRecording()).toBe(true);
    h.ptt.stop(false);
    expect(streams[0].stops(), "discard stops the microphone track").toBe(1);

    FakeRecorder.throwOnCreate = true;
    const failedStart = h.ptt.start();
    h.resolveMedia(stream());
    await failedStart;
    expect(streams[1].stops(), "constructor failure releases the stream").toBe(1);
    expect(h.status.text).toMatch(/cannot record audio/);
    FakeRecorder.throwOnCreate = false;

    const errorStart = h.ptt.start();
    h.resolveMedia(stream());
    await errorStart;
    const erroring = FakeRecorder.latest!;
    expect(typeof erroring.onerror).toBe("function");
    erroring.state = "inactive";
    erroring.onerror!({ error: new Error("encoder failed") });
    expect(streams[2].stops(), "recorder errors release the microphone").toBe(1);

    // A recorder may finish asynchronously after the next recording starts.
    // Its chunks and discard choice must stay attached to that recorder.
    FakeRecorder.deferStop = true;
    const oldStart = h.ptt.start();
    h.resolveMedia(stream());
    await oldStart;
    const oldRecorder = FakeRecorder.latest!;
    h.ptt.stop(false);
    await h.ptt.start();
    expect(h.getUserMediaCalls(), "new recording waits for terminal cleanup").toBe(4);
    oldRecorder.ondataavailable!({ data: new Blob(["old"]) });
    oldRecorder.onstop!();
    expect(h.outbox.length, "old discard stays with old recorder").toBe(0);
    const nextStart = h.ptt.start();
    h.resolveMedia(stream());
    await nextStart;
    const nextRecorder = FakeRecorder.latest!;
    h.ptt.stop(true);
    nextRecorder.ondataavailable!({ data: new Blob(["new"]) });
    nextRecorder.onstop!();
    expect(h.outbox.length).toBe(1);
    expect(h.outbox[0].audio.size).toBe(3);
    FakeRecorder.deferStop = false;

    const denied = h.ptt.start();
    h.rejectMedia(
      Object.assign(new Error("permission denied"), { name: "NotAllowedError" }),
    );
    await denied;
    expect(h.status.text).toMatch(/Microphone unavailable \(NotAllowedError\)/);
    expect(h.status.error).toBe(true);
  });

  it("honours a stop pressed while the permission prompt is open", async () => {
    const h = harness();
    const stream = fakeStream();
    const start = h.ptt.start();
    expect(h.ptt.isActive).toBe(true);
    h.ptt.stop(true);
    h.resolveMedia(stream);
    await start;
    expect(stream.stops()).toBe(1);
    expect(h.ptt.isRecording()).toBe(false);
    expect(h.ptt.isActive).toBe(false);
    expect(h.outbox.length).toBe(0);
    expect(h.status.text).toBe("idle");
  });

  it("stamps the clip with the epoch and transfer it started under", async () => {
    let context = { epoch: 3, transferEra: "alpha" as string | null, streamingSelected: false };
    const h = harness({ context: () => context });
    const start = h.ptt.start();
    h.resolveMedia(fakeStream());
    await start;
    const recorder = FakeRecorder.latest!;
    context = { epoch: 4, transferEra: null, streamingSelected: false };
    h.ptt.stop(true);
    recorder.ondataavailable!({ data: new Blob(["words"]) });
    recorder.onstop!();
    expect(h.outbox[0].epoch).toBe(3);
    expect(h.outbox[0].transferEra).toBe("alpha");
    expect(h.recording).toEqual([true, false]);
  });

  it("streams chunks while recording when the backend selected streaming", async () => {
    const sent: unknown[] = [];
    const socket = { send: (data: unknown) => sent.push(data) } as unknown as WebSocket;
    const h = harness({
      context: () => ({ epoch: 2, transferEra: null, streamingSelected: true }),
      openSocket: () => socket,
      createRecorder: () => {
        const recorder = new FakeRecorder();
        recorder.mimeType = "audio/webm;codecs=opus";
        return recorder as unknown as MediaRecorder;
      },
    });
    const start = h.ptt.start();
    h.resolveMedia(fakeStream());
    await start;
    const recorder = FakeRecorder.latest!;
    const chunk = new Blob(["chunk"]);
    recorder.ondataavailable!({ data: chunk });
    h.ptt.stop(true);

    const frames = sent.map((frame) =>
      typeof frame === "string" ? JSON.parse(frame).type : frame,
    );
    expect(frames).toEqual(["stt_start", "stt_chunk", chunk, "stt_start", "stt_end"]);
    expect(h.outbox[0].streaming).toBe(true);
    expect(h.outbox[0].sent, "a streamed clip is already on the wire").toBe(true);
    expect(h.outbox[0].transmitted, "and keeps the stamp it went out with").toBe(true);
  });

  it("feeds the microphone analyser level while recording", async () => {
    const levels: number[] = [];
    vi.stubGlobal("AudioContext", FakeMeterContext);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const h = harness({ onAudioLevel: (level) => levels.push(level) });
    const start = h.ptt.start();
    h.resolveMedia(fakeStream());
    await start;
    expect(levels.at(-1)).toBeGreaterThan(0);
    h.ptt.stop(false);
  });

  // WebKit's `AudioContext.resume()` can be left pending when the page's
  // audio session is taken away, and the meter's context is created and
  // resumed inside the press. Waited for, that press never reached the
  // recorder, `starting` stayed true for the rest of the page's life, and
  // every later press returned at the guard with nothing said.
  it("records when the meter's audio context never resumes", async () => {
    vi.stubGlobal("AudioContext", PendingResumeContext);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const h = harness({ onAudioLevel: () => {} });
    const start = h.ptt.start();
    h.resolveMedia(fakeStream());
    await start;
    expect(h.ptt.isRecording(), "the recorder runs without the meter").toBe(true);
    expect(h.ptt.isStarting).toBe(false);
    expect(h.recording).toEqual([true]);
    expect(h.status.text).toMatch(/Recording/);
    h.ptt.stop(true);
    expect(h.ptt.isActive, "and the press after it is free to start").toBe(false);
  });

  // A meter that cannot be built at all is still only a picture of the voice.
  it("records when the meter's graph cannot be built", async () => {
    vi.stubGlobal("AudioContext", BrokenGraphContext);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const h = harness({ onAudioLevel: () => {} });
    const start = h.ptt.start();
    h.resolveMedia(fakeStream());
    await start;
    expect(h.ptt.isRecording()).toBe(true);
    expect(h.status.text).toMatch(/Recording/);
    h.ptt.stop(false);
  });

  // Hands-free asks whether push-to-talk still holds the microphone before it
  // takes it back; a recording that has not let go yet makes it refuse (#257).
  it("has let go of the recording when it hands the microphone back", async () => {
    let activeAtResume: boolean | null = null;
    let ptt: PushToTalk | null = null;
    const h = harness({
      resumeHandsFree: () => {
        activeAtResume = ptt!.isActive;
      },
    });
    ptt = h.ptt;
    const start = h.ptt.start();
    h.resolveMedia(fakeStream());
    await start;
    h.ptt.stop(true);
    expect(activeAtResume).toBe(false);
  });

  // A browser stops the recorder itself when its track ends: the microphone
  // is unplugged, or another app takes the iPad's audio session (#262).
  it("says the recording ended when the recorder stops by itself", async () => {
    const h = harness();
    const start = h.ptt.start();
    h.resolveMedia(fakeStream());
    await start;
    expect(h.recording).toEqual([true]);
    const recorder = FakeRecorder.latest!;
    recorder.ondataavailable!({ data: new Blob(["words"]) });
    recorder.state = "inactive";
    recorder.onstop!();
    expect(h.recording).toEqual([true, false]);
    expect(h.ptt.isActive).toBe(false);
    expect(h.outbox.length, "what was said before it stopped is sent").toBe(1);
    expect(h.status).toEqual({
      text: "Recording stopped: the microphone was taken away.",
      error: true,
    });
  });

  // `navigator.mediaDevices` is undefined on a page that is not a secure
  // origin, which reached the caller as "Microphone unavailable (TypeError)".
  it("names https when the browser offers no microphone API", async () => {
    const status = { text: "", error: undefined as boolean | undefined };
    const ptt = new PushToTalk({
      idleText: "idle",
      createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
      newClipId: () => "clip-1",
      context: () => ({ epoch: 0, transferEra: null, streamingSelected: false }),
      openSocket: () => null,
      enqueue: () => true,
      flush: () => {},
      onRecordingChange: () => {},
      onStatus: (text, error) => {
        status.text = text;
        if (error !== undefined) status.error = error;
      },
      pauseHandsFree: () => {},
      resumeHandsFree: () => {},
    });
    expect(navigator.mediaDevices, "the test page is not a secure origin").toBe(
      undefined,
    );
    await ptt.start();
    expect(status.text).toMatch(/https/);
    expect(status.error).toBe(true);
    expect(ptt.isActive, "and the next press is free to try again").toBe(false);
  });
});

/**
 * Push-to-talk's lifecycle, phase by event (#365). Each row puts a fresh
 * push-to-talk in a phase, applies one event, and checks what the event did
 * as the page and hands-free see it: the page's `recording` flag (published
 * values applied in order, as `CallRuntime.update` does), the status it set,
 * how often hands-free was paused and resumed, the microphone asked for and
 * released, the meter's audio context closed, the socket frames sent and the
 * clips queued. Then it checks which phase the row left push-to-talk in. A
 * phase is not visible from outside, so `expectPhase` recognises it by what
 * the next event does.
 *
 * The recorder streams (the backend selected streaming and the codec is
 * opus), so the rows also pin what goes on the wire. Its `stop()` never fires
 * `stop` by itself, so the `stopping` phase can be seen.
 */
describe("push-to-talk lifecycle: phase x event", () => {
  type Phase =
    | "idle"
    | "acquiring"
    /** A Send or Discard arrived while the permission prompt was open. */
    | "cancelled"
    | "recording"
    /** Recording, and the recorder has stopped by itself; its `stop` event has not fired yet. */
    | "self-stopped"
    | "stopping, send"
    | "stopping, discard"
    /** Idle after the recorder failed; the failed recorder's own events may still arrive. */
    | "failed";
  type Event =
    | "press"
    | "send"
    | "discard"
    | "granted"
    | "granted, no recorder"
    | "granted, start throws"
    | "refused"
    | "refused, no capture API"
    | "data"
    | "stopped"
    | "stopped, outbox full"
    | "recorder error"
    | "abandoned"
    | "abandoned, another clip"
    | "late data"
    | "late stop";
  type Then = "idle" | "acquiring" | "cancelled" | "recording" | "self-stopped" | "stopping";
  interface Seen {
    /** The page's `recording` after the event. */
    recording: boolean;
    /** The status the event set, or null when it set none. */
    status: [string, boolean] | null;
    paused: number;
    resumed: number;
    /** `getUserMedia` calls. */
    asked: number;
    /** Microphone tracks stopped. */
    released: number;
    /** Meter contexts closed. */
    closed: number;
    frames: string[];
    /** Clips queued, as `id size streaming sent`. */
    clips: string[];
  }
  interface Row {
    from: Phase;
    event: Event;
    seen: Partial<Seen>;
    then: Then;
  }

  const RECORDING_STATUS = "Recording... Send when you are done, Discard to throw it away.";
  const NOTHING: Seen = {
    recording: false,
    status: null,
    paused: 0,
    resumed: 0,
    asked: 0,
    released: 0,
    closed: 0,
    frames: [],
    clips: [],
  };

  class TableRecorder {
    state: RecordingState = "inactive";
    mimeType = "audio/webm;codecs=opus";
    startThrows = false;
    stopCalls = 0;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((event: { error: unknown }) => void) | null = null;
    start() {
      if (this.startThrows) throw new Error("start refused");
      this.state = "recording";
    }
    stop() {
      this.stopCalls += 1;
      this.state = "inactive";
    }
  }

  class CountingContext extends FakeMeterContext {
    static closed = 0;
    close() {
      CountingContext.closed += 1;
      return Promise.resolve();
    }
  }

  beforeEach(() => {
    vi.stubGlobal("AudioContext", CountingContext);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  function harness() {
    const recorders: TableRecorder[] = [];
    const streams: Array<ReturnType<typeof fakeStream>> = [];
    const frames: string[] = [];
    const clips: Clip[] = [];
    const counts = { paused: 0, resumed: 0, asked: 0 };
    let recording = false;
    let status: [string, boolean] | null = null;
    let outboxFull = false;
    let nextRecorderThrows: "create" | "start" | null = null;
    let answer: { resolve: (stream: unknown) => void; reject: (error: unknown) => void } | null = null;
    const socket = {
      send: (data: unknown) =>
        frames.push(typeof data === "string" ? JSON.parse(data).type : "blob"),
    } as unknown as WebSocket;
    const ptt = new PushToTalk({
      idleText: "idle",
      getUserMedia: () => {
        counts.asked += 1;
        return new Promise((resolve, reject) => {
          answer = { resolve: resolve as (stream: unknown) => void, reject };
        });
      },
      createRecorder: () => {
        if (nextRecorderThrows === "create") throw new Error("codec unavailable");
        const recorder = new TableRecorder();
        recorder.startThrows = nextRecorderThrows === "start";
        recorders.push(recorder);
        return recorder as unknown as MediaRecorder;
      },
      createAudioContext: () => new CountingContext() as unknown as AudioContext,
      onAudioLevel: () => {},
      newClipId: () => `clip-${recorders.length}`,
      context: () => ({ epoch: 1, transferEra: null, streamingSelected: true }),
      openSocket: () => socket,
      enqueue: (clip) => {
        if (outboxFull) return false;
        clips.push(clip);
        return true;
      },
      flush: () => frames.push("flush"),
      onRecordingChange: (on) => (recording = on),
      onStatus: (text, error) => (status = [text, error]),
      pauseHandsFree: () => (counts.paused += 1),
      resumeHandsFree: () => (counts.resumed += 1),
    });
    const released = () => streams.reduce((sum, stream) => sum + stream.stops(), 0);
    let mark = { released: 0, closed: 0, frames: 0, clips: 0 };
    return {
      ptt,
      recorders,
      latest: () => recorders[recorders.length - 1],
      grant: async (throws: "create" | "start" | null = null) => {
        nextRecorderThrows = throws;
        const stream = fakeStream();
        streams.push(stream);
        answer!.resolve(stream);
        await settle();
        nextRecorderThrows = null;
      },
      refuse: async (error: unknown) => {
        answer!.reject(error);
        await settle();
      },
      fillOutbox: () => (outboxFull = true),
      /** Starts counting this row's effects from here. */
      reset: () => {
        counts.paused = counts.resumed = counts.asked = 0;
        status = null;
        mark = { released: released(), closed: CountingContext.closed, frames: frames.length, clips: clips.length };
      },
      seen: (): Seen => ({
        recording,
        status,
        ...counts,
        released: released() - mark.released,
        closed: CountingContext.closed - mark.closed,
        frames: frames.slice(mark.frames),
        clips: clips
          .slice(mark.clips)
          .map((clip) => `${clip.id} ${clip.audio.size} ${clip.streaming} ${clip.sent}`),
      }),
    };
  }
  type Harness = ReturnType<typeof harness>;

  function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function reach(phase: Phase): Promise<{ h: Harness; earlier: TableRecorder | null }> {
    const h = harness();
    let earlier: TableRecorder | null = null;
    if (phase !== "idle") void h.ptt.start();
    if (phase === "cancelled") h.ptt.stop(true);
    if (phase !== "idle" && phase !== "acquiring" && phase !== "cancelled") {
      await h.grant();
      h.latest().ondataavailable!({ data: new Blob(["abc"]) });
    }
    if (phase === "self-stopped") h.latest().state = "inactive";
    if (phase === "stopping, send") h.ptt.stop(true);
    if (phase === "stopping, discard") h.ptt.stop(false);
    if (phase === "failed") {
      earlier = h.latest();
      earlier.state = "inactive";
      earlier.onerror!({ error: new Error("encoder failed") });
    }
    h.reset();
    return { h, earlier };
  }

  async function apply(h: Harness, earlier: TableRecorder | null, event: Event): Promise<void> {
    switch (event) {
      case "press":
        void h.ptt.start();
        return settle();
      case "send":
        return h.ptt.stop(true);
      case "discard":
        return h.ptt.stop(false);
      case "granted":
        return h.grant();
      case "granted, no recorder":
        return h.grant("create");
      case "granted, start throws":
        return h.grant("start");
      case "refused":
        return h.refuse(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
      case "refused, no capture API":
        return h.refuse(new NoCaptureApi());
      case "data":
        return h.latest().ondataavailable!({ data: new Blob(["defg"]) });
      case "stopped":
        h.latest().state = "inactive";
        return h.latest().onstop!();
      case "stopped, outbox full":
        h.fillOutbox();
        h.latest().state = "inactive";
        return h.latest().onstop!();
      case "recorder error":
        h.latest().state = "inactive";
        return h.latest().onerror!({ error: new Error("encoder failed") });
      case "abandoned":
        return h.ptt.abandonStreaming("clip-1");
      case "abandoned, another clip":
        return h.ptt.abandonStreaming("clip-9");
      case "late data":
        return earlier!.ondataavailable!({ data: new Blob(["late"]) });
      case "late stop":
        return earlier!.onstop!();
    }
  }

  /** Recognises the phase by what the next event does. */
  async function expectPhase(h: Harness, then: Then): Promise<void> {
    const recorders = h.recorders.length;
    switch (then) {
      case "idle": {
        expect([h.ptt.isActive, h.ptt.isStarting, h.ptt.isRecording()]).toEqual([false, false, false]);
        h.reset();
        void h.ptt.start();
        expect(h.seen().asked, "a press asks for the microphone").toBe(1);
        return;
      }
      case "acquiring":
      case "cancelled": {
        expect([h.ptt.isActive, h.ptt.isStarting, h.ptt.isRecording()]).toEqual([true, true, false]);
        await h.grant();
        expect(h.recorders.length - recorders, "the grant records unless cancelled").toBe(then === "acquiring" ? 1 : 0);
        expect(h.ptt.isRecording()).toBe(then === "acquiring");
        return;
      }
      case "recording": {
        expect([h.ptt.isActive, h.ptt.isStarting, h.ptt.isRecording()]).toEqual([true, false, true]);
        const recorder = h.latest();
        h.ptt.stop(true);
        expect(recorder.stopCalls, "a send stops this recorder").toBe(1);
        return;
      }
      case "self-stopped": {
        // `isRecording()` is not pinned here: today it reads the recorder,
        // which has stopped, while push-to-talk still holds the take.
        expect([h.ptt.isActive, h.ptt.isStarting]).toEqual([true, false]);
        const recorder = h.latest();
        h.ptt.stop(true);
        expect(recorder.stopCalls, "a send leaves a stopped recorder alone").toBe(0);
        recorder.onstop!();
        expect(h.seen().status?.[0]).toMatch(/taken away/);
        return;
      }
      case "stopping": {
        expect([h.ptt.isActive, h.ptt.isStarting, h.ptt.isRecording()]).toEqual([true, false, false]);
        h.reset();
        void h.ptt.start();
        expect(h.seen().asked, "a press waits for the stop").toBe(0);
        h.latest().onstop!();
        expect(h.ptt.isActive, "the recorder's stop ends it").toBe(false);
        return;
      }
    }
  }

  const TAKEN = ["Recording stopped: the microphone was taken away.", true] as [string, boolean];
  const FAILED = ["Recording failed (encoder failed).", true] as [string, boolean];
  const NO_HTTPS = ["No microphone on this page: open it over https, not by address.", true] as [string, boolean];
  const REFUSED = ["Microphone unavailable (NotAllowedError).", true] as [string, boolean];
  const IDLE = ["idle", false] as [string, boolean];
  const ENDED = { recording: false, released: 1, closed: 1, resumed: 1 };
  const rows: Row[] = [
    { from: "idle", event: "press", seen: { asked: 1, paused: 1 }, then: "acquiring" },
    { from: "idle", event: "send", seen: {}, then: "idle" },
    { from: "idle", event: "discard", seen: {}, then: "idle" },
    { from: "idle", event: "abandoned", seen: {}, then: "idle" },

    // A second tap while the permission prompt is open is swallowed (#365).
    { from: "acquiring", event: "press", seen: {}, then: "acquiring" },
    { from: "acquiring", event: "send", seen: {}, then: "cancelled" },
    { from: "acquiring", event: "discard", seen: {}, then: "cancelled" },
    {
      from: "acquiring",
      event: "granted",
      seen: { recording: true, status: [RECORDING_STATUS, false], frames: ["stt_start"] },
      then: "recording",
    },
    {
      from: "acquiring",
      event: "granted, no recorder",
      seen: { ...ENDED, status: ["This browser cannot record audio (codec unavailable).", true] },
      then: "idle",
    },
    {
      from: "acquiring",
      event: "granted, start throws",
      seen: { ...ENDED, status: ["This browser cannot record audio (start refused).", true], frames: ["stt_start"] },
      then: "idle",
    },
    { from: "acquiring", event: "refused", seen: { resumed: 1, closed: 1, status: REFUSED }, then: "idle" },
    { from: "acquiring", event: "refused, no capture API", seen: { resumed: 1, closed: 1, status: NO_HTTPS }, then: "idle" },

    { from: "cancelled", event: "press", seen: {}, then: "cancelled" },
    { from: "cancelled", event: "send", seen: {}, then: "cancelled" },
    { from: "cancelled", event: "granted", seen: { ...ENDED, status: IDLE }, then: "idle" },
    { from: "cancelled", event: "refused", seen: { resumed: 1, closed: 1, status: REFUSED }, then: "idle" },

    { from: "recording", event: "press", seen: { recording: true }, then: "recording" },
    { from: "recording", event: "send", seen: { recording: true }, then: "stopping" },
    { from: "recording", event: "discard", seen: { recording: true }, then: "stopping" },
    { from: "recording", event: "data", seen: { recording: true, frames: ["stt_chunk", "blob"] }, then: "recording" },
    // The browser stopped the recorder: what was said is sent (#262).
    {
      from: "recording",
      event: "stopped",
      seen: { ...ENDED, status: TAKEN, clips: ["clip-1 3 true true"], frames: ["stt_start", "stt_end", "flush"] },
      then: "idle",
    },
    { from: "recording", event: "stopped, outbox full", seen: ENDED, then: "idle" },
    { from: "recording", event: "recorder error", seen: { ...ENDED, status: FAILED }, then: "idle" },
    { from: "recording", event: "abandoned", seen: { recording: true }, then: "recording" },
    { from: "recording", event: "abandoned, another clip", seen: { recording: true }, then: "recording" },

    { from: "self-stopped", event: "send", seen: { recording: true }, then: "self-stopped" },
    {
      from: "self-stopped",
      event: "stopped",
      seen: { ...ENDED, status: TAKEN, clips: ["clip-1 3 true true"], frames: ["stt_start", "stt_end", "flush"] },
      then: "idle",
    },

    { from: "stopping, send", event: "press", seen: { recording: true }, then: "stopping" },
    { from: "stopping, send", event: "send", seen: { recording: true }, then: "stopping" },
    { from: "stopping, send", event: "discard", seen: { recording: true }, then: "stopping" },
    { from: "stopping, send", event: "data", seen: { recording: true, frames: ["stt_chunk", "blob"] }, then: "stopping" },
    {
      from: "stopping, send",
      event: "stopped",
      seen: { ...ENDED, clips: ["clip-1 3 true true"], frames: ["stt_start", "stt_end", "flush"] },
      then: "idle",
    },
    { from: "stopping, send", event: "stopped, outbox full", seen: ENDED, then: "idle" },
    { from: "stopping, send", event: "recorder error", seen: { ...ENDED, status: FAILED }, then: "idle" },
    { from: "stopping, send", event: "abandoned", seen: { recording: true }, then: "stopping" },
    { from: "stopping, discard", event: "data", seen: { recording: true, frames: ["stt_chunk", "blob"] }, then: "stopping" },
    { from: "stopping, discard", event: "stopped", seen: { ...ENDED, status: IDLE }, then: "idle" },
    { from: "stopping, discard", event: "recorder error", seen: { ...ENDED, status: FAILED }, then: "idle" },

    // A recorder fires `dataavailable` and `stop` after its `error`.
    { from: "failed", event: "late data", seen: {}, then: "idle" },
    { from: "failed", event: "late stop", seen: { resumed: 1 }, then: "idle" },
    { from: "failed", event: "press", seen: { asked: 1, paused: 1 }, then: "acquiring" },
  ];

  it.each(rows)("$from | $event -> $then", async ({ from, event, seen, then }) => {
    const { h, earlier } = await reach(from);
    await apply(h, earlier, event);
    expect(h.seen()).toEqual({ ...NOTHING, ...seen });
    await expectPhase(h, then);
  });

  // The streaming half of `abandoned`: the clip goes whole, not as a stream.
  it("sends a clip whole once the backend abandoned its stream", async () => {
    const { h } = await reach("recording");
    h.ptt.abandonStreaming("clip-1");
    h.latest().ondataavailable!({ data: new Blob(["defg"]) });
    h.ptt.stop(true);
    h.latest().onstop!();
    expect(h.seen().frames, "no chunk or end goes out on the stream").toEqual(["flush"]);
    expect(h.seen().clips).toEqual(["clip-1 7 false false"]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Clip } from "../../src/runtime/outbox";
import { PushToTalk, type PushToTalkOptions } from "../../src/runtime/pushToTalk";

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

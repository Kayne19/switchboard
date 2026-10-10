// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HandsFreeController,
  SpeechEndpointer,
  WakeDetector,
} from "../../src/hands_free";

// A real HandsFreeController over fakes, driven through the lifecycle a caller
// walks: start, armed, wake word, capture, stop, a pause for push-to-talk, and
// a detector that fails. Every one of those paths resets the two detectors, so
// a reset that does not terminate (`resetListening` calling itself) overflows
// the stack here instead of in a caller's browser.

type Callback = () => void;
type ErrorCallback = (error: unknown) => void;

function fakeDetector() {
  let detect: Callback = () => undefined;
  let fail: ErrorCallback = () => undefined;
  const detector = {
    resets: 0,
    frames: 0,
    loads: 0,
    load: async () => {
      detector.loads += 1;
    },
    reset: () => {
      detector.resets += 1;
    },
    process: () => {
      detector.frames += 1;
    },
    onDetect: (callback: Callback) => {
      detect = callback;
      return () => undefined;
    },
    onError: (callback: ErrorCallback) => {
      fail = callback;
      return () => undefined;
    },
    hear: () => detect(),
    breakDown: (error: unknown) => fail(error),
  };
  return detector;
}

function fakeEndpointer() {
  let start: Callback = () => undefined;
  let end: Callback = () => undefined;
  const endpointer = {
    resets: 0,
    loads: 0,
    load: async () => {
      endpointer.loads += 1;
    },
    reset: () => {
      endpointer.resets += 1;
    },
    process: () => undefined,
    onSpeechStart: (callback: Callback) => {
      start = callback;
      return () => undefined;
    },
    onSpeechEnd: (callback: Callback) => {
      end = callback;
      return () => undefined;
    },
    onError: () => () => undefined,
    speechStarts: () => start(),
    speechEnds: () => end(),
  };
  return endpointer;
}

function fakeRecorder() {
  const recorder = {
    state: "inactive" as "inactive" | "recording",
    mimeType: "audio/webm",
    startCalls: 0,
    stopCalls: 0,
    ondataavailable: null as ((event: { data: Blob }) => void) | null,
    onstop: null as (() => void) | null,
    onerror: null as ((event: { error: unknown }) => void) | null,
    start() {
      recorder.startCalls += 1;
      recorder.state = "recording";
    },
    stop() {
      recorder.stopCalls += 1;
      recorder.state = "inactive";
      recorder.onstop?.();
    },
  };
  return recorder;
}

function fakeAudio() {
  const node = {
    port: {
      onmessage: null as ((event: MessageEvent) => void) | null,
      close: () => undefined,
      postMessage: () => undefined,
    },
    connect: () => undefined,
    disconnect: () => undefined,
  };
  const context = {
    state: "running" as "running" | "suspended",
    destination: {},
    audioWorklet: { addModule: async () => undefined },
    resume: async () => undefined,
    close: async () => undefined,
    createMediaStreamSource: () => ({
      connect: () => undefined,
      disconnect: () => undefined,
    }),
    createGain: () => ({
      gain: { value: 1 },
      connect: () => undefined,
      disconnect: () => undefined,
    }),
  };
  return { node, context };
}

function controller() {
  const detector = fakeDetector();
  const endpointer = fakeEndpointer();
  const audio = fakeAudio();
  const recorder = fakeRecorder();
  const timers: Array<{ handler: () => void; at: number }> = [];
  const states: string[] = [];
  const clips: number[] = [];
  let clock = 0;
  let ptt = false;
  const stream = { getTracks: () => [{ stop: () => undefined }] };
  const instance = new HandsFreeController({
    getUserMedia: async () => stream as unknown as MediaStream,
    createAudioContext: () => audio.context as unknown as AudioContext,
    createRecorder: () => recorder as unknown as MediaRecorder,
    createWorkletNode: () => audio.node as unknown as AudioWorkletNode,
    wakeDetector: detector as unknown as WakeDetector,
    speechEndpointer: endpointer as unknown as SpeechEndpointer,
    now: () => clock,
    setTimeout: (handler, timeout) => {
      timers.push({ handler, at: clock + timeout });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => undefined,
    isForeground: () => true,
    isSnapshotReady: () => true,
    currentEpoch: () => 4,
    isPttActive: () => ptt,
    onClip: (_audio, _mime, epoch) => clips.push(epoch),
    onState: (detail) => states.push(detail.state),
  });
  return {
    instance,
    detector,
    endpointer,
    recorder,
    audio,
    states,
    clips,
    pressPtt: (down: boolean) => {
      ptt = down;
    },
    advance: (ms: number) => {
      clock += ms;
      const due = timers.filter((timer) => timer.at <= clock);
      for (const timer of due) {
        timers.splice(timers.indexOf(timer), 1);
        timer.handler();
      }
    },
  };
}

describe("the hands-free controller over fakes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubBrowser() {
    vi.stubGlobal("isSecureContext", true);
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => undefined },
    });
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("the test supplies the context");
        }
      },
    );
    vi.stubGlobal("AudioWorkletNode", class {});
    vi.stubGlobal("MediaRecorder", {
      isTypeSupported: (mime: string) => mime === "audio/webm;codecs=opus",
    });
  }

  it("walks start, wake, capture and stop without recursing", async () => {
    stubBrowser();
    const harness = controller();
    expect(await harness.instance.enable()).toBe(true);
    expect(harness.instance.currentState).toBe("armed");
    expect(harness.detector.resets).toBeGreaterThan(0);
    expect(harness.endpointer.resets).toBeGreaterThan(0);

    harness.detector.hear();
    expect(harness.instance.currentState).toBe("wake_grace");
    harness.endpointer.speechStarts();
    expect(harness.instance.currentState).toBe("capturing");
    expect(harness.recorder.startCalls).toBe(1);
    harness.recorder.ondataavailable?.({ data: new Blob(["words"]) });
    harness.endpointer.speechEnds();
    expect(harness.clips).toEqual([4]);
    expect(harness.instance.currentState).toBe("awaiting_response");

    const resets = {
      detector: harness.detector.resets,
      endpointer: harness.endpointer.resets,
    };
    harness.instance.disable();
    expect(harness.instance.currentState).toBe("off");
    expect(harness.detector.resets).toBeGreaterThan(resets.detector);
    expect(harness.endpointer.resets).toBeGreaterThan(resets.endpointer);
  });

  it("resets both detectors when a wake grace lapses", async () => {
    stubBrowser();
    const harness = controller();
    expect(await harness.instance.enable()).toBe(true);
    harness.detector.hear();
    const resets = {
      detector: harness.detector.resets,
      endpointer: harness.endpointer.resets,
    };
    harness.advance(2_100);
    expect(harness.instance.currentState).toBe("armed");
    expect(harness.detector.resets).toBeGreaterThan(resets.detector);
    expect(harness.endpointer.resets).toBeGreaterThan(resets.endpointer);
  });

  // A start that a newer one overtook (push-to-talk paused and resumed while
  // the first one waited) closed whatever graph the controller held when it
  // woke up: the newer start's. Hands-free then said "armed" and heard
  // nothing (#261).
  it("lets an overtaken start release only what it made", async () => {
    stubBrowser();
    const detector = fakeDetector();
    const endpointer = fakeEndpointer();
    const audio = fakeAudio();
    const closed: number[] = [];
    const stopped: number[] = [];
    let contexts = 0;
    let streams = 0;
    let releaseFirstModule: () => void = () => undefined;
    const instance = new HandsFreeController({
      getUserMedia: async () => {
        const id = ++streams;
        return {
          getTracks: () => [{ stop: () => stopped.push(id) }],
        } as unknown as MediaStream;
      },
      createAudioContext: () => {
        const id = ++contexts;
        return {
          ...audio.context,
          audioWorklet: {
            addModule: () =>
              id === 1
                ? new Promise<undefined>((resolve) => {
                    releaseFirstModule = () => resolve(undefined);
                  })
                : Promise.resolve(undefined),
          },
          close: async () => {
            closed.push(id);
          },
        } as unknown as AudioContext;
      },
      createRecorder: () => fakeRecorder() as unknown as MediaRecorder,
      createWorkletNode: () => audio.node as unknown as AudioWorkletNode,
      wakeDetector: detector as unknown as WakeDetector,
      speechEndpointer: endpointer as unknown as SpeechEndpointer,
      isForeground: () => true,
      isSnapshotReady: () => true,
      currentEpoch: () => 4,
      isPttActive: () => false,
      onClip: () => true,
      onState: () => undefined,
    });

    const first = instance.enable();
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    instance.pauseForPtt();
    instance.resumeAfterPtt();
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    expect(instance.currentState).toBe("armed");

    releaseFirstModule();
    expect(await first).toBe(false);
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    expect(closed, "the overtaken start closes its own context").toEqual([1]);
    expect(stopped, "and stops its own microphone").toEqual([1]);
    expect(instance.currentState).toBe("armed");
  });

  // WebKit can leave `resume()` pending while the audio session is taken
  // away (#183). Waited on without a limit, the start never finished.
  it("fails a start whose audio never resumes, and says so", async () => {
    stubBrowser();
    const harness = controller();
    harness.audio.context.state = "suspended";
    harness.audio.context.resume = () => new Promise<undefined>(() => undefined);
    const start = harness.instance.enable();
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    expect(harness.instance.currentState).toBe("starting");
    harness.advance(3_000);
    expect(await start).toBe(false);
    expect(harness.instance.currentState).toBe("error");
    expect(harness.instance.isEnabled).toBe(false);
  });

  it("pauses for push-to-talk and resumes", async () => {
    stubBrowser();
    const harness = controller();
    expect(await harness.instance.enable()).toBe(true);
    harness.instance.pauseForPtt();
    expect(harness.instance.currentState).toBe("paused_ptt");
    expect(harness.detector.resets).toBeGreaterThan(1);
    expect(harness.endpointer.resets).toBeGreaterThan(1);
    harness.instance.resumeAfterPtt();
    // `resumeAfterPtt` starts the enable path without awaiting it; the fakes
    // settle in microtasks, so the test drains them instead of waiting on a
    // clock.
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
    expect(harness.instance.currentState).toBe("armed");
  });

  it("stops on a detector failure and says which one failed", async () => {
    stubBrowser();
    const harness = controller();
    expect(await harness.instance.enable()).toBe(true);
    const resets = {
      detector: harness.detector.resets,
      endpointer: harness.endpointer.resets,
    };
    harness.detector.breakDown(new Error("engine gone"));
    expect(harness.instance.currentState).toBe("error");
    expect(harness.instance.isEnabled).toBe(false);
    expect(harness.detector.resets).toBeGreaterThan(resets.detector);
    expect(harness.endpointer.resets).toBeGreaterThan(resets.endpointer);
  });

  it("reports a failed start once, after resetting both detectors", async () => {
    stubBrowser();
    const harness = controller();
    harness.audio.context.audioWorklet.addModule = async () => {
      throw new Error("worklet missing");
    };
    expect(await harness.instance.enable()).toBe(false);
    expect(harness.instance.currentState).toBe("error");
    expect(harness.detector.resets).toBeGreaterThan(0);
    expect(harness.endpointer.resets).toBeGreaterThan(0);
  });
});

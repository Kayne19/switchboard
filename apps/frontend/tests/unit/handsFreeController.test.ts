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

/** The microtasks a start settles in (the fakes never wait on a clock). */
async function drain(ticks = 50): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
}

/** MODE as the page taps it, with the start it began settled. */
async function tapMode(harness: { instance: HandsFreeController }): Promise<void> {
  harness.instance.toggle();
  await drain();
}

/** MODE tapped on, and hands-free listening for the wake word. */
async function armHandsFree(harness: { instance: HandsFreeController }): Promise<void> {
  await tapMode(harness);
  expect(harness.instance.currentState).toBe("armed");
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
  let acceptClips = true;
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
    onClip: (_audio, _mime, epoch) => {
      clips.push(epoch);
      return acceptClips ? `clip-${clips.length}` : null;
    },
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
    refuseClips: () => {
      acceptClips = false;
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
    await armHandsFree(harness);
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
    harness.instance.toggle();
    expect(harness.instance.currentState).toBe("off");
    expect(harness.detector.resets).toBeGreaterThan(resets.detector);
    expect(harness.endpointer.resets).toBeGreaterThan(resets.endpointer);
  });

  // Only a successful reply opens the follow-up lease, so `awaiting_response`
  // needs a way out for a turn that brings none, or the wake word is never
  // heard again (#258).
  it("listens for the wake word again when the awaited turn brings no reply", async () => {
    stubBrowser();
    const harness = controller();
    await armHandsFree(harness);
    harness.detector.hear();
    harness.endpointer.speechStarts();
    harness.recorder.ondataavailable?.({ data: new Blob(["cough"]) });
    harness.endpointer.speechEnds();
    expect(harness.instance.currentState).toBe("awaiting_response");

    harness.instance.endAwaitedTurn();
    expect(harness.instance.currentState).toBe("armed");
    harness.detector.hear();
    expect(harness.instance.currentState).toBe("wake_grace");
  });

  it("does not wait for a reply to an utterance the page could not send", async () => {
    stubBrowser();
    const harness = controller();
    await armHandsFree(harness);
    harness.refuseClips();
    harness.detector.hear();
    harness.endpointer.speechStarts();
    harness.recorder.ondataavailable?.({ data: new Blob(["words"]) });
    harness.endpointer.speechEnds();
    expect(harness.clips).toEqual([4]);
    expect(harness.instance.currentState).toBe("armed");
  });

  it("does not wait for a reply to a follow-up that kept nothing", async () => {
    stubBrowser();
    const harness = controller();
    await armHandsFree(harness);
    harness.instance.replyClosed(4, true);
    harness.advance(400);
    expect(harness.instance.currentState).toBe("lease");
    harness.endpointer.speechStarts();
    expect(harness.instance.currentState).toBe("lease_capturing");
    harness.endpointer.speechEnds();
    expect(harness.clips).toEqual([]);
    expect(harness.instance.currentState).toBe("armed");
  });

  it("resets both detectors when a wake grace lapses", async () => {
    stubBrowser();
    const harness = controller();
    await armHandsFree(harness);
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
      onClip: () => "clip",
      onState: () => undefined,
    });

    instance.toggle();
    await drain(20);
    instance.pauseForPtt();
    instance.resumeAfterPtt();
    await drain(20);
    expect(instance.currentState).toBe("armed");

    releaseFirstModule();
    await drain(20);
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
    harness.instance.toggle();
    await drain(20);
    expect(harness.instance.currentState).toBe("starting");
    harness.advance(3_000);
    await drain();
    expect(harness.instance.currentState).toBe("error");
    expect(harness.instance.isEnabled).toBe(false);
  });

  it("pauses for push-to-talk and resumes", async () => {
    stubBrowser();
    const harness = controller();
    await armHandsFree(harness);
    harness.instance.pauseForPtt();
    expect(harness.instance.currentState).toBe("paused_ptt");
    expect(harness.detector.resets).toBeGreaterThan(1);
    expect(harness.endpointer.resets).toBeGreaterThan(1);
    harness.instance.resumeAfterPtt();
    await drain();
    expect(harness.instance.currentState).toBe("armed");
  });

  // Each of these ends hands-free, or pauses it, while the caller is still
  // speaking. The capture they retire must not outlive them: a capture left
  // behind makes every later wake word open nothing (#256).
  const retirements = {
    "MODE off and on": async (harness: ReturnType<typeof controller>) => {
      harness.instance.toggle();
      await tapMode(harness);
    },
    pauseForPtt: async (harness: ReturnType<typeof controller>) => {
      harness.instance.pauseForPtt();
      harness.instance.resumeAfterPtt();
    },
    "a rescue epoch": async (harness: ReturnType<typeof controller>) => {
      harness.instance.epochChanged(false);
      await tapMode(harness);
    },
    // A hand-off keeps listening: the next wake word needs no MODE.
    "a hand-off epoch": async (harness: ReturnType<typeof controller>) => {
      harness.instance.epochChanged(true);
    },
    "a detector failure": async (harness: ReturnType<typeof controller>) => {
      harness.detector.breakDown(new Error("engine gone"));
      await tapMode(harness);
    },
  };
  for (const [how, retire] of Object.entries(retirements)) {
    it(`captures again after ${how} during a capture`, async () => {
      stubBrowser();
      const harness = controller();
      await armHandsFree(harness);
      harness.detector.hear();
      harness.endpointer.speechStarts();
      expect(harness.instance.currentState).toBe("capturing");

      await retire(harness);
      await drain();
      expect(harness.instance.currentState).toBe("armed");
      expect(harness.instance.isCapturing).toBe(false);
      expect(harness.clips).toEqual([]);

      harness.detector.hear();
      harness.endpointer.speechStarts();
      expect(harness.instance.currentState).toBe("capturing");
      expect(harness.recorder.startCalls).toBe(2);
    });
  }

  it("stops on a detector failure and says which one failed", async () => {
    stubBrowser();
    const harness = controller();
    await armHandsFree(harness);
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
    await tapMode(harness);
    expect(harness.instance.currentState).toBe("error");
    expect(harness.detector.resets).toBeGreaterThan(0);
    expect(harness.endpointer.resets).toBeGreaterThan(0);
  });

  // A refusal is published as an error, which the page shows as hands-free
  // off. The controller must agree, or the next MODE tap turns it "off" and
  // nothing visible happens (#257).
  it("is off after a resume it refuses", async () => {
    stubBrowser();
    const harness = controller();
    await armHandsFree(harness);
    harness.instance.pauseForPtt();
    harness.pressPtt(true);
    harness.instance.resumeAfterPtt();
    await drain();
    expect(harness.instance.currentState).toBe("error");
    expect(harness.instance.isEnabled).toBe(false);

    harness.pressPtt(false);
    await armHandsFree(harness);
  });
});

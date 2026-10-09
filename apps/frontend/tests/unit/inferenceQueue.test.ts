import { afterEach, describe, expect, it, vi } from "vitest";

// ONNX Runtime Web's `run` is not re-entrant across sessions: a run that
// starts while another session's run is still awaiting corrupts the first
// one's inputs, and ONNX Runtime fails both. The fakes below fail the same
// way, so a page that lets the wake engine and the Silero endpointer run at
// once fails here instead of on the first frames after "armed", where it
// released the microphone and turned hands-free off (#213).

const ort = vi.hoisted(() => {
  const state = { inFlight: 0, runs: 0, overlaps: 0 };
  async function exclusive<T>(value: T): Promise<T> {
    if (state.inFlight > 0) {
      state.overlaps += 1;
      throw new Error(
        "failed to call OrtRun(). ERROR_CODE: 2, ERROR_MESSAGE: NULL input supplied for input c",
      );
    }
    state.inFlight += 1;
    try {
      // A real run awaits the wasm module; give the other queue its chance.
      await new Promise((resolve) => setTimeout(resolve, 1));
      state.runs += 1;
      return value;
    } finally {
      state.inFlight -= 1;
    }
  }
  return { state, exclusive };
});

vi.mock("onnxruntime-web", () => {
  class Tensor {
    constructor(
      readonly type: string,
      readonly data: unknown,
      readonly dims: number[],
    ) {}
  }
  const session = {
    run: () =>
      ort.exclusive({
        output: { data: new Float32Array([0.1]) },
        hn: new Tensor("float32", new Float32Array(128), [2, 1, 64]),
        cn: new Tensor("float32", new Float32Array(128), [2, 1, 64]),
      }),
  };
  return {
    Tensor,
    env: { wasm: {} },
    InferenceSession: { create: () => ort.exclusive(session) },
  };
});

vi.mock("openwakeword-wasm-browser", () => ({
  // The package engine runs several sessions per chunk on the same runtime.
  WakeWordEngine: class {
    async load() {
      for (let model = 0; model < 5; model += 1) await ort.exclusive(model);
    }
    on() {
      return () => undefined;
    }
    _resetState() {}
    async _processChunk() {
      for (let model = 0; model < 4; model += 1) await ort.exclusive(model);
    }
  },
}));

const { createWakeWordDetector } = await import("../../src/wake_word");
const { createSpeechEndpointer } = await import("../../src/silero_vad");
const { WAKE_FRAME_SAMPLES } = await import("../../src/hands_free");

afterEach(() => {
  ort.state.inFlight = 0;
  ort.state.runs = 0;
  ort.state.overlaps = 0;
});

describe("the wake engine and the Silero endpointer share ONNX Runtime", () => {
  it("never run inference at the same time, so hands-free survives its first frames", async () => {
    const wake = createWakeWordDetector();
    const speech = createSpeechEndpointer();
    const errors: unknown[] = [];
    wake.onError((error) => errors.push(error));
    speech.onError((error) => errors.push(error));

    // Loaded together, as the call runtime loads them.
    await Promise.all([wake.load(), speech.load()]);

    // Every worklet frame goes to both, as HandsFreeController feeds them.
    for (let frame = 0; frame < 4; frame += 1) {
      const samples = new Float32Array(WAKE_FRAME_SAMPLES);
      speech.process(samples);
      wake.process(samples);
    }
    await vi.waitFor(
      () => {
        // 4 frames: 4 x 4 wake runs, and 1280 x 4 / 512 = 10 Silero windows.
        expect(ort.state.runs).toBe(5 + 1 + 16 + 10);
      },
      { timeout: 2_000 },
    );

    expect(ort.state.overlaps).toBe(0);
    expect(errors).toEqual([]);
  });
});

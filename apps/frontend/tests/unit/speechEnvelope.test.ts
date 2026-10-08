import { describe, expect, it, vi } from "vitest";
import {
  decodeEnvelope,
  EnvelopeMeter,
  envelopeOfBuffer,
  SpeechEnvelope,
} from "../../src/runtime/speechEnvelope";

// WebKit cannot be given an analyser on the playback element (#189), so the
// level comes from the utterance's own bytes, decoded aside and read at the
// element's `currentTime`.

/** Decoded audio: `levels` are the amplitudes of successive 10ms blocks. */
function fakeBuffer(blocks: number[], sampleRate = 1000) {
  const perBlock = sampleRate / 100;
  const samples = new Float32Array(blocks.length * perBlock);
  blocks.forEach((amplitude, index) => {
    samples.fill(amplitude, index * perBlock, (index + 1) * perBlock);
  });
  return {
    sampleRate,
    length: samples.length,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

describe("SpeechEnvelope", () => {
  it("reads loudness per step and nothing outside the utterance", () => {
    // 10ms blocks, read in 20ms steps: each step covers two blocks.
    const envelope = envelopeOfBuffer(fakeBuffer([0, 0, 0.5, 0.5]), 20);
    expect(envelope.steps).toBe(2);
    expect(envelope.levelAt(0)).toBe(0);
    expect(envelope.levelAt(0.025)).toBeCloseTo(1, 5);
    expect(envelope.levelAt(1), "past the end is silence").toBe(0);
    expect(envelope.levelAt(-1)).toBe(0);
    expect(envelope.levelAt(Number.NaN)).toBe(0);
  });

  it("gives no envelope when the bytes cannot be decoded", async () => {
    const decoder = {
      decodeAudioData: () => Promise.reject(new Error("not audio")),
    };
    expect(await decodeEnvelope(new ArrayBuffer(4), decoder)).toBeNull();
  });

  it("gives no envelope for an empty decode", async () => {
    const decoder = {
      decodeAudioData: () => Promise.resolve(fakeBuffer([])),
    };
    expect(await decodeEnvelope(new ArrayBuffer(4), decoder)).toBeNull();
  });
});

describe("EnvelopeMeter", () => {
  it("reports the level the element has reached and stops at zero", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const levels: number[] = [];
      const element = { currentTime: 0 };
      const meter = new EnvelopeMeter(
        element,
        new SpeechEnvelope([0, 0.5, 1], 100),
        (level) => levels.push(level),
      );
      meter.start();
      element.currentTime = 0.15;
      frames.pop()?.(0);
      element.currentTime = 0.25;
      frames.pop()?.(0);
      meter.stop();
      expect(levels).toEqual([0, 0.5, 1, 0]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

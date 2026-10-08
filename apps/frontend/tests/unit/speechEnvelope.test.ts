import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  decodeEnvelope,
  EnvelopeMeter,
  envelopeOfBuffer,
  mp3FrameBoundary,
  SpeechEnvelope,
  StreamingEnvelope,
} from "../../src/runtime/speechEnvelope";

// The level of the agent's voice comes from the utterance's own bytes in
// every engine (#194): decoded aside, read at the element's `currentTime`.
// The element is never routed through Web Audio.

/** One MPEG-1 Layer III frame at 128 kbps, 44.1 kHz: 417 bytes, no padding. */
const FRAME_BYTES = 417;

function mp3Stream(frames: number): Uint8Array {
  const bytes = new Uint8Array(frames * FRAME_BYTES);
  for (let frame = 0; frame < frames; frame += 1) {
    const at = frame * FRAME_BYTES;
    bytes[at] = 0xff;
    bytes[at + 1] = 0xfb;
    bytes[at + 2] = 0x90;
    bytes[at + 3] = 0x00;
  }
  return bytes;
}

/**
 * A decoder of the stream above: each frame decodes to 1152 samples of a
 * level of its own, so an envelope says which frames it was decoded from.
 */
function frameDecoder() {
  const calls: number[] = [];
  return {
    calls,
    decodeAudioData(data: ArrayBuffer) {
      calls.push(data.byteLength);
      const frames = Math.floor(data.byteLength / FRAME_BYTES);
      const samples = new Float32Array(frames * 1152);
      for (let frame = 0; frame < frames; frame += 1) {
        samples.fill(((frame % 5) + 1) / 16, frame * 1152, (frame + 1) * 1152);
      }
      return Promise.resolve({
        sampleRate: 44100,
        length: samples.length,
        getChannelData: () => samples,
      } as unknown as AudioBuffer);
    },
  };
}

/** Lets every decode a chunk started settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

function levels(envelope: { steps: number; levelAt(at: number): number }) {
  const read: number[] = [];
  for (let step = 0; step < envelope.steps; step += 1) {
    read.push(envelope.levelAt((step * 40 + 1) / 1000));
  }
  return read;
}

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

describe("mp3FrameBoundary", () => {
  it("cuts a stream where a frame ends, never inside one", () => {
    const whole = mp3Stream(3);
    expect(mp3FrameBoundary(whole)).toBe(3 * FRAME_BYTES);
    // A chunk that stops mid-frame is decodable up to the frame before it.
    expect(mp3FrameBoundary(whole.subarray(0, 2 * FRAME_BYTES + 10))).toBe(
      2 * FRAME_BYTES,
    );
    expect(mp3FrameBoundary(whole.subarray(0, 10)), "no whole frame yet").toBe(
      0,
    );
    expect(mp3FrameBoundary(new Uint8Array([1, 2, 3, 4])), "not MP3").toBe(0);
  });

  it("reads the voice fixture, tag and all", () => {
    const bytes = new Uint8Array(
      readFileSync(
        path.join(import.meta.dirname, "../fixtures/speech-pulse.mp3"),
      ),
    );
    const boundary = mp3FrameBoundary(bytes);
    expect(boundary, "whole frames were found").toBeGreaterThan(
      bytes.length / 2,
    );
    expect(boundary).toBeLessThanOrEqual(bytes.length);
    const half = bytes.subarray(0, Math.floor(bytes.length / 2));
    const partial = mp3FrameBoundary(half);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThanOrEqual(half.length);
  });
});

describe("StreamingEnvelope", () => {
  it("decodes the chunks into the envelope of the whole clip", async () => {
    const whole = mp3Stream(6);
    const decoder = frameDecoder();
    const wholeEnvelope = await decodeEnvelope(
      whole.slice().buffer as ArrayBuffer,
      decoder,
    );
    const streaming = new StreamingEnvelope(frameDecoder());
    // Chunks off a socket land on no frame boundary at all.
    for (let at = 0; at < whole.length; at += 500) {
      streaming.append(whole.slice(at, at + 500).buffer as ArrayBuffer);
      await settle();
    }
    expect(streaming.steps).toBe(wholeEnvelope!.steps);
    expect(levels(streaming)).toEqual(levels(wholeEnvelope!));
  });

  it("grows as the clip arrives and reports nothing past it", async () => {
    const whole = mp3Stream(6);
    const streaming = new StreamingEnvelope(frameDecoder());
    expect(streaming.levelAt(0), "nothing decoded is a flat level").toBe(0);

    streaming.append(whole.slice(0, FRAME_BYTES + 5).buffer as ArrayBuffer);
    await settle();
    const firstSteps = streaming.steps;
    expect(firstSteps, "one frame is one 26ms step").toBeGreaterThan(0);
    expect(streaming.levelAt(0)).toBeCloseTo(0.5, 5);
    expect(streaming.levelAt(0.1), "not yet arrived is silence").toBe(0);

    streaming.append(whole.slice(FRAME_BYTES + 5).buffer as ArrayBuffer);
    await settle();
    expect(streaming.steps).toBeGreaterThan(firstSteps);
    expect(streaming.levelAt(0.1)).toBeGreaterThan(0);
    const wholeEnvelope = await decodeEnvelope(
      whole.slice().buffer as ArrayBuffer,
      frameDecoder(),
    );
    expect(
      streaming.levelAt(0),
      "the timeline keeps the whole clip's own zero",
    ).toBeCloseTo(wholeEnvelope!.levelAt(0), 5);
    expect(streaming.levelAt(60), "past the clip is silence").toBe(0);
  });

  it("offers a failing prefix once, instead of retrying the same bytes", async () => {
    const whole = mp3Stream(4);
    const calls: number[] = [];
    // Rejects every prefix, then gives in. The giving in is only so that a
    // build which retries the same bytes ends this test instead of spinning
    // in it: there, the count runs away before the twelfth call stops it.
    const decoder = {
      decodeAudioData(data: ArrayBuffer) {
        calls.push(data.byteLength);
        if (calls.length < 12) return Promise.reject(new Error("not audio"));
        return frameDecoder().decodeAudioData(data);
      },
    };
    const streaming = new StreamingEnvelope(decoder);
    // A partial trailing frame: bytes past the last whole frame. That is
    // what sent the decode loop back to the same boundary again.
    streaming.append(whole.slice(0, 2 * FRAME_BYTES + 7).buffer as ArrayBuffer);
    await settle();
    expect(calls.length, "one decode per boundary, taken or refused").toBe(1);
    expect(streaming.levelAt(0), "refused bytes are a flat level").toBe(0);
    expect(streaming.steps).toBe(0);

    // A longer prefix is new bytes, so it is still offered.
    streaming.append(whole.slice(2 * FRAME_BYTES + 7).buffer as ArrayBuffer);
    await settle();
    expect(calls.length).toBe(2);
  });

  it("decodes an arriving clip once per chunk at most", async () => {
    const whole = mp3Stream(4);
    const decoder = frameDecoder();
    const streaming = new StreamingEnvelope(decoder);
    for (let at = 0; at < whole.length; at += 40) {
      streaming.append(whole.slice(at, at + 40).buffer as ArrayBuffer);
    }
    await settle();
    // A chunk with no new whole frame in it decodes nothing, and chunks that
    // arrive during a decode are taken by one decode, not one each.
    expect(decoder.calls.length).toBeLessThanOrEqual(4);
    expect(decoder.calls.at(-1)).toBe(whole.length);
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

  it("stays flat while the element does not move, and follows a seek", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const levelsSeen: number[] = [];
      const element = { currentTime: 0.15 };
      const meter = new EnvelopeMeter(
        element,
        new SpeechEnvelope([0, 0.5, 1], 100),
        (level) => levelsSeen.push(level),
      );
      meter.start();
      // A stalled element: the level is whatever the clip says at that time,
      // and it does not drift on its own.
      frames.pop()?.(0);
      frames.pop()?.(0);
      expect(levelsSeen).toEqual([0.5, 0.5, 0.5]);
      // A seek back reads the clip at the new time, not the old one.
      element.currentTime = 0.05;
      frames.pop()?.(0);
      expect(levelsSeen.at(-1)).toBe(0);
      meter.stop();
      expect(levelsSeen.at(-1)).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

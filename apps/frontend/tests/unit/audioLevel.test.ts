import { describe, expect, it } from "vitest";
import { normalizeAudioEnergy, smoothAudioLevel } from "../../src/runtime/audioLevel";
import { mapVoiceLevelToBar } from "../../src/primitives/VoiceIndicator";

describe("voice level mapping", () => {
  it("expands and clamps quiet RMS energy", () => {
    expect(normalizeAudioEnergy(0)).toBe(0);
    expect(normalizeAudioEnergy(0.05)).toBeCloseTo(0.4);
    expect(normalizeAudioEnergy(1)).toBe(1);
  });

  it("attacks faster than it releases", () => {
    expect(smoothAudioLevel(0, 1)).toBeCloseTo(0.42);
    expect(smoothAudioLevel(1, 0)).toBeCloseTo(0.82);
  });

  it("makes every bar respond monotonically to the live level", () => {
    for (let index = 0; index < 16; index += 1) {
      expect(mapVoiceLevelToBar(0.8, index)).toBeGreaterThan(
        mapVoiceLevelToBar(0.1, index),
      );
    }
  });
});

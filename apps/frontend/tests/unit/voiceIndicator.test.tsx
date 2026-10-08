// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mapVoiceLevelToBar,
  VoiceIndicator,
} from "../../src/primitives/VoiceIndicator";
import { mount, unmount } from "./sceneHarness";

describe("VoiceIndicator live level", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps polling when level starts unavailable and recovers when it appears", () => {
    let level: number | null = null;
    let nextFrame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextFrame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const host = mount(<VoiceIndicator getLevel={() => level} />);
    expect(nextFrame).not.toBeNull();
    level = 0.8;
    act(() => {
      nextFrame?.(0);
    });
    const firstBar = host.querySelector(".voice-indicator__bars i") as HTMLElement;
    expect(firstBar.style.transform).toMatch(/^scaleY\(/);
    // Before the frame stubs go.
    unmount(host);
  });

  // On WebKit the playback analyser is unavailable, so the level stays null
  // while the agent speaks. The bars ran the canned loop for the whole call
  // and told the caller nothing about who was speaking (#189).
  it("stays flat while a call reports no level", () => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const host = mount(<VoiceIndicator getLevel={() => null} />);
    const bars = host.querySelectorAll<HTMLElement>(".voice-indicator__bars i");
    expect(bars.length).toBeGreaterThan(0);
    bars.forEach((bar, index) => {
      expect(bar.style.transform).toBe(
        `scaleY(${mapVoiceLevelToBar(0, index)})`,
      );
    });
    unmount(host);
  });
});

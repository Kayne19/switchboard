// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VoiceIndicator } from "../../src/primitives/VoiceIndicator";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

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
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => {
      root.render(<VoiceIndicator getLevel={() => level} />);
    });
    expect(nextFrame).not.toBeNull();
    level = 0.8;
    act(() => {
      nextFrame?.(0);
    });
    const firstBar = host.querySelector(".voice-indicator__bars i") as HTMLElement;
    expect(firstBar.style.transform).toMatch(/^scaleY\(/);
    act(() => root.unmount());
  });
});

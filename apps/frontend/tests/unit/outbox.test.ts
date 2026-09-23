import { describe, expect, it } from "vitest";
import {
  ClipOutbox,
  MAX_OUTBOX_CLIPS,
  restampStaleClips,
  type Clip,
} from "../../src/runtime/outbox";

function clip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    audio: new Blob([id]),
    mime: "audio/webm",
    created: 0,
    epoch: 0,
    sent: false,
    ...overrides,
  };
}

describe("restampStaleClips", () => {
  it("moves only transfer-era clips onto the new leg", () => {
    const transferClip = clip("a", { epoch: 3, transferEra: "alpha" });
    const preClip = clip("b", { epoch: 3 });
    const currentClip = clip("c", { epoch: 4 });
    const resubmitted = restampStaleClips([transferClip, preClip, currentClip], 4);
    expect(resubmitted, "only the transfer-era clip is re-stamped").toBe(1);
    expect(transferClip.epoch, "transfer-era clip follows the new leg").toBe(4);
    expect(preClip.epoch, "pre-transfer speech keeps the server's discard").toBe(3);
    expect(currentClip.epoch).toBe(4);
  });
});

describe("ClipOutbox", () => {
  it("refuses clips beyond its cap", () => {
    const outbox = new ClipOutbox();
    for (let index = 0; index < MAX_OUTBOX_CLIPS; index += 1) {
      expect(outbox.add(clip(`clip-${index}`))).toBe(true);
    }
    expect(outbox.add(clip("one-too-many"))).toBe(false);
    expect(outbox.size).toBe(MAX_OUTBOX_CLIPS);
  });

  it("resends everything after a reconnect, oldest first", () => {
    const outbox = new ClipOutbox();
    outbox.add(clip("first", { sent: true }));
    outbox.add(clip("second", { sent: true }));
    expect(outbox.firstUnsent()).toBeUndefined();
    outbox.markAllUnsent();
    expect(outbox.firstUnsent()?.id).toBe("first");
    outbox.remove("first");
    expect(outbox.firstUnsent()?.id).toBe("second");
  });
});

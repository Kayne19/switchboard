import { describe, expect, it } from "vitest";
import { ClipOutbox, MAX_OUTBOX_CLIPS, type Clip } from "../../src/runtime/outbox";

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

function holding(...clips: Clip[]): ClipOutbox {
  const outbox = new ClipOutbox();
  for (const held of clips) outbox.add(held);
  return outbox;
}

describe("ClipOutbox.carry", () => {
  it("moves only transfer-era clips onto the new leg", () => {
    const transferClip = clip("a", { epoch: 3, transferEra: "alpha" });
    const preClip = clip("b", { epoch: 3 });
    const currentClip = clip("c", { epoch: 4 });
    const resubmitted = holding(transferClip, preClip, currentClip).carry({
      route: "alpha",
      generation: 4,
    });
    expect(resubmitted, "only the transfer-era clip is re-stamped").toBe(1);
    expect(transferClip.epoch, "transfer-era clip follows the new leg").toBe(4);
    expect(preClip.epoch, "pre-transfer speech keeps the server's discard").toBe(3);
    expect(currentClip.epoch).toBe(4);
  });

  it("leaves a clip that already went out on the stamp it went out with", () => {
    // The server keeps the first stamp it sees for a clip id, so a clip that
    // was handed to a socket cannot be moved: a retransmission under a new
    // stamp would be taken as the clip it already has and never answered.
    const onTheWire = clip("a", { epoch: 3, transferEra: "alpha", sent: true, transmitted: true });
    const afterReconnect = clip("b", { epoch: 3, transferEra: "alpha", sent: false, transmitted: true });
    expect(
      holding(onTheWire, afterReconnect).carry({ route: "alpha", generation: 4 }),
    ).toBe(0);
    expect(onTheWire.epoch).toBe(3);
    expect(afterReconnect.epoch).toBe(3);
  });

  // Issue #70: speech addressed to a connecting leg goes only to that leg,
  // adopted at the epoch right after the one the clip was recorded under.
  it("moves a clip only onto the adoption of the candidate it was recorded for", () => {
    const forAlpha = () => clip("a", { epoch: 3, transferEra: "alpha" });
    const otherRoute = forAlpha();
    expect(holding(otherRoute).carry({ route: "beta", generation: 4 })).toBe(0);
    expect(otherRoute.epoch).toBe(3);
    // Adopted later than the candidate it was recorded for: a rescue came
    // between, and this is a leg the words were never addressed to.
    const laterLeg = forAlpha();
    expect(holding(laterLeg).carry({ route: "alpha", generation: 5 })).toBe(0);
    expect(laterLeg.epoch).toBe(3);
  });

  it("forgets the transfer a clip was recorded for once it ends unadopted", () => {
    const forAlpha = clip("a", { epoch: 3, transferEra: "alpha" });
    const forBeta = clip("b", { epoch: 3, transferEra: "beta" });
    const outbox = holding(forAlpha, forBeta);
    outbox.unmark("alpha");
    expect(forAlpha.transferEra).toBeUndefined();
    expect(forBeta.transferEra).toBe("beta");
    expect(outbox.carry({ route: "alpha", generation: 4 })).toBe(0);
  });
});

describe("ClipOutbox", () => {
  it("drops the clips of other epochs that never went out, and counts them", () => {
    const current = clip("current", { epoch: 4 });
    const neverSent = clip("never-sent", { epoch: 3 });
    const onTheWire = clip("on-the-wire", { epoch: 3, transmitted: true });
    const outbox = holding(current, neverSent, onTheWire);
    expect(outbox.retireOtherEpochs(4)).toBe(1);
    expect(outbox.find("never-sent")).toBeUndefined();
    expect(outbox.size).toBe(2);
  });

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

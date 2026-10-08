import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpokenLines, type HeardLine } from "../../src/runtime/spokenLines";

// The caption follows the audio, not the text (#112): a spoken line is heard
// when playback reaches the utterance that voices it.

function clock() {
  const heard: HeardLine[] = [];
  const lines = new SpokenLines((line) => heard.push(line));
  const texts = () => heard.map((line) => line.text);
  return { lines, heard, texts };
}

describe("SpokenLines", () => {
  it("holds a line until its utterance starts to play", () => {
    const { lines, texts } = clock();
    lines.reach(1);
    lines.add({ text: "First." }, 1);
    // Its audio was already playing when the text came: heard at once.
    expect(texts()).toEqual(["First."]);

    // Two more lines arrive while the first is still playing.
    lines.add({ text: "Second." }, 2);
    lines.add({ text: "Third." }, 3);
    expect(texts()).toEqual(["First."]);

    lines.reach(2);
    expect(texts()).toEqual(["First.", "Second."]);
    lines.reach(3);
    expect(texts()).toEqual(["First.", "Second.", "Third."]);
  });

  it("holds a reply that comes before its audio", () => {
    const { lines, texts } = clock();
    lines.add({ text: "Putting you through." }, 4);
    expect(texts()).toEqual([]);
    lines.reach(4);
    expect(texts()).toEqual(["Putting you through."]);
  });

  it("hears a line without audio as soon as the lines before it", () => {
    const { lines, texts } = clock();
    lines.add({ text: "No audio." });
    expect(texts()).toEqual(["No audio."]);

    lines.add({ text: "Spoken." }, 5);
    lines.add({ text: "After it." });
    expect(texts()).toEqual(["No audio."]);
    lines.reach(5);
    expect(texts()).toEqual(["No audio.", "Spoken.", "After it."]);
  });

  it("puts lines whose texts crossed back in their audio's order", () => {
    const { lines, texts } = clock();
    lines.reach(1);
    // The short second line's text overtook the first's.
    lines.add({ text: "Done." }, 2);
    lines.add({ text: "A long first line." }, 1);
    expect(texts()).toEqual(["A long first line."]);
    lines.reach(2);
    expect(texts()).toEqual(["A long first line.", "Done."]);
  });

  it("orders a line heard after a later one before it", () => {
    const { lines, heard } = clock();
    lines.reach(2);
    lines.add({ text: "Done." }, 2);
    lines.add({ text: "A long first line." }, 1);
    expect(heard.map((line) => [line.text, line.order])).toEqual([
      ["Done.", 2],
      ["A long first line.", 1],
    ]);
  });

  it("treats a dropped utterance as reached", () => {
    const { lines, texts } = clock();
    lines.add({ text: "One." }, 1);
    lines.add({ text: "Two." }, 2);
    // Utterance 1 never plays; playback reports 2 when its turn comes.
    lines.reach(2);
    expect(texts()).toEqual(["One.", "Two."]);
  });

  it("hears every waiting line when playback is retired", () => {
    const { lines, texts } = clock();
    lines.add({ text: "Cut off." }, 7);
    lines.add({ text: "Never played." }, 8);
    lines.retire();
    expect(texts()).toEqual(["Cut off.", "Never played."]);
    // The next leg's lines wait for their own audio again.
    lines.add({ text: "New leg." }, 9);
    expect(texts()).toEqual(["Cut off.", "Never played."]);
    lines.reach(9);
    expect(texts()).toEqual(["Cut off.", "Never played.", "New leg."]);
  });

  it("forgets waiting lines when the transcript is replaced", () => {
    const { lines, texts } = clock();
    lines.add({ text: "Stale." }, 3);
    lines.clear();
    lines.reach(3);
    expect(texts()).toEqual([]);
  });
  // Since #112 a caption waits for playback to reach its utterance. On WebKit
  // playback can refuse, fail, or go silent, and the caption log then froze
  // on an old line while the transcript drawer had every later one (#189).
  describe("when playback never reaches the utterance", () => {
    function waitingClock() {
      const heard: HeardLine[] = [];
      const lines = new SpokenLines((line) => heard.push(line), { waitMs: 500 });
      return { lines, texts: () => heard.map((line) => line.text) };
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("hears a line whose audio never arrives", () => {
      const { lines, texts } = waitingClock();
      lines.add({ text: "Nothing voiced this." }, 1);
      vi.advanceTimersByTime(499);
      expect(texts(), "the wait is given to the audio first").toEqual([]);
      vi.advanceTimersByTime(1);
      expect(texts()).toEqual(["Nothing voiced this."]);
    });

    // Every WebKit failure in #189 reaches the clock the same way: playback
    // stops sounding with lines still waiting. A refused `play()`, a
    // SourceBuffer error that fails the stream, and an element that starts
    // and plays nothing all end in `playbackActive(false)`.
    it("hears the lines behind a clip that stopped sounding, in order", () => {
      const { lines, texts } = waitingClock();
      // Playback started, and `play()` was refused.
      lines.playbackActive(true);
      lines.add({ text: "First." }, 1);
      lines.add({ text: "Second." }, 2);
      vi.advanceTimersByTime(5000);
      expect(texts(), "a clip that is sounding is waited for").toEqual([]);

      lines.playbackActive(false);
      vi.advanceTimersByTime(500);
      expect(texts()).toEqual(["First.", "Second."]);
    });

    it("waits again once playback is sounding", () => {
      const { lines, texts } = waitingClock();
      lines.add({ text: "First." }, 1);
      lines.playbackActive(true);
      vi.advanceTimersByTime(5000);
      expect(texts()).toEqual([]);
      lines.reach(1);
      expect(texts()).toEqual(["First."]);

      // The next line waits for its own audio while the first still plays.
      lines.add({ text: "Second." }, 2);
      vi.advanceTimersByTime(5000);
      expect(texts()).toEqual(["First."]);
    });

    it("forgets the wait when the transcript is replaced", () => {
      const { lines, texts } = waitingClock();
      lines.add({ text: "Stale." }, 3);
      lines.clear();
      vi.advanceTimersByTime(5000);
      expect(texts()).toEqual([]);
    });
  });
});

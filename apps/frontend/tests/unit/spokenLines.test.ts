import { describe, expect, it } from "vitest";
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
});

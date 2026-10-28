import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// Streaming playback, driven in a real browser (#203).
//
// `mseStartNext` used to create a `MediaSource` and wait for `sourceopen`
// without ever attaching it to the element, and a `MediaSource` is `closed`
// until an element takes its URL: nothing opened, nothing played, nothing was
// reported, and the utterance never left `mseActive`, so every later one
// queued behind it. That was silence for the rest of the call on any page
// that offers `mse_mp3` -- Chrome and an iPad -- and it is the silence in
// #189.
//
// What this holds, in whichever engine runs it and with no test of which one
// that is: the caller hears the clip, and if streaming could not carry it,
// the failure named itself and the whole replay did. It runs in both
// projects of `playwright.config.ts`, and CI's `browser` legs run both:
// Chromium, where the stream itself plays, and WebKit, where it may be
// accepted and never sound. To run one engine locally:
//
//   npm run test:browser -- --project=webkit --grep "streaming playback"

/** The same 1.6s voice clip the orb level is read from. */
const clip = readFileSync(
  path.join(import.meta.dirname, "../fixtures/speech-pulse.mp3"),
).toString("base64");

test.describe("streaming playback in this engine", () => {
  test("a streamed utterance is heard, or names why it is replayed whole", async ({
    page,
  }) => {
    await page.goto("/");
    const result = await page.evaluate(async (base64: string) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const specifier = "/src/runtime/audioPlayback.ts";
      const module = (await import(/* @vite-ignore */ specifier)) as {
        AudioPlayback: new (options: Record<string, unknown>) => {
          readonly streamingEnabled: boolean;
          setStreamingEnabled(enabled: boolean): void;
          receiveAudioStart(message: Record<string, unknown>): void;
          receiveAudioChunk(data: ArrayBuffer): void;
          receiveAudioDone(message: Record<string, unknown>): void;
          isDrained(): boolean;
          dispose(): void;
        };
      };
      const player = document.createElement("audio");
      document.body.appendChild(player);
      const statuses: Array<[string, boolean]> = [];
      const playback = new module.AudioPlayback({
        player,
        idleText: "idle",
        onStatus: (text: string, error?: boolean) =>
          statuses.push([text, error === true]),
        onChange: () => {},
        gapMs: 0,
      });
      playback.setStreamingEnabled(true);
      const offered = playback.streamingEnabled;
      playback.receiveAudioStart({
        generation: 0,
        sequence: 1,
        mime: "audio/mpeg",
      });
      // The element must have taken the source before anything can open.
      const attached = player.src !== "";
      // Chunks land on no frame boundary, as they do off the socket.
      for (let at = 0; at < bytes.length; at += 1_500) {
        playback.receiveAudioChunk(
          bytes.slice(at, at + 1_500).buffer as ArrayBuffer,
        );
      }
      playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });

      // Long enough for the stream to play, or for the 3s silence watch to
      // give up and the whole replay to be heard instead.
      let heard = 0;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        heard = Math.max(heard, player.currentTime);
        if (heard > 1.2) break;
      }
      const streamed = playback.streamingEnabled;
      playback.dispose();
      player.remove();
      return { offered, attached, heard, statuses, streamed };
    }, clip);

    expect(result.offered, "this engine offers MP3 through MediaSource").toBe(
      true,
    );
    expect(
      result.attached,
      "the element is given the source, which is what opens it",
    ).toBe(true);
    expect(result.heard, "the caller hears the clip").toBeGreaterThan(1.2);
    if (result.streamed) {
      expect(result.statuses, "a stream that plays says nothing").toEqual([]);
    } else {
      // The engine took the stream and never sounded. That is allowed, and
      // saying so is not optional: silence with no cause is the bug.
      expect(result.statuses.map(([text]) => text)).toEqual([
        "Streaming audio failed; using the complete replay (no playback progress).",
      ]);
      expect(result.statuses[0][1], "reported as an error").toBe(true);
    }
  });
});

// Kayne's decision on #437 (2026-10-11): at a handoff (a transfer this tab
// saw adopted), what the old leg is already saying finishes, and the new
// leg's audio plays after it. Before, a clip still arriving at the handoff
// was cut off. It runs in both engines, as the test above does.
test.describe("a handoff in this engine", () => {
  test("a clip still arriving at a handoff is heard, then the new leg's", async ({
    page,
  }) => {
    await page.goto("/");
    const result = await page.evaluate(async (base64: string) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const specifier = "/src/runtime/audioPlayback.ts";
      const module = (await import(/* @vite-ignore */ specifier)) as {
        AudioPlayback: new (options: Record<string, unknown>) => {
          setStreamingEnabled(enabled: boolean): void;
          handOffToGeneration(generation: number): void;
          receiveAudioStart(message: Record<string, unknown>): void;
          receiveAudioChunk(data: ArrayBuffer): void;
          receiveAudioDone(message: Record<string, unknown>): void;
          dispose(): void;
        };
      };
      const player = document.createElement("audio");
      document.body.appendChild(player);
      // Which utterance holds the element: its turn to play came. A stream
      // this engine takes and never sounds is replayed whole on another
      // source, so time heard is kept by utterance, not by source.
      let playing = 0;
      const playback = new module.AudioPlayback({
        player,
        idleText: "idle",
        onStatus: () => {},
        onChange: () => {},
        onUtterance: (sequence: number) => {
          playing = sequence;
        },
        gapMs: 0,
      });
      playback.setStreamingEnabled(true);
      const send = (generation: number, sequence: number, from: number, to: number) => {
        if (from === 0)
          playback.receiveAudioStart({ generation, sequence, mime: "audio/mpeg" });
        for (let at = from; at < to; at += 1_500)
          playback.receiveAudioChunk(
            bytes.slice(at, Math.min(at + 1_500, to)).buffer as ArrayBuffer,
          );
        if (to === bytes.length)
          playback.receiveAudioDone({ generation, sequence, done: true });
      };
      // The old leg's clip is half here when the call hands off.
      const half = Math.floor(bytes.length / 2);
      send(0, 1, 0, half);
      playback.handOffToGeneration(1);
      send(0, 1, half, bytes.length);
      send(1, 2, 0, bytes.length);

      // Each clip is 1.6s: the old leg's is heard to its end, then the new
      // leg's after it.
      const heard = new Map<number, number>();
      const order: number[] = [];
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (!playing) continue;
        if (!order.includes(playing)) order.push(playing);
        heard.set(playing, Math.max(heard.get(playing) ?? 0, player.currentTime));
        if ((heard.get(2) ?? 0) > 1.2) break;
      }
      playback.dispose();
      player.remove();
      return { order, first: heard.get(1) ?? 0, second: heard.get(2) ?? 0 };
    }, clip);

    expect(result.order, "the old leg's clip, then the new leg's").toEqual([1, 2]);
    expect(result.first, "the old leg's clip is heard to its end").toBeGreaterThan(1.2);
    expect(result.second, "the new leg's clip is heard after it").toBeGreaterThan(1.2);
  });
});

test.describe("an utterance with no audio in this engine", () => {
  const orders = {
    "then one with audio": [
      [1, "none"],
      [2, "audio"],
    ],
    "ending once its source has opened, then one with audio": [
      [1, "none, ending late"],
      [2, "audio"],
    ],
    "behind one with audio, then another": [
      [1, "audio"],
      [2, "none"],
      [3, "audio"],
    ],
  } as const;
  for (const streaming of [true, false])
    for (const [name, steps] of Object.entries(orders))
      test(`${name} (${streaming ? "streaming" : "whole replay"}): the next is heard, and no error shows`, async ({
        page,
      }) => {
        test.setTimeout(60_000);
        await page.goto("/");
        const target = steps[steps.length - 1][0];
        const result = await page.evaluate(
          async ({ base64, streaming, steps, target }) => {
            const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
            const specifier = "/src/runtime/audioPlayback.ts";
            const module = (await import(/* @vite-ignore */ specifier)) as {
              NO_PROGRESS_MS: number;
              AudioPlayback: new (options: Record<string, unknown>) => {
                readonly streamingEnabled: boolean;
                setStreamingEnabled(enabled: boolean): void;
                receiveAudioStart(message: Record<string, unknown>): void;
                receiveAudioChunk(data: ArrayBuffer): void;
                receiveAudioDone(message: Record<string, unknown>): void;
                isDrained(): boolean;
                dispose(): void;
              };
            };
            const player = document.createElement("audio");
            document.body.appendChild(player);
            const statuses: Array<[string, boolean]> = [];
            let playing = 0;
            const playback = new module.AudioPlayback({
              player,
              idleText: "idle",
              onStatus: (text: string, error?: boolean) =>
                statuses.push([text, error === true]),
              onChange: () => {},
              onUtterance: (sequence: number) => {
                playing = sequence;
              },
              gapMs: 0,
            });
            playback.setStreamingEnabled(streaming);
            const offered = playback.streamingEnabled;
            for (const [sequence, audio] of steps) {
              playback.receiveAudioStart({ generation: 0, sequence, mime: "audio/mpeg" });
              if (audio === "audio")
                for (let at = 0; at < bytes.length; at += 1_500)
                  playback.receiveAudioChunk(
                    bytes.slice(at, at + 1_500).buffer as ArrayBuffer,
                  );
              if (audio === "none, ending late")
                await new Promise((resolve) => setTimeout(resolve, 300));
              playback.receiveAudioDone({ generation: 0, sequence, done: true });
            }
            let heard = 0;
            const deadline = Date.now() + 15_000;
            while (Date.now() < deadline && heard <= 1.2) {
              await new Promise((resolve) => setTimeout(resolve, 50));
              if (playing === target) heard = Math.max(heard, player.currentTime);
            }
            const tail = Date.now() + 2 * module.NO_PROGRESS_MS;
            while (Date.now() < tail && !playback.isDrained())
              await new Promise((resolve) => setTimeout(resolve, 50));
            const drained = playback.isDrained();
            const streamed = playback.streamingEnabled;
            playback.dispose();
            player.remove();
            return { offered, heard, drained, streamed, statuses };
          },
          { base64: clip, streaming, steps, target },
        );

        expect(result.heard, "the utterance after it is heard").toBeGreaterThan(1.2);
        expect(result.drained, "and then nothing is left playing").toBe(true);
        const errors = result.statuses
          .filter(([, error]) => error)
          .map(([text]) => text);
        const refused = result.offered && !result.streamed;
        if (refused)
          expect(errors, "only this engine's refusal of a stream with audio").toEqual([
            "Streaming audio failed; using the complete replay (no playback progress).",
          ]);
        else expect(errors, "nothing is reported").toEqual([]);
      });
});

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

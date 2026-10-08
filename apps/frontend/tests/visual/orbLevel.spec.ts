import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// The orb's playback level has one reader in every engine (#194): the
// utterance's own bytes, decoded in an `OfflineAudioContext` and read at the
// element's `currentTime`. This drives the real `AudioPlayback` off the dev
// server with a clip that is loud, then silent, then loud again, and reads
// the level the orb would draw.
//
// CI runs this in Chromium (the `browser` job). WebKit is the engine the
// deleted analyser path could never serve, so run it there too before a
// change to playback, with an untracked config of your own:
//
//   // playwright.webkit.local.config.ts  (ignored by .gitignore)
//   import { defineConfig, devices } from '@playwright/test';
//   import base from './apps/frontend/playwright.config';
//   const port = Number(process.env.PLAYWRIGHT_PORT || 4183);
//   export default defineConfig({
//     ...base,
//     testDir: './apps/frontend/tests/visual',
//     use: { ...base.use, ...devices['Desktop Safari'], launchOptions: {} },
//     webServer: {
//       command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
//       url: `http://127.0.0.1:${port}`,
//       reuseExistingServer: false,
//       timeout: 120_000,
//     },
//   });
//
//   npx playwright test --config playwright.webkit.local.config.ts \
//     --grep "the orb level"
//
// Both engines pass it; the WebKit run is local because this host's CI image
// has no WebKit libraries.

/**
 * 1.6s of 300Hz tone, loud for 400ms and silent for 400ms, twice:
 *   ffmpeg -f lavfi -i "sine=frequency=300:duration=1.6:sample_rate=16000" \
 *     -af "volume='if(lt(mod(t,0.8),0.4),0.8,0.0)':eval=frame" \
 *     -codec:a libmp3lame -b:a 32k -ac 1 speech-pulse.mp3
 */
const clip = readFileSync(
  path.join(import.meta.dirname, "../fixtures/speech-pulse.mp3"),
).toString("base64");

/** What the orb was told while the clip played: `[currentTime, level]`. */
type Reading = [number, number];

const loudest = (readings: Reading[], from: number, to: number) =>
  Math.max(
    0,
    ...readings.filter(([at]) => at >= from && at <= to).map(([, level]) => level),
  );

const quietest = (readings: Reading[], from: number, to: number) => {
  const window = readings
    .filter(([at]) => at >= from && at <= to)
    .map(([, level]) => level);
  return window.length ? Math.min(...window) : 1;
};

function expectFollowsTheVoice(readings: Reading[], what: string) {
  expect(readings.length, `${what}: the level was reported`).toBeGreaterThan(5);
  expect(
    loudest(readings, 0.05, 0.35),
    `${what}: the orb reacts to the first loud half`,
  ).toBeGreaterThan(0.3);
  expect(
    quietest(readings, 0.45, 0.75),
    `${what}: the orb settles through the silent half`,
  ).toBeLessThan(0.15);
  expect(
    loudest(readings, 0.85, 1.15),
    `${what}: and reacts again to the second loud half`,
  ).toBeGreaterThan(0.3);
}

test.describe("the orb level reads the agent's voice in this engine", () => {
  test("a replay meters the clip it plays, and no graph touches the element", async ({
    page,
  }) => {
    await page.goto("/");
    const result = await page.evaluate(async (base64: string) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const specifier = "/src/runtime/audioPlayback.ts";
      const module = (await import(/* @vite-ignore */ specifier)) as {
        AudioPlayback: new (options: Record<string, unknown>) => {
          audioQueue: Blob[];
          isPlaying: boolean;
          playNext(): void;
          setStreamingEnabled(enabled: boolean): void;
          receiveAudioStart(message: Record<string, unknown>): void;
          receiveAudioChunk(data: ArrayBuffer): void;
          receiveAudioDone(message: Record<string, unknown>): void;
          dispose(): void;
        };
      };
      // Nothing may route the element through Web Audio, in any engine: that
      // is what silenced WebKit playback (#189).
      let contexts = 0;
      const liveContext = window.AudioContext;
      class CountedContext extends liveContext {
        constructor(...args: ConstructorParameters<typeof liveContext>) {
          super(...args);
          contexts += 1;
        }
      }
      window.AudioContext = CountedContext as typeof liveContext;

      const readings: Record<string, Array<[number, number]>> = {};
      const play = async (
        leg: string,
        feed: (playback: InstanceType<typeof module.AudioPlayback>) => void,
      ) => {
        const player = document.createElement("audio");
        document.body.appendChild(player);
        const taken: Array<[number, number]> = [];
        const playback = new module.AudioPlayback({
          player,
          idleText: "idle",
          onStatus: () => {},
          onChange: () => {},
          // The stall watchdog is off: this is a level test, not a timing one.
          stallMs: 0,
          gapMs: 0,
          onAudioLevel: (level: number) => taken.push([player.currentTime, level]),
        });
        feed(playback);
        const deadline = Date.now() + 12_000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (player.currentTime > 1.3 && taken.length > 5) break;
        }
        playback.dispose();
        player.remove();
        readings[leg] = taken;
      };

      await play("replay", (playback) => {
        playback.audioQueue.push(new Blob([bytes], { type: "audio/mpeg" }));
        playback.playNext();
      });

      // The streaming path is not driven here: a `MediaSource` never opens
      // in a real browser on this code, so there is nothing to meter (#203).
      // Its envelope is read chunk by chunk in the test below, in this same
      // engine, and its wiring in tests/unit/audioPlayback.test.ts.

      window.AudioContext = liveContext;
      return { readings, contexts };
    }, clip);

    expectFollowsTheVoice(result.readings.replay as Reading[], "replay");
    expect(result.contexts, "playback builds no live audio context").toBe(0);
  });

  test("the envelope of an arriving clip is the envelope of the whole clip", async ({
    page,
  }) => {
    await page.goto("/");
    const result = await page.evaluate(async (base64: string) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const specifier = "/src/runtime/speechEnvelope.ts";
      const module = (await import(/* @vite-ignore */ specifier)) as {
        createEnvelopeDecoder: () => { decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> } | null;
        decodeEnvelope: (
          data: ArrayBuffer,
          decoder: { decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> },
        ) => Promise<{ steps: number; levelAt(at: number): number } | null>;
        StreamingEnvelope: new (decoder: {
          decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
        }) => { append(chunk: ArrayBuffer): void; steps: number; levelAt(at: number): number };
      };
      const decoder = module.createEnvelopeDecoder();
      if (!decoder) return null;
      const whole = await module.decodeEnvelope(
        bytes.slice().buffer as ArrayBuffer,
        decoder,
      );
      const streaming = new module.StreamingEnvelope(decoder);
      for (let at = 0; at < bytes.length; at += 1_500) {
        streaming.append(bytes.slice(at, at + 1_500).buffer as ArrayBuffer);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      const read = (envelope: { steps: number; levelAt(at: number): number }) => {
        const levels: number[] = [];
        for (let step = 0; step < envelope.steps; step += 1) {
          levels.push(envelope.levelAt((step * 40 + 1) / 1000));
        }
        return levels;
      };
      return { whole: read(whole!), streamed: read(streaming) };
    }, clip);

    expect(result, "this engine decodes audio off to the side").not.toBeNull();
    expect(result!.streamed.length).toBe(result!.whole.length);
    expect(result!.streamed).toEqual(result!.whole);
  });
});

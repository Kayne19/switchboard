import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioPlayback } from "../../src/runtime/audioPlayback";
import { mp3FrameBoundary } from "../../src/runtime/speechEnvelope";

// Ported from the legacy runtime's playback regressions: one clip owns the
// element at a time, and a late event from a replaced clip can never advance,
// resume, or requeue the clip that replaced it.

type Handler = () => void;

/**
 * `onAttach` is called with each source the element is given, the way a
 * browser acts on it: it is what opens a `MediaSource` (`FakeMediaSource`).
 */
function fakePlayer(onAttach?: (url: string) => void) {
  const listeners = new Map<string, Set<Handler>>();
  let currentSource = "";
  const player = {
    listeners,
    playCalls: [] as string[],
    playPromises: [] as Array<{
      resolve: () => void;
      reject: (error: unknown) => void;
    }>,
    paused: false,
    ended: false,
    duration: 10,
    currentTime: 1,
    error: null as unknown,
    pauseCalls: 0,
    loadCalls: 0,
    activeSources: new Set<string>(),
    addEventListener(name: string, handler: Handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(handler);
    },
    removeEventListener(name: string, handler: Handler) {
      listeners.get(name)?.delete(handler);
    },
    emit(name: string) {
      for (const handler of [...(listeners.get(name) || [])]) handler();
    },
    get src() {
      return currentSource;
    },
    set src(value: string) {
      currentSource = value;
      if (value) {
        player.ended = false;
        onAttach?.(value);
      }
    },
    play() {
      player.playCalls.push(player.src);
      player.activeSources.add(player.src);
      return new Promise<void>((resolve, reject) => {
        player.playPromises.push({ resolve, reject });
      });
    },
    pause() {
      player.pauseCalls += 1;
      player.paused = true;
      if (player.src) player.activeSources.delete(player.src);
    },
    removeAttribute(name: string) {
      if (name === "src") player.src = "";
    },
    load() {
      player.loadCalls += 1;
    },
  };
  return player;
}

function stubObjectUrls() {
  const urls = new Map<string, unknown>();
  const revoked: string[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
    const url = `blob:${urls.size}`;
    urls.set(url, value);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    revoked.push(url);
  });
  return { urls, revoked };
}

function snapshotListeners(player: ReturnType<typeof fakePlayer>) {
  return new Map(
    [...player.listeners].map(([name, handlers]) => [name, [...handlers]]),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AudioPlayback replay ownership", () => {
  it("plays one clip at a time and ignores events from replaced clips", async () => {
    const player = fakePlayer();
    const { urls, revoked } = stubObjectUrls();
    const playback = new AudioPlayback({
      player: player as unknown as HTMLAudioElement,
      idleText: "idle",
      onStatus: () => {},
      onChange: () => {},
      gapMs: 0,
    });
    const clickHandler = (event?: { target: unknown }) =>
      playback.handleGesture((event?.target ?? null) as EventTarget | null);

    const first = new Blob(["first"]);
    const second = new Blob(["second"]);
    const third = new Blob(["third"]);
    playback.audioQueue.push(first, second, third);
    playback.playNext();
    const staleFirstHandlers = snapshotListeners(player);
    expect(urls.get(player.src)).toBe(first);
    expect(player.playCalls.length).toBe(1);
    expect(player.activeSources.size).toBe(1);
    player.playPromises[0].resolve();
    await Promise.resolve();

    // A pause retains A and queued B. Repeated clicks while play() is
    // unresolved must not issue duplicate resume attempts.
    player.paused = true;
    player.emit("pause");
    expect(playback.audioQueue.length).toBe(2);
    clickHandler();
    clickHandler();
    expect(player.playCalls.length).toBe(2);
    player.paused = false;
    player.playPromises[1].resolve();
    await Promise.resolve();

    // Both event orders and duplicate events consume exactly once.
    player.paused = true;
    player.emit("pause");
    player.ended = true;
    player.emit("ended");
    player.emit("ended");
    await Promise.resolve();
    expect(urls.get(player.src)).toBe(second);
    expect(playback.audioQueue.length).toBe(1);
    expect(player.pauseCalls).toBe(1);
    expect(player.loadCalls).toBe(1);
    expect(player.activeSources.size).toBe(1);
    expect(revoked).toEqual(["blob:0"]);

    player.playPromises[2].resolve();
    await Promise.resolve();
    const staleSecondHandlers = snapshotListeners(player);
    player.ended = true;
    const playsBeforeNaturalEnd = player.playCalls.length;
    player.emit("ended");
    player.emit("ended");
    player.emit("pause");
    expect(urls.get(player.src)).toBe(third);
    expect(player.playCalls.length).toBe(playsBeforeNaturalEnd + 1);
    expect(player.activeSources.size).toBe(1);
    expect(playback.audioQueue.length).toBe(0);
    player.playPromises[3].resolve();
    await Promise.resolve();

    // Retained A/B callbacks cannot mutate the newer owner.
    for (const handler of staleFirstHandlers.get("pause")!) handler();
    for (const handler of staleFirstHandlers.get("ended")!) handler();
    for (const handler of staleSecondHandlers.get("pause")!) handler();
    expect(urls.get(player.src)).toBe(third);
    expect(playback.audioQueue.length).toBe(0);

    // A reverse seek resets the guard, and NaN duration must never become
    // terminal by accident.
    player.ended = false;
    player.paused = true;
    player.currentTime = player.duration;
    player.emit("seeking");
    player.emit("pause");
    clickHandler();
    expect(player.playCalls.length).toBe(4);
    player.currentTime = 2;
    player.emit("seeking");
    clickHandler();
    expect(player.playCalls.length).toBe(5);
    player.playPromises[4].resolve();
    await Promise.resolve();

    // Error duplicates consume once.
    player.error = new Error("decode");
    player.emit("error");
    player.emit("error");
    expect(playback.audioQueue.length).toBe(0);

    // Rejecting A after ownership has moved to B cannot requeue A. A fresh
    // rejection while still owner does requeue exactly once.
    player.error = null;
    const fourth = new Blob(["fourth"]);
    const fifth = new Blob(["fifth"]);
    playback.audioQueue.push(fourth, fifth);
    playback.playNext();
    const staleReject = player.playPromises[5].reject;
    playback.playNext();
    expect(urls.get(player.src)).toBe(fifth);
    staleReject(new Error("autoplay"));
    await Promise.resolve();
    expect(playback.audioQueue.length).toBe(0);
    player.playPromises[6].resolve();
    await Promise.resolve();
    player.ended = true;
    player.emit("ended");
    const sixth = new Blob(["sixth"]);
    playback.audioQueue.push(sixth);
    playback.playNext();
    player.playPromises[7].reject(new Error("blocked"));
    await Promise.resolve();
    expect(playback.audioQueue.length).toBe(1);
    clickHandler();
    clickHandler();
    expect(player.playCalls.length).toBe(9);
    player.playPromises[8].resolve();
    await Promise.resolve();
    player.ended = true;
    player.emit("ended");
    expect(revoked).toEqual([
      "blob:0",
      "blob:1",
      "blob:2",
      "blob:3",
      "blob:4",
      "blob:5",
      "blob:6",
    ]);

    // A terminal seek consumes once in either event order and never starts
    // the current clip again. The source tracker also proves replacement
    // pauses A before B becomes audible.
    const seekFirst = new Blob(["seek-first"]);
    const seekSecond = new Blob(["seek-second"]);
    const seekThird = new Blob(["seek-third"]);
    playback.audioQueue.push(seekFirst, seekSecond, seekThird);
    playback.playNext();
    const seekFirstUrl = player.src;
    expect(player.activeSources.size).toBe(1);
    player.playPromises[9].resolve();
    await Promise.resolve();
    player.paused = true;
    player.currentTime = player.duration;
    player.ended = false;
    player.emit("seeking");
    player.emit("pause");
    const playsBeforeTerminalEnd = player.playCalls.length;
    clickHandler();
    expect(player.playCalls.length, "terminal pause is not resumed").toBe(
      playsBeforeTerminalEnd,
    );
    player.ended = true;
    player.emit("ended");
    player.emit("ended");
    expect(urls.get(player.src)).toBe(seekSecond);
    expect(player.playCalls.length).toBe(playsBeforeTerminalEnd + 1);
    expect(player.activeSources.has(seekFirstUrl)).toBe(false);
    expect(player.activeSources.size).toBe(1);

    player.playPromises[10].resolve();
    await Promise.resolve();
    const staleSeekPause = [...(player.listeners.get("pause") || [])];
    player.currentTime = player.duration;
    player.ended = true;
    player.emit("ended");
    for (const handler of staleSeekPause) handler();
    expect(urls.get(player.src)).toBe(seekThird);
    expect(player.playCalls.length).toBe(playsBeforeTerminalEnd + 2);
    expect(player.activeSources.size).toBe(1);
    player.playPromises[11].resolve();
    await Promise.resolve();
    player.ended = true;
    player.emit("ended");
    player.emit("ended");
    expect(player.activeSources.size).toBe(0);
    expect(revoked).toEqual([
      "blob:0",
      "blob:1",
      "blob:2",
      "blob:3",
      "blob:4",
      "blob:5",
      "blob:6",
      "blob:7",
      "blob:8",
      "blob:9",
    ]);

    // Terminal seek events must consume even while play() is pending, in
    // either event order. A pause at duration without a seek remains resumable.
    const raceFirst = new Blob(["race-first"]);
    const raceSecond = new Blob(["race-second"]);
    const raceThird = new Blob(["race-third"]);
    playback.audioQueue.push(raceFirst, raceSecond, raceThird);
    playback.playNext();
    player.paused = true;
    player.currentTime = player.duration;
    player.ended = false;
    player.emit("seeking");
    player.emit("pause");
    const raceFirstUrl = player.src;
    player.ended = true;
    player.emit("ended");
    expect(urls.get(player.src)).toBe(raceSecond);
    expect(player.activeSources.has(raceFirstUrl)).toBe(false);

    const raceSecondHandlers = snapshotListeners(player);
    player.ended = true;
    for (const handler of raceSecondHandlers.get("ended")!) handler();
    for (const handler of raceSecondHandlers.get("pause")!) handler();
    expect(urls.get(player.src)).toBe(raceThird);

    player.playPromises[12].resolve();
    player.playPromises[13].resolve();
    await Promise.resolve();
    player.playPromises[14].resolve();
    await Promise.resolve();
    player.paused = true;
    player.ended = false;
    player.currentTime = player.duration;
    player.emit("pause");
    const playsBeforeNativeClick = player.playCalls.length;
    clickHandler({ target: player });
    expect(
      player.playCalls.length,
      "the element's own controls do not resume audio",
    ).toBe(playsBeforeNativeClick);
    clickHandler({ target: null });
    expect(player.playCalls.length).toBe(playsBeforeNativeClick + 1);
    player.playPromises[15].resolve();
    await Promise.resolve();
    player.ended = true;
    player.emit("ended");
    expect(revoked).toEqual([
      "blob:0",
      "blob:1",
      "blob:2",
      "blob:3",
      "blob:4",
      "blob:5",
      "blob:6",
      "blob:7",
      "blob:8",
      "blob:9",
      "blob:10",
      "blob:11",
      "blob:12",
    ]);
  });

  it("reports blocked autoplay as an error the next gesture can recover", async () => {
    const player = fakePlayer();
    stubObjectUrls();
    const statuses: Array<[string, boolean | undefined]> = [];
    const playback = new AudioPlayback({
      player: player as unknown as HTMLAudioElement,
      idleText: "idle",
      onStatus: (text, error) => statuses.push([text, error]),
      onChange: () => {},
      gapMs: 0,
    });
    playback.audioQueue.push(new Blob(["reply"]));
    playback.playNext();
    player.playPromises[0].reject(
      Object.assign(new Error("blocked"), { name: "NotAllowedError" }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses.at(-1)).toEqual([
      "Audio blocked by the browser — tap or click anywhere on this page once, then it will play (NotAllowedError).",
      true,
    ]);
    expect(playback.audioQueue.length).toBe(1);
    expect(playback.isDrained()).toBe(false);
  });
});

describe("AudioPlayback and Web Audio", () => {
  // One reader of the level, in every engine (#194): the element plays
  // natively everywhere and the level is decoded off to the side. A graph on
  // the element was a second implementation of the same level, and it is the
  // graph that silences a WebKit element holding a MediaSource (#189).
  it("never routes the element through a live context, whatever the engine", async () => {
    const player = fakePlayer();
    stubObjectUrls();
    let contexts = 0;
    class ForbiddenContext {
      state = "running";
      destination = {} as AudioNode;
      constructor() {
        contexts += 1;
      }
      createMediaElementSource(): MediaElementAudioSourceNode {
        throw new Error("the element must stay on native playback");
      }
      createAnalyser(): AnalyserNode {
        throw new Error("the level is not read from the element");
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", ForbiddenContext);
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    });
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const playback = new AudioPlayback({
      player: player as unknown as HTMLAudioElement,
      idleText: "idle",
      onStatus: () => {},
      onChange: () => {},
      onAudioLevel: () => {},
      gapMs: 0,
    });
    playback.audioQueue.push(new Blob(["speech"]));
    playback.playNext();
    player.playPromises[0].resolve();
    for (let step = 0; step < 8; step += 1) await Promise.resolve();
    playback.handleGesture(null);
    playback.dispose();
    expect(contexts, "no live context is built for playback").toBe(0);
    expect(player.playCalls).toHaveLength(1);
  });
});

describe("AudioPlayback streaming", () => {
  class FakeSourceBuffer {
    listeners = new Map<string, Set<Handler>>();
    updating = false;
    mode = "segments";
    appended: Uint8Array[] = [];
    fail = false;
    addEventListener(name: string, handler: Handler) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name)!.add(handler);
    }
    removeEventListener(name: string, handler: Handler) {
      this.listeners.get(name)?.delete(handler);
    }
    emit(name: string) {
      if (name === "updateend") this.updating = false;
      for (const handler of [...(this.listeners.get(name) || [])]) handler();
    }
    appendBuffer(data: ArrayBuffer) {
      if (this.fail) {
        const error = new Error("quota");
        error.name = "QuotaExceededError";
        throw error;
      }
      this.updating = true;
      this.appended.push(new Uint8Array(data));
    }
  }

  class FakeMediaSource {
    static isTypeSupported = () => true;
    // A MediaSource is closed until a media element attaches its URL, and
    // `sourceopen` fires then and not before. A fake that opens on its own
    // let the streaming path pass a test no browser can run (#203).
    readyState = "closed";
    buffer = new FakeSourceBuffer();
    ended = false;
    listeners = new Map<string, Set<Handler>>();
    addEventListener(name: string, handler: Handler) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name)!.add(handler);
    }
    /** What the browser does when the element is given this source's URL. */
    attach() {
      if (this.readyState !== "closed") return;
      this.readyState = "open";
      for (const handler of [...(this.listeners.get("sourceopen") || [])])
        handler();
    }
    addSourceBuffer() {
      if (this.readyState !== "open") {
        const error = new Error("source is not open");
        error.name = "InvalidStateError";
        throw error;
      }
      return this.buffer;
    }
    endOfStream() {
      this.ended = true;
      this.readyState = "ended";
    }
  }

  function streamingPlayback(
    onUtterance?: (sequence: number) => void,
    statuses?: Array<[string, boolean | undefined]>,
    stallMs?: number,
    gapMs = 0,
  ) {
    const { urls } = stubObjectUrls();
    const player = fakePlayer((url) => {
      const source = urls.get(url);
      if (source instanceof FakeMediaSource) source.attach();
    });
    player.play = () => {
      player.playCalls.push(player.src);
      return Promise.resolve();
    };
    vi.stubGlobal("MediaSource", FakeMediaSource);
    const playback = new AudioPlayback({
      player: player as unknown as HTMLAudioElement,
      idleText: "idle",
      onStatus: (text, error) => statuses?.push([text, error]),
      onChange: () => {},
      onUtterance,
      gapMs,
      stallMs,
    });
    playback.setStreamingEnabled(true);
    return { player, urls, playback };
  }

  const bytes = (text: string) => new TextEncoder().encode(text).buffer;

  it("attaches the source to the element, which is what opens it", () => {
    // #203: the source was created and waited on, never attached, so it
    // never opened. Nothing played and nothing was reported.
    const { player, urls, playback } = streamingPlayback();
    playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
    const source = urls.get(player.src) as FakeMediaSource;
    expect(source, "the element took the source's URL").toBeInstanceOf(
      FakeMediaSource,
    );
    expect(source.readyState, "attaching opened it").toBe("open");
    playback.receiveAudioChunk(bytes("one"));
    expect(source.buffer.appended.length, "and the chunk went in").toBe(1);
    expect(player.playCalls.length, "and it started playing").toBe(1);
  });

  it("plays each utterance through its own MediaSource as it arrives", () => {
    const { player, urls, playback } = streamingPlayback();
    expect(playback.streamingEnabled).toBe(true);

    playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
    playback.receiveAudioChunk(bytes("one"));
    playback.receiveAudioChunk(bytes("two"));
    const first = urls.get(player.src) as FakeMediaSource;
    expect(player.playCalls.length, "first chunk starts playback").toBe(1);
    expect(first.buffer.appended).toEqual([new Uint8Array([111, 110, 101])]);
    first.buffer.emit("updateend");
    expect(first.buffer.appended).toEqual([
      new Uint8Array([111, 110, 101]),
      new Uint8Array([116, 119, 111]),
    ]);
    first.buffer.emit("updateend");
    playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
    expect(first.ended, "done waits for every queued append").toBe(true);

    playback.receiveAudioStart({ generation: 0, sequence: 2, mime: "audio/mpeg" });
    playback.receiveAudioChunk(bytes("next"));
    playback.receiveAudioDone({ generation: 0, sequence: 2, done: true });
    player.emit("ended");
    const second = urls.get(player.src) as FakeMediaSource;
    expect(second, "each utterance owns a MediaSource").not.toBe(first);
    second.buffer.emit("updateend");
    expect(second.ended).toBe(true);
  });

  it("gives the SourceBuffer whole MP3 frames, in sequence (#213)", () => {
    // Chunks come off the socket cut anywhere. Appended as they came, a
    // frame split across two appends reached an engine that parses each
    // append alone (WebKit on an iPad): clicks, clipped syllables, and a gap
    // it would not play across.
    const voice = new Uint8Array(
      readFileSync(
        path.join(import.meta.dirname, "../fixtures/speech-pulse.mp3"),
      ),
    );
    const { player, urls, playback } = streamingPlayback();
    playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
    const source = urls.get(player.src) as FakeMediaSource;
    expect(source.buffer.mode, "each append follows the last").toBe("sequence");
    for (let at = 0; at < voice.length; at += 1_500) {
      playback.receiveAudioChunk(voice.slice(at, at + 1_500).buffer);
      while (source.buffer.updating) source.buffer.emit("updateend");
    }
    const appended = () => {
      const all = new Uint8Array(
        source.buffer.appended.reduce((total, part) => total + part.length, 0),
      );
      let at = 0;
      for (const part of source.buffer.appended) {
        all.set(part, at);
        at += part.length;
      }
      return all;
    };
    expect(source.buffer.appended.length).toBeGreaterThan(1);
    let through = 0;
    const before = appended();
    for (const part of source.buffer.appended) {
      through += part.length;
      expect(
        mp3FrameBoundary(before.subarray(0, through)),
        "every append ends where a frame ends",
      ).toBe(through);
    }
    playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
    while (source.buffer.updating) source.buffer.emit("updateend");
    expect(appended(), "and every byte is in by the end").toEqual(voice);
    expect(source.ended).toBe(true);
  });

  it("falls back to the complete replay once when streaming fails", async () => {
    const { player, urls, playback } = streamingPlayback();
    playback.receiveAudioStart({ generation: 0, sequence: 3, mime: "audio/mpeg" });
    const third = urls.get(player.src) as FakeMediaSource;
    third.buffer.fail = true;
    playback.receiveAudioChunk(bytes("fallback"));
    playback.receiveAudioDone({ generation: 0, sequence: 3, done: true });
    playback.receiveAudioDone({ generation: 0, sequence: 3, done: true });

    const replays = [...urls.values()].filter(
      (value): value is Blob => value instanceof Blob,
    );
    expect(replays.length, "fallback is queued exactly once").toBe(1);
    expect(await replays[0].text()).toBe("fallback");
    expect(urls.get(player.src), "the complete replay is what plays").toBe(
      replays[0],
    );
    expect(playback.streamingEnabled).toBe(false);
  });

  it("stays off for the rest of the call once a stream could not sound", () => {
    // WebKit takes a stream and never sounds it. The first failure names
    // itself and the whole replay follows; the rest of the call must not pay
    // the silence watch and read the same line again, and a reconnect's
    // `hello_ack` must not offer streaming back (#203).
    const statuses: Array<[string, boolean | undefined]> = [];
    const { player, urls, playback } = streamingPlayback(undefined, statuses);
    playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
    (urls.get(player.src) as FakeMediaSource).buffer.fail = true;
    playback.receiveAudioChunk(bytes("first"));
    playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
    expect(playback.streamingEnabled).toBe(false);
    const reported = () => statuses.filter(([, error]) => error === true);
    expect(reported().length, "the cause is read once").toBe(1);
    player.ended = true;
    player.emit("ended");

    // A reconnect says hello again and the service offers MSE again.
    playback.setStreamingEnabled(true);
    expect(playback.streamingEnabled, "this browser already refused").toBe(
      false,
    );

    playback.receiveAudioStart({ generation: 0, sequence: 2, mime: "audio/mpeg" });
    playback.receiveAudioChunk(bytes("second"));
    playback.receiveAudioDone({ generation: 0, sequence: 2, done: true });
    const replay = urls.get(player.src);
    expect(replay instanceof Blob, "straight to the whole replay").toBe(true);
    expect(reported().length, "and no second line about it").toBe(1);
    expect(
      [...urls.values()].filter((value) => value instanceof FakeMediaSource)
        .length,
      "no second MediaSource was made",
    ).toBe(1);
  });

  it("lets a handoff's goodbye finish and plays the new leg after it", () => {
    const { player, urls, playback } = streamingPlayback();
    playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
    playback.receiveAudioChunk(bytes("bye"));
    playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
    const goodbye = urls.get(player.src) as FakeMediaSource;

    playback.handOffToGeneration(1);
    expect(player.pauseCalls, "the goodbye is not cut off").toBe(0);
    expect(urls.get(player.src), "the goodbye still owns the element").toBe(goodbye);

    playback.receiveAudioStart({ generation: 1, sequence: 2, mime: "audio/mpeg" });
    playback.receiveAudioChunk(bytes("hi"));
    playback.receiveAudioDone({ generation: 1, sequence: 2, done: true });
    expect(urls.get(player.src), "the new leg waits for the goodbye").toBe(goodbye);
    player.emit("ended");
    const greeting = urls.get(player.src) as FakeMediaSource;
    expect(greeting).not.toBe(goodbye);
    expect(player.playCalls.length).toBe(2);

    playback.receiveAudioStart({ generation: 0, sequence: 3, mime: "audio/mpeg" });
    expect(urls.get(player.src), "late audio from the old leg is ignored").toBe(greeting);
  });

  it("retires everything on a handoff while an old clip is still arriving", () => {
    const { player, playback } = streamingPlayback();
    playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
    playback.receiveAudioChunk(bytes("half"));
    playback.handOffToGeneration(1);
    expect(player.pauseCalls).toBe(1);
    expect(playback.isDrained()).toBe(true);
  });

  it("reports each utterance when its turn to play comes (#112)", () => {
    const reached: number[] = [];
    const { player, playback } = streamingPlayback((sequence) => reached.push(sequence));

    playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
    playback.receiveAudioChunk(bytes("one"));
    expect(reached).toEqual([1]);
    // The next utterance arrives whole while the first still plays.
    playback.receiveAudioStart({ generation: 0, sequence: 2, mime: "audio/mpeg" });
    playback.receiveAudioChunk(bytes("two"));
    playback.receiveAudioDone({ generation: 0, sequence: 2, done: true });
    expect(reached, "a queued utterance waits its turn").toEqual([1]);
    player.emit("ended");
    expect(reached).toEqual([1, 2]);

    // Audio from a leg the call has left never plays.
    playback.receiveAudioStart({ generation: 5, sequence: 3, mime: "audio/mpeg" });
    expect(reached).toEqual([1, 2, 3]);
  });

  // On WebKit an unsupported SourceBuffer payload sets a MediaError on the
  // element instead of throwing: the clip stayed "playing" for the rest of
  // the call, silent, with no fallback and nothing on screen (#189).
  it("falls back and names the cause when the element refuses the stream", async () => {
    const statuses: Array<[string, boolean | undefined]> = [];
    const { player, urls, playback } = streamingPlayback(undefined, statuses);
    playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
    playback.receiveAudioChunk(bytes("refused"));
    expect(playback.isPlaying).toBe(true);

    player.error = { code: 4 };
    player.emit("error");
    expect(playback.isPlaying, "a refused stream stops playing").toBe(false);
    expect(statuses).toEqual([
      [
        "Streaming audio failed; using the complete replay (MEDIA_ERR_SRC_NOT_SUPPORTED).",
        true,
      ],
    ]);
    expect(playback.streamingEnabled).toBe(false);

    player.error = null;
    playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
    const replays = [...urls.values()].filter(
      (value): value is Blob => value instanceof Blob,
    );
    expect(replays.length, "the whole utterance is replayed once").toBe(1);
    expect(await replays[0].text()).toBe("refused");
    expect(urls.get(player.src)).toBe(replays[0]);
  });

  // WebKit resolves `play()` on a MediaSource it cannot play and then never
  // advances: silent, no `ended`, no `error`, no fallback (#189).
  it("falls back when a stream's play() never settles at all", () => {
    // #203: WebKit takes a MediaSource of MP3, buffers every append, never
    // reaches `canplay`, and leaves `play()` pending for good. The watch was
    // armed inside the resolve handler, so nothing was ever watched: no
    // sound, no rejection, no report, for the rest of the call.
    vi.useFakeTimers();
    try {
      const statuses: Array<[string, boolean | undefined]> = [];
      const { player, playback } = streamingPlayback(undefined, statuses, 3000);
      player.play = () => {
        player.playCalls.push(player.src);
        return new Promise<void>(() => {});
      };
      playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
      playback.receiveAudioChunk(bytes("one"));
      playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
      expect(player.playCalls.length, "the stream was started").toBe(1);
      vi.advanceTimersByTime(2999);
      expect(statuses, "a clip is given its time first").toEqual([]);
      vi.advanceTimersByTime(1);
      expect(statuses).toEqual([
        [
          "Streaming audio failed; using the complete replay (no playback progress).",
          true,
        ],
      ]);
      expect(player.playCalls.length, "and the whole replay follows").toBe(2);
      expect(playback.streamingEnabled, "and nothing streams again").toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the play() rejection it caused itself off the caller's screen", async () => {
    // Reloading the element to fall back aborts the pending `play()`. That
    // rejection belongs to a clip that is already gone; it reached the
    // caller as "Audio blocked by the browser" while the replay played (#203).
    vi.useFakeTimers();
    try {
      const statuses: Array<[string, boolean | undefined]> = [];
      const { player, playback } = streamingPlayback(undefined, statuses, 3000);
      const rejects: Array<(error: unknown) => void> = [];
      player.play = () => {
        player.playCalls.push(player.src);
        return new Promise<void>((_, reject) => rejects.push(reject));
      };
      playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
      playback.receiveAudioChunk(bytes("one"));
      playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
      vi.advanceTimersByTime(3000);
      const aborted = new Error("interrupted by load()");
      aborted.name = "AbortError";
      rejects[0](aborted);
      await Promise.resolve();
      expect(
        statuses.map(([text]) => text),
        "only the cause, once",
      ).toEqual([
        "Streaming audio failed; using the complete replay (no playback progress).",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back when the stream starts and plays nothing", async () => {
    vi.useFakeTimers();
    try {
      const statuses: Array<[string, boolean | undefined]> = [];
      const { player, urls, playback } = streamingPlayback(
        undefined,
        statuses,
        1000,
      );
      playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
      playback.receiveAudioChunk(bytes("silent"));
      expect(player.playCalls.length).toBe(1);
      await Promise.resolve();

      vi.advanceTimersByTime(1000);
      expect(statuses).toEqual([
        [
          "Streaming audio failed; using the complete replay (no playback progress).",
          true,
        ],
      ]);
      expect(playback.streamingEnabled).toBe(false);
      expect(playback.isPlaying).toBe(false);

      playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
      const replays = [...urls.values()].filter(
        (value): value is Blob => value instanceof Blob,
      );
      expect(replays.length).toBe(1);
      expect(urls.get(player.src)).toBe(replays[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back when a stream that was sounding stops partway (#213)", async () => {
    // The watch used to give up on a stream once it had advanced. One that
    // then stopped -- a gap WebKit will not play across -- left the call
    // "speaking" over silence for the rest of the utterance, and the
    // "voice stream active" indicator up with it.
    vi.useFakeTimers();
    try {
      const statuses: Array<[string, boolean | undefined]> = [];
      const { player, urls, playback } = streamingPlayback(
        undefined,
        statuses,
        1000,
      );
      playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
      playback.receiveAudioChunk(bytes("partway"));
      const source = urls.get(player.src) as FakeMediaSource;
      source.buffer.emit("updateend");
      playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
      await Promise.resolve();
      player.currentTime += 0.5;
      vi.advanceTimersByTime(1000);
      expect(statuses, "it was sounding").toEqual([]);
      expect(playback.isPlaying).toBe(true);

      vi.advanceTimersByTime(1000);
      expect(statuses).toEqual([
        [
          "Streaming audio failed; using the complete replay (playback stalled).",
          true,
        ],
      ]);
      expect(playback.streamingEnabled).toBe(false);
      const replay = urls.get(player.src);
      expect(replay instanceof Blob, "the whole replay follows").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops speaking when a stream stalls before its last bytes arrive", async () => {
    vi.useFakeTimers();
    try {
      const statuses: Array<[string, boolean | undefined]> = [];
      const { player, urls, playback } = streamingPlayback(
        undefined,
        statuses,
        1000,
      );
      playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
      playback.receiveAudioChunk(bytes("half"));
      (urls.get(player.src) as FakeMediaSource).buffer.emit("updateend");
      await Promise.resolve();
      player.currentTime += 0.5;
      vi.advanceTimersByTime(2000);
      expect(statuses.map(([text]) => text)).toEqual([
        "Streaming audio failed; using the complete replay (playback stalled).",
      ]);
      expect(
        playback.isPlaying,
        "nothing is sounding, so the page does not say it is",
      ).toBe(false);

      playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
      expect(urls.get(player.src) instanceof Blob, "the replay follows").toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a stream whose bytes are still landing", async () => {
    // An element that has played everything it was given waits for the
    // next append. That is not a stall while appends keep landing.
    vi.useFakeTimers();
    try {
      const statuses: Array<[string, boolean | undefined]> = [];
      const { player, urls, playback } = streamingPlayback(
        undefined,
        statuses,
        1000,
      );
      playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
      const source = urls.get(player.src) as FakeMediaSource;
      playback.receiveAudioChunk(bytes("slow"));
      await Promise.resolve();
      for (let window = 0; window < 4; window += 1) {
        playback.receiveAudioChunk(bytes("more"));
        source.buffer.emit("updateend");
        vi.advanceTimersByTime(1000);
      }
      expect(statuses, "still arriving").toEqual([]);
      expect(playback.isPlaying).toBe(true);
      source.buffer.emit("updateend");
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);
      expect(statuses.map(([text]) => text)).toEqual([
        "Streaming audio failed; using the complete replay (no playback progress).",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a stream that played out without its ended event", async () => {
    vi.useFakeTimers();
    try {
      const statuses: Array<[string, boolean | undefined]> = [];
      const { player, urls, playback } = streamingPlayback(
        undefined,
        statuses,
        1000,
      );
      playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
      playback.receiveAudioChunk(bytes("whole"));
      const first = urls.get(player.src) as FakeMediaSource;
      first.buffer.emit("updateend");
      playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
      expect(first.ended).toBe(true);
      playback.receiveAudioStart({ generation: 0, sequence: 2, mime: "audio/mpeg" });
      playback.receiveAudioChunk(bytes("next"));
      playback.receiveAudioDone({ generation: 0, sequence: 2, done: true });
      await Promise.resolve();
      player.currentTime = player.duration;
      vi.advanceTimersByTime(2000);
      expect(statuses, "a stream that played out is not a failure").toEqual([]);
      expect(playback.streamingEnabled).toBe(true);
      const second = urls.get(player.src);
      expect(second, "the next one plays").toBeInstanceOf(FakeMediaSource);
      expect(second).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not blame a stream that ended for the next one's start", async () => {
    // The watch outlived `ended`. When the next utterance took the element
    // before its first bytes arrived, `currentTime` went back to 0 and the
    // finished stream was reported as silent, turning streaming off.
    vi.useFakeTimers();
    try {
      const statuses: Array<[string, boolean | undefined]> = [];
      const { player, urls, playback } = streamingPlayback(
        undefined,
        statuses,
        1000,
      );
      playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
      playback.receiveAudioChunk(bytes("short"));
      (urls.get(player.src) as FakeMediaSource).buffer.emit("updateend");
      playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
      await Promise.resolve();
      player.currentTime = 1.4;
      player.ended = true;
      player.emit("ended");
      playback.receiveAudioStart({ generation: 0, sequence: 2, mime: "audio/mpeg" });
      player.currentTime = 0;
      vi.advanceTimersByTime(1000);
      expect(statuses).toEqual([]);
      expect(playback.streamingEnabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says a stream an outside pause stopped needs a tap, and resumes on one", async () => {
    // An iPad hands its audio session to the microphone or another app and
    // the element pauses. The stream used to stay "playing": no message, no
    // way back, the indicator up over silence (#213).
    const statuses: Array<[string, boolean | undefined]> = [];
    const { player, playback } = streamingPlayback(undefined, statuses);
    playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
    playback.receiveAudioChunk(bytes("interrupted"));
    await Promise.resolve();
    expect(playback.isPlaying).toBe(true);

    player.paused = true;
    player.emit("pause");
    expect(playback.isPlaying, "a paused stream is not speaking").toBe(false);
    expect(statuses).toEqual([
      ["Audio paused — tap or click anywhere on this page to resume.", true],
    ]);

    playback.handleGesture(null);
    expect(player.playCalls.length, "a tap plays it again").toBe(2);
    expect(playback.isPlaying).toBe(true);
  });

  it("plays the utterances queued behind a stream that fails (#259)", async () => {
    // The stall #216 catches on an iPad fell the stream back to its whole
    // replay, and the complete utterance queued behind it was never started
    // or reported. The queue never drained, so hands-free never got its
    // follow-up lease back for the rest of the leg.
    vi.useFakeTimers();
    try {
      const statuses: Array<[string, boolean | undefined]> = [];
      const reached: number[] = [];
      const { player, urls, playback } = streamingPlayback(
        (sequence) => reached.push(sequence),
        statuses,
        1000,
      );
      playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
      playback.receiveAudioChunk(bytes("first"));
      (urls.get(player.src) as FakeMediaSource).buffer.emit("updateend");
      playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
      // The second arrives whole while the first still plays.
      playback.receiveAudioStart({ generation: 0, sequence: 2, mime: "audio/mpeg" });
      playback.receiveAudioChunk(bytes("second"));
      playback.receiveAudioDone({ generation: 0, sequence: 2, done: true });
      await Promise.resolve();
      player.currentTime += 0.5;
      vi.advanceTimersByTime(2000);
      expect(statuses.map(([text]) => text)).toEqual([
        "Streaming audio failed; using the complete replay (playback stalled).",
      ]);
      const first = urls.get(player.src);
      expect(first instanceof Blob, "the first is replayed whole").toBe(true);
      expect(await (first as Blob).text()).toBe("first");

      player.ended = true;
      player.emit("ended");
      const second = urls.get(player.src);
      expect(second instanceof Blob, "the second follows it").toBe(true);
      expect(await (second as Blob).text()).toBe("second");
      expect(reached).toEqual([1, 1, 2]);
      player.ended = true;
      player.emit("ended");
      expect(playback.isDrained()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays an utterance still arriving behind a stream that fails (#259)", async () => {
    vi.useFakeTimers();
    try {
      const { player, urls, playback } = streamingPlayback(undefined, [], 1000);
      playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
      playback.receiveAudioChunk(bytes("first"));
      (urls.get(player.src) as FakeMediaSource).buffer.emit("updateend");
      playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
      playback.receiveAudioStart({ generation: 0, sequence: 2, mime: "audio/mpeg" });
      playback.receiveAudioChunk(bytes("sec"));
      await Promise.resolve();
      player.currentTime += 0.5;
      vi.advanceTimersByTime(2000);
      playback.receiveAudioChunk(bytes("ond"));
      playback.receiveAudioDone({ generation: 0, sequence: 2, done: true });
      player.ended = true;
      player.emit("ended");
      const second = urls.get(player.src);
      expect(second instanceof Blob).toBe(true);
      expect(await (second as Blob).text()).toBe("second");
      player.ended = true;
      player.emit("ended");
      expect(playback.isDrained()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back when a stream's source never opens (#259)", () => {
    // An engine that leaves the source closed and sets no error: nothing was
    // appended, so the watch was never armed, and the call heard nothing
    // with nothing said.
    vi.useFakeTimers();
    try {
      const statuses: Array<[string, boolean | undefined]> = [];
      const reached: number[] = [];
      const { player, urls, playback } = streamingPlayback(
        (sequence) => reached.push(sequence),
        statuses,
        1000,
      );
      vi.spyOn(FakeMediaSource.prototype, "attach").mockImplementation(() => {});
      playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
      playback.receiveAudioChunk(bytes("never"));
      playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
      vi.advanceTimersByTime(999);
      expect(statuses, "the source is given its time first").toEqual([]);
      vi.advanceTimersByTime(1);
      expect(statuses).toEqual([
        [
          "Streaming audio failed; using the complete replay (MediaSource did not open).",
          true,
        ],
      ]);
      const replay = urls.get(player.src);
      expect(replay instanceof Blob, "the whole replay follows").toBe(true);
      player.ended = true;
      player.emit("ended");
      expect(playback.isDrained()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hurry a source that opened and waits for its first bytes", () => {
    vi.useFakeTimers();
    try {
      const statuses: Array<[string, boolean | undefined]> = [];
      const { player, urls, playback } = streamingPlayback(undefined, statuses, 1000);
      playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
      vi.advanceTimersByTime(5000);
      expect(statuses).toEqual([]);
      playback.receiveAudioChunk(bytes("late"));
      expect((urls.get(player.src) as FakeMediaSource).buffer.appended.length).toBe(1);
      expect(playback.streamingEnabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps what was queued when the service turns streaming off (#259)", async () => {
    // A `hello_ack` without MSE dropped the utterance still arriving: its
    // `audio_done` found nothing pending, and it never played or drained.
    const reached: number[] = [];
    const { player, urls, playback } = streamingPlayback((sequence) =>
      reached.push(sequence),
    );
    playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
    playback.receiveAudioChunk(bytes("half"));
    playback.setStreamingEnabled(false);
    expect(playback.isPlaying, "the stream is taken off the element").toBe(false);
    playback.receiveAudioChunk(bytes("way"));
    playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
    const replay = urls.get(player.src);
    expect(replay instanceof Blob, "it is replayed whole").toBe(true);
    expect(await (replay as Blob).text()).toBe("halfway");
    player.ended = true;
    player.emit("ended");
    expect(playback.isDrained()).toBe(true);
  });

  it("plays what was queued when streaming turns off in the pause between streams (#259)", async () => {
    // The pause before the next stream was already running, so the replays
    // could not start then, and the stream it waited for was never started
    // either: the queue never drained.
    vi.useFakeTimers();
    try {
      const reached: number[] = [];
      const { player, urls, playback } = streamingPlayback(
        (sequence) => reached.push(sequence),
        undefined,
        undefined,
        350,
      );
      playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
      playback.receiveAudioChunk(bytes("first"));
      (urls.get(player.src) as FakeMediaSource).buffer.emit("updateend");
      playback.receiveAudioDone({ generation: 0, sequence: 1, done: true });
      playback.receiveAudioStart({ generation: 0, sequence: 2, mime: "audio/mpeg" });
      playback.receiveAudioChunk(bytes("second"));
      playback.receiveAudioDone({ generation: 0, sequence: 2, done: true });
      await Promise.resolve();
      player.ended = true;
      player.emit("ended");
      playback.setStreamingEnabled(false);
      vi.advanceTimersByTime(350);
      const second = urls.get(player.src);
      expect(second instanceof Blob, "the second is replayed whole").toBe(true);
      expect(await (second as Blob).text()).toBe("second");
      expect(reached).toEqual([1, 2]);
      player.ended = true;
      player.emit("ended");
      expect(playback.isDrained()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores audio stamped with another generation", () => {
    const { player, urls, playback } = streamingPlayback();
    playback.resetForGeneration(4);
    const createdBefore = urls.size;
    playback.receiveAudioStart({ generation: 9, sequence: 99, mime: "audio/mpeg" });
    playback.receiveAudioChunk(bytes("stale"));
    playback.receiveAudioDone({ generation: 9, sequence: 99, done: true });
    expect(urls.size, "stale audio creates no source").toBe(createdBefore);
    expect(player.playCalls.length).toBe(0);
    expect(playback.isDrained()).toBe(true);
  });
});

describe("AudioPlayback complete replays", () => {
  it("reports an utterance when its replay starts (#112)", () => {
    const player = fakePlayer();
    stubObjectUrls();
    const reached: number[] = [];
    const playback = new AudioPlayback({
      player: player as unknown as HTMLAudioElement,
      idleText: "idle",
      onStatus: () => {},
      onChange: () => {},
      onUtterance: (sequence) => reached.push(sequence),
      gapMs: 0,
    });
    for (const sequence of [4, 5]) {
      playback.receiveAudioStart({ generation: 0, sequence, mime: "audio/mpeg" });
      playback.receiveAudioChunk(new TextEncoder().encode("x").buffer);
      playback.receiveAudioDone({ generation: 0, sequence, done: true });
    }
    expect(reached).toEqual([4]);
    player.ended = true;
    player.emit("ended");
    expect(reached).toEqual([4, 5]);
  });
});

describe("AudioPlayback failure reporting", () => {
  // A browser that refuses the clip used to drop every utterance in silence:
  // no sound, and nothing on screen for the caller to report (#189).
  it("names a media element error instead of dropping the clip silently", async () => {
    const player = fakePlayer();
    stubObjectUrls();
    const statuses: Array<[string, boolean | undefined]> = [];
    const playback = new AudioPlayback({
      player: player as unknown as HTMLAudioElement,
      idleText: "idle",
      onStatus: (text, error) => statuses.push([text, error]),
      onChange: () => {},
      gapMs: 0,
    });
    playback.audioQueue.push(new Blob(["clip"]));
    playback.playNext();
    player.playPromises[0].resolve();
    await Promise.resolve();

    player.error = { code: 3 };
    player.emit("error");
    expect(statuses).toEqual([
      ["Audio failed to play (MEDIA_ERR_DECODE).", true],
      ["idle", false],
    ]);
    expect(playback.isDrained()).toBe(true);
  });
});

describe("AudioPlayback silent playback", () => {
  // `play()` resolving proves nothing: on WebKit an element with a
  // MediaSource it cannot play resolves and never advances. The call then
  // "spoke" in silence for the rest of its life, with nothing on screen and
  // no caption, because `ended` never came either (#189).
  it("reports a replay that starts and plays nothing", async () => {
    vi.useFakeTimers();
    try {
      const player = fakePlayer();
      stubObjectUrls();
      const statuses: Array<[string, boolean | undefined]> = [];
      const playback = new AudioPlayback({
        player: player as unknown as HTMLAudioElement,
        idleText: "idle",
        onStatus: (text, error) => statuses.push([text, error]),
        onChange: () => {},
        gapMs: 0,
        stallMs: 1000,
      });
      playback.audioQueue.push(new Blob(["silent"]));
      playback.playNext();
      player.playPromises[0].resolve();
      await Promise.resolve();
      expect(playback.isPlaying).toBe(true);

      vi.advanceTimersByTime(999);
      expect(statuses, "the watch gives the clip its time").toEqual([]);
      vi.advanceTimersByTime(1);
      expect(statuses[0]).toEqual([
        "Audio started but produced no sound (nothing played in 1000ms).",
        true,
      ]);
      expect(playback.isPlaying, "a silent clip stops speaking").toBe(false);
      expect(playback.isDrained()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a replay whose play() never settles either", async () => {
    // The same hazard on the replay path: a `play()` that never resolves is
    // a clip that produced no sound, and the watch is armed on the attempt
    // so it is noticed either way (#203).
    vi.useFakeTimers();
    try {
      const player = fakePlayer();
      stubObjectUrls();
      const statuses: Array<[string, boolean | undefined]> = [];
      const playback = new AudioPlayback({
        player: player as unknown as HTMLAudioElement,
        idleText: "idle",
        onStatus: (text, error) => statuses.push([text, error]),
        onChange: () => {},
        gapMs: 0,
        stallMs: 1000,
      });
      playback.audioQueue.push(new Blob(["silent"]));
      playback.playNext();
      // Nothing resolves or rejects the attempt.
      vi.advanceTimersByTime(1000);
      expect(statuses[0]).toEqual([
        "Audio started but produced no sound (nothing played in 1000ms).",
        true,
      ]);
      expect(playback.isDrained()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a clip that is playing alone", async () => {
    vi.useFakeTimers();
    try {
      const player = fakePlayer();
      stubObjectUrls();
      const statuses: Array<[string, boolean | undefined]> = [];
      const playback = new AudioPlayback({
        player: player as unknown as HTMLAudioElement,
        idleText: "idle",
        onStatus: (text, error) => statuses.push([text, error]),
        onChange: () => {},
        gapMs: 0,
        stallMs: 1000,
      });
      playback.audioQueue.push(new Blob(["heard"]));
      playback.playNext();
      player.playPromises[0].resolve();
      await Promise.resolve();
      for (let window = 0; window < 5; window += 1) {
        player.currentTime += 0.5;
        vi.advanceTimersByTime(1000);
      }
      expect(statuses).toEqual([]);
      expect(playback.isPlaying).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a replay that stops partway and never resumes (#213)", async () => {
    // A clip that advanced used to be left alone for good: if it then
    // stopped, with no `ended` and no `error`, the call stayed "speaking"
    // over silence.
    vi.useFakeTimers();
    try {
      const player = fakePlayer();
      stubObjectUrls();
      const statuses: Array<[string, boolean | undefined]> = [];
      const playback = new AudioPlayback({
        player: player as unknown as HTMLAudioElement,
        idleText: "idle",
        onStatus: (text, error) => statuses.push([text, error]),
        onChange: () => {},
        gapMs: 0,
        stallMs: 1000,
      });
      playback.audioQueue.push(new Blob(["cut off"]));
      playback.playNext();
      player.playPromises[0].resolve();
      await Promise.resolve();
      player.currentTime += 0.5;
      vi.advanceTimersByTime(1000);
      expect(statuses, "it was sounding").toEqual([]);

      vi.advanceTimersByTime(1000);
      expect(statuses[0]).toEqual([
        "Audio stopped partway and did not resume (nothing played for 1000ms).",
        true,
      ]);
      expect(playback.isPlaying, "and it stops speaking").toBe(false);
      expect(playback.isDrained()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says a paused replay needs a tap, as an error the caller sees", async () => {
    const player = fakePlayer();
    stubObjectUrls();
    const statuses: Array<[string, boolean | undefined]> = [];
    const playback = new AudioPlayback({
      player: player as unknown as HTMLAudioElement,
      idleText: "idle",
      onStatus: (text, error) => statuses.push([text, error]),
      onChange: () => {},
      gapMs: 0,
    });
    playback.audioQueue.push(new Blob(["interrupted"]));
    playback.playNext();
    player.playPromises[0].resolve();
    await Promise.resolve();
    player.paused = true;
    player.emit("pause");
    expect(statuses).toEqual([
      ["Audio paused — tap or click anywhere on this page to resume.", true],
    ]);
  });
});

describe("AudioPlayback level", () => {
  // The level is the utterance's own bytes in every engine (#194): a replay
  // is decoded in one go, a stream as its chunks arrive.
  it("meters the replay against its decoded envelope", async () => {
    const player = fakePlayer();
    stubObjectUrls();
    const levels: number[] = [];
    const frames: FrameRequestCallback[] = [];
    const samples = new Float32Array(1000).fill(0.5);
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData() {
          return Promise.resolve({
            sampleRate: 1000,
            length: samples.length,
            getChannelData: () => samples,
          } as unknown as AudioBuffer);
        }
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const playback = new AudioPlayback({
      player: player as unknown as HTMLAudioElement,
      idleText: "idle",
      onStatus: () => {},
      onChange: () => {},
      onAudioLevel: (level) => levels.push(level),
      gapMs: 0,
    });

    playback.audioQueue.push(new Blob(["mp3 bytes"]));
    playback.playNext();
    player.currentTime = 0.5;
    player.playPromises[0].resolve();
    for (let step = 0; step < 8; step += 1) await Promise.resolve();
    expect(levels.length, "the envelope is metered once decoded").toBeGreaterThan(0);
    expect(levels[levels.length - 1]).toBeCloseTo(1, 5);

    player.currentTime = 100;
    frames.pop()?.(0);
    expect(levels[levels.length - 1], "past the clip is silence").toBe(0);

    player.ended = true;
    player.emit("ended");
    expect(levels[levels.length - 1], "a finished clip reports nothing").toBe(0);
  });

  it("meters a stream against the chunks that have arrived", async () => {
    const { urls } = stubObjectUrls();
    const player = fakePlayer((url) => {
      const source = urls.get(url) as { attach?: () => void };
      source?.attach?.();
    });
    player.play = () => {
      player.playCalls.push(player.src);
      return Promise.resolve();
    };
    const levels: number[] = [];
    const frames: FrameRequestCallback[] = [];
    // One MPEG-1 Layer III frame at 128 kbps, 44.1 kHz: 417 bytes, 26ms.
    const frameBytes = 417;
    const mp3 = (count: number) => {
      const bytes = new Uint8Array(count * frameBytes);
      for (let frame = 0; frame < count; frame += 1) {
        bytes.set([0xff, 0xfb, 0x90, 0x00], frame * frameBytes);
      }
      return bytes.buffer as ArrayBuffer;
    };
    class FakeSourceBuffer {
      updating = false;
      addEventListener() {}
      removeEventListener() {}
      appendBuffer() {}
    }
    // Closed until the element attaches it, as a real one is (#203).
    class FakeMediaSource {
      static isTypeSupported = () => true;
      readyState = "closed";
      opens: Array<() => void> = [];
      addEventListener(name: string, handler: () => void) {
        if (name === "sourceopen") this.opens.push(handler);
      }
      attach() {
        this.readyState = "open";
        for (const handler of [...this.opens]) handler();
      }
      addSourceBuffer() {
        return new FakeSourceBuffer();
      }
      endOfStream() {}
    }
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData(data: ArrayBuffer) {
          const decoded = Math.floor(data.byteLength / frameBytes) * 1152;
          const samples = new Float32Array(decoded).fill(0.5);
          return Promise.resolve({
            sampleRate: 44100,
            length: samples.length,
            getChannelData: () => samples,
          } as unknown as AudioBuffer);
        }
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const playback = new AudioPlayback({
      player: player as unknown as HTMLAudioElement,
      idleText: "idle",
      onStatus: () => {},
      onChange: () => {},
      onAudioLevel: (level) => levels.push(level),
      gapMs: 0,
    });
    playback.setStreamingEnabled(true);

    playback.receiveAudioStart({ generation: 0, sequence: 1, mime: "audio/mpeg" });
    // Two frames: 52ms of voice, cut mid-frame as a socket chunk is.
    playback.receiveAudioChunk(mp3(2).slice(0, 2 * frameBytes + 11));
    for (let step = 0; step < 8; step += 1) await Promise.resolve();
    player.currentTime = 0.01;
    frames.pop()?.(0);
    expect(levels.at(-1), "the stream is metered as it arrives").toBeCloseTo(1, 5);

    player.currentTime = 0.09;
    frames.pop()?.(0);
    expect(levels.at(-1), "past what has arrived is silence").toBe(0);

    playback.receiveAudioChunk(mp3(4));
    for (let step = 0; step < 8; step += 1) await Promise.resolve();
    frames.pop()?.(0);
    expect(levels.at(-1), "the same timeline grew with the clip").toBeCloseTo(
      1,
      5,
    );
  });
});

describe("AudioPlayback pause between messages", () => {
  it("waits the gap before the next message and none after the last", async () => {
    vi.useFakeTimers();
    try {
      const player = fakePlayer();
      const { urls } = stubObjectUrls();
      const playback = new AudioPlayback({
        player: player as unknown as HTMLAudioElement,
        idleText: "idle",
        onStatus: () => {},
        onChange: () => {},
        gapMs: 350,
      });
      const first = new Blob(["first"]);
      const second = new Blob(["second"]);
      playback.audioQueue.push(first, second);
      playback.playNext();
      expect(urls.get(player.src)).toBe(first);
      player.playPromises[0].resolve();
      await Promise.resolve();

      player.ended = true;
      player.emit("ended");
      // The first message is over; the second waits for the pause.
      expect(player.playCalls.length).toBe(1);
      expect(playback.isDrained()).toBe(false);
      // A click during the pause does not skip it.
      playback.handleGesture(null);
      expect(player.playCalls.length).toBe(1);
      vi.advanceTimersByTime(349);
      expect(player.playCalls.length).toBe(1);
      vi.advanceTimersByTime(1);
      expect(urls.get(player.src)).toBe(second);
      expect(player.playCalls.length).toBe(2);
      player.playPromises[1].resolve();
      await Promise.resolve();

      player.ended = true;
      player.emit("ended");
      // Nothing is left, so there is no pause to wait for.
      expect(playback.isDrained()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a new leg cancels a pending pause", () => {
    vi.useFakeTimers();
    try {
      const player = fakePlayer();
      stubObjectUrls();
      const playback = new AudioPlayback({
        player: player as unknown as HTMLAudioElement,
        idleText: "idle",
        onStatus: () => {},
        onChange: () => {},
        gapMs: 350,
      });
      playback.audioQueue.push(new Blob(["first"]), new Blob(["second"]));
      playback.playNext();
      player.ended = true;
      player.emit("ended");
      playback.resetForGeneration(7);
      vi.advanceTimersByTime(1000);
      expect(player.playCalls.length).toBe(1);
      expect(playback.isDrained()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

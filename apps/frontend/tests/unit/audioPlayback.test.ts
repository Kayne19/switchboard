import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioPlayback } from "../../src/runtime/audioPlayback";

// Ported from the legacy runtime's playback regressions: one clip owns the
// element at a time, and a late event from a replaced clip can never advance,
// resume, or requeue the clip that replaced it.

type Handler = () => void;

function fakePlayer() {
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
      if (value) player.ended = false;
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
    });
    playback.audioQueue.push(new Blob(["reply"]));
    playback.playNext();
    player.playPromises[0].reject(
      Object.assign(new Error("blocked"), { name: "NotAllowedError" }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses.at(-1)).toEqual([
      "Audio blocked by the browser — click anywhere on this page once, then it will play (NotAllowedError).",
      true,
    ]);
    expect(playback.audioQueue.length).toBe(1);
    expect(playback.isDrained()).toBe(false);
  });
});

describe("AudioPlayback streaming", () => {
  class FakeSourceBuffer {
    listeners = new Map<string, Set<Handler>>();
    updating = false;
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
    readyState = "open";
    buffer = new FakeSourceBuffer();
    ended = false;
    addEventListener() {}
    addSourceBuffer() {
      return this.buffer;
    }
    endOfStream() {
      this.ended = true;
      this.readyState = "ended";
    }
  }

  function streamingPlayback() {
    const player = fakePlayer();
    player.play = () => {
      player.playCalls.push(player.src);
      return Promise.resolve();
    };
    const { urls } = stubObjectUrls();
    vi.stubGlobal("MediaSource", FakeMediaSource);
    const playback = new AudioPlayback({
      player: player as unknown as HTMLAudioElement,
      idleText: "idle",
      onStatus: () => {},
      onChange: () => {},
    });
    playback.setStreamingEnabled(true);
    return { player, urls, playback };
  }

  const bytes = (text: string) => new TextEncoder().encode(text).buffer;

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

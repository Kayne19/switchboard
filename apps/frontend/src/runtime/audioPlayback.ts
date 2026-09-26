// Plays the agent's spoken replies.
//
// Replies arrive as `audio_start`, binary chunks, and `audio_done`. When the
// backend and browser agree on streaming MP3, each utterance plays through its
// own MediaSource as it arrives; otherwise (or when streaming fails) the
// complete utterance is replayed from a Blob. One element plays one clip at a
// time, and every event handler is bound to the clip that installed it, so a
// late event from a replaced clip can never advance or requeue the new one.

import type { AudioDoneMessage, AudioStartMessage } from "../protocol";
import { errorName } from "./errors";

export const MAX_AUDIO_UTTERANCE = 32 * 1024 * 1024;
export const MAX_AUDIO_REPLAY = 64 * 1024 * 1024;

interface PlaybackOwner {
  blob: Blob;
  url: string;
  token: number;
  consumed: boolean;
  requeued: boolean;
  paused: boolean;
  seeked: boolean;
  awaitingEnded: boolean;
  pendingAttempt: number | null;
  handlers: Array<[string, EventListener]>;
}

interface MseUtterance {
  generation: number;
  sequence: number;
  mime: string;
  parts: Blob[];
  queued: ArrayBuffer[];
  bytes: number;
  done: boolean;
  failed: boolean;
  fallbackQueued: boolean;
  media: MediaSource | null;
  buffer: SourceBuffer | null;
  url: string | null;
  started: boolean;
  endedHandler?: EventListener;
}

export interface AudioPlaybackOptions {
  /** The element replies play through. Defaults to a detached `new Audio()`. */
  player?: HTMLAudioElement;
  /** The status shown once nothing is left to play. */
  idleText: string;
  /** `error` undefined leaves the current error flag as it is. */
  onStatus: (text: string, error?: boolean) => void;
  /** Called whenever what is playing, or waiting to play, changes. */
  onChange: () => void;
}

export class AudioPlayback {
  readonly player: HTMLAudioElement;
  /** Complete utterances waiting for the element, oldest first. */
  readonly audioQueue: Blob[] = [];
  private readonly options: AudioPlaybackOptions;
  private playing = false;
  private playbackOwner: PlaybackOwner | null = null;
  private playbackToken = 0;
  private playAttemptToken = 0;
  private audioEpoch = 0;
  private mseEnabled = false;
  private mseQueue: MseUtterance[] = [];
  private mseActive: MseUtterance | null = null;
  private msePending: MseUtterance | null = null;
  private mseReplayBytes = 0;

  constructor(options: AudioPlaybackOptions) {
    this.options = options;
    this.player = options.player ?? new Audio();
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get streamingEnabled(): boolean {
    return this.mseEnabled;
  }

  /** True when nothing is playing and nothing is waiting to play. */
  isDrained(): boolean {
    return (
      this.audioQueue.length === 0 &&
      this.playbackOwner === null &&
      !this.playing &&
      this.mseActive === null &&
      this.mseQueue.length === 0 &&
      this.msePending === null
    );
  }

  /** Streams MP3 through MediaSource when the backend and this browser agree. */
  setStreamingEnabled(requested: boolean): void {
    this.mseEnabled = requested && mseRuntimeSupported();
    if (!this.mseEnabled) this.clearMsePlayback();
  }

  /**
   * Retires everything queued or playing from the previous leg. Audio stamped
   * with an older generation is ignored from here on.
   */
  resetForGeneration(generation: number): void {
    this.audioEpoch = generation;
    this.audioQueue.length = 0;
    this.clearMsePlayback();
    if (this.playbackOwner) this.cleanupOwner(this.playbackOwner);
    this.playing = false;
  }

  /** Stops playback for good; used when the runtime is torn down. */
  dispose(): void {
    this.audioQueue.length = 0;
    this.clearMsePlayback();
    if (this.playbackOwner) this.cleanupOwner(this.playbackOwner);
    this.playing = false;
  }

  // The status message promises that a page interaction resumes blocked
  // audio. This is that gesture path, so blocked audio does not wait for a
  // later clip to arrive.
  handleGesture(target?: EventTarget | null): void {
    if (target === this.player) return;
    const owner = this.playbackOwner;
    if (!owner) {
      if (this.mseActive && !this.playing) this.msePlay();
      else if (this.audioQueue.length) this.playNext();
      return;
    }
    if (this.playing || owner.awaitingEnded || owner.pendingAttempt !== null)
      return;
    this.attemptPlay(owner);
  }

  playNext(): void {
    if (this.playbackOwner) this.cleanupOwner(this.playbackOwner);
    const blob = this.audioQueue.shift();
    if (!blob) {
      this.playing = false;
      this.options.onStatus(this.options.idleText, false);
      this.notifyPlaybackChange();
      return;
    }
    const player = this.player;
    const owner: PlaybackOwner = {
      blob,
      url: URL.createObjectURL(blob),
      token: ++this.playbackToken,
      consumed: false,
      requeued: false,
      paused: false,
      seeked: false,
      awaitingEnded: false,
      pendingAttempt: null,
      handlers: [],
    };
    this.playbackOwner = owner;
    this.notifyPlaybackChange();
    const ended: EventListener = () => {
      if (
        this.playbackOwner !== owner ||
        owner.consumed ||
        player.ended === false
      )
        return;
      this.consumeOwner(owner);
    };
    const pause: EventListener = () => {
      if (
        this.playbackOwner !== owner ||
        owner.consumed ||
        player.ended ||
        player.paused === false
      )
        return;
      owner.paused = true;
      owner.awaitingEnded = owner.seeked && this.terminalSeek();
      this.playing = false;
      this.notifyPlaybackChange();
      this.options.onStatus(
        owner.awaitingEnded
          ? "Audio finishing — click anywhere on this page to continue."
          : "Audio paused — click anywhere on this page to resume.",
      );
    };
    const error: EventListener = () => {
      if (this.playbackOwner !== owner || owner.consumed || !player.error)
        return;
      this.consumeOwner(owner);
    };
    const resetTerminal = () => {
      if (
        this.playbackOwner === owner &&
        (!Number.isFinite(player.duration) ||
          !Number.isFinite(player.currentTime) ||
          player.currentTime < player.duration)
      ) {
        owner.awaitingEnded = false;
        owner.seeked = false;
      }
    };
    owner.handlers = [
      ["ended", ended],
      ["pause", pause],
      ["error", error],
      [
        "seeking",
        () => {
          owner.seeked = true;
          resetTerminal();
        },
      ],
      ["seeked", resetTerminal],
      ["timeupdate", resetTerminal],
    ];
    for (const [name, handler] of owner.handlers) {
      player.addEventListener(name, handler);
    }
    player.src = owner.url;
    this.attemptPlay(owner);
  }

  receiveAudioStart(
    message: Pick<AudioStartMessage, "generation" | "sequence" | "mime">,
  ): void {
    const generation = message.generation;
    const sequence = message.sequence;
    if (
      typeof generation !== "number" ||
      typeof sequence !== "number" ||
      generation !== this.audioEpoch
    )
      return;
    const utterance: MseUtterance = {
      generation,
      sequence,
      mime: message.mime === "audio/mpeg" ? message.mime : "audio/mpeg",
      parts: [],
      queued: [],
      bytes: 0,
      done: false,
      failed: false,
      fallbackQueued: false,
      media: null,
      buffer: null,
      url: null,
      started: false,
    };
    this.msePending = utterance;
    if (this.mseEnabled) {
      this.mseQueue.push(utterance);
      this.mseStartNext();
    }
    this.notifyPlaybackChange();
  }

  receiveAudioChunk(data: ArrayBuffer): void {
    const utterance = this.msePending;
    if (!utterance || utterance.generation !== this.audioEpoch) return;
    if (
      utterance.bytes + data.byteLength > MAX_AUDIO_UTTERANCE ||
      this.mseReplayBytes + data.byteLength > MAX_AUDIO_REPLAY
    ) {
      this.mseFail(utterance, new Error("audio replay limit"));
      return;
    }
    utterance.bytes += data.byteLength;
    this.mseReplayBytes += data.byteLength;
    utterance.parts.push(new Blob([data], { type: utterance.mime }));
    if (this.mseEnabled && !utterance.failed) {
      utterance.queued.push(data);
      if (utterance === this.mseActive) this.mseAppend(utterance);
    }
    this.notifyPlaybackChange();
  }

  receiveAudioDone(
    message: Pick<AudioDoneMessage, "generation" | "sequence" | "done">,
  ): void {
    if (
      message.generation !== this.audioEpoch ||
      typeof message.sequence !== "number"
    )
      return;
    const utterance = this.msePending;
    if (!utterance || utterance.sequence !== message.sequence) return;
    utterance.done = message.done === true;
    if (!this.mseEnabled || utterance.failed) {
      this.queueMseFallback(utterance);
      if (this.mseActive === utterance) this.mseActive = null;
      this.msePending = null;
      if (!this.playing && !this.playbackOwner) this.playNext();
      this.notifyPlaybackChange();
      return;
    }
    if (utterance === this.mseActive) this.mseAppend(utterance);
    this.msePending = null;
    this.notifyPlaybackChange();
  }

  private notifyPlaybackChange(): void {
    this.options.onChange();
  }

  private cleanupOwner(owner: PlaybackOwner): void {
    const player = this.player;
    if (this.playbackOwner === owner) this.playbackOwner = null;
    owner.pendingAttempt = null;
    for (const [name, handler] of owner.handlers) {
      player.removeEventListener(name, handler);
    }
    owner.handlers = [];
    player.pause();
    player.removeAttribute("src");
    player.load();
    URL.revokeObjectURL(owner.url);
    this.playing = false;
    this.notifyPlaybackChange();
  }

  private consumeOwner(owner: PlaybackOwner): void {
    if (this.playbackOwner !== owner || owner.consumed) return;
    owner.consumed = true;
    this.cleanupOwner(owner);
    this.playNext();
  }

  private playFailed(
    owner: PlaybackOwner,
    attempt: number,
    error: unknown,
  ): void {
    if (
      this.playbackOwner !== owner ||
      owner.consumed ||
      owner.pendingAttempt !== attempt ||
      owner.requeued
    )
      return;
    owner.pendingAttempt = null;
    owner.requeued = true;
    this.cleanupOwner(owner);
    // Autoplay rejection is recoverable: keep this clip at the front so the
    // next user gesture retries it instead of silently losing it.
    this.audioQueue.unshift(owner.blob);
    this.options.onStatus(
      "Audio blocked by the browser — click anywhere on this page once, then it will play (" +
        errorName(error) +
        ").",
      true,
    );
  }

  private attemptPlay(owner: PlaybackOwner): void {
    if (
      this.playbackOwner !== owner ||
      owner.consumed ||
      owner.pendingAttempt !== null
    )
      return;
    owner.paused = false;
    owner.seeked = false;
    this.playing = true;
    this.notifyPlaybackChange();
    const attempt = ++this.playAttemptToken;
    owner.pendingAttempt = attempt;
    let result: Promise<void>;
    try {
      result = this.player.play();
    } catch (error) {
      this.playFailed(owner, attempt, error);
      return;
    }
    Promise.resolve(result).then(
      () => {
        if (
          this.playbackOwner !== owner ||
          owner.consumed ||
          owner.pendingAttempt !== attempt
        )
          return;
        owner.pendingAttempt = null;
        this.playing = !owner.paused;
        this.notifyPlaybackChange();
      },
      (error) => this.playFailed(owner, attempt, error),
    );
  }

  private terminalSeek(): boolean {
    const player = this.player;
    return (
      Number.isFinite(player.duration) &&
      player.duration > 0 &&
      Number.isFinite(player.currentTime) &&
      player.currentTime >= player.duration
    );
  }

  private queueMseFallback(utterance: MseUtterance): void {
    if (utterance.fallbackQueued) return;
    utterance.fallbackQueued = true;
    if (utterance.bytes > MAX_AUDIO_UTTERANCE) {
      this.options.onStatus(
        "Audio exceeded the replay limit and was stopped.",
        true,
      );
      return;
    }
    this.audioQueue.push(new Blob(utterance.parts, { type: utterance.mime }));
    this.notifyPlaybackChange();
  }

  private msePlay(): void {
    if (!this.mseActive || this.mseActive.failed || this.playing) return;
    this.playing = true;
    this.notifyPlaybackChange();
    Promise.resolve(this.player.play()).catch((error) => {
      this.playing = false;
      this.notifyPlaybackChange();
      this.options.onStatus(
        "Audio blocked by the browser — click anywhere on this page once, then it will play (" +
          errorName(error) +
          ").",
        true,
      );
    });
  }

  private mseFinishSource(utterance: MseUtterance): void {
    if (
      !utterance.done ||
      !utterance.media ||
      !utterance.buffer ||
      utterance.buffer.updating ||
      utterance.queued.length
    )
      return;
    try {
      if (utterance.media.readyState === "open") utterance.media.endOfStream();
    } catch (error) {
      this.mseFail(utterance, error);
    }
  }

  private mseAppend(utterance: MseUtterance): void {
    if (utterance.failed || !utterance.buffer || utterance.buffer.updating)
      return;
    if (!utterance.queued.length) {
      this.mseFinishSource(utterance);
      return;
    }
    try {
      utterance.buffer.appendBuffer(utterance.queued[0]);
      utterance.started = true;
      this.msePlay();
      const remove = () => {
        utterance.buffer?.removeEventListener("updateend", remove);
        utterance.queued.shift();
        this.mseAppend(utterance);
      };
      utterance.buffer.addEventListener("updateend", remove, { once: true });
    } catch (error) {
      this.mseFail(utterance, error);
    }
  }

  private mseFail(utterance: MseUtterance, error: unknown): void {
    if (utterance.failed) return;
    utterance.failed = true;
    const player = this.player;
    if (this.mseActive === utterance) {
      this.playing = false;
      this.notifyPlaybackChange();
      if (utterance.endedHandler)
        player.removeEventListener("ended", utterance.endedHandler);
      player.pause();
      player.removeAttribute("src");
      player.load();
      if (utterance.url) URL.revokeObjectURL(utterance.url);
      utterance.url = null;
    }
    this.options.onStatus(
      "Streaming audio failed; using the complete replay (" +
        errorName(error) +
        ").",
      true,
    );
    this.mseEnabled = false;
    if (utterance.done && this.mseActive === utterance) {
      this.queueMseFallback(utterance);
      this.mseActive = null;
      if (!this.playing && !this.playbackOwner) this.playNext();
    }
    this.notifyPlaybackChange();
  }

  private mseOpen(utterance: MseUtterance): void {
    if (utterance.failed || !utterance.media) return;
    try {
      utterance.buffer = utterance.media.addSourceBuffer(utterance.mime);
      utterance.buffer.addEventListener("error", () =>
        this.mseFail(utterance, new Error("MediaSource append error")),
      );
      this.player.src = utterance.url || "";
      this.mseAppend(utterance);
    } catch (error) {
      this.mseFail(utterance, error);
    }
  }

  private mseStartNext(): void {
    if (!this.mseEnabled || this.mseActive || !this.mseQueue.length) return;
    const utterance = this.mseQueue.shift()!;
    const player = this.player;
    this.mseActive = utterance;
    utterance.media = new MediaSource();
    utterance.url = URL.createObjectURL(utterance.media);
    utterance.endedHandler = () => {
      if (this.mseActive !== utterance) return;
      player.removeEventListener("ended", utterance.endedHandler!);
      this.mseActive = null;
      this.playing = false;
      this.notifyPlaybackChange();
      if (utterance.url) URL.revokeObjectURL(utterance.url);
      this.mseStartNext();
      this.notifyPlaybackChange();
    };
    player.addEventListener("ended", utterance.endedHandler);
    utterance.media.addEventListener(
      "sourceopen",
      () => this.mseOpen(utterance),
      { once: true },
    );
    if (utterance.media.readyState === "open") this.mseOpen(utterance);
  }

  private clearMsePlayback(): void {
    const player = this.player;
    for (const utterance of [this.mseActive, ...this.mseQueue].filter(
      Boolean,
    ) as MseUtterance[]) {
      if (utterance.endedHandler)
        player.removeEventListener("ended", utterance.endedHandler);
      if (utterance.url) URL.revokeObjectURL(utterance.url);
    }
    this.mseActive = null;
    this.mseQueue = [];
    this.msePending = null;
    this.mseReplayBytes = 0;
    this.playing = false;
    this.notifyPlaybackChange();
    player.pause();
    player.removeAttribute("src");
    player.load();
    this.notifyPlaybackChange();
  }
}

function mseRuntimeSupported(): boolean {
  return (
    typeof MediaSource !== "undefined" &&
    MediaSource.isTypeSupported("audio/mpeg")
  );
}

// Plays the agent's spoken replies.
//
// Replies arrive as `audio_start`, binary chunks, and `audio_done`. When the
// backend and browser agree on streaming MP3, each utterance plays through its
// own MediaSource as it arrives; otherwise (or when streaming fails) the
// complete utterance is replayed from a Blob. One element plays one clip at a
// time, and every event handler is bound to the clip that installed it, so a
// late event from a replaced clip can never advance or requeue the new one.

import type { AudioDoneMessage, AudioStartMessage } from "../protocol";
import { errorName, mediaErrorName } from "./errors";
import {
  createEnvelopeDecoder,
  decodeEnvelope,
  EnvelopeMeter,
  StreamingEnvelope,
  type EnvelopeDecoder,
} from "./speechEnvelope";

export const MAX_AUDIO_UTTERANCE = 32 * 1024 * 1024;
export const MAX_AUDIO_REPLAY = 64 * 1024 * 1024;
/**
 * The pause between two spoken messages. It is off (0): messages play back to
 * back. The gap code stays in place; set this to a positive value (350 was the
 * previous setting) to pause between messages again. Speech inside one message
 * always keeps the voice's own timing.
 */
export const INTER_UTTERANCE_GAP_MS = 0;
/**
 * How long a clip the element accepted has to produce sound. `play()` can
 * resolve on an element that never advances -- the usual WebKit outcome for a
 * MediaSource it cannot play -- and nothing noticed: the call went on
 * "speaking" in silence for the rest of its life (#189).
 */
export const NO_PROGRESS_MS = 3000;

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
  /** This utterance's level, decoded from its chunks as they arrive. */
  envelope: StreamingEnvelope | null;
  endedHandler?: EventListener;
  errorHandler?: EventListener;
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
  /** The pause between two messages. Defaults to `INTER_UTTERANCE_GAP_MS`. */
  gapMs?: number;
  /**
   * How long an accepted clip has to advance `currentTime` before it is
   * called silent. Defaults to `NO_PROGRESS_MS`; 0 turns the watch off.
   */
  stallMs?: number;
  /** Receives the live output level without entering React state. */
  onAudioLevel?: (level: number) => void;
  /**
   * Called with an utterance's `sequence` when its turn to play comes, or
   * when it is dropped and will never play. The caption follows this, so a
   * line is shown when its audio starts rather than when it arrives (#112).
   * It may be called more than once for one utterance (a replay after a
   * blocked autoplay, a streaming fallback).
   */
  onUtterance?: (sequence: number) => void;
}

export class AudioPlayback {
  readonly player: HTMLAudioElement;
  /** Complete utterances waiting for the element, oldest first. */
  readonly audioQueue: Blob[] = [];
  /** The utterance each complete replay voices. */
  private readonly replaySequences = new WeakMap<Blob, number>();
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
  /** The pause before the next message; nothing starts while it runs. */
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  /** Watches an accepted clip for sound; see `NO_PROGRESS_MS`. */
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The one reader of the agent's playback level, in every engine (#194):
   * the utterance's own bytes, decoded off to the side, read at the
   * element's `currentTime`. The element is never routed through Web Audio,
   * so no engine has to be asked whether it survives that (#189).
   */
  private envelopeDecoder: EnvelopeDecoder | null = null;
  private envelopeMeter: EnvelopeMeter | null = null;
  private envelopeToken = 0;
  private envelopeDecoderAttempted = false;

  constructor(options: AudioPlaybackOptions) {
    this.options = options;
    this.player = options.player ?? new Audio();
  }

  /** Run `next` after the pause between messages. */
  private afterGap(next: () => void): void {
    const gap = this.options.gapMs ?? INTER_UTTERANCE_GAP_MS;
    this.clearGap();
    if (gap <= 0) {
      next();
      return;
    }
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      next();
      this.notifyPlaybackChange();
    }, gap);
  }

  /**
   * Calls `onStall` if the element has not advanced by the time the watch
   * runs out. A clip that did advance has proved itself and is not watched
   * again: a stall after sound was heard ends in `ended` or `error`.
   */
  private watchProgress(onStall: () => void): void {
    this.clearProgressWatch();
    const player = this.player;
    const ms = this.options.stallMs ?? NO_PROGRESS_MS;
    if (ms <= 0) return;
    const startedAt = Number.isFinite(player.currentTime)
      ? player.currentTime
      : 0;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      const now = Number.isFinite(player.currentTime) ? player.currentTime : 0;
      if (now <= startedAt) onStall();
    }, ms);
  }

  private clearProgressWatch(): void {
    if (this.progressTimer !== null) clearTimeout(this.progressTimer);
    this.progressTimer = null;
  }

  /** The text a silent clip is reported with. */
  private silentText(): string {
    const ms = this.options.stallMs ?? NO_PROGRESS_MS;
    return (
      "Audio started but produced no sound (nothing played in " + ms + "ms)."
    );
  }

  private clearGap(): void {
    if (this.gapTimer !== null) clearTimeout(this.gapTimer);
    this.gapTimer = null;
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
      this.msePending === null &&
      this.gapTimer === null
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
    this.clearGap();
    this.audioEpoch = generation;
    this.audioQueue.length = 0;
    this.clearMsePlayback();
    if (this.playbackOwner) this.cleanupOwner(this.playbackOwner);
    this.playing = false;
  }

  /**
   * Moves to `generation` on a handoff (a transfer this tab saw adopted, or a
   * return to the operator): the goodbye already here keeps playing, and the
   * new leg's audio queues behind it. A clip from another leg that is still
   * arriving could never finish, so that case retires everything instead.
   */
  handOffToGeneration(generation: number): void {
    if (this.msePending && this.msePending.generation !== generation) {
      this.resetForGeneration(generation);
      return;
    }
    this.audioEpoch = generation;
  }

  /** Stops playback for good; used when the runtime is torn down. */
  dispose(): void {
    this.clearGap();
    this.clearProgressWatch();
    this.audioQueue.length = 0;
    this.clearMsePlayback();
    if (this.playbackOwner) this.cleanupOwner(this.playbackOwner);
    this.stopEnvelopeMeter();
    this.playing = false;
  }

  // The status message promises that a page interaction resumes blocked
  // audio. This is that gesture path, so blocked audio does not wait for a
  // later clip to arrive.
  handleGesture(target?: EventTarget | null): void {
    if (target === this.player || this.gapTimer !== null) return;
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

  /**
   * The decoder the level is read through, made once. `null` on a browser
   * with no `OfflineAudioContext`: that is a flat level, which is what a
   * caller with no level should see.
   */
  private meterDecoder(): EnvelopeDecoder | null {
    if (!this.options.onAudioLevel) return null;
    if (!this.envelopeDecoderAttempted) {
      this.envelopeDecoderAttempted = true;
      this.envelopeDecoder = createEnvelopeDecoder();
    }
    return this.envelopeDecoder;
  }

  /** Decodes the clip aside and meters the element against its envelope. */
  private startEnvelopeMeter(blob: Blob): void {
    const onLevel = this.options.onAudioLevel;
    const decoder = this.meterDecoder();
    if (!onLevel || !decoder) return;
    const token = ++this.envelopeToken;
    void blob
      .arrayBuffer()
      .then((bytes) => decodeEnvelope(bytes, decoder))
      .then((envelope) => {
        if (!envelope || this.envelopeToken !== token) return;
        const meter = new EnvelopeMeter(this.player, envelope, onLevel);
        this.envelopeMeter = meter;
        if (this.playing) meter.start();
      })
      .catch(() => undefined);
  }

  /** The timeline a streamed utterance's chunks are decoded into. */
  private newStreamEnvelope(): StreamingEnvelope | null {
    const decoder = this.meterDecoder();
    return decoder ? new StreamingEnvelope(decoder) : null;
  }

  /** Meters a stream against the envelope its chunks are decoded into. */
  private startStreamEnvelopeMeter(utterance: MseUtterance): void {
    const onLevel = this.options.onAudioLevel;
    if (!onLevel || !utterance.envelope) return;
    this.envelopeToken += 1;
    this.envelopeMeter = new EnvelopeMeter(
      this.player,
      utterance.envelope,
      onLevel,
    );
  }

  private startMeter(): void {
    this.envelopeMeter?.start();
  }

  private stopMeter(): void {
    this.envelopeMeter?.stop();
  }

  private stopEnvelopeMeter(): void {
    this.envelopeToken += 1;
    this.envelopeMeter?.stop();
    this.envelopeMeter = null;
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
    this.startEnvelopeMeter(blob);
    const sequence = this.replaySequences.get(blob);
    if (sequence !== undefined) this.options.onUtterance?.(sequence);
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
      this.clearProgressWatch();
      this.stopMeter();
      owner.awaitingEnded = owner.seeked && this.terminalSeek();
      this.playing = false;
      this.notifyPlaybackChange();
      this.options.onStatus(
        owner.awaitingEnded
          ? "Audio finishing — tap or click anywhere on this page to continue."
          : "Audio paused — tap or click anywhere on this page to resume.",
      );
    };
    const error: EventListener = () => {
      if (this.playbackOwner !== owner || owner.consumed || !player.error)
        return;
      // The element refused the clip. Say so: a browser that cannot decode
      // what was sent used to drop every utterance in silence, with nothing
      // on screen for the caller to report (#189).
      this.options.onStatus(
        "Audio failed to play (" + mediaErrorName(player.error) + ").",
        true,
      );
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
    if (typeof generation !== "number" || typeof sequence !== "number") return;
    if (generation !== this.audioEpoch) {
      // Audio from a leg the call has left never plays.
      this.options.onUtterance?.(sequence);
      return;
    }
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
      // A stream's level is its own chunks, decoded as they arrive; a
      // replay's is the whole blob (`startEnvelopeMeter`).
      envelope: this.mseEnabled ? this.newStreamEnvelope() : null,
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
    utterance.envelope?.append(data);
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
      if (!this.playing && !this.playbackOwner && this.gapTimer === null)
        this.playNext();
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
    this.clearProgressWatch();
    this.stopEnvelopeMeter();
    if (this.playbackOwner === owner) this.playbackOwner = null;
    owner.pendingAttempt = null;
    for (const [name, handler] of owner.handlers) {
      player.removeEventListener(name, handler);
    }
    owner.handlers = [];
    this.stopMeter();
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
    if (this.audioQueue.length === 0) {
      this.playNext();
      return;
    }
    this.afterGap(() => {
      if (!this.playing && !this.playbackOwner) this.playNext();
    });
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
      "Audio blocked by the browser — tap or click anywhere on this page once, then it will play (" +
        errorName(error) +
        ").",
      true,
    );
  }

  /** The element took the clip, started, and played nothing. */
  private replayStalled(owner: PlaybackOwner): void {
    if (this.playbackOwner !== owner || owner.consumed) return;
    this.options.onStatus(this.silentText(), true);
    this.consumeOwner(owner);
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
    this.startMeter();
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
        if (this.playing)
          this.watchProgress(() => this.replayStalled(owner));
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
      this.options.onUtterance?.(utterance.sequence);
      return;
    }
    const replay = new Blob(utterance.parts, { type: utterance.mime });
    this.replaySequences.set(replay, utterance.sequence);
    this.audioQueue.push(replay);
    this.notifyPlaybackChange();
  }

  private msePlay(): void {
    if (!this.mseActive || this.mseActive.failed || this.playing) return;
    const utterance = this.mseActive;
    this.startMeter();
    this.playing = true;
    this.notifyPlaybackChange();
    Promise.resolve(this.player.play()).then(
      () => {
        if (this.mseActive !== utterance || utterance.failed) return;
        // The element accepted the stream. If it never advances, this is a
        // MediaSource it cannot play: say so and use the whole replay (#189).
        this.watchProgress(() =>
          this.mseFail(utterance, new Error("no playback progress")),
        );
      },
      (error) => {
        this.stopMeter();
        this.playing = false;
        this.notifyPlaybackChange();
        this.options.onStatus(
          "Audio blocked by the browser — tap or click anywhere on this page once, then it will play (" +
            errorName(error) +
            ").",
          true,
        );
      },
    );
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
      this.clearProgressWatch();
      this.stopEnvelopeMeter();
      this.playing = false;
      this.notifyPlaybackChange();
      this.mseDetach(utterance);
      player.pause();
      player.removeAttribute("src");
      player.load();
      if (utterance.url) URL.revokeObjectURL(utterance.url);
      utterance.url = null;
    }
    this.options.onStatus(
      "Streaming audio failed; using the complete replay (" +
        mediaErrorName(error) +
        ").",
      true,
    );
    this.mseEnabled = false;
    if (utterance.done && this.mseActive === utterance) {
      this.queueMseFallback(utterance);
      this.mseActive = null;
      if (!this.playing && !this.playbackOwner && this.gapTimer === null)
        this.playNext();
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
    if (
      !this.mseEnabled ||
      this.mseActive ||
      !this.mseQueue.length ||
      this.gapTimer !== null
    )
      return;
    const utterance = this.mseQueue.shift()!;
    const player = this.player;
    this.mseActive = utterance;
    this.startStreamEnvelopeMeter(utterance);
    this.options.onUtterance?.(utterance.sequence);
    utterance.media = new MediaSource();
    utterance.url = URL.createObjectURL(utterance.media);
    utterance.endedHandler = () => {
      if (this.mseActive !== utterance) return;
      this.mseDetach(utterance);
      this.mseActive = null;
      this.stopEnvelopeMeter();
      this.playing = false;
      this.notifyPlaybackChange();
      if (utterance.url) URL.revokeObjectURL(utterance.url);
      if (this.mseQueue.length) this.afterGap(() => this.mseStartNext());
      this.notifyPlaybackChange();
    };
    player.addEventListener("ended", utterance.endedHandler);
    // The element can refuse what was appended -- a SourceBuffer WebKit
    // cannot parse sets a MediaError and stops. Without this the clip stayed
    // "playing" for the rest of the call: no sound, no fallback, no message
    // (#189).
    utterance.errorHandler = () => {
      if (this.mseActive !== utterance || !player.error) return;
      this.mseFail(utterance, player.error);
    };
    player.addEventListener("error", utterance.errorHandler);
    utterance.media.addEventListener(
      "sourceopen",
      () => this.mseOpen(utterance),
      { once: true },
    );
    if (utterance.media.readyState === "open") this.mseOpen(utterance);
  }

  /** Takes an utterance's element handlers back off the element. */
  private mseDetach(utterance: MseUtterance): void {
    if (utterance.endedHandler)
      this.player.removeEventListener("ended", utterance.endedHandler);
    if (utterance.errorHandler)
      this.player.removeEventListener("error", utterance.errorHandler);
  }

  private clearMsePlayback(): void {
    this.clearGap();
    this.clearProgressWatch();
    const player = this.player;
    for (const utterance of [this.mseActive, ...this.mseQueue].filter(
      Boolean,
    ) as MseUtterance[]) {
      this.mseDetach(utterance);
      if (utterance.url) URL.revokeObjectURL(utterance.url);
    }
    this.mseActive = null;
    this.mseQueue = [];
    this.msePending = null;
    this.mseReplayBytes = 0;
    this.stopEnvelopeMeter();
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

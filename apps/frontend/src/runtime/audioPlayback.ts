// Plays the agent's spoken replies.
//
// Replies arrive as `audio_start`, binary chunks, and `audio_done`. When the
// backend and browser agree on streaming MP3, each utterance plays through its
// own MediaSource as it arrives (`mseStream.ts`); otherwise (or when streaming
// fails) the complete utterance is replayed from a Blob.
//
// One element plays one clip at a time, and who holds it is one value,
// `holder`, written in one place (`enter`): nothing, the pause between
// messages, a whole replay, a stream, or a stream cut off while its bytes are
// still arriving. Leaving a clip takes everything it put on the element back
// off. Every event handler, timer and `play()` callback names the clip it
// belongs to, and does nothing once that clip no longer holds the element, so
// a late event from a replaced clip can never advance or requeue the new one.

import type { AudioDoneMessage, AudioStartMessage } from "../protocol";
import { MseSource, mseRuntimeSupported } from "./mseStream";
import { PlaybackLevel } from "./playbackLevel";
import { PlaybackStatus } from "./playbackStatus";
import { ProgressWatch } from "./progressWatch";
import type { EnvelopeMeter, StreamingEnvelope } from "./speechEnvelope";

export const MAX_AUDIO_UTTERANCE = 32 * 1024 * 1024;
/**
 * The most audio held at once for whole replays: every utterance arriving,
 * streaming or waiting, and every replay queued or on the element. What has
 * played is no longer held, so a long leg never reaches it (#431).
 */
export const MAX_AUDIO_REPLAY = 64 * 1024 * 1024;
/**
 * The pause between two spoken messages. It is off (0): messages play back to
 * back. The gap code stays in place; set this to a positive value (350 was the
 * previous setting) to pause between messages again. Speech inside one message
 * always keeps the voice's own timing.
 */
export const INTER_UTTERANCE_GAP_MS = 0;
/**
 * How long a sounding clip may go without its `currentTime` moving. `play()`
 * can resolve on an element that never advances -- the usual WebKit outcome
 * for a MediaSource it cannot play -- and nothing noticed: the call went on
 * "speaking" in silence for the rest of its life (#189). A clip that did
 * advance can stop partway just as quietly (a gap the engine will not play
 * across, an audio session that took the output away), so the watch runs for
 * the whole clip, not only its start (#213).
 */
export const NO_PROGRESS_MS = 3000;
/**
 * How close to its duration a clip that stopped advancing counts as played
 * out: one whose `ended` never came is finished, not stalled.
 */
const END_SLACK_S = 0.25;

/**
 * Whether utterances stream. `off` until the backend and this browser agree
 * (`hello_ack`), `on` while they do, and `refused` once this browser has
 * taken a stream it could not sound. The engine does not change mid-call, so
 * neither does the answer: later utterances go straight to the whole replay,
 * and a reconnect's `hello_ack` cannot offer streaming again. Otherwise every
 * utterance pays `NO_PROGRESS_MS` and the caller reads the same failure over
 * and over (#203). Written only by `setMode`.
 */
type StreamingMode = "off" | "on" | "refused";

/** An utterance, from its `audio_start` to its `audio_done`. */
interface Utterance {
  readonly generation: number;
  readonly sequence: number;
  readonly mime: string;
  /** Every byte that arrived, kept for the whole replay. */
  readonly parts: Blob[];
  bytes: number;
  /** Its `audio_done` came and said it is complete. */
  done: boolean;
  /** Its MediaSource while it streams; `null` once it goes whole. */
  stream: MseSource | null;
  /** Its failure was reported (`streamFailed` says it once). */
  failed: boolean;
  fallbackQueued: boolean;
  /** This utterance's level, decoded from its chunks as they arrive. */
  readonly envelope: StreamingEnvelope | null;
}

type ElementHandlers = Array<[string, EventListener]>;

/** A whole replay on the element. */
interface ReplayClip {
  readonly blob: Blob;
  readonly url: string;
  handlers: ElementHandlers;
  /** The element seeked since the last `play()`; see `atEnd`. */
  seeked: boolean;
  /** Its level, once its blob is decoded (`meterReplay`). */
  meter: EnvelopeMeter | null;
}

/** A stream on the element. */
interface StreamClip {
  readonly utterance: Utterance;
  readonly source: MseSource;
  readonly meter: EnvelopeMeter | null;
  handlers: ElementHandlers;
}

/** One `play()` call; its settling is dropped once another call follows. */
type PlayAttempt = symbol;

type ReplayPhase =
  /** Its source is being set; nothing has been asked of the element yet. */
  | { kind: "attaching" }
  /** `play()` was called and has not settled. */
  | { kind: "starting"; attempt: PlayAttempt; watch: ProgressWatch }
  | { kind: "playing"; watch: ProgressWatch }
  /**
   * Something outside the page paused it. `attempt` is a `play()` that has
   * not settled yet. `atEnd`: paused at its end after a seek, so its `ended`
   * is due and a tap does not start it again.
   */
  | { kind: "paused"; attempt: PlayAttempt | null; atEnd: boolean };

type StreamPhase =
  /** Its source is being set on the element. */
  | { kind: "attaching" }
  /** Attached: waiting for the source to open and the first bytes. */
  | { kind: "opening"; watch: ProgressWatch }
  | { kind: "playing"; watch: ProgressWatch }
  /** Something outside the page paused it: the next tap or append plays it. */
  | { kind: "paused" }
  /** `play()` was refused: the next tap or append plays it. */
  | { kind: "blocked" };

/** Who holds the element. */
type Holder =
  | { kind: "idle" }
  /** The pause between two messages; nothing starts while it runs. */
  | { kind: "gap"; timer: ReturnType<typeof setTimeout> }
  | { kind: "replay"; clip: ReplayClip; phase: ReplayPhase }
  | { kind: "stream"; clip: StreamClip; phase: StreamPhase }
  /**
   * A stream taken off the element while its bytes were still arriving. The
   * element is free, but nothing plays before its whole replay, which is
   * queued when its `audio_done` comes.
   */
  | { kind: "cutOff"; utterance: Utterance };

/**
 * What leaving a clip does to the element: take its source off (`unload`),
 * or leave it there for the next clip's `src` to replace (a stream that
 * played to its end; a reset, which unloads once itself).
 */
type Exit = "unload" | "keep source";

export interface AudioPlaybackOptions {
  /** The element replies play through. Defaults to a detached `new Audio()`. */
  player?: HTMLAudioElement;
  /** The status shown once nothing is left to play. */
  idleText: string;
  /** Every status says whether it is an error (`CallRuntime.setStatus`). */
  onStatus: (text: string, error: boolean) => void;
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
  /**
   * Complete utterances waiting for the element, oldest first. Every one is
   * older than every stream in `streamQueue`, so they go first.
   */
  readonly audioQueue: Blob[] = [];
  /** The utterance each complete replay voices. */
  private readonly replaySequences = new WeakMap<Blob, number>();
  private readonly options: AudioPlaybackOptions;
  /** Who holds the element; written only by `enter`. */
  private holder: Holder = { kind: "idle" };
  private mode: StreamingMode = "off";
  /** Streams waiting for the element, oldest first. */
  private streamQueue: Utterance[] = [];
  /** The utterance whose bytes are arriving now. */
  private arriving: Utterance | null = null;
  /** The leg whose audio plays; audio stamped with another is ignored. */
  private generation = 0;
  private readonly level: PlaybackLevel;
  private readonly status: PlaybackStatus;

  constructor(options: AudioPlaybackOptions) {
    this.options = options;
    this.player = options.player ?? new Audio();
    this.level = new PlaybackLevel(this.player, options.onAudioLevel);
    this.status = new PlaybackStatus(options.idleText, options.onStatus);
  }

  get isPlaying(): boolean {
    return sounding(this.holder);
  }

  get streamingEnabled(): boolean {
    return this.mode === "on";
  }

  /** True when nothing is playing and nothing is waiting to play. */
  isDrained(): boolean {
    return (
      this.holder.kind === "idle" &&
      this.audioQueue.length === 0 &&
      this.streamQueue.length === 0 &&
      this.arriving === null
    );
  }

  /** Streams MP3 through MediaSource when the backend and this browser agree. */
  setStreamingEnabled(requested: boolean): void {
    const enabled =
      requested && this.mode !== "refused" && mseRuntimeSupported();
    // A repeat of what is already set retires nothing: every reconnect's
    // `hello_ack` arrives here, and clearing would cut the clip playing.
    if (enabled === (this.mode === "on")) return;
    this.setMode(enabled ? "on" : "off");
  }

  /**
   * Retires everything queued or playing from the previous leg. Audio stamped
   * with an older generation is ignored from here on.
   */
  resetForGeneration(generation: number): void {
    this.generation = generation;
    this.status.newLeg();
    this.retire();
  }

  /**
   * Moves to `generation` on a handoff (a transfer this tab saw adopted, or a
   * return to the operator): the goodbye already here keeps playing, and the
   * new leg's audio queues behind it. A clip from another leg that is still
   * arriving could never finish, so that case retires everything instead.
   */
  handOffToGeneration(generation: number): void {
    if (this.arriving && this.arriving.generation !== generation) {
      this.resetForGeneration(generation);
      return;
    }
    this.generation = generation;
  }

  /** Stops playback for good; used when the runtime is torn down. */
  dispose(): void {
    this.retire();
  }

  // The status message promises that a page interaction resumes blocked
  // audio. This is that gesture path, so blocked audio does not wait for a
  // later clip to arrive.
  handleGesture(target?: EventTarget | null): void {
    if (target === this.player) return;
    const holder = this.holder;
    switch (holder.kind) {
      case "idle":
        if (this.audioQueue.length) this.startReplay();
        return;
      case "gap":
      case "cutOff":
        return;
      case "replay": {
        const phase = holder.phase;
        if (phase.kind === "paused" && phase.attempt === null && !phase.atEnd)
          this.attemptPlay(holder.clip);
        return;
      }
      case "stream":
        // A stream that still holds the element keeps it, whether or not it
        // is sounding: the replays behind it wait for its end.
        this.playStream(holder.clip);
        return;
      default:
        unreachable(holder);
    }
  }

  /**
   * Starts the head of `audioQueue` now, in place of whatever holds the
   * element. The tests put their blobs on the element through here.
   */
  playNext(): void {
    this.enter({ kind: "idle" });
    if (this.audioQueue.length) this.startReplay();
    else this.status.idle();
  }

  receiveAudioStart(
    message: Pick<AudioStartMessage, "generation" | "sequence" | "mime">,
  ): void {
    const generation = message.generation;
    const sequence = message.sequence;
    if (typeof generation !== "number" || typeof sequence !== "number") return;
    if (generation !== this.generation) {
      // Audio from a leg the call has left never plays.
      this.options.onUtterance?.(sequence);
      return;
    }
    const mime = message.mime === "audio/mpeg" ? message.mime : "audio/mpeg";
    const streaming = this.mode === "on";
    const utterance: Utterance = {
      generation,
      sequence,
      mime,
      parts: [],
      bytes: 0,
      done: false,
      stream: null,
      failed: false,
      fallbackQueued: false,
      // A stream's level is its own chunks, decoded as they arrive; a
      // replay's is the whole blob (`meterReplay`).
      envelope: streaming ? this.level.streamEnvelope() : null,
    };
    if (streaming)
      utterance.stream = new MseSource(mime, {
        appended: () => this.streamAppended(utterance),
        failed: (error) => this.streamFailed(utterance, error),
      });
    this.arriving = utterance;
    if (streaming) {
      this.streamQueue.push(utterance);
      this.startNext();
    }
    this.notifyPlaybackChange();
  }

  receiveAudioChunk(data: ArrayBuffer): void {
    const utterance = this.arriving;
    if (!utterance || utterance.generation !== this.generation) return;
    if (
      utterance.bytes + data.byteLength > MAX_AUDIO_UTTERANCE ||
      this.heldBytes() + data.byteLength > MAX_AUDIO_REPLAY
    ) {
      this.streamFailed(utterance, new Error("audio replay limit"));
      return;
    }
    utterance.bytes += data.byteLength;
    utterance.parts.push(new Blob([data], { type: utterance.mime }));
    utterance.envelope?.append(data);
    utterance.stream?.receive(data);
    this.notifyPlaybackChange();
  }

  receiveAudioDone(
    message: Pick<AudioDoneMessage, "generation" | "sequence" | "done">,
  ): void {
    if (
      message.generation !== this.generation ||
      typeof message.sequence !== "number"
    )
      return;
    const utterance = this.arriving;
    if (!utterance || utterance.sequence !== message.sequence) return;
    utterance.done = message.done === true;
    this.arriving = null;
    if (utterance.stream) utterance.stream.finish(utterance.done);
    else {
      this.queueReplay(utterance);
      const holder = this.holder;
      if (holder.kind === "cutOff" && holder.utterance === utterance)
        this.enter({ kind: "idle" });
      this.startNext();
    }
    this.notifyPlaybackChange();
  }

  // --- The holder -------------------------------------------------------

  /**
   * The one writer of `holder`. Moving to another clip, or to none, takes
   * everything the old holder put on the element back off (`release`).
   * Within one clip, a progress watch the next phase does not carry is
   * stopped, and the level meter runs exactly while the clip is sounding.
   */
  private enter(next: Holder, exit: Exit = "unload"): void {
    const previous = this.holder;
    this.holder = next;
    const watch = watchOf(previous);
    if (watch && watch !== watchOf(next)) watch.cancel();
    const sameOccupant = occupant(previous) === occupant(next);
    if (!sameOccupant) this.release(previous, exit);
    else if (sounding(previous) && !sounding(next)) meterOf(next)?.stop();
    if (sounding(next) && !(sameOccupant && sounding(previous)))
      meterOf(next)?.start();
    this.notifyPlaybackChange();
  }

  /** Takes what `holder` put on the element back off. */
  private release(holder: Holder, exit: Exit): void {
    switch (holder.kind) {
      case "idle":
      case "cutOff":
        return;
      case "gap":
        clearTimeout(holder.timer);
        return;
      case "replay":
        this.detach(holder.clip.handlers);
        holder.clip.meter?.stop();
        if (exit === "unload") this.unloadElement();
        URL.revokeObjectURL(holder.clip.url);
        return;
      case "stream":
        this.detach(holder.clip.handlers);
        holder.clip.meter?.stop();
        if (exit === "unload") this.unloadElement();
        holder.clip.source.release();
        return;
      default:
        unreachable(holder);
    }
  }

  private detach(handlers: ElementHandlers): void {
    for (const [name, handler] of handlers)
      this.player.removeEventListener(name, handler);
  }

  private attach(handlers: ElementHandlers): void {
    for (const [name, handler] of handlers)
      this.player.addEventListener(name, handler);
  }

  private unloadElement(): void {
    const player = this.player;
    player.pause();
    player.removeAttribute("src");
    player.load();
  }

  /**
   * Starts what waits for the element, if nothing holds it: the oldest whole
   * replay, or else the next stream.
   */
  private startNext(): void {
    if (this.holder.kind !== "idle") return;
    if (this.audioQueue.length) this.startReplay();
    else if (this.mode === "on" && this.streamQueue.length) this.startStream();
  }

  /**
   * A clip played to its end, failed, or went silent, and the element is
   * free: what waits follows after the pause between messages. When nothing
   * waits, the idle line, so no error the clip reported outlives it (#260).
   */
  private afterClip(): void {
    if (!this.audioQueue.length && !this.streamQueue.length) {
      this.status.idle();
      return;
    }
    const gap = this.options.gapMs ?? INTER_UTTERANCE_GAP_MS;
    if (gap <= 0) {
      this.startNext();
      return;
    }
    const timer = setTimeout(() => this.gapElapsed(timer), gap);
    this.enter({ kind: "gap", timer });
  }

  private gapElapsed(timer: ReturnType<typeof setTimeout>): void {
    const holder = this.holder;
    if (holder.kind !== "gap" || holder.timer !== timer) return;
    this.enter({ kind: "idle" });
    this.startNext();
  }

  /** Everything queued, arriving or playing is dropped. */
  private retire(): void {
    this.audioQueue.length = 0;
    this.streamQueue = [];
    this.arriving = null;
    // One unload, whatever held the element: a stream that played out left
    // its source there.
    this.enter({ kind: "idle" }, "keep source");
    this.unloadElement();
    this.notifyPlaybackChange();
  }

  // --- Whole replays ----------------------------------------------------

  /** The head of `audioQueue` takes the element. */
  private startReplay(): void {
    const blob = this.audioQueue.shift();
    if (!blob) return;
    const player = this.player;
    const clip: ReplayClip = {
      blob,
      url: URL.createObjectURL(blob),
      handlers: [],
      seeked: false,
      meter: null,
    };
    this.enter({ kind: "replay", clip, phase: { kind: "attaching" } });
    this.meterReplay(clip);
    const sequence = this.replaySequences.get(blob);
    if (sequence !== undefined) this.options.onUtterance?.(sequence);
    const resetTerminal = () => {
      const phase = this.replayPhase(clip);
      if (
        !phase ||
        (Number.isFinite(player.duration) &&
          Number.isFinite(player.currentTime) &&
          player.currentTime >= player.duration)
      )
        return;
      clip.seeked = false;
      if (phase.kind === "paused" && phase.atEnd)
        this.enter({
          kind: "replay",
          clip,
          phase: { ...phase, atEnd: false },
        });
    };
    clip.handlers = [
      ["ended", () => this.replayEnded(clip)],
      ["pause", () => this.replayPaused(clip)],
      ["error", () => this.replayError(clip)],
      [
        "seeking",
        () => {
          clip.seeked = true;
          resetTerminal();
        },
      ],
      ["seeked", resetTerminal],
      ["timeupdate", resetTerminal],
    ];
    this.attach(clip.handlers);
    player.src = clip.url;
    this.attemptPlay(clip);
  }

  private replayPhase(clip: ReplayClip): ReplayPhase | null {
    const holder = this.holder;
    return holder.kind === "replay" && holder.clip === clip
      ? holder.phase
      : null;
  }

  private attemptPlay(clip: ReplayClip): void {
    if (!this.replayPhase(clip)) return;
    clip.seeked = false;
    const attempt: PlayAttempt = Symbol("play");
    // Armed on the attempt, for the same reason as the stream's: a `play()`
    // that never settles is a clip that produced no sound, and the caller
    // has to be told about it either way (#203).
    const watch = this.watchProgress((heard) =>
      this.replayStalled(clip, heard),
    );
    this.enter({
      kind: "replay",
      clip,
      phase: { kind: "starting", attempt, watch },
    });
    let result: Promise<void>;
    try {
      result = this.player.play();
    } catch (error) {
      this.replayRefused(clip, attempt, error);
      return;
    }
    Promise.resolve(result).then(
      () => this.replayStarted(clip, attempt),
      (error) => this.replayRefused(clip, attempt, error),
    );
  }

  private replayStarted(clip: ReplayClip, attempt: PlayAttempt): void {
    const phase = this.replayPhase(clip);
    if (phase?.kind === "starting" && phase.attempt === attempt) {
      this.enter({
        kind: "replay",
        clip,
        phase: { kind: "playing", watch: phase.watch },
      });
      this.status.resumed();
    } else if (phase?.kind === "paused" && phase.attempt === attempt)
      this.enter({
        kind: "replay",
        clip,
        phase: { ...phase, attempt: null },
      });
  }

  /**
   * Autoplay rejection is recoverable: the clip goes back to the front of the
   * queue, so the next user gesture retries it instead of silently losing it.
   */
  private replayRefused(
    clip: ReplayClip,
    attempt: PlayAttempt,
    error: unknown,
  ): void {
    const phase = this.replayPhase(clip);
    if (
      (phase?.kind !== "starting" && phase?.kind !== "paused") ||
      phase.attempt !== attempt
    )
      return;
    this.audioQueue.unshift(clip.blob);
    this.enter({ kind: "idle" });
    this.status.blocked(error);
  }

  private replayEnded(clip: ReplayClip): void {
    if (!this.replayPhase(clip) || this.player.ended === false) return;
    this.replayFinished(clip);
  }

  private replayPaused(clip: ReplayClip): void {
    const phase = this.replayPhase(clip);
    const player = this.player;
    if (!phase || player.ended || player.paused === false) return;
    const atEnd = clip.seeked && this.terminalSeek();
    this.enter({
      kind: "replay",
      clip,
      phase: { kind: "paused", attempt: attemptOf(phase), atEnd },
    });
    this.status.paused(atEnd);
  }

  private replayError(clip: ReplayClip): void {
    const player = this.player;
    if (!this.replayPhase(clip) || !player.error) return;
    this.status.refused(player.error);
    this.replayFinished(clip);
  }

  /**
   * The element stopped advancing: before any sound, or partway. A clip
   * standing at its end whose `ended` never came is simply over.
   */
  private replayStalled(clip: ReplayClip, heard: boolean): void {
    if (!this.replayPhase(clip)) return;
    if (!this.playedOut())
      this.status.silent(heard, this.options.stallMs ?? NO_PROGRESS_MS);
    this.replayFinished(clip);
  }

  private replayFinished(clip: ReplayClip): void {
    if (!this.replayPhase(clip)) return;
    this.enter({ kind: "idle" });
    this.afterClip();
  }

  // --- Streams ----------------------------------------------------------

  /** The head of `streamQueue` takes the element. */
  private startStream(): void {
    const utterance = this.streamQueue.shift();
    const source = utterance?.stream;
    if (!utterance || !source) return;
    const player = this.player;
    const clip: StreamClip = {
      utterance,
      source,
      meter: this.level.streamMeter(utterance.envelope),
      handlers: [],
    };
    this.enter({ kind: "stream", clip, phase: { kind: "attaching" } });
    this.options.onUtterance?.(utterance.sequence);
    const url = source.attach();
    // The element can refuse what was appended -- a SourceBuffer WebKit
    // cannot parse sets a MediaError and stops. Without this the clip stayed
    // "playing" for the rest of the call: no sound, no fallback, no message
    // (#189).
    const error: EventListener = () => {
      if (this.streamPhase(clip) && player.error)
        this.streamFailed(utterance, player.error);
    };
    // Something outside the page stopped the element partway (an iPad's
    // audio session taken for the microphone, a lock-screen control). It is
    // paused, not playing, and a tap resumes it, as with a replay; without
    // this the call stayed "speaking" over silence (#213). The `pause` a
    // clip fires as it reaches its end is not this.
    const pause: EventListener = () => {
      if (
        this.streamPhase(clip)?.kind !== "playing" ||
        player.ended ||
        player.paused === false
      )
        return;
      this.enter({ kind: "stream", clip, phase: { kind: "paused" } });
      this.status.paused(false);
    };
    clip.handlers = [
      ["ended", () => this.streamFinished(clip)],
      ["error", error],
      ["pause", pause],
    ];
    this.attach(clip.handlers);
    // Attaching the source is what opens it (`MseSource.attach`). The
    // element's `error` handler is already on, so an engine that refuses the
    // source says so and the whole replay follows.
    player.src = url;
    // An engine can also leave the source `closed` and set no error (WebKit
    // with a bare page, #203). Nothing appends then, so the stream's own
    // watch (`playStream`) never starts, and the call heard nothing with
    // nothing said (#259). This one holds once the source is open and
    // waiting for bytes; the first append replaces it with the stream's own.
    if (this.streamPhase(clip)?.kind !== "attaching") return;
    const watch = this.watchProgress(
      () => {
        if (this.streamPhase(clip)?.kind === "opening")
          this.streamFailed(utterance, new Error("MediaSource did not open"));
      },
      () => source.opened,
    );
    this.enter({ kind: "stream", clip, phase: { kind: "opening", watch } });
  }

  private streamPhase(clip: StreamClip): StreamPhase | null {
    const holder = this.holder;
    return holder.kind === "stream" && holder.clip === clip
      ? holder.phase
      : null;
  }

  /** An append went into `utterance`'s source: it plays, if it holds the element. */
  private streamAppended(utterance: Utterance): void {
    const holder = this.holder;
    if (holder.kind === "stream" && holder.clip.utterance === utterance)
      this.playStream(holder.clip);
  }

  /** The stream that holds the element plays: on an append, or a tap. */
  private playStream(clip: StreamClip): void {
    const phase = this.streamPhase(clip);
    if (!phase || phase.kind === "playing") return;
    const source = clip.source;
    // The watch is armed on the attempt, not on `play()` resolving: a
    // WebKit element given a MediaSource of MP3 buffers it, never reaches
    // `canplay`, and leaves `play()` pending for good -- no sound, no
    // rejection, nothing to notice (#203). It stays on until the stream ends:
    // one that stops partway and never resumes is the same failure, and used
    // to leave the call "speaking" with nothing sounding (#213). Either way
    // it says so and the whole replay follows. An append that landed since
    // the last look holds it: the element may be waiting for those bytes.
    source.takeFreshAppends();
    const watch = this.watchProgress(
      (heard) => this.streamStalled(clip, heard),
      () => source.takeFreshAppends(),
    );
    this.enter({ kind: "stream", clip, phase: { kind: "playing", watch } });
    Promise.resolve(this.player.play()).then(
      () => {
        if (this.streamPhase(clip)?.kind === "playing") this.status.resumed();
      },
      (error) => {
        // A rejection that arrives after this stream was replaced or failed
        // belongs to a clip that is already gone: falling back aborts the
        // pending `play()` itself when it reloads the element, and that
        // used to reach the caller as "Audio blocked by the browser" while
        // the whole replay was already playing (#203).
        if (!this.streamPhase(clip)) return;
        this.enter({ kind: "stream", clip, phase: { kind: "blocked" } });
        this.status.blocked(error);
      },
    );
  }

  /** The stream stopped advancing; see `watchProgress`. */
  private streamStalled(clip: StreamClip, heard: boolean): void {
    if (!this.streamPhase(clip)) return;
    // Every byte went in, the source was ended, and the element stands at
    // its end: the stream played out and `ended` never came.
    if (clip.source.ended && this.playedOut()) {
      this.streamFinished(clip);
      return;
    }
    this.streamFailed(
      clip.utterance,
      new Error(heard ? "playback stalled" : "no playback progress"),
    );
  }

  /** The stream played to its end; what waits follows. */
  private streamFinished(clip: StreamClip): void {
    if (!this.streamPhase(clip)) return;
    // Its finished source stays on the element until the next clip's `src`
    // replaces it, as it always has.
    this.enter({ kind: "idle" }, "keep source");
    this.afterClip();
  }

  private streamFailed(utterance: Utterance, error: unknown): void {
    if (utterance.failed) return;
    utterance.failed = true;
    this.status.streamFailed(error);
    this.setMode("refused", utterance);
  }

  /**
   * The one writer of `mode`. Every move to `off` or `refused` stops
   * streaming (`stopStreaming`); `failed` names the utterance whose failure
   * moved it.
   */
  private setMode(next: StreamingMode, failed: Utterance | null = null): void {
    this.mode = next;
    if (next !== "on") this.stopStreaming(failed);
  }

  /**
   * Streaming stops here, because `failed` could not be streamed or because
   * the service turned it off, and nothing it held is lost (#259): every
   * utterance goes on as a whole replay, in order. One that is complete is
   * queued now; one still arriving falls back on its `audio_done`. A
   * complete stream that did not fail plays out, and the replays follow it.
   * A replay that holds the element is left alone.
   */
  private stopStreaming(failed: Utterance | null): void {
    const holder = this.holder;
    if (holder.kind === "stream") {
      const utterance = holder.clip.utterance;
      if (utterance === failed || !utterance.done) {
        // Its bytes can no longer go in: take it off the element. Whatever
        // waits in the replay queue came after it.
        utterance.failed = true;
        utterance.stream = null;
        if (utterance.done) {
          this.queueReplay(utterance, true);
          this.enter({ kind: "idle" });
        } else this.enter({ kind: "cutOff", utterance });
      }
    }
    for (const utterance of this.streamQueue) {
      utterance.stream = null;
      if (utterance.done) this.queueReplay(utterance);
    }
    this.streamQueue = [];
    this.startNext();
    this.notifyPlaybackChange();
  }

  /**
   * Queues `utterance` as a whole replay. `first` is for the stream that
   * held the element: whatever waits in the replay queue came after it.
   */
  private queueReplay(utterance: Utterance, first = false): void {
    if (utterance.fallbackQueued) return;
    utterance.fallbackQueued = true;
    const replay = new Blob(utterance.parts, { type: utterance.mime });
    this.replaySequences.set(replay, utterance.sequence);
    if (first) this.audioQueue.unshift(replay);
    else this.audioQueue.push(replay);
    this.notifyPlaybackChange();
  }

  /**
   * The bytes held for whole replays now (`MAX_AUDIO_REPLAY`). It is read
   * from what the machine holds, not kept as a count: an utterance or a
   * replay that leaves the machine takes its bytes with it.
   */
  private heldBytes(): number {
    const utterances = new Set<Utterance>(this.streamQueue);
    if (this.arriving) utterances.add(this.arriving);
    const holder = this.holder;
    if (holder.kind === "stream") utterances.add(holder.clip.utterance);
    if (holder.kind === "cutOff") utterances.add(holder.utterance);
    let bytes = 0;
    for (const utterance of utterances) bytes += utterance.bytes;
    for (const replay of this.audioQueue) bytes += replay.size;
    if (holder.kind === "replay") bytes += holder.clip.blob.size;
    return bytes;
  }

  // --- Watch, level, status ---------------------------------------------

  /**
   * Watches the clip that holds the element for as long as it is meant to
   * be sounding; see `ProgressWatch`. The phase that carries it stops it on
   * the way out (`enter`).
   */
  private watchProgress(
    onStall: (heard: boolean) => void,
    stillArriving?: () => boolean,
  ): ProgressWatch {
    return new ProgressWatch(
      () => this.position(),
      this.options.stallMs ?? NO_PROGRESS_MS,
      onStall,
      stillArriving,
    );
  }

  private position(): number {
    const time = this.player.currentTime;
    return Number.isFinite(time) ? time : 0;
  }

  /** The element stands at the end of what it was given. */
  private playedOut(): boolean {
    const duration = this.player.duration;
    return (
      Number.isFinite(duration) &&
      duration > 0 &&
      this.position() >= duration - END_SLACK_S
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

  /** Meters the replay once its blob is decoded, if it still holds the element. */
  private meterReplay(clip: ReplayClip): void {
    this.level.meterReplay(clip.blob, (meter) => {
      const holder = this.holder;
      if (holder.kind !== "replay" || holder.clip !== clip) return;
      clip.meter = meter;
      if (sounding(holder)) meter.start();
    });
  }

  private notifyPlaybackChange(): void {
    this.options.onChange();
  }
}

/** Whether the page is told playback is sounding. */
function sounding(holder: Holder): boolean {
  switch (holder.kind) {
    case "idle":
    case "gap":
    case "cutOff":
      return false;
    case "replay":
      return (
        holder.phase.kind === "starting" || holder.phase.kind === "playing"
      );
    case "stream":
      return holder.phase.kind === "playing";
    default:
      return unreachable(holder);
  }
}

/** What holds the element: a clip, a pause, a cut-off utterance, or nothing. */
function occupant(holder: Holder): object | null {
  switch (holder.kind) {
    case "idle":
      return null;
    case "gap":
      return holder;
    case "replay":
    case "stream":
      return holder.clip;
    case "cutOff":
      return holder.utterance;
    default:
      return unreachable(holder);
  }
}

function watchOf(holder: Holder): ProgressWatch | null {
  if (holder.kind !== "replay" && holder.kind !== "stream") return null;
  const phase = holder.phase;
  return "watch" in phase ? phase.watch : null;
}

function meterOf(holder: Holder): EnvelopeMeter | null {
  return holder.kind === "replay" || holder.kind === "stream"
    ? holder.clip.meter
    : null;
}

function attemptOf(phase: ReplayPhase): PlayAttempt | null {
  return phase.kind === "starting" || phase.kind === "paused"
    ? phase.attempt
    : null;
}

function unreachable(holder: never): never {
  throw new Error("unknown playback holder: " + (holder as Holder).kind);
}

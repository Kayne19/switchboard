// Manual push-to-talk: one microphone stream, one MediaRecorder, one clip.
//
// A recording is stamped with the turn epoch (and any in-flight transfer) as
// it starts, because that is the earliest moment the browser knows who the
// caller is speaking to; nothing later -- upload, transcription -- is early
// enough to be safe. When the backend selected streaming STT, chunks go out as
// they are recorded and the finished clip is still kept for retransmission.

import {
  sttCancelHeader,
  sttChunkHeader,
  sttEndHeader,
  sttStartHeader,
} from "../protocol";
import { errorName } from "./errors";
import type { Clip } from "./outbox";
import { AudioLevelMonitor } from "./audioLevel";

const STREAMING_MIME = "audio/webm;codecs=opus";
const STREAMING_TIMESLICE_MS = 200;

export interface RecordingContext {
  /** The server's turn epoch as last announced. */
  epoch: number;
  /** The route a transfer is connecting to, when one is in flight. */
  transferEra: string | null;
  /** Whether the backend selected streaming STT for this socket. */
  streamingSelected: boolean;
}

export interface PushToTalkOptions {
  idleText: string;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createRecorder?: (stream: MediaStream) => MediaRecorder;
  createAudioContext?: () => AudioContext;
  onAudioLevel?: (level: number) => void;
  newClipId: () => string;
  context: () => RecordingContext;
  /** The socket to stream on, or null when it is not open. */
  openSocket: () => WebSocket | null;
  /** Hands the finished clip to the outbox; false when the outbox is full. */
  enqueue: (clip: Clip) => boolean;
  flush: () => void;
  onRecordingChange: (recording: boolean) => void;
  /** `error` undefined leaves the current error flag as it is. */
  /** Every status says whether it is an error (`CallRuntime.setStatus`). */
  onStatus: (text: string, error: boolean) => void;
  pauseHandsFree: () => void;
  resumeHandsFree: () => void;
}

function defaultCreateRecorder(stream: MediaStream): MediaRecorder {
  return MediaRecorder.isTypeSupported?.(STREAMING_MIME)
    ? new MediaRecorder(stream, { mimeType: STREAMING_MIME })
    : new MediaRecorder(stream);
}

/**
 * The browser offers no microphone API on this page at all. A browser only
 * grants capture on a secure origin, and WebKit leaves `navigator.mediaDevices`
 * undefined on a plain-http page rather than refusing the call, so the failure
 * used to reach the caller as a bare `TypeError`.
 */
export class NoCaptureApi extends Error {
  constructor() {
    super("this browser offers no microphone on this page");
    this.name = "NoCaptureApi";
  }
}

function defaultGetUserMedia(
  constraints: MediaStreamConstraints,
): Promise<MediaStream> {
  const devices = navigator.mediaDevices as MediaDevices | undefined;
  if (!devices?.getUserMedia) return Promise.reject(new NoCaptureApi());
  return devices.getUserMedia(constraints);
}

/**
 * The level meter of one press. Its context is made inside the press, where a
 * browser still gives it an audio session; its graph is built once the
 * recorder runs.
 */
interface Meter {
  context: AudioContext | null;
  monitor: AudioLevelMonitor | null;
  sink: GainNode | null;
}

/** One press waiting for the microphone; its permission prompt's answer names it. */
interface Press {
  meter: Meter;
}

/** One recording: the recorder, what it holds, and what its clip is stamped with. */
interface Take {
  recorder: MediaRecorder;
  stream: MediaStream;
  meter: Meter;
  id: string;
  epoch: number;
  /** The route a transfer was connecting to as the recording began. */
  transferEra: string | null;
  /** Whether chunks go out as they are recorded; the backend may abandon the stream. */
  streaming: boolean;
  chunks: Blob[];
  sequence: number;
}

/**
 * Where push-to-talk is. Each phase holds what exists only in it: a press
 * waiting for the microphone holds its meter, a recording holds its take.
 */
type Phase =
  | { kind: "idle" }
  /** The permission prompt is open. `cancelled`: Send or Discard came first. */
  | { kind: "acquiring"; press: Press; cancelled: boolean; answered: Promise<void> }
  | { kind: "recording"; take: Take }
  /** `stop()` was called; the recorder's `stop` event has not fired yet. */
  | { kind: "stopping"; take: Take; send: boolean };

/**
 * What moves push-to-talk. An event from a permission prompt or a recorder
 * names its press or take, so one that outlives its phase is dropped.
 */
type PttEvent =
  | { kind: "press" }
  | { kind: "release"; send: boolean }
  | { kind: "abandonStreaming"; id: unknown }
  | { kind: "granted"; press: Press; stream: MediaStream }
  | { kind: "refused"; press: Press; error: unknown }
  | { kind: "startFailed"; take: Take; error: unknown }
  | { kind: "data"; take: Take; blob: Blob }
  | { kind: "stopped"; take: Take }
  | { kind: "recorderError"; take: Take; error: unknown };

/** How a press ended. Each says what the caller hears about it. */
type Outcome =
  | { kind: "refused"; error: unknown }
  | { kind: "cancelled" }
  | { kind: "cannotRecord"; error: unknown }
  | { kind: "failed"; error: unknown }
  | { kind: "discarded" }
  | { kind: "sent"; take: Take }
  /** The browser stopped the recorder: what was said is sent. */
  | { kind: "taken"; take: Take };

/** A step into `idle`, with how the press ended. */
interface Ended {
  kind: "ended";
  outcome: Outcome;
}

const IDLE: Phase = { kind: "idle" };

function ended(outcome: Outcome): Ended {
  return { kind: "ended", outcome };
}

function takeOf(phase: Phase): Take | null {
  return "take" in phase ? phase.take : null;
}

function meterOf(phase: Phase): Meter | null {
  return phase.kind === "acquiring" ? phase.press.meter : (takeOf(phase)?.meter ?? null);
}

/** Takes the meter's graph down and gives its context back. */
function releaseMeter(meter: Meter): void {
  meter.monitor?.disconnect();
  meter.sink?.disconnect();
  meter.monitor = null;
  meter.sink = null;
  if (meter.context) void meter.context.close().catch(() => undefined);
  meter.context = null;
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** The one teardown: release what `from` holds and `to` does not. */
function leave(from: Phase, to: Phase): void {
  const meter = meterOf(from);
  if (meter && meter !== meterOf(to)) releaseMeter(meter);
  const stream = takeOf(from)?.stream;
  if (stream && stream !== takeOf(to)?.stream) stopTracks(stream);
}

export class PushToTalk {
  private readonly options: PushToTalkOptions;
  private readonly getUserMedia: NonNullable<PushToTalkOptions["getUserMedia"]>;
  private readonly createRecorder: NonNullable<
    PushToTalkOptions["createRecorder"]
  >;
  private readonly createAudioContext: NonNullable<
    PushToTalkOptions["createAudioContext"]
  >;
  private phase: Phase = IDLE;

  constructor(options: PushToTalkOptions) {
    this.options = options;
    this.getUserMedia = options.getUserMedia ?? defaultGetUserMedia;
    this.createRecorder = options.createRecorder ?? defaultCreateRecorder;
    this.createAudioContext =
      options.createAudioContext ?? (() => new AudioContext());
  }

  isRecording(): boolean {
    return this.phase.kind === "recording";
  }

  get isStarting(): boolean {
    return this.phase.kind === "acquiring";
  }

  /** Whether push-to-talk owns the microphone in any phase. */
  get isActive(): boolean {
    return this.phase.kind !== "idle";
  }

  /** The backend could not stream this clip; the complete clip goes instead. */
  abandonStreaming(id: unknown): void {
    this.transition({ kind: "abandonStreaming", id });
  }

  /** Settles once this press's permission prompt is answered. */
  start(): Promise<void> {
    this.transition({ kind: "press" });
    return this.phase.kind === "acquiring"
      ? this.phase.answered
      : Promise.resolve();
  }

  stop(send: boolean): void {
    this.transition({ kind: "release", send });
  }

  /** The only writer of `phase`. */
  private transition(event: PttEvent): void {
    const from = this.phase;
    const step = this.next(from, event);
    if (step === from) return;
    const to = step.kind === "ended" ? IDLE : step;
    leave(from, to);
    this.phase = to;
    if (step.kind === "ended") this.end(step.outcome);
    else if (to.kind !== from.kind) this.enter(to);
  }

  /**
   * The phase x event table (pinned by `pushToTalk.test.ts`): the phase
   * `event` moves push-to-talk to, or `phase` itself when the event changes
   * nothing. It may act on the way (ask for the microphone, send a chunk),
   * but never in a way that calls back into the machine at once: what can
   * (starting or stopping the recorder) runs in `enter`, after the phase is
   * written.
   */
  private next(phase: Phase, event: PttEvent): Phase | Ended {
    switch (event.kind) {
      case "press":
        // A second tap while the permission prompt is open is swallowed.
        return phase.kind === "idle" ? this.ask() : phase;
      case "release":
        return this.release(phase, event.send);
      case "abandonStreaming": {
        const take = takeOf(phase);
        if (take && take.id === event.id) take.streaming = false;
        return phase;
      }
      case "granted":
        if (phase.kind !== "acquiring" || phase.press !== event.press)
          return phase;
        if (phase.cancelled) return this.unused(event.stream, { kind: "cancelled" });
        return this.record(phase.press.meter, event.stream);
      case "refused":
        if (phase.kind !== "acquiring" || phase.press !== event.press)
          return phase;
        return ended({ kind: "refused", error: event.error });
      case "startFailed":
        if (takeOf(phase) !== event.take) return phase;
        return ended({ kind: "cannotRecord", error: event.error });
      case "data":
        if (takeOf(phase) === event.take) this.keep(event.take, event.blob);
        return phase;
      case "stopped":
        if (takeOf(phase) !== event.take) return phase;
        if (phase.kind === "recording")
          return ended({ kind: "taken", take: event.take });
        if (phase.kind === "stopping")
          return ended(
            phase.send
              ? { kind: "sent", take: event.take }
              : { kind: "discarded" },
          );
        return phase;
      case "recorderError":
        if (takeOf(phase) !== event.take) return phase;
        return ended({ kind: "failed", error: event.error });
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  /** Enter `acquiring`: hands-free lets go, the meter's context is made, the microphone is asked for. */
  private ask(): Phase {
    this.options.pauseHandsFree();
    const press: Press = { meter: this.openMeter() };
    // A `getUserMedia` that throws instead of rejecting is a refusal too.
    const answered = new Promise<MediaStream>((resolve) =>
      resolve(this.getUserMedia({ audio: true })),
    ).then(
      (stream) => this.transition({ kind: "granted", press, stream }),
      (error: unknown) => this.transition({ kind: "refused", press, error }),
    );
    return { kind: "acquiring", press, cancelled: false, answered };
  }

  /**
   * Makes the meter's context inside the press handler: that is where a
   * browser still gives it an audio session. Resuming it is never waited for
   * -- a WebKit `resume()` that an audio session interruption leaves pending
   * would otherwise hold the press in `acquiring` for the rest of the page's
   * life, with the microphone light on and nothing said. Nothing about the
   * level meter may stand between the press and the recorder.
   */
  private openMeter(): Meter {
    const meter: Meter = { context: null, monitor: null, sink: null };
    if (!this.options.onAudioLevel || typeof AudioContext === "undefined")
      return meter;
    try {
      meter.context = this.createAudioContext();
      if (meter.context.state === "suspended")
        void meter.context.resume().catch(() => undefined);
    } catch {
      meter.context = null;
    }
    return meter;
  }

  private release(phase: Phase, send: boolean): Phase {
    switch (phase.kind) {
      case "idle":
        this.options.onRecordingChange(false);
        return phase;
      case "acquiring":
        // Send or Discard during the permission prompt: the answer is
        // honoured by not starting a recording the caller already cancelled.
        this.options.onRecordingChange(false);
        return phase.cancelled ? phase : { ...phase, cancelled: true };
      case "recording":
        // A recorder that stopped by itself has its `stop` event on the way,
        // and that event ends the take.
        if (phase.take.recorder.state === "inactive") return phase;
        return { kind: "stopping", take: phase.take, send };
      case "stopping":
        return phase;
      default: {
        const exhaustive: never = phase;
        return exhaustive;
      }
    }
  }

  /** A granted stream that no take will hold. */
  private unused(stream: MediaStream, outcome: Outcome): Ended {
    stopTracks(stream);
    return ended(outcome);
  }

  /** Enter `recording`: a recorder on the granted stream, stamped as it begins. */
  private record(meter: Meter, stream: MediaStream): Phase | Ended {
    let recorder: MediaRecorder;
    try {
      // Safari does not support the opus mimeType and the constructor throws
      // NotSupportedError; left unguarded, Talk did nothing, no error
      // appeared, and the mic light stayed on because the tracks never
      // stopped.
      recorder = this.createRecorder(stream);
    } catch (error) {
      return this.unused(stream, { kind: "cannotRecord", error });
    }
    const context = this.options.context();
    const take: Take = {
      recorder,
      stream,
      meter,
      id: this.options.newClipId(),
      epoch: context.epoch,
      // Set when a transfer was already in flight as this recording began.
      // The clip is re-stamped to the new epoch when the transfer lands, so
      // the caller's words reach the leg they were speaking to.
      transferEra: context.transferEra,
      streaming:
        context.streamingSelected &&
        (recorder.mimeType || "") === STREAMING_MIME,
      chunks: [],
      sequence: 0,
    };
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0)
        this.transition({ kind: "data", take, blob: event.data });
    };
    // The one place a started recording ends, whatever stopped the recorder:
    // `stop()` only asks. A browser stops it by itself when its track ends --
    // the microphone is unplugged, or another app takes the iPad's audio
    // session -- and the page went on saying it was recording (#262).
    recorder.onstop = () => this.transition({ kind: "stopped", take });
    recorder.onerror = (event) =>
      this.transition({
        kind: "recorderError",
        take,
        error: (event as Event & { error?: unknown }).error,
      });
    return { kind: "recording", take };
  }

  /** What entering a phase does once it is written. `idle` is entered through `end`. */
  private enter(phase: Phase): void {
    switch (phase.kind) {
      case "recording":
        return this.startRecorder(phase.take);
      case "stopping":
        return phase.take.recorder.stop();
      case "idle":
      case "acquiring":
        return;
      default: {
        const exhaustive: never = phase;
        return exhaustive;
      }
    }
  }

  private startRecorder(take: Take): void {
    const timeslice = take.streaming ? STREAMING_TIMESLICE_MS : undefined;
    const socket = take.streaming ? this.options.openSocket() : null;
    if (socket) {
      try {
        socket.send(
          sttStartHeader({
            id: take.id,
            mime: take.recorder.mimeType,
            epoch: take.epoch,
          }),
        );
      } catch {
        take.streaming = false;
      }
    }
    try {
      take.recorder.start(timeslice);
    } catch (error) {
      this.transition({ kind: "startFailed", take, error });
      return;
    }
    this.options.onRecordingChange(true);
    this.options.onStatus(
      "Recording... Send when you are done, Discard to throw it away.",
      false,
    );
    // The meter is the last thing built, after the recorder is running: it is
    // a picture of the caller's voice, and a browser that cannot draw it
    // still has to record.
    this.attachMeter(take);
  }

  /**
   * Puts the level meter on a running recording. A failure here costs the
   * caller the moving bars and nothing else.
   */
  private attachMeter(take: Take): void {
    const { meter, stream } = take;
    const onAudioLevel = this.options.onAudioLevel;
    // A take that has already ended had its meter released on the way out.
    if (!meter.context || !onAudioLevel || takeOf(this.phase) !== take) return;
    try {
      const source = meter.context.createMediaStreamSource(stream);
      const sink = meter.context.createGain();
      sink.gain.value = 0;
      sink.connect(meter.context.destination);
      meter.sink = sink;
      meter.monitor = new AudioLevelMonitor(
        meter.context,
        source,
        onAudioLevel,
        sink,
      );
      meter.monitor.start();
    } catch {
      releaseMeter(meter);
    }
  }

  /** Keeps a recorded chunk, and streams it when the take still streams. */
  private keep(take: Take, blob: Blob): void {
    take.chunks.push(blob);
    if (!take.streaming) return;
    const socket = this.options.openSocket();
    if (!socket) return;
    const sequence = take.sequence++;
    try {
      socket.send(sttChunkHeader({ id: take.id, epoch: take.epoch }, sequence));
      socket.send(blob);
    } catch {
      try {
        socket.send(sttCancelHeader({ id: take.id, epoch: take.epoch }));
      } catch {
        /* socket is already closed */
      }
      take.streaming = false;
    }
  }

  /**
   * `idle`'s entry, whatever ended the press. Push-to-talk has already let go
   * of the microphone when hands-free is asked to take it back: hands-free
   * refuses while push-to-talk is still active (#257).
   */
  private end(outcome: Outcome): void {
    const { onStatus } = this.options;
    this.options.resumeHandsFree();
    this.options.onRecordingChange(false);
    switch (outcome.kind) {
      case "refused":
        return onStatus(
          outcome.error instanceof NoCaptureApi
            ? "No microphone on this page: open it over https, not by address."
            : "Microphone unavailable (" + errorName(outcome.error) + ").",
          true,
        );
      case "cancelled":
      case "discarded":
        return onStatus(this.options.idleText, false);
      case "cannotRecord":
        return onStatus(
          "This browser cannot record audio (" + errorName(outcome.error) + ").",
          true,
        );
      case "failed":
        return onStatus(
          "Recording failed (" + errorName(outcome.error) + ").",
          true,
        );
      case "sent":
        this.deliver(outcome.take);
        return;
      case "taken":
        if (this.deliver(outcome.take))
          onStatus("Recording stopped: the microphone was taken away.", true);
        return;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }

  /** Hands the take's clip to the outbox; false when the outbox is full. */
  private deliver(take: Take): boolean {
    const blob = new Blob(take.chunks, {
      type: take.recorder.mimeType || "audio/webm",
    });
    const clip: Clip = {
      id: take.id,
      audio: blob,
      mime: blob.type,
      created: Date.now(),
      epoch: take.epoch,
      transferEra: take.transferEra ?? undefined,
      sent: false,
      streaming: take.streaming,
      chunks: take.streaming ? take.chunks : undefined,
    };
    if (!this.options.enqueue(clip)) return false;
    const socket = take.streaming ? this.options.openSocket() : null;
    if (socket) {
      try {
        socket.send(sttStartHeader(clip));
        socket.send(sttEndHeader(clip));
        clip.sent = true;
        clip.transmitted = true;
      } catch {
        clip.sent = false;
      }
    }
    this.options.flush();
    return true;
  }
}

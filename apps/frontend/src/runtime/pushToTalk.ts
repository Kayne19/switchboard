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

interface ActiveRecording {
  recorder: MediaRecorder;
  discard: boolean;
  id: string;
  epoch: number;
  streaming: boolean;
  chunks: Blob[];
  sequence: number;
  transferEra: string | null;
  /** Set by `stop()`; a recorder that stops without it was stopped by the browser. */
  stopRequested: boolean;
  levelMonitor?: AudioLevelMonitor;
  levelSink?: GainNode;
  levelContext?: AudioContext;
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

/** Takes the level meter off a recording and gives its context back. */
function releaseMeter(recording: ActiveRecording): void {
  recording.levelMonitor?.disconnect();
  recording.levelSink?.disconnect();
  recording.levelMonitor = undefined;
  recording.levelSink = undefined;
  if (recording.levelContext)
    void recording.levelContext.close().catch(() => undefined);
  recording.levelContext = undefined;
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
  private mediaRecorder: MediaRecorder | null = null;
  private activeRecording: ActiveRecording | null = null;
  // True from the moment getUserMedia is asked for until the recorder is
  // actually running. Without it a second press lands inside the permission
  // await, spawns a second stream and recorder, orphans the first one with
  // its mic light stuck on, and garbles the clip because both write into the
  // same chunks array.
  private starting = false;
  private startCancelled = false;

  constructor(options: PushToTalkOptions) {
    this.options = options;
    this.getUserMedia = options.getUserMedia ?? defaultGetUserMedia;
    this.createRecorder = options.createRecorder ?? defaultCreateRecorder;
    this.createAudioContext =
      options.createAudioContext ?? (() => new AudioContext());
  }

  isRecording(): boolean {
    return this.mediaRecorder?.state === "recording";
  }

  get isStarting(): boolean {
    return this.starting;
  }

  /** Whether push-to-talk owns the microphone in any phase. */
  get isActive(): boolean {
    return this.starting || this.isRecording() || this.activeRecording !== null;
  }

  /** The backend could not stream this clip; the complete clip goes instead. */
  abandonStreaming(id: unknown): void {
    if (this.activeRecording && this.activeRecording.id === id)
      this.activeRecording.streaming = false;
  }

  async start(): Promise<void> {
    if (this.starting || this.activeRecording || this.isRecording()) return;
    const { onStatus } = this.options;
    this.options.pauseHandsFree();
    this.starting = true;
    this.startCancelled = false;
    // Create the meter's context inside the press handler: that is where a
    // browser still gives it an audio session. Resuming it is never waited
    // for -- a WebKit `resume()` that an audio session interruption leaves
    // pending would otherwise hold `starting` true for the rest of the page's
    // life, and every later press returns at the guard above with the
    // microphone light on and nothing said. Nothing about the level meter may
    // stand between the press and the recorder.
    let levelContext: AudioContext | undefined;
    if (this.options.onAudioLevel && typeof AudioContext !== "undefined") {
      try {
        levelContext = this.createAudioContext();
        if (levelContext.state === "suspended")
          void levelContext.resume().catch(() => undefined);
      } catch {
        levelContext = undefined;
      }
    }
    let stream: MediaStream;
    try {
      stream = await this.getUserMedia({ audio: true });
    } catch (err) {
      this.starting = false;
      if (levelContext) void levelContext.close().catch(() => undefined);
      this.options.resumeHandsFree();
      onStatus(
        err instanceof NoCaptureApi
          ? "No microphone on this page: open it over https, not by address."
          : "Microphone unavailable (" + errorName(err) + ").",
        true,
      );
      return;
    }
    // Discard/Send pressed during the permission await: honour it instead of
    // starting a recording the caller already cancelled.
    if (this.startCancelled) {
      this.starting = false;
      if (levelContext) void levelContext.close().catch(() => undefined);
      stream.getTracks().forEach((t) => t.stop());
      this.options.resumeHandsFree();
      onStatus(this.options.idleText, false);
      this.options.onRecordingChange(false);
      return;
    }
    let recorder: MediaRecorder;
    try {
      // Safari does not support the opus mimeType and the constructor throws
      // NotSupportedError; left unguarded, Talk did nothing, no error
      // appeared, and the mic light stayed on because the tracks never
      // stopped.
      recorder = this.createRecorder(stream);
      this.mediaRecorder = recorder;
    } catch (err) {
      this.starting = false;
      if (levelContext) void levelContext.close().catch(() => undefined);
      stream.getTracks().forEach((t) => t.stop());
      this.options.resumeHandsFree();
      this.options.onRecordingChange(false);
      onStatus(
        "This browser cannot record audio (" + errorName(err) + ").",
        true,
      );
      return;
    }
    const chunks: Blob[] = [];
    const context = this.options.context();
    const recordingId = this.options.newClipId();
    const recordingEpoch = context.epoch;
    const recordingStreaming =
      context.streamingSelected &&
      (recorder.mimeType || "") === STREAMING_MIME;
    // Set when a transfer was already in flight as this recording began. The
    // clip is re-stamped to the new epoch when the transfer lands, so the
    // caller's words reach the leg they were speaking to.
    const recordingTransferEra = context.transferEra;
    let streamReleased = false;
    const releaseStream = () => {
      if (streamReleased) return;
      streamReleased = true;
      stream.getTracks().forEach((t) => t.stop());
    };
    let recorderFailed = false;
    const recording: ActiveRecording = {
      recorder,
      discard: false,
      id: recordingId,
      epoch: recordingEpoch,
      streaming: recordingStreaming,
      chunks,
      sequence: 0,
      transferEra: recordingTransferEra,
      stopRequested: false,
      levelContext,
    };
    this.activeRecording = recording;
    recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      chunks.push(e.data);
      const active = this.activeRecording;
      if (active?.recorder !== recorder || !active.streaming) return;
      const ws = this.options.openSocket();
      if (!ws) return;
      const sequence = active.sequence++;
      try {
        ws.send(sttChunkHeader({ id: active.id, epoch: active.epoch }, sequence));
        ws.send(e.data);
      } catch {
        try {
          ws.send(sttCancelHeader({ id: active.id, epoch: active.epoch }));
        } catch {
          /* socket is already closed */
        }
        active.streaming = false;
      }
    };
    const startSocket = recording.streaming ? this.options.openSocket() : null;
    if (startSocket) {
      try {
        startSocket.send(
          sttStartHeader({
            id: recording.id,
            mime: recorder.mimeType,
            epoch: recording.epoch,
          }),
        );
      } catch {
        recording.streaming = false;
      }
    }
    // The one place a started recording ends for the page, whatever stopped
    // the recorder: `stop()` only asks. A browser stops it by itself when its
    // track ends -- the microphone is unplugged, or another app takes the
    // iPad's audio session -- and the page went on saying it was recording
    // (#262).
    recorder.onstop = () => {
      releaseMeter(recording);
      releaseStream();
      const current = this.activeRecording === recording;
      // Let go of the recording before hands-free is asked to take the
      // microphone back: it refuses while push-to-talk is still active
      // (#257), as every other exit here already knows.
      if (current) this.activeRecording = null;
      if (this.mediaRecorder === recorder) this.mediaRecorder = null;
      this.options.resumeHandsFree();
      if (recorderFailed) return;
      if (current) this.options.onRecordingChange(false);
      if (recording.discard) {
        onStatus(this.options.idleText, false);
        return;
      }
      const blob = new Blob(chunks, {
        type: recorder.mimeType || "audio/webm",
      });
      const clip: Clip = {
        id: recordingId,
        audio: blob,
        mime: blob.type,
        created: Date.now(),
        epoch: recordingEpoch,
        transferEra: recordingTransferEra ?? undefined,
        sent: false,
        streaming: recording.streaming,
        chunks: recording.streaming ? chunks : undefined,
      };
      if (!this.options.enqueue(clip)) return;
      const endSocket = recording.streaming ? this.options.openSocket() : null;
      if (endSocket) {
        try {
          endSocket.send(sttStartHeader(clip));
          endSocket.send(sttEndHeader(clip));
          clip.sent = true;
          clip.transmitted = true;
        } catch {
          clip.sent = false;
        }
      }
      this.options.flush();
      if (!recording.stopRequested)
        onStatus("Recording stopped: the microphone was taken away.", true);
    };
    recorder.onerror = (event) => {
      if (recorderFailed) return;
      recorderFailed = true;
      if (this.activeRecording?.recorder === recorder)
        this.activeRecording = null;
      if (this.mediaRecorder === recorder) this.mediaRecorder = null;
      this.starting = false;
      releaseMeter(recording);
      releaseStream();
      this.options.resumeHandsFree();
      this.options.onRecordingChange(false);
      onStatus(
        "Recording failed (" +
          errorName((event as Event & { error?: unknown }).error) +
          ").",
        true,
      );
    };
    try {
      recorder.start(recordingStreaming ? STREAMING_TIMESLICE_MS : undefined);
    } catch (err) {
      recorderFailed = true;
      if (this.activeRecording?.recorder === recorder)
        this.activeRecording = null;
      releaseMeter(recording);
      releaseStream();
      this.mediaRecorder = null;
      this.starting = false;
      this.options.resumeHandsFree();
      this.options.onRecordingChange(false);
      onStatus(
        "This browser cannot record audio (" + errorName(err) + ").",
        true,
      );
      return;
    }
    this.starting = false;
    this.options.onRecordingChange(true);
    onStatus(
      "Recording... Send when you are done, Discard to throw it away.",
      false,
    );
    // The meter is the last thing built, after the recorder is running: it is
    // a picture of the caller's voice, and a browser that cannot draw it
    // still has to record.
    this.attachMeter(recording, stream);
  }

  /**
   * Puts the level meter on a running recording. A failure here costs the
   * caller the moving bars and nothing else.
   */
  private attachMeter(recording: ActiveRecording, stream: MediaStream): void {
    const levelContext = recording.levelContext;
    const onAudioLevel = this.options.onAudioLevel;
    if (!levelContext || !onAudioLevel) return;
    if (this.activeRecording !== recording) {
      releaseMeter(recording);
      return;
    }
    try {
      const source = levelContext.createMediaStreamSource(stream);
      const levelSink = levelContext.createGain();
      levelSink.gain.value = 0;
      levelSink.connect(levelContext.destination);
      recording.levelSink = levelSink;
      recording.levelMonitor = new AudioLevelMonitor(
        levelContext,
        source,
        onAudioLevel,
        levelSink,
      );
      recording.levelMonitor.start();
    } catch {
      releaseMeter(recording);
    }
  }

  stop(send: boolean): void {
    // Set before the state check so a press landing inside the getUserMedia
    // await is still honoured once the permission resolves.
    if (this.starting) {
      this.startCancelled = true;
      this.options.onRecordingChange(false);
      return;
    }
    const recording = this.activeRecording;
    if (!recording) {
      this.options.onRecordingChange(false);
      return;
    }
    // The recorder's stop event tells the page the recording ended.
    if (recording.recorder.state !== "inactive") {
      recording.discard = !send;
      recording.stopRequested = true;
      recording.recorder.stop();
    }
  }
}

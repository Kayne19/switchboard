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
  newClipId: () => string;
  context: () => RecordingContext;
  /** The socket to stream on, or null when it is not open. */
  openSocket: () => WebSocket | null;
  /** Hands the finished clip to the outbox; false when the outbox is full. */
  enqueue: (clip: Clip) => boolean;
  flush: () => void;
  onRecordingChange: (recording: boolean) => void;
  /** `error` undefined leaves the current error flag as it is. */
  onStatus: (text: string, error?: boolean) => void;
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
}

function defaultCreateRecorder(stream: MediaStream): MediaRecorder {
  return MediaRecorder.isTypeSupported?.(STREAMING_MIME)
    ? new MediaRecorder(stream, { mimeType: STREAMING_MIME })
    : new MediaRecorder(stream);
}

export class PushToTalk {
  private readonly options: PushToTalkOptions;
  private readonly getUserMedia: NonNullable<PushToTalkOptions["getUserMedia"]>;
  private readonly createRecorder: NonNullable<
    PushToTalkOptions["createRecorder"]
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
    this.getUserMedia =
      options.getUserMedia ??
      ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
    this.createRecorder = options.createRecorder ?? defaultCreateRecorder;
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
    let stream: MediaStream;
    try {
      stream = await this.getUserMedia({ audio: true });
    } catch (err) {
      this.starting = false;
      this.options.resumeHandsFree();
      onStatus("Microphone unavailable (" + errorName(err) + ").", true);
      return;
    }
    // Discard/Send pressed during the permission await: honour it instead of
    // starting a recording the caller already cancelled.
    if (this.startCancelled) {
      this.starting = false;
      stream.getTracks().forEach((t) => t.stop());
      this.options.resumeHandsFree();
      onStatus(this.options.idleText);
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
    recorder.onstop = () => {
      releaseStream();
      this.options.resumeHandsFree();
      if (this.activeRecording?.recorder === recorder)
        this.activeRecording = null;
      if (this.mediaRecorder === recorder) this.mediaRecorder = null;
      if (recorderFailed) return;
      if (recording.discard) {
        onStatus(this.options.idleText);
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
    };
    recorder.onerror = (event) => {
      if (recorderFailed) return;
      recorderFailed = true;
      if (this.activeRecording?.recorder === recorder)
        this.activeRecording = null;
      if (this.mediaRecorder === recorder) this.mediaRecorder = null;
      this.starting = false;
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
      releaseStream();
      this.options.resumeHandsFree();
      this.mediaRecorder = null;
      this.starting = false;
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
  }

  stop(send: boolean): void {
    // Set before the state check so a press landing inside the getUserMedia
    // await is still honoured once the permission resolves.
    if (this.starting) {
      this.startCancelled = true;
      this.options.onRecordingChange(false);
      return;
    }
    if (
      this.activeRecording &&
      this.activeRecording.recorder.state !== "inactive"
    ) {
      this.activeRecording.discard = !send;
      this.activeRecording.recorder.stop();
    }
    this.options.onRecordingChange(false);
  }
}

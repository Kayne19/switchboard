// One streamed utterance's MediaSource.
//
// An utterance streams through its own `MediaSource`: the chunks go into a
// `SourceBuffer` as whole MP3 frames while they arrive, and the stream is
// ended once the last of them is in. `AudioPlayback` decides which stream
// holds the element and when it plays; this file owns only the source: the
// frames, the buffer, the appends and the end. A source that was released
// ignores every late event, so a stream that is gone can never append, play
// or fail again.

import { Mp3FrameAligner } from "./speechEnvelope";

/** True when this browser can stream MP3 through a `MediaSource`. */
export function mseRuntimeSupported(): boolean {
  return (
    typeof MediaSource !== "undefined" &&
    MediaSource.isTypeSupported("audio/mpeg")
  );
}

export interface MseSourceEvents {
  /** An append went into the buffer: the element has something to play. */
  appended: () => void;
  /** The source refused what it was given. */
  failed: (error: unknown) => void;
}

export class MseSource {
  private readonly mime: string;
  private readonly events: MseSourceEvents;
  /** Cuts the stream where frames end before it reaches the SourceBuffer. */
  private readonly frames = new Mp3FrameAligner();
  /** Whole frames waiting for the SourceBuffer, oldest first. */
  private readonly queued: ArrayBuffer[] = [];
  private media: MediaSource | null = null;
  private buffer: SourceBuffer | null = null;
  private url: string | null = null;
  /** `audio_done` said the utterance is complete: end the stream once drained. */
  private complete = false;
  private released = false;
  /**
   * Appends that landed since the progress watch last looked: an element
   * waiting for bytes that are still arriving is not stalled.
   */
  private freshAppends = 0;

  constructor(mime: string, events: MseSourceEvents) {
    this.mime = mime;
    this.events = events;
  }

  /** A chunk as it came off the socket; the whole frames in it go in. */
  receive(data: ArrayBuffer): void {
    const whole = this.frames.take(data);
    if (!whole) return;
    this.queued.push(whole);
    this.append();
  }

  /**
   * The utterance has no more bytes: the part-frame held back goes in last,
   * and a `complete` stream is ended once every append has landed.
   */
  finish(complete: boolean): void {
    this.complete = complete;
    const rest = this.frames.flush();
    if (rest) this.queued.push(rest);
    this.append();
  }

  /**
   * Makes the source and returns its URL. Attaching the source is what opens
   * it: a MediaSource is `closed` until an element takes its URL, and
   * `sourceopen` fires then. Waiting for the event before attaching waits
   * forever -- no SourceBuffer, no append, no `play()`, and nothing
   * reported, which is a call that hears nothing at all (#203, the silence
   * in #189).
   */
  attach(): string {
    const media = new MediaSource();
    this.media = media;
    this.url = URL.createObjectURL(media);
    media.addEventListener("sourceopen", () => this.open(), { once: true });
    return this.url;
  }

  /** The source opened and has a SourceBuffer: it is waiting for bytes. */
  get opened(): boolean {
    return this.buffer !== null;
  }

  /** Every byte went in and the stream was ended. */
  get ended(): boolean {
    return this.media?.readyState === "ended";
  }

  /** Whether an append landed since the last look, and starts a new look. */
  takeFreshAppends(): boolean {
    const fresh = this.freshAppends > 0;
    this.freshAppends = 0;
    return fresh;
  }

  /** The stream is gone: revoke its URL and ignore whatever comes late. */
  release(): void {
    this.released = true;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }

  /** The source is open: it has a SourceBuffer, and what has arrived goes in. */
  private open(): void {
    if (this.released || !this.media) return;
    try {
      const buffer = this.media.addSourceBuffer(this.mime);
      this.buffer = buffer;
      // MP3 carries no timestamps of its own: in `sequence` mode each append
      // is placed straight after the last, with no gap or overlap to splice.
      // The MSE spec already starts an MPEG audio buffer in it; this says so
      // rather than trust every engine to (#213).
      buffer.mode = "sequence";
      buffer.addEventListener("error", () => {
        if (!this.released)
          this.events.failed(new Error("MediaSource append error"));
      });
      this.append();
    } catch (error) {
      this.events.failed(error);
    }
  }

  private append(): void {
    const buffer = this.buffer;
    if (this.released || !buffer || buffer.updating) return;
    if (!this.queued.length) {
      this.end();
      return;
    }
    try {
      buffer.appendBuffer(this.queued[0]);
      this.events.appended();
      buffer.addEventListener(
        "updateend",
        () => {
          this.queued.shift();
          this.freshAppends += 1;
          this.append();
        },
        { once: true },
      );
    } catch (error) {
      this.events.failed(error);
    }
  }

  /** Called with every append landed: ends a complete stream. */
  private end(): void {
    const media = this.media;
    if (!this.complete || !media) return;
    try {
      if (media.readyState === "open") media.endOfStream();
    } catch (error) {
      this.events.failed(error);
    }
  }
}

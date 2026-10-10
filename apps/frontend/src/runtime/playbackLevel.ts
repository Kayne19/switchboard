// The agent's playback level.
//
// The one reader of the level, in every engine (#194): the utterance's own
// bytes, decoded off to the side, read at the element's `currentTime`. The
// element is never routed through Web Audio, so no engine has to be asked
// whether it survives that (#189). A replay is decoded in one go, a stream
// as its chunks arrive.

import {
  createEnvelopeDecoder,
  decodeEnvelope,
  EnvelopeMeter,
  StreamingEnvelope,
  type EnvelopeDecoder,
} from "./speechEnvelope";

export class PlaybackLevel {
  private readonly element: HTMLAudioElement;
  private readonly onLevel: ((level: number) => void) | undefined;
  private decoder: EnvelopeDecoder | null = null;
  private decoderAttempted = false;

  constructor(
    element: HTMLAudioElement,
    onLevel: ((level: number) => void) | undefined,
  ) {
    this.element = element;
    this.onLevel = onLevel;
  }

  /** The timeline a streamed utterance's chunks are decoded into. */
  streamEnvelope(): StreamingEnvelope | null {
    const decoder = this.envelopeDecoder();
    return decoder ? new StreamingEnvelope(decoder) : null;
  }

  /** Meters the element against a stream's envelope as it grows. */
  streamMeter(envelope: StreamingEnvelope | null): EnvelopeMeter | null {
    return this.onLevel && envelope
      ? new EnvelopeMeter(this.element, envelope, this.onLevel)
      : null;
  }

  /**
   * Decodes a replay aside and hands `use` the meter on its envelope. Nothing
   * is handed over when there is no level to report.
   */
  meterReplay(blob: Blob, use: (meter: EnvelopeMeter) => void): void {
    const onLevel = this.onLevel;
    const decoder = this.envelopeDecoder();
    if (!onLevel || !decoder) return;
    void blob
      .arrayBuffer()
      .then((bytes) => decodeEnvelope(bytes, decoder))
      .then((envelope) => {
        if (envelope) use(new EnvelopeMeter(this.element, envelope, onLevel));
      })
      .catch(() => undefined);
  }

  /**
   * The decoder the level is read through, made once. `null` on a browser
   * with no `OfflineAudioContext`: that is a flat level, which is what a
   * caller with no level should see.
   */
  private envelopeDecoder(): EnvelopeDecoder | null {
    if (!this.onLevel) return null;
    if (!this.decoderAttempted) {
      this.decoderAttempted = true;
      this.decoder = createEnvelopeDecoder();
    }
    return this.decoder;
  }
}

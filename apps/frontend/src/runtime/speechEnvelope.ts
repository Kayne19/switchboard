// A spoken utterance's loudness over time, read from the audio itself.
//
// This is the only reader of the agent's playback level, in every engine
// (#194). The element is never routed through Web Audio: WebKit silences a
// media element routed through `createMediaElementSource` while a
// `MediaSource` is attached, and an `AnalyserNode` on the element was a
// second implementation of one level for the engines where it works (#189).
//
// The same MP3 bytes can be decoded off to the side instead. The decode
// touches no element and no live context: it is an `OfflineAudioContext`,
// which needs no user gesture. The meter then reads the envelope at the
// element's own `currentTime`, and the element stays on native playback.

import { clampAudioLevel, normalizeAudioEnergy } from "./audioLevel";

/** One envelope step. Short enough to follow speech, long enough to be cheap. */
export const ENVELOPE_STEP_MS = 40;

/** What decodes compressed audio; an `OfflineAudioContext` is one. */
export interface EnvelopeDecoder {
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
}

/** The level of an utterance at a time in it; what the meter reads. */
export interface LevelTimeline {
  /** The level at `seconds` into the utterance; 0 where it is unknown. */
  levelAt(seconds: number): number;
}

/** The RMS level of each step of an utterance, on the meter's own scale. */
export class SpeechEnvelope implements LevelTimeline {
  private readonly levels: readonly number[];
  readonly stepMs: number;

  constructor(levels: readonly number[], stepMs: number = ENVELOPE_STEP_MS) {
    this.levels = levels;
    this.stepMs = stepMs > 0 ? stepMs : ENVELOPE_STEP_MS;
  }

  /** The level at `seconds` into the utterance; 0 outside it. */
  levelAt(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds < 0) return 0;
    const step = Math.floor((seconds * 1000) / this.stepMs);
    return this.levels[step] ?? 0;
  }

  get steps(): number {
    return this.levels.length;
  }
}

/** Reads one channel of decoded audio into an envelope. */
export function envelopeOfBuffer(
  buffer: AudioBuffer,
  stepMs: number = ENVELOPE_STEP_MS,
): SpeechEnvelope {
  const samples = buffer.getChannelData(0);
  const perStep = Math.max(1, Math.round((buffer.sampleRate * stepMs) / 1000));
  const levels: number[] = [];
  for (let start = 0; start < samples.length; start += perStep) {
    let energy = 0;
    const end = Math.min(start + perStep, samples.length);
    for (let at = start; at < end; at += 1) energy += samples[at] * samples[at];
    levels.push(normalizeAudioEnergy(Math.sqrt(energy / (end - start))));
  }
  return new SpeechEnvelope(levels, stepMs);
}

/**
 * A decoder that does not touch playback. `null` when the browser has no
 * `OfflineAudioContext`: the meter then has no envelope, which is a flat
 * level, never a canned animation.
 */
export function createEnvelopeDecoder(): EnvelopeDecoder | null {
  if (typeof OfflineAudioContext === "undefined") return null;
  try {
    // One frame at a common rate. Nothing is rendered; only `decodeAudioData`
    // is used, and it decodes at the file's own rate.
    return new OfflineAudioContext(1, 1, 44100);
  } catch {
    return null;
  }
}

/** The envelope of one utterance, or `null` if it cannot be read. */
export async function decodeEnvelope(
  bytes: ArrayBuffer,
  decoder: EnvelopeDecoder,
  stepMs: number = ENVELOPE_STEP_MS,
): Promise<SpeechEnvelope | null> {
  try {
    const buffer = await decoder.decodeAudioData(bytes);
    if (!buffer || buffer.length === 0) return null;
    return envelopeOfBuffer(buffer, stepMs);
  } catch {
    return null;
  }
}

/**
 * The MP3 frame table. A frame's length is fixed by its header, so a byte
 * stream can be cut where one frame ends and the next begins -- which is
 * what `decodeAudioData` needs: it takes whole frames, never half of one.
 */
const MP3_BITRATES_KBPS = {
  // MPEG-1 Layer III, by the header's bitrate index.
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  // MPEG-2 and MPEG-2.5 Layer III.
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
} as const;
const MP3_SAMPLE_RATES = {
  mpeg1: [44100, 48000, 32000],
  mpeg2: [22050, 24000, 16000],
  mpeg25: [11025, 12000, 8000],
} as const;

/** The length in bytes of the Layer III frame at `at`, or 0 if there is none. */
function mp3FrameLength(bytes: Uint8Array, at: number): number {
  if (at + 4 > bytes.length) return 0;
  if (bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) return 0;
  const version = (bytes[at + 1] >> 3) & 0x03;
  // Layer III only: that is what the voice is sent as.
  if (((bytes[at + 1] >> 1) & 0x03) !== 0x01) return 0;
  const bitrateIndex = (bytes[at + 2] >> 4) & 0x0f;
  const rateIndex = (bytes[at + 2] >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 0x0f || rateIndex === 0x03) return 0;
  const rates =
    version === 3
      ? MP3_SAMPLE_RATES.mpeg1
      : version === 2
        ? MP3_SAMPLE_RATES.mpeg2
        : version === 0
          ? MP3_SAMPLE_RATES.mpeg25
          : null;
  if (!rates) return 0;
  const bitrate =
    (version === 3 ? MP3_BITRATES_KBPS[1] : MP3_BITRATES_KBPS[2])[
      bitrateIndex
    ] * 1000;
  const samples = version === 3 ? 1152 : 576;
  const padding = (bytes[at + 2] >> 1) & 0x01;
  return Math.floor((samples / 8) * (bitrate / rates[rateIndex])) + padding;
}

/** Past an ID3v2 tag, if the stream opens with one. */
function afterId3(bytes: Uint8Array): number {
  if (bytes.length < 10) return 0;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size =
    (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
  const footer = (bytes[5] & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/**
 * The length of the longest prefix of `bytes` that ends where an MP3 frame
 * ends; 0 when no whole frame has arrived yet. A decoder given this prefix
 * decodes every frame in it and nothing half-formed, so the envelope of the
 * prefix is the first part of the envelope of the whole clip.
 */
export function mp3FrameBoundary(bytes: Uint8Array): number {
  let at = afterId3(bytes);
  if (at >= bytes.length) return 0;
  let boundary = 0;
  for (;;) {
    const length = mp3FrameLength(bytes, at);
    if (length <= 0 || at + length > bytes.length) break;
    at += length;
    boundary = at;
  }
  return boundary;
}

/**
 * The envelope of an utterance that is still arriving. Chunks come off the
 * socket on no particular boundary, so each decode is of every whole frame
 * received so far: one timeline, growing, always starting at the utterance's
 * own zero, and equal to the whole-clip envelope once the last chunk is in.
 * One decode runs at a time; chunks that arrive during it are taken by the
 * next.
 */
export class StreamingEnvelope implements LevelTimeline {
  private readonly decoder: EnvelopeDecoder;
  private readonly stepMs: number;
  private received: Uint8Array[] = [];
  private bytes = 0;
  /** The prefix length the current envelope was decoded from. */
  private decodedBytes = 0;
  private envelope: SpeechEnvelope | null = null;
  private decoding = false;

  constructor(decoder: EnvelopeDecoder, stepMs: number = ENVELOPE_STEP_MS) {
    this.decoder = decoder;
    this.stepMs = stepMs > 0 ? stepMs : ENVELOPE_STEP_MS;
  }

  /** Takes a chunk as it arrives and decodes what is now whole. */
  append(chunk: ArrayBuffer): void {
    this.received.push(new Uint8Array(chunk.slice(0)));
    this.bytes += chunk.byteLength;
    void this.decodeWhatIsWhole();
  }

  levelAt(seconds: number): number {
    return this.envelope?.levelAt(seconds) ?? 0;
  }

  /** The steps decoded so far; 0 before the first whole frame. */
  get steps(): number {
    return this.envelope?.steps ?? 0;
  }

  private joined(): Uint8Array {
    if (this.received.length > 1) {
      const all = new Uint8Array(this.bytes);
      let at = 0;
      for (const chunk of this.received) {
        all.set(chunk, at);
        at += chunk.length;
      }
      this.received = [all];
    }
    return this.received[0] ?? new Uint8Array(0);
  }

  private async decodeWhatIsWhole(): Promise<void> {
    if (this.decoding) return;
    const all = this.joined();
    const boundary = mp3FrameBoundary(all);
    if (boundary <= this.decodedBytes) return;
    this.decoding = true;
    try {
      const buffer = await this.decoder.decodeAudioData(
        all.slice(0, boundary).buffer as ArrayBuffer,
      );
      if (buffer && buffer.length > 0) {
        this.envelope = envelopeOfBuffer(buffer, this.stepMs);
        this.decodedBytes = boundary;
      }
    } catch {
      // An undecodable prefix is a flat level, never a canned animation.
    } finally {
      this.decoding = false;
    }
    if (this.bytes > boundary) await this.decodeWhatIsWhole();
  }
}

/** What the meter needs of the element it follows. */
export interface MeteredElement {
  readonly currentTime: number;
}

/**
 * Reports an element's loudness from the utterance's own envelope. It is the
 * only reader of the agent's playback level, in every engine (#194): a
 * replay reads a `SpeechEnvelope` decoded in one go, a stream reads a
 * `StreamingEnvelope` that grows as the chunks arrive, and both are the same
 * timeline against the same `currentTime`.
 */
export class EnvelopeMeter {
  private readonly element: MeteredElement;
  private readonly envelope: LevelTimeline;
  private readonly onLevel: (level: number) => void;
  private animationFrame: number | null = null;

  constructor(
    element: MeteredElement,
    envelope: LevelTimeline,
    onLevel: (level: number) => void,
  ) {
    this.element = element;
    this.envelope = envelope;
    this.onLevel = onLevel;
  }

  start(): void {
    if (this.animationFrame !== null) return;
    const sample = () => {
      this.animationFrame = requestAnimationFrame(sample);
      this.onLevel(
        clampAudioLevel(this.envelope.levelAt(this.element.currentTime)),
      );
    };
    sample();
  }

  stop(): void {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.onLevel(0);
  }
}

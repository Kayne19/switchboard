// A spoken utterance's loudness over time, read from the audio itself.
//
// The playback meter normally comes from an `AnalyserNode` on the element.
// WebKit cannot be given that: routing a media element through
// `createMediaElementSource` while a `MediaSource` is attached silences it,
// so `AudioPlayback` refuses to build that graph there (#189) and the caller
// watched a canned animation instead of the agent's voice.
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

/** The RMS level of each step of an utterance, on the meter's own scale. */
export class SpeechEnvelope {
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

/** What the meter needs of the element it follows. */
export interface MeteredElement {
  readonly currentTime: number;
}

/**
 * Reports an element's loudness from a precomputed envelope. It is the
 * analyser's counterpart for a browser whose element cannot be analysed;
 * `AudioPlayback` names which of the two a browser gets.
 */
export class EnvelopeMeter {
  private readonly element: MeteredElement;
  private readonly envelope: SpeechEnvelope;
  private readonly onLevel: (level: number) => void;
  private animationFrame: number | null = null;

  constructor(
    element: MeteredElement,
    envelope: SpeechEnvelope,
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

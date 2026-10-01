/** Keep audio feedback bounded before it reaches the visual meter. */
export function clampAudioLevel(level: number): number {
  return Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
}

/** VAD and analyser RMS values are quiet for normal speech; expand them into a useful range. */
export function normalizeAudioEnergy(energy: number): number {
  return clampAudioLevel(energy * 8);
}

/** Smooth attacks quickly and let silence settle without flicker. */
export function selectVoiceLevel(
  caller: number,
  agent: number,
  agentSpeaking: boolean,
): number {
  return clampAudioLevel(agentSpeaking ? agent : caller);
}

export function smoothAudioLevel(previous: number, next: number): number {
  const target = clampAudioLevel(next);
  const factor = target > previous ? 0.42 : 0.18;
  return clampAudioLevel(previous + (target - previous) * factor);
}

/** Poll an AnalyserNode without putting 60fps values into React state. */
export class AudioLevelMonitor {
  private readonly analyser: AnalyserNode;
  private readonly values: Uint8Array<ArrayBuffer>;
  private readonly onLevel: (level: number) => void;
  private animationFrame: number | null = null;
  private smoothed = 0;

  constructor(
    context: AudioContext,
    input: AudioNode,
    onLevel: (level: number) => void,
    output?: AudioNode,
  ) {
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 512;
    this.values = new Uint8Array(this.analyser.fftSize);
    this.onLevel = onLevel;
    input.connect(this.analyser);
    output && this.analyser.connect(output);
  }

  start(): void {
    if (this.animationFrame !== null) return;
    const sample = () => {
      this.animationFrame = requestAnimationFrame(sample);
      this.analyser.getByteTimeDomainData(this.values);
      let energy = 0;
      for (const value of this.values) {
        const sample = (value - 128) / 128;
        energy += sample * sample;
      }
      this.smoothed = smoothAudioLevel(this.smoothed, Math.sqrt(energy / this.values.length) * 8);
      this.onLevel(this.smoothed);
    };
    sample();
  }

  stop(): void {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.smoothed = 0;
    this.onLevel(0);
  }

  disconnect(): void {
    this.stop();
    this.analyser.disconnect();
  }
}

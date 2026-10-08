// The hands-free capture worklet. It forwards 16 kHz PCM frames to the
// main-thread wake detector and speech endpointer, and posts the level the
// voice indicator reads. Speech endpointing is the endpointer's (Silero VAD,
// `speech_endpoint.ts`); there is no second, energy-threshold copy of it here.
const ENERGY_FRAME_SAMPLES = 960;
const WAKE_FRAME_SAMPLES = 1_280;

class HandsFreeProcessor extends AudioWorkletProcessor {
	private samples = 0;
	private energy = 0;
	private wakeFrame = new Float32Array(WAKE_FRAME_SAMPLES);
	private wakeFrameSamples = 0;

	process(inputs: Float32Array[][]): boolean {
		const channel = inputs[0]?.[0];
		if (!channel) return true;
		for (let index = 0; index < channel.length; index += 1) {
			const sample = channel[index];
			this.wakeFrame[this.wakeFrameSamples++] = sample;
			this.energy += sample * sample;
			this.samples += 1;
			if (this.wakeFrameSamples === WAKE_FRAME_SAMPLES) {
				const frame = this.wakeFrame;
				this.wakeFrame = new Float32Array(WAKE_FRAME_SAMPLES);
				this.wakeFrameSamples = 0;
				this.port.postMessage({ type: "audio", samples: frame }, [
					frame.buffer,
				]);
			}
			if (this.samples < ENERGY_FRAME_SAMPLES) continue;
			this.port.postMessage({
				type: "energy",
				energy: Math.sqrt(this.energy / this.samples),
				time: currentTime * 1000,
			});
			this.samples = 0;
			this.energy = 0;
		}
		return true;
	}
}

registerProcessor("hands-free-vad", HandsFreeProcessor);

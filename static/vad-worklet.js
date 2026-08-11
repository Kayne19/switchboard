"use strict";
const VAD_FRAME_SAMPLES = 960;
const WAKE_FRAME_SAMPLES = 1_280;
const MIN_ENERGY = 0.008;
class HandsFreeProcessor extends AudioWorkletProcessor {
    samples = 0;
    energy = 0;
    noiseFloor = MIN_ENERGY;
    speaking = false;
    silenceMs = 0;
    wakeFrame = new Float32Array(WAKE_FRAME_SAMPLES);
    wakeFrameSamples = 0;
    constructor() {
        super();
        this.port.onmessage = (event) => {
            if (event.data?.type === "reset_endpoint")
                this.resetEndpoint();
        };
    }
    resetEndpoint() {
        this.samples = 0;
        this.energy = 0;
        this.speaking = false;
        this.silenceMs = 0;
    }
    process(inputs) {
        const channel = inputs[0]?.[0];
        if (!channel)
            return true;
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
            if (this.samples < VAD_FRAME_SAMPLES)
                continue;
            const rms = Math.sqrt(this.energy / this.samples);
            const threshold = Math.max(MIN_ENERGY, this.noiseFloor * 2.8);
            const voiced = rms > threshold;
            if (!this.speaking && !voiced) {
                this.noiseFloor = this.noiseFloor * 0.92 + rms * 0.08;
            }
            if (voiced) {
                this.silenceMs = 0;
                if (!this.speaking) {
                    this.speaking = true;
                    this.port.postMessage({ type: "speech_start" });
                }
            }
            else if (this.speaking) {
                this.silenceMs += (this.samples / sampleRate) * 1000;
                if (this.silenceMs >= 900) {
                    this.speaking = false;
                    this.silenceMs = 0;
                    this.port.postMessage({ type: "speech_end" });
                }
            }
            this.port.postMessage({
                type: "energy",
                energy: rms,
                time: currentTime * 1000,
            });
            this.samples = 0;
            this.energy = 0;
        }
        return true;
    }
}
registerProcessor("hands-free-vad", HandsFreeProcessor);

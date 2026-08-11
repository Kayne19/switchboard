import WakeWordEngine from "openwakeword-wasm-browser";
import { WakeWordDetectorAdapter } from "./wake_detector.js";
export function createWakeWordDetector() {
    const engine = new WakeWordEngine({
        baseAssetUrl: "/openwakeword/models",
        ortWasmPath: "/openwakeword/ort/",
        keywords: ["hey_jarvis"],
        detectionThreshold: 0.5,
        cooldownMs: 2_000,
        executionProviders: ["wasm"],
    });
    const packageEngine = engine;
    return new WakeWordDetectorAdapter({
        load: () => packageEngine.load(),
        reset: () => packageEngine._resetState(),
        processChunk: (samples) => packageEngine._processChunk(samples),
        on: (event, callback) => packageEngine.on(event, callback),
    });
}

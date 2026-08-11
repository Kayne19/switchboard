import WakeWordEngine from "openwakeword-wasm-browser";
import { WakeWordDetectorAdapter } from "./wake_detector.js";

export function createWakeWordDetector(): WakeWordDetectorAdapter {
	const engine = new WakeWordEngine({
		baseAssetUrl: "/openwakeword/models",
		ortWasmPath: "/openwakeword/ort/",
		keywords: ["hey_jarvis"],
		detectionThreshold: 0.5,
		cooldownMs: 2_000,
		executionProviders: ["wasm"],
	});
	const packageEngine = engine as unknown as {
		load(): Promise<void>;
		on(
			event: "detect" | "error",
			callback: (payload?: unknown) => void,
		): () => void;
		_resetState(): void;
		_processChunk(samples: Float32Array): Promise<void>;
	};
	return new WakeWordDetectorAdapter({
		load: () => packageEngine.load(),
		reset: () => packageEngine._resetState(),
		processChunk: (samples) => packageEngine._processChunk(samples),
		on: (event, callback) => packageEngine.on(event, callback),
	});
}

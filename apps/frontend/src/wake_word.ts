import { WakeWordEngine } from "openwakeword-wasm-browser";
import { WakeWordDetectorAdapter } from "./wake_detector.js";
import {
	isWakeDetection,
	WAKE_WORD_ENGINE_THRESHOLD,
	WAKE_WORD_MODELS,
} from "./wake_models.js";

export function createWakeWordDetector(): WakeWordDetectorAdapter {
	const keywords = Object.keys(WAKE_WORD_MODELS);
	const engine = new WakeWordEngine({
		baseAssetUrl: "/openwakeword/models",
		ortWasmPath: "/openwakeword/ort/",
		keywords,
		modelFiles: Object.fromEntries(
			keywords.map((keyword) => [keyword, WAKE_WORD_MODELS[keyword].file]),
		),
		detectionThreshold: WAKE_WORD_ENGINE_THRESHOLD,
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
		on: (event, callback) =>
			packageEngine.on(event, (payload) => {
				if (event === "detect" && !isWakeDetection(payload)) return;
				callback(payload);
			}),
	});
}

declare module "openwakeword-wasm-browser" {
	interface WakeWordEngineOptions {
		baseAssetUrl?: string;
		ortWasmPath?: string;
		keywords?: string[];
		detectionThreshold?: number;
		cooldownMs?: number;
		executionProviders?: string[];
	}

	export class WakeWordEngine {
		constructor(options?: WakeWordEngineOptions);
	}
}

declare const sampleRate: number;
declare const currentTime: number;

interface AudioWorkletProcessor {
	readonly port: MessagePort;
	process(
		inputs: Float32Array[][],
		outputs?: Float32Array[][],
		parameters?: Record<string, Float32Array>,
	): boolean;
}

declare const AudioWorkletProcessor: {
	new (options?: Record<string, unknown>): AudioWorkletProcessor;
};

declare function registerProcessor(
	name: string,
	processorCtor: new (
		options?: Record<string, unknown>,
	) => AudioWorkletProcessor,
): void;

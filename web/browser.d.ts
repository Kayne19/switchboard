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

interface TranscriptEntry {
	role: string;
	text: string;
	id?: string;
	route?: string;
	ts?: number;
	pending?: boolean;
}

interface BrowserMessage {
	type?: string;
	id?: string;
	response_id?: string;
	success?: boolean;
	source?: string;
	kind?: string;
	items?: Array<{
		label: string;
		state?: string;
		detail?: string;
		ms?: number;
	}>;
	title?: string;
	notes?: string;
	text?: string;
	message?: string;
	route?: string;
	label?: string;
	model?: string;
	model_name?: string;
	thinking?: string;
	thinking_default?: string;
	thinking_confirmed?: boolean;
	model_swaps?: boolean;
	models_available?: boolean;
	models_diagnostic?: string;
	projects?: string[];
	levels?: string[];
	models?: Array<{ provider: string; model: string; thinks: boolean }>;
	entries?: TranscriptEntry[];
	entry?: TranscriptEntry;
	waiting?: number;
	steered?: boolean;
	generation?: number;
	sequence?: number;
	streaming?: boolean;
	capabilities?: Record<string, boolean>;
	[key: string]: unknown;
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

import * as ort from "onnxruntime-web";
import { WAKE_SAMPLE_RATE } from "./hands_free.js";
import {
	SileroSpeechEndpointer,
	type SpeechProbabilityPort,
} from "./speech_endpoint.js";

const MODEL_URL = "/openwakeword/models/silero_vad.onnx";
const ORT_WASM_PATH = "/openwakeword/ort/";
/**
 * The committed silero_vad.onnx carries the v4 signature: `input` [batch,
 * sequence] and a scalar `sr` in, the recurrent state as `h` and `c` shaped
 * [2, batch, 64], and `output`, `hn`, `cn` out. It is not the v5 single
 * `state` tensor. `apps/frontend/tests/test_hands_free.mjs` reads the
 * committed model's graph and pins these names, so a model swap fails there
 * instead of at a caller's microphone.
 */
const STATE_DIMENSIONS = [2, 1, 64];

function zeroState(): ort.Tensor {
	const size = STATE_DIMENSIONS.reduce((product, dim) => product * dim, 1);
	return new ort.Tensor("float32", new Float32Array(size), STATE_DIMENSIONS);
}

/** The real Silero VAD, on the same ONNX Runtime the wake engine loads. */
class SileroVadModel implements SpeechProbabilityPort {
	private session: ort.InferenceSession | null = null;
	private h = zeroState();
	private c = zeroState();

	async load(): Promise<void> {
		if (this.session) return;
		ort.env.wasm.wasmPaths = ORT_WASM_PATH;
		this.session = await ort.InferenceSession.create(MODEL_URL, {
			executionProviders: ["wasm"],
		});
	}

	reset(): void {
		this.h = zeroState();
		this.c = zeroState();
	}

	async probability(window: Float32Array): Promise<number> {
		const session = this.session;
		if (!session) throw new Error("the speech model is not loaded");
		const results = await session.run({
			input: new ort.Tensor("float32", window, [1, window.length]),
			sr: new ort.Tensor("int64", [BigInt(WAKE_SAMPLE_RATE)], []),
			h: this.h,
			c: this.c,
		});
		this.h = results.hn as ort.Tensor;
		this.c = results.cn as ort.Tensor;
		return Number((results.output.data as Float32Array)[0]);
	}
}

export function createSpeechEndpointer(): SileroSpeechEndpointer {
	return new SileroSpeechEndpointer(new SileroVadModel());
}

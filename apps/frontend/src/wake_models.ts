/**
 * The custom keyword models this page listens for, with the detection
 * threshold each one earned on the validation negatives (see
 * docs/wake-word-training.md). "damo" is one short word close to everyday
 * speech, so it is held to a stricter score than "damocles".
 */
export const WAKE_WORD_MODELS: Record<
	string,
	{ file: string; threshold: number }
> = {
	damocles: { file: "damocles_v0.1.onnx", threshold: 0.5 },
	damo: { file: "damo_v0.1.onnx", threshold: 0.6 },
};

/** The lowest threshold any model accepts; the engine carries only one. */
export const WAKE_WORD_ENGINE_THRESHOLD = Math.min(
	...Object.values(WAKE_WORD_MODELS).map((model) => model.threshold),
);

/**
 * Whether an engine detect payload clears its own model's threshold. The
 * package engine carries one detectionThreshold for every keyword, so it runs
 * at the lowest of ours and every event is held to its model here. A score
 * between the two thresholds is not a detection; it does start the engine's
 * shared cooldown, exactly as a real detection would.
 */
export function isWakeDetection(payload: unknown): boolean {
	const { keyword, score } = (payload ?? {}) as {
		keyword?: string;
		score?: number;
	};
	const model = keyword === undefined ? undefined : WAKE_WORD_MODELS[keyword];
	if (model === undefined || typeof score !== "number") return false;
	return score > model.threshold;
}

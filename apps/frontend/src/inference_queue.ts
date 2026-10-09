/**
 * The page's one ONNX Runtime Web queue. The wake engine and the Silero
 * endpointer load their sessions into the same ONNX Runtime wasm instance,
 * and its `run` is not re-entrant across sessions: while one session's run is
 * awaiting, a second session's run corrupts its inputs and both fail
 * ("failed to call OrtRun(). ERROR_CODE: 2, ERROR_MESSAGE: NULL input
 * supplied for input c"). Each detector queues its own work, but the
 * controller feeds every frame to both, so the two queues interleaved, the
 * first frames after "armed" failed, and hands-free released the microphone
 * and turned itself off in Chromium, Firefox and Safari alike (#213).
 * Every session create and run on the page goes through `runInference`, one
 * at a time, in the order asked.
 */
let tail: Promise<void> = Promise.resolve();

export function runInference<T>(work: () => Promise<T>): Promise<T> {
	const turn = tail.then(work);
	tail = turn.then(
		() => undefined,
		() => undefined,
	);
	return turn;
}

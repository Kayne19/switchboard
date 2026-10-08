import {
	SPEECH_END_PROBABILITY,
	SPEECH_START_PROBABILITY,
	VAD_TRAILING_SILENCE_MS,
	VAD_WINDOW_MS,
	VAD_WINDOW_SAMPLES,
} from "./hands_free.js";

type EndpointCallback = () => void;
type EndpointErrorCallback = (error: unknown) => void;

/**
 * One Silero VAD step. The port owns the model's recurrent state, so a reset
 * reaches the state and not only this adapter's speech flags.
 */
export interface SpeechProbabilityPort {
	load(): Promise<void>;
	reset(): void;
	probability(window: Float32Array): Promise<number>;
}

/**
 * The hands-free speech endpoint. It cuts the controller's 16 kHz PCM frames
 * into Silero's 512-sample windows, scores each one, and reports a speech
 * start and, after VAD_TRAILING_SILENCE_MS below the exit threshold, a speech
 * end. Inference is asynchronous and queued; reset stamps a new generation so
 * a window scored before a PTT pause, a wake grace period, or an epoch change
 * cannot start or end a turn after it.
 */
export class SileroSpeechEndpointer {
	private readonly model: SpeechProbabilityPort;
	private readonly startListeners = new Set<EndpointCallback>();
	private readonly endListeners = new Set<EndpointCallback>();
	private readonly errorListeners = new Set<EndpointErrorCallback>();
	private window = new Float32Array(VAD_WINDOW_SAMPLES);
	private filled = 0;
	private processing = Promise.resolve();
	private generation = 0;
	private speaking = false;
	private silenceMs = 0;
	private loadPromise: Promise<void> | null = null;

	constructor(model: SpeechProbabilityPort) {
		this.model = model;
	}

	load(): Promise<void> {
		if (!this.loadPromise) {
			this.loadPromise = this.model.load().catch((error) => {
				this.loadPromise = null;
				throw error;
			});
		}
		return this.loadPromise;
	}

	reset(): void {
		const generation = ++this.generation;
		this.filled = 0;
		this.speaking = false;
		this.silenceMs = 0;
		this.processing = this.processing.then(() => {
			if (generation === this.generation) this.model.reset();
		});
	}

	process(samples: Float32Array): void {
		for (let index = 0; index < samples.length; index += 1) {
			this.window[this.filled++] = samples[index];
			if (this.filled < VAD_WINDOW_SAMPLES) continue;
			const window = this.window;
			this.window = new Float32Array(VAD_WINDOW_SAMPLES);
			this.filled = 0;
			this.score(window);
		}
	}

	onSpeechStart(callback: EndpointCallback): () => void {
		this.startListeners.add(callback);
		return () => this.startListeners.delete(callback);
	}

	onSpeechEnd(callback: EndpointCallback): () => void {
		this.endListeners.add(callback);
		return () => this.endListeners.delete(callback);
	}

	onError(callback: EndpointErrorCallback): () => void {
		this.errorListeners.add(callback);
		return () => this.errorListeners.delete(callback);
	}

	private score(window: Float32Array): void {
		const generation = this.generation;
		this.processing = this.processing
			.then(async () => {
				if (generation !== this.generation) return;
				const probability = await this.model.probability(window);
				if (generation !== this.generation) return;
				if (!Number.isFinite(probability))
					throw new Error("the speech model returned no probability");
				this.advance(probability);
			})
			.catch((error) => this.emitError(error));
	}

	/** One window's verdict, with hysteresis between the two thresholds. */
	private advance(probability: number): void {
		if (!this.speaking) {
			if (probability < SPEECH_START_PROBABILITY) return;
			this.speaking = true;
			this.silenceMs = 0;
			for (const listener of this.startListeners) listener();
			return;
		}
		if (probability >= SPEECH_END_PROBABILITY) {
			this.silenceMs = 0;
			return;
		}
		this.silenceMs += VAD_WINDOW_MS;
		if (this.silenceMs < VAD_TRAILING_SILENCE_MS) return;
		this.speaking = false;
		this.silenceMs = 0;
		for (const listener of this.endListeners) listener();
	}

	private emitError(error: unknown): void {
		for (const listener of this.errorListeners) listener(error);
	}
}

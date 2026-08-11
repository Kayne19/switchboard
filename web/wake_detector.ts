type DetectorCallback = () => void;
type DetectorErrorCallback = (error: unknown) => void;
type EngineEvent = "detect" | "error";
export interface WakeWordEnginePort {
	load(): Promise<void>;
	reset(): void;
	processChunk(samples: Float32Array): Promise<void>;
	on(event: EngineEvent, callback: (payload?: unknown) => void): () => void;
}

/**
 * Bridges the package's serialized PCM pipeline to the controller-owned audio
 * graph. The package's public start() owns a second microphone graph, so this
 * seam deliberately feeds the package engine one 16 kHz frame at a time.
 */
export class WakeWordDetectorAdapter {
	private readonly engine: WakeWordEnginePort;
	private readonly detectListeners = new Set<DetectorCallback>();
	private readonly errorListeners = new Set<DetectorErrorCallback>();
	private processing = Promise.resolve();
	private generation = 0;
	private processingGeneration: number | null = null;
	private loadPromise: Promise<void> | null = null;

	constructor(engine: WakeWordEnginePort) {
		this.engine = engine;
		this.engine.on("detect", () => {
			if (this.processingGeneration !== this.generation) return;
			for (const listener of this.detectListeners) listener();
		});
		this.engine.on("error", (error) => {
			if (this.processingGeneration === this.generation)
				this.emitError(error);
		});
	}

	load(): Promise<void> {
		if (!this.loadPromise) {
			this.loadPromise = this.engine.load().catch((error) => {
				this.loadPromise = null;
				throw error;
			});
		}
		return this.loadPromise;
	}

	reset(): void {
		const generation = ++this.generation;
		this.processingGeneration = null;
		this.processing = this.processing.then(() => {
			if (generation === this.generation) this.engine.reset();
		});
	}

	process(samples: Float32Array): void {
		const generation = this.generation;
		this.processing = this.processing
			.then(async () => {
				if (generation !== this.generation) return;
				this.processingGeneration = generation;
				try {
					await this.engine.processChunk(samples);
				} finally {
					if (this.processingGeneration === generation)
						this.processingGeneration = null;
				}
			})
			.catch((error) => this.emitError(error));
	}

	onDetect(callback: DetectorCallback): () => void {
		this.detectListeners.add(callback);
		return () => this.detectListeners.delete(callback);
	}

	onError(callback: DetectorErrorCallback): () => void {
		this.errorListeners.add(callback);
		return () => this.errorListeners.delete(callback);
	}

	private emitError(error: unknown): void {
		for (const listener of this.errorListeners) listener(error);
	}
}

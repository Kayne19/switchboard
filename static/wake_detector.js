/**
 * Bridges the package's serialized PCM pipeline to the controller-owned audio
 * graph. The package's public start() owns a second microphone graph, so this
 * seam deliberately feeds the package engine one 16 kHz frame at a time.
 */
export class WakeWordDetectorAdapter {
    engine;
    detectListeners = new Set();
    errorListeners = new Set();
    processing = Promise.resolve();
    generation = 0;
    processingGeneration = null;
    loadPromise = null;
    constructor(engine) {
        this.engine = engine;
        this.engine.on("detect", () => {
            if (this.processingGeneration !== this.generation)
                return;
            for (const listener of this.detectListeners)
                listener();
        });
        this.engine.on("error", (error) => {
            if (this.processingGeneration === this.generation)
                this.emitError(error);
        });
    }
    load() {
        if (!this.loadPromise) {
            this.loadPromise = this.engine.load().catch((error) => {
                this.loadPromise = null;
                throw error;
            });
        }
        return this.loadPromise;
    }
    reset() {
        const generation = ++this.generation;
        this.processingGeneration = null;
        this.processing = this.processing.then(() => {
            if (generation === this.generation)
                this.engine.reset();
        });
    }
    process(samples) {
        const generation = this.generation;
        this.processing = this.processing
            .then(async () => {
            if (generation !== this.generation)
                return;
            this.processingGeneration = generation;
            try {
                await this.engine.processChunk(samples);
            }
            finally {
                if (this.processingGeneration === generation)
                    this.processingGeneration = null;
            }
        })
            .catch((error) => this.emitError(error));
    }
    onDetect(callback) {
        this.detectListeners.add(callback);
        return () => this.detectListeners.delete(callback);
    }
    onError(callback) {
        this.errorListeners.add(callback);
        return () => this.errorListeners.delete(callback);
    }
    emitError(error) {
        for (const listener of this.errorListeners)
            listener(error);
    }
}

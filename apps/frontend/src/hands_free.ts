function normalizeAudioEnergy(energy: number): number {
	return Number.isFinite(energy) ? Math.max(0, Math.min(1, energy * 8)) : 0;
}

export const WAKE_PHRASE = "Damocles";
export const WAKE_SAMPLE_RATE = 16_000;
export const WAKE_FRAME_SAMPLES = 1_280;
export const VAD_TRAILING_SILENCE_MS = 900;
/** Silero VAD's window at 16 kHz, and the 32 ms of audio it scores. */
export const VAD_WINDOW_SAMPLES = 512;
export const VAD_WINDOW_MS = (VAD_WINDOW_SAMPLES / WAKE_SAMPLE_RATE) * 1_000;
/** Speech starts at the first threshold and only ends below the second. */
export const SPEECH_START_PROBABILITY = 0.5;
export const SPEECH_END_PROBABILITY = 0.35;
export const WAKE_SPEECH_GRACE_MS = 2_000;
export const MAX_HANDS_FREE_UTTERANCE_MS = 30_000;
export const FOLLOW_UP_LEASE_MS = 8_000;
/** How long a start waits for a suspended audio context to run. */
export const AUDIO_RESUME_DEADLINE_MS = 3_000;
export const PLAYBACK_DRAIN_DEBOUNCE_MS = 400;

type Timer = ReturnType<typeof setTimeout>;

type DetectorCallback = () => void;
type DetectorErrorCallback = (error: unknown) => void;

export type HandsFreeState =
	| "off"
	| "starting"
	| "armed"
	| "wake_grace"
	| "capturing"
	| "awaiting_response"
	| "lease"
	| "lease_capturing"
	| "paused_ptt"
	| "error";

export interface WakeDetector {
	load?(): Promise<void>;
	reset(): void;
	process(samples: Float32Array): void;
	onDetect(callback: DetectorCallback): () => void;
	onError?(callback: DetectorErrorCallback): () => void;
}

/**
 * The speech endpoint detector: the same 16 kHz PCM frames in, a speech start
 * and a speech end out. `silero_vad.ts` is the implementation; there is no
 * energy-threshold fallback (`docs/architecture.md` rule 9).
 */
export interface SpeechEndpointer {
	load?(): Promise<void>;
	reset(): void;
	process(samples: Float32Array): void;
	onSpeechStart(callback: DetectorCallback): () => void;
	onSpeechEnd(callback: DetectorCallback): () => void;
	onError?(callback: DetectorErrorCallback): () => void;
}

export interface HandsFreeStateDetail {
	state: HandsFreeState;
	message: string;
	leaseRemainingMs: number;
}

export interface HandsFreeControllerOptions {
	getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
	createAudioContext?: () => AudioContext;
	createRecorder?: (stream: MediaStream, mime: string) => MediaRecorder;
	createWorkletNode?: (context: AudioContext) => AudioWorkletNode;
	wakeDetector?: WakeDetector;
	speechEndpointer?: SpeechEndpointer;
	workletUrl?: string;
	now?: () => number;
	setTimeout?: (handler: () => void, timeout: number) => Timer;
	clearTimeout?: (timer: Timer) => void;
	isForeground?: () => boolean;
	isSnapshotReady: () => boolean;
	currentEpoch: () => number;
	isPttActive: () => boolean;
	/** Takes a finished utterance; false when the page could not send it. */
	onClip: (audio: Blob, mime: string, epoch: number) => boolean;
	onAudioLevel?: (level: number) => void;
	onState: (detail: HandsFreeStateDetail) => void;
}

interface Capture {
	recorder: MediaRecorder;
	token: number;
	epoch: number;
	chunks: Blob[];
	lease: boolean;
}

/** A start's audio context did not run by `AUDIO_RESUME_DEADLINE_MS`. */
class AudioSuspended extends Error {
	constructor() {
		super("the audio context did not start");
		this.name = "AudioSuspended";
	}
}

function isRunning(context: AudioContext): boolean {
	return context.state === "running";
}

/** Stops what a start made and never installed. */
function releaseUnused(
	context: AudioContext | null,
	stream: MediaStream | null,
): void {
	stream?.getTracks().forEach((track) => track.stop());
	if (context) void context.close().catch(() => undefined);
}

export class HandsFreeController {
	private readonly options: HandsFreeControllerOptions;
	private readonly getUserMedia: NonNullable<
		HandsFreeControllerOptions["getUserMedia"]
	>;
	private readonly createAudioContext: NonNullable<
		HandsFreeControllerOptions["createAudioContext"]
	>;
	private readonly createRecorder: NonNullable<
		HandsFreeControllerOptions["createRecorder"]
	>;
	private readonly createWorkletNode: NonNullable<
		HandsFreeControllerOptions["createWorkletNode"]
	>;
	private readonly now: NonNullable<HandsFreeControllerOptions["now"]>;
	private readonly setTimer: NonNullable<
		HandsFreeControllerOptions["setTimeout"]
	>;
	private readonly clearTimer: NonNullable<
		HandsFreeControllerOptions["clearTimeout"]
	>;
	private readonly isForeground: NonNullable<
		HandsFreeControllerOptions["isForeground"]
	>;
	private readonly detector: WakeDetector | null;
	private readonly endpointer: SpeechEndpointer | null;
	private state: HandsFreeState = "off";
	private enabled = false;
	private runtimeToken = 0;
	private wakeTimer: Timer | null = null;
	private leaseTimer: Timer | null = null;
	private leaseTickTimer: Timer | null = null;
	private leaseDeadline = 0;
	private leaseUsed = false;
	private capture: Capture | null = null;
	private stream: MediaStream | null = null;
	private context: AudioContext | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private worklet: AudioWorkletNode | null = null;
	private sink: GainNode | null = null;
	private pausedForPtt = false;

	constructor(options: HandsFreeControllerOptions) {
		this.options = options;
		this.getUserMedia =
			options.getUserMedia ||
			((constraints) => navigator.mediaDevices.getUserMedia(constraints));
		this.createAudioContext =
			options.createAudioContext ||
			(() => new AudioContext({ sampleRate: WAKE_SAMPLE_RATE }));
		this.createRecorder =
			options.createRecorder ||
			((stream, mime) =>
				mime
					? new MediaRecorder(stream, { mimeType: mime })
					: new MediaRecorder(stream));
		this.createWorkletNode =
			options.createWorkletNode ||
			((context) => new AudioWorkletNode(context, "hands-free-vad"));
		this.detector = options.wakeDetector || null;
		this.endpointer = options.speechEndpointer || null;
		this.detector?.onDetect(() => {
			if (this.enabled && this.state === "armed") this.beginWakeGrace();
		});
		this.detector?.onError?.((error) => this.failListening("detector", error));
		this.endpointer?.onSpeechStart(() => {
			if (!this.enabled) return;
			if (this.state === "wake_grace") this.beginCapture(false);
			else if (this.state === "lease") this.beginCapture(true);
		});
		this.endpointer?.onSpeechEnd(() => {
			if (this.enabled && this.capture) this.stopCapture(false);
		});
		this.endpointer?.onError?.((error) =>
			this.failListening("speech detector", error),
		);
		this.now = options.now || (() => Date.now());
		this.setTimer =
			options.setTimeout ||
			((handler, timeout) => setTimeout(handler, timeout));
		this.clearTimer = options.clearTimeout || ((timer) => clearTimeout(timer));
		this.isForeground =
			options.isForeground || (() => document.visibilityState === "visible");
		this.publish("off", "Hands-free is off.");
	}

	get currentState(): HandsFreeState {
		return this.state;
	}

	get isEnabled(): boolean {
		return this.enabled;
	}

	get isCapturing(): boolean {
		return this.capture !== null;
	}

	async enable(): Promise<boolean> {
		if (this.enabled && this.state !== "error" && this.state !== "paused_ptt")
			return true;
		if (this.options.isPttActive() || !this.isForeground())
			return this.refuseStart(
				"Finish push-to-talk and keep this page visible first.",
			);
		if (!this.supported())
			return this.refuseStart(
				"Hands-free needs a secure browser with local audio worklet support.",
			);
		if (!this.detector || !this.endpointer)
			return this.refuseStart(
				this.detector
					? "Hands-free speech detector is unavailable."
					: "Hands-free wake detector is unavailable.",
			);
		this.enabled = true;
		this.publish(
			"starting",
			"Starting local microphone listening. Ambient audio stays on this device.",
		);
		const token = ++this.runtimeToken;
		// What this start makes stays in locals until its last wait is over.
		// A start that a newer one overtook (push-to-talk paused and resumed
		// it, the page was hidden and shown) then releases only what it made,
		// never the newer start's graph (#261).
		let context: AudioContext | null = null;
		let stream: MediaStream | null = null;
		let installed = false;
		try {
			// Two models, one wait: either one failing is the same start
			// failure, reported by the catch below.
			await Promise.all([this.detector.load?.(), this.endpointer.load?.()]);
			if (!this.enabled || token !== this.runtimeToken) return false;
			context = this.createAudioContext();
			if (typeof context.audioWorklet?.addModule !== "function")
				throw new Error("audio worklet is unavailable");
			stream = await this.getUserMedia({ audio: true });
			if (
				!this.enabled ||
				token !== this.runtimeToken ||
				!this.isForeground()
			) {
				releaseUnused(context, stream);
				return false;
			}
			await this.resumeAudio(context);
			await context.audioWorklet.addModule(
				this.options.workletUrl || "/vad-worklet.js",
			);
			if (!this.enabled || token !== this.runtimeToken) {
				releaseUnused(context, stream);
				return false;
			}
			this.context = context;
			this.stream = stream;
			installed = true;
			this.source = context.createMediaStreamSource(stream);
			this.worklet = this.createWorkletNode(context);
			const worklet = this.worklet;
			worklet.port.onmessage = (event: MessageEvent) => {
				if (token !== this.runtimeToken || worklet !== this.worklet) return;
				this.onWorkletMessage(event.data);
			};
			this.source.connect(worklet);
			this.sink = context.createGain();
			this.sink.gain.value = 0;
			worklet.connect(this.sink);
			this.sink.connect(context.destination);
			this.resetListening();
			this.publish("armed", `Listening locally for “${WAKE_PHRASE}”.`);
			return true;
		} catch (error) {
			if (!installed) releaseUnused(context, stream);
			if (!this.enabled || token !== this.runtimeToken) return false;
			this.enabled = false;
			this.releaseRuntime();
			this.resetListening();
			this.publish(
				"error",
				`Hands-free could not start (${this.errorName(error)}).`,
			);
			return false;
		}
	}

	/**
	 * Resumes a suspended context, but not forever. WebKit can leave
	 * `resume()` pending while the audio session is interrupted (#183), and a
	 * start that waited on it never finished (#261). A context that is not
	 * running by the deadline fails the start, which says so.
	 */
	private async resumeAudio(context: AudioContext): Promise<void> {
		if (context.state !== "suspended") return;
		const resumed = context.resume();
		// A rejection after the deadline has nobody waiting for it.
		resumed.catch(() => undefined);
		let expire: () => void = () => undefined;
		const deadline = new Promise<void>((resolve) => {
			expire = resolve;
		});
		const timer = this.setTimer(() => expire(), AUDIO_RESUME_DEADLINE_MS);
		try {
			await Promise.race([resumed, deadline]);
		} finally {
			this.clearTimer(timer);
		}
		// Read again: `resume()` changes the state the check above narrowed.
		if (!isRunning(context)) throw new AudioSuspended();
	}

	disable(message = "Hands-free is off."): void {
		this.enabled = false;
		this.pausedForPtt = false;
		this.runtimeToken++;
		this.clearWakeTimer();
		this.clearLeaseTimer();
		this.stopCapture(true);
		this.releaseRuntime();
		this.resetListening();
		this.publish("off", message);
	}

	pauseForPtt(): void {
		if (!this.enabled) return;
		this.pausedForPtt = true;
		this.runtimeToken++;
		this.clearWakeTimer();
		this.stopCapture(true);
		this.releaseRuntime();
		this.resetListening();
		this.publish("paused_ptt", "Hands-free paused for push-to-talk.");
	}

	resumeAfterPtt(): void {
		if (!this.pausedForPtt || !this.enabled) return;
		this.pausedForPtt = false;
		void this.enable();
	}

	openFollowUpLease(generation: number): void {
		if (
			!this.enabled ||
			this.pausedForPtt ||
			generation !== this.options.currentEpoch() ||
			!this.options.isSnapshotReady() ||
			this.state === "error"
		)
			return;
		this.clearLeaseTimer();
		this.endpointer?.reset();
		this.leaseUsed = false;
		this.leaseDeadline = this.now() + FOLLOW_UP_LEASE_MS;
		this.leaseTimer = this.setTimer(
			() => this.expireLease(),
			FOLLOW_UP_LEASE_MS,
		);
		this.scheduleLeaseUpdate();
		this.publish(
			"lease",
			"Follow-up listening is open for 8 seconds. No wake word needed.",
		);
	}

	/**
	 * The turn hands-free is waiting on will bring no reply: the server
	 * refused the clip, or the reply could not be produced. Only a successful
	 * reply opens the follow-up lease, so without this the controller would
	 * wait in `awaiting_response`, where no wake word is heard (#258).
	 */
	endAwaitedTurn(): void {
		if (!this.enabled || this.state !== "awaiting_response") return;
		this.rearm(`No reply is coming; listening locally for “${WAKE_PHRASE}”.`);
	}

	epochChanged(): void {
		if (!this.enabled) return;
		this.disable("Hands-free stopped because the call changed.");
	}

	private supported(): boolean {
		return (
			window.isSecureContext &&
			typeof navigator.mediaDevices?.getUserMedia === "function" &&
			typeof AudioContext !== "undefined" &&
			typeof AudioWorkletNode !== "undefined" &&
			typeof MediaRecorder !== "undefined" &&
			this.recordingMime() !== ""
		);
	}

	private recordingMime(): string {
		const candidates = [
			"audio/webm;codecs=opus",
			"audio/ogg;codecs=opus",
			"audio/mp4",
		];
		return candidates.find((mime) => MediaRecorder.isTypeSupported(mime)) || "";
	}

	private onWorkletMessage(value: unknown): void {
		if (!value || typeof value !== "object") return;
		const message = value as {
			type?: string;
			energy?: number;
			time?: number;
			samples?: unknown;
		};
		if (message.type === "energy") {
			if (typeof message.energy !== "number") return;
			this.options.onAudioLevel?.(normalizeAudioEnergy(message.energy));
			return;
		}
		if (message.type === "audio") {
			if (!(message.samples instanceof Float32Array)) return;
			// The endpointer scores every frame; the wake detector only runs
			// while a wake word could still open a turn.
			this.endpointer?.process(message.samples);
			if (this.state === "armed" || this.state === "wake_grace")
				this.detector?.process(message.samples);
		}
	}

	private beginWakeGrace(): void {
		if (this.state !== "armed") return;
		this.endpointer?.reset();
		this.clearWakeTimer();
		this.wakeTimer = this.setTimer(() => {
			this.wakeTimer = null;
			if (this.state === "wake_grace")
				this.rearm(
					`Wake heard; speak within ${WAKE_SPEECH_GRACE_MS / 1000} seconds.`,
				);
		}, WAKE_SPEECH_GRACE_MS);
		this.publish("wake_grace", "Wake word heard. Speak now.");
	}

	private beginCapture(lease: boolean): void {
		if (!this.enabled || this.capture || !this.options.isSnapshotReady())
			return;
		if (this.options.isPttActive()) return;
		const epoch = this.options.currentEpoch();
		const token = this.runtimeToken;
		let recorder: MediaRecorder;
		try {
			const mime = this.recordingMime();
			if (!mime) throw new Error("no supported recording MIME type");
			recorder = this.createRecorder(this.stream!, mime);
		} catch (error) {
			this.publish(
				"error",
				`Hands-free recording is unavailable (${this.errorName(error)}).`,
			);
			this.disable();
			return;
		}
		const capture: Capture = {
			recorder,
			token,
			epoch,
			chunks: [],
			lease,
		};
		this.capture = capture;
		if (lease) this.leaseUsed = true;
		recorder.ondataavailable = (event) => {
			if (this.capture !== capture || token !== this.runtimeToken) return;
			if (event.data.size) capture.chunks.push(event.data);
		};
		recorder.onstop = () => {
			if (this.capture !== capture || token !== this.runtimeToken) return;
			this.capture = null;
			// Nothing was sent, so no reply will come: listen for the wake
			// word again, after a follow-up as after a wake word (#258).
			if (!capture.chunks.length) {
				this.rearm("No utterance was retained.");
				return;
			}
			const blob = new Blob(capture.chunks, {
				type: recorder.mimeType || "audio/webm",
			});
			capture.chunks.length = 0;
			if (!this.options.onClip(blob, blob.type, capture.epoch)) {
				this.rearm("The utterance could not be sent; say the wake word again.");
				return;
			}
			this.publish(
				"awaiting_response",
				"Utterance sent; waiting for the response.",
			);
		};
		recorder.onerror = (event) => {
			if (this.capture !== capture || token !== this.runtimeToken) return;
			this.capture = null;
			this.publish(
				"error",
				`Hands-free recording failed (${this.errorName(event.error)}).`,
			);
			this.disable();
		};
		try {
			recorder.start();
		} catch (error) {
			this.capture = null;
			this.publish(
				"error",
				`Hands-free recording failed (${this.errorName(error)}).`,
			);
			this.disable();
			return;
		}
		this.clearWakeTimer();
		this.publish(
			lease ? "lease_capturing" : "capturing",
			"Capturing speech locally; silence will end it.",
		);
		this.setTimer(() => {
			if (this.capture === capture && token === this.runtimeToken)
				this.stopCapture(false);
		}, MAX_HANDS_FREE_UTTERANCE_MS);
	}

	/**
	 * Ends the current capture. A discarded capture is retired here, before
	 * the recorder is asked to stop: every caller that discards has already
	 * moved `runtimeToken` on, so the recorder's `onstop` would see a stale
	 * token and leave the capture in place for good (#256). A capture that is
	 * no longer `this.capture` is retired: its recorder's events are ignored.
	 */
	private stopCapture(discard: boolean): void {
		const capture = this.capture;
		if (!capture) return;
		if (discard) this.capture = null;
		if (capture.recorder.state !== "inactive") {
			try {
				capture.recorder.stop();
			} catch {
				this.capture = null;
			}
		} else {
			this.capture = null;
		}
	}

	private expireLease(): void {
		this.leaseTimer = null;
		if (this.leaseTickTimer !== null) this.clearTimer(this.leaseTickTimer);
		this.leaseTickTimer = null;
		this.leaseDeadline = 0;
		if (this.capture) this.capture.lease = false;
		this.leaseUsed = true;
		if (this.state === "lease") {
			// Every way back to `armed` starts the detectors from silence. The
			// wake detector was last fed before the turn this lease follows, so
			// its window still holds that audio, often the wake word itself
			// (#367).
			this.rearm("Follow-up window closed; wake word required again.");
		} else if (this.state === "lease_capturing") {
			this.publish(
				"capturing",
				"Follow-up window closed; finishing the current utterance.",
			);
		}
	}

	private clearWakeTimer(): void {
		if (this.wakeTimer !== null) this.clearTimer(this.wakeTimer);
		this.wakeTimer = null;
	}

	private clearLeaseTimer(): void {
		if (this.leaseTimer !== null) this.clearTimer(this.leaseTimer);
		if (this.leaseTickTimer !== null) this.clearTimer(this.leaseTickTimer);
		this.leaseTimer = null;
		this.leaseTickTimer = null;
		this.leaseDeadline = 0;
	}

	private scheduleLeaseUpdate(): void {
		this.leaseTickTimer = this.setTimer(() => {
			this.leaseTickTimer = null;
			if (this.leaseDeadline <= 0 || this.leaseUsed) return;
			if (this.state === "lease" || this.state === "lease_capturing") {
				this.publish(
					this.state,
					"Follow-up listening is open for 8 seconds. No wake word needed.",
				);
				this.scheduleLeaseUpdate();
			}
		}, 250);
	}

	private releaseStream(): void {
		this.stream?.getTracks().forEach((track) => track.stop());
		this.stream = null;
	}

	private releaseRuntime(): void {
		this.worklet?.port.close();
		this.worklet?.disconnect();
		this.source?.disconnect();
		this.sink?.disconnect();
		this.worklet = null;
		this.source = null;
		this.sink = null;
		this.releaseStream();
		this.options.onAudioLevel?.(0);
		const context = this.context;
		this.context = null;
		if (context) void context.close().catch(() => undefined);
	}

	private publish(state: HandsFreeState, message: string): void {
		this.state = state;
		this.options.onState({
			state,
			message,
			leaseRemainingMs: Math.max(0, this.leaseDeadline - this.now()),
		});
	}

	/**
	 * A start that cannot begin leaves the controller off. A refused resume
	 * after push-to-talk was still enabled, and the page shows `error` as
	 * hands-free off: unless the controller is off too, the next MODE tap
	 * reads `isEnabled` and turns "off" what the caller already sees as off
	 * (#257).
	 */
	private refuseStart(message: string): false {
		this.enabled = false;
		this.publish("error", message);
		return false;
	}

	/** A detector that failed stops hands-free and says which one it was. */
	private failListening(what: string, error: unknown): void {
		if (!this.enabled) return;
		this.enabled = false;
		this.runtimeToken++;
		this.clearWakeTimer();
		this.clearLeaseTimer();
		this.stopCapture(true);
		this.releaseRuntime();
		this.resetListening();
		this.publish(
			"error",
			`Hands-free ${what} failed (${this.errorName(error)}).`,
		);
	}

	/**
	 * Back to waiting for the wake word after a turn, or a wake word, that
	 * came to nothing. The detectors start from silence, so audio from before
	 * cannot open the next turn.
	 */
	private rearm(message: string): void {
		this.resetListening();
		this.publish("armed", message);
	}

	/** Both detectors forget the audio before this moment. */
	private resetListening(): void {
		this.detector?.reset();
		this.endpointer?.reset();
	}

	private errorName(error: unknown): string {
		return error instanceof Error ? error.name : "unknown error";
	}
}

import {
	type Attempt,
	type Capture,
	type Countdown,
	type Effect,
	type Graph,
	type GraphParts,
	type HandsFreeEvent,
	type PageReads,
	type Phase,
	type Timer,
	OFF_MESSAGE,
	WAKE_PHRASE,
	captureOf,
	countdown,
	graceOf,
	graphOf,
	isEnabled,
	leaseOf,
	next,
	tickOf,
	view,
} from "./hands_free_machine.js";

// The wake phrase and the lifecycle's own timings are written in the machine
// that uses them; the rest of the page reads them from here.
export {
	FOLLOW_UP_LEASE_MS,
	MAX_HANDS_FREE_UTTERANCE_MS,
	WAKE_PHRASE,
	WAKE_SPEECH_GRACE_MS,
} from "./hands_free_machine.js";

function normalizeAudioEnergy(energy: number): number {
	return Number.isFinite(energy) ? Math.max(0, Math.min(1, energy * 8)) : 0;
}

export const WAKE_SAMPLE_RATE = 16_000;
export const WAKE_FRAME_SAMPLES = 1_280;
export const VAD_TRAILING_SILENCE_MS = 900;
/** Silero VAD's window at 16 kHz, and the 32 ms of audio it scores. */
export const VAD_WINDOW_SAMPLES = 512;
export const VAD_WINDOW_MS = (VAD_WINDOW_SAMPLES / WAKE_SAMPLE_RATE) * 1_000;
/** Speech starts at the first threshold and only ends below the second. */
export const SPEECH_START_PROBABILITY = 0.5;
export const SPEECH_END_PROBABILITY = 0.35;
/** How long a start waits for a suspended audio context to run. */
export const AUDIO_RESUME_DEADLINE_MS = 3_000;
export const PLAYBACK_DRAIN_DEBOUNCE_MS = 400;

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

/** Takes down what a graph, or a start that did not finish one, holds. */
function releaseGraph(parts: GraphParts): void {
	parts.worklet?.port.close();
	parts.worklet?.disconnect();
	parts.source?.disconnect();
	parts.sink?.disconnect();
	parts.stream?.getTracks().forEach((track) => track.stop());
	if (parts.context) void parts.context.close().catch(() => undefined);
}

/** An option the controller always has, its default filled in. */
type Option<Name extends keyof HandsFreeControllerOptions> = NonNullable<
	HandsFreeControllerOptions[Name]
>;

export class HandsFreeController {
	private readonly options: HandsFreeControllerOptions;
	private readonly getUserMedia: Option<"getUserMedia">;
	private readonly createAudioContext: Option<"createAudioContext">;
	private readonly createRecorder: Option<"createRecorder">;
	private readonly createWorkletNode: Option<"createWorkletNode">;
	private readonly setTimer: Option<"setTimeout">;
	private readonly clearTimer: Option<"clearTimeout">;
	private readonly isForeground: Option<"isForeground">;
	private readonly detector: WakeDetector | null;
	private readonly endpointer: SpeechEndpointer | null;
	private readonly page: PageReads;
	private phase: Phase = { kind: "off", message: OFF_MESSAGE };

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
		const now = options.now || (() => Date.now());
		this.setTimer =
			options.setTimeout ||
			((handler, timeout) => setTimeout(handler, timeout));
		this.clearTimer = options.clearTimeout || ((timer) => clearTimeout(timer));
		this.isForeground =
			options.isForeground || (() => document.visibilityState === "visible");
		this.page = {
			snapshotReady: () => options.isSnapshotReady(),
			epoch: () => options.currentEpoch(),
			pttActive: () => options.isPttActive(),
			refusal: () => this.refusal(),
			now,
		};
		this.detector = options.wakeDetector || null;
		this.endpointer = options.speechEndpointer || null;
		this.detector?.onDetect(() => this.transition({ kind: "wake" }));
		this.detector?.onError?.((error) =>
			this.transition({ kind: "detectorFailed", what: "detector", error }),
		);
		this.endpointer?.onSpeechStart(() =>
			this.transition({ kind: "speechStart" }),
		);
		this.endpointer?.onSpeechEnd(() => this.transition({ kind: "speechEnd" }));
		this.endpointer?.onError?.((error) =>
			this.transition({
				kind: "detectorFailed",
				what: "speech detector",
				error,
			}),
		);
		this.publish();
	}

	get currentState(): HandsFreeState {
		return view(this.phase, this.page.now()).state;
	}

	get isEnabled(): boolean {
		return isEnabled(this.phase);
	}

	get isCapturing(): boolean {
		return captureOf(this.phase) !== null;
	}

	/** Settles once the start this call began ends: true when hands-free is listening. */
	enable(): Promise<boolean> {
		const before = this.phase;
		this.transition({ kind: "enable" });
		const after = this.phase;
		if (after.kind === "starting" && after !== before)
			return after.attempt.result;
		return Promise.resolve(isEnabled(after));
	}

	disable(message = OFF_MESSAGE): void {
		this.transition({ kind: "turnOff", message });
	}

	pauseForPtt(): void {
		this.transition({ kind: "pttActive", active: true });
	}

	resumeAfterPtt(): void {
		this.transition({ kind: "pttActive", active: false });
	}

	openFollowUpLease(generation: number): void {
		this.transition({ kind: "followUp", generation });
	}

	/**
	 * The turn hands-free is waiting on will bring no reply: the server
	 * refused the clip, or the reply could not be produced. Only a successful
	 * reply opens the follow-up lease, so without this the controller would
	 * wait in `awaiting_response`, where no wake word is heard (#258).
	 */
	endAwaitedTurn(): void {
		this.transition({
			kind: "noReply",
			message: `No reply is coming; listening locally for “${WAKE_PHRASE}”.`,
		});
	}

	epochChanged(): void {
		this.transition({ kind: "callChanged" });
	}

	/**
	 * The only writer of `phase`. The new phase is written before anything
	 * is done about it, so a callback that fires at once (a recorder's `stop`)
	 * sees the phase it belongs to, or is dropped. Then what the old phase
	 * held and the new one does not is released, the step's effects run (no
	 * more once one of them has moved the machine on), and the phase is
	 * published.
	 */
	private transition(event: HandsFreeEvent): void {
		const from = this.phase;
		const step = next(from, event, this.page);
		if (!step) return;
		const to = step.to;
		this.phase = to;
		this.leave(from, to);
		for (const effect of step.effects) {
			if (this.phase !== to) return;
			this.run(effect);
		}
		if (this.phase !== to) return;
		if (step.publish) this.publish();
		if (step.then) this.transition(step.then);
	}

	/** The one teardown: release what `from` holds and `to` does not. */
	private leave(from: Phase, to: Phase): void {
		const grace = graceOf(from);
		if (grace && grace !== graceOf(to)) this.disarm(grace);
		const tick = tickOf(from);
		if (tick && tick !== tickOf(to)) this.disarm(tick);
		const lease = leaseOf(from);
		if (lease && lease !== leaseOf(to)) this.disarm(lease.expiry);
		const capture = captureOf(from);
		if (capture && capture !== captureOf(to)) {
			this.disarm(capture.cap);
			// A capture left by any other way than its recorder's `stop` is
			// discarded: that event, if it comes, names a capture no phase
			// holds (#256).
			if (capture.recorder.state !== "inactive") {
				try {
					capture.recorder.stop();
				} catch {
					/* the recorder is gone with its capture */
				}
			}
		}
		const graph = graphOf(from);
		if (graph && graph !== graphOf(to)) releaseGraph(graph);
	}

	private run(effect: Effect): void {
		switch (effect.kind) {
			case "resetDetectors":
				// Both detectors forget the audio before this moment, so audio
				// from before cannot open the next turn.
				this.detector?.reset();
				this.endpointer?.reset();
				return;
			case "resetEndpointer":
				this.endpointer?.reset();
				return;
			case "silence":
				this.options.onAudioLevel?.(0);
				return;
			case "start":
				void this.buildGraph(effect.attempt);
				return;
			case "arm": {
				const { countdown, event } = effect;
				countdown.handle = this.setTimer(() => {
					countdown.handle = null;
					this.transition(event);
				}, effect.ms);
				return;
			}
			case "openCapture":
				return this.openCapture(effect.graph);
			case "startRecorder":
				try {
					effect.capture.recorder.start();
				} catch (error) {
					this.transition({
						kind: "recorderFailed",
						capture: effect.capture,
						error,
					});
				}
				return;
			case "stopRecorder": {
				const { capture } = effect;
				// A recorder that stopped by itself has its `stop` event on
				// the way, and that event ends the capture.
				if (capture.recorder.state === "inactive") return;
				try {
					capture.recorder.stop();
				} catch (error) {
					this.transition({ kind: "recorderFailed", capture, error });
				}
				return;
			}
			case "keep":
				effect.capture.chunks.push(effect.blob);
				return;
			case "deliver":
				return this.deliver(effect.capture);
			default: {
				const exhaustive: never = effect;
				return exhaustive;
			}
		}
	}

	private disarm(countdown: Countdown): void {
		if (countdown.handle !== null) this.clearTimer(countdown.handle);
		countdown.handle = null;
	}

	private publish(): void {
		this.options.onState(view(this.phase, this.page.now()));
	}

	/** Why a start cannot begin now, or null when it can. */
	private refusal(): string | null {
		if (this.options.isPttActive() || !this.isForeground())
			return "Finish push-to-talk and keep this page visible first.";
		if (!this.supported())
			return "Hands-free needs a secure browser with local audio worklet support.";
		if (!this.detector || !this.endpointer)
			return this.detector
				? "Hands-free speech detector is unavailable."
				: "Hands-free wake detector is unavailable.";
		return null;
	}

	/** Whether `attempt` is the start hands-free still waits on. */
	private isCurrent(attempt: Attempt): boolean {
		return this.phase.kind === "starting" && this.phase.attempt === attempt;
	}

	/**
	 * Builds the listening graph for `attempt`. What it makes stays in its
	 * own `parts` until it hands the graph over in `graphReady`. A start that
	 * a newer one overtook (push-to-talk paused and resumed it, the page was
	 * hidden and shown) then releases only what it made, never the newer
	 * start's graph (#261).
	 */
	private async buildGraph(attempt: Attempt): Promise<void> {
		const parts: GraphParts = {
			context: null,
			stream: null,
			source: null,
			worklet: null,
			sink: null,
		};
		try {
			// Two models, one wait: either one failing is the same start
			// failure, reported by the catch below.
			await Promise.all([this.detector?.load?.(), this.endpointer?.load?.()]);
			if (!this.isCurrent(attempt)) return attempt.finish(false);
			const context = this.createAudioContext();
			parts.context = context;
			if (typeof context.audioWorklet?.addModule !== "function")
				throw new Error("audio worklet is unavailable");
			const stream = await this.getUserMedia({ audio: true });
			parts.stream = stream;
			if (!this.isCurrent(attempt) || !this.isForeground()) {
				releaseGraph(parts);
				return attempt.finish(false);
			}
			await this.resumeAudio(context);
			await context.audioWorklet.addModule(
				this.options.workletUrl || "/vad-worklet.js",
			);
			if (!this.isCurrent(attempt)) {
				releaseGraph(parts);
				return attempt.finish(false);
			}
			const source = context.createMediaStreamSource(stream);
			parts.source = source;
			const worklet = this.createWorkletNode(context);
			parts.worklet = worklet;
			source.connect(worklet);
			const sink = context.createGain();
			parts.sink = sink;
			sink.gain.value = 0;
			worklet.connect(sink);
			sink.connect(context.destination);
			const graph: Graph = { context, stream, source, worklet, sink };
			worklet.port.onmessage = (event: MessageEvent) => {
				if (graphOf(this.phase) === graph) this.onWorkletMessage(event.data);
			};
			this.transition({ kind: "graphReady", attempt, graph });
			attempt.finish(true);
		} catch (error) {
			releaseGraph(parts);
			this.transition({ kind: "startFailed", attempt, error });
			attempt.finish(false);
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
			if (this.phase.kind === "armed" || this.phase.kind === "wake_grace")
				this.detector?.process(message.samples);
		}
	}

	/**
	 * Makes the recorder for an utterance and wires its events to name the
	 * capture. A recorder that cannot be made is reported, not recorded.
	 */
	private openCapture(graph: Graph): void {
		const epoch = this.options.currentEpoch();
		let recorder: MediaRecorder;
		try {
			const mime = this.recordingMime();
			if (!mime) throw new Error("no supported recording MIME type");
			recorder = this.createRecorder(graph.stream, mime);
		} catch (error) {
			this.transition({ kind: "recorderUnavailable", error });
			return;
		}
		const capture: Capture = { recorder, epoch, chunks: [], cap: countdown() };
		recorder.ondataavailable = (event) =>
			this.transition({ kind: "data", capture, blob: event.data });
		recorder.onstop = () => this.transition({ kind: "recorderStopped", capture });
		recorder.onerror = (event) =>
			this.transition({ kind: "recorderFailed", capture, error: event.error });
		this.transition({ kind: "captureOpened", capture });
	}

	/** Hands the finished utterance to the page; one it cannot send brings no reply. */
	private deliver(capture: Capture): void {
		const blob = new Blob(capture.chunks, {
			type: capture.recorder.mimeType || "audio/webm",
		});
		capture.chunks.length = 0;
		if (!this.options.onClip(blob, blob.type, capture.epoch))
			this.transition({
				kind: "noReply",
				message: "The utterance could not be sent; say the wake word again.",
			});
	}
}

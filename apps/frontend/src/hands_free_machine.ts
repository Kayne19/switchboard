// The hands-free lifecycle as data: the phases, the events that move them,
// and the one step function between them. It is pure: it reads the page
// through `PageReads` and returns the next phase with the effects to run.
// `HandsFreeController` (`hands_free.ts`) writes the phase and runs the
// effects; this file touches no browser API.

import type { HandsFreeState, HandsFreeStateDetail } from "./hands_free.js";

export const WAKE_PHRASE = "Damocles";
export const WAKE_SPEECH_GRACE_MS = 2_000;
export const MAX_HANDS_FREE_UTTERANCE_MS = 30_000;
export const FOLLOW_UP_LEASE_MS = 8_000;

export type Timer = ReturnType<typeof setTimeout>;

/** The status line of each phase that has one fixed line. */
export const OFF_MESSAGE = "Hands-free is off.";
const STARTING_MESSAGE =
	"Starting local microphone listening. Ambient audio stays on this device.";
const LISTENING_MESSAGE = `Listening locally for “${WAKE_PHRASE}”.`;
const CAPTURING_MESSAGE = "Capturing speech locally; silence will end it.";
const LEASE_TICK_MS = 250;

/**
 * A timer the machine set. The event it fires names it, so a timer that
 * outlives the phase that set it is dropped.
 */
export interface Countdown {
	handle: Timer | null;
}

/** The 16 kHz listening graph: the microphone through the worklet into a silent sink. */
export interface Graph {
	context: AudioContext;
	stream: MediaStream;
	source: MediaStreamAudioSourceNode;
	worklet: AudioWorkletNode;
	sink: GainNode;
}

/** What a start has made so far; it is the start's own until `graphReady`. */
export type GraphParts = { [Part in keyof Graph]: Graph[Part] | null };

/** One start of the listening graph; `result` settles when it ends. */
export interface Attempt {
	result: Promise<boolean>;
	finish: (armed: boolean) => void;
}

/** One utterance being recorded, stamped with the epoch it began in. */
export interface Capture {
	recorder: MediaRecorder;
	epoch: number;
	chunks: Blob[];
	/** The `MAX_HANDS_FREE_UTTERANCE_MS` cap. */
	cap: Countdown;
}

/** The follow-up lease: one utterance without the wake word, until `deadline`. */
interface Lease {
	deadline: number;
	expiry: Countdown;
}

/** What `capturing` and `finishing` hold. */
interface Recording {
	graph: Graph;
	capture: Capture;
	/** The follow-up lease the capture began in, until it expires. */
	lease: Lease | null;
	message: string;
}

/**
 * Where hands-free is. Each phase holds what exists only in it: every
 * listening phase holds the graph, a wake grace its timer, a capture its
 * recorder, a lease its timers. `capturing` with a lease is published as
 * `lease_capturing`; `finishing` (the recorder asked to stop, its `stop`
 * event not yet fired) is published as the capture it ends.
 */
export type Phase =
	| { kind: "off"; message: string }
	| { kind: "error"; message: string }
	| { kind: "starting"; attempt: Attempt }
	| { kind: "paused_ptt" }
	| { kind: "armed"; graph: Graph; message: string }
	| { kind: "wake_grace"; graph: Graph; grace: Countdown }
	| ({ kind: "capturing" } & Recording)
	| ({ kind: "finishing" } & Recording)
	| { kind: "awaiting_response"; graph: Graph }
	| { kind: "lease"; graph: Graph; lease: Lease; tick: Countdown };

/**
 * What moves hands-free. An event from a start, a recorder or a timer names
 * it, so one that outlives its phase is dropped.
 */
export type HandsFreeEvent =
	| { kind: "enable" }
	| { kind: "turnOff"; message: string }
	| { kind: "callChanged" }
	| { kind: "pttActive"; active: boolean }
	| { kind: "followUp"; generation: number }
	/** The awaited turn brings no reply: refused, failed, or never sent. */
	| { kind: "noReply"; message: string }
	| { kind: "graphReady"; attempt: Attempt; graph: Graph }
	| { kind: "startFailed"; attempt: Attempt; error: unknown }
	| { kind: "detectorFailed"; what: string; error: unknown }
	| { kind: "wake" }
	| { kind: "graceExpired"; grace: Countdown }
	| { kind: "speechStart" }
	| { kind: "captureOpened"; capture: Capture }
	| { kind: "recorderUnavailable"; error: unknown }
	| { kind: "speechEnd" }
	| { kind: "capped"; capture: Capture }
	| { kind: "data"; capture: Capture; blob: Blob }
	| { kind: "recorderStopped"; capture: Capture }
	| { kind: "recorderFailed"; capture: Capture; error: unknown }
	| { kind: "leaseExpired"; lease: Lease }
	| { kind: "leaseTick"; tick: Countdown };

/** What a step asks the runner to do once the new phase is written. */
export type Effect =
	| { kind: "resetDetectors" }
	| { kind: "resetEndpointer" }
	/** The voice indicator falls to zero. */
	| { kind: "silence" }
	| { kind: "start"; attempt: Attempt }
	| { kind: "arm"; countdown: Countdown; ms: number; event: HandsFreeEvent }
	| { kind: "openCapture"; graph: Graph }
	| { kind: "startRecorder"; capture: Capture }
	| { kind: "stopRecorder"; capture: Capture }
	| { kind: "keep"; capture: Capture; blob: Blob }
	| { kind: "deliver"; capture: Capture };

/**
 * One step: the phase to write, the effects to run after it, whether to
 * publish it, and an event the machine sends itself once it is published.
 */
interface Step {
	to: Phase;
	effects: Effect[];
	publish: boolean;
	then: HandsFreeEvent | null;
}

/** What a step may read from the page. It writes nothing. */
export interface PageReads {
	snapshotReady(): boolean;
	epoch(): number;
	pttActive(): boolean;
	/** Why a start cannot begin now, or null when it can. */
	refusal(): string | null;
	now(): number;
}

const RESET: Effect = { kind: "resetDetectors" };
const QUIET: Effect[] = [{ kind: "silence" }, RESET];

function go(
	to: Phase,
	effects: Effect[] = [],
	then: HandsFreeEvent | null = null,
): Step {
	return { to, effects, publish: true, then };
}

/** A step that writes `to` without publishing it. */
function quietly(to: Phase, effects: Effect[]): Step {
	return { to, effects, publish: false, then: null };
}

export function countdown(): Countdown {
	return { handle: null };
}

function newAttempt(): Attempt {
	let finish: (armed: boolean) => void = () => undefined;
	const result = new Promise<boolean>((resolve) => {
		finish = resolve;
	});
	return { result, finish };
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown error";
}

export function isEnabled(phase: Phase): boolean {
	return phase.kind !== "off" && phase.kind !== "error";
}

export function graphOf(phase: Phase): Graph | null {
	return "graph" in phase ? phase.graph : null;
}

export function captureOf(phase: Phase): Capture | null {
	return "capture" in phase ? phase.capture : null;
}

export function leaseOf(phase: Phase): Lease | null {
	return "lease" in phase ? phase.lease : null;
}

export function graceOf(phase: Phase): Countdown | null {
	return phase.kind === "wake_grace" ? phase.grace : null;
}

export function tickOf(phase: Phase): Countdown | null {
	return phase.kind === "lease" ? phase.tick : null;
}

const TURN_OFF: HandsFreeEvent = { kind: "turnOff", message: OFF_MESSAGE };

function arm(countdown: Countdown, ms: number, event: HandsFreeEvent): Effect {
	return { kind: "arm", countdown, ms, event };
}

/** A start begins, or the page refuses it and says why. */
function startOrRefuse(page: PageReads): Step {
	const refusal = page.refusal();
	if (refusal) return go({ kind: "error", message: refusal });
	const attempt = newAttempt();
	return go({ kind: "starting", attempt }, [{ kind: "start", attempt }]);
}

/** Waiting for the wake word, both detectors starting from silence. */
function listen(graph: Graph, message: string): Step {
	return go({ kind: "armed", graph, message }, [RESET]);
}

/** Hands-free stops listening and says what failed. */
function fail(what: string, error: unknown): Step {
	const message = `Hands-free ${what} (${errorName(error)}).`;
	return go({ kind: "error", message }, QUIET);
}

/**
 * A recorder that cannot be made, started or stopped, or that reports an
 * error. Today it says so, then turns hands-free off over it.
 */
function failRecording(what: string, error: unknown): Step {
	const message = `Hands-free recording ${what} (${errorName(error)}).`;
	return go({ kind: "error", message }, [], TURN_OFF);
}

/**
 * The phase x event table (pinned by `handsFreeLifecycle.test.ts`): the step
 * `event` takes from `phase`, or null when the event changes nothing there.
 * It reads the page and acts on nothing; the runner applies its effects
 * after the new phase is written.
 */
export function next(
	phase: Phase,
	event: HandsFreeEvent,
	page: PageReads,
): Step | null {
	switch (event.kind) {
		case "enable":
			return isEnabled(phase) && phase.kind !== "paused_ptt"
				? null
				: startOrRefuse(page);
		case "turnOff":
			return go({ kind: "off", message: event.message }, QUIET);
		case "callChanged": {
			const message = "Hands-free stopped because the call changed.";
			return isEnabled(phase) ? go({ kind: "off", message }, QUIET) : null;
		}
		case "pttActive":
			if (event.active)
				return isEnabled(phase) ? go({ kind: "paused_ptt" }, QUIET) : null;
			return phase.kind === "paused_ptt" ? startOrRefuse(page) : null;
		case "followUp":
			return followUp(phase, event.generation, page);
		case "noReply":
			return phase.kind === "awaiting_response"
				? listen(phase.graph, event.message)
				: null;
		case "graphReady":
			return phase.kind === "starting" && phase.attempt === event.attempt
				? listen(event.graph, LISTENING_MESSAGE)
				: null;
		case "startFailed":
			return phase.kind === "starting" && phase.attempt === event.attempt
				? fail("could not start", event.error)
				: null;
		case "detectorFailed":
			return isEnabled(phase)
				? fail(`${event.what} failed`, event.error)
				: null;
		case "wake": {
			if (phase.kind !== "armed") return null;
			const grace = countdown();
			return go({ kind: "wake_grace", graph: phase.graph, grace }, [
				{ kind: "resetEndpointer" },
				arm(grace, WAKE_SPEECH_GRACE_MS, { kind: "graceExpired", grace }),
			]);
		}
		case "graceExpired":
			return phase.kind === "wake_grace" && phase.grace === event.grace
				? listen(
						phase.graph,
						`Wake heard; speak within ${WAKE_SPEECH_GRACE_MS / 1000} seconds.`,
					)
				: null;
		case "speechStart":
			if (phase.kind !== "wake_grace" && phase.kind !== "lease") return null;
			if (!page.snapshotReady() || page.pttActive()) return null;
			return quietly(phase, [{ kind: "openCapture", graph: phase.graph }]);
		case "captureOpened": {
			if (phase.kind !== "wake_grace" && phase.kind !== "lease") return null;
			const { capture } = event;
			const lease = phase.kind === "lease" ? phase.lease : null;
			return go(
				{ kind: "capturing", graph: phase.graph, capture, lease, message: CAPTURING_MESSAGE },
				[
					{ kind: "startRecorder", capture },
					arm(capture.cap, MAX_HANDS_FREE_UTTERANCE_MS, { kind: "capped", capture }),
				],
			);
		}
		case "recorderUnavailable":
			return phase.kind === "wake_grace" || phase.kind === "lease"
				? failRecording("is unavailable", event.error)
				: null;
		case "speechEnd":
			return phase.kind === "capturing" ? finish(phase) : null;
		case "capped":
			// A capture already finishing ends in its recorder's `stop`
			// event: a second stop changes nothing.
			return phase.kind === "capturing" && phase.capture === event.capture
				? finish(phase)
				: null;
		case "data":
			return captureOf(phase) === event.capture && event.blob.size
				? quietly(phase, [{ kind: "keep", capture: event.capture, blob: event.blob }])
				: null;
		case "recorderStopped":
			if (
				(phase.kind !== "capturing" && phase.kind !== "finishing") ||
				phase.capture !== event.capture
			)
				return null;
			// Nothing was kept, so no reply will come: listen for the wake
			// word again (#258).
			if (!event.capture.chunks.length)
				return listen(phase.graph, "No utterance was retained.");
			return go({ kind: "awaiting_response", graph: phase.graph }, [
				{ kind: "deliver", capture: event.capture },
			]);
		case "recorderFailed":
			return captureOf(phase) === event.capture
				? failRecording("failed", event.error)
				: null;
		case "leaseExpired":
			if (leaseOf(phase) !== event.lease) return null;
			// Back to `armed` from silence, as every way there is (#367).
			if (phase.kind === "lease")
				return listen(
					phase.graph,
					"Follow-up window closed; wake word required again.",
				);
			if (phase.kind === "capturing" || phase.kind === "finishing")
				return go({
					...phase,
					lease: null,
					message: "Follow-up window closed; finishing the current utterance.",
				});
			return null;
		case "leaseTick": {
			if (phase.kind !== "lease" || phase.tick !== event.tick) return null;
			const tick = countdown();
			return go({ ...phase, tick }, [
				arm(tick, LEASE_TICK_MS, { kind: "leaseTick", tick }),
			]);
		}
		default: {
			const exhaustive: never = event;
			return exhaustive;
		}
	}
}

/** The recorder is asked to stop; its `stop` event ends the capture. */
function finish(phase: Phase & { kind: "capturing" }): Step {
	return quietly({ ...phase, kind: "finishing" }, [
		{ kind: "stopRecorder", capture: phase.capture },
	]);
}

/**
 * Opens the follow-up lease where hands-free listens and no capture runs.
 * Not over a start, which has no graph to listen with, and not over a
 * capture, which the lease would claim to be waiting for.
 */
function followUp(
	phase: Phase,
	generation: number,
	page: PageReads,
): Step | null {
	if (generation !== page.epoch() || !page.snapshotReady()) return null;
	switch (phase.kind) {
		case "armed":
		case "wake_grace":
		case "awaiting_response":
		case "lease": {
			const lease: Lease = {
				deadline: page.now() + FOLLOW_UP_LEASE_MS,
				expiry: countdown(),
			};
			const tick = countdown();
			return go({ kind: "lease", graph: phase.graph, lease, tick }, [
				{ kind: "resetEndpointer" },
				arm(lease.expiry, FOLLOW_UP_LEASE_MS, { kind: "leaseExpired", lease }),
				arm(tick, LEASE_TICK_MS, { kind: "leaseTick", tick }),
			]);
		}
		case "off":
		case "error":
		case "starting":
		case "paused_ptt":
		case "capturing":
		case "finishing":
			return null;
		default: {
			const exhaustive: never = phase;
			return exhaustive;
		}
	}
}

function detail(
	state: HandsFreeState,
	message: string,
	leaseRemainingMs = 0,
): HandsFreeStateDetail {
	return { state, message, leaseRemainingMs: Math.max(0, leaseRemainingMs) };
}

/** What the page sees of a phase: the only thing ever published. */
export function view(phase: Phase, now: number): HandsFreeStateDetail {
	switch (phase.kind) {
		case "off":
		case "error":
		case "armed":
			return detail(phase.kind, phase.message);
		case "starting":
			return detail("starting", STARTING_MESSAGE);
		case "paused_ptt":
			return detail("paused_ptt", "Hands-free paused for push-to-talk.");
		case "wake_grace":
			return detail("wake_grace", "Wake word heard. Speak now.");
		case "capturing":
		case "finishing":
			return phase.lease
				? detail("lease_capturing", phase.message, phase.lease.deadline - now)
				: detail("capturing", phase.message);
		case "awaiting_response":
			return detail(
				"awaiting_response",
				"Utterance sent; waiting for the response.",
			);
		case "lease":
			return detail(
				"lease",
				"Follow-up listening is open for 8 seconds. No wake word needed.",
				phase.lease.deadline - now,
			);
		default: {
			const exhaustive: never = phase;
			return exhaustive;
		}
	}
}


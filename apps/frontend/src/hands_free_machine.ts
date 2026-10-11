// The hands-free lifecycle as data: the phases, the events that move them,
// and the one step function between them. It is pure: it reads the page
// through `PageReads` and returns the next state with the effects to run.
// `HandsFreeController` (`hands_free.ts`) writes the state and runs the
// effects; this file touches no browser API.

import type {
	HandsFreeState,
	HandsFreeStateDetail,
	SpeechEndpointer,
	WakeDetector,
} from "./hands_free.js";

export const WAKE_PHRASE = "Damocles";
export const WAKE_SPEECH_GRACE_MS = 2_000;
export const MAX_HANDS_FREE_UTTERANCE_MS = 30_000;
export const FOLLOW_UP_LEASE_MS = 8_000;
/** How long playback must stay drained before a closed reply opens the lease. */
export const PLAYBACK_DRAIN_DEBOUNCE_MS = 400;

export type Timer = ReturnType<typeof setTimeout>;

/** The status line of each phase that has one fixed line. */
export const OFF_MESSAGE = "Hands-free is off.";
const STARTING_MESSAGE =
	"Starting local microphone listening. Ambient audio stays on this device.";
const LISTENING_MESSAGE = `Listening locally for “${WAKE_PHRASE}”.`;
const CAPTURING_MESSAGE = "Capturing speech locally; silence will end it.";
const LOADING_MESSAGE = "Loading the local wake-word and speech detectors...";
const NO_REPLY_MESSAGE = `No reply is coming; listening locally for “${WAKE_PHRASE}”.`;
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

/** The wake-word detector and the speech endpointer. */
export interface Detectors {
	wake: WakeDetector | null;
	speech: SpeechEndpointer | null;
}

/** One load of the detectors; the event it ends in names it. */
export interface Load {
	readonly kind: "load";
}

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
	/** The first MODE: the detectors are loading; published as `starting`. */
	| { kind: "loading"; load: Load }
	| { kind: "starting"; attempt: Attempt }
	| { kind: "paused_ptt" }
	| { kind: "armed"; graph: Graph; message: string }
	| { kind: "wake_grace"; graph: Graph; grace: Countdown }
	| ({ kind: "capturing" } & Recording)
	| ({ kind: "finishing" } & Recording)
	/** `clipId` is the id the page sent the utterance under. */
	| { kind: "awaiting_response"; graph: Graph; clipId: string }
	| { kind: "lease"; graph: Graph; lease: Lease; tick: Countdown };

/**
 * A reply that closed at `generation`: the follow-up lease opens once its
 * audio has drained and stayed drained for `PLAYBACK_DRAIN_DEBOUNCE_MS`.
 * `debounce` is set while that wait runs, and stays set once it fired.
 */
export interface FollowUp {
	generation: number;
	debounce: Countdown | null;
}

/**
 * Everything hands-free holds. `phase` is where it is. The other two outlive
 * a phase: `detectors` are null until the first load lands and are kept from
 * then on, and `followUp` is a closed reply that waits for its audio to drain
 * whatever the phase does meanwhile (a push-to-talk turn and the restart
 * after it, MODE off and on). Only a page stop, an epoch, the next closed
 * reply, or the lease it opens ends it.
 */
export interface Machine {
	phase: Phase;
	detectors: Detectors | null;
	followUp: FollowUp | null;
}

/** Why the page stops hands-free; each says so in the status. */
export type StopReason =
	| "hidden"
	| "pagehide"
	| "dispose"
	| "route"
	| "hangup"
	| "disconnected";

const STOPPED: Record<StopReason, string> = {
	hidden: "Hands-free stopped while the page is hidden.",
	pagehide: "Hands-free stopped when the page was left.",
	dispose: "Hands-free stopped when the page was left.",
	route: "Hands-free stopped while changing the line.",
	hangup: "Hands-free stopped for hangup.",
	disconnected: "Hands-free stopped while disconnected.",
};

/**
 * What moves hands-free. An event from a start, a recorder or a timer names
 * it, so one that outlives its phase is dropped.
 */
export type HandsFreeEvent =
	/** MODE. */
	| { kind: "toggle" }
	| { kind: "enable" }
	| { kind: "turnOff"; message: string }
	| { kind: "stop"; reason: StopReason }
	| { kind: "callChanged" }
	| { kind: "pttActive"; active: boolean }
	/** The awaited turn brings no reply: routing is unavailable. */
	| { kind: "noReply" }
	/** The server's `error` naming a clip. */
	| { kind: "clipFailed"; id: string }
	/** `final_response_audio_closed`. */
	| { kind: "replyClosed"; generation: number; success: boolean }
	| { kind: "playbackChanged" }
	| { kind: "debounceElapsed"; debounce: Countdown }
	/** A controller built with its detectors has them from the start. */
	| { kind: "given"; detectors: Detectors }
	| { kind: "loaded"; load: Load; detectors: Detectors }
	| { kind: "loadFailed"; load: Load; error: unknown }
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
	/** The page took the utterance under `clipId`, or could not send it. */
	| { kind: "delivered"; capture: Capture; clipId: string | null }
	| { kind: "recorderFailed"; capture: Capture; error: unknown }
	| { kind: "leaseExpired"; lease: Lease }
	| { kind: "leaseTick"; tick: Countdown };

/** What a step asks the runner to do once the new phase is written. */
export type Effect =
	| { kind: "resetDetectors" }
	| { kind: "resetEndpointer" }
	/** The voice indicator falls to zero. */
	| { kind: "silence" }
	| { kind: "load"; load: Load }
	/** Connects the loaded detectors' callbacks to the machine. */
	| { kind: "install"; detectors: Detectors }
	| { kind: "start"; attempt: Attempt }
	| { kind: "arm"; countdown: Countdown; ms: number; event: HandsFreeEvent }
	| { kind: "openCapture"; graph: Graph }
	| { kind: "startRecorder"; capture: Capture }
	| { kind: "stopRecorder"; capture: Capture }
	| { kind: "keep"; capture: Capture; blob: Blob }
	| { kind: "deliver"; capture: Capture };

/**
 * What an event does to the phase: the phase to write, the effects to run
 * after it, whether to publish it, and an event the machine sends itself
 * once it is published.
 */
interface PhaseStep {
	to: Phase;
	effects: Effect[];
	publish: boolean;
	then: HandsFreeEvent | null;
}

/** One step of the whole machine; only a phase step publishes. */
export interface Step {
	to: Machine;
	effects: Effect[];
	publish: boolean;
	then: HandsFreeEvent | null;
}

/** What a step may read from the page. It writes nothing. */
export interface PageReads {
	snapshotReady(): boolean;
	epoch(): number;
	pttActive(): boolean;
	playbackDrained(): boolean;
	/** Why the browser or the page refuses a start now, or null. */
	refusal(): string | null;
	now(): number;
}

const RESET: Effect = { kind: "resetDetectors" };
const QUIET: Effect[] = [{ kind: "silence" }, RESET];

function go(
	to: Phase,
	effects: Effect[] = [],
	then: HandsFreeEvent | null = null,
): PhaseStep {
	return { to, effects, publish: true, then };
}

/** A step that writes `to` without publishing it. */
function quietly(to: Phase, effects: Effect[]): PhaseStep {
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

/** As `errorText` in `runtime/errors.ts`; this module imports no values. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isEnabled(phase: Phase): boolean {
	return phase.kind !== "off" && phase.kind !== "error";
}

/**
 * On and past the first load. A load in flight answers only to its own
 * result: a push-to-talk press, an epoch or a detector cannot reach it.
 */
function isOn(phase: Phase): boolean {
	return isEnabled(phase) && phase.kind !== "loading";
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
function startOrRefuse(page: PageReads, detectors: Detectors): PhaseStep {
	const refusal =
		page.refusal() ??
		(!detectors.wake
			? "Hands-free wake detector is unavailable."
			: !detectors.speech
				? "Hands-free speech detector is unavailable."
				: null);
	if (refusal) return go({ kind: "error", message: refusal });
	const attempt = newAttempt();
	return go({ kind: "starting", attempt }, [{ kind: "start", attempt }]);
}

/**
 * Off, saying why. A load in flight holds no microphone and no detector yet;
 * its result, when it comes, names a load no phase holds.
 */
function turnOff(phase: Phase, message: string): PhaseStep {
	return go({ kind: "off", message }, phase.kind === "loading" ? [] : QUIET);
}

/** MODE on: the first time loads the detectors, then every time starts. */
function turnOn(machine: Machine, page: PageReads): PhaseStep {
	if (machine.detectors) return startOrRefuse(page, machine.detectors);
	const load: Load = { kind: "load" };
	return go({ kind: "loading", load }, [{ kind: "load", load }]);
}

/** Waiting for the wake word, both detectors starting from silence. */
function listen(graph: Graph, message: string): PhaseStep {
	return go({ kind: "armed", graph, message }, [RESET]);
}

/** Hands-free stops listening and says what failed. */
function fail(what: string, error: unknown): PhaseStep {
	const message = `Hands-free ${what} (${errorName(error)}).`;
	return go({ kind: "error", message }, QUIET);
}

/**
 * A recorder that cannot be made, started or stopped, or that reports an
 * error. Today it says so, then turns hands-free off over it.
 */
function failRecording(what: string, error: unknown): PhaseStep {
	const message = `Hands-free recording ${what} (${errorName(error)}).`;
	return go({ kind: "error", message }, [], TURN_OFF);
}

/** The events that read or write more than the phase; `step` takes them. */
type MachineEvent = Extract<
	HandsFreeEvent,
	{
		kind:
			| "toggle"
			| "enable"
			| "stop"
			| "callChanged"
			| "pttActive"
			| "replyClosed"
			| "playbackChanged"
			| "debounceElapsed"
			| "given"
			| "loaded"
			| "loadFailed";
	}
>;

/**
 * The state x event table (pinned by `handsFreeLifecycle.test.ts` and
 * `handsFreeGlue.test.ts`): the step `event` takes from `machine`, or null
 * when the event changes nothing. It reads the page and acts on nothing; the
 * runner applies its effects after the new state is written. The events
 * that move only the phase are `next`'s.
 */
export function step(
	machine: Machine,
	event: HandsFreeEvent,
	page: PageReads,
): Step | null {
	const { phase, detectors, followUp } = machine;
	// The same machine without the reply waiting to drain.
	const dropped = { ...machine, followUp: null };
	switch (event.kind) {
		case "toggle":
			// MODE waits for the first load to land (#261).
			if (phase.kind === "loading") return null;
			return moved(
				machine,
				machine,
				isEnabled(phase) ? turnOff(phase, OFF_MESSAGE) : turnOn(machine, page),
			);
		case "enable":
			return isEnabled(phase) && phase.kind !== "paused_ptt"
				? null
				: moved(machine, machine, turnOn(machine, page));
		case "stop":
			// Every page stop drops a reply still waiting to drain. Before
			// the first load there is nothing to stop and nothing to say.
			return moved(
				machine,
				dropped,
				detectors || phase.kind === "loading"
					? turnOff(phase, STOPPED[event.reason])
					: null,
			);
		case "callChanged":
			return moved(
				machine,
				dropped,
				isEnabled(phase)
					? turnOff(phase, "Hands-free stopped because the call changed.")
					: null,
			);
		case "pttActive":
			if (event.active)
				return isOn(phase)
					? moved(machine, machine, go({ kind: "paused_ptt" }, QUIET))
					: null;
			return phase.kind === "paused_ptt" && detectors
				? moved(machine, machine, startOrRefuse(page, detectors))
				: null;
		case "replyClosed":
			if (event.generation !== page.epoch()) return null;
			// No follow-up lease without a reply; listen for the wake word.
			if (!event.success)
				return moved(
					machine,
					dropped,
					phase.kind === "awaiting_response"
						? listen(phase.graph, NO_REPLY_MESSAGE)
						: null,
				);
			return drain(
				machine,
				{ ...machine, followUp: { generation: event.generation, debounce: null } },
				page,
			);
		case "playbackChanged":
			return followUp ? drain(machine, machine, page) : null;
		case "debounceElapsed":
			if (!followUp || followUp.debounce !== event.debounce) return null;
			if (!ready(followUp, page) || !page.playbackDrained()) return null;
			return moved(machine, dropped, openLease(phase, followUp.generation, page));
		case "given":
			if (detectors) return null;
			return moved(
				machine,
				{ ...machine, detectors: event.detectors },
				go(phase),
				[{ kind: "install", detectors: event.detectors }],
			);
		case "loaded":
			if (phase.kind !== "loading" || phase.load !== event.load) return null;
			return moved(
				machine,
				{ ...machine, detectors: event.detectors },
				startOrRefuse(page, event.detectors),
				[{ kind: "install", detectors: event.detectors }],
			);
		case "loadFailed":
			if (phase.kind !== "loading" || phase.load !== event.load) return null;
			return moved(
				machine,
				machine,
				go({
					kind: "error",
					message: `Hands-free detector could not load (${errorMessage(event.error)}).`,
				}),
			);
		default:
			return moved(machine, machine, next(phase, event, page));
	}
}

/**
 * The step from `from` to `to` with `phaseStep` applied to its phase, the
 * effects in `before` running first. Null when nothing changes.
 */
function moved(
	from: Machine,
	to: Machine,
	phaseStep: PhaseStep | null,
	before: Effect[] = [],
): Step | null {
	if (!phaseStep && to.followUp === from.followUp && to.detectors === from.detectors)
		return null;
	return {
		to: phaseStep ? { ...to, phase: phaseStep.to } : to,
		effects: [...before, ...(phaseStep?.effects ?? [])],
		publish: phaseStep?.publish ?? false,
		then: phaseStep?.then ?? null,
	};
}

/** Whether a closed reply still belongs to the call the page is on. */
function ready(followUp: FollowUp, page: PageReads): boolean {
	return page.snapshotReady() && followUp.generation === page.epoch();
}

/**
 * Playback changed while `to.followUp` waits: drained starts the debounce
 * once, playing again cancels it.
 */
function drain(from: Machine, to: Machine, page: PageReads): Step | null {
	const waiting = to.followUp;
	if (!waiting || !ready(waiting, page)) return moved(from, to, null);
	if (!page.playbackDrained())
		return moved(
			from,
			waiting.debounce ? { ...to, followUp: { ...waiting, debounce: null } } : to,
			null,
		);
	if (waiting.debounce) return moved(from, to, null);
	const debounce = countdown();
	return moved(from, { ...to, followUp: { ...waiting, debounce } }, null, [
		arm(debounce, PLAYBACK_DRAIN_DEBOUNCE_MS, { kind: "debounceElapsed", debounce }),
	]);
}

/**
 * The phase x event table: the step `event` takes from `phase`, or null
 * when the event changes nothing there.
 */
function next(
	phase: Phase,
	event: Exclude<HandsFreeEvent, MachineEvent>,
	page: PageReads,
): PhaseStep | null {
	switch (event.kind) {
		case "turnOff":
			return turnOff(phase, event.message);
		case "noReply":
			return phase.kind === "awaiting_response"
				? listen(phase.graph, NO_REPLY_MESSAGE)
				: null;
		case "clipFailed":
			return phase.kind === "awaiting_response" && phase.clipId === event.id
				? listen(phase.graph, NO_REPLY_MESSAGE)
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
			return isOn(phase)
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
			// The capture ends once the page has taken the utterance.
			return quietly({ ...phase, kind: "finishing" }, [
				{ kind: "deliver", capture: event.capture },
			]);
		case "delivered":
			if (phase.kind !== "finishing" || phase.capture !== event.capture)
				return null;
			if (event.clipId === null)
				return listen(
					phase.graph,
					"The utterance could not be sent; say the wake word again.",
				);
			return go({
				kind: "awaiting_response",
				graph: phase.graph,
				clipId: event.clipId,
			});
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
function finish(phase: Phase & { kind: "capturing" }): PhaseStep {
	return quietly({ ...phase, kind: "finishing" }, [
		{ kind: "stopRecorder", capture: phase.capture },
	]);
}

/**
 * Opens the follow-up lease where hands-free listens and no capture runs.
 * Not over a start, which has no graph to listen with, and not over a
 * capture, which the lease would claim to be waiting for.
 */
function openLease(
	phase: Phase,
	generation: number,
	page: PageReads,
): PhaseStep | null {
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
		case "loading":
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
		case "loading":
			return detail("starting", LOADING_MESSAGE);
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


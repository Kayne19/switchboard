import {
	clipHeader,
	decodeServerMessage,
	helloMessage,
	postJson,
	screenStateMessage,
	sttChunkHeader,
	sttEndHeader,
	sttStartHeader,
	sttCancelHeader,
} from "./protocol.js";
import {
	HandsFreeController,
	PLAYBACK_DRAIN_DEBOUNCE_MS,
} from "./hands_free.js";
import {
	historyBack,
	historyForward,
	historyLive,
	markStale,
	renderVisual,
} from "./stage.js";
import "./diff.js";
import {
	initMissionClock,
	initSynchro,
	type SynchroController,
} from "./synchro.js";

interface Clip {
	id: string;
	audio: Blob;
	mime: string;
	created: number;
	epoch: number;
	sent: boolean;
	accepted?: boolean;
	streaming?: boolean;
	chunks?: Blob[];
}

interface ActivityMessage extends BrowserMessage {
	state?: string;
	tool?: string;
	detail?: string;
}

function getElement<T extends Element>(id: string): T {
	const element = document.getElementById(id);
	if (!element) throw new Error(`Missing required element #${id}`);
	return element as unknown as T;
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown error";
}

function getChildElement<T extends Element>(
	parent: Element,
	selector: string,
): T {
	const element = parent.querySelector(selector);
	if (!element) throw new Error(`Missing required child ${selector}`);
	return element as unknown as T;
}

function clearTimeoutSafe(timer: ReturnType<typeof setTimeout> | null): void {
	if (timer !== null) clearTimeout(timer);
}

function clearIntervalSafe(timer: ReturnType<typeof setInterval> | null): void {
	if (timer !== null) clearInterval(timer);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const btn = getElement<HTMLButtonElement>("talkBtn");
const cancelBtn = getElement<HTMLButtonElement>("cancelBtn");
const sendBtn = getElement<HTMLButtonElement>("sendBtn");
const statusEl = getElement<HTMLElement>("status");
const logEl = getElement<HTMLElement>("log");
const lineEl = getElement<HTMLElement>("line");
const whoEl = getElement<HTMLElement>("who");
const modelEl = getElement<HTMLElement>("model");
const routeSelect = getElement<HTMLSelectElement>("routeSelect");
const modelSelect = getElement<HTMLSelectElement>("modelSelect");
const thinkingSelect = getElement<HTMLSelectElement>("thinkingSelect");
const hangupBtn = getElement<HTMLButtonElement>("hangupBtn");
const retryBtn = getElement<HTMLButtonElement>("retryBtn");
const player = getElement<HTMLAudioElement>("player");
const handsFreeBtn = getElement<HTMLButtonElement>("handsFreeBtn");
const handsFreeStatusEl = getElement<HTMLElement>("handsFreeStatus");
const handsFreeLeaseEl = getElement<HTMLElement>("handsFreeLease");
const presenceEl = getElement<HTMLElement>("presenceState");

let ws: WebSocket | null = null;
let mediaRecorder: MediaRecorder | null = null;
let activeRecording: {
	recorder: MediaRecorder;
	discard: boolean;
	id: string;
	epoch: number;
	streaming: boolean;
	chunks: Blob[];
	sequence: number;
} | null = null;
const audioQueue: Blob[] = [];
let isPlaying = false;
let audioEpoch = 0;
const MAX_AUDIO_UTTERANCE = 32 * 1024 * 1024;
const MAX_AUDIO_REPLAY = 64 * 1024 * 1024;
const MAX_OUTBOX_CLIPS = 16;
const MAX_OUTBOX_BYTES = 128 * 1024 * 1024;
interface MseUtterance {
	generation: number;
	sequence: number;
	mime: string;
	parts: Blob[];
	queued: ArrayBuffer[];
	bytes: number;
	done: boolean;
	failed: boolean;
	fallbackQueued: boolean;
	media: MediaSource | null;
	buffer: SourceBuffer | null;
	url: string | null;
	started: boolean;
	endedHandler?: EventListener;
}
let mseEnabled = false;
let mseQueue: MseUtterance[] = [];
let mseActive: MseUtterance | null = null;
let msePending: MseUtterance | null = null;
let mseReplayBytes = 0;
const idleText = "Connected. Tap Talk and speak.";
// True from the moment getUserMedia is asked for until the recorder is
// actually running. Without it a second click (or Space) lands inside the
// permission await, spawns a second stream and recorder, orphans the
// first one with its mic light stuck on, and garbles the clip because
// both write into the same chunks array.
let starting = false;
let startCancelled = false;
// Completed clips remain here, oldest first, until the backend explicitly
// accepts their id. `sent` means only "attempted on this socket"; reconnect
// clears it and safely retransmits because the backend deduplicates ids.
let outbox: Clip[] = [];
let outboxBytes = 0;
function setOutbox(next: Clip[]): void {
	outbox = next;
	outboxBytes = outbox.reduce((total, clip) => total + clip.audio.size, 0);
}
function enqueueOutbox(clip: Clip): boolean {
	if (
		outbox.length >= MAX_OUTBOX_CLIPS ||
		outboxBytes + clip.audio.size > MAX_OUTBOX_BYTES
	) {
		statusEl.textContent =
			"Too many unsent voice clips; reconnect before recording again.";
		statusEl.classList.add("error");
		return false;
	}
	outbox.push(clip);
	outboxBytes += clip.audio.size;
	return true;
}
let clipSequence = 0;
let streamingSelected = false;
// The server's turn epoch, as last announced. A clip is stamped with whatever
// this held when its recording started, so speech begun before a transfer is
// discarded rather than delivered to the leg that replaced it. Recording start
// is the earliest knowable moment; the server cannot see it, because upload and
// transcription both happen afterwards.
let turnEpoch = 0;
let socketGeneration = 0;
let snapshotReady = false;
let heartbeatSequence = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let pongDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPong: string | null = null;
interface PlaybackOwner {
	blob: Blob;
	url: string;
	token: number;
	consumed: boolean;
	requeued: boolean;
	paused: boolean;
	seeked: boolean;
	awaitingEnded: boolean;
	pendingAttempt: number | null;
	handlers: Array<[string, EventListener]>;
}

let playbackOwner: PlaybackOwner | null = null;
let playbackToken = 0;
let handsFreeController: HandsFreeController | null = null;
let handsFreeStartup: Promise<void> | null = null;
let pendingResponseBarrier: {
	responseId: string;
	generation: number;
	timer: ReturnType<typeof setTimeout> | null;
} | null = null;
let playAttemptToken = 0;
let turnStarted = 0;
let clockTimer: ReturnType<typeof setInterval> | null = null;

function playbackIsDrained(): boolean {
	return (
		audioQueue.length === 0 &&
		playbackOwner === null &&
		!isPlaying &&
		mseActive === null &&
		mseQueue.length === 0 &&
		msePending === null
	);
}

function clearResponseBarrier(): void {
	const barrier = pendingResponseBarrier;
	if (barrier?.timer !== null && barrier?.timer !== undefined) {
		clearTimeoutSafe(barrier.timer);
	}
	pendingResponseBarrier = null;
}

function maybeCompleteResponseBarrier(): void {
	const barrier = pendingResponseBarrier;
	if (!barrier || !snapshotReady || barrier.generation !== audioEpoch) return;
	if (!playbackIsDrained()) {
		if (barrier.timer !== null) clearTimeoutSafe(barrier.timer);
		barrier.timer = null;
		return;
	}
	if (barrier.timer !== null) return;
	barrier.timer = setTimeout(() => {
		if (
			pendingResponseBarrier !== barrier ||
			!playbackIsDrained() ||
			!snapshotReady ||
			barrier.generation !== audioEpoch
		)
			return;
		pendingResponseBarrier = null;
		handsFreeController?.openFollowUpLease(barrier.generation);
	}, PLAYBACK_DRAIN_DEBOUNCE_MS);
}

const activityEl = getElement<HTMLElement>("activity");
const activityList = getElement<HTMLUListElement>("activityList");
const activityWho = getElement<HTMLElement>("activityWho");
const activityClock = getElement<HTMLElement>("activityClock");

// A turn is a black box otherwise: four minutes of real work and a leg
// that died look exactly the same from here, so callers hang up on
// healthy turns and wait forever on dead ones. The elapsed clock runs
// even when no tool has fired, because "thinking, 90s" is still an answer.
function startActivity(label: string) {
	activityWho.textContent = label || "working";
	activityList.textContent = "";
	activityEl.classList.remove("hidden");
	presenceEl.textContent = "INTELLIGENCE WORKING";
	turnStarted = Date.now();
	clearIntervalSafe(clockTimer);
	const tick = () => {
		const secs = Math.round((Date.now() - turnStarted) / 1000);
		activityClock.textContent =
			secs < 60 ? secs + "s" : Math.floor(secs / 60) + "m " + (secs % 60) + "s";
	};
	tick();
	clockTimer = setInterval(tick, 1000);
}

function stopActivity() {
	clearIntervalSafe(clockTimer);
	clockTimer = null;
	activityEl.classList.add("hidden");
	presenceEl.textContent = "INTELLIGENCE ONLINE";
}

function addActivity(msg: ActivityMessage) {
	if (msg.state !== "start" || !msg.tool) return;
	// The strip is a live view, not a log; the transcript is the log. Ten
	// rows is about what fits without pushing the transcript off screen.
	while (activityList.children.length >= 10 && activityList.firstChild) {
		activityList.removeChild(activityList.firstChild);
	}
	const row = document.createElement("li");
	const name = document.createElement("span");
	name.className = "tool";
	name.textContent = msg.tool;
	row.appendChild(name);
	if (msg.detail) {
		const detail = document.createElement("span");
		detail.className = "detail";
		detail.textContent = msg.detail;
		row.appendChild(detail);
	}
	activityList.appendChild(row);
	activityList.scrollTop = activityList.scrollHeight;
}

// Enough markdown for what an agent actually says back: fences, headings,
// lists, quotes, and inline emphasis. Everything is HTML-escaped up front,
// so no reply text can inject markup.
function renderMarkdown(src: string): string {
	// One malformed entry used to throw inside renderHistory's forEach and
	// silently drop every remaining turn, truncating the transcript.
	if (typeof src !== "string") src = String(src ?? "");
	const esc = (s: string): string =>
		s.replace(
			/[&<>"]/g,
			(c: string) =>
				(
					({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }) as Record<
						string,
						string
					>
				)[c],
		);
	const inline = (s: string): string =>
		esc(s)
			.replace(/`([^`]+)`/g, "<code>$1</code>")
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
			.replace(
				/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
				'<a href="$2" rel="noopener">$1</a>',
			);

	const out: string[] = [];
	const lines = src.replace(/\r\n/g, "\n").split("\n");
	let list: "ul" | "ol" | null = null; // 'ul' | 'ol' while one is open
	let para: string[] = [];
	let fence: string[] | null = null; // buffered code-block lines while inside ```

	const closeList = () => {
		if (list) {
			out.push(`</${list}>`);
			list = null;
		}
	};
	const closePara = () => {
		if (para.length) {
			out.push("<p>" + inline(para.join(" ")) + "</p>");
			para = [];
		}
	};
	const openList = (kind: "ul" | "ol"): void => {
		if (list !== kind) {
			closeList();
			out.push(`<${kind}>`);
			list = kind;
		}
	};

	for (const line of lines) {
		if (/^\s*```/.test(line)) {
			if (fence === null) {
				closePara();
				closeList();
				fence = [];
			} else {
				out.push("<pre><code>" + esc(fence.join("\n")) + "</code></pre>");
				fence = null;
			}
			continue;
		}
		if (fence !== null) {
			fence.push(line);
			continue;
		}

		if (!line.trim()) {
			closePara();
			closeList();
			continue;
		}

		let m: RegExpMatchArray | null;
		if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
			closePara();
			closeList();
			const level = Math.min(m[1].length, 3);
			out.push(`<h${level}>${inline(m[2])}</h${level}>`);
		} else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
			closePara();
			openList("ul");
			out.push("<li>" + inline(m[1]) + "</li>");
		} else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
			closePara();
			openList("ol");
			out.push("<li>" + inline(m[1]) + "</li>");
		} else if ((m = line.match(/^\s*>\s?(.*)$/))) {
			closePara();
			closeList();
			out.push("<blockquote>" + inline(m[1]) + "</blockquote>");
		} else {
			closeList();
			para.push(line.trim());
		}
	}
	if (fence !== null)
		out.push("<pre><code>" + esc(fence.join("\n")) + "</code></pre>");
	closePara();
	closeList();
	return out.join("\n");
}

// The route label is only known for the live line; replayed history carries
// its own route string, which may name a project that is no longer on the
// line. Fall back to something readable either way.
function speakerName(role: string, route?: string): string {
	if (role === "caller") return "You";
	if (!route || route === "operator") return "Operator";
	return route;
}

function clockTime(ts?: number): string {
	if (!ts) return "";
	return new Date(ts * 1000).toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
}

function turnForClip(id?: string): HTMLElement | null {
	if (!id) return null;
	return (
		(Array.from(logEl.children).find(
			(el) => (el as HTMLElement).dataset.clipId === id,
		) as HTMLElement | undefined) || null
	);
}

function appendTurn(entry: TranscriptEntry): HTMLElement {
	// A completed recording is drawn immediately with its id.  Whisper's
	// transcript updates that same node rather than appending a second copy.
	const existing = turnForClip(entry.id);
	if (existing) {
		existing.classList.toggle("pending", Boolean(entry.pending));
		getChildElement<HTMLElement>(existing, ".body").textContent = entry.text;
		return existing;
	}

	const turn = document.createElement("div");
	turn.className = "turn " + (entry.role === "caller" ? "caller" : "agent");
	turn.classList.toggle("pending", Boolean(entry.pending));
	if (entry.id) turn.dataset.clipId = entry.id;

	const meta = document.createElement("div");
	meta.className = "meta";
	const time = clockTime(entry.ts);
	meta.textContent =
		speakerName(entry.role, entry.route) + (time ? " · " + time : "");
	turn.appendChild(meta);

	const body = document.createElement("div");
	body.className = "body";
	if (entry.role === "caller") {
		body.textContent = entry.text;
	} else {
		body.classList.add("md");
		// renderMarkdown escapes input before generating its small, known tag
		// set. Parse the result off-DOM and adopt the nodes instead of using
		// innerHTML on the live page.
		const parsed = new DOMParser().parseFromString(
			renderMarkdown(entry.text),
			"text/html",
		);
		body.replaceChildren(...Array.from(parsed.body.childNodes));
	}
	turn.appendChild(body);

	// Pin to the newest line only when the reader is already at the bottom,
	// so scrolling back through the call does not get yanked forward.
	const atBottom =
		logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
	logEl.appendChild(turn);
	if (atBottom) logEl.scrollTop = logEl.scrollHeight;
	return turn;
}

function pendingEntry(clip: Clip): TranscriptEntry {
	return {
		role: "caller",
		id: clip.id,
		text: "Voice clip pending transcription…",
		pending: true,
		ts: clip.created / 1000,
	};
}

function renderHistory(entries: TranscriptEntry[] = []): void {
	const history = entries || [];
	const completed = new Set(history.map((entry) => entry.id).filter(Boolean));
	// A transcript in history is the durable completion acknowledgement.
	// Drop its retained audio even if the live transcript frame was lost.
	setOutbox(outbox.filter((clip) => !completed.has(clip.id)));
	updateOutboxUI();
	logEl.textContent = "";
	history.forEach(appendTurn);
	// Preserve optimistic bubbles for clips accepted but not transcribed.
	outbox.forEach((clip) => {
		if (!turnForClip(clip.id)) appendTurn(pendingEntry(clip));
	});
	logEl.scrollTop = logEl.scrollHeight;
}

function cleanupOwner(owner: PlaybackOwner): void {
	if (playbackOwner === owner) playbackOwner = null;
	owner.pendingAttempt = null;
	for (const [name, handler] of owner.handlers) {
		player.removeEventListener(name, handler);
	}
	owner.handlers = [];
	player.pause();
	player.removeAttribute("src");
	player.load();
	URL.revokeObjectURL(owner.url);
	isPlaying = false;
	notifyPlaybackChange();
}

// Kept next to playback ownership so source-slice playback tests can exercise
// the same cleanup path without bootstrapping the whole page.
function notifyPlaybackChange(): void {
	if (typeof maybeCompleteResponseBarrier === "function")
		maybeCompleteResponseBarrier();
	const recording = document?.body?.classList?.contains("recording") ?? false;
	const ctrl = (
		globalThis as unknown as { synchroController?: SynchroController }
	).synchroController;
	if (ctrl && !recording) {
		ctrl.setMode(isPlaying ? "receiving" : "idle");
		ctrl.setLevel(isPlaying ? 0.65 : 0.04);
	}
}

function consumeOwner(owner: PlaybackOwner): void {
	if (playbackOwner !== owner || owner.consumed) return;
	owner.consumed = true;
	cleanupOwner(owner);
	playNext();
}

function playFailed(
	owner: PlaybackOwner,
	attempt: number,
	error: unknown,
): void {
	if (
		playbackOwner !== owner ||
		owner.consumed ||
		owner.pendingAttempt !== attempt ||
		owner.requeued
	)
		return;
	owner.pendingAttempt = null;
	owner.requeued = true;
	cleanupOwner(owner);
	// Autoplay rejection is recoverable: keep this clip at the front so the
	// next user gesture retries it instead of silently losing it.
	audioQueue.unshift(owner.blob);
	statusEl.textContent =
		"Audio blocked by the browser — click anywhere on this page once, then it will play (" +
		errorName(error) +
		").";
	statusEl.classList.add("error");
}

function attemptPlay(owner: PlaybackOwner): void {
	if (playbackOwner !== owner || owner.consumed || owner.pendingAttempt !== null)
		return;
	owner.paused = false;
	owner.seeked = false;
	isPlaying = true;
	notifyPlaybackChange();
	const attempt = ++playAttemptToken;
	owner.pendingAttempt = attempt;
	let result: Promise<void>;
	try {
		result = player.play();
	} catch (error) {
		playFailed(owner, attempt, error);
		return;
	}
	Promise.resolve(result).then(
		() => {
			if (
				playbackOwner !== owner ||
				owner.consumed ||
				owner.pendingAttempt !== attempt
			)
				return;
			owner.pendingAttempt = null;
			isPlaying = !owner.paused;
			notifyPlaybackChange();
		},
		(error) => playFailed(owner, attempt, error),
	);
}

function terminalSeek(): boolean {
	return (
		Number.isFinite(player.duration) &&
		player.duration > 0 &&
		Number.isFinite(player.currentTime) &&
		player.currentTime >= player.duration
	);
}

function playNext(): void {
	if (playbackOwner) cleanupOwner(playbackOwner);
	const blob = audioQueue.shift();
	if (!blob) {
		isPlaying = false;
		statusEl.textContent = idleText;
		notifyPlaybackChange();
		statusEl.classList.remove("error");
		return;
	}
	const owner: PlaybackOwner = {
		blob,
		url: URL.createObjectURL(blob),
		token: ++playbackToken,
		consumed: false,
		requeued: false,
		paused: false,
		seeked: false,
		awaitingEnded: false,
		pendingAttempt: null,
		handlers: [],
	};
	playbackOwner = owner;
	notifyPlaybackChange();
	const ended: EventListener = () => {
		if (playbackOwner !== owner || owner.consumed || player.ended === false)
			return;
		consumeOwner(owner);
	};
	const pause: EventListener = () => {
		if (
			playbackOwner !== owner ||
			owner.consumed ||
			player.ended ||
			player.paused === false
		)
			return;
		owner.paused = true;
		owner.awaitingEnded = owner.seeked && terminalSeek();
		isPlaying = false;
		notifyPlaybackChange();
		statusEl.textContent = owner.awaitingEnded
			? "Audio finishing — click anywhere on this page to continue."
			: "Audio paused — click anywhere on this page to resume.";
	};
	const error: EventListener = () => {
		if (playbackOwner !== owner || owner.consumed || !player.error) return;
		consumeOwner(owner);
	};
	const resetTerminal = () => {
		if (
			playbackOwner === owner &&
			(!Number.isFinite(player.duration) ||
				!Number.isFinite(player.currentTime) ||
				player.currentTime < player.duration)
		) {
			owner.awaitingEnded = false;
			owner.seeked = false;
		}
	};
	owner.handlers = [
		["ended", ended],
		["pause", pause],
		["error", error],
		[
			"seeking",
			() => {
				owner.seeked = true;
				resetTerminal();
			},
		],
		["seeked", resetTerminal],
		["timeupdate", resetTerminal],
	];
	for (const [name, handler] of owner.handlers) {
		player.addEventListener(name, handler);
	}
	player.src = owner.url;
	attemptPlay(owner);
}

function mseRuntimeSupported(): boolean {
	return (
		typeof MediaSource !== "undefined" &&
		MediaSource.isTypeSupported("audio/mpeg")
	);
}

function queueMseFallback(utterance: MseUtterance): void {
	if (utterance.fallbackQueued) return;
	utterance.fallbackQueued = true;
	if (utterance.bytes > MAX_AUDIO_UTTERANCE) {
		statusEl.textContent = "Audio exceeded the replay limit and was stopped.";
		statusEl.classList.add("error");
		return;
	}
	audioQueue.push(new Blob(utterance.parts, { type: utterance.mime }));
	if (typeof maybeCompleteResponseBarrier === "function")
		maybeCompleteResponseBarrier();
}

function msePlay(): void {
	if (!mseActive || mseActive.failed || isPlaying) return;
	isPlaying = true;
	notifyPlaybackChange();
	Promise.resolve(player.play()).catch((error) => {
		isPlaying = false;
		notifyPlaybackChange();
		statusEl.textContent =
			"Audio blocked by the browser — click anywhere on this page once, then it will play (" +
			errorName(error) +
			").";
		statusEl.classList.add("error");
		if (typeof maybeCompleteResponseBarrier === "function")
			maybeCompleteResponseBarrier();
	});
}

function mseFinishSource(utterance: MseUtterance): void {
	if (
		!utterance.done ||
		!utterance.media ||
		!utterance.buffer ||
		utterance.buffer.updating ||
		utterance.queued.length
	)
		return;
	try {
		if (utterance.media.readyState === "open") utterance.media.endOfStream();
	} catch (error) {
		mseFail(utterance, error);
	}
}

function mseAppend(utterance: MseUtterance): void {
	if (utterance.failed || !utterance.buffer || utterance.buffer.updating) return;
	if (!utterance.queued.length) {
		mseFinishSource(utterance);
		return;
	}
	try {
		utterance.buffer.appendBuffer(utterance.queued[0]);
		utterance.started = true;
		msePlay();
		const remove = () => {
			utterance.buffer?.removeEventListener("updateend", remove);
			utterance.queued.shift();
			mseAppend(utterance);
		};
		utterance.buffer.addEventListener("updateend", remove, { once: true });
	} catch (error) {
		mseFail(utterance, error);
	}
}

function mseFail(utterance: MseUtterance, error: unknown): void {
	if (utterance.failed) return;
	utterance.failed = true;
	if (mseActive === utterance) {
		isPlaying = false;
		notifyPlaybackChange();
		if (utterance.endedHandler)
			player.removeEventListener("ended", utterance.endedHandler);
		player.pause();
		player.removeAttribute("src");
		player.load();
		if (utterance.url) URL.revokeObjectURL(utterance.url);
		utterance.url = null;
	}
	statusEl.textContent =
		"Streaming audio failed; using the complete replay (" +
		errorName(error) +
		").";
	statusEl.classList.add("error");
	mseEnabled = false;
	if (utterance.done && mseActive === utterance) {
		queueMseFallback(utterance);
		mseActive = null;
		if (!isPlaying && !playbackOwner) playNext();
	}
	if (typeof maybeCompleteResponseBarrier === "function")
		maybeCompleteResponseBarrier();
}

function mseOpen(utterance: MseUtterance): void {
	if (utterance.failed || !utterance.media) return;
	try {
		utterance.buffer = utterance.media.addSourceBuffer(utterance.mime);
		utterance.buffer.addEventListener("error", () =>
			mseFail(utterance, new Error("MediaSource append error")),
		);
		player.src = utterance.url || "";
		mseAppend(utterance);
	} catch (error) {
		mseFail(utterance, error);
	}
}

function mseStartNext(): void {
	if (!mseEnabled || mseActive || !mseQueue.length) return;
	const utterance = mseQueue.shift()!;
	mseActive = utterance;
	utterance.media = new MediaSource();
	utterance.url = URL.createObjectURL(utterance.media);
	utterance.endedHandler = () => {
		if (mseActive !== utterance) return;
		player.removeEventListener("ended", utterance.endedHandler!);
		mseActive = null;
		isPlaying = false;
		notifyPlaybackChange();
		if (utterance.url) URL.revokeObjectURL(utterance.url);
		mseStartNext();
		if (typeof maybeCompleteResponseBarrier === "function")
			maybeCompleteResponseBarrier();
	};
	player.addEventListener("ended", utterance.endedHandler);
	utterance.media.addEventListener("sourceopen", () => mseOpen(utterance), {
		once: true,
	});
	if (utterance.media.readyState === "open") mseOpen(utterance);
}

function clearMsePlayback(): void {
	for (const utterance of [mseActive, ...mseQueue].filter(
		Boolean,
	) as MseUtterance[]) {
		if (utterance.endedHandler)
			player.removeEventListener("ended", utterance.endedHandler);
		if (utterance.url) URL.revokeObjectURL(utterance.url);
	}
	mseActive = null;
	mseQueue = [];
	msePending = null;
	mseReplayBytes = 0;
	isPlaying = false;
	notifyPlaybackChange();
	player.pause();
	player.removeAttribute("src");
	player.load();
	if (typeof maybeCompleteResponseBarrier === "function")
		maybeCompleteResponseBarrier();
}

function receiveAudioStart(msg: BrowserMessage): void {
	const generation = msg.generation;
	const sequence = msg.sequence;
	if (
		typeof generation !== "number" ||
		typeof sequence !== "number" ||
		generation !== audioEpoch
	)
		return;
	const utterance: MseUtterance = {
		generation,
		sequence,
		mime: msg.mime === "audio/mpeg" ? msg.mime : "audio/mpeg",
		parts: [],
		queued: [],
		bytes: 0,
		done: false,
		failed: false,
		fallbackQueued: false,
		media: null,
		buffer: null,
		url: null,
		started: false,
	};
	msePending = utterance;
	if (mseEnabled) {
		mseQueue.push(utterance);
		mseStartNext();
	}
	if (typeof maybeCompleteResponseBarrier === "function")
		maybeCompleteResponseBarrier();
}

function receiveAudioChunk(data: ArrayBuffer): void {
	const utterance = msePending;
	if (!utterance || utterance.generation !== audioEpoch) return;
	if (
		utterance.bytes + data.byteLength > MAX_AUDIO_UTTERANCE ||
		mseReplayBytes + data.byteLength > MAX_AUDIO_REPLAY
	) {
		mseFail(utterance, new Error("audio replay limit"));
		return;
	}
	utterance.bytes += data.byteLength;
	mseReplayBytes += data.byteLength;
	utterance.parts.push(new Blob([data], { type: utterance.mime }));
	if (mseEnabled && !utterance.failed) {
		utterance.queued.push(data);
		if (utterance === mseActive) mseAppend(utterance);
	}
	if (typeof maybeCompleteResponseBarrier === "function")
		maybeCompleteResponseBarrier();
}

function receiveAudioDone(msg: BrowserMessage): void {
	if (msg.generation !== audioEpoch || typeof msg.sequence !== "number") return;
	const utterance = msePending;
	if (!utterance || utterance.sequence !== msg.sequence) return;
	utterance.done = msg.done === true;
	if (!mseEnabled || utterance.failed) {
		queueMseFallback(utterance);
		if (mseActive === utterance) mseActive = null;
		msePending = null;
		if (!isPlaying && !playbackOwner) playNext();
		if (typeof maybeCompleteResponseBarrier === "function")
			maybeCompleteResponseBarrier();
		return;
	}
	if (utterance === mseActive) mseAppend(utterance);
	msePending = null;
	if (typeof maybeCompleteResponseBarrier === "function")
		maybeCompleteResponseBarrier();
}

// The status message promises that a page interaction resumes blocked audio.
// Keep that gesture path here rather than relying on a later clip to arrive.
document.addEventListener("click", (event?: MouseEvent) => {
	if (event?.target === player) return;
	const owner = playbackOwner;
	if (!owner) {
		if (typeof mseActive !== "undefined" && mseActive && !isPlaying) msePlay();
		else if (audioQueue.length) playNext();
		return;
	}
	if (isPlaying || owner.awaitingEnded || owner.pendingAttempt !== null) return;
	attemptPlay(owner);
});

// Rebuilt only when the set of options actually changes, so a select the
// caller has open does not collapse under them on a routine status update.
function fillSelect(
	select: HTMLSelectElement,
	values: Array<{ value: string; label: string }>,
	current?: string,
): void {
	const wanted = values.map((v) => v.value).join("\u0000");
	if (select.dataset.filled !== wanted) {
		select.textContent = "";
		for (const v of values) {
			const option = document.createElement("option");
			option.value = v.value;
			option.textContent = v.label;
			select.appendChild(option);
		}
		select.dataset.filled = wanted;
	}
	if (current && select.value !== current) select.value = current;
	// Keep the last server-confirmed choice separate from the native value,
	// which already contains the user's uncommitted change in a `change` event.
	select.dataset.committedValue = select.value;
}

let lastRoute: string | undefined;
function setRoute(msg: BrowserMessage): void {
	const currentRoute = msg.route || "operator";
	if (lastRoute !== undefined && lastRoute !== currentRoute) {
		markStale();
	}
	lastRoute = currentRoute;
	const onProject = Boolean(msg.route && msg.route !== "operator");
	whoEl.textContent = msg.label || "Operator";
	// Every leg runs at a level somebody chose, so there is always a level to
	// name. A leg that has not reported back yet is marked as asked-for
	// rather than stated as fact — the runtime may still clamp it.
	const name = msg.model_name || msg.model || "";
	let level = "";
	if (msg.thinking) {
		level = "thinking " + msg.thinking;
		if (!msg.thinking_confirmed) level += " (requested)";
	}
	modelEl.textContent = [name, level].filter(Boolean).join(" · ");
	lineEl.classList.toggle("project", onProject);

	fillSelect(
		routeSelect,
		[{ value: "operator", label: "Operator" }].concat(
			(msg.projects || []).map((id) => ({ value: id, label: id })),
		),
		msg.route || "operator",
	);
	invalidatePicker(routeSelect);
	invalidatePicker(modelSelect);
	invalidatePicker(thinkingSelect);
	const currentModel = msg.model_name || "";
	const modelValues = (msg.models || []).map((entry) => ({
		value: entry.provider + "/" + entry.model,
		label: entry.provider + "/" + entry.model,
	}));
	if (
		currentModel &&
		!modelValues.some((entry) => entry.value === currentModel)
	) {
		modelValues.push({ value: currentModel, label: currentModel });
	}
	fillSelect(modelSelect, modelValues, currentModel);
	pickerOnProject = onProject;
	pickerModelSwaps = msg.model_swaps !== false;
	pickerModelsAvailable = msg.models_available !== false;
	pickerDiagnostic = msg.models_diagnostic || "";
	applyPickerDisabled();

	fillSelect(
		thinkingSelect,
		(msg.levels || []).map((l) => ({
			value: l,
			label: "thinking: " + l,
		})),
		msg.thinking || msg.thinking_default || "",
	);
	applyPickerDisabled();

	// Only offered on a project leg: the operator is where hanging up puts
	// you, so there is nowhere for it to go from there.
	hangupBtn.classList.toggle("hidden", !onProject);
}

const pickerRequests = new WeakMap<HTMLSelectElement, number>();
let pickerBusy = false;
let pickerOnProject = false;
let pickerModelSwaps = true;
let pickerModelsAvailable = true;
let pickerDiagnostic = "";
let pickerOperation: Promise<void> | null = null;
function invalidatePicker(control: HTMLSelectElement): void {
	pickerRequests.set(control, (pickerRequests.get(control) || 0) + 1);
}
function applyPickerDisabled(): void {
	routeSelect.disabled = pickerBusy;
	modelSelect.disabled =
		pickerBusy || !pickerOnProject || !pickerModelSwaps || !pickerModelsAvailable;
	thinkingSelect.disabled = pickerBusy || (pickerOnProject && !pickerModelSwaps);
	modelSelect.title = pickerModelsAvailable
		? ""
		: pickerDiagnostic || "Model catalog unavailable";
}

// Both selects act immediately and both can take a while — connecting dials
// ssh and starts an agent, changing the level restarts the live leg. Lock
// them while that happens so a second pick cannot race the first.
async function post(
	url: string,
	body: Record<string, string>,
	control: HTMLSelectElement,
): Promise<void> {
	const request = (pickerRequests.get(control) || 0) + 1;
	pickerRequests.set(control, request);
	const previousValue = control.dataset.committedValue ?? control.value;
	control.disabled = true;
	const execute = async () => {
		let succeeded = false;
		pickerBusy = true;
		if (typeof document !== "undefined") applyPickerDisabled();
		statusEl.classList.remove("error");
		try {
			const response = await postJson(url, body);
			if (response.error !== null && response.error !== undefined) {
				throw new Error(String(response.error));
			}
			succeeded = true;
		} catch (err) {
			if (pickerRequests.get(control) === request) {
				// A failed POST must not leave the native select claiming a model
				// that the live leg never adopted. A newer status invalidates this
				// request, so never overwrite a fresh server selection here.
				control.value = previousValue;
				statusEl.textContent = "That did not go through: " + errorText(err);
				statusEl.classList.add("error");
			}
		} finally {
			if (pickerRequests.get(control) === request && succeeded) {
				control.dataset.committedValue = control.value;
			}
			pickerBusy = false;
			if (pickerRequests.get(control) === request) control.disabled = false;
			if (typeof document !== "undefined") applyPickerDisabled();
		}
	};
	const run = pickerOperation
		? pickerOperation.then(execute, execute)
		: execute();
	pickerOperation = run;
	run.then(
		() => {
			if (pickerOperation === run) pickerOperation = null;
		},
		() => {
			if (pickerOperation === run) pickerOperation = null;
		},
	);
	await run;
}

// Goes straight to the backend rather than through the agent on the line,
// which is the whole point — it has to work when that agent is the problem,
// including while it is still mid-turn.
async function hangup() {
	handsFreeController?.disable("Hands-free stopped for hangup.");
	clearResponseBarrier();
	hangupBtn.disabled = true;
	try {
		await postJson("/hangup", {});
	} catch (err) {
		statusEl.textContent = "Could not hang up: " + errorText(err);
		statusEl.classList.add("error");
	} finally {
		hangupBtn.disabled = false;
	}
}

function updateOutboxUI() {
	retryBtn.classList.toggle("hidden", outbox.length === 0);
}

// Send one unsent clip at a time. Accepted clips stay here until their
// transcript arrives, so a backend restart cannot destroy the only copy.
function flushOutbox() {
	updateOutboxUI();
	if (!snapshotReady || outbox.length === 0) return;
	const clip = outbox.find((entry) => !entry.sent);
	if (!clip) {
		statusEl.textContent = `Transcribing ${outbox.length} voice clip(s)...`;
		statusEl.classList.remove("error");
		return;
	}
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		statusEl.textContent = `Waiting to send ${outbox.length} clip(s)...`;
		statusEl.classList.add("error");
		return;
	}
	try {
		if (clip.streaming && clip.chunks) {
			ws.send(sttStartHeader(clip));
			clip.chunks.forEach((chunk, sequence) => {
				ws?.send(sttChunkHeader(clip, sequence));
				ws?.send(chunk);
			});
			ws.send(sttEndHeader(clip));
		} else {
			ws.send(clipHeader(clip));
			ws.send(clip.audio);
		}
		clip.sent = true;
		statusEl.textContent = "Waiting for the server to accept your clip...";
		statusEl.classList.remove("error");
	} catch {
		// The socket died between frames. The same id and bytes are retried on
		// the next generation; the backend either never saw them or dedupes.
		clip.sent = false;
		ws.close();
	}
}

function stopHeartbeat() {
	clearTimeoutSafe(heartbeatTimer);
	clearTimeoutSafe(pongDeadlineTimer);
	heartbeatTimer = null;
	pongDeadlineTimer = null;
	pendingPong = null;
}

function startHeartbeat(socket: WebSocket, generation: number): void {
	const schedule = () => {
		clearTimeoutSafe(heartbeatTimer);
		heartbeatTimer = setTimeout(ping, 20000);
	};
	const ping = () => {
		if (
			generation !== socketGeneration ||
			socket !== ws ||
			socket.readyState !== WebSocket.OPEN
		)
			return;
		const nonce = `${generation}:${Date.now()}:${++heartbeatSequence}`;
		pendingPong = nonce;
		try {
			socket.send(JSON.stringify({ type: "ping", nonce, time: Date.now() }));
		} catch {
			socket.close();
			connect();
			return;
		}
		clearTimeoutSafe(pongDeadlineTimer);
		pongDeadlineTimer = setTimeout(() => {
			if (
				generation === socketGeneration &&
				socket === ws &&
				pendingPong === nonce
			) {
				statusEl.textContent = "Keepalive missed. Reconnecting...";
				statusEl.classList.add("error");
				socket.close();
				connect();
			}
		}, 8000);
	};
	schedule();
}

function connect() {
	const generation = ++socketGeneration;
	clearTimeoutSafe(reconnectTimer);
	reconnectTimer = null;
	stopHeartbeat();

	// Incrementing the generation first makes every callback from the old
	// socket a no-op, including its close callback. This is what prevents a
	// manual force-send from stacking another reconnect timer behind itself.
	const previous = ws;
	ws = null;
	if (
		previous &&
		(previous.readyState === WebSocket.OPEN ||
			previous.readyState === WebSocket.CONNECTING)
	)
		previous.close();

	const proto = location.protocol === "https:" ? "wss" : "ws";
	const socket = new WebSocket(`${proto}://${location.host}/ws`);
	snapshotReady = false;
	ws = socket;
	socket.binaryType = "arraybuffer";
	const current = () => generation === socketGeneration && socket === ws;

	socket.onopen = () => {
		if (!current()) return;
		statusEl.textContent = idleText;
		statusEl.classList.remove("error");
		presenceEl.textContent = "INTELLIGENCE ONLINE";
		btn.disabled = false;
		handsFreeBtn.disabled = false;
		outbox.forEach((clip) => (clip.sent = false));
		snapshotReady = false;
		streamingSelected = false;
		try {
			socket.send(helloMessage());
			reportWorkspaceState(true);
		} catch {
			socket.close();
			return;
		}
		startHeartbeat(socket, generation);
	};

	socket.onclose = () => {
		if (!current()) return;
		// Finalise the in-flight recording into the outbox rather than
		// discarding it. Accepted work is already server-owned; unaccepted
		// work remains locally retryable under the same id.
		if (isRecording() || starting) stopRecording(true);
		handsFreeController?.disable("Hands-free stopped while disconnected.");
		clearResponseBarrier();
		stopHeartbeat();
		outbox.forEach((clip) => (clip.sent = false));
		updateOutboxUI();
		statusEl.textContent = "Disconnected. Reconnecting...";
		statusEl.classList.add("error");
		presenceEl.textContent = "LINK RECOVERING";
		btn.disabled = true;
		handsFreeBtn.disabled = true;
		clearTimeoutSafe(reconnectTimer);
		reconnectTimer = setTimeout(() => {
			if (generation === socketGeneration) connect();
		}, 1500);
	};

	socket.onerror = () => {
		if (!current()) return;
		statusEl.textContent = "Connection error.";
		statusEl.classList.add("error");
		presenceEl.textContent = "LINK FAULT";
		handsFreeBtn.disabled = true;
	};

	socket.onmessage = (event) => {
		if (!current()) return;
		if (typeof event.data === "string") {
			const msg = decodeServerMessage(event.data);
			if (!msg) return;
			if (msg.type === "hello_ack") {
				streamingSelected = msg.stt_streaming === true;
				mseEnabled = msg.mse_mp3 === true && mseRuntimeSupported();
				if (!mseEnabled) clearMsePlayback();
				flushOutbox();
			} else if (msg.type === "epoch") {
				// Adopt the server's epoch immediately and retire every queued or
				// currently playing clip from the old leg. Do this before allowing
				// reconnect retry, otherwise a pre-rescue clip can cross the barrier.
				if (typeof msg.generation === "number") {
					handsFreeController?.epochChanged();
					clearResponseBarrier();
					setOutbox(outbox.filter((clip) => clip.epoch === msg.generation));
					updateOutboxUI();
					turnEpoch = msg.generation;
					audioEpoch = msg.generation;
					snapshotReady = true;
					flushOutbox();
					audioQueue.length = 0;
					clearMsePlayback();
					if (playbackOwner) cleanupOwner(playbackOwner);
					isPlaying = false;
				}
			} else if (msg.type === "audio_start") {
				receiveAudioStart(msg);
			} else if (msg.type === "audio_done") {
				receiveAudioDone(msg);
			} else if (msg.type === "final_response_audio_closed") {
				if (
					typeof msg.response_id === "string" &&
					typeof msg.generation === "number" &&
					msg.generation === audioEpoch
				) {
					clearResponseBarrier();
					if (msg.success === false) {
						handsFreeStatusEl.textContent =
							"Hands-free follow-up is waiting for a successful response.";
						handsFreeStatusEl.classList.add("error");
					} else {
						pendingResponseBarrier = {
							responseId: msg.response_id,
							generation: msg.generation,
							timer: null,
						};
						maybeCompleteResponseBarrier();
					}
				}
			} else if (msg.type === "pong") {
				if (msg.nonce === pendingPong) {
					pendingPong = null;
					clearTimeoutSafe(pongDeadlineTimer);
					pongDeadlineTimer = null;
					clearTimeoutSafe(heartbeatTimer);
					startHeartbeat(socket, generation);
				}
			} else if (msg.type === "abandoned") {
				if (activeRecording && activeRecording.id === msg.id)
					activeRecording.streaming = false;
				const clip = outbox.find((entry) => entry.id === msg.id);
				if (clip) {
					clip.streaming = false;
					clip.sent = false;
					statusEl.textContent = "Streaming unavailable; sending complete clip...";
					flushOutbox();
				}
			} else if (msg.type === "accepted") {
				const clip = outbox.find((entry) => entry.id === msg.id);
				if (clip) {
					clip.accepted = true;
					statusEl.textContent = "Transcribing...";
					statusEl.classList.remove("error");
					flushOutbox();
				}
			} else if (msg.type === "history") {
				renderHistory(msg.entries);
			} else if (msg.type === "transcript") {
				if (msg.text) {
					setOutbox(outbox.filter((clip) => clip.id !== msg.id));
					updateOutboxUI();
					appendTurn({
						role: "caller",
						id: msg.id,
						text: msg.text,
						ts: Date.now() / 1000,
					});
					flushOutbox();
				}
			} else if (msg.type === "spoken") {
				if (msg.entry) appendTurn(msg.entry);
			} else if (msg.type === "thinking") {
				statusEl.textContent =
					msg.route === "operator"
						? "Operator is listening..."
						: `${whoEl.textContent || "working"} is working...`;
				startActivity(
					msg.route === "operator" ? "Operator" : whoEl.textContent || "working",
				);
			} else if (msg.type === "activity") {
				addActivity(msg);
			} else if (msg.type === "queued") {
				const waiting = msg.waiting ?? 0;
				if (msg.steered) {
					statusEl.textContent = "Added that to the turn already in progress.";
				} else if (waiting > 1) {
					statusEl.textContent = `Got it — ${waiting} waiting their turn.`;
				} else {
					statusEl.textContent = "Got it — you're next, once this turn finishes.";
				}
				statusEl.classList.remove("error");
			} else if (msg.type === "reply") {
				stopActivity();
				statusEl.textContent = idleText;
				appendTurn({
					role: "agent",
					text: msg.text || "(nothing said)",
					route: msg.route,
					ts: Date.now() / 1000,
				});
			} else if (msg.type === "status") {
				setRoute(msg);
			} else if (msg.type === "diagram") {
				void renderVisual(msg).then(() => reportWorkspaceState());
			} else if (msg.type === "view") {
				setWorkspaceView(
					typeof msg.target === "string" ? msg.target : "",
					"agent",
				);
			} else if (msg.type === "error") {
				stopActivity();
				const pending = turnForClip(msg.id);
				if (pending) {
					setOutbox(outbox.filter((clip) => clip.id !== msg.id));
					updateOutboxUI();
					pending.classList.remove("pending");
					getChildElement<HTMLElement>(pending, ".body").textContent =
						"Voice clip failed: " + msg.message;
				}
				statusEl.textContent = "Error: " + msg.message;
				statusEl.classList.add("error");
			}
		} else if (event.data instanceof ArrayBuffer) {
			receiveAudioChunk(event.data);
		} else if (event.data instanceof Blob) {
			void event.data.arrayBuffer().then((bytes) => {
				if (current()) receiveAudioChunk(bytes);
			});
		}
	};
}

function setRecordingUI(on: boolean): void {
	btn.classList.toggle("hidden", on);
	cancelBtn.classList.toggle("hidden", !on);
	sendBtn.classList.toggle("hidden", !on);
	const doc = (globalThis as unknown as { document?: Document }).document;
	if (doc?.body?.classList) {
		doc.body.classList.toggle("recording", on);
	}
	const ctrl = (
		globalThis as unknown as { synchroController?: SynchroController }
	).synchroController;
	if (ctrl) {
		if (on) {
			ctrl.setMode("transmitting");
			ctrl.setLevel(0.85);
		} else {
			const playing = Boolean(
				(globalThis as unknown as { isPlaying?: boolean }).isPlaying ?? isPlaying,
			);
			ctrl.setMode(playing ? "receiving" : "idle");
			ctrl.setLevel(playing ? 0.65 : 0.05);
		}
	}
}

function pauseHandsFreeForPtt(): void {
	if (typeof handsFreeController !== "undefined")
		handsFreeController?.pauseForPtt();
}

function resumeHandsFreeAfterPtt(): void {
	if (typeof handsFreeController !== "undefined")
		handsFreeController?.resumeAfterPtt();
}

async function startRecording() {
	if (starting || activeRecording || isRecording()) return;
	pauseHandsFreeForPtt();
	starting = true;
	startCancelled = false;
	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch (err) {
		starting = false;
		resumeHandsFreeAfterPtt();
		statusEl.textContent = "Microphone unavailable (" + errorName(err) + ").";
		statusEl.classList.add("error");
		return;
	}
	// Discard/Send pressed during the permission await: honour it instead of
	// starting a recording the caller already cancelled.
	if (startCancelled) {
		starting = false;
		stream.getTracks().forEach((t) => t.stop());
		resumeHandsFreeAfterPtt();
		statusEl.textContent = idleText;
		setRecordingUI(false);
		return;
	}
	try {
		// Only getUserMedia was guarded before. Safari/iOS does not support
		// this mimeType and the constructor throws NotSupportedError, which
		// escaped as an unhandled rejection from an un-awaited caller: Talk
		// did nothing, no error appeared, and the mic light stayed on forever
		// because the tracks were never stopped.
		const mime = "audio/webm;codecs=opus";
		mediaRecorder = window.MediaRecorder?.isTypeSupported?.(mime)
			? new MediaRecorder(stream, { mimeType: mime })
			: new MediaRecorder(stream);
	} catch (err) {
		starting = false;
		stream.getTracks().forEach((t) => t.stop());
		resumeHandsFreeAfterPtt();
		setRecordingUI(false);
		statusEl.textContent =
			"This browser cannot record audio (" + errorName(err) + ").";
		statusEl.classList.add("error");
		return;
	}
	const recorder = mediaRecorder;
	if (!recorder) {
		starting = false;
		stream.getTracks().forEach((t) => t.stop());
		return;
	}
	const chunks: Blob[] = [];
	const recordingId = globalThis.crypto?.randomUUID
		? globalThis.crypto.randomUUID()
		: `${Date.now()}-${++clipSequence}`;
	const recordingEpoch = turnEpoch;
	const recordingStreaming =
		typeof streamingSelected !== "undefined" &&
		streamingSelected &&
		(recorder.mimeType || "") === "audio/webm;codecs=opus";
	let streamReleased = false;
	const releaseStream = () => {
		if (streamReleased) return;
		streamReleased = true;
		stream.getTracks().forEach((t) => t.stop());
	};
	let recorderFailed = false;
	const recording = {
		recorder,
		discard: false,
		id: recordingId,
		epoch: recordingEpoch,
		streaming: recordingStreaming,
		chunks,
		sequence: 0,
	};
	activeRecording = recording;
	recorder.ondataavailable = (e) => {
		if (e.data.size === 0) return;
		chunks.push(e.data);
		if (activeRecording?.recorder !== recorder || !activeRecording.streaming)
			return;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		const sequence = activeRecording.sequence++;
		try {
			ws.send(
				sttChunkHeader(
					{ id: activeRecording.id, epoch: activeRecording.epoch },
					sequence,
				),
			);
			ws.send(e.data);
		} catch {
			try {
				ws.send(
					sttCancelHeader({
						id: activeRecording.id,
						epoch: activeRecording.epoch,
					}),
				);
			} catch {
				/* socket is already closed */
			}
			activeRecording.streaming = false;
		}
	};
	if (recording.streaming && ws?.readyState === WebSocket.OPEN) {
		try {
			ws.send(
				sttStartHeader({
					id: recording.id,
					mime: recorder.mimeType,
					epoch: recording.epoch,
				}),
			);
		} catch {
			recording.streaming = false;
		}
	}
	recorder.onstop = () => {
		releaseStream();
		resumeHandsFreeAfterPtt();
		if (activeRecording?.recorder === recorder) activeRecording = null;
		if (mediaRecorder === recorder) mediaRecorder = null;
		if (recorderFailed) return;
		if (recording.discard) {
			statusEl.textContent = idleText;
			return;
		}
		const blob = new Blob(chunks, {
			type: recorder.mimeType || "audio/webm",
		});
		const clip: Clip = {
			id: recordingId,
			audio: blob,
			mime: blob.type,
			created: Date.now(),
			epoch: recordingEpoch,
			sent: false,
			streaming: recording.streaming,
			chunks: recording.streaming ? chunks : undefined,
		};
		// Local echo does not wait for a network round trip or Whisper. The
		// transcript carrying this id will replace the bubble in place.
		if (!enqueueOutbox(clip)) return;
		if (recording.streaming && ws?.readyState === WebSocket.OPEN) {
			try {
				ws.send(sttStartHeader(clip));
				ws.send(sttEndHeader(clip));
				clip.sent = true;
			} catch {
				clip.sent = false;
			}
		}
		appendTurn(pendingEntry(clip));
		flushOutbox();
	};
	recorder.onerror = (event) => {
		if (recorderFailed) return;
		recorderFailed = true;
		if (activeRecording?.recorder === recorder) activeRecording = null;
		if (mediaRecorder === recorder) mediaRecorder = null;
		starting = false;
		releaseStream();
		resumeHandsFreeAfterPtt();
		setRecordingUI(false);
		statusEl.textContent = "Recording failed (" + errorName(event.error) + ").";
		statusEl.classList.add("error");
	};
	// Sampled here, as recording actually begins, because that is what the
	// clip is stamped with. Nothing later -- upload, transcription -- is
	// early enough to be safe.
	try {
		recorder.start(recordingStreaming ? 200 : undefined);
	} catch (err) {
		recorderFailed = true;
		if (activeRecording?.recorder === recorder) activeRecording = null;
		releaseStream();
		resumeHandsFreeAfterPtt();
		mediaRecorder = null;
		starting = false;
		setRecordingUI(false);
		statusEl.textContent =
			"This browser cannot record audio (" + errorName(err) + ").";
		statusEl.classList.add("error");
		return;
	}
	starting = false;
	setRecordingUI(true);
	statusEl.textContent =
		"Recording... Send when you are done, Discard to throw it away.";
	statusEl.classList.remove("error");
}

function stopRecording(send: boolean): void {
	// Set before the state check so a press landing inside the getUserMedia
	// await is still honoured once the permission resolves.
	if (starting) {
		startCancelled = true;
		setRecordingUI(false);
		return;
	}
	if (activeRecording && activeRecording.recorder.state !== "inactive") {
		activeRecording.discard = !send;
		activeRecording.recorder.stop();
	}
	setRecordingUI(false);
}

function isRecording(): boolean {
	return mediaRecorder?.state === "recording";
}

function submitHandsFreeClip(audio: Blob, mime: string, epoch: number): void {
	if (!snapshotReady || epoch !== turnEpoch) return;
	const clip: Clip = {
		id: globalThis.crypto?.randomUUID
			? globalThis.crypto.randomUUID()
			: `${Date.now()}-${++clipSequence}`,
		audio,
		mime: mime || audio.type || "audio/webm",
		created: Date.now(),
		epoch,
		sent: false,
		streaming: false,
	};
	if (!enqueueOutbox(clip)) return;
	appendTurn(pendingEntry(clip));
	flushOutbox();
}

function renderHandsFreeState(detail: {
	state: string;
	message: string;
	leaseRemainingMs: number;
}): void {
	const active = detail.state !== "off" && detail.state !== "error";
	handsFreeBtn.setAttribute("aria-pressed", active ? "true" : "false");
	handsFreeBtn.textContent = active
		? "Disable hands-free listening"
		: "Enable hands-free listening";
	handsFreeStatusEl.textContent = detail.message;
	handsFreeStatusEl.classList.toggle("error", detail.state === "error");
	const leaseStates =
		detail.state === "lease" || detail.state === "lease_capturing";
	handsFreeLeaseEl.textContent = leaseStates
		? `Follow-up lease: ${Math.ceil(detail.leaseRemainingMs / 1000)} seconds remaining.`
		: "";
}

btn.addEventListener("click", () => {
	startRecording();
});
async function enableHandsFree(): Promise<void> {
	if (handsFreeController) {
		await handsFreeController.enable();
		return;
	}
	if (handsFreeStartup) return handsFreeStartup;
	handsFreeStartup = (async () => {
		handsFreeBtn.disabled = true;
		renderHandsFreeState({
			state: "starting",
			message: "Loading the local wake-word detector...",
			leaseRemainingMs: 0,
		});
		try {
			const { createWakeWordDetector } = await import("./wake_word.js");
			handsFreeController = new HandsFreeController({
				wakeDetector: createWakeWordDetector(),
				isSnapshotReady: () => snapshotReady,
				currentEpoch: () => turnEpoch,
				isPttActive: () => starting || isRecording() || activeRecording !== null,
				onClip: submitHandsFreeClip,
				onState: renderHandsFreeState,
			});
			await handsFreeController.enable();
		} catch (error) {
			handsFreeController = null;
			renderHandsFreeState({
				state: "error",
				message: `Hands-free detector could not load (${errorText(error)}).`,
				leaseRemainingMs: 0,
			});
		} finally {
			handsFreeStartup = null;
			handsFreeBtn.disabled = ws?.readyState !== WebSocket.OPEN;
		}
	})();
	return handsFreeStartup;
}

handsFreeBtn.addEventListener("click", () => {
	if (handsFreeController?.isEnabled) {
		handsFreeController.disable();
	} else {
		void enableHandsFree();
	}
});
hangupBtn.addEventListener("click", hangup);
routeSelect.addEventListener("change", () => {
	handsFreeController?.disable("Hands-free stopped while changing the line.");
	clearResponseBarrier();
	statusEl.textContent =
		routeSelect.value === "operator"
			? "Going back to the operator..."
			: "Connecting to " + routeSelect.value + "...";
	post("/connect", { project: routeSelect.value }, routeSelect);
});
modelSelect.addEventListener("change", () => {
	statusEl.textContent = "Switching to " + modelSelect.value + "...";
	post("/model", { model: modelSelect.value }, modelSelect);
});
thinkingSelect.addEventListener("change", () => {
	statusEl.textContent = "Setting thinking to " + thinkingSelect.value + "...";
	post("/thinking", { level: thinkingSelect.value }, thinkingSelect);
});
sendBtn.addEventListener("click", () => stopRecording(true));
cancelBtn.addEventListener("click", () => stopRecording(false));
retryBtn.addEventListener("click", () => {
	outbox.forEach((clip) => (clip.sent = false));
	statusEl.textContent = "Forcing a fresh connection and retrying...";
	statusEl.classList.remove("error");
	connect();
});

type WorkspaceView = "auto" | "system" | "visual" | "comms" | "theater";
type ViewSource = "agent" | "user";

const theaterExit = getElement<HTMLButtonElement>("theaterExit");
const stageZoom = getElement<HTMLElement>("stageZoom");
let requestedWorkspaceView: WorkspaceView = "auto";
let userPinnedView = false;
let previousWorkspaceFocus: HTMLElement | null = null;

const hasVisual = () => document.body.classList.contains("has-diagram");
let lastScreenState = "";

function reportWorkspaceState(force = false): void {
	if (!ws || ws.readyState !== WebSocket.OPEN) return;
	const payload = screenStateMessage(
		document.body.classList.contains("theater")
			? "theater"
			: document.body.dataset.view || "auto",
		hasVisual(),
		document.body.dataset.visualKind || "",
		document.getElementById("stageTitle")?.textContent || "",
		document.body.classList.contains("stage-stale"),
	);
	if (!force && payload === lastScreenState) return;
	lastScreenState = payload;
	try {
		ws.send(payload);
	} catch {
		/* The reconnect snapshot reports it again. */
	}
}

function normalizeWorkspaceTarget(target: string): WorkspaceView | null {
	switch (target.trim().toLowerCase()) {
		case "auto":
		case "overview":
		case "grid":
		case "split":
			return "auto";
		case "system":
		case "magi":
		case "routing":
		case "bay1":
			return "system";
		case "visual":
		case "stage":
		case "bay2":
			return "visual";
		case "comms":
		case "transcript":
		case "bay3":
			return "comms";
		case "theater":
			return "theater";
		default:
			return null;
	}
}

function applyWorkspaceView(): void {
	const effective =
		(requestedWorkspaceView === "visual" || requestedWorkspaceView === "theater") &&
		!hasVisual()
			? "auto"
			: requestedWorkspaceView;
	const theater = effective === "theater";
	const wasTheater = document.body.classList.contains("theater");

	document.body.dataset.view = theater ? "visual" : effective;
	document.body.classList.toggle("theater", theater);
	document
		.querySelectorAll<HTMLButtonElement>("[data-view]")
		.forEach((control) => {
			control.setAttribute(
				"aria-pressed",
				control.dataset.view === effective ? "true" : "false",
			);
		});

	if (theater && !wasTheater) {
		previousWorkspaceFocus =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		theaterExit.focus();
	} else if (!theater && wasTheater) {
		if (previousWorkspaceFocus && document.body.contains(previousWorkspaceFocus)) {
			previousWorkspaceFocus.focus();
		}
		logEl.scrollTop = logEl.scrollHeight;
	}
	reportWorkspaceState();
}

function setWorkspaceView(target: string, source: ViewSource): void {
	const next = normalizeWorkspaceTarget(target);
	if (!next || (source === "agent" && userPinnedView)) return;
	requestedWorkspaceView = next;
	if (source === "user") userPinnedView = next !== "auto";
	applyWorkspaceView();
}

document.addEventListener("switchboard:stage-change", () =>
	reportWorkspaceState(),
);

new MutationObserver(applyWorkspaceView).observe(document.body, {
	attributes: true,
	attributeFilter: ["class"],
});

stageZoom.addEventListener("click", (e: MouseEvent) => {
	const target = e.target;
	if (!(target instanceof HTMLElement)) return;
	if (target.id === "historyBack") historyBack();
	if (target.id === "historyForward") historyForward();
	if (target.id === "historyLive") historyLive();
});

theaterExit.addEventListener("click", () => setWorkspaceView("auto", "user"));

document.addEventListener("click", (e) => {
	const control = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(
		"[data-view]",
	);
	if (!control?.dataset.view) return;
	const next = normalizeWorkspaceTarget(control.dataset.view);
	if (next && userPinnedView && requestedWorkspaceView === next) {
		setWorkspaceView("auto", "user");
	} else {
		setWorkspaceView(control.dataset.view, "user");
	}
});

applyWorkspaceView();

// Space owns voice. Escape first protects a recording, then returns the
// workspace to its automatic composition.
document.addEventListener("keydown", (e) => {
	if (
		e.target instanceof HTMLElement &&
		e.target.matches("input, textarea, select, button")
	)
		return;
	if (e.code === "Space" && !btn.disabled) {
		e.preventDefault();
		isRecording() || starting ? stopRecording(true) : startRecording();
	} else if (e.code === "Escape" && (isRecording() || starting)) {
		stopRecording(false);
	} else if (e.code === "Digit1" || e.code === "KeyM") {
		setWorkspaceView("system", "user");
	} else if (e.code === "Digit2" || e.code === "KeyV") {
		setWorkspaceView("visual", "user");
	} else if (e.code === "Digit3" || e.code === "KeyC") {
		setWorkspaceView("comms", "user");
	} else if (e.code === "KeyT" && hasVisual()) {
		setWorkspaceView("theater", "user");
	} else if (e.code === "Escape") {
		setWorkspaceView("auto", "user");
	}
});

handsFreeBtn.disabled = true;
btn.disabled = true;
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "hidden") {
		handsFreeController?.disable("Hands-free stopped while the page is hidden.");
		clearResponseBarrier();
	}
});
window.addEventListener("pagehide", () => {
	handsFreeController?.disable("Hands-free stopped when the page was left.");
	clearResponseBarrier();
});
try {
	initMissionClock("missionClock");
	(
		globalThis as unknown as { synchroController?: SynchroController }
	).synchroController = initSynchro("synchroCanvas");
} catch {
	// Tactical canvas and mission clock enhancements degrade gracefully
}
connect();

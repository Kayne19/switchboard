import { clipHeader, decodeServerMessage, postJson } from "./protocol.js";

interface Clip {
	id: string;
	audio: Blob;
	mime: string;
	created: number;
	epoch: number;
	sent: boolean;
	accepted?: boolean;
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

let ws: WebSocket | null = null;
let mediaRecorder: MediaRecorder | null = null;
let activeRecording: {
	recorder: MediaRecorder;
	discard: boolean;
} | null = null;
const audioQueue: Blob[] = [];
let isPlaying = false;
let pendingAudioGeneration: number | null = null;
let audioEpoch = 0;
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
let clipSequence = 0;
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
let playAttemptToken = 0;
let turnStarted = 0;
let clockTimer: ReturnType<typeof setInterval> | null = null;

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
	outbox = outbox.filter((clip) => !completed.has(clip.id));
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
	if (
		playbackOwner !== owner ||
		owner.consumed ||
		owner.pendingAttempt !== null
	)
		return;
	owner.paused = false;
	owner.seeked = false;
	isPlaying = true;
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

// The status message promises that a page interaction resumes blocked audio.
// Keep that gesture path here rather than relying on a later clip to arrive.
document.addEventListener("click", (event?: MouseEvent) => {
	if (event?.target === player) return;
	const owner = playbackOwner;
	if (!owner) {
		if (audioQueue.length) playNext();
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

function setRoute(msg: BrowserMessage): void {
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
		pickerBusy ||
		!pickerOnProject ||
		!pickerModelSwaps ||
		!pickerModelsAvailable;
	thinkingSelect.disabled =
		pickerBusy || (pickerOnProject && !pickerModelSwaps);
	modelSelect.title = !pickerModelsAvailable
		? pickerDiagnostic || "Model catalog unavailable"
		: "";
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
		ws.send(clipHeader(clip));
		ws.send(clip.audio);
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
		btn.disabled = false;
		outbox.forEach((clip) => (clip.sent = false));
		snapshotReady = false;
		startHeartbeat(socket, generation);
	};

	socket.onclose = () => {
		if (!current()) return;
		// Finalise the in-flight recording into the outbox rather than
		// discarding it. Accepted work is already server-owned; unaccepted
		// work remains locally retryable under the same id.
		if (isRecording() || starting) stopRecording(true);
		stopHeartbeat();
		outbox.forEach((clip) => (clip.sent = false));
		updateOutboxUI();
		statusEl.textContent = "Disconnected. Reconnecting...";
		statusEl.classList.add("error");
		btn.disabled = true;
		clearTimeoutSafe(reconnectTimer);
		reconnectTimer = setTimeout(() => {
			if (generation === socketGeneration) connect();
		}, 1500);
	};

	socket.onerror = () => {
		if (!current()) return;
		statusEl.textContent = "Connection error.";
		statusEl.classList.add("error");
	};

	socket.onmessage = (event) => {
		if (!current()) return;
		if (typeof event.data === "string") {
			const msg = decodeServerMessage(event.data);
			if (!msg) return;
			if (msg.type === "epoch") {
				// Adopt the server's epoch immediately and retire every queued or
				// currently playing clip from the old leg. Do this before allowing
				// reconnect retry, otherwise a pre-rescue clip can cross the barrier.
				if (typeof msg.generation === "number") {
					outbox = outbox.filter((clip) => clip.epoch === msg.generation);
					updateOutboxUI();
					turnEpoch = msg.generation;
					audioEpoch = msg.generation;
					snapshotReady = true;
					flushOutbox();
					audioQueue.length = 0;
					pendingAudioGeneration = null;
					if (playbackOwner) cleanupOwner(playbackOwner);
					isPlaying = false;
				}
			} else if (msg.type === "audio") {
				pendingAudioGeneration =
					typeof msg.generation === "number" ? msg.generation : null;
			} else if (msg.type === "pong") {
				if (msg.nonce === pendingPong) {
					pendingPong = null;
					clearTimeoutSafe(pongDeadlineTimer);
					pongDeadlineTimer = null;
					clearTimeoutSafe(heartbeatTimer);
					startHeartbeat(socket, generation);
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
					outbox = outbox.filter((clip) => clip.id !== msg.id);
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
					msg.route === "operator"
						? "Operator"
						: whoEl.textContent || "working",
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
					statusEl.textContent =
						"Got it — you're next, once this turn finishes.";
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
				// Undefined if the CDN never loaded. The call is still worth
				// noting in the transcript so the caller knows one was sent.
				window.renderDiagram?.(msg);
			} else if (msg.type === "error") {
				stopActivity();
				const pending = turnForClip(msg.id);
				if (pending) {
					outbox = outbox.filter((clip) => clip.id !== msg.id);
					updateOutboxUI();
					pending.classList.remove("pending");
					getChildElement<HTMLElement>(pending, ".body").textContent =
						"Voice clip failed: " + msg.message;
				}
				statusEl.textContent = "Error: " + msg.message;
				statusEl.classList.add("error");
			}
		} else {
			// Binary frame: mp3. Its preceding metadata frame identifies the
			// generation, so stale queued audio cannot survive a rescue.
			if (
				pendingAudioGeneration !== null &&
				pendingAudioGeneration !== audioEpoch
			) {
				pendingAudioGeneration = null;
				return;
			}
			audioQueue.push(new Blob([event.data], { type: "audio/mpeg" }));
			pendingAudioGeneration = null;
			if (!isPlaying && !playbackOwner) {
				statusEl.textContent = "Playing speech...";
				playNext();
			} else {
				statusEl.textContent = `Queued (${audioQueue.length} waiting)...`;
			}
		}
	};
}

function setRecordingUI(on: boolean): void {
	btn.classList.toggle("hidden", on);
	cancelBtn.classList.toggle("hidden", !on);
	sendBtn.classList.toggle("hidden", !on);
}

async function startRecording() {
	if (starting || activeRecording || isRecording()) return;
	starting = true;
	startCancelled = false;
	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch (err) {
		starting = false;
		statusEl.textContent = "Microphone unavailable (" + errorName(err) + ").";
		statusEl.classList.add("error");
		return;
	}
	// Discard/Send pressed during the permission await: honour it instead of
	// starting a recording the caller already cancelled.
	if (startCancelled) {
		starting = false;
		stream.getTracks().forEach((t) => t.stop());
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
	let streamReleased = false;
	const releaseStream = () => {
		if (streamReleased) return;
		streamReleased = true;
		stream.getTracks().forEach((t) => t.stop());
	};
	let recorderFailed = false;
	const recording = { recorder, discard: false };
	activeRecording = recording;
	recorder.ondataavailable = (e) => {
		if (e.data.size > 0) chunks.push(e.data);
	};
	let recordingEpoch = turnEpoch;
	recorder.onstop = () => {
		releaseStream();
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
		const id = globalThis.crypto?.randomUUID
			? globalThis.crypto.randomUUID()
			: `${Date.now()}-${++clipSequence}`;
		const clip = {
			id,
			audio: blob,
			mime: blob.type,
			created: Date.now(),
			epoch: recordingEpoch,
			sent: false,
		};
		// Local echo does not wait for a network round trip or Whisper. The
		// transcript carrying this id will replace the bubble in place.
		outbox.push(clip);
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
		setRecordingUI(false);
		statusEl.textContent = "Recording failed (" + errorName(event.error) + ").";
		statusEl.classList.add("error");
	};
	// Sampled here, as recording actually begins, because that is what the
	// clip is stamped with. Nothing later -- upload, transcription -- is
	// early enough to be safe.
	recordingEpoch = turnEpoch;
	try {
		recorder.start();
	} catch (err) {
		recorderFailed = true;
		if (activeRecording?.recorder === recorder) activeRecording = null;
		releaseStream();
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

btn.addEventListener("click", () => {
	startRecording();
});
hangupBtn.addEventListener("click", hangup);
routeSelect.addEventListener("change", () => {
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

// Theater mode hides the entire voice interface and gives the screen to the
// diagram. One rule keeps it safe: the wish and the state are separate, and
// the state is only ever entered when there is a diagram to look at. Without
// one #stage is display:none, so hiding the column too would leave a blank
// page with nothing on it to press. Asking for theater early — by shortcut on
// an empty page, or by a stored preference on a cold load — arms it instead,
// and the next diagram arrives in theater.
const THEATER_KEY = "switchboard.theater";
const theaterExit = getElement<HTMLButtonElement>("theaterExit");
let wantsTheater = false;
// Where the transcript was parked on the way in. A display:none ancestor
// reports a scrollHeight of zero, so every scroll-to-bottom that ran while
// the column was hidden was a no-op and the log would come back pinned to
// the top of the call.
let logWasAtBottom = true;

const hasDiagram = () => document.body.classList.contains("has-diagram");
const inTheater = () => document.body.classList.contains("theater");

function applyTheater() {
	const active = wantsTheater && hasDiagram();
	if (active === inTheater()) return;
	if (active) {
		logWasAtBottom =
			logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
	}
	document.body.classList.toggle("theater", active);
	if (!active && logWasAtBottom) logEl.scrollTop = logEl.scrollHeight;
	// Nothing to say to the diagram from here. The canvas has just changed
	// size by most of a screen, but the SVG is sized absolutely — off its own
	// viewBox rather than off the panel — so the zoom is still the zoom, and
	// the ResizeObserver in the module script is what re-fits it. Which is
	// also what keeps the two scripts uncoupled: with the CDN down there is no
	// diagram to fit and nothing on this side goes looking for one.
}

function setTheater(on: boolean): void {
	wantsTheater = on;
	try {
		localStorage.setItem(THEATER_KEY, on ? "1" : "0");
	} catch {
		/* Private-mode Safari throws on write. The mode still works, it just
       does not survive a reload. */
	}
	applyTheater();
}

// renderDiagram lives in the other script and owns has-diagram; watching the
// class is how this side hears about a diagram without reaching into it.
// Re-entrant by nature — applyTheater writes a class too — which the
// no-change guard above turns into a cheap no-op.
new MutationObserver(applyTheater).observe(document.body, {
	attributes: true,
	attributeFilter: ["class"],
});

const stageZoom = getElement<HTMLElement>("stageZoom");
stageZoom.addEventListener("click", (e: MouseEvent) => {
	const target = e.target;
	if (target instanceof HTMLElement && target.dataset.stage === "theater")
		setTheater(true);
});
theaterExit.addEventListener("click", () => setTheater(false));

try {
	wantsTheater = localStorage.getItem(THEATER_KEY) === "1";
} catch {
	/* Reading it throws in the same places writing it does. */
}
applyTheater();

// Space toggles talk/send, Escape discards — but not while typing anywhere.
document.addEventListener("keydown", (e) => {
	// `select` and `button` included: after picking a route the select keeps
	// focus, and Space then started a recording instead of opening the
	// dropdown.
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
	} else if (e.code === "KeyT" && !isRecording() && !starting) {
		// Not mid-recording: pulling Send and Discard off the screen while the
		// caller is holding a clip is the one thing this must never do. The
		// wish is what toggles, not the state, so a second press cancels an
		// arming that has not had a diagram to act on yet.
		setTheater(!wantsTheater);
	} else if (e.code === "Escape" && inTheater()) {
		// Only once discard has had its refusal: Escape is the universal way out
		// of a full-screen anything, but it belongs to the recording first.
		setTheater(false);
	}
});

btn.disabled = true;
connect();

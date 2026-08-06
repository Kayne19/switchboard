import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync("web/app.ts", "utf8");

function compile(body, name) {
	const result = ts.transpileModule(body, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ES2022,
		},
		fileName: name,
		reportDiagnostics: true,
	});
	assert.deepEqual(result.diagnostics ?? [], [], `${name} should transpile`);
	return result.outputText;
}

function eventsNode() {
	const listeners = new Map();
	return {
		listeners,
		addEventListener(name, handler) {
			if (!listeners.has(name)) listeners.set(name, new Set());
			listeners.get(name).add(handler);
		},
		removeEventListener(name, handler) {
			listeners.get(name)?.delete(handler);
		},
		emit(name) {
			for (const handler of [...(listeners.get(name) || [])]) handler();
		},
		classList: { toggle() {}, add() {}, remove() {} },
	};
}

async function audioPlaybackRegressions() {
	const start = source.indexOf("function cleanupOwner(");
	const end = source.indexOf("// Rebuilt only when the set of options", start);
	assert.ok(start >= 0 && end > start, "audio playback section is present");

	const player = eventsNode();
	player.playCalls = [];
	player.playPromises = [];
	player.paused = false;
	player.ended = false;
	player.duration = 10;
	player.currentTime = 1;
	player.error = null;
	player.pauseCalls = 0;
	player.loadCalls = 0;
	player.activeSources = new Set();
	let currentSource = "";
	Object.defineProperty(player, "src", {
		configurable: true,
		get: () => currentSource,
		set: (value) => {
			currentSource = value;
			if (value) player.ended = false;
		},
	});
	player.play = () => {
		player.playCalls.push(player.src);
		player.activeSources.add(player.src);
		let resolve;
		let reject;
		const promise = new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		});
		player.playPromises.push({ resolve, reject });
		return promise;
	};
	player.pause = () => {
		player.pauseCalls += 1;
		player.paused = true;
		if (player.src) player.activeSources.delete(player.src);
	};
	player.removeAttribute = (name) => {
		if (name === "src") player.src = "";
	};
	player.load = () => {
		player.loadCalls += 1;
	};
	const urls = new Map();
	const revoked = [];
	const previousUrl = globalThis.URL;
	const previousDocument = globalThis.document;
	let clickHandler;
	globalThis.document = {
		addEventListener(name, handler) {
			if (name === "click") clickHandler = handler;
		},
	};
	globalThis.URL = {
		createObjectURL(blob) {
			const url = `blob:${urls.size}`;
			urls.set(url, blob);
			return url;
		},
		revokeObjectURL(url) {
			revoked.push(url);
		},
	};
	try {
		globalThis.__player = player;
		const encoded = Buffer.from(
			compile(
				`const audioQueue = [];
let isPlaying = false;
let playbackOwner = null;
let playbackToken = 0;
let playAttemptToken = 0;
const idleText = "idle";
const statusEl = { textContent: "", classList: { add() {}, remove() {} } };
function errorName(error) { return error instanceof Error ? error.name : "unknown error"; }
const player = globalThis.__player;
${source.slice(start, end)}
export { audioQueue, player, playNext };`,
				"audioPlayback",
			),
		).toString("base64");
		const loaded = await import(
			`data:text/javascript;base64,${encoded}#audioPlayback`
		);
		const first = new Blob(["first"]);
		const second = new Blob(["second"]);
		const third = new Blob(["third"]);
		loaded.audioQueue.push(first, second, third);
		loaded.playNext();
		const staleFirstHandlers = new Map(
			[...player.listeners].map(([name, handlers]) => [name, [...handlers]]),
		);
		assert.equal(urls.get(player.src), first);
		assert.equal(player.playCalls.length, 1);
		assert.equal(player.activeSources.size, 1, "one clip owns playback");
		player.playPromises[0].resolve();
		await Promise.resolve();

		// A pause retains A and queued B. Repeated clicks while play() is
		// unresolved must not issue duplicate resume attempts.
		player.paused = true;
		player.emit("pause");
		assert.equal(loaded.audioQueue.length, 2);
		clickHandler();
		clickHandler();
		assert.equal(player.playCalls.length, 2);
		player.paused = false;
		player.playPromises[1].resolve();
		await Promise.resolve();

		// Both event orders and duplicate events consume exactly once.
		player.paused = true;
		player.emit("pause");
		player.ended = true;
		player.emit("ended");
		player.emit("ended");
		await Promise.resolve();
		assert.equal(urls.get(player.src), second);
		assert.equal(loaded.audioQueue.length, 1);
		assert.equal(player.pauseCalls, 1);
		assert.equal(player.loadCalls, 1);
		assert.equal(player.activeSources.size, 1, "A is not audible beside B");
		assert.deepEqual(revoked, ["blob:0"]);

		player.playPromises[2].resolve();
		await Promise.resolve();
		const staleSecondHandlers = new Map(
			[...player.listeners].map(([name, handlers]) => [name, [...handlers]]),
		);
		player.ended = true;
		const playsBeforeNaturalEnd = player.playCalls.length;
		player.emit("ended");
		player.emit("ended");
		player.emit("pause");
		assert.equal(urls.get(player.src), third);
		assert.equal(player.playCalls.length, playsBeforeNaturalEnd + 1);
		assert.equal(player.activeSources.size, 1, "natural end leaves one owner");
		assert.equal(loaded.audioQueue.length, 0);
		player.playPromises[3].resolve();
		await Promise.resolve();

		// Retained A/B callbacks cannot mutate the newer owner.
		for (const handler of staleFirstHandlers.get("pause")) handler();
		for (const handler of staleFirstHandlers.get("ended")) handler();
		for (const handler of staleSecondHandlers.get("pause")) handler();
		assert.equal(urls.get(player.src), third);
		assert.equal(loaded.audioQueue.length, 0);

		// A reverse seek resets the guard, and NaN duration must never become
		// terminal by accident.
		player.ended = false;
		player.paused = true;
		player.currentTime = player.duration;
		player.emit("seeking");
		player.emit("pause");
		clickHandler();
		assert.equal(player.playCalls.length, 4);
		player.currentTime = 2;
		player.emit("seeking");
		clickHandler();
		assert.equal(player.playCalls.length, 5);
		player.playPromises[4].resolve();
		await Promise.resolve();

		// Error duplicates consume once.
		player.error = new Error("decode");
		player.emit("error");
		player.emit("error");
		assert.equal(loaded.audioQueue.length, 0);

		// Rejecting A after ownership has moved to B cannot requeue A. A fresh
		// rejection while still owner does requeue exactly once.
		player.error = null;
		const fourth = new Blob(["fourth"]);
		const fifth = new Blob(["fifth"]);
		loaded.audioQueue.push(fourth, fifth);
		loaded.playNext();
		const staleReject = player.playPromises[5].reject;
		loaded.playNext();
		assert.equal(urls.get(player.src), fifth);
		staleReject(new Error("autoplay"));
		await Promise.resolve();
		assert.equal(loaded.audioQueue.length, 0);
		player.playPromises[6].resolve();
		await Promise.resolve();
		player.ended = true;
		player.emit("ended");
		const sixth = new Blob(["sixth"]);
		loaded.audioQueue.push(sixth);
		loaded.playNext();
		player.playPromises[7].reject(new Error("blocked"));
		await Promise.resolve();
		assert.equal(loaded.audioQueue.length, 1);
		clickHandler();
		clickHandler();
		assert.equal(player.playCalls.length, 9);
		player.playPromises[8].resolve();
		await Promise.resolve();
		player.ended = true;
		player.emit("ended");
		assert.deepEqual(revoked, [
			"blob:0",
			"blob:1",
			"blob:2",
			"blob:3",
			"blob:4",
			"blob:5",
			"blob:6",
		]);

		// A terminal seek consumes once in either event order and never starts
		// the current clip again. The source tracker also proves replacement
		// pauses A before B becomes audible.
		const seekFirst = new Blob(["seek-first"]);
		const seekSecond = new Blob(["seek-second"]);
		const seekThird = new Blob(["seek-third"]);
		loaded.audioQueue.push(seekFirst, seekSecond, seekThird);
		loaded.playNext();
		const seekFirstUrl = player.src;
		assert.equal(player.activeSources.size, 1);
		player.playPromises[9].resolve();
		await Promise.resolve();
		player.paused = true;
		player.currentTime = player.duration;
		player.ended = false;
		player.emit("seeking");
		player.emit("pause");
		const playsBeforeTerminalEnd = player.playCalls.length;
		clickHandler();
		assert.equal(
			player.playCalls.length,
			playsBeforeTerminalEnd,
			"terminal pause is not resumed",
		);
		player.ended = true;
		player.emit("ended");
		player.emit("ended");
		assert.equal(urls.get(player.src), seekSecond);
		assert.equal(player.playCalls.length, playsBeforeTerminalEnd + 1);
		assert.equal(player.activeSources.has(seekFirstUrl), false);
		assert.equal(player.activeSources.size, 1);

		player.playPromises[10].resolve();
		await Promise.resolve();
		const staleSeekPause = [...(player.listeners.get("pause") || [])];
		player.currentTime = player.duration;
		player.ended = true;
		player.emit("ended");
		for (const handler of staleSeekPause) handler();
		assert.equal(urls.get(player.src), seekThird);
		assert.equal(player.playCalls.length, playsBeforeTerminalEnd + 2);
		assert.equal(player.activeSources.size, 1);
		player.playPromises[11].resolve();
		await Promise.resolve();
		player.ended = true;
		player.emit("ended");
		player.emit("ended");
		assert.equal(player.activeSources.size, 0);
		assert.deepEqual(revoked, [
			"blob:0",
			"blob:1",
			"blob:2",
			"blob:3",
			"blob:4",
			"blob:5",
			"blob:6",
			"blob:7",
			"blob:8",
			"blob:9",
		]);

		// Terminal seek events must consume even while play() is pending, in
		// either event order. A pause at duration without a seek remains resumable.
		const raceFirst = new Blob(["race-first"]);
		const raceSecond = new Blob(["race-second"]);
		const raceThird = new Blob(["race-third"]);
		loaded.audioQueue.push(raceFirst, raceSecond, raceThird);
		loaded.playNext();
		player.paused = true;
		player.currentTime = player.duration;
		player.ended = false;
		player.emit("seeking");
		player.emit("pause");
		const raceFirstUrl = player.src;
		player.ended = true;
		player.emit("ended");
		assert.equal(urls.get(player.src), raceSecond);
		assert.equal(player.activeSources.has(raceFirstUrl), false);

		const raceSecondHandlers = new Map(
			[...player.listeners].map(([name, handlers]) => [name, [...handlers]]),
		);
		player.ended = true;
		for (const handler of raceSecondHandlers.get("ended")) handler();
		for (const handler of raceSecondHandlers.get("pause")) handler();
		assert.equal(urls.get(player.src), raceThird);

		player.playPromises[12].resolve();
		player.playPromises[13].resolve();
		await Promise.resolve();
		player.playPromises[14].resolve();
		await Promise.resolve();
		player.paused = true;
		player.ended = false;
		player.currentTime = player.duration;
		player.emit("pause");
		const playsBeforeNativeClick = player.playCalls.length;
		clickHandler({ target: player });
		assert.equal(
			player.playCalls.length,
			playsBeforeNativeClick,
			"native player controls do not resume audio",
		);
		clickHandler({ target: null });
		assert.equal(player.playCalls.length, playsBeforeNativeClick + 1);
		player.playPromises[15].resolve();
		await Promise.resolve();
		player.ended = true;
		player.emit("ended");
		assert.deepEqual(revoked, [
			"blob:0",
			"blob:1",
			"blob:2",
			"blob:3",
			"blob:4",
			"blob:5",
			"blob:6",
			"blob:7",
			"blob:8",
			"blob:9",
			"blob:10",
			"blob:11",
			"blob:12",
		]);
	} finally {
		globalThis.URL = previousUrl;
		if (previousDocument === undefined) delete globalThis.document;
		else globalThis.document = previousDocument;
		delete globalThis.__player;
	}
}

async function recorderLifecycleRegressions() {
	const start = source.indexOf("function setRecordingUI");
	const end = source.indexOf('btn.addEventListener("click"', start);
	assert.ok(start >= 0 && end > start, "recorder section is present");

	const makeNode = () => {
		const node = eventsNode();
		node.classList = { toggle() {}, add() {}, remove() {} };
		return node;
	};
	const btn = makeNode();
	const cancelBtn = makeNode();
	const sendBtn = makeNode();
	const statusEl = { textContent: "", classList: { add() {}, remove() {} } };
	const streams = [];
	const previousNavigator = Object.getOwnPropertyDescriptor(
		globalThis,
		"navigator",
	);
	let getUserMediaCalls = 0;
	let resolveMedia;
	let rejectMedia;
	const mediaPromise = () =>
		new Promise((resolve, reject) => {
			resolveMedia = resolve;
			rejectMedia = reject;
		});
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		writable: true,
		value: {
			mediaDevices: {
				getUserMedia() {
					getUserMediaCalls += 1;
					return mediaPromise();
				},
			},
		},
	});
	let recorderCount = 0;
	class FakeRecorder {
		static isTypeSupported() {
			return true;
		}
		constructor(stream) {
			if (globalThis.__throwRecorder) throw new Error("codec unavailable");
			this.stream = stream;
			this.state = "inactive";
			this.mimeType = "audio/webm";
			recorderCount += 1;
			globalThis.__recorder = this;
		}
		start() {
			this.state = "recording";
		}
		stop() {
			this.state = "inactive";
			if (!globalThis.__deferStop) this.onstop?.();
		}
	}
	globalThis.MediaRecorder = FakeRecorder;
	globalThis.window = { MediaRecorder: FakeRecorder };
	const stream = () => {
		let stops = 0;
		const value = {
			getTracks: () => [{ stop: () => (stops += 1) }],
			stops: () => stops,
		};
		streams.push(value);
		return value;
	};
	const harness = `
let mediaRecorder = null;
let activeRecording = null;
let starting = false;
let startCancelled = false;
let turnEpoch = 0;
let clipSequence = 0;
let outbox = [];
const btn = globalThis.__btn;
const cancelBtn = globalThis.__cancelBtn;
const sendBtn = globalThis.__sendBtn;
const statusEl = globalThis.__status;
const idleText = "idle";
function appendTurn() {}
function pendingEntry(clip) { return clip; }
function updateOutboxUI() {}
function flushOutbox() {}
function errorName(error) { return error instanceof Error ? error.name : "unknown error"; }
${source.slice(start, end)}
export { startRecording, stopRecording, isRecording, outbox };`;
	globalThis.__btn = btn;
	globalThis.__cancelBtn = cancelBtn;
	globalThis.__sendBtn = sendBtn;
	globalThis.__status = statusEl;
	const encoded = Buffer.from(compile(harness, "recorderLifecycle")).toString(
		"base64",
	);
	const recorder = await import(
		`data:text/javascript;base64,${encoded}#recorderLifecycle`
	);
	try {
		const firstStart = recorder.startRecording();
		const duplicateStart = recorder.startRecording();
		assert.equal(getUserMediaCalls, 1, "permission request is deduplicated");
		resolveMedia(stream());
		await Promise.all([firstStart, duplicateStart]);
		assert.equal(recorderCount, 1, "one stream creates one recorder");
		assert.equal(recorder.isRecording(), true);
		recorder.stopRecording(false);
		assert.equal(streams[0].stops(), 1, "discard stops the microphone track");

		globalThis.__throwRecorder = true;
		const failedStart = recorder.startRecording();
		resolveMedia(stream());
		await failedStart;
		assert.equal(
			streams[1].stops(),
			1,
			"constructor failure releases the stream",
		);
		assert.match(statusEl.textContent, /cannot record audio/);
		delete globalThis.__throwRecorder;

		const errorStart = recorder.startRecording();
		resolveMedia(stream());
		await errorStart;
		assert.equal(typeof globalThis.__recorder.onerror, "function");
		globalThis.__recorder.state = "inactive";
		globalThis.__recorder.onerror({ error: new Error("encoder failed") });
		assert.equal(
			streams[2].stops(),
			1,
			"recorder errors release the microphone",
		);

		// A recorder may finish asynchronously after the next recording starts.
		// Its chunks and discard choice must stay attached to that recorder.
		globalThis.__deferStop = true;
		const oldStart = recorder.startRecording();
		resolveMedia(stream());
		await oldStart;
		const oldRecorder = globalThis.__recorder;
		recorder.stopRecording(false);
		const blockedStart = recorder.startRecording();
		await blockedStart;
		assert.equal(
			getUserMediaCalls,
			4,
			"new recording waits for terminal cleanup",
		);
		oldRecorder.ondataavailable({ data: new Blob(["old"]) });
		oldRecorder.onstop();
		assert.equal(
			recorder.outbox.length,
			0,
			"old discard stays with old recorder",
		);
		const nextStart = recorder.startRecording();
		resolveMedia(stream());
		await nextStart;
		const nextRecorder = globalThis.__recorder;
		recorder.stopRecording(true);
		nextRecorder.ondataavailable({ data: new Blob(["new"]) });
		nextRecorder.onstop();
		assert.equal(recorder.outbox.length, 1);
		assert.equal(recorder.outbox[0].audio.size, 3);
		globalThis.__deferStop = false;

		const denied = recorder.startRecording();
		rejectMedia(
			Object.assign(new Error("permission denied"), {
				name: "NotAllowedError",
			}),
		);
		await denied;
		assert.match(
			statusEl.textContent,
			/Microphone unavailable \(NotAllowedError\)/,
		);
	} finally {
		delete globalThis.__btn;
		delete globalThis.__cancelBtn;
		delete globalThis.__sendBtn;
		delete globalThis.__status;
		delete globalThis.__recorder;
		delete globalThis.MediaRecorder;
		delete globalThis.window;
		if (previousNavigator) {
			Object.defineProperty(globalThis, "navigator", previousNavigator);
		} else {
			delete globalThis.navigator;
		}
	}
}

async function modelPickerRegressions() {
	const start = source.indexOf("function fillSelect(");
	const end = source.indexOf("// Both selects act immediately", start);
	assert.ok(start >= 0 && end > start, "model picker section is present");
	class Select {
		constructor() {
			this.dataset = {};
			this.options = [];
			this.value = "";
			this.disabled = false;
		}
		set textContent(value) {
			if (value === "") this.options = [];
		}
		get textContent() {
			return this.options.map((option) => option.textContent).join("");
		}
		appendChild(option) {
			this.options.push(option);
		}
	}
	const routeSelect = new Select();
	const modelSelect = new Select();
	const thinkingSelect = new Select();
	const whoEl = { textContent: "" };
	const modelEl = { textContent: "" };
	const lineEl = { classList: { toggle() {} } };
	const hangupBtn = { classList: { toggle() {} } };
	globalThis.document = {
		createElement: () => ({ value: "", textContent: "" }),
	};
	const harness = `
const routeSelect = globalThis.__routeSelect;
const modelSelect = globalThis.__modelSelect;
const thinkingSelect = globalThis.__thinkingSelect;
const whoEl = globalThis.__whoEl;
const modelEl = globalThis.__modelEl;
const lineEl = globalThis.__lineEl;
const hangupBtn = globalThis.__hangupBtn;
${source.slice(start, end)}
export { setRoute };`;
	globalThis.__routeSelect = routeSelect;
	globalThis.__modelSelect = modelSelect;
	globalThis.__thinkingSelect = thinkingSelect;
	globalThis.__whoEl = whoEl;
	globalThis.__modelEl = modelEl;
	globalThis.__lineEl = lineEl;
	globalThis.__hangupBtn = hangupBtn;
	const encoded = Buffer.from(compile(harness, "modelPicker")).toString(
		"base64",
	);
	try {
		const picker = await import(
			`data:text/javascript;base64,${encoded}#modelPicker`
		);
		picker.setRoute({
			type: "status",
			route: "alpha",
			model_name: "openai/gpt-5.6",
			models: [
				{ provider: "openai", model: "gpt-5.6", thinks: true },
				{ provider: "moonshot", model: "luna", thinks: true },
				{ provider: "openai", model: "sol", thinks: false },
			],
			levels: ["off", "high"],
			model_swaps: true,
		});
		assert.deepEqual(
			modelSelect.options.map((option) => option.value),
			["openai/gpt-5.6", "moonshot/luna", "openai/sol"],
		);
		assert.equal(modelSelect.value, "openai/gpt-5.6");
		assert.equal(modelSelect.disabled, false);

		picker.setRoute({
			type: "status",
			route: "alpha",
			model_name: "provider/model",
			models: [],
			models_available: false,
			models_diagnostic: "model listing failed or timed out",
			levels: ["off", "high"],
			model_swaps: true,
		});
		assert.equal(
			modelSelect.disabled,
			true,
			"unavailable catalog disables model picker",
		);
		assert.equal(
			modelSelect.title,
			"model listing failed or timed out",
			"catalog failure is exposed as the picker diagnostic",
		);
		assert.equal(
			thinkingSelect.disabled,
			false,
			"catalog failure does not disable thinking control",
		);
	} finally {
		delete globalThis.document;
		for (const name of [
			"__routeSelect",
			"__modelSelect",
			"__thinkingSelect",
			"__whoEl",
			"__modelEl",
			"__lineEl",
			"__hangupBtn",
		])
			delete globalThis[name];
	}
}

async function pickerRequestRegressions() {
	const start = source.indexOf("function fillSelect(");
	const end = source.indexOf("// Goes straight to the backend", start);
	assert.ok(start >= 0 && end > start, "picker request section is present");
	class Select {
		constructor() {
			this.dataset = {};
			this.options = [];
			this.value = "";
			this.disabled = false;
			this.title = "";
		}
		set textContent(value) {
			if (value === "") this.options = [];
		}
		appendChild(option) {
			this.options.push(option);
		}
	}
	const routeSelect = new Select();
	const modelSelect = new Select();
	const thinkingSelect = new Select();
	const statusEl = {
		textContent: "",
		classList: { add() {}, remove() {} },
	};
	const whoEl = { textContent: "" };
	const modelEl = { textContent: "" };
	const lineEl = { classList: { toggle() {} } };
	const hangupBtn = { classList: { toggle() {} } };
	const calls = [];
	const completions = [];
	globalThis.__postJson = (url, body) => {
		calls.push({ url, body });
		return new Promise((resolve, reject) =>
			completions.push({ resolve, reject }),
		);
	};
	globalThis.document = {
		createElement: () => ({ value: "", textContent: "" }),
	};
	const harness = `
const routeSelect = globalThis.__routeSelect;
const modelSelect = globalThis.__modelSelect;
const thinkingSelect = globalThis.__thinkingSelect;
const whoEl = globalThis.__whoEl;
const modelEl = globalThis.__modelEl;
const lineEl = globalThis.__lineEl;
const hangupBtn = globalThis.__hangupBtn;
const statusEl = globalThis.__pickerStatus;
const postJson = globalThis.__postJson;
function errorText(error) { return error instanceof Error ? error.message : "unknown"; }
${source.slice(start, end)}
export { setRoute, post };`;
	globalThis.__routeSelect = routeSelect;
	globalThis.__modelSelect = modelSelect;
	globalThis.__thinkingSelect = thinkingSelect;
	globalThis.__whoEl = whoEl;
	globalThis.__modelEl = modelEl;
	globalThis.__lineEl = lineEl;
	globalThis.__hangupBtn = hangupBtn;
	globalThis.__pickerStatus = statusEl;
	const encoded = Buffer.from(compile(harness, "pickerRequests")).toString(
		"base64",
	);
	try {
		const picker = await import(
			`data:text/javascript;base64,${encoded}#pickerRequests`
		);
		picker.setRoute({
			type: "status",
			route: "fixture-project",
			model_name: "fixture-provider/fixture-model",
			models: [
				{ provider: "fixture-provider", model: "fixture-model", thinks: true },
			],
			levels: ["off", "high"],
			model_swaps: true,
			models_available: true,
		});

		const route = picker.post(
			"/connect",
			{ project: "fixture-project" },
			routeSelect,
		);
		const model = picker.post(
			"/model",
			{ model: "fixture-provider/fixture-model" },
			modelSelect,
		);
		// The native select already contains the user's new value when the
		// change handler runs; the picker must still remember the committed one.
		thinkingSelect.value = "high";
		const thinking = picker.post(
			"/thinking",
			{ level: "high" },
			thinkingSelect,
		);
		assert.equal(calls.length, 1, "cross-control requests are serialized");
		assert.deepEqual(calls[0], {
			url: "/connect",
			body: { project: "fixture-project" },
		});
		assert.equal(
			routeSelect.disabled,
			true,
			"route is disabled while queue is active",
		);
		assert.equal(
			modelSelect.disabled,
			true,
			"model is disabled while queue is active",
		);
		assert.equal(
			thinkingSelect.disabled,
			true,
			"thinking is disabled while queue is active",
		);

		const settle = async () => {
			for (let i = 0; i < 5; i += 1) await Promise.resolve();
		};
		completions.shift().resolve({ error: null });
		await settle();
		assert.equal(calls.length, 2, "model starts only after route settles");
		completions.shift().resolve({ error: null });
		await settle();
		assert.equal(calls.length, 3, "thinking starts only after model settles");
		completions.shift().reject(new Error("backend refused thinking"));
		await Promise.all([route, model, thinking]);
		assert.equal(
			statusEl.textContent,
			"That did not go through: backend refused thinking",
			"the final cross-control error is shown",
		);
		assert.equal(routeSelect.disabled, false);
		assert.equal(modelSelect.disabled, false);
		assert.equal(thinkingSelect.disabled, false);
		assert.equal(
			thinkingSelect.value,
			"",
			"failed picker request restores the last committed value",
		);
	} finally {
		delete globalThis.document;
		for (const name of [
			"__routeSelect",
			"__modelSelect",
			"__thinkingSelect",
			"__whoEl",
			"__modelEl",
			"__lineEl",
			"__hangupBtn",
			"__pickerStatus",
			"__postJson",
		])
			delete globalThis[name];
	}
}

await audioPlaybackRegressions();
await recorderLifecycleRegressions();
await modelPickerRegressions();
await pickerRequestRegressions();
console.log("ok — app audio lifecycle, playback ordering, and model picker");

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
			listeners.set(name, handler);
		},
		classList: { toggle() {}, add() {}, remove() {} },
	};
}

async function audioPlaybackRegressions() {
	const start = source.indexOf("function playNext()");
	const end = source.indexOf("// Rebuilt only when the set of options", start);
	assert.ok(start >= 0 && end > start, "audio playback section is present");

	const player = eventsNode();
	player.playCalls = [];
	player.play = () => {
		player.playCalls.push(player.src);
		return Promise.resolve();
	};
	player.ended = false;
	const urls = new Map();
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
		revokeObjectURL() {},
	};
	try {
		globalThis.__player = player;
		const encoded = Buffer.from(
			compile(
				`const audioQueue = [];
let isPlaying = false;
let playPending = false;
let playbackGeneration = 0;
let currentUrl = null;
let currentBlob = null;
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
		loaded.audioQueue.push(first, second);
		loaded.playNext();
		await Promise.resolve();
		assert.equal(urls.get(player.src), first);
		assert.equal(player.playCalls.length, 1);

		// Browsers can report pause immediately before ended when the caller
		// drags to the end. That pair must advance once, not requeue the clip and
		// replay it as the next item.
		player.ended = false;
		player.listeners.get("pause")();
		clickHandler();
		await Promise.resolve();
		assert.equal(
			player.playCalls.length,
			2,
			"a page click resumes a paused clip",
		);
		player.ended = true;
		player.listeners.get("ended")();
		await Promise.resolve();
		assert.equal(urls.get(player.src), second);
		assert.deepEqual(
			player.playCalls.map((url) => urls.get(url)),
			[first, first, second],
		);
		assert.equal(loaded.audioQueue.length, 0);

		// A stale pause after ended must not alter the new clip or enqueue the
		// already-finished one.
		player.listeners.get("pause")();
		assert.equal(urls.get(player.src), second);
		assert.equal(loaded.audioQueue.length, 0);
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

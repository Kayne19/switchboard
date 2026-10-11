import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import ts from "typescript";

const source = readFileSync("apps/frontend/src/hands_free.ts", "utf8");
const machineSource = readFileSync(
	"apps/frontend/src/hands_free_machine.ts",
	"utf8",
);
const detectorSource = readFileSync(
	"apps/frontend/src/wake_detector.ts",
	"utf8",
);
const wakeWordSource = readFileSync("apps/frontend/src/wake_word.ts", "utf8");
const endpointSource = readFileSync(
	"apps/frontend/src/speech_endpoint.ts",
	"utf8",
);
const sileroSource = readFileSync("apps/frontend/src/silero_vad.ts", "utf8");
const worklet = readFileSync("apps/frontend/src/vad-worklet.ts", "utf8");
const runtime = readFileSync(
	"apps/frontend/src/runtime/callRuntime.ts",
	"utf8",
);
const pageSource = readFileSync("apps/frontend/index.html", "utf8");
const page = readFileSync("static/index.html", "utf8");
const packageRuntime = readFileSync(
	"static/openwakeword/wake-word-engine.js",
	"utf8",
);
const ortRuntime = readFileSync(
	"static/openwakeword/ort/ort.wasm.bundle.min.mjs",
	"utf8",
);

function compile(text, fileName) {
	const compiled = ts.transpileModule(text, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ES2022,
		},
		fileName,
		reportDiagnostics: true,
	});
	assert.deepEqual(
		compiled.diagnostics ?? [],
		[],
		`${fileName} should transpile`,
	);
	return compiled.outputText;
}

const moduleUrl = (text, fileName, tag) =>
	`data:text/javascript;base64,${Buffer.from(compile(text, fileName)).toString(
		"base64",
	)}#${tag}`;

// A data: URL cannot resolve a relative import, so hands_free.ts is pointed
// at the machine module loaded first (it imports only types back).
const machineUrl = moduleUrl(machineSource, "hands_free_machine.ts", "hands-free-machine");
const handsFreeUrl = moduleUrl(
	source.replaceAll('"./hands_free_machine.js"', JSON.stringify(machineUrl)),
	"hands_free.ts",
	"hands-free",
);
const handsFree = await import(handsFreeUrl);
const { WakeWordDetectorAdapter } = await import(
	moduleUrl(detectorSource, "wake_detector.ts", "wake-detector")
);
// The endpointer reads its thresholds and timings from hands_free.ts, the one
// place they are written; a data: URL cannot resolve a relative import, so the
// test points it at the module it already loaded.
const { SileroSpeechEndpointer } = await import(
	moduleUrl(
		endpointSource.replace('"./hands_free.js"', JSON.stringify(handsFreeUrl)),
		"speech_endpoint.ts",
		"speech-endpoint",
	)
);

assert.equal(handsFree.WAKE_PHRASE, "Damocles");
assert.equal(handsFree.WAKE_SAMPLE_RATE, 16000);
assert.equal(handsFree.WAKE_FRAME_SAMPLES, 1280);
assert.equal(handsFree.VAD_TRAILING_SILENCE_MS, 900);
assert.equal(handsFree.FOLLOW_UP_LEASE_MS, 8000);
assert.equal(handsFree.MAX_HANDS_FREE_UTTERANCE_MS, 30000);
assert.equal(handsFree.PLAYBACK_DRAIN_DEBOUNCE_MS, 400);
assert.equal(handsFree.VAD_WINDOW_SAMPLES, 512);
assert.equal(handsFree.VAD_WINDOW_MS, 32);
assert.equal(handsFree.SPEECH_START_PROBABILITY, 0.5);
assert.equal(handsFree.SPEECH_END_PROBABILITY, 0.35);
assert.ok(
	handsFree.SPEECH_END_PROBABILITY < handsFree.SPEECH_START_PROBABILITY,
	"the exit threshold is the lower one, so the endpoint has hysteresis",
);
assert.equal("LocalWakeDetector" in handsFree, false);
assert.doesNotMatch(
	source,
	/acoustic envelope|syllabic bursts|threshold = 0\.018/,
);

class FakeSession {
	inputs = [];

	constructor(emit) {
		this.emit = emit;
	}

	async run(samples) {
		this.inputs.push(samples);
		this.emit({ keyword: "damocles", score: 0.91 });
	}
}

class FakeEngine {
	listeners = new Map();
	loaded = false;
	resetCount = 0;
	session = new FakeSession((payload) => this.emit("detect", payload));

	on(event, callback) {
		const callbacks = this.listeners.get(event) ?? new Set();
		callbacks.add(callback);
		this.listeners.set(event, callbacks);
		return () => callbacks.delete(callback);
	}

	async load() {
		this.loaded = true;
	}

	reset() {
		this.resetCount += 1;
	}

	async processChunk(samples) {
		assert.equal(this.loaded, true);
		await this.session.run(samples);
	}

	emit(event, payload) {
		for (const callback of this.listeners.get(event) ?? []) callback(payload);
	}
}

const engine = new FakeEngine();
const detector = new WakeWordDetectorAdapter(engine);
let detections = 0;
detector.onDetect(() => {
	detections += 1;
});
await detector.load();
const frame = new Float32Array(1280);
detector.process(frame);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(detections, 1, "adapter forwards a real engine detection");
assert.equal(engine.session.inputs[0], frame, "adapter forwards PCM unchanged");
detector.reset();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(engine.resetCount, 1, "reset reaches the engine session state");

let releaseBlocked;
let blockStarted;
const blockedStart = new Promise((resolve) => {
	blockStarted = resolve;
});
const blocked = new FakeEngine();
blocked.processChunk = async function (samples) {
	blockStarted();
	await new Promise((resolve) => {
		releaseBlocked = resolve;
	});
	await this.session.run(samples);
};
const blockedDetector = new WakeWordDetectorAdapter(blocked);
let staleDetections = 0;
blockedDetector.onDetect(() => {
	staleDetections += 1;
});
await blockedDetector.load();
blockedDetector.process(frame);
await blockedStart;
blockedDetector.reset();
releaseBlocked();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(
	staleDetections,
	0,
	"reset suppresses an in-flight stale detection",
);

// --- The Silero speech endpointer --------------------------------------
// The thresholds and the trailing-silence timing, over fakes. The real ONNX
// model is never loaded here: a window's probability comes from the script.

const SILENCE_WINDOWS = Math.ceil(
	handsFree.VAD_TRAILING_SILENCE_MS / handsFree.VAD_WINDOW_MS,
);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeVadModel {
	loaded = false;
	resetCount = 0;
	windows = [];
	probabilities = [];

	async load() {
		this.loaded = true;
	}

	reset() {
		this.resetCount += 1;
	}

	async probability(window) {
		assert.equal(this.loaded, true, "a window is scored only after load");
		assert.equal(
			window.length,
			handsFree.VAD_WINDOW_SAMPLES,
			"the model is fed Silero's window size",
		);
		this.windows.push(window);
		return this.probabilities.length ? this.probabilities.shift() : 0;
	}
}

async function endpointer() {
	const model = new FakeVadModel();
	const endpoint = new SileroSpeechEndpointer(model);
	const seen = { starts: 0, ends: 0, errors: [] };
	endpoint.onSpeechStart(() => {
		seen.starts += 1;
	});
	endpoint.onSpeechEnd(() => {
		seen.ends += 1;
	});
	endpoint.onError((error) => seen.errors.push(error));
	await endpoint.load();
	return { model, endpoint, seen };
}

async function speak(state, probability, windows) {
	for (let index = 0; index < windows; index += 1)
		state.model.probabilities.push(probability);
	state.endpoint.process(
		new Float32Array(handsFree.VAD_WINDOW_SAMPLES * windows),
	);
	await settle();
}

{
	// Windows are cut from the controller's frames, which do not divide into
	// them: two 1,280-sample frames are five 512-sample windows.
	const state = await endpointer();
	state.endpoint.process(new Float32Array(handsFree.WAKE_FRAME_SAMPLES));
	state.endpoint.process(new Float32Array(handsFree.WAKE_FRAME_SAMPLES));
	await settle();
	assert.equal(state.model.windows.length, 5, "frames are rewindowed to 512");
}

{
	const state = await endpointer();
	await speak(state, 0.4, 20);
	assert.equal(state.seen.starts, 0, "noise under the threshold is not speech");
	await speak(state, 0.9, 1);
	assert.equal(state.seen.starts, 1, "speech above the threshold starts");
	await speak(state, 0.9, 10);
	assert.equal(state.seen.starts, 1, "speech starts once, not per window");
	assert.equal(state.seen.ends, 0, "speech does not end while it is heard");
}

{
	const state = await endpointer();
	await speak(state, 0.9, 2);
	await speak(state, 0.0, SILENCE_WINDOWS - 1);
	assert.equal(
		state.seen.ends,
		0,
		"the turn holds until the trailing silence is over",
	);
	await speak(state, 0.0, 1);
	assert.equal(state.seen.ends, 1, "silence past 900 ms ends the turn");
}

{
	// A pause to think, then more words: under the start threshold but over
	// the exit threshold is still speech, and a short silence restarts the
	// trailing-silence count instead of ending the turn.
	const state = await endpointer();
	await speak(state, 0.9, 2);
	await speak(state, 0.4, 40);
	assert.equal(state.seen.ends, 0, "hysteresis keeps a quiet word in the turn");
	await speak(state, 0.0, SILENCE_WINDOWS - 1);
	await speak(state, 0.9, 1);
	await speak(state, 0.0, SILENCE_WINDOWS - 1);
	assert.equal(state.seen.ends, 0, "a short pause does not end the turn");
	assert.equal(state.seen.starts, 1, "and does not start a second turn");
}

{
	// A reset is the generation change: it reaches the model's recurrent
	// state, drops the half-filled window, and suppresses the window already
	// in flight, so stale audio cannot end or start a turn after it.
	const state = await endpointer();
	await speak(state, 0.9, 1);
	let release;
	let scored;
	const started = new Promise((resolve) => {
		scored = resolve;
	});
	state.model.probability = async () => {
		scored();
		await new Promise((resolve) => {
			release = resolve;
		});
		return 0.0;
	};
	state.endpoint.process(new Float32Array(handsFree.VAD_WINDOW_SAMPLES));
	await started;
	state.endpoint.reset();
	release();
	await settle();
	assert.equal(state.seen.ends, 0, "a stale window cannot end the turn");
	assert.equal(state.model.resetCount, 1, "reset reaches the recurrent state");
	state.model.probability = FakeVadModel.prototype.probability;
	await speak(state, 0.9, 1);
	assert.equal(state.seen.starts, 2, "after a reset, speech starts again");
}

{
	// A model that cannot score reports it, and hands-free stops (the
	// controller's onError path): there is no energy fallback to fall into.
	const state = await endpointer();
	state.model.probability = async () => {
		throw new Error("session gone");
	};
	state.endpoint.process(new Float32Array(handsFree.VAD_WINDOW_SAMPLES));
	await settle();
	assert.equal(state.seen.errors.length, 1, "a failed window is reported");
	state.model.probability = async () => Number.NaN;
	state.endpoint.process(new Float32Array(handsFree.VAD_WINDOW_SAMPLES));
	await settle();
	assert.equal(state.seen.errors.length, 2, "so is a window without a score");
}

{
	// A load failure is the one the controller reports; the next attempt
	// tries again rather than running without a model.
	const model = new FakeVadModel();
	let attempts = 0;
	model.load = async () => {
		attempts += 1;
		if (attempts === 1) throw new Error("model missing");
		model.loaded = true;
	};
	const endpoint = new SileroSpeechEndpointer(model);
	await assert.rejects(() => endpoint.load(), /model missing/);
	await endpoint.load();
	assert.equal(attempts, 2, "a failed load is not cached");
}

// The committed silero_vad.onnx is the v4 signature, and the adapter feeds
// exactly it: `input`, a scalar `sr`, and the recurrent state as `h` and `c`,
// with `output`, `hn` and `cn` back. A v5 model (one `state` tensor) or any
// other swap fails here instead of at a caller's microphone.
{
	const model = readFileSync("static/openwakeword/models/silero_vad.onnx");
	const varint = (at) => {
		let value = 0;
		let shift = 0;
		for (;;) {
			const byte = model[at++];
			value += (byte & 0x7f) * 2 ** shift;
			if ((byte & 0x80) === 0) return [value, at];
			shift += 7;
		}
	};
	// Protobuf fields of one message: (field number, wire type, bytes).
	const fields = (start, end) => {
		const found = [];
		let at = start;
		while (at < end) {
			const [key, afterKey] = varint(at);
			at = afterKey;
			const field = key >> 3;
			if ((key & 7) === 2) {
				const [length, afterLength] = varint(at);
				found.push([field, afterLength, afterLength + length]);
				at = afterLength + length;
			} else if ((key & 7) === 0) [, at] = varint(at);
			else if ((key & 7) === 5) at += 4;
			else if ((key & 7) === 1) at += 8;
			else throw new Error(`unsupported wire type in ${key}`);
		}
		return found;
	};
	const graph = fields(0, model.length).find(([field]) => field === 7);
	assert.ok(graph, "silero_vad.onnx has a graph");
	// ValueInfoProto.name is field 1; GraphProto input is 11, output 12.
	const names = (field) =>
		fields(graph[1], graph[2])
			.filter(([number]) => number === field)
			.map(([, start, end]) => {
				const name = fields(start, end).find(([number]) => number === 1);
				return model.toString("utf8", name[1], name[2]);
			});
	assert.deepEqual(names(11), ["input", "sr", "h", "c"]);
	assert.deepEqual(names(12), ["output", "hn", "cn"]);
	for (const name of ["input", "sr", "h", "c"])
		assert.match(sileroSource, new RegExp(`\\n\\t+${name}:`));
	assert.match(sileroSource, /results\.hn|results\["hn"\]/);
	assert.match(sileroSource, /results\.cn|results\["cn"\]/);
	assert.match(sileroSource, /results\.output|results\["output"\]/);
	assert.match(sileroSource, /import \* as ort from "onnxruntime-web"/);
	assert.match(sileroSource, /"\/openwakeword\/models\/silero_vad\.onnx"/);
	assert.match(sileroSource, /"\/openwakeword\/ort\/"/);
}

// The worklet is the capture seam only: 16 kHz PCM frames out and the level
// the voice indicator reads. Endpointing is the Silero endpointer's, so the
// energy threshold, its speech messages and its reset are gone from both
// sides (one endpointing path, docs/architecture.md rule 9).
assert.match(worklet, /type: "energy"/);
assert.match(worklet, /postMessage\(\{ type: "audio", samples: frame \}/);
assert.doesNotMatch(worklet, /postMessage\(\s*channel/);
for (const text of [worklet, source, machineSource]) {
	assert.doesNotMatch(text, /"speech_start"|"speech_end"|reset_endpoint/);
	assert.doesNotMatch(text, /noiseFloor|MIN_ENERGY/);
}
assert.match(runtime, /createWakeWordDetector/);
assert.match(runtime, /import\("\.\.\/wake_word"\)/);
assert.match(runtime, /createSpeechEndpointer/);
assert.match(runtime, /import\("\.\.\/silero_vad"\)/);
assert.match(wakeWordSource, /import \{ WakeWordEngine \}/);
assert.match(runtime, /final_response_audio_closed/);
assert.match(runtime, /isSnapshotReady: \(\) => this\.link\.ready/);
assert.match(runtime, /submitHandsFreeClip/);
// The engine and ONNX Runtime load from the committed /openwakeword/ files
// through the page's import map; the import map must precede the bundle.
for (const html of [pageSource, page]) {
	assert.match(html, /"openwakeword-wasm-browser": "\/openwakeword\/wake-word-engine\.js"/);
	assert.match(html, /"onnxruntime-web": "\/openwakeword\/ort\/ort\.wasm\.bundle\.min\.mjs"/);
}
assert.ok(
	page.indexOf('type="importmap"') < page.indexOf('type="module"'),
	"the import map precedes the module script",
);
assert.equal(
	readdirSync("static/v17-assets").some((file) => file.endsWith(".wasm")),
	false,
	"the bundle does not carry its own ONNX Runtime WASM",
);
assert.ok(statSync("static/vad-worklet.js").size > 0, "the VAD worklet is built");
assert.match(packageRuntime, /from 'onnxruntime-web'/);
assert.match(ortRuntime, /ONNX Runtime Web/);
for (const asset of [
	"static/openwakeword/models/damocles_v0.1.onnx",
	"static/openwakeword/models/damo_v0.1.onnx",
	"static/openwakeword/models/melspectrogram.onnx",
	"static/openwakeword/models/embedding_model.onnx",
	"static/openwakeword/models/silero_vad.onnx",
	"static/openwakeword/ort/ort-wasm-simd-threaded.mjs",
	"static/openwakeword/ort/ort-wasm-simd-threaded.wasm",
]) {
	assert.ok(statSync(asset).size > 0, `${asset} is staged`);
}
assert.equal(
	existsSync("static/openwakeword/models/hey_jarvis_v0.1.onnx"),
	false,
	"the package's Hey Jarvis model is no longer staged",
);

// Each keyword model carries its own threshold, and the engine, which has
// only one, runs at the lowest of them.
const wakeModels = await import(
	`data:text/javascript;base64,${Buffer.from(
		compile(
			readFileSync("apps/frontend/src/wake_models.ts", "utf8"),
			"wake_models.ts",
		),
	).toString("base64")}#wake-models`
);
assert.deepEqual(Object.keys(wakeModels.WAKE_WORD_MODELS), [
	"damocles",
	"damo",
]);
assert.ok(
	wakeModels.WAKE_WORD_MODELS.damo.threshold >
		wakeModels.WAKE_WORD_MODELS.damocles.threshold,
	"damo is held to the stricter threshold",
);
assert.equal(
	wakeModels.WAKE_WORD_ENGINE_THRESHOLD,
	Math.min(
		...Object.values(wakeModels.WAKE_WORD_MODELS).map(
			(model) => model.threshold,
		),
	),
);
assert.equal(wakeModels.isWakeDetection({ keyword: "damo", score: 0.95 }), true);
assert.equal(
	wakeModels.isWakeDetection({
		keyword: "damo",
		score: wakeModels.WAKE_WORD_ENGINE_THRESHOLD + 0.01,
	}),
	false,
	"a damo score under its own threshold is not a detection",
);
assert.equal(
	wakeModels.isWakeDetection({ keyword: "damocles", score: 0.6 }),
	true,
);
assert.equal(wakeModels.isWakeDetection({ keyword: "hey_jarvis", score: 1 }), false);
assert.equal(wakeModels.isWakeDetection(undefined), false);
assert.match(wakeWordSource, /isWakeDetection\(payload\)/);
for (const model of Object.values(wakeModels.WAKE_WORD_MODELS)) {
	assert.ok(
		statSync(`training/wake-words/models/${model.file}`).size > 0,
		`${model.file} is committed as the staged model's source`,
	);
}

console.log(
	"ok - real wake adapter, Silero endpointer, PCM worklet, barrier, and wake-word import map",
);

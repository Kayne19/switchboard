import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import ts from "typescript";

const source = readFileSync("apps/frontend/src/hands_free.ts", "utf8");
const detectorSource = readFileSync(
	"apps/frontend/src/wake_detector.ts",
	"utf8",
);
const wakeWordSource = readFileSync("apps/frontend/src/wake_word.ts", "utf8");
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

const handsFree = await import(
	`data:text/javascript;base64,${Buffer.from(
		compile(source, "hands_free.ts"),
	).toString("base64")}#hands-free`
);
const { WakeWordDetectorAdapter } = await import(
	`data:text/javascript;base64,${Buffer.from(
		compile(detectorSource, "wake_detector.ts"),
	).toString("base64")}#wake-detector`
);

assert.equal(handsFree.WAKE_PHRASE, "Hey Jarvis");
assert.equal(handsFree.WAKE_SAMPLE_RATE, 16000);
assert.equal(handsFree.WAKE_FRAME_SAMPLES, 1280);
assert.equal(handsFree.VAD_TRAILING_SILENCE_MS, 900);
assert.equal(handsFree.FOLLOW_UP_LEASE_MS, 8000);
assert.equal(handsFree.MAX_HANDS_FREE_UTTERANCE_MS, 30000);
assert.equal(handsFree.PLAYBACK_DRAIN_DEBOUNCE_MS, 400);
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
		this.emit({ keyword: "hey_jarvis", score: 0.91 });
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

assert.match(worklet, /type: "energy"/);
assert.match(worklet, /type: "audio"/);
assert.match(worklet, /type: "speech_start"/);
assert.match(worklet, /type: "speech_end"/);
assert.match(worklet, /reset_endpoint/);
assert.match(source, /port\.postMessage\(\{ type: "reset_endpoint" \}\)/);
assert.match(worklet, /this\.port\.onmessage/);
assert.match(worklet, /this\.speaking = false/);
assert.match(worklet, /postMessage\(\{ type: "audio", samples: frame \}/);
assert.doesNotMatch(worklet, /postMessage\(\s*channel/);
assert.match(runtime, /createWakeWordDetector/);
assert.match(runtime, /import\("\.\.\/wake_word"\)/);
assert.match(wakeWordSource, /import \{ WakeWordEngine \}/);
assert.match(runtime, /final_response_audio_closed/);
assert.match(runtime, /snapshotReady/);
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
	"static/openwakeword/models/hey_jarvis_v0.1.onnx",
	"static/openwakeword/models/melspectrogram.onnx",
	"static/openwakeword/models/embedding_model.onnx",
	"static/openwakeword/models/silero_vad.onnx",
	"static/openwakeword/ort/ort-wasm-simd-threaded.mjs",
	"static/openwakeword/ort/ort-wasm-simd-threaded.wasm",
]) {
	assert.ok(statSync(asset).size > 0, `${asset} is staged`);
}
console.log(
	"ok - real wake adapter, PCM worklet, barrier, and wake-word import map",
);

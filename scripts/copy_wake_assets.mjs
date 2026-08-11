import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const copy = (from, to) => {
	const destination = resolve(root, to);
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(resolve(root, from), destination);
};

copy(
	"node_modules/openwakeword-wasm-browser/src/WakeWordEngine.js",
	"static/openwakeword/wake-word-engine.js",
);
for (const model of [
	"melspectrogram.onnx",
	"embedding_model.onnx",
	"silero_vad.onnx",
	"hey_jarvis_v0.1.onnx",
]) {
	copy(
		`node_modules/openwakeword-wasm-browser/models/${model}`,
		`static/openwakeword/models/${model}`,
	);
}
for (const asset of [
	"ort.wasm.bundle.min.mjs",
	"ort-wasm-simd-threaded.mjs",
	"ort-wasm-simd-threaded.wasm",
]) {
	copy(
		`node_modules/onnxruntime-web/dist/${asset}`,
		`static/openwakeword/ort/${asset}`,
	);
}

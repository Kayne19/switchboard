import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync("apps/frontend/src/protocol.ts", "utf8");
const compiled = ts.transpileModule(source, {
	compilerOptions: {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ES2022,
	},
	fileName: "apps/frontend/src/protocol.ts",
	reportDiagnostics: true,
});
assert.deepEqual(compiled.diagnostics ?? [], []);
const encoded = Buffer.from(compiled.outputText).toString("base64");
const {
	clipHeader,
	decodeServerMessage,
	helloMessage,
	screenStateMessage,
	sttChunkHeader,
	sttEndHeader,
	sttStartHeader,
	sttCancelHeader,
	typedTurnMessage,
	postJson,
} = await import(`data:text/javascript;base64,${encoded}`);

assert.deepEqual(decodeServerMessage('{"type":"status","route":"operator"}'), {
	type: "status",
	route: "operator",
});
assert.equal(decodeServerMessage("not json"), null);
assert.equal(decodeServerMessage("null"), null);
assert.equal(decodeServerMessage("42"), null);

const previousFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url, options) => {
	requests.push({ url, options });
	return { ok: true, status: 200, json: async () => ({ error: null }) };
};
try {
	await postJson("/thinking", { level: "high" });
	assert.equal(requests[0].url, "/thinking");
	assert.equal(requests[0].options.method, "POST");
	assert.deepEqual(JSON.parse(requests[0].options.body), { level: "high" });

	globalThis.fetch = async () => ({
		ok: true,
		status: 200,
		json: async () => ({ error: "not available" }),
	});
	assert.deepEqual(await postJson("/model", { model: "provider/model" }), {
		error: "not available",
	});

	globalThis.fetch = async () => ({ ok: false, status: 503 });
	await assert.rejects(postJson("/connect", { project: "alpha" }), /HTTP 503/);
} finally {
	globalThis.fetch = previousFetch;
}

// The clip header carries the epoch the recording started under. The server
// drops the clip when that epoch has moved on, which is what stops speech begun
// before a page transfer from reaching the leg that replaced it -- so the field
// has to survive changes to this frame.
assert.deepEqual(
	JSON.parse(clipHeader({ id: "abc", mime: "audio/webm", epoch: 4 })),
	{ type: "clip", id: "abc", mime: "audio/webm", generation: 4 },
);
// Zero is a real epoch, not an absent one; it must still be sent.
assert.equal(
	JSON.parse(clipHeader({ id: "abc", mime: "", epoch: 0 })).generation,
	0,
);
// A typed turn carries the same epoch guard as a clip.
assert.deepEqual(
	JSON.parse(typedTurnMessage({ id: "t1", epoch: 0, text: "hello" })),
	{ type: "typed_turn", id: "t1", generation: 0, text: "hello" },
);
assert.deepEqual(JSON.parse(helloMessage()), {
	type: "hello",
	version: 1,
	capabilities: { stt_streaming: true, audio_streaming: false, mse_mp3: false },
});
const previousMediaSource = globalThis.MediaSource;
globalThis.MediaSource = { isTypeSupported: (mime) => mime === "audio/mpeg" };
assert.deepEqual(JSON.parse(helloMessage()).capabilities, {
	stt_streaming: true,
	audio_streaming: true,
	mse_mp3: true,
});
if (previousMediaSource === undefined) delete globalThis.MediaSource;
else globalThis.MediaSource = previousMediaSource;
assert.deepEqual(
	JSON.parse(screenStateMessage("visual", true, "diff", "Auth changes", false)),
	{
		type: "screen_state",
		view: "visual",
		has_visual: true,
		visual_kind: "diff",
		title: "Auth changes",
		stale: false,
	},
);
assert.deepEqual(
	JSON.parse(
		sttStartHeader({ id: "abc", mime: "audio/webm;codecs=opus", epoch: 4 }),
	),
	{
		type: "stt_start",
		clip_id: "abc",
		generation: 4,
		mime: "audio/webm;codecs=opus",
	},
);
assert.deepEqual(JSON.parse(sttChunkHeader({ id: "abc", epoch: 4 }, 2)), {
	type: "stt_chunk",
	clip_id: "abc",
	generation: 4,
	sequence: 2,
});
assert.deepEqual(JSON.parse(sttEndHeader({ id: "abc", epoch: 4 })), {
	type: "stt_end",
	clip_id: "abc",
	generation: 4,
});
assert.deepEqual(JSON.parse(sttCancelHeader({ id: "abc", epoch: 4 })), {
	type: "stt_cancel",
	clip_id: "abc",
	generation: 4,
});

console.log("ok — browser protocol parsing and POST failures");

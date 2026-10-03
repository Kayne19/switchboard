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
	SERVER_MESSAGE_TYPES,
	clipHeader,
	decodeServerMessage,
	helloMessage,
	pingMessage,
	screenStateMessage,
	sttChunkHeader,
	sttEndHeader,
	sttStartHeader,
	sttCancelHeader,
	typedTurnMessage,
	postJson,
} = await import(`data:text/javascript;base64,${encoded}`);

// The shared examples of every server-to-browser message, which the Rust
// serializer is held to as well (apps/backend/tests/test_protocol.rs). Each
// one decodes to exactly itself, as the variant its type names, and every
// type the page knows has at least one.
const fixture = JSON.parse(
	readFileSync("apps/frontend/tests/fixtures/server-messages.json", "utf8"),
);
const exemplified = new Set();
for (const { name, message } of fixture.messages) {
	const decoded = decodeServerMessage(JSON.stringify(message));
	assert.deepEqual(decoded, message, `example ${name} decodes to itself`);
	exemplified.add(decoded.type);
}
assert.deepEqual(
	SERVER_MESSAGE_TYPES.filter((type) => !exemplified.has(type)),
	[],
	"every server message type has an example in server-messages.json",
);

// The shared examples of every browser-to-server command, which the Rust
// reader is held to as well (apps/backend/tests/test_protocol.rs). Each one
// must be exactly what its builder sends, and every command has a builder
// and an example. The screen-state report's fields are held to its examples
// by type as well, in tests/unit/clientMessages.test.ts.
const withMediaSource = (mse, build) => {
	const previous = globalThis.MediaSource;
	globalThis.MediaSource = { isTypeSupported: (mime) => mse && mime === "audio/mpeg" };
	try {
		return build();
	} finally {
		if (previous === undefined) delete globalThis.MediaSource;
		else globalThis.MediaSource = previous;
	}
};
const CLIENT_BUILDERS = {
	hello: (m) => withMediaSource(m.capabilities.mse_mp3, helloMessage),
	ping: (m) => pingMessage(m.nonce, m.time),
	clip: (m) => clipHeader({ id: m.id, mime: m.mime, epoch: m.generation }),
	typed_turn: (m) =>
		typedTurnMessage({ id: m.id, epoch: m.generation, text: m.text }),
	stt_start: (m) =>
		sttStartHeader({ id: m.clip_id, mime: m.mime, epoch: m.generation }),
	stt_chunk: (m) =>
		sttChunkHeader({ id: m.clip_id, epoch: m.generation }, m.sequence),
	stt_end: (m) => sttEndHeader({ id: m.clip_id, epoch: m.generation }),
	stt_cancel: (m) => sttCancelHeader({ id: m.clip_id, epoch: m.generation }),
	screen_state: ({ type: _type, ...report }) => screenStateMessage(report),
};
const clientFixture = JSON.parse(
	readFileSync("apps/frontend/tests/fixtures/client-messages.json", "utf8"),
);
const clientExemplified = new Set();
for (const { name, message } of clientFixture.messages) {
	const build = CLIENT_BUILDERS[message.type];
	assert.ok(build, `example ${name} is a command with a builder`);
	assert.deepEqual(
		JSON.parse(build(message)),
		message,
		`example ${name} is what its builder sends`,
	);
	clientExemplified.add(message.type);
}
assert.deepEqual(
	Object.keys(CLIENT_BUILDERS).filter((type) => !clientExemplified.has(type)),
	[],
	"every command has an example in client-messages.json",
);

// A frame is admitted only as a whole message of the protocol.
for (const [frame, why] of [
	["not json", "not JSON"],
	["null", "not an object"],
	["42", "not an object"],
	['[{"type":"epoch","generation":1}]', "an array"],
	['{"generation":1}', "no type"],
	[
		'{"type":"partial","id":"c1","generation":1,"sequence":0,"text":"hel"}',
		"a type the service does not send",
	],
	['{"type":"status","route":"operator"}', "a status missing its fields"],
	['{"type":"epoch","generation":"4"}', "a field of the wrong kind"],
	['{"type":"error","id":7,"message":"x"}', "an optional field of the wrong kind"],
	['{"type":"error","code":"other","message":"x"}', "an unknown error code"],
	[
		'{"type":"spoken","entry":{"role":"agent","text":"hi"}}',
		"a transcript entry missing its route and time",
	],
	['{"type":"history","entries":[{"role":"agent"}]}', "a malformed entry in a list"],
	['{"type":"display","seq":3}', "a display without its action"],
]) {
	assert.equal(decodeServerMessage(frame), null, why);
}
assert.deepEqual(
	decodeServerMessage('{"type":"epoch","generation":4,"stale":true}'),
	{ type: "epoch", generation: 4 },
	"a field no message declares is dropped",
);

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
	capabilities: { stt_streaming: true, mse_mp3: false },
});
const previousMediaSource = globalThis.MediaSource;
globalThis.MediaSource = { isTypeSupported: (mime) => mime === "audio/mpeg" };
assert.deepEqual(JSON.parse(helloMessage()).capabilities, {
	stt_streaming: true,
	mse_mp3: true,
});
if (previousMediaSource === undefined) delete globalThis.MediaSource;
else globalThis.MediaSource = previousMediaSource;
// The report goes out as it was derived, under its type.
assert.equal(
	screenStateMessage({
		view: "visual",
		pinned: false,
		has_visual: true,
		visual_kind: "chart",
		object_ids: ["c1"],
		title: "Auth changes",
		stale: false,
		generation: 3,
	}),
	'{"type":"screen_state","view":"visual","pinned":false,"has_visual":true,' +
		'"visual_kind":"chart","object_ids":["c1"],"title":"Auth changes",' +
		'"stale":false,"generation":3}',
);
assert.equal(pingMessage("2:5:1", 5), '{"type":"ping","nonce":"2:5:1","time":5}');
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

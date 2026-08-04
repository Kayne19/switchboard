import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync("web/protocol.ts", "utf8");
const compiled = ts.transpileModule(source, {
	compilerOptions: {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ES2022,
	},
	fileName: "web/protocol.ts",
	reportDiagnostics: true,
});
assert.deepEqual(compiled.diagnostics ?? [], []);
const encoded = Buffer.from(compiled.outputText).toString("base64");
const { decodeServerMessage, postJson } = await import(
	`data:text/javascript;base64,${encoded}`
);

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
	return { ok: true, status: 200 };
};
try {
	await postJson("/thinking", { level: "high" });
	assert.equal(requests[0].url, "/thinking");
	assert.equal(requests[0].options.method, "POST");
	assert.deepEqual(JSON.parse(requests[0].options.body), { level: "high" });

	globalThis.fetch = async () => ({ ok: false, status: 503 });
	await assert.rejects(postJson("/connect", { project: "alpha" }), /HTTP 503/);
} finally {
	globalThis.fetch = previousFetch;
}

console.log("ok — browser protocol parsing and POST failures");

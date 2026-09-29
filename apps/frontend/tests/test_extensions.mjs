import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const typeboxStub = `
const Type = {
  Object: (properties, options = {}) => ({ type: "object", properties, ...options }),
  String: (options = {}) => ({ type: "string", ...options }),
  Boolean: (options = {}) => ({ type: "boolean", ...options }),
  Array: (items, options = {}) => ({ type: "array", items, ...options }),
  Optional: (schema) => ({ ...schema, optional: true }),
};`;
let moduleNumber = 0;

async function loadExtension(path) {
	const source = readFileSync(path, "utf8");
	let javascript = ts.transpileModule(source, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ES2022,
		},
		fileName: path,
		reportDiagnostics: true,
	});
	assert.deepEqual(
		javascript.diagnostics ?? [],
		[],
		`${path} should transpile without diagnostics`,
	);
	javascript = javascript.outputText.replace(
		/import \{ Type \} from ["']typebox["'];/,
		typeboxStub,
	);
	assert.ok(
		javascript.includes("const Type ="),
		"typebox import should be stubbed",
	);
	const encoded = Buffer.from(javascript).toString("base64");
	moduleNumber += 1;
	return import(`data:text/javascript;base64,${encoded}#${moduleNumber}`);
}

function fakePi(utility = false) {
	const tools = new Map();
	const handlers = new Map();
	let sessionStarted = false;
	return {
		tools,
		handlers,
		activeTools: [],
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerFlag(name, options) {
			this.flagName = name;
			this.flagDefault = options.default ?? false;
		},
		getFlag(name) {
			assert.equal(name, "switchboard-utility");
			return sessionStarted ? utility : undefined;
		},
		on(name, handler) {
			handlers.set(name, handler);
		},
		setActiveTools(names) {
			this.activeTools = [...names];
		},
		startSession() {
			sessionStarted = true;
			return handlers.get("session_start")?.();
		},
	};
}

async function extensionBehavior(utility, expectedActive) {
	const extension = await loadExtension("extensions/operator-switchboard.ts");
	const pi = fakePi(utility);
	extension.default(pi);
	assert.deepEqual(
		[...pi.tools.keys()],
		["route", "second_opinion", "rewrite", "dispatch_parts"],
		"the factory registers tools before CLI flags are available",
	);
	assert.deepEqual(pi.activeTools, [], "tools are selected after session_start");
	await pi.startSession();
	assert.deepEqual(pi.activeTools, expectedActive);
	return pi;
}

const operator = await extensionBehavior(false, ["route"]);
const routed = await operator.tools.get("route").execute("call", {
	target: "alpha",
	mode: "fresh",
});
assert.deepEqual(routed.details, { target: "alpha", mode: "fresh" });

const utility = await extensionBehavior(true, ["second_opinion", "rewrite", "dispatch_parts"]);
const split = await utility.tools.get("dispatch_parts").execute("call", {
	parts: [{ agent: "alpha", text: "Audit it" }],
});
assert.deepEqual(split.details, { count: 1 });
console.log("ok — operator and utility extension tools");

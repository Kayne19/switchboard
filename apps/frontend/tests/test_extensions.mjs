import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const typeboxStub = `
const Type = {
  Object: (properties, options = {}) => ({ type: "object", properties, ...options }),
  Union: (anyOf, options = {}) => ({ type: "union", anyOf, ...options }),
  Literal: (value, options = {}) => ({ type: "literal", const: value, ...options }),
  String: (options = {}) => ({ type: "string", ...options }),
  Number: (options = {}) => ({ type: "number", ...options }),
  Boolean: (options = {}) => ({ type: "boolean", ...options }),
  Array: (items, options = {}) => ({ type: "array", items, ...options }),
  Optional: (schema) => ({ ...schema, optional: true }),
  Null: () => ({ type: "null" }),
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

function fakePi(thinking = "high") {
	const tools = new Map();
	const handlers = new Map();
	return {
		tools,
		handlers,
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerFlag(name, options) {
			this.flags ??= new Map();
			this.flags.set(name, options.default ?? false);
		},
		getFlag(name) {
			return this.flags?.get(name) ?? false;
		},
		on(name, handler) {
			handlers.set(name, handler);
		},
		getThinkingLevel() {
			return thinking;
		},
	};
}

async function operatorExtensionBehavior() {
	const directory = mkdtempSync(join(tmpdir(), "switchboard-extension-"));
	const registry = join(directory, "projects.json");
	writeFileSync(
		registry,
		JSON.stringify({
			projects: [
				{
					id: "alpha",
					description: "Alpha project",
					aliases: ["a"],
					host: "scriptorium",
					cwd: "/srv/alpha",
				},
			],
		}),
	);
	process.env.SWITCHBOARD_PROJECTS_FILE = registry;
	try {
		const extension = await loadExtension("extensions/operator-switchboard.ts");
		const pi = fakePi();
		extension.default(pi);
		assert.deepEqual([...pi.tools.keys()], ["route"]);
		const routed = await pi.tools
			.get("route")
			.execute("call", { target: "alpha", mode: "fresh" });
		assert.deepEqual(routed.details, { target: "alpha", mode: "fresh" });
	} finally {
		rmSync(directory, { recursive: true, force: true });
		delete process.env.SWITCHBOARD_PROJECTS_FILE;
	}
}

async function utilityExtensionBehavior() {
	const extension = await loadExtension("extensions/operator-switchboard.ts");
	const pi = fakePi();
	pi.registerFlag = (name) => {
		pi.flags ??= new Map();
		pi.flags.set(name, true);
	};
	pi.getFlag = (name) => pi.flags?.get(name) ?? false;
	extension.default(pi);
	assert.deepEqual([...pi.tools.keys()], ["second_opinion", "dispatch_parts"]);
	const split = await pi.tools.get("dispatch_parts").execute("call", {
		parts: [{ agent: "alpha", text: "Audit it" }],
	});
	assert.deepEqual(split.details, { count: 1 });
}

await operatorExtensionBehavior();
await utilityExtensionBehavior();
console.log("ok — operator and utility extension tools");

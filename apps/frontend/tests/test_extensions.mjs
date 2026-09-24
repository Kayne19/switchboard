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
		on(name, handler) {
			handlers.set(name, handler);
		},
		getThinkingLevel() {
			return thinking;
		},
	};
}

async function agentExtensionBehavior() {
	process.env.SWITCHBOARD_SPEAK_URL = "http://switchboard.test/speak";
	process.env.SWITCHBOARD_STATE_URL = "http://switchboard.test/leg-state";
	process.env.SWITCHBOARD_DISPLAY_URL = "http://switchboard.test/display";
	process.env.SWITCHBOARD_PERSONA = "Sound calm and direct.";
	process.env.SWITCHBOARD_SESSION_TOKEN = "leg-token";

	const requests = [];
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async (url, options) => {
		const body = JSON.parse(options.body);
		requests.push({ url: String(url), options, body });
		const response =
			String(url).endsWith("/view") && !body.target
				? {
						delivered: true,
						screen: {
							view: "comms",
							has_visual: true,
							visual_kind: "diff",
							title: "Code changes",
							stale: false,
							confirmed: true,
						},
					}
				: { delivered: true };
		return new Response(JSON.stringify(response), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};
	try {
		const extension = await loadExtension("extensions/agent-switchboard.ts");
		const pi = fakePi("xhigh");
		extension.default(pi);
		assert.deepEqual(
			[...pi.tools.keys()],
			[
				"speak",
				"display",
				"view",
				"return_to_operator",
				"transfer_to_project",
				"set_model",
			],
		);
		assert.match(pi.tools.get("speak").description, /Sound calm and direct/);

		// Schema inspection on display tool
		const displayTool = pi.tools.get("display");
		const schema = displayTool.parameters;
		assert.equal(schema.type, "union", "display parameters must be a TypeBox Union");
		assert.ok(Array.isArray(schema.anyOf), "union must contain anyOf array");
		assert.equal(schema.anyOf.length, 11, "union must have 11 action branches");

		for (const branch of schema.anyOf) {
			assert.equal(branch.type, "object", "every action branch must be an object");
			assert.equal(branch.additionalProperties, false, "every action branch must have additionalProperties: false");
		}

		// Verify diagram data is structured graph only with mode: 'graph' and no source field
		const diagramBranch = schema.anyOf.find((b) => b.properties?.type?.const === "diagram");
		assert.ok(diagramBranch, "diagram branch must be defined in union");
		assert.equal(diagramBranch.properties.data.properties.mode.const, "graph", "diagram data mode must be graph");
		assert.equal(diagramBranch.properties.data.properties.source, undefined, "diagram data must not define source");
		assert.equal(diagramBranch.properties.data.additionalProperties, false, "diagram data must have additionalProperties: false");

		// Verify say branch structure
		const sayBranch = schema.anyOf.find((b) => b.properties?.op?.const === "say");
		assert.ok(sayBranch, "say branch must be defined in union");
		assert.ok(sayBranch.properties.text, "say must define text");
		assert.ok(sayBranch.properties.at, "say must define at anchor");

		// Problem #1: an undiscriminated union enumerates every branch's requirements
		// on failure, so a wrong-shaped payload for one type surfaces every other
		// type's fields too. The description must show each type's own shape so the
		// model picks the right one before calling, and the schema must keep a
		// literal `type` (and `op`) discriminator per show branch so real pi's
		// TypeBox can narrow the error to the chosen branch.
		assert.match(
			displayTool.description,
			/diagram:/,
			"display description must include a per-type shape hint (e.g. 'diagram:')",
		);

		// The model is told that primary metrics cluster, and how many the
		// cluster holds -- the same cap the page and the backend apply (#38).
		const cap = Number(
			/export const MAX_PRIMARY_METRICS = (\d+);/.exec(
				readFileSync(new URL("../src/controller/reducer.ts", import.meta.url), "utf8"),
			)?.[1],
		);
		const capWords = { 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten", 12: "twelve" };
		assert.ok(capWords[cap], `no word for a primary metric cap of ${cap}`);
		assert.match(
			displayTool.description,
			new RegExp(`role primary share the main stage as one cluster, up to ${capWords[cap]}\\b`),
			"display description must say primary metrics cluster, and state the cluster's cap",
		);

		const showBranches = schema.anyOf.filter((b) => b.properties?.op?.const === "show");
		const expectedShowTypes = ["chart", "metric", "progress", "diagram", "document", "code", "note"];
		assert.equal(showBranches.length, expectedShowTypes.length, "there must be one show branch per displayable type");
		for (const expectedType of expectedShowTypes) {
			const branch = showBranches.find((b) => b.properties?.type?.const === expectedType);
			assert.ok(branch, `show branch for type '${expectedType}' must be defined`);
			assert.equal(branch.properties.type.type, "literal", `type discriminator for '${expectedType}' must be a TypeBox Literal`);
			assert.equal(branch.properties.op.type, "literal", `op discriminator for '${expectedType}' must be a TypeBox Literal`);
			assert.equal(branch.properties.op.const, "show", `op discriminator for '${expectedType}' must be literal 'show'`);
		}

		// Verify no obsolete per-kind tools exist
		const obsoleteTools = ["diagram", "plan", "timeline", "diff", "listen"];
		for (const oldTool of obsoleteTools) {
			assert.ok(!pi.tools.has(oldTool), `obsolete tool '${oldTool}' must not be registered`);
		}

		await pi.handlers.get("session_start")();
		await pi.handlers.get("thinking_level_select")();
		assert.equal(requests[0].url, process.env.SWITCHBOARD_STATE_URL);
		assert.deepEqual(requests[0].body, {
			thinking: "xhigh",
			token: "leg-token",
		});

		const spoken = await pi.tools
			.get("speak")
			.execute("call", { text: "Still working." });
		assert.equal(spoken.content[0].text, "Spoken.");
		assert.deepEqual(requests.at(-1).body, {
			text: "Still working.",
			token: "leg-token",
		});

		// Run every canonical valid fixture through display tool
		const fixtures = JSON.parse(readFileSync("apps/frontend/tests/fixtures/display-actions.json", "utf8"));
		for (const testCase of fixtures.valid) {
			const res = await displayTool.execute("call", testCase.action);
			assert.equal(res.isError, undefined, `display execution for fixture '${testCase.name}' should succeed`);
			assert.equal(res.content[0].text, "On screen.");
			assert.equal(requests.at(-1).url, process.env.SWITCHBOARD_DISPLAY_URL);
			assert.deepEqual(requests.at(-1).body, {
				action: testCase.action,
				token: "leg-token",
			});
		}

		const viewed = await pi.tools.get("view").execute("call", {
			target: "stage",
			reason: "Display architecture",
		});
		assert.equal(
			viewed.content[0].text,
			"Requested stage view. The caller's pinned view may take precedence.",
		);
		assert.equal(requests.at(-1).url, "http://switchboard.test/view");
		assert.deepEqual(requests.at(-1).body, {
			target: "stage",
			reason: "Display architecture",
			token: "leg-token",
		});

		const inspected = await pi.tools.get("view").execute("call", {});
		assert.equal(
			inspected.content[0].text,
			"Showing a diff titled 'Code changes' on the caller's screen.",
		);
		assert.equal(inspected.details.screen.visual_kind, "diff");

		const returned = await pi.tools
			.get("return_to_operator")
			.execute("call", { summary: "Finished the check." });
		assert.deepEqual(returned.details, { summary: "Finished the check." });
		const transferred = await pi.tools
			.get("transfer_to_project")
			.execute("call", { project: "alpha", intent: "Fix it" });
		assert.deepEqual(transferred.details, { project: "alpha" });
		const changed = await pi.tools.get("set_model").execute("call", {
			model: "anthropic/opus",
			thinking: "high",
			keep_context: false,
		});
		assert.deepEqual(changed.details, {
			model: "anthropic/opus",
			thinking: "high",
			keep_context: false,
		});
	} finally {
		globalThis.fetch = previousFetch;
		delete process.env.SWITCHBOARD_SESSION_TOKEN;
	}
}

async function agentExtensionFallbacks() {
	delete process.env.SWITCHBOARD_SPEAK_URL;
	delete process.env.SWITCHBOARD_STATE_URL;
	delete process.env.SWITCHBOARD_DISPLAY_URL;
	delete process.env.SWITCHBOARD_DIAGRAM_URL;
	delete process.env.SWITCHBOARD_PERSONA;
	delete process.env.SWITCHBOARD_SESSION_TOKEN;
	const extension = await loadExtension("extensions/agent-switchboard.ts");
	const pi = fakePi();
	extension.default(pi);
	const speak = await pi.tools.get("speak").execute("call", { text: "Hello" });
	assert.equal(speak.isError, true);
	assert.match(speak.content[0].text, /No SWITCHBOARD_SPEAK_URL/);
	const display = await pi.tools
		.get("display")
		.execute("call", { op: "show", id: "x", type: "note", data: { segments: [{ text: "Hello" }] } });
	assert.equal(display.isError, true);
	assert.match(display.content[0].text, /No SWITCHBOARD_DISPLAY_URL/);
}

async function agentExtensionHttpFailures() {
	process.env.SWITCHBOARD_SPEAK_URL = "http://switchboard.test/speak";
	process.env.SWITCHBOARD_STATE_URL = "http://switchboard.test/leg-state";
	process.env.SWITCHBOARD_DISPLAY_URL = "http://switchboard.test/display";
	const previousFetch = globalThis.fetch;
	let speakMode = "http-error";
	globalThis.fetch = async (url) => {
		if (String(url).endsWith("leg-state")) throw new Error("page went away");
		if (String(url).endsWith("display")) {
			if (speakMode === "bad-request-detail") {
				return new Response(
					JSON.stringify({
						delivered: false,
						detail: "at most one active item allowed",
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}
			if (speakMode === "legacy-422") {
				return new Response("Unprocessable Entity", { status: 422 });
			}
			if (speakMode === "not-found-404") {
				return new Response("Not Found", { status: 404 });
			}
			if (speakMode === "long-400-detail") {
				return new Response(
					JSON.stringify({
						delivered: false,
						detail: "x".repeat(600),
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({ delivered: false, reason: "no browser connected" }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (speakMode === "network-error") throw new Error("connection refused");
		if (speakMode === "not-delivered") {
			return new Response(
				JSON.stringify({ delivered: false, reason: "no browser connected" }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response("bad gateway", { status: 502 });
	};
	try {
		const extension = await loadExtension("extensions/agent-switchboard.ts");
		const pi = fakePi();
		extension.default(pi);
		// State reporting is advisory and must never fail session startup.
		await pi.handlers.get("session_start")();

		const refused = await pi.tools
			.get("speak")
			.execute("call", { text: "Hello" });
		assert.equal(refused.isError, true);
		assert.match(refused.content[0].text, /HTTP 502/);

		speakMode = "bad-request-detail";
		const detailedRefusal = await pi.tools.get("display").execute("call", {
			op: "show", id: "x", type: "note", data: { segments: [{ text: "x" }] },
		});
		assert.equal(detailedRefusal.isError, true);
		assert.match(detailedRefusal.content[0].text, /at most one active item allowed/);

		speakMode = "legacy-422";
		const legacyRefusal = await pi.tools.get("display").execute("call", { op: "clear" });
		assert.equal(legacyRefusal.isError, true);
		assert.match(legacyRefusal.content[0].text, /no display screen/);

		speakMode = "network-error";
		const unreachable = await pi.tools
			.get("speak")
			.execute("call", { text: "Hello again" });
		assert.equal(unreachable.isError, true);
		assert.match(unreachable.content[0].text, /Could not reach/);

		speakMode = "not-delivered";
		const undelivered = await pi.tools
			.get("speak")
			.execute("call", { text: "Hello without a page" });
		assert.equal(undelivered.isError, true);
		assert.match(undelivered.content[0].text, /Nothing was played/);

		const held = await pi.tools
			.get("display")
			.execute("call", { op: "clear" });
		assert.equal(held.isError, undefined);
		assert.match(held.content[0].text, /It will be there/);
	} finally {
		globalThis.fetch = previousFetch;
	}
}

async function agentExtensionDisplayAndViewResults() {
	process.env.SWITCHBOARD_DISPLAY_URL = "http://switchboard.test/display";
	const previousFetch = globalThis.fetch;
	let displayResponse = { delivered: true, rendered: true };
	let viewResponse = { delivered: true, screen: {} };
	globalThis.fetch = async (url) => {
		const body = String(url).endsWith("/view") ? viewResponse : displayResponse;
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};
	try {
		const extension = await loadExtension("extensions/agent-switchboard.ts");
		const pi = fakePi();
		extension.default(pi);
		const displayTool = pi.tools.get("display");
		const viewTool = pi.tools.get("view");
		const clearAction = { op: "clear" };

		// delivered:true, rendered:true -> confirmed on screen, not an error.
		displayResponse = { delivered: true, rendered: true };
		const rendered = await displayTool.execute("call", clearAction);
		assert.equal(rendered.isError, undefined);
		assert.equal(rendered.content[0].text, "On screen.");

		// delivered:true, rendered:false, no rejection -> honest "not confirmed", not an error.
		displayResponse = {
			delivered: true,
			rendered: false,
			reason: "no confirmation from the browser",
		};
		const unconfirmed = await displayTool.execute("call", clearAction);
		assert.equal(unconfirmed.isError, undefined);
		assert.match(unconfirmed.content[0].text, /has not confirmed/);

		// delivered:true, rendered:false, rejected:true -> surfaces the reason and is an error.
		displayResponse = {
			delivered: true,
			rendered: false,
			rejected: true,
			reason: "at most one active item allowed",
		};
		const rejected = await displayTool.execute("call", clearAction);
		assert.equal(rejected.isError, true);
		assert.match(rejected.content[0].text, /at most one active item allowed/);

		// view with no target, has_visual true but confirmed:false -> "not yet confirmed", not "showing".
		viewResponse = {
			delivered: true,
			screen: {
				view: "comms",
				has_visual: true,
				visual_kind: "diagram",
				title: "Flow",
				confirmed: false,
			},
		};
		const notYetConfirmed = await viewTool.execute("call", {});
		assert.equal(
			notYetConfirmed.content[0].text,
			"Requested a diagram titled 'Flow', but the caller's screen has not confirmed it yet.",
		);
	} finally {
		globalThis.fetch = previousFetch;
		delete process.env.SWITCHBOARD_DISPLAY_URL;
	}
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
		assert.deepEqual([...pi.tools.keys()], ["transfer_to_project"]);
		const transferred = await pi.tools
			.get("transfer_to_project")
			.execute("call", { project: "alpha", intent: "Audit it" });
		assert.deepEqual(transferred.details, { project: "alpha" });
	} finally {
		rmSync(directory, { recursive: true, force: true });
		delete process.env.SWITCHBOARD_PROJECTS_FILE;
	}
}

await agentExtensionBehavior();
await agentExtensionFallbacks();
await agentExtensionHttpFailures();
await agentExtensionDisplayAndViewResults();
await operatorExtensionBehavior();
console.log("ok — extension tools and fallbacks");

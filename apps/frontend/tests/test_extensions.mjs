import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const typeboxStub = `
const Type = {
  Object: (shape) => shape,
  String: (options = {}) => options,
  Number: (options = {}) => options,
  Optional: (value) => value,
  Boolean: (options = {}) => options,
  Array: (items) => items,
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
	process.env.SWITCHBOARD_DIAGRAM_URL = "http://switchboard.test/diagram";
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

		const drawn = await pi.tools.get("display").execute("call", {
			op: "show",
			id: "call-path",
			type: "diagram",
			data: { title: "Call path", source: "flowchart TD; A-->B", nodes: [], edges: [] },
		});
		assert.equal(drawn.content[0].text, "On screen.");
		assert.deepEqual(requests.at(-1).body, {
			op: "show",
			id: "call-path",
			type: "diagram",
			data: { title: "Call path", source: "flowchart TD; A-->B", nodes: [], edges: [] },
			token: "leg-token",
		});

		const viewed = await pi.tools.get("view").execute("call", {
			target: "stage",
			reason: "Display architecture",
		});
		assert.equal(
			viewed.content[0].text,
			"Requested stage view. The caller's pinned view may take precedence.",
		);
		assert.deepEqual(requests.at(-1).body, {
			target: "stage",
			reason: "Display architecture",
			token: "leg-token",
		});

		const inspected = await pi.tools.get("view").execute("call", {});
		assert.equal(
			inspected.content[0].text,
			"Screen is in comms view with diff titled 'Code changes'.",
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
	delete process.env.SWITCHBOARD_DIAGRAM_URL;
	delete process.env.SWITCHBOARD_PERSONA;
	delete process.env.SWITCHBOARD_SESSION_TOKEN;
	const extension = await loadExtension("extensions/agent-switchboard.ts");
	const pi = fakePi();
	extension.default(pi);
	const speak = await pi.tools.get("speak").execute("call", { text: "Hello" });
	assert.equal(speak.isError, true);
	assert.match(speak.content[0].text, /No SWITCHBOARD_SPEAK_URL/);
	const diagram = await pi.tools
		.get("display")
		.execute("call", { op: "show", id: "x", type: "note", data: { segments: [{ text: "Hello" }] } });
	assert.equal(diagram.isError, true);
	assert.match(diagram.content[0].text, /No SWITCHBOARD_DIAGRAM_URL/);
}

async function agentExtensionHttpFailures() {
	process.env.SWITCHBOARD_SPEAK_URL = "http://switchboard.test/speak";
	process.env.SWITCHBOARD_STATE_URL = "http://switchboard.test/leg-state";
	process.env.SWITCHBOARD_DIAGRAM_URL = "http://switchboard.test/diagram";
	const previousFetch = globalThis.fetch;
	let speakMode = "http-error";
	globalThis.fetch = async (url) => {
		if (String(url).endsWith("leg-state")) throw new Error("page went away");
		if (String(url).endsWith("diagram")) {
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
await operatorExtensionBehavior();
console.log("ok — extension tools and fallbacks");

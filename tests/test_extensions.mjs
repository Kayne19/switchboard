import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const typeboxStub = `
const Type = {
  Object: (shape) => shape,
  String: (options = {}) => options,
  Optional: (value) => value,
  Boolean: (options = {}) => options,
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
	assert.ok(javascript.includes("const Type ="), "typebox import should be stubbed");
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

	const requests = [];
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async (url, options) => {
		requests.push({ url: String(url), options, body: JSON.parse(options.body) });
		return new Response(JSON.stringify({ delivered: true }), {
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
			["speak", "diagram", "return_to_operator", "transfer_to_project", "set_model"],
		);
		assert.match(pi.tools.get("speak").description, /Sound calm and direct/);

		await pi.handlers.get("session_start")();
		await pi.handlers.get("thinking_level_select")();
		assert.equal(requests[0].url, process.env.SWITCHBOARD_STATE_URL);
		assert.deepEqual(requests[0].body, { thinking: "xhigh" });

		const spoken = await pi.tools.get("speak").execute("call", { text: "Still working." });
		assert.equal(spoken.content[0].text, "Spoken.");
		assert.deepEqual(requests.at(-1).body, { text: "Still working." });

		const drawn = await pi.tools.get("diagram").execute("call", {
			source: "flowchart TD; A-->B",
			title: "Call path",
		});
		assert.equal(drawn.content[0].text, "On screen.");
		assert.deepEqual(requests.at(-1).body, {
			source: "flowchart TD; A-->B",
			title: "Call path",
			notes: "",
		});

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
	}
}

async function agentExtensionFallbacks() {
	delete process.env.SWITCHBOARD_SPEAK_URL;
	delete process.env.SWITCHBOARD_STATE_URL;
	delete process.env.SWITCHBOARD_DIAGRAM_URL;
	delete process.env.SWITCHBOARD_PERSONA;
	const extension = await loadExtension("extensions/agent-switchboard.ts");
	const pi = fakePi();
	extension.default(pi);
	const speak = await pi.tools.get("speak").execute("call", { text: "Hello" });
	assert.equal(speak.isError, true);
	assert.match(speak.content[0].text, /No SWITCHBOARD_SPEAK_URL/);
	const diagram = await pi.tools
		.get("diagram")
		.execute("call", { source: "flowchart TD; A-->B" });
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
			return new Response(
				JSON.stringify({ delivered: false, reason: "no browser connected" }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (speakMode === "network-error") throw new Error("connection refused");
		return new Response("bad gateway", { status: 502 });
	};
	try {
		const extension = await loadExtension("extensions/agent-switchboard.ts");
		const pi = fakePi();
		extension.default(pi);
		// State reporting is advisory and must never fail session startup.
		await pi.handlers.get("session_start")();

		const refused = await pi.tools.get("speak").execute("call", { text: "Hello" });
		assert.equal(refused.isError, true);
		assert.match(refused.content[0].text, /HTTP 502/);

		speakMode = "network-error";
		const unreachable = await pi.tools
			.get("speak")
			.execute("call", { text: "Hello again" });
		assert.equal(unreachable.isError, true);
		assert.match(unreachable.content[0].text, /Could not reach/);

		const held = await pi.tools
			.get("diagram")
			.execute("call", { source: "flowchart TD; A-->B" });
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
		assert.deepEqual([...pi.tools.keys()], ["list_projects", "transfer_to_project"]);
		const listed = await pi.tools.get("list_projects").execute("call", {});
		assert.match(listed.content[0].text, /alpha/);
		assert.match(listed.content[0].text, /scriptorium:\/srv\/alpha/);
		assert.deepEqual(listed.details, { count: 1 });
		const transferred = await pi.tools
			.get("transfer_to_project")
			.execute("call", { project: "alpha", intent: "Audit it" });
		assert.deepEqual(transferred.details, { project: "alpha" });
	} finally {
		rmSync(directory, { recursive: true, force: true });
		delete process.env.SWITCHBOARD_PROJECTS_FILE;
	}
}

async function operatorExtensionBrokenRegistry() {
	process.env.SWITCHBOARD_PROJECTS_FILE = join(
		tmpdir(),
		`missing-switchboard-registry-${process.pid}.json`,
	);
	try {
		const extension = await loadExtension("extensions/operator-switchboard.ts");
		const pi = fakePi();
		extension.default(pi);
		const listed = await pi.tools.get("list_projects").execute("call", {});
		assert.deepEqual(listed.details, {});
		assert.match(listed.content[0].text, /empty or unreadable/);
	} finally {
		delete process.env.SWITCHBOARD_PROJECTS_FILE;
	}
}

await agentExtensionBehavior();
await agentExtensionFallbacks();
await agentExtensionHttpFailures();
await operatorExtensionBehavior();
await operatorExtensionBrokenRegistry();
console.log("ok — extension tools and fallbacks");

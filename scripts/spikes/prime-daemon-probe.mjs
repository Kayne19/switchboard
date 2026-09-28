#!/usr/bin/env node
// prime-daemon-probe.mjs — step-1 spike probe for the sb-one-assistant plan.
//
// It checks the prime-agent daemon behaviour the switchboard design relies on,
// against an ISOLATED daemon that this script starts and stops itself.
//
// Usage:
//   node scripts/spikes/prime-daemon-probe.mjs --isolated-root /tmp/sbp-<something> [--keep] [--only a,b] [--verbose]
//
//   --isolated-root DIR  Required. An absolute path (at most 40 characters, so the
//                        Unix socket paths inside it stay short) that does not exist
//                        or is an empty directory. Everything the probe and the
//                        isolated daemon write goes inside it:
//                          DIR/home            HOME for every process the probe starts
//                          DIR/home/.prime/agent   PRIME_AGENT_CODING_AGENT_DIR
//                          DIR/t               TMPDIR (worker sockets live in $TMPDIR/prime-agent-<uid>)
//                          DIR/daemon.sock     the isolated daemon socket (--daemon-socket)
//   --keep               Keep DIR after the run (processes and units are always stopped).
//   --only a,b           Run only the named check groups (see GROUPS below).
//   --verbose            Print event traces.
//
// Refusal: the probe exits with status 2 BEFORE it spawns or connects to anything when
// --isolated-root is missing, relative, too long, not empty, or resolves to (or inside)
// the live state: the real ~/.prime, the default socket dir $TMPDIR/prime-agent-<uid>
// (also /tmp/prime-agent-<uid>), or the directory of PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET.
//
// Isolation recipe (every process the probe starts gets a scrubbed env built from an
// allowlist; the probe also scrubs its own process.env before it imports prime-agent):
//   HOME, TMPDIR, XDG_{DATA,CONFIG,CACHE,STATE}_HOME inside DIR,
//   PRIME_AGENT_CODING_AGENT_DIR=DIR/home/.prime/agent,
//   PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR=DIR/home/.prime/supervisor-owners,
//   PRIME_AGENT_KERNEL_VENV=DIR/home/.prime/agent/kernel-venv,
//   PI_OFFLINE=1 (and --offline), PI_SKIP_VERSION_CHECK=1, PRIME_AGENT_TELEMETRY=0, DO_NOT_TRACK=1,
//   UV_OFFLINE=1 with the user's uv cache (read for wheels; uv may add entries),
//   a copy of the user's uv-managed CPython 3.11 inside DIR (so uv never touches the real one).
// The model is a fake OpenAI-compatible server inside this process on 127.0.0.1; no
// credentials are copied. The daemon runs in its own transient systemd user unit
// (sb-probe-<id>-daemon); all transient units are stopped and reset at exit.
//
// Output: one line per check, "PASS <check>" or "FAIL <check>: <reason>", plus "INFO" lines
// with measured data. Exit 0 only if every check passed. A JSON report is written to
// DIR/report.json (kept only with --keep).

import { spawn, execFileSync, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, createConnection } from "node:net";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 0. Arguments and refusal (nothing is spawned or connected before this passes)
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function argValue(name) {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}
const KEEP = argv.includes("--keep");
const VERBOSE = argv.includes("--verbose");
const ONLY = argValue("--only") ? new Set(argValue("--only").split(",")) : undefined;

function refuse(reason) {
	console.error(`REFUSED: ${reason}`);
	console.error("usage: node scripts/spikes/prime-daemon-probe.mjs --isolated-root /tmp/sbp-<id> [--keep] [--only groups] [--verbose]");
	process.exit(2);
}
function isInside(child, parent) {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
function realOrSelf(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

const ORIGINAL_ENV = { ...process.env };
const UID = typeof process.getuid === "function" ? process.getuid() : "user";
const REAL_HOME = os.homedir();
const rawRoot = argValue("--isolated-root");
if (!rawRoot) refuse("--isolated-root is required; the probe never runs against the default or live daemon");
if (!path.isAbsolute(rawRoot)) refuse(`--isolated-root must be absolute: ${rawRoot}`);
const ROOT = path.resolve(rawRoot);
if (ROOT.length > 40) refuse(`--isolated-root is too long (${ROOT.length} > 40 chars); Unix socket paths inside it must stay short`);
{
	// The root's parent must exist; resolve symlinks in it so "inside" checks are real.
	const parent = realOrSelf(path.dirname(ROOT));
	const resolved = path.join(parent, path.basename(ROOT));
	const forbidden = [
		["the real ~/.prime", path.join(REAL_HOME, ".prime")],
		["the default daemon socket dir", path.join(os.tmpdir(), `prime-agent-${UID}`)],
		["the default daemon socket dir under /tmp", path.join("/tmp", `prime-agent-${UID}`)],
	];
	const envSock = ORIGINAL_ENV.PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET;
	if (envSock) forbidden.push(["the live supervisor socket dir (PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET)", path.dirname(envSock)]);
	const envAgentDir = ORIGINAL_ENV.PRIME_AGENT_CODING_AGENT_DIR;
	if (envAgentDir) forbidden.push(["the live agent dir (PRIME_AGENT_CODING_AGENT_DIR)", envAgentDir]);
	for (const [label, dir] of forbidden) {
		const d = realOrSelf(dir);
		if (isInside(resolved, d) || isInside(ROOT, dir)) refuse(`--isolated-root ${ROOT} is inside ${label} (${dir})`);
		if (isInside(d, resolved)) refuse(`--isolated-root ${ROOT} contains ${label} (${dir})`);
	}
	if (resolved === realOrSelf(REAL_HOME) || ROOT === REAL_HOME) refuse("--isolated-root must not be the real HOME");
	if (fs.existsSync(ROOT)) {
		const st = fs.lstatSync(ROOT);
		if (!st.isDirectory() || st.isSymbolicLink()) refuse(`--isolated-root exists and is not a plain directory: ${ROOT}`);
		if (fs.readdirSync(ROOT).length > 0) refuse(`--isolated-root must be a fresh empty directory or not exist: ${ROOT}`);
	}
}

// Derived isolated paths.
const ISO = {
	root: ROOT,
	home: path.join(ROOT, "home"),
	tmp: path.join(ROOT, "t"),
	agentDir: path.join(ROOT, "home", ".prime", "agent"),
	registry: path.join(ROOT, "home", ".prime", "supervisor-owners"),
	kernelVenv: path.join(ROOT, "home", ".prime", "agent", "kernel-venv"),
	xdgData: path.join(ROOT, "home", ".local", "share"),
	xdgConfig: path.join(ROOT, "home", ".config"),
	xdgCache: path.join(ROOT, "home", ".cache"),
	xdgState: path.join(ROOT, "home", ".local", "state"),
	socket: path.join(ROOT, "daemon.sock"),
	probeSock: path.join(ROOT, "home", ".cache", "sbprobe", "probe.sock"),
	proj: path.join(ROOT, "proj"),
	logs: path.join(ROOT, "probe-logs"),
};
{
	// Final guard on the derived socket/agent dir (belt and braces).
	const liveSockets = [path.join(os.tmpdir(), `prime-agent-${UID}`, "daemon.sock"), path.join("/tmp", `prime-agent-${UID}`, "daemon.sock")];
	if (ORIGINAL_ENV.PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET) liveSockets.push(ORIGINAL_ENV.PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET);
	if (liveSockets.includes(ISO.socket)) refuse(`derived socket ${ISO.socket} is a live socket`);
	if (isInside(ISO.agentDir, path.join(REAL_HOME, ".prime"))) refuse("derived agent dir is inside the real ~/.prime");
	const workerSockDir = path.join(ISO.tmp, `prime-agent-${UID}`);
	if (workerSockDir.length + "/worker-xxxxxxxxxxxx-xxxxxxxxxxxx.sock".length > 100) refuse("worker socket path would be too long");
}

// Resolve external programs from the ORIGINAL PATH (read-only lookups; nothing is run yet).
function which(cmd) {
	for (const dir of (ORIGINAL_ENV.PATH ?? "").split(":")) {
		if (!dir) continue;
		const p = path.join(dir, cmd);
		try {
			fs.accessSync(p, fs.constants.X_OK);
			return p;
		} catch {}
	}
	return undefined;
}
const PRIME_BIN_LINK = which("prime-agent");
if (!PRIME_BIN_LINK) refuse("prime-agent is not on PATH");
const PRIME_BIN = fs.realpathSync(PRIME_BIN_LINK);
const UV_BIN = which("uv");
const NODE_BIN = process.execPath;
// The Node package that exports DaemonClient (the host's installed prime-agent package).
const NPM_PKG = (() => {
	const candidates = [path.join(path.dirname(path.dirname(PRIME_BIN_LINK)), "lib", "node_modules", "prime-agent")];
	for (const c of candidates) if (fs.existsSync(path.join(c, "dist", "index.js"))) return c;
	return undefined;
})();
if (!NPM_PKG) refuse("cannot find the installed prime-agent Node package (lib/node_modules/prime-agent)");
const REAL_UV_CACHE = (() => {
	if (ORIGINAL_ENV.UV_CACHE_DIR) return ORIGINAL_ENV.UV_CACHE_DIR;
	return path.join(ORIGINAL_ENV.XDG_CACHE_HOME || path.join(REAL_HOME, ".cache"), "uv");
})();
const REAL_UV_PYTHON = path.join(ORIGINAL_ENV.XDG_DATA_HOME || path.join(REAL_HOME, ".local", "share"), "uv", "python");

// ---------------------------------------------------------------------------
// 1. Scrubbed environment
// ---------------------------------------------------------------------------
const ENV_ALLOW = ["LANG", "LC_ALL", "TERM", "USER", "LOGNAME", "SHELL"];
function isolatedEnv(overrides = {}, iso = ISO) {
	const env = {};
	for (const k of ENV_ALLOW) if (ORIGINAL_ENV[k] !== undefined) env[k] = ORIGINAL_ENV[k];
	const pathDirs = [UV_BIN && path.dirname(UV_BIN), path.dirname(NODE_BIN), "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean);
	Object.assign(env, {
		PATH: [...new Set(pathDirs)].join(":"),
		HOME: iso.home,
		TMPDIR: iso.tmp,
		XDG_DATA_HOME: iso.xdgData,
		XDG_CONFIG_HOME: iso.xdgConfig,
		XDG_CACHE_HOME: iso.xdgCache,
		XDG_STATE_HOME: iso.xdgState,
		PRIME_AGENT_CODING_AGENT_DIR: iso.agentDir,
		PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR: iso.registry,
		PRIME_AGENT_KERNEL_VENV: iso.kernelVenv,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PRIME_AGENT_TELEMETRY: "0",
		DO_NOT_TRACK: "1",
		PRIME_AGENT_INSTALL_UV: "0",
		UV_OFFLINE: "1",
		UV_CACHE_DIR: REAL_UV_CACHE,
		UV_NO_PROGRESS: "1",
		PYTHONDONTWRITEBYTECODE: "1",
		NO_PROXY: "*",
		no_proxy: "*",
	});
	return { ...env, ...overrides };
}
// Scrub this process's own env before prime-agent code is imported (DaemonClient reads
// getAgentDir() for its log path; config.js reads HOME).
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, isolatedEnv());

// ---------------------------------------------------------------------------
// 2. Result bookkeeping
// ---------------------------------------------------------------------------
const results = [];
const info = {};
function pass(name, detail) {
	results.push({ name, ok: true, detail });
	console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, reason) {
	results.push({ name, ok: false, reason: String(reason) });
	console.log(`FAIL ${name}: ${reason}`);
}
function note(key, value) {
	info[key] = value;
	console.log(`INFO ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}
function check(name, cond, detail, reason) {
	if (cond) pass(name, detail);
	else fail(name, reason ?? detail ?? "condition false");
	return Boolean(cond);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.timeOrigin + performance.now();
function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
}
async function waitFor(fn, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
		await sleep(100);
	}
}

// ---------------------------------------------------------------------------
// 3. Fake OpenAI-compatible model (openai-completions, streaming) on 127.0.0.1
// ---------------------------------------------------------------------------
// Directives go in the user message; they are honoured only for agent requests, which
// carry AGENT_MARKER in the system prompt (set by the isolated APPEND_SYSTEM.md). Other
// model calls (compaction summaries, background summarizers) get a plain reply.
const AGENT_MARKER = "SBPROBE-AGENT-MARKER";
const fake = {
	requests: [],
	counters: new Map(),
	toolCallSentAt: new Map(), // tag -> time the tool call was fully sent
	activeSlow: new Set(),
};
function textOf(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
	return "";
}
function sseWrite(res, obj) {
	res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function chunk(model, delta, finish = null) {
	return { id: "chatcmpl-probe", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] };
}
function finishStream(res, model, finish, usage) {
	sseWrite(res, chunk(model, {}, finish));
	sseWrite(res, { id: "chatcmpl-probe", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage });
	res.write("data: [DONE]\n\n");
	res.end();
}
function replyText(res, model, text, usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	sseWrite(res, chunk(model, { role: "assistant", content: "" }));
	sseWrite(res, chunk(model, { content: text }));
	finishStream(res, model, "stop", usage);
}
function classify(body) {
	const msgs = body.messages ?? [];
	const system = msgs.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
	const last = msgs[msgs.length - 1];
	let lastUser = "";
	for (let i = msgs.length - 1; i >= 0; i--) {
		if (msgs[i].role === "user") {
			lastUser = textOf(msgs[i].content);
			break;
		}
	}
	return { system, last, lastUser, isAgent: system.includes(AGENT_MARKER) || system.includes("SBPROBE-CFG-APPEND"), tools: (body.tools ?? []).map((t) => t.function?.name ?? t.name) };
}
function lastDirective(text) {
	const all = [...text.matchAll(/\[\[([a-z]+)(?::([^\]]*))?\]\]/g)];
	return all.length ? { kind: all[all.length - 1][1], arg: all[all.length - 1][2] ?? "" } : undefined;
}
async function handleCompletion(req, res, body) {
	const c = classify(body);
	const model = body.model;
	const rec = { t: now(), model, isAgent: c.isAgent, tools: c.tools, lastRole: c.last?.role, lastUser: c.lastUser.slice(0, 300), system: c.system, reasoning_effort: body.reasoning_effort, nMessages: (body.messages ?? []).length };
	fake.requests.push(rec);
	if (!c.isAgent) return replyText(res, model, "SUMMARY: probe conversation.");
	if (c.last?.role === "tool") {
		rec.toolContent = textOf(c.last.content).slice(0, 2000);
		return replyText(res, model, `TOOL_DONE ${textOf(c.last.content).slice(0, 400)}`);
	}
	const d = lastDirective(c.lastUser);
	rec.directive = d;
	if (!d) return replyText(res, model, "OK");
	switch (d.kind) {
		case "reply":
			return replyText(res, model, d.arg || "OK");
		case "slow": {
			const n = Number(d.arg || 20);
			res.writeHead(200, { "content-type": "text/event-stream" });
			sseWrite(res, chunk(model, { role: "assistant", content: "" }));
			let closed = false;
			res.on("close", () => {
				closed = true;
			});
			fake.activeSlow.add(res);
			for (let i = 0; i < n && !closed; i++) {
				sseWrite(res, chunk(model, { content: `slow-${i} ` }));
				await sleep(250);
			}
			fake.activeSlow.delete(res);
			rec.slowClosedEarly = closed;
			if (!closed) finishStream(res, model, "stop", { prompt_tokens: 100, completion_tokens: n, total_tokens: 100 + n });
			return;
		}
		case "fail": {
			const [key, times] = d.arg.split(":");
			const seen = fake.counters.get(key) ?? 0;
			fake.counters.set(key, seen + 1);
			if (seen < Number(times || 1)) {
				rec.failed = true;
				res.writeHead(503, { "content-type": "application/json" });
				return res.end(JSON.stringify({ error: { message: "probe: service temporarily overloaded", type: "server_error", code: "overloaded" } }));
			}
			return replyText(res, model, `RECOVERED ${key}`);
		}
		case "overflow": {
			const key = d.arg;
			const seen = fake.counters.get(`overflow:${key}`) ?? 0;
			fake.counters.set(`overflow:${key}`, seen + 1);
			if (seen < 1) {
				rec.failed = true;
				res.writeHead(400, { "content-type": "application/json" });
				return res.end(JSON.stringify({ error: { message: "This model's maximum context length is 8000 tokens. However, your messages resulted in 9100 tokens.", type: "invalid_request_error", code: "context_length_exceeded" } }));
			}
			return replyText(res, model, `AFTER_OVERFLOW ${key}`);
		}
		case "long":
			return replyText(res, model, `LONG ${"lorem ipsum dolor sit amet ".repeat(Math.ceil(Number(d.arg || 2000) / 27))}`);
		case "big":
			return replyText(res, model, `BIG ${d.arg}`, { prompt_tokens: 7600, completion_tokens: 10, total_tokens: 7610 });
		case "py": {
			const code = Buffer.from(d.arg, "base64url").toString("utf8");
			const tag = (code.match(/#tag:(\S+)/) ?? [])[1] ?? "untagged";
			res.writeHead(200, { "content-type": "text/event-stream" });
			sseWrite(res, chunk(model, { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${tag}_${randomBytes(3).toString("hex")}`, type: "function", function: { name: "ipython", arguments: "" } }] }));
			sseWrite(res, chunk(model, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ code }) } }] }));
			finishStream(res, model, "tool_calls", { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
			fake.toolCallSentAt.set(tag, now());
			return;
		}
		default:
			return replyText(res, model, `UNKNOWN ${d.kind}`);
	}
}
function startFakeModel() {
	const server = createHttpServer((req, res) => {
		let data = "";
		req.on("data", (c) => (data += c));
		req.on("end", () => {
			if (req.method === "GET" && req.url.endsWith("/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				return res.end(JSON.stringify({ object: "list", data: [] }));
			}
			let body = {};
			try {
				body = JSON.parse(data || "{}");
			} catch {}
			handleCompletion(req, res, body).catch((e) => {
				try {
					res.writeHead(500);
					res.end(String(e));
				} catch {}
			});
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---------------------------------------------------------------------------
// 4. Probe socket: stands in for the host-agent socket the switchboard module will dial
// ---------------------------------------------------------------------------
const sockMsgs = [];
function startProbeSocket() {
	fs.mkdirSync(path.dirname(ISO.probeSock), { recursive: true });
	const server = createNetServer((conn) => {
		let buf = "";
		conn.on("data", (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				const t = now();
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					msg = { raw: line };
				}
				sockMsgs.push({ t, msg });
				conn.write(`${JSON.stringify({ ok: true, t })}\n`);
			}
		});
		conn.on("error", () => {});
	});
	return new Promise((resolve) => server.listen(ISO.probeSock, () => resolve(server)));
}

// ---------------------------------------------------------------------------
// 5. Isolated files: settings, fake models, global skill, project dir
// ---------------------------------------------------------------------------
function writeJson(p, v) {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
}
function writeText(p, v) {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, v);
}
function setupAgentDir(iso, port) {
	for (const d of [iso.home, iso.tmp, iso.agentDir, iso.xdgData, iso.xdgConfig, iso.xdgCache, iso.xdgState, iso.logs]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
	writeJson(path.join(iso.agentDir, "settings.json"), {
		defaultProvider: "fake",
		defaultModel: "fake-a",
		defaultThinkingLevel: "off",
		telemetry: { enabled: false },
		quietStartup: true,
		idleEvictionMinutes: "off",
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 200, provider: { waitForUsage: { enabled: false } } },
		compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 200 },
	});
	writeJson(path.join(iso.agentDir, "models.json"), {
		providers: {
			fake: {
				baseUrl: `http://127.0.0.1:${port}/v1`,
				api: "openai-completions",
				apiKey: "probe-fake-key",
				compat: { supportsDeveloperRole: false, supportsStore: false },
				models: [
					{ id: "fake-a", name: "Fake A", reasoning: false, contextWindow: 200000, maxTokens: 4096 },
					{ id: "fake-b", name: "Fake B", reasoning: true, contextWindow: 200000, maxTokens: 4096, thinkingLevelMap: { minimal: null, xhigh: null, max: null } },
					{ id: "fake-tiny", name: "Fake Tiny", reasoning: false, contextWindow: 8000, maxTokens: 1000 },
				],
			},
		},
	});
	// Marks every agent request (roots and subagents) so the fake model can tell them from summarizer calls.
	writeText(path.join(iso.agentDir, "APPEND_SYSTEM.md"), `${AGENT_MARKER}\n`);
	// A tiny global Python skill, installed the way the switchboard skill will be (agentDir/skills/<name>).
	const skill = path.join(iso.agentDir, "skills", "sbprobe");
	writeText(path.join(skill, "SKILL.md"), "---\nname: sbprobe\ndescription: Probe skill that reports session identity to a local Unix socket.\n---\n\nCall `sbprobe.hello()` or `sbprobe.speak(text)`.\n");
	writeText(path.join(skill, "pyproject.toml"), '[project]\nname = "sbprobe"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = []\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n\n[tool.hatch.build.targets.wheel]\npackages = ["src/sbprobe"]\n');
	writeText(
		path.join(skill, "src", "sbprobe", "__init__.py"),
		`"""Probe skill: stdlib only, mirrors the planned switchboard module's socket use."""
import json, os, socket, time

SOCK = os.path.join(os.path.expanduser("~"), ".cache", "sbprobe", "probe.sock")

def _send(op, **fields):
    t0 = time.time()
    p0 = time.perf_counter()
    msg = {"op": op, "t_py": t0, "depth": os.environ.get("RLM_DEPTH"), "session_dir": os.environ.get("RLM_SESSION_DIR"), **fields}
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(SOCK)
    s.sendall((json.dumps(msg) + "\\n").encode())
    reply = b""
    while not reply.endswith(b"\\n"):
        part = s.recv(4096)
        if not part:
            break
        reply += part
    s.close()
    rtt_ms = (time.perf_counter() - p0) * 1000
    return {"rtt_ms": rtt_ms, "reply": json.loads(reply or b"{}")}

def hello(**fields):
    return _send("hello", **fields)

def speak(text, **fields):
    return _send("speak", text=text, **fields)
`,
	);
	// Project dir with project-local resources (for the project-trust check).
	writeText(path.join(iso.proj, "AGENTS.md"), "# Project\nSBPROBE-PROJECT-AGENTS-MD\n");
	writeText(path.join(iso.proj, ".prime", "agent", "APPEND_SYSTEM.md"), `SBPROBE-PROJECT-APPEND-SYSTEM\n${AGENT_MARKER}\n`);
	writeJson(path.join(iso.proj, ".prime", "agent", "settings.json"), { compaction: { keepRecentTokens: 250 } });
	writeText(path.join(iso.proj, ".prime", "agent", "skills", "projskill", "SKILL.md"), "---\nname: projskill\ndescription: SBPROBE-PROJECT-SKILL marker skill.\n---\n\nNothing.\n");
	writeText(
		path.join(iso.proj, ".prime", "agent", "extensions", "projext.ts"),
		`export default function (pi: any) {
  pi.registerTool({
    name: "sbprobe_project_tool",
    label: "sbprobe project tool",
    description: "SBPROBE-PROJECT-EXTENSION marker tool",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "x" }], details: {} }; },
  });
}
`,
	);
}
function copyUvPython(iso) {
	// uv-managed CPython 3.11 copied into the isolated XDG data dir so the kernel bootstrap's
	// "uv python install 3.11" is satisfied offline without touching the user's uv python dir.
	if (!fs.existsSync(REAL_UV_PYTHON)) return "no uv python dir";
	const dirs = fs.readdirSync(REAL_UV_PYTHON).filter((d) => /^cpython-3\.11\.\d+-/.test(d));
	if (dirs.length === 0) return "no cpython-3.11 in uv python dir";
	const dest = path.join(iso.xdgData, "uv", "python");
	fs.mkdirSync(dest, { recursive: true });
	const src = path.join(REAL_UV_PYTHON, dirs.sort().at(-1));
	const r = spawnSync("cp", ["-a", src, dest], { env: isolatedEnv() });
	return r.status === 0 ? `copied ${path.basename(src)}` : `cp failed: ${r.stderr}`;
}

// ---------------------------------------------------------------------------
// 6. systemd transient user units (only units named sb-probe-<id>-*; stopped at exit)
// ---------------------------------------------------------------------------
const RUN_ID = randomBytes(3).toString("hex");
const startedUnits = new Set();
const childPids = new Set();
function systemdEnv() {
	return { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: ORIGINAL_ENV.XDG_RUNTIME_DIR ?? `/run/user/${UID}`, DBUS_SESSION_BUS_ADDRESS: ORIGINAL_ENV.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${UID}/bus` };
}
function systemctl(...args) {
	const r = spawnSync("systemctl", ["--user", ...args], { env: systemdEnv(), encoding: "utf8" });
	return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
function envArgs(env) {
	return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}
function startUnit(suffix, env, cmd, extraProps = []) {
	const unit = `sb-probe-${RUN_ID}-${suffix}`;
	if (!/^sb-probe-[0-9a-f]{6}-[a-z0-9-]+$/.test(unit)) throw new Error(`bad unit name ${unit}`);
	const args = ["--user", `--unit=${unit}`, "--quiet", "--collect", `--working-directory=${ISO.root}`, ...extraProps.map((p) => `--property=${p}`), "--", "/usr/bin/env", "-i", ...envArgs(env), ...cmd];
	const r = spawnSync("systemd-run", args, { env: systemdEnv(), encoding: "utf8" });
	if (r.status !== 0) throw new Error(`systemd-run ${unit} failed: ${r.stderr}`);
	startedUnits.add(unit);
	return unit;
}
function unitProps(unit) {
	const out = systemctl("show", unit, "-p", "MainPID", "-p", "ControlGroup", "-p", "ActiveState", "-p", "KillMode", "-p", "NRestarts").out;
	return Object.fromEntries(out.trim().split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}
function unitPids(unit) {
	const cg = unitProps(unit).ControlGroup;
	if (!cg) return [];
	try {
		return fs.readFileSync(path.join("/sys/fs/cgroup", cg, "cgroup.procs"), "utf8").trim().split("\n").filter(Boolean).map(Number);
	} catch {
		return [];
	}
}
function procCmd(pid) {
	try {
		return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
	} catch {
		return undefined;
	}
}
function procEnv(pid) {
	try {
		return Object.fromEntries(
			fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
		);
	} catch {
		return undefined;
	}
}
function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
function stopUnit(unit) {
	if (!startedUnits.has(unit)) throw new Error(`refusing to stop a unit this probe did not start: ${unit}`);
	systemctl("stop", unit);
	systemctl("reset-failed", unit);
}

// ---------------------------------------------------------------------------
// 7. Daemon + DaemonClient helpers
// ---------------------------------------------------------------------------
let DC; // the prime-agent module (DaemonClient, DAEMON_PROTOCOL_VERSION, ...)
async function loadPrimeAgent() {
	DC = await import(pathToFileURL(path.join(NPM_PKG, "dist", "index.js")).href);
	return DC;
}
function daemonCmd(iso) {
	return [PRIME_BIN, "--mode", "daemon", "--daemon-socket", iso.socket, "--offline"];
}
async function socketReady(sock, timeoutMs = 60000) {
	return waitFor(
		async () => {
			if (!fs.existsSync(sock)) return false;
			const c = new DC.DaemonClient(sock);
			try {
				await c.connect(500);
				const hello = await c.waitForHello(3000);
				return hello;
			} catch {
				return false;
			} finally {
				c.close();
			}
		},
		timeoutMs,
		`daemon hello on ${sock}`,
	);
}
class Conn {
	constructor(sock, label = "probe") {
		this.sock = sock;
		this.label = label;
		this.client = new DC.DaemonClient(sock);
		this.events = []; // {t, sid, type, ev, cursor, replayed}
		this.raw = [];
		this.waiters = new Set();
	}
	async open() {
		await this.client.connect(3000);
		this.hello = await this.client.waitForHello(5000);
		this.client.onMessage((m) => this.onMessage(m));
		return this;
	}
	onMessage(m) {
		const t = now();
		if (VERBOSE) this.raw.push({ t, m });
		if (m && (m.type === "session_event" || m.type === "event")) {
			const ev = m.event ?? {};
			const meta = m.meta ?? m;
			const rec = { t, sid: m.activeSessionId ?? meta.activeSessionId, type: ev.type, ev, cursor: meta.cursor, sequence: meta.sequence, replayed: meta.replayed === true };
			this.events.push(rec);
			for (const w of [...this.waiters]) if (w.pred(rec)) {
				this.waiters.delete(w);
				w.resolve(rec);
			}
		}
	}
	waitEvent(pred, timeoutMs, label) {
		const existing = this.events.find(pred);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const w = { pred, resolve };
			this.waiters.add(w);
			setTimeout(() => {
				if (this.waiters.delete(w)) reject(new Error(`timed out waiting for ${label}`));
			}, timeoutMs);
		});
	}
	async req(cmd, timeoutMs) {
		const r = await this.client.request(cmd, timeoutMs);
		if (!r.success) {
			const e = new Error(`${cmd.type} failed: ${r.error}`);
			e.response = r;
			throw e;
		}
		return r.data;
	}
	async tryReq(cmd, timeoutMs) {
		try {
			return { ok: true, data: await this.req(cmd, timeoutMs) };
		} catch (e) {
			return { ok: false, error: e.message, response: e.response };
		}
	}
	async attach(sid, extra = {}) {
		return this.req({ type: "attach", activeSessionId: sid, capabilities: ["attach_snapshot", "event_sequence"], ...extra }, 60000);
	}
	eventsFor(sid, fromIdx = 0) {
		return this.events.slice(fromIdx).filter((e) => e.sid === sid);
	}
	close() {
		this.client.close();
	}
}
const LIFECYCLE = new Set(["agent_start", "agent_end", "turn_start", "turn_end", "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end", "tool_execution_start", "tool_execution_end", "session_resynced"]);
function lifecycleSeq(events) {
	return events
		.filter((e) => LIFECYCLE.has(e.type) || (e.type === "message_end" && e.ev.message?.role === "assistant"))
		.map((e) => {
			if (e.type === "message_end") return `message_end(assistant:${e.ev.message?.stopReason ?? "?"})`;
			if (e.type === "compaction_end") return `compaction_end(${e.ev.reason ?? ""}${e.ev.willRetry ? ",willRetry" : ""}${e.ev.aborted ? ",aborted" : ""})`;
			if (e.type === "compaction_start") return `compaction_start(${e.ev.reason ?? ""})`;
			if (e.type === "auto_retry_start") return `auto_retry_start(${e.ev.attempt ?? ""})`;
			if (e.type === "auto_retry_end") return `auto_retry_end(${e.ev.success === undefined ? "" : e.ev.success ? "success" : "failed"})`;
			return e.type;
		});
}
function b64(code) {
	return Buffer.from(code, "utf8").toString("base64url");
}
function pyDirective(code) {
	return `[[py:${b64(code)}]]`;
}

// ---------------------------------------------------------------------------
// 8. Stand-alone DaemonClient program (runs as a separate process or systemd unit)
// ---------------------------------------------------------------------------
// Modes:
//   create-exit      create a session (resident or client_owned), print its summary, exit
//   service          ensure a named resident session exists, write a status file, stay alive
//                    (optionally spawning its own daemon first: the "shared cgroup" layout)
const CLIENT_SOURCE = `
import fs from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
const opts = JSON.parse(process.argv[2]);
const DC = await import(pathToFileURL(opts.npmIndex).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect() {
  for (let i = 0; i < 300; i++) {
    const c = new DC.DaemonClient(opts.socket);
    try { await c.connect(500); await c.waitForHello(3000); return c; } catch { c.close(); await sleep(200); }
  }
  throw new Error("daemon not reachable");
}
let daemonPid;
if (opts.spawnDaemon) {
  // Like prime-agent's own ensureDaemonRunning: a detached child. It stays in this unit's cgroup.
  const child = spawn(opts.daemonCmd[0], opts.daemonCmd.slice(1), { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  daemonPid = child.pid;
}
const c = await connect();
async function req(cmd, t = 120000) { const r = await c.request(cmd, t); if (!r.success) throw new Error(cmd.type + ": " + r.error); return r.data; }
if (opts.mode === "create-exit") {
  const s = await req({ type: "create", lifecycle: opts.lifecycle, name: opts.name, config: opts.config });
  process.stdout.write(JSON.stringify({ activeSessionId: s.activeSessionId ?? s.id, sessionId: s.sessionId, workerPid: s.workerPid, clientPid: process.pid }) + "\\n");
  process.exit(0);
}
if (opts.mode === "service") {
  const list = await req({ type: "list" });
  let s = (list.sessions ?? []).find((x) => x.sessionName === opts.name);
  let created = false;
  let createError;
  if (!s) {
    try { s = await req({ type: "create", lifecycle: "resident", name: opts.name, config: opts.config }); created = true; }
    catch (e) { createError = String(e.message ?? e); }
  }
  const status = { pid: process.pid, daemonPid: daemonPid ?? c.hello?.supervisorPid, created, createError, activeSessionId: s && (s.activeSessionId ?? s.id), sessionId: s?.sessionId, workerPid: s?.workerPid, at: Date.now() };
  fs.writeFileSync(opts.statusFile + ".tmp", JSON.stringify(status));
  fs.renameSync(opts.statusFile + ".tmp", opts.statusFile);
  setInterval(() => {}, 1 << 30);
}
`;
function writeClientProgram() {
	const p = path.join(ROOT, "client.mjs");
	fs.writeFileSync(p, CLIENT_SOURCE);
	return p;
}
function runClientProcess(opts, iso = ISO) {
	const p = path.join(ROOT, "client.mjs");
	return new Promise((resolve) => {
		const child = spawn(NODE_BIN, [p, JSON.stringify({ npmIndex: path.join(NPM_PKG, "dist", "index.js"), socket: iso.socket, ...opts })], { env: isolatedEnv({}, iso), stdio: ["ignore", "pipe", "pipe"] });
		childPids.add(child.pid);
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("exit", (code) => resolve({ code, out, err, pid: child.pid }));
	});
}

// ---------------------------------------------------------------------------
// 9. Checks
// ---------------------------------------------------------------------------
const S = {}; // sessions by label: {sid, sessionId, sessionFile}
const turnLog = {};
const WORK = () => path.join(ROOT, "work");
function reqsSince(t0, pred = () => true) {
	return fake.requests.filter((r) => r.t >= t0 && pred(r));
}
async function runTurn(c, sid, label, sendFn, { waitMs = 90000, quietMs = 2000 } = {}) {
	const idx = c.events.length;
	const tStart = now();
	await sendFn();
	const tSent = now();
	const idle = await c.tryReq({ type: "wait_for_idle", activeSessionId: sid }, waitMs);
	const tIdle = now();
	const st = await c.req({ type: "get_state", activeSessionId: sid });
	await sleep(quietMs);
	const evs = c.eventsFor(sid, idx);
	const firstStart = evs.find((e) => e.type === "agent_start");
	const ends = evs.filter((e) => e.type === "agent_end");
	const after = evs.filter((e) => e.t > tIdle && LIFECYCLE.has(e.type));
	const r = {
		label,
		sequence: lifecycleSeq(evs),
		agentEndCount: ends.length,
		waitForIdle: idle.ok ? "resolved" : `error: ${idle.error}`,
		idleMsAfterSend: Math.round(tIdle - tSent),
		idleMsAfterLastAgentEnd: ends.length ? Math.round(tIdle - ends.at(-1).t) : null,
		idleBeforeFirstAgentStart: firstStart ? tIdle < firstStart.t : true,
		lifecycleEventsAfterIdle: lifecycleSeq(after),
		stateAtIdle: { isStreaming: st.isStreaming, isCompacting: st.isCompacting, activity: st.activity, queued: st.sessionActions?.queuedCount, unfinishedActionCount: st.unfinishedActionCount },
		elapsedMs: Math.round(tIdle - tStart),
	};
	turnLog[label] = r;
	note(`turn:${label}`, r);
	return r;
}
function settledOk(r) {
	return r.waitForIdle === "resolved" && !r.idleBeforeFirstAgentStart && r.lifecycleEventsAfterIdle.length === 0 && r.stateAtIdle.isStreaming === false && r.stateAtIdle.isCompacting === false;
}
async function createSession(c, label, cmd) {
	const s = await c.req({ type: "create", lifecycle: "resident", ...cmd }, 180000);
	const sid = s.activeSessionId ?? s.id;
	S[label] = { sid, sessionId: s.sessionId, sessionFile: s.sessionFile, summary: s };
	await c.attach(sid);
	return S[label];
}

async function groupCreate(c) {
	// create with lifecycle resident + config + name
	const t0 = now();
	const s = await c.req(
		{
			type: "create",
			lifecycle: "resident",
			name: "sbp-alpha",
			config: { cwd: ISO.proj, provider: "fake", model: "fake-b", thinking: "xhigh", appendSystemPrompt: ["SBPROBE-CFG-APPEND"], noBuiltinTools: true },
		},
		180000,
	);
	const sid = s.activeSessionId ?? s.id;
	S.alpha = { sid, sessionId: s.sessionId, sessionFile: s.sessionFile };
	note("create-latency-ms", Math.round(now() - t0));
	check("create-resident-name", s.sessionName === "sbp-alpha", `sessionName=${s.sessionName}`);
	check("create-config-cwd", s.cwd === ISO.proj, `cwd=${s.cwd}`);
	check("create-config-model", s.model?.provider === "fake" && s.model?.id === "fake-b", `model=${s.model?.provider}/${s.model?.id}`);
	check("create-config-thinking-clamped", s.thinkingLevel === "high", `requested xhigh on a model whose map drops xhigh/max; state thinkingLevel=${s.thinkingLevel}`);
	const list = await c.req({ type: "list" });
	const row = (list.sessions ?? []).find((x) => (x.activeSessionId ?? x.id) === sid);
	check("create-resident-listed", Boolean(row), `default list shows it (client-owned workers are hidden from default lists)`);
	await c.attach(sid);
	const tp = now();
	await runTurn(c, sid, "alpha-plain", () => c.req({ type: "prompt", activeSessionId: sid, message: "[[reply:ALPHA]]" }));
	const reqs = reqsSince(tp, (r) => r.isAgent);
	const r0 = reqs[0];
	check("create-config-appendSystemPrompt", r0 && r0.system.includes("SBPROBE-CFG-APPEND"), "config.appendSystemPrompt text reaches the model system prompt", r0 ? "marker missing" : "no agent request seen");
	note("noBuiltinTools-tools-sent", r0?.tools ?? null);
	note("alpha-system-prompt-markers", r0 ? { cfgAppend: r0.system.includes("SBPROBE-CFG-APPEND"), projectAppendSystemMd: r0.system.includes("SBPROBE-PROJECT-APPEND-SYSTEM"), globalAppendSystemMd: r0.system.includes(AGENT_MARKER), agentsMd: r0.system.includes("SBPROBE-PROJECT-AGENTS-MD") } : null);
	check("create-config-noBuiltinTools", r0 && !r0.tools.includes("ipython"), `tools sent with noBuiltinTools=true: ${JSON.stringify(r0?.tools)}`);
	note("thinking-sent-to-provider", { reasoning_effort: r0?.reasoning_effort ?? null });
	// duplicate name
	const dup = await c.tryReq({ type: "create", lifecycle: "resident", name: "sbp-alpha", config: { cwd: WORK(), provider: "fake", model: "fake-a" } }, 60000);
	note("duplicate-name-create", dup.ok ? { accepted: true, sessionName: dup.data.sessionName } : { accepted: false, error: dup.error });
	check("create-duplicate-name-refused", !dup.ok, dup.ok ? "second live session with the same name was accepted" : `refused: ${dup.error}`);
	if (dup.ok) await c.tryReq({ type: "kill", activeSessionId: dup.data.activeSessionId ?? dup.data.id });
	// tools: ["ipython"] together with noBuiltinTools
	const s2 = await c.tryReq({ type: "create", lifecycle: "resident", name: "sbp-alpha-tools", config: { cwd: WORK(), provider: "fake", model: "fake-a", noBuiltinTools: true, tools: ["ipython"] } }, 180000);
	if (s2.ok) {
		const sid2 = s2.data.activeSessionId ?? s2.data.id;
		await c.attach(sid2);
		const t2 = now();
		await runTurn(c, sid2, "alpha-tools", () => c.req({ type: "prompt", activeSessionId: sid2, message: "[[reply:TOOLS]]" }));
		const rq = reqsSince(t2, (r) => r.isAgent)[0];
		note("noBuiltinTools+tools[ipython]-tools-sent", rq?.tools ?? null);
		await c.tryReq({ type: "kill", activeSessionId: sid2 });
	}
}

async function groupTurns(c) {
	const b = await createSession(c, "beta", { name: "sbp-beta", config: { cwd: WORK(), provider: "fake", model: "fake-a" } });
	const sid = b.sid;
	const plain = await runTurn(c, sid, "plain", () => c.req({ type: "prompt", activeSessionId: sid, message: "[[reply:PLAIN]]" }));
	check("prompt", plain.sequence.includes("agent_end") && plain.agentEndCount === 1, `sequence ${plain.sequence.join(" > ")}`);
	check("wait_for_idle", settledOk(plain), `resolved ${plain.idleMsAfterLastAgentEnd} ms after agent_end; nothing after it`, JSON.stringify(plain));
	// steer while streaming
	let tS = now();
	const steer = await runTurn(c, sid, "steer", async () => {
		await c.req({ type: "prompt", activeSessionId: sid, message: "[[slow:12]]" });
		await c.waitEvent((e) => e.sid === sid && e.t > tS && e.type === "message_update", 10000, "streaming");
		await c.req({ type: "steer", activeSessionId: sid, message: "[[reply:STEERED]]" });
	});
	const steerReq = reqsSince(tS, (r) => r.isAgent && r.lastUser.includes("STEERED"));
	check("steer", steerReq.length > 0, `steer reached the model; sequence ${steer.sequence.join(" > ")}`, "steer text never reached the model");
	check("settled-signal-steer", settledOk(steer), `agent_end count ${steer.agentEndCount}`, JSON.stringify(steer));
	// follow_up while streaming
	tS = now();
	const fu = await runTurn(c, sid, "follow_up", async () => {
		await c.req({ type: "prompt", activeSessionId: sid, message: "[[slow:12]]" });
		await c.waitEvent((e) => e.sid === sid && e.t > tS && e.type === "message_update", 10000, "streaming");
		await c.req({ type: "follow_up", activeSessionId: sid, message: "[[reply:FOLLOWED]]" });
	});
	const fuReq = reqsSince(tS, (r) => r.isAgent && r.lastUser.includes("FOLLOWED"));
	check("follow_up", fuReq.length > 0, `follow-up delivered after the run: ${fu.sequence.join(" > ")}`, "follow-up never reached the model");
	check("settled-signal-follow_up", settledOk(fu), `agent_end count ${fu.agentEndCount}`, JSON.stringify(fu));
	// abort
	tS = now();
	const ab = await runTurn(c, sid, "abort", async () => {
		await c.req({ type: "prompt", activeSessionId: sid, message: "[[slow:120]]" });
		await c.waitEvent((e) => e.sid === sid && e.t > tS && e.type === "message_update", 10000, "streaming");
		await sleep(500);
		await c.req({ type: "abort", activeSessionId: sid });
	});
	check("abort", ab.sequence.some((x) => x.includes("aborted")) && ab.elapsedMs < 20000, `sequence ${ab.sequence.join(" > ")}`, JSON.stringify(ab));
	check("settled-signal-abort", settledOk(ab), `wait_for_idle resolved ${ab.idleMsAfterLastAgentEnd} ms after agent_end`, JSON.stringify(ab));
	// After abort the session suspends queued session input (AgentSession.requestAbort). Record how
	// the next prompt behaves: immediately, after a short wait, and after resume_queue.
	const attempts = [];
	let recovered = false;
	for (const step of ["immediate", "after-1s", "resume_queue"]) {
		if (step === "after-1s") await sleep(1000);
		if (step === "resume_queue") {
			const rq = await c.tryReq({ type: "resume_queue", activeSessionId: sid });
			attempts.push({ step: "resume_queue-response", result: rq.ok ? "ok" : rq.error });
		}
		const p = await c.tryReq({ type: "prompt", activeSessionId: sid, message: `[[reply:AFTER_ABORT_${step}]]` });
		attempts.push({ step, result: p.ok ? "accepted" : p.error });
		if (p.ok) {
			await c.req({ type: "wait_for_idle", activeSessionId: sid }, 60000);
			recovered = true;
			break;
		}
	}
	note("prompt-after-abort", attempts);
	check("prompt-after-abort", recovered, JSON.stringify(attempts), JSON.stringify(attempts));
	// retry (one 503, then success)
	const rt = await runTurn(c, sid, "retry", () => c.req({ type: "prompt", activeSessionId: sid, message: "[[fail:R1:1]]" }));
	check("retry-observed", rt.sequence.some((x) => x.startsWith("auto_retry_start")), `sequence ${rt.sequence.join(" > ")}`, JSON.stringify(rt));
	check("settled-signal-retry", settledOk(rt), `agent_end count ${rt.agentEndCount}; wait_for_idle after the retry finished`, JSON.stringify(rt));
	// retry exhausted (maxRetries=2, three failures)
	const rx = await runTurn(c, sid, "retry-exhausted", () => c.req({ type: "prompt", activeSessionId: sid, message: "[[fail:R2:9]]" }));
	check("settled-signal-retry-exhausted", settledOk(rx), `agent_end count ${rx.agentEndCount}`, JSON.stringify(rx));
	// set_model / set_thinking_level
	await c.req({ type: "set_model", activeSessionId: sid, provider: "fake", modelId: "fake-b" });
	let st = await c.req({ type: "get_state", activeSessionId: sid });
	const tm = now();
	await runTurn(c, sid, "after-set-model", () => c.req({ type: "prompt", activeSessionId: sid, message: "[[reply:MODEL_B]]" }), { quietMs: 300 });
	const mreq = reqsSince(tm, (r) => r.isAgent)[0];
	check("set_model", st.model?.id === "fake-b" && mreq?.model === "fake-b", `state model ${st.model?.id}; next request used ${mreq?.model}`);
	await c.req({ type: "set_thinking_level", activeSessionId: sid, level: "max" });
	st = await c.req({ type: "get_state", activeSessionId: sid });
	check("set_thinking_level-clamped-readable", st.thinkingLevel === "high", `set max on fake-b (map drops xhigh/max) -> get_state thinkingLevel=${st.thinkingLevel}`);
	const cs = await c.req({ type: "get_connection_state", activeSessionId: sid }).catch((e) => ({ error: e.message }));
	note("connection-state-thinking", { thinkingLevel: cs.thinkingLevel ?? cs.state?.thinkingLevel ?? null, availableThinkingLevels: cs.availableThinkingLevels ?? cs.state?.availableThinkingLevels ?? null });
	await c.req({ type: "set_model", activeSessionId: sid, provider: "fake", modelId: "fake-a" });
	st = await c.req({ type: "get_state", activeSessionId: sid });
	note("thinking-after-switch-to-non-reasoning-model", st.thinkingLevel);
	await c.req({ type: "set_thinking_level", activeSessionId: sid, level: "high" });
	st = await c.req({ type: "get_state", activeSessionId: sid });
	check("set_thinking_level-clamped-off", st.thinkingLevel === "off", `set high on non-reasoning fake-a -> ${st.thinkingLevel}`);
}

async function groupCompaction(c) {
	const g = await createSession(c, "gamma", { name: "sbp-gamma", config: { cwd: WORK(), provider: "fake", model: "fake-tiny" } });
	const sid = g.sid;
	const grow = async (tag) => {
		for (let i = 0; i < 4; i++) await runTurn(c, sid, `grow-${tag}-${i}`, () => c.req({ type: "prompt", activeSessionId: sid, message: `[[long:1500]] ${tag}${i}` }), { quietMs: 100 });
	};
	const compactionEnds = (idx) =>
		c.eventsFor(sid, idx)
			.filter((e) => e.type === "compaction_end")
			.map((e) => ({ reason: e.ev.reason, willRetry: e.ev.willRetry, aborted: e.ev.aborted, hasResult: Boolean(e.ev.result), error: e.ev.errorMessage }));
	await grow("a");
	let idx = c.events.length;
	let t0 = now();
	const th = await runTurn(c, sid, "compaction-threshold", () => c.req({ type: "prompt", activeSessionId: sid, message: "[[big:T1]]" }), { quietMs: 3000 });
	note("compaction-threshold-ends", { ends: compactionEnds(idx), summaryRequests: reqsSince(t0, (r) => !r.isAgent).length });
	check("compaction-threshold-observed", compactionEnds(idx).some((e) => e.hasResult), `sequence ${th.sequence.join(" > ")}`, JSON.stringify({ th, ends: compactionEnds(idx) }));
	check("settled-signal-compaction-threshold", settledOk(th), `wait_for_idle resolved ${th.idleMsAfterLastAgentEnd} ms after agent_end, after compaction_end`, JSON.stringify(th));
	await grow("b");
	idx = c.events.length;
	t0 = now();
	const ov = await runTurn(c, sid, "compaction-overflow", () => c.req({ type: "prompt", activeSessionId: sid, message: "[[overflow:O1]]" }), { quietMs: 3000 });
	const ci = ov.sequence.findIndex((x) => x.startsWith("compaction_end(overflow"));
	const retried = ci >= 0 && ov.sequence.slice(ci).includes("agent_start") && reqsSince(t0, (r) => r.isAgent && !r.failed).length > 0;
	note("compaction-overflow-ends", { ends: compactionEnds(idx), summaryRequests: reqsSince(t0, (r) => !r.isAgent).length, retriedAfterCompaction: retried });
	check("compaction-overflow-observed", compactionEnds(idx).some((e) => e.hasResult && e.willRetry) && retried, `sequence ${ov.sequence.join(" > ")}`, JSON.stringify({ ov, ends: compactionEnds(idx), retried }));
	check("settled-signal-compaction-overflow", settledOk(ov), `agent_end count ${ov.agentEndCount}; wait_for_idle after the post-compaction retry`, JSON.stringify(ov));
}

async function groupReattach(c) {
	const sid = S.beta?.sid ?? (await createSession(c, "beta", { name: "sbp-beta", config: { cwd: WORK(), provider: "fake", model: "fake-a" } })).sid;
	const x = await new Conn(ISO.socket, "x").open();
	const att1 = await x.attach(sid);
	await runTurn(x, sid, "reattach-before", () => x.req({ type: "prompt", activeSessionId: sid, message: "[[reply:BEFORE]]" }), { quietMs: 300 });
	const lastEv = x.eventsFor(sid).at(-1);
	const cursor = lastEv?.cursor ?? att1.lastEventCursor;
	await x.req({ type: "detach", activeSessionId: sid });
	const nBefore = x.events.length;
	// another client drives a turn while x is detached
	await runTurn(c, sid, "while-detached", () => c.req({ type: "prompt", activeSessionId: sid, message: "[[reply:WHILE_DETACHED]]" }), { quietMs: 300 });
	check("detach", x.events.length === nBefore, `detached client received ${x.events.length - nBefore} events while detached`);
	const att2 = await x.attach(sid, { resumeCursor: { activeSessionId: sid, ...cursor } });
	await sleep(500);
	const replayed = x.events.slice(nBefore).filter((e) => e.sid === sid);
	note("reattach-same-client", { cursor, replay: att2.replay, replayedEvents: replayed.length, replayedFlag: replayed.filter((e) => e.replayed).length, snapshotMessages: att2.snapshot?.messages?.length });
	// The daemon does not replay missed events; the attach snapshot is the recovery baseline. The
	// client detects the gap by comparing its saved cursor with the attach result's lastEventCursor.
	const snapText = JSON.stringify(att2.snapshot?.messages ?? []);
	const gap = att2.lastEventCursor?.generation === cursor.generation && att2.lastEventCursor.sequence > cursor.sequence;
	check(
		"reattach-with-cursor",
		gap && snapText.includes("WHILE_DETACHED"),
		`gap detected from cursors (${cursor.sequence} -> ${att2.lastEventCursor?.sequence}, same generation); snapshot holds the missed turn; ${replayed.length} events replayed; replay status reported "${att2.replay?.status}"`,
		JSON.stringify({ cursor, last: att2.lastEventCursor, replay: att2.replay, replayed: replayed.length }),
	);
	// a brand-new client (as after a host-agent restart) presenting the same cursor
	const z = await new Conn(ISO.socket, "z").open();
	await runTurn(c, sid, "while-z-absent", () => c.req({ type: "prompt", activeSessionId: sid, message: "[[reply:Z_ABSENT]]" }), { quietMs: 300 });
	const att3 = await z.attach(sid, { resumeCursor: { activeSessionId: sid, ...cursor } });
	await sleep(500);
	note("reattach-new-client", { replay: att3.replay, replayedEvents: z.eventsFor(sid).length, snapshotMessages: att3.snapshot?.messages?.length, snapshotSummaryName: att3.snapshot?.summary?.sessionName });
	check("reattach-new-client-with-cursor", ["complete", "partial"].includes(att3.replay?.status) || (att3.snapshot?.messages?.length ?? 0) > 0, `replay ${att3.replay?.status}; snapshot has ${att3.snapshot?.messages?.length} messages`);
	// protocol "reattach" (switch the attachment of one client to another session)
	if (S.alpha) {
		const rr = await x.tryReq({ type: "reattach", activeSessionId: sid, targetActiveSessionId: S.alpha.sid, capabilities: ["attach_snapshot", "event_sequence"] });
		note("reattach-command", rr.ok ? { ok: true, activeSessionId: rr.data?.activeSessionId } : rr.error);
	}
	const list = await c.req({ type: "list" });
	const names = (list.sessions ?? []).map((s) => s.sessionName).filter(Boolean);
	note("list-names", names);
	check("list", names.includes("sbp-beta") && list.sessions.every((s) => typeof s.sessionId === "string"), `${list.sessions.length} sessions: ${names.join(", ")}`);
	x.close();
	z.close();
}

async function groupSurvive(c) {
	writeClientProgram();
	const out = await runClientProcess({ mode: "create-exit", lifecycle: "resident", name: "sbp-orphan", config: { cwd: WORK(), provider: "fake", model: "fake-a" } });
	let s;
	try {
		s = JSON.parse(out.out.trim().split("\n").at(-1));
	} catch {
		return fail("survive-creator-exit", `client failed: code ${out.code} ${out.err.slice(0, 500)}`);
	}
	check("creator-process-exited", out.code === 0 && !pidAlive(out.pid), `client pid ${out.pid} exited ${out.code}`);
	await sleep(3000);
	const list = await c.req({ type: "list" });
	const row = (list.sessions ?? []).find((x) => (x.activeSessionId ?? x.id) === s.activeSessionId);
	await c.attach(s.activeSessionId);
	const r = await runTurn(c, s.activeSessionId, "orphan-alive", () => c.req({ type: "prompt", activeSessionId: s.activeSessionId, message: "[[reply:ALIVE]]" }), { quietMs: 300 });
	check("survive-creator-exit", Boolean(row) && r.agentEndCount === 1 && row.workerPid === s.workerPid, `listed after creator exit, same worker pid ${row?.workerPid}, prompt ran`);
	S.orphan = { sid: s.activeSessionId, sessionId: s.sessionId };
	// contrast: a client_owned session whose creator exits
	const out2 = await runClientProcess({ mode: "create-exit", lifecycle: "client_owned", name: "sbp-owned", config: { cwd: WORK(), provider: "fake", model: "fake-a" } });
	let o;
	try {
		o = JSON.parse(out2.out.trim().split("\n").at(-1));
	} catch {
		note("client-owned-contrast", `client failed: ${out2.err.slice(0, 300)}`);
		return;
	}
	const seen = [];
	let elapsedS = 0;
	for (const waitS of [1, 5, 15, 30]) {
		await sleep((waitS - elapsedS) * 1000);
		elapsedS = waitS;
		const l = await c.req({ type: "list", includeClientOwned: true });
		seen.push({ afterS: waitS, present: (l.sessions ?? []).some((x) => (x.activeSessionId ?? x.id) === o.activeSessionId), workerAlive: pidAlive(o.workerPid) });
	}
	note("client-owned-after-creator-exit", seen);
}

async function groupReopenKill(c) {
	const d = await createSession(c, "delta", { name: "sbp-delta", config: { cwd: WORK(), provider: "fake", model: "fake-a" } });
	await runTurn(c, d.sid, "delta-1", () => c.req({ type: "prompt", activeSessionId: d.sid, message: "[[reply:DELTA_ONE]]" }), { quietMs: 200 });
	const killed = await c.tryReq({ type: "kill", activeSessionId: d.sid });
	await sleep(1000);
	const list = await c.req({ type: "list" });
	const gone = !(list.sessions ?? []).some((x) => x.sessionId === d.sessionId);
	check("kill", killed.ok && gone && fs.existsSync(d.sessionFile), `killed; not listed; transcript kept at ${path.basename(d.sessionFile)}`, JSON.stringify(killed));
	// reopen by session id
	const byId = await c.tryReq({ type: "create", lifecycle: "resident", sessionPath: d.sessionId }, 180000);
	if (!byId.ok) return fail("reopen-by-id", byId.error);
	const sidId = byId.data.activeSessionId ?? byId.data.id;
	await c.attach(sidId);
	const msgs = await c.req({ type: "get_messages", activeSessionId: sidId });
	const texts = JSON.stringify(msgs);
	check("reopen-by-id", byId.data.sessionId === d.sessionId && texts.includes("DELTA_ONE"), `same sessionId, history kept, name=${byId.data.sessionName}`);
	note("reopen-keeps-name", byId.data.sessionName ?? null);
	await c.req({ type: "kill", activeSessionId: sidId });
	await sleep(500);
	const byPath = await c.tryReq({ type: "create", lifecycle: "resident", sessionPath: d.sessionFile }, 180000);
	check("reopen-by-path", byPath.ok && byPath.data.sessionId === d.sessionId, byPath.ok ? `sessionId ${byPath.data.sessionId}` : byPath.error);
	if (byPath.ok) {
		// a second open of the same live session returns the same worker (single writer)
		const again = await c.tryReq({ type: "create", lifecycle: "resident", sessionPath: d.sessionId }, 60000);
		note("reopen-while-live", again.ok ? { sameActiveSession: (again.data.activeSessionId ?? again.data.id) === (byPath.data.activeSessionId ?? byPath.data.id) } : again.error);
		await c.req({ type: "kill", activeSessionId: byPath.data.activeSessionId ?? byPath.data.id });
		await sleep(500);
	}
	// name reuse after the named session was killed (its transcript still exists)
	const reuse = await c.tryReq({ type: "create", lifecycle: "resident", name: "sbp-delta", config: { cwd: WORK(), provider: "fake", model: "fake-a" } }, 180000);
	note("name-reuse-after-kill", reuse.ok ? { accepted: true } : { accepted: false, error: reuse.error });
	if (reuse.ok) await c.tryReq({ type: "kill", activeSessionId: reuse.data.activeSessionId ?? reuse.data.id });
}

async function groupTrust(c) {
	const e = await createSession(c, "epsilon", { name: "sbp-epsilon", config: { cwd: ISO.proj, provider: "fake", model: "fake-a" } });
	const t0 = now();
	await runTurn(c, e.sid, "trust", () => c.req({ type: "prompt", activeSessionId: e.sid, message: "[[reply:TRUST]]" }), { quietMs: 300 });
	const r = reqsSince(t0, (x) => x.isAgent)[0];
	const sys = r?.system ?? "";
	const got = {
		agentsMd: sys.includes("SBPROBE-PROJECT-AGENTS-MD"),
		projectAppendSystem: sys.includes("SBPROBE-PROJECT-APPEND-SYSTEM"),
		projectSkill: sys.includes("projskill"),
		projectExtensionTool: (r?.tools ?? []).includes("sbprobe_project_tool"),
		globalAppendSystemAlsoPresent: sys.split(AGENT_MARKER).length - 1 > 1,
	};
	const uiRequests = c.eventsFor(e.sid).filter((x) => String(x.type).includes("extension_ui")).length;
	note("project-resources", { ...got, extensionUiRequests: uiRequests });
	check("project-trust-no-approval-needed", got.agentsMd && got.projectAppendSystem && got.projectSkill && got.projectExtensionTool && uiRequests === 0, JSON.stringify(got));
	// contrast: a session outside the project sees none of it
	const w = S.beta ?? (await createSession(c, "beta", { name: "sbp-beta", config: { cwd: WORK(), provider: "fake", model: "fake-a" } }));
	const t1 = now();
	await runTurn(c, w.sid, "trust-contrast", () => c.req({ type: "prompt", activeSessionId: w.sid, message: "[[reply:NOPROJ]]" }), { quietMs: 300 });
	const r2 = reqsSince(t1, (x) => x.isAgent)[0];
	check("project-resources-scoped-to-cwd", r2 && !r2.system.includes("SBPROBE-PROJECT") && !r2.tools.includes("sbprobe_project_tool"), "a session with another cwd gets none of the project resources");
}

async function groupSkill(c) {
	const k = await createSession(c, "kappa", { name: "sbp-kappa", config: { cwd: WORK(), provider: "fake", model: "fake-a" } });
	const sid = k.sid;
	const helloCode = `pre = "sbprobe" in globals()
import os, json
import sbprobe
r = sbprobe.hello(tag="hello", preimported=pre, file=sbprobe.__file__)
print(json.dumps({"pre": pre, "depth": os.environ.get("RLM_DEPTH"), "sd": os.environ.get("RLM_SESSION_DIR"), "rtt_ms": r["rtt_ms"]}))
#tag:hello`;
	const tb = now();
	await runTurn(c, sid, "skill-hello", () => c.req({ type: "prompt", activeSessionId: sid, message: pyDirective(helloCode) }), { waitMs: 400000, quietMs: 300 });
	note("first-ipython-call-ms (includes kernel bootstrap)", Math.round(now() - tb));
	const h = sockMsgs.find((m) => m.msg.tag === "hello");
	if (!h) {
		const tr = reqsSince(tb, (r) => r.lastRole === "tool")[0];
		return fail("skill-importable", `no socket message from the kernel; tool result: ${tr?.toolContent ?? "none"}`);
	}
	check("skill-importable", true, `import sbprobe ok (${h.msg.file}); pre-imported in namespace: ${h.msg.preimported}`);
	check("skill-preimported", h.msg.preimported === true, "the kernel pre-imports installed Python skills", `preimported=${h.msg.preimported}`);
	check("rlm-session-dir-is-session-id", h.msg.depth === "0" && path.basename(h.msg.session_dir ?? "") === k.sessionId, `RLM_DEPTH=${h.msg.depth}; RLM_SESSION_DIR=${h.msg.session_dir}; sessionId=${k.sessionId}`);
	note("home-in-kernel-resolves-to", path.dirname(path.dirname(path.dirname(ISO.probeSock))));
	// subagent
	const childCode = `import sbprobe, os
sbprobe.hello(tag="child")
print("child", os.environ.get("RLM_DEPTH"))
#tag:child`;
	const spawnCode = `h = await rlm.spawn(${JSON.stringify(pyDirective(childCode))}, name="sbp-child")
print(h)
#tag:spawn`;
	await runTurn(c, sid, "spawn", () => c.req({ type: "prompt", activeSessionId: sid, message: pyDirective(spawnCode) }), { quietMs: 300 });
	let ch;
	try {
		ch = await waitFor(() => sockMsgs.find((m) => m.msg.tag === "child"), 240000, "child hello");
	} catch (e) {
		const tr = fake.requests.filter((r) => r.toolContent).map((r) => r.toolContent).slice(-3);
		return fail("subagent-depth-above-0", `${e.message}; recent tool results ${JSON.stringify(tr)}`);
	}
	check("subagent-depth-above-0", Number(ch.msg.depth) > 0 && path.basename(ch.msg.session_dir ?? "") !== k.sessionId, `child RLM_DEPTH=${ch.msg.depth}; RLM_SESSION_DIR=${ch.msg.session_dir}`);
	check("subagent-has-skill", true, "the child kernel imported sbprobe too (so the module must refuse by depth)");
	// A finished child wakes its parent: the parent starts a run that no client prompted.
	const idxWake = c.events.length;
	const tWake = now();
	await sleep(1500);
	for (let quiet = 0; quiet < 3; ) {
		await c.req({ type: "wait_for_idle", activeSessionId: sid }, 120000);
		const n = c.events.length;
		await sleep(1500);
		quiet = c.events.length === n ? quiet + 1 : 0;
	}
	const wake = c.eventsFor(sid, idxWake);
	const wakeReqs = reqsSince(tWake, (r) => r.isAgent);
	note("parent-run-after-child-finished", { sequence: lifecycleSeq(wake), modelRequests: wakeReqs.map((r) => r.lastUser.slice(0, 160)) });
	// latency: module call vs tool-call event, same clock (this process)
	const rows = [];
	for (let i = 0; i < 6; i++) {
		const tag = `speak${i}`;
		const code = `import sbprobe
r = sbprobe.speak("hello ${i}", tag="${tag}")
sbprobe._send("rtt", tag="${tag}-rtt", rtt_ms=r["rtt_ms"])
#tag:${tag}`;
		const idx = c.events.length;
		await runTurn(c, sid, `speak-${i}`, () => c.req({ type: "prompt", activeSessionId: sid, message: pyDirective(code) }), { quietMs: 100 });
		const sent = fake.toolCallSentAt.get(tag);
		const evt = c.events.slice(idx).find((e) => e.sid === sid && e.type === "tool_execution_start");
		const sock = sockMsgs.find((m) => m.msg.tag === tag);
		const rtt = sockMsgs.find((m) => m.msg.tag === `${tag}-rtt`);
		rows.push({ i, toolEventMs: evt && sent ? evt.t - sent : null, moduleMs: sock && sent ? sock.t - sent : null, pyRttMs: rtt?.msg.rtt_ms ?? null });
	}
	const warm = rows.slice(1);
	const summary = {
		samples: rows.map((r) => ({ i: r.i, toolEventMs: r.toolEventMs && +r.toolEventMs.toFixed(1), moduleMs: r.moduleMs && +r.moduleMs.toFixed(1), pyRttMs: r.pyRttMs && +r.pyRttMs.toFixed(2) })),
		medianToolExecutionStartEventMs: +median(warm.map((r) => r.toolEventMs)).toFixed(1),
		medianModuleSocketArrivalMs: +median(warm.map((r) => r.moduleMs)).toFixed(1),
		medianPythonSocketRoundTripMs: +median(warm.map((r) => r.pyRttMs)).toFixed(2),
		clockOrigin: "time the fake model finished sending the ipython tool call",
	};
	note("speak-latency", summary);
	check("speak-latency-measured", warm.every((r) => r.moduleMs !== null && r.toolEventMs !== null), `median module ${summary.medianModuleSocketArrivalMs} ms vs tool_execution_start event ${summary.medianToolExecutionStartEventMs} ms after the tool call left the model`);
}

async function groupSystemd(c) {
	writeClientProgram();
	const port = fakeServer.address().port;
	// Layout B: the daemon has its own unit (sb-probe-<id>-daemon); the client (host agent) has another.
	const statusB = path.join(ROOT, "status-b.json");
	const optsB = { npmIndex: path.join(NPM_PKG, "dist", "index.js"), socket: ISO.socket, mode: "service", name: "sbp-svc", statusFile: statusB, config: { cwd: WORK(), provider: "fake", model: "fake-a" } };
	const unitB = startUnit("client-b", isolatedEnv(), [NODE_BIN, path.join(ROOT, "client.mjs"), JSON.stringify(optsB)], ["KillMode=control-group"]);
	const s1 = await waitFor(() => fs.existsSync(statusB) && JSON.parse(fs.readFileSync(statusB, "utf8")), 180000, "client-b status");
	fs.rmSync(statusB);
	const r = systemctl("restart", unitB);
	const s2 = await waitFor(() => fs.existsSync(statusB) && JSON.parse(fs.readFileSync(statusB, "utf8")), 120000, "client-b status after restart");
	const list = await c.req({ type: "list" });
	const row = (list.sessions ?? []).find((x) => (x.activeSessionId ?? x.id) === s1.activeSessionId);
	const detail = { first: s1, afterRestart: s2, restartExit: r.status, clientPidChanged: s1.pid !== s2.pid, sameSession: s1.activeSessionId === s2.activeSessionId, workerPidStillAlive: pidAlive(s1.workerPid) };
	note("systemd-separate-units", detail);
	check("systemd-client-restart-keeps-resident-worker", s1.created && !s2.created && detail.sameSession && detail.clientPidChanged && detail.workerPidStillAlive && Boolean(row), "daemon in its own unit: restarting the client unit keeps the session and its worker", JSON.stringify(detail));
	if (row) {
		await c.attach(s1.activeSessionId);
		const t = await runTurn(c, s1.activeSessionId, "after-client-restart", () => c.req({ type: "prompt", activeSessionId: s1.activeSessionId, message: "[[reply:STILL_HERE]]" }), { quietMs: 200 });
		check("attachable-after-client-unit-restart", t.agentEndCount === 1, "another client attaches and prompts it");
	}
	stopUnit(unitB);
	// Layout A: the client spawns the daemon itself, so the daemon and its workers live in the client's cgroup.
	const isoA = { ...ISO, root: path.join(ROOT, "a"), home: path.join(ROOT, "a", "h"), tmp: path.join(ROOT, "a", "t"), socket: path.join(ROOT, "a", "d.sock") };
	Object.assign(isoA, { agentDir: path.join(isoA.home, ".prime", "agent"), registry: path.join(isoA.home, ".prime", "supervisor-owners"), kernelVenv: ISO.kernelVenv, xdgData: path.join(isoA.home, ".local", "share"), xdgConfig: path.join(isoA.home, ".config"), xdgCache: path.join(isoA.home, ".cache"), xdgState: path.join(isoA.home, ".local", "state"), proj: path.join(ROOT, "a", "proj"), logs: path.join(ROOT, "a", "logs") });
	setupAgentDir(isoA, port);
	const statusA = path.join(ROOT, "status-a.json");
	const optsA = { npmIndex: path.join(NPM_PKG, "dist", "index.js"), socket: isoA.socket, mode: "service", name: "sbp-svc-a", statusFile: statusA, spawnDaemon: true, daemonCmd: daemonCmd(isoA), config: { cwd: WORK(), provider: "fake", model: "fake-a" } };
	const unitA = startUnit("client-a", isolatedEnv({}, isoA), [NODE_BIN, path.join(ROOT, "client.mjs"), JSON.stringify(optsA)], ["KillMode=control-group"]);
	const a1 = await waitFor(() => fs.existsSync(statusA) && JSON.parse(fs.readFileSync(statusA, "utf8")), 180000, "client-a status");
	const pidsBefore = unitPids(unitA);
	fs.rmSync(statusA);
	systemctl("restart", unitA);
	const a2 = await waitFor(() => fs.existsSync(statusA) && JSON.parse(fs.readFileSync(statusA, "utf8")), 180000, "client-a status after restart");
	const detailA = { first: a1, afterRestart: a2, pidsInUnitBefore: pidsBefore.length, oldDaemonAlive: pidAlive(a1.daemonPid), oldWorkerAlive: pidAlive(a1.workerPid), sameSession: a1.activeSessionId === a2.activeSessionId };
	note("systemd-shared-cgroup", detailA);
	check("systemd-shared-cgroup-kills-workers", !detailA.oldDaemonAlive && !detailA.oldWorkerAlive && !detailA.sameSession, "when the client spawns the daemon inside its own unit, restarting that unit kills the daemon and every resident worker (the layout to avoid)", JSON.stringify(detailA));
	stopUnit(unitA);
}

function readSs(kind) {
	const r = spawnSync("ss", [kind, "-p", "-n", "-a"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
	return r.stdout ?? "";
}
async function groupIsolation() {
	const pids = [...startedUnits].flatMap((u) => unitPids(u));
	const problems = [];
	const seen = [];
	for (const pid of pids) {
		const env = procEnv(pid);
		const cmd = procCmd(pid);
		if (!env || !cmd) continue;
		seen.push(`${pid}:${path.basename(cmd[0])}`);
		if (!isInside(env.HOME ?? "", ROOT)) problems.push(`${pid} HOME=${env.HOME}`);
		if (env.TMPDIR && !isInside(env.TMPDIR, ROOT)) problems.push(`${pid} TMPDIR=${env.TMPDIR}`);
		if (env.PRIME_AGENT_CODING_AGENT_DIR && !isInside(env.PRIME_AGENT_CODING_AGENT_DIR, ROOT)) problems.push(`${pid} agent dir ${env.PRIME_AGENT_CODING_AGENT_DIR}`);
		for (const [k, v] of Object.entries(env)) {
			if (v.includes(`/tmp/prime-agent-${UID}`) || v.includes(path.join(REAL_HOME, ".prime"))) problems.push(`${pid} ${k}=${v}`);
			if (/^(PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET|PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN)$/.test(k) && !v.startsWith(ROOT) && !/^[A-Za-z0-9_-]+$/.test(v)) problems.push(`${pid} ${k}=${v}`);
		}
	}
	const pidSet = new Set(pids);
	const unixPaths = [];
	for (const line of readSs("-x").split("\n")) {
		const m = [...line.matchAll(/pid=(\d+)/g)].map((x) => Number(x[1]));
		if (!m.some((p) => pidSet.has(p))) continue;
		for (const tok of line.split(/\s+/)) if (tok.startsWith("/")) unixPaths.push(tok);
	}
	const foreignUnix = unixPaths.filter((p) => !isInside(p, ROOT));
	const tcp = [];
	for (const line of readSs("-t").split("\n")) {
		const m = [...line.matchAll(/pid=(\d+)/g)].map((x) => Number(x[1]));
		if (m.some((p) => pidSet.has(p))) tcp.push(line.trim().split(/\s+/).slice(0, 5).join(" "));
	}
	const port = fakeServer.address().port;
	const foreignTcp = tcp.filter((l) => !l.includes(`127.0.0.1:${port}`));
	note("isolation-processes", seen);
	note("isolation-unix-sockets", [...new Set(unixPaths)]);
	note("isolation-tcp", tcp);
	check("isolated-env", pids.length > 0 && problems.length === 0, `${pids.length} probe-started processes: HOME/TMPDIR/agent dir inside ${ROOT}; no live socket or ~/.prime in any env`, problems.join("; "));
	check("isolated-sockets", foreignUnix.length === 0, `every named Unix socket of the probe's processes is inside ${ROOT}`, foreignUnix.join(", "));
	check("isolated-network", foreignTcp.length === 0, "TCP only to the fake model on 127.0.0.1", foreignTcp.join(" | "));
	const nonAgent = fake.requests.filter((r) => !r.isAgent).length;
	note("fake-model-requests", { total: fake.requests.length, agent: fake.requests.length - nonAgent, other: nonAgent });
}

const GROUPS = [
	["create", groupCreate],
	["turns", groupTurns],
	["compaction", groupCompaction],
	["reattach", groupReattach],
	["survive", groupSurvive],
	["reopen", groupReopenKill],
	["trust", groupTrust],
	["skill", groupSkill],
	["systemd", groupSystemd],
];

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
let fakeServer, probeServer, daemonUnit;
async function cleanup() {
	for (const unit of [...startedUnits]) {
		try {
			stopUnit(unit);
		} catch (e) {
			console.error(`cleanup: ${e.message}`);
		}
	}
	for (const pid of childPids) {
		const cmd = procCmd(pid);
		if (cmd && cmd.some((a) => a.includes(ROOT))) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
		}
	}
	fakeServer?.close();
	probeServer?.close();
}
async function main() {
	fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
	fs.mkdirSync(WORK(), { recursive: true });
	fakeServer = await startFakeModel();
	setupAgentDir(ISO, fakeServer.address().port);
	note("isolated-root", ROOT);
	note("uv-python", copyUvPython(ISO));
	probeServer = await startProbeSocket();
	await loadPrimeAgent();
	const clientVersion = JSON.parse(fs.readFileSync(path.join(NPM_PKG, "package.json"), "utf8")).version;
	const clientSchema = DC.DAEMON_PROTOCOL_INFO ? undefined : undefined;
	daemonUnit = startUnit("daemon", isolatedEnv(), daemonCmd(ISO), ["KillMode=control-group"]);
	const hello = await socketReady(ISO.socket);
	note("version-skew", {
		daemonBinary: PRIME_BIN,
		daemon: { appVersion: hello.appVersion, protocol: hello.protocol?.version, schemaId: hello.schemaId },
		client: { package: NPM_PKG, version: clientVersion, protocol: DC.DAEMON_PROTOCOL_VERSION },
		serverCapabilities: hello.serverCapabilities,
	});
	check("isolated-daemon-started", hello.protocol?.version === DC.DAEMON_PROTOCOL_VERSION, `daemon ${hello.appVersion} pid ${hello.supervisorPid} in unit ${daemonUnit}; protocol ${hello.protocol?.version} = client protocol ${DC.DAEMON_PROTOCOL_VERSION}`);
	const c = await new Conn(ISO.socket).open();
	for (const [name, fn] of GROUPS) {
		if (ONLY && !ONLY.has(name)) continue;
		try {
			await fn(c);
		} catch (e) {
			fail(`group-${name}`, e.stack ?? e);
		}
	}
	await groupIsolation();
	c.close();
}
main()
	.catch((e) => {
		fail("probe-run", e.stack ?? e);
	})
	.finally(async () => {
		await cleanup();
		const remaining = [...startedUnits].filter((u) => systemctl("is-active", u).out.trim() === "active");
		check("cleanup-units-stopped", remaining.length === 0, `stopped ${startedUnits.size} transient units`, remaining.join(", "));
		try {
			fs.writeFileSync(path.join(ROOT, "report.json"), JSON.stringify({ results, info, turns: turnLog, fakeRequests: fake.requests.map((r) => ({ ...r, system: r.system.length })) }, null, 2));
		} catch {}
		if (!KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
		const failed = results.filter((r) => !r.ok);
		console.log(`SUMMARY ${results.length - failed.length}/${results.length} checks passed`);
		process.exit(failed.length === 0 && results.length > 0 ? 0 : 1);
	});

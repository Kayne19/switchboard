import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type DaemonEvent, DaemonCommandError, DaemonProtocolError, PrimeDaemonPort } from "../src/daemon_port.ts";
import { HostLink } from "../src/link.ts";
import { SessionManager } from "../src/sessions.ts";
import { command, FakeService, type Message } from "./fake_service.ts";

// A stand-in for the installed prime-agent package: dist/index.js exports a
// DaemonClient that records what the adapter does. No real prime-agent runs.
const FAKE_INDEX = `
const g = globalThis.__sbFakePrime;
export class DaemonClient {
  constructor(socketPath) { this.socketPath = socketPath; this.listeners = []; g.log.push(["new", socketPath]); g.client = this; }
  get hello() { return g.hello; }
  get isConnected() { return !g.socketDestroyed; }
  async connect() { g.log.push(["connect"]); if (g.connectError) throw new Error(g.connectError); }
  async waitForHello() { if (g.helloError) throw new Error(g.helloError); return g.hello; }
  onMessage(l) { this.listeners.push(l); return () => {}; }
  onClose(l) { this.closeListener = l; return () => {}; }
  async request(command, timeoutMs, options) {
    if (g.socketDestroyed) throw new Error("Cannot send daemon command " + command.type + " because the Prime Agent daemon is not connected.");
    g.log.push(["request", command, timeoutMs, options?.recoverable]);
    if (g.unsupported.includes(command.type)) { const e = new Error("capability unavailable: " + command.type); e.name = "DaemonCapabilityUnavailableError"; throw e; }
    return g.respond(command);
  }
  close() { g.log.push(["close"]); }
}
export function isUnknownDaemonCommandError(error, command) { return /unknown command/.test(String(error.message)); }
export function ensureDaemonRunning() { g.log.push(["LAUNCH HELPER CALLED"]); throw new Error("must not be called"); }
export const AuthStorage = { create() { return {}; } };
export const ModelRegistry = { create() { return { getAvailable() { return [{ provider: "anthropic", id: "claude-x", name: "Claude X", reasoning: true }]; } }; } };
`;

interface FakeGlobals {
	log: unknown[][];
	hello: { protocol: { version: number }; appVersion: string };
	unsupported: string[];
	connectError?: string;
	helloError?: string;
	socketDestroyed?: boolean;
	respond: (command: Record<string, unknown>) => { success: boolean; data?: unknown; error?: string };
	client?: { listeners: ((m: unknown) => void)[]; closeListener?: (error: Error) => void };
}

function fakePackage(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "sb-prime-pkg-"));
	mkdirSync(path.join(dir, "dist"));
	writeFileSync(path.join(dir, "dist", "index.js"), FAKE_INDEX);
	writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "prime-agent", version: "0.9.5", type: "module" }));
	return dir;
}

function globals(version: number, appVersion: string): FakeGlobals {
	const g: FakeGlobals = {
		log: [],
		hello: { protocol: { version }, appVersion },
		unsupported: [],
		respond: (command) => {
			if (command.type === "create") return { success: true, data: { activeSessionId: "a1", sessionId: "s1", sessionName: command.name, cwd: "/w", isStreaming: false, isCompacting: false, thinkingLevel: "high", rlmDepth: 0 } };
			if (command.type === "resume_queue") return { success: false, error: "No queued work to resume" };
			if (command.type === "compact") return { success: false, error: "unknown command: compact" };
			return { success: true, data: {} };
		},
	};
	(globalThis as unknown as { __sbFakePrime: FakeGlobals }).__sbFakePrime = g;
	return g;
}

test("adapter gates on the daemon protocol, not appVersion, and never calls a launch helper", async () => {
	const pkg = fakePackage();
	const g = globals(7, "99.0.0-newer-than-client");
	const port = new PrimeDaemonPort("/nonexistent/daemon.sock", pkg);
	const info = await port.connect();
	assert.deepEqual(info, { protocolVersion: 7, daemonVersion: "99.0.0-newer-than-client", clientVersion: "0.9.5" });
	assert.deepEqual(g.log.slice(0, 2), [["new", "/nonexistent/daemon.sock"], ["connect"]]);

	const created = await port.create({ lifecycle: "resident", name: "sb-homelab-1", config: { cwd: "/w" } });
	assert.equal(created.handle, "a1");
	assert.equal(created.name, "sb-homelab-1");
	const create = g.log.find((e) => e[0] === "request" && (e[1] as { type: string }).type === "create") as unknown[];
	assert.deepEqual(create[1], { type: "create", lifecycle: "resident", name: "sb-homelab-1", config: { cwd: "/w" } });
	assert.equal(create[3], false, "requests opt out of reconnect parking");

	g.unsupported.push("set_thinking_level");
	await assert.rejects(port.setThinking("a1", "low"), (e: unknown) => e instanceof DaemonCommandError && e.unsupported);
	await port.setModel("a1", "p", "m"); // the other commands keep working
	await assert.rejects(port.resumeQueue("a1"), (e: unknown) => e instanceof DaemonCommandError && !e.unsupported);

	const events: DaemonEvent[] = [];
	port.onEvent((e) => events.push(e));
	for (const l of g.client?.listeners ?? []) l({ type: "session_event", activeSessionId: "a1", event: { type: "agent_start" } });
	assert.deepEqual(events, [{ handle: "a1", event: { type: "agent_start" } }]);
	assert.deepEqual(await port.listModels(), [{ provider: "anthropic", id: "claude-x", name: "Claude X", reasoning: true }]);
	assert.ok(!g.log.some((e) => e[0] === "LAUNCH HELPER CALLED"));
	port.close();
});

test("adapter refuses a daemon speaking another protocol", async () => {
	const pkg = fakePackage();
	const g = globals(6, "0.9.5");
	const port = new PrimeDaemonPort("/nonexistent/daemon.sock", pkg);
	await assert.rejects(port.connect(), (e: unknown) => e instanceof DaemonProtocolError && e.version === 6);
	assert.deepEqual(g.log.at(-1), ["close"]);
});

test("adapter closes the client when the dial or the hello fails, so a retry leaves no socket open", async () => {
	for (const failure of ["connectError", "helloError"] as const) {
		const pkg = fakePackage();
		const g = globals(7, "0.9.5");
		g[failure] = "timed out after 5000ms";
		const port = new PrimeDaemonPort("/nonexistent/daemon.sock", pkg);
		await assert.rejects(port.connect(), /timed out after 5000ms/);
		assert.deepEqual(g.log.at(-1), ["close"], `${failure}: the client is closed`);
	}
});

function sent(g: FakeGlobals, type: string): boolean {
	return g.log.some((e) => e[0] === "request" && (e[1] as { type: string }).type === type);
}

async function withHostAgent(run: (errorCode: (name: string, args?: Message) => Promise<string | undefined>, port: PrimeDaemonPort) => Promise<void>): Promise<void> {
	const port = new PrimeDaemonPort("/nonexistent/daemon.sock", fakePackage());
	await port.connect();
	const manager = new SessionManager({ port, stateFile: path.join(mkdtempSync(path.join(os.tmpdir(), "sb-host-")), "sessions.json"), emit: () => {} });
	await manager.createSession("homelab", { cwd: "/w" });
	const service = await FakeService.start();
	const link = new HostLink({
		url: service.url,
		hostId: "scriptorium",
		token: "test-host-token-not-a-secret",
		gitSha: "abc123",
		versions: () => ({ prime_agent_client: "0.9.5", prime_agent_daemon: "0.9.6", daemon_protocol: 7 }),
		command: (name, args) => manager.handle(name, args),
		sessions: () => [],
		describe: async (handle) => ({ session: handle }),
		heartbeatMs: 20,
		backoffInitialMs: 10,
		backoffMaxMs: 40,
	});
	try {
		link.start();
		const l = await service.link(0);
		await l.next((m) => m.type === "synced");
		let id = 0;
		await run(async (name, args = {}) => ((await command(l, 1, `c${id++}`, name, { session: "a1", ...args })).error as Message | undefined)?.code as string | undefined, port);
	} finally {
		link.stop();
		await service.close();
		port.close();
	}
}

test("a command the host agent could not send is answered daemon_error, as a refusal is: nothing changed on the daemon", async () => {
	const g = globals(7, "0.9.5");
	const answer = g.respond;
	g.respond = (command) => (command.type === "set_thinking_level" ? { success: false, error: "thinking level not supported" } : answer(command));
	await withHostAgent(async (errorCode, port) => {
		assert.equal(await errorCode("set_thinking", { level: "low" }), "daemon_error", "the daemon refused it");
		g.socketDestroyed = true;
		assert.equal(await errorCode("prompt", { message: "hi" }), "daemon_error", "the socket closed before its close event cleared the client");
		port.close();
		assert.equal(await errorCode("set_model", { provider: "p", model: "m" }), "daemon_error", "the host agent has no daemon connection");
		assert.ok(!sent(g, "prompt") && !sent(g, "set_model"), "neither command reached the daemon");
	});
});

test("a command sent to the daemon that gets no answer is answered daemon_unreachable: the daemon may have run it", async () => {
	const g = globals(7, "0.9.5");
	const answer = g.respond;
	g.respond = (command) => {
		if (command.type === "prompt") throw new Error("Connection to the Prime Agent daemon closed.");
		if (command.type === "set_model") throw new Error("Timed out after 60000ms waiting for the Prime Agent daemon response.");
		return answer(command);
	};
	await withHostAgent(async (errorCode) => {
		assert.equal(await errorCode("prompt", { message: "hi" }), "daemon_unreachable", "the connection closed before the answer");
		assert.equal(await errorCode("set_model", { provider: "p", model: "m" }), "daemon_unreachable", "the request timed out");
		assert.ok(sent(g, "prompt") && sent(g, "set_model"), "both commands reached the daemon");
	});
});

test("a command whose follow-up fails after the daemon applied its change is answered daemon_unreachable: its state is unknown", async () => {
	const changes = [
		["set_model", { provider: "p", model: "m" }, "set_model", "get_state"],
		["set_thinking", { level: "low" }, "set_thinking_level", "get_state"],
		["create_session", { project: "homelab", config: { cwd: "/w" } }, "create", "attach"],
		["open_session", { session_id: "s2", cwd: "/w", project: "homelab" }, "create", "attach"],
	] as const;
	for (const [name, args, change, followUp] of changes) {
		for (const failure of ["refused", "lost", "not sent"] as const) {
			const g = globals(7, "0.9.5");
			const answer = g.respond;
			let armed = false;
			g.respond = (command) => {
				if (armed && command.type === change && failure === "not sent") g.client?.closeListener?.(new Error("daemon closed"));
				if (armed && command.type === followUp && failure === "refused") return { success: false, error: "no such session" };
				if (armed && command.type === followUp && failure === "lost") throw new Error("Connection to the Prime Agent daemon closed.");
				if (command.sessionPath) return { success: true, data: { activeSessionId: "a2", sessionId: "s2", sessionName: "sb-homelab-old", cwd: "/w" } };
				return answer(command);
			};
			await withHostAgent(async (errorCode) => {
				g.log.length = 0;
				armed = true;
				assert.equal(await errorCode(name, args), "daemon_unreachable", `${name}, ${followUp} ${failure}`);
				assert.ok(sent(g, change), `${name}: the change reached the daemon`);
				assert.equal(sent(g, followUp), failure !== "not sent", `${name}, ${followUp} ${failure}: ${followUp} sent`);
			});
		}
	}
});

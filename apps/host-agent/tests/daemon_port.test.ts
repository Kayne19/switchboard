import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type DaemonEvent, DaemonCommandError, DaemonProtocolError, PrimeDaemonPort } from "../src/daemon_port.ts";

// A stand-in for the installed prime-agent package: dist/index.js exports a
// DaemonClient that records what the adapter does. No real prime-agent runs.
const FAKE_INDEX = `
const g = globalThis.__sbFakePrime;
export class DaemonClient {
  constructor(socketPath) { this.socketPath = socketPath; this.listeners = []; g.log.push(["new", socketPath]); g.client = this; }
  get hello() { return g.hello; }
  async connect() { g.log.push(["connect"]); }
  async waitForHello() { return g.hello; }
  onMessage(l) { this.listeners.push(l); return () => {}; }
  onClose(l) { this.closeListener = l; return () => {}; }
  async request(command, timeoutMs, options) {
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
	respond: (command: Record<string, unknown>) => { success: boolean; data?: unknown; error?: string };
	client?: { listeners: ((m: unknown) => void)[] };
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

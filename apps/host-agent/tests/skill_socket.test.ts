import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ModuleReply } from "../src/link.ts";
import type { CallState } from "../src/sessions.ts";
import { SessionManager } from "../src/sessions.ts";
import { MAX_LINE_BYTES, SkillSocket } from "../src/skill_socket.ts";
import { FakeDaemon } from "./fake_daemon.ts";

interface Relayed {
	handle: string;
	token: string;
	call: string;
	args: Record<string, unknown>;
	timeoutMs: number;
}

async function withSocket(fn: (ctx: { ask: (m: unknown) => Promise<Record<string, unknown>>; manager: SessionManager; handle: string; sessionId: string; relayed: Relayed[]; socketPath: string; setReply: (r: ModuleReply | Error) => void }) => Promise<void>) {
	const home = mkdtempSync(path.join(os.tmpdir(), "sb-sk-"));
	const socketPath = path.join(home, ".cache", "switchboard", "host-agent.sock");
	const daemon = new FakeDaemon();
	const manager = new SessionManager({ port: daemon, stateFile: path.join(home, "state.json"), emit: () => {} });
	const info = (await manager.createSession("homelab", { cwd: "/srv/homelab" })) as { session: string; session_id: string };
	const relayed: Relayed[] = [];
	let reply: ModuleReply | Error = { status: "delivered", reason: null };
	const socket = new SkillSocket({
		socketPath,
		lookup: (id) => manager.bySessionId(id),
		relay: async (handle, token, call, args, timeoutMs) => {
			relayed.push({ handle, token, call, args, timeoutMs });
			if (reply instanceof Error) throw reply;
			return reply;
		},
		relayTimeoutMs: 1234,
	});
	await socket.listen();
	const conn = net.createConnection(socketPath);
	await new Promise<void>((r) => conn.once("connect", () => r()));
	let buffered = "";
	const waiting: ((line: string) => void)[] = [];
	conn.on("data", (d) => {
		buffered += String(d);
		let at = buffered.indexOf("\n");
		while (at >= 0) {
			const line = buffered.slice(0, at);
			buffered = buffered.slice(at + 1);
			waiting.shift()?.(line);
			at = buffered.indexOf("\n");
		}
	});
	const ask = (m: unknown) =>
		new Promise<Record<string, unknown>>((resolve) => {
			waiting.push((line) => resolve(JSON.parse(line)));
			conn.write(`${typeof m === "string" ? m : JSON.stringify(m)}\n`);
		});
	try {
		await fn({ ask, manager, handle: info.session, sessionId: info.session_id, relayed, socketPath, setReply: (r) => (reply = r) });
	} finally {
		conn.destroy();
		await socket.close();
	}
}

const CALL = { token: "call-token-1", persona: "Jev", speech_deadline_ms: 25000 };

test("socket permissions: directory 0700, socket 0600", async () => {
	await withSocket(async ({ socketPath }) => {
		assert.equal(statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
		assert.equal(statSync(socketPath).mode & 0o777, 0o600);
	});
});

test("hello: not on call, then settings once the service puts the session on a call", async () => {
	await withSocket(async ({ ask, manager, handle, sessionId }) => {
		assert.deepEqual(await ask({ op: "hello", session_id: sessionId, depth: 0 }), { on_call: false });
		assert.deepEqual(await ask({ op: "hello", session_id: "unknown-session", depth: 0 }), { on_call: false });
		await manager.handle("join_call", { session: handle, ...CALL, mode: "foreground" });
		assert.deepEqual(await ask({ op: "hello", session_id: sessionId, depth: 0 }), { on_call: true, token: "call-token-1", persona: "Jev", speech_deadline_ms: 25000 });
		await manager.handle("leave_call", { session: handle });
		assert.deepEqual(await ask({ op: "hello", session_id: sessionId, depth: 0 }), { on_call: false });
	});
});

test("host-link loss unregisters the session from the skill socket", async () => {
	await withSocket(async ({ ask, manager, handle, sessionId }) => {
		await manager.handle("join_call", { session: handle, ...CALL });
		assert.equal((await ask({ op: "hello", session_id: sessionId, depth: 0 })).on_call, true);
		manager.clearCalls();
		assert.deepEqual(await ask({ op: "hello", session_id: sessionId, depth: 0 }), { on_call: false });
		assert.deepEqual(await ask({ op: "call", session_id: sessionId, depth: 0, token: CALL.token, call: "speak", args: { text: "stale" } }), { status: "refused", reason: "not_on_call" });
	});
});

test("depth above 0 is refused for hello and calls", async () => {
	await withSocket(async ({ ask, manager, handle, sessionId, relayed }) => {
		await manager.handle("join_call", { session: handle, ...CALL });
		assert.deepEqual(await ask({ op: "hello", session_id: sessionId, depth: 1 }), { on_call: false, reason: "subagent" });
		assert.deepEqual(await ask({ op: "call", session_id: sessionId, depth: 1, token: CALL.token, call: "speak", args: { text: "x" } }), { status: "refused", reason: "subagent" });
		assert.equal(relayed.length, 0);
	});
});

test("calls: token check, then delivery decided from session state", async () => {
	await withSocket(async ({ ask, manager, handle, sessionId, relayed, setReply }) => {
		const call = (name: string, args: Record<string, unknown> = {}, token = CALL.token) => ask({ op: "call", session_id: sessionId, depth: 0, token, call: name, args });
		assert.deepEqual(await call("speak", { text: "hi" }), { status: "refused", reason: "not_on_call" });
		await manager.handle("join_call", { session: handle, ...CALL, mode: "foreground" });
		assert.deepEqual(await call("speak", { text: "hi" }, "stale-token"), { status: "refused", reason: "not_on_call" });
		assert.deepEqual(await call("speak", { text: "hi" }), { status: "delivered", reason: null });
		assert.deepEqual(relayed.at(-1), { handle, token: CALL.token, call: "speak", args: { text: "hi" }, timeoutMs: 25000 });
		assert.deepEqual(await call("request_to_speak", { message: "done", reason: "finished" }), { status: "refused", reason: "caller_listening" });
		assert.deepEqual(await call("display", { action: { op: "show" } }), { status: "delivered", reason: null });
		assert.equal(relayed.at(-1)?.timeoutMs, 1234);
		assert.deepEqual(await call("return_to_operator", { summary: "bye" }), { status: "refused", reason: "unknown_call" });
		await manager.handle("set_mode", { session: handle, mode: "background" });
		const before = relayed.length;
		assert.deepEqual(await call("speak", { text: "hi" }), { status: "refused", reason: "caller_away" });
		assert.deepEqual(await call("transfer_to_project", { project: "x" }), { status: "refused", reason: "unknown_call" });
		assert.equal(relayed.length, before);
		setReply({ status: "accepted", reason: null });
		assert.deepEqual(await call("request_to_speak", { message: "done", reason: "finished" }), { status: "accepted", reason: null });
		setReply({ status: "delivered", reason: null, result: { visible: ["chart"] } });
		assert.deepEqual(await call("view", {}), { status: "delivered", reason: null, result: { visible: ["chart"] } });
		setReply(new Error("link down"));
		assert.deepEqual(await call("view", {}), { status: "failed", reason: "failed" });
		assert.deepEqual(await call("launch_missiles", {}), { status: "refused", reason: "unknown_call" });
		assert.deepEqual(await ask("not json"), { status: "refused", reason: "bad_request" });
		// Valid JSON that is not an object is refused the same way, and the
		// connection keeps answering afterwards: a `null` used to throw inside
		// the handler and leave every later line on the connection unanswered.
		assert.deepEqual(await ask("null"), { status: "refused", reason: "bad_request" });
		assert.deepEqual(await ask("[1]"), { status: "refused", reason: "bad_request" });
		assert.deepEqual(await ask({ op: "hello", session_id: sessionId, depth: 0 }), { on_call: true, ...CALL });
	});
});

test("join_call validates its arguments; set_mode needs a call", async () => {
	await withSocket(async ({ manager, handle }) => {
		await assert.rejects(manager.handle("set_mode", { session: handle, mode: "foreground" }), (e: Error & { code?: string }) => e.code === "refused");
		await assert.rejects(manager.handle("join_call", { session: handle, token: "t", speech_deadline_ms: 0 }), (e: Error & { code?: string }) => e.code === "bad_request");
		await assert.rejects(manager.handle("join_call", { session: handle, ...CALL, mode: "loud" }), (e: Error & { code?: string }) => e.code === "bad_request");
		const state: CallState | null = manager.bySessionId("nope")?.call ?? null;
		assert.equal(state, null);
	});
});

test("background mode refuses speak, but accepts request_to_speak and display", async () => {
	await withSocket(async ({ ask, manager, handle, sessionId, relayed }) => {
		const call = (name: string, args: Record<string, unknown> = {}) => ask({ op: "call", session_id: sessionId, depth: 0, token: CALL.token, call: name, args });
		await manager.handle("join_call", { session: handle, ...CALL, mode: "background" });
		assert.deepEqual(await call("speak", { text: "away" }), { status: "refused", reason: "caller_away" });
		assert.deepEqual(await call("request_to_speak", { message: "finished", reason: "finished" }), { status: "delivered", reason: null });
		assert.deepEqual(await call("display", { action: { op: "show", id: "chart", type: "chart", data: { series: [] } } }), { status: "delivered", reason: null });
		assert.equal(relayed.length, 2, "speak is refused locally while request and display are relayed");
	});
});

test("a 12 MiB image display line is relayed whole; a line over the cap is refused and ends the connection", async () => {
	await withSocket(async ({ ask, manager, handle, sessionId, relayed, socketPath }) => {
		await manager.handle("join_call", { session: handle, ...CALL, mode: "foreground" });
		// 12 MiB of base64: the largest image action the service accepts.
		const bytes = "A".repeat(12 * 1024 * 1024 - 256);
		const action = { op: "show", id: "fig", type: "image", data: { format: "png", bytes, alt: "a" } };
		assert.deepEqual(await ask({ op: "call", session_id: sessionId, depth: 0, token: CALL.token, call: "display", args: { action } }), { status: "delivered", reason: null });
		assert.equal((relayed.at(-1)?.args.action as typeof action).data.bytes.length, bytes.length);

		// The relay wraps the args in a frame of its own; the cap leaves room
		// for that under the host link's 16 MiB frame limit.
		assert.ok(MAX_LINE_BYTES + 1024 * 1024 <= 16 * 1024 * 1024);
		const before = relayed.length;
		const long = net.createConnection(socketPath);
		let answer = "";
		long.on("data", (chunk) => {
			answer += String(chunk);
		});
		const closed = new Promise<void>((resolve) => long.once("close", () => resolve()));
		long.on("error", () => {});
		long.write(`${JSON.stringify({ op: "call", session_id: sessionId, depth: 0, token: CALL.token, call: "display", args: { pad: "A".repeat(MAX_LINE_BYTES) } })}\n`);
		// A request after it on the same connection is not answered.
		long.write(`${JSON.stringify({ op: "hello", session_id: sessionId, depth: 0 })}\n`);
		await closed;
		// It used to close without a word, and the module could only report
		// that the host agent hung up.
		assert.equal(answer, '{"status":"refused","reason":"too_large"}\n');
		assert.equal(relayed.length, before, "an over-long line is never relayed");
	});
});

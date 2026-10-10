import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ModuleReply } from "../src/link.ts";
import type { CallState } from "../src/sessions.ts";
import { SessionManager } from "../src/sessions.ts";
import { HostLink } from "../src/link.ts";
import { MAX_LINE_BYTES, MAX_WAITING_REQUESTS, SkillSocket, SPEAK_REPLY_MARGIN_MS } from "../src/skill_socket.ts";
import { FakeDaemon } from "./fake_daemon.ts";
import { FakeService } from "./fake_service.ts";

interface Relayed {
	handle: string;
	token: string;
	call: string;
	args: Record<string, unknown>;
	timeoutMs: number;
}

async function withSocket(fn: (ctx: { ask: (m: unknown) => Promise<Record<string, unknown>>; connect: () => Promise<net.Socket>; hold: () => () => void; manager: SessionManager; handle: string; sessionId: string; relayed: Relayed[]; socketPath: string; setReply: (r: ModuleReply | Error) => void }) => Promise<void>) {
	const home = mkdtempSync(path.join(os.tmpdir(), "sb-sk-"));
	const socketPath = path.join(home, ".cache", "switchboard", "host-agent.sock");
	const daemon = new FakeDaemon();
	const manager = new SessionManager({ port: daemon, stateFile: path.join(home, "state.json"), emit: () => {} });
	const info = (await manager.createSession("homelab", { cwd: "/srv/homelab" })) as { session: string; session_id: string };
	const relayed: Relayed[] = [];
	let reply: ModuleReply | Error = { status: "delivered", reason: null };
	// While held, a relayed call waits, as one waits on the service.
	let held: Promise<void> | null = null;
	const hold = () => {
		let release = () => {};
		held = new Promise<void>((resolve) => (release = resolve));
		return () => {
			held = null;
			release();
		};
	};
	const socket = new SkillSocket({
		socketPath,
		lookup: (id) => manager.bySessionId(id),
		relay: async (handle, token, call, args, timeoutMs) => {
			relayed.push({ handle, token, call, args, timeoutMs });
			if (held) await held;
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
	// Another connection, closed with the rest: the socket's close waits for
	// every connection, so one a failed test left open would hang the run.
	const others: net.Socket[] = [];
	const connect = async () => {
		const other = net.createConnection(socketPath);
		others.push(other);
		other.on("error", () => {});
		await new Promise<void>((resolve) => other.once("connect", () => resolve()));
		return other;
	};
	try {
		await fn({ ask, connect, hold, manager, handle: info.session, sessionId: info.session_id, relayed, socketPath, setReply: (r) => (reply = r) });
	} finally {
		conn.destroy();
		for (const other of others) other.destroy();
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
		assert.deepEqual(relayed.at(-1), { handle, token: CALL.token, call: "speak", args: { text: "hi" }, timeoutMs: 25000 + SPEAK_REPLY_MARGIN_MS });
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

test("a 12 MiB image display line is relayed whole; a line over the cap is refused and ends the connection", { timeout: 30_000 }, async () => {
	await withSocket(async ({ ask, connect, manager, handle, sessionId, relayed }) => {
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
		const long = await connect();
		let answer = "";
		long.on("data", (chunk) => {
			answer += String(chunk);
		});
		const closed = new Promise<void>((resolve) => long.once("close", () => resolve()));
		long.write(`${JSON.stringify({ op: "call", session_id: sessionId, depth: 0, token: CALL.token, call: "display", args: { pad: "A".repeat(MAX_LINE_BYTES) } })}\n`);
		// A request after it on the same connection is not answered.
		long.write(`${JSON.stringify({ op: "hello", session_id: sessionId, depth: 0 })}\n`);
		await within(10_000, closed, "the connection closed after the refused line");
		// It used to close without a word, and the module could only report
		// that the host agent hung up.
		assert.equal(answer, '{"status":"refused","reason":"too_large"}\n');
		assert.equal(relayed.length, before, "an over-long line is never relayed");
	});
});

/** `promise`, or a failure naming `what` once `ms` pass without it. */
async function within<T>(ms: number, promise: Promise<T>, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`no ${what} within ${ms} ms`)), ms);
	});
	try {
		return await Promise.race([promise, late]);
	} finally {
		clearTimeout(timer);
	}
}

/** Everything `conn` sends, as it arrives, and a promise for its first line. */
function listen(conn: net.Socket): { text: () => string; firstLine: Promise<void>; closed: Promise<void> } {
	let text = "";
	const firstLine = new Promise<void>((resolve) => {
		conn.on("data", (chunk) => {
			text += String(chunk);
			if (text.includes("\n")) resolve();
		});
	});
	const closed = new Promise<void>((resolve) => conn.once("close", () => resolve()));
	return { text: () => text, firstLine, closed };
}

/**
 * Writes `bytes` bytes of "A" to `conn` a mebibyte at a time, waiting for
 * each to drain, and returns how far this process's resident memory rose
 * meanwhile. The socket under test is served in this process, so a line it
 * held would show here; the block written is one buffer, used again.
 */
async function writeAs(conn: net.Socket, bytes: number): Promise<number> {
	const block = Buffer.alloc(1024 * 1024, "A");
	const start = process.memoryUsage().rss;
	let peak = start;
	for (let left = bytes; left > 0; left -= block.length) {
		const part = left < block.length ? block.subarray(0, left) : block;
		if (!conn.write(part)) await new Promise<void>((resolve) => conn.once("drain", () => resolve()));
		peak = Math.max(peak, process.memoryUsage().rss);
	}
	return peak - start;
}

const TOO_LARGE_LINE = '{"status":"refused","reason":"too_large"}\n';

test("a line is refused once it passes the cap, before its newline, and the rest of it is dropped as it arrives", { timeout: 30_000 }, async () => {
	await withSocket(async ({ ask, connect, sessionId, relayed }) => {
		const long = await connect();
		const heard = listen(long);
		// One byte past the cap, and no newline. The line used to be held until
		// its newline came, however long it grew.
		long.write("A".repeat(MAX_LINE_BYTES + 1));
		await within(5000, heard.firstLine, "answer to a line past the cap, before its newline");
		assert.equal(heard.text(), TOO_LARGE_LINE);
		// The rest of the line is still read, and dropped: the module writes a
		// line whole before it reads the answer, so it is not cut off mid-line.
		const more = await new Promise<Error | null | undefined>((resolve) => long.write("A".repeat(4 * 1024 * 1024), resolve));
		assert.equal(more ?? null, null, "the connection stays open to the end of the refused line");
		// The connection ends where the line does.
		long.write("\n");
		await within(5000, heard.closed, "close at the end of the refused line");
		assert.equal(heard.text(), TOO_LARGE_LINE, "one answer, and nothing after it");
		assert.equal(relayed.length, 0, "an over-long line is never relayed");
		assert.deepEqual(await ask({ op: "hello", session_id: sessionId, depth: 0 }), { on_call: false });
	});
});

test("a 64 MiB and a 600 MiB line are each refused at the cap and dropped, and the host agent keeps serving", { timeout: 120_000 }, async () => {
	await withSocket(async ({ ask, connect, sessionId, relayed }) => {
		for (const mebibytes of [64, 600]) {
			const long = await connect();
			const heard = listen(long);
			// Past V8's longest string (about 512 MiB), the old reader threw
			// RangeError: Invalid string length and ended the process. The
			// answer comes at the cap, long before the line is written out.
			const writing = writeAs(long, mebibytes * 1024 * 1024);
			await within(10_000, heard.firstLine, `answer to a ${mebibytes} MiB line, before its newline`);
			const rose = await within(60_000, writing, `room for the rest of a ${mebibytes} MiB line`);
			// The cap's 13 MiB and the reads in flight, not the line: about
			// 40 MiB on a 600 MiB line.
			assert.ok(rose < 256 * 1024 * 1024, `memory rose ${Math.round(rose / 1024 / 1024)} MiB over a ${mebibytes} MiB line`);
			long.write("\n");
			await within(5000, heard.closed, `close at the end of a ${mebibytes} MiB line`);
			assert.equal(heard.text(), TOO_LARGE_LINE);
		}
		assert.equal(relayed.length, 0, "an over-long line is never relayed");
		assert.deepEqual(await ask({ op: "hello", session_id: sessionId, depth: 0 }), { on_call: false });
	});
});

/** The answer lines `conn` has sent so far, parsed. */
const answers = (text: string) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

const QUEUE_FULL_ANSWER = { status: "refused", reason: "queue_full" };

test("a connection that writes requests without reading the answers is refused past the queue's bound", { timeout: 30_000 }, async () => {
	await withSocket(async ({ connect, hold, manager, handle, sessionId, relayed }) => {
		await manager.handle("join_call", { session: handle, ...CALL, mode: "foreground" });
		const release = hold();
		const conn = await connect();
		const heard = listen(conn);
		// A call that waits on the service, then more hellos behind it than
		// the queue holds, all written before any answer is read. They used
		// to be held, however many came, until the call ahead answered.
		const call = { op: "call", session_id: sessionId, depth: 0, token: CALL.token, call: "display", args: { action: { op: "clear" } } };
		const hello = { op: "hello", session_id: sessionId, depth: 0 };
		conn.write([call, ...Array.from({ length: MAX_WAITING_REQUESTS + 1 }, () => hello)].map((request) => `${JSON.stringify(request)}\n`).join(""));
		await within(5000, new Promise<void>((resolve) => {
			const wait = () => (relayed.length > 0 ? resolve() : setTimeout(wait, 5));
			wait();
		}), "relayed call");
		release();
		await within(5000, heard.closed, "close after the request past the bound");
		const onCall = { on_call: true, token: CALL.token, persona: CALL.persona, speech_deadline_ms: CALL.speech_deadline_ms };
		// In order: the call, the hellos that fit beside it, the refusal; the
		// hello after it is not read.
		assert.deepEqual(answers(heard.text()), [
			{ status: "delivered", reason: null },
			...Array.from({ length: MAX_WAITING_REQUESTS - 1 }, () => onCall),
			QUEUE_FULL_ANSWER,
		]);
	});
});

test("requests waiting on one connection hold at most one line's cap of text between them", { timeout: 30_000 }, async () => {
	await withSocket(async ({ ask, connect, hold, manager, handle, sessionId, relayed }) => {
		await manager.handle("join_call", { session: handle, ...CALL, mode: "foreground" });
		const release = hold();
		const conn = await connect();
		const heard = listen(conn);
		// Two lines each a little over half the cap: each is within it, but
		// the second, waiting behind the first, would hold more than one
		// line's cap between them.
		const half = Math.floor(MAX_LINE_BYTES / 2) + 1024;
		const line = (pad: string) => `${JSON.stringify({ op: "call", session_id: sessionId, depth: 0, token: CALL.token, call: "display", args: { pad } })}\n`;
		// Released only once the server has read both lines: the write's
		// callback comes when the kernel has taken the last byte, and a Unix
		// socket's buffer holds at most a few hundred KiB the server has not
		// read, which its next reads take. Released sooner, the first call
		// could be answered before the second line is whole, and then the two
		// never wait together.
		await new Promise<void>((resolve) => conn.write(line("A".repeat(half)) + line("B".repeat(half)), () => resolve()));
		for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(relayed.length, 1, "the first call is waiting on the service");
		release();
		await within(5000, heard.closed, "close after the request past the bound");
		assert.deepEqual(answers(heard.text()), [{ status: "delivered", reason: null }, QUEUE_FULL_ANSWER]);
		assert.equal(relayed.length, 1, "the refused request is never relayed");
		// One line that size at a time is answered, as the module sends it.
		const mod = await connect();
		const one = listen(mod);
		mod.write(line("C".repeat(half)));
		await within(5000, one.firstLine, "answer to one line");
		assert.deepEqual(answers(one.text()), [{ status: "delivered", reason: null }]);
		assert.deepEqual(await ask({ op: "hello", session_id: sessionId, depth: 0 }), { on_call: true, ...CALL });
	});
});

test("speak waits past the speech deadline for the service's answer: the service starts its deadline later", { timeout: 30_000 }, async () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "sb-sk-"));
	const socketPath = path.join(home, ".cache", "switchboard", "host-agent.sock");
	const daemon = new FakeDaemon();
	const manager = new SessionManager({ port: daemon, stateFile: path.join(home, "state.json"), emit: () => {} });
	const info = (await manager.createSession("homelab", { cwd: "/srv/homelab" })) as { session: string; session_id: string };
	await manager.handle("join_call", { session: info.session, token: "call-token-1", persona: "Jev", speech_deadline_ms: 200, mode: "foreground" });
	const service = await FakeService.start();
	const link = new HostLink({
		url: service.url,
		hostId: "h1",
		token: "t",
		gitSha: "sha",
		versions: () => ({ prime_agent_client: null, prime_agent_daemon: null, daemon_protocol: 7 }),
		command: (n, a) => manager.handle(n, a),
		sessions: () => [],
		describe: async (h) => ({ session: h }),
		heartbeatMs: 1000,
		backoffInitialMs: 10,
	});
	const socket = new SkillSocket({
		socketPath,
		lookup: (id) => manager.bySessionId(id),
		relay: (handle, token, call, args, timeoutMs, turnId, turnCause) => link.relayModuleCall(handle, token, call, args, timeoutMs, turnId, turnCause),
	});
	await socket.listen();
	const conn = net.createConnection(socketPath);
	try {
		await new Promise<void>((r) => conn.once("connect", () => r()));
		link.start();
		const l = await service.link(0);
		await l.next((m) => m.type === "synced");
		const answer = new Promise<Record<string, unknown>>((resolve) => {
			let buffered = "";
			conn.on("data", (d) => {
				buffered += String(d);
				if (buffered.includes("\n")) resolve(JSON.parse(buffered.slice(0, buffered.indexOf("\n"))));
			});
		});
		conn.write(`${JSON.stringify({ op: "call", session_id: info.session_id, depth: 0, token: "call-token-1", call: "speak", args: { text: "a long line" } })}\n`);
		const call = await l.next((m) => m.type === "module_call");
		// The service admits the call later than the host agent sent it, so
		// its own 200 ms deadline ends later too: its drain answers at 300 ms
		// on the host agent's clock, and that answer is the one that counts.
		await new Promise((r) => setTimeout(r, 300));
		l.send({ type: "module_reply", id: call.id, status: "delivered", reason: null });
		assert.deepEqual(await answer, { status: "delivered", reason: null });
	} finally {
		conn.destroy();
		link.stop();
		await socket.close();
		await service.close();
	}
});

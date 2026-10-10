import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { DaemonKeeper } from "../src/daemon_keeper.ts";
import { DaemonCommandError } from "../src/daemon_port.ts";
import { SessionManager } from "../src/sessions.ts";
import { FakeDaemon, flush } from "./fake_daemon.ts";

test("keeper: after a daemon drop, a session that will not attach is retried, and the rest are snapshotted at once", async () => {
	const daemon = new FakeDaemon();
	const stateFile = path.join(mkdtempSync(path.join(os.tmpdir(), "sb-keep-")), "sessions.json");
	const manager = new SessionManager({ port: daemon, stateFile, emit: () => {} });
	const snapshots: string[] = [];
	let snapshotted: (() => void) | null = null;
	const keeper = new DaemonKeeper({
		port: daemon,
		manager,
		onLive: async (handle) => {
			snapshots.push(handle);
			snapshotted?.();
		},
		backoffInitialMs: 5,
		log: () => {},
	});
	await keeper.start();
	const config = { cwd: "/srv/homelab" };
	const a = String((await manager.createSession("homelab", config)).session);
	const b = String((await manager.createSession("homelab", config)).session);
	snapshots.length = 0;
	const attach = daemon.attach.bind(daemon);
	let refusals = 2;
	daemon.attach = async (handle: string) => {
		if (handle === a && refusals > 0) {
			refusals--;
			throw new DaemonCommandError("attach", "timed out after 60000ms");
		}
		return attach(handle);
	};
	const reattached = new Promise<void>((resolve) => {
		snapshotted = () => {
			if (snapshots.includes(a)) resolve();
		};
	});
	daemon.dropConnection();
	await reattached;
	assert.equal(snapshots[0], b, "the session that attached is snapshotted on the first pass");
	assert.equal(refusals, 0, "the refused session was tried again until it attached");
	assert.equal(daemon.ops().filter((op) => op === "connect").length, 2, "one reconnect: a retry does not dial again while connected");
	assert.ok(snapshots.includes(a));
});

// -- the keeper's phase x event table -----------------------------------------
//
// The keeper is in one of four phases: disconnected (before start, or after
// the daemon closed), resyncing (connected, and the whole resync is owed: it
// has not run on this connection, or it threw), retrying (the resync left a
// session the daemon still lists unattached) and attached (nothing to do until
// the daemon closes). Each row puts a keeper in a phase, applies one event, and
// checks what the keeper asked the daemon, which sessions it snapshotted, and
// the phase it is in after: `attached` is a minute with no daemon traffic,
// `retry in N ms` is nothing for N - 1 ms and a pass at N.

/** A keeper over two sessions this host agent created, `a1` and `a2`, not started. */
async function rig(t: TestContext, backoffInitialMs = 10) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const daemon = new FakeDaemon();
	const stateFile = path.join(mkdtempSync(path.join(os.tmpdir(), "sb-keep-")), "sessions.json");
	const events: { handle: string; kind: string; reason?: unknown }[] = [];
	const manager = new SessionManager({ port: daemon, stateFile, emit: (handle, event) => events.push({ handle, kind: event.kind, reason: event.reason }) });
	const config = { cwd: "/srv/homelab" };
	await manager.createSession("homelab", config);
	await manager.createSession("homelab", config);
	const snapshots: string[] = [];
	const logs: string[] = [];
	const keeper = new DaemonKeeper({
		port: daemon,
		manager,
		onLive: async (handle) => {
			snapshots.push(handle);
		},
		backoffInitialMs,
		log: (message) => logs.push(message),
	});
	/** Attaches the daemon refuses, by handle; a refusal is `attach: timed out`. */
	const refuse = new Set<string>();
	const attach = daemon.attach.bind(daemon);
	let gate: Promise<void> | null = null;
	daemon.attach = async (handle: string) => {
		const result = attach(handle);
		if (gate) await gate;
		if (refuse.has(handle)) throw new DaemonCommandError("attach", "timed out after 60000ms");
		return result;
	};
	/** How many of the next `list` calls fail. */
	let failLists = 0;
	const list = daemon.list.bind(daemon);
	daemon.list = async () => {
		const sessions = await list();
		if (failLists > 0) {
			failLists--;
			throw new DaemonCommandError("list", "timed out after 30000ms");
		}
		return sessions;
	};
	/** How many of the next `connect` calls fail. */
	let failConnects = 0;
	const connect = daemon.connect.bind(daemon);
	daemon.connect = async () => {
		const info = await connect();
		if (failConnects > 0) {
			failConnects--;
			throw new Error("connect ENOENT");
		}
		return info;
	};
	let seen = 0;
	const r = {
		daemon,
		manager,
		keeper,
		events,
		snapshots,
		logs,
		refuse,
		failLists: (n: number) => {
			failLists = n;
		},
		failConnects: (n: number) => {
			failConnects = n;
		},
		/** Hold every attach until the returned function is called. */
		holdAttaches: () => {
			let release!: () => void;
			gate = new Promise<void>((resolve) => {
				release = () => {
					gate = null;
					resolve();
				};
			});
			return release;
		},
		/** Daemon traffic since the last call, `attach` with its handle. */
		ops: () => {
			const calls = daemon.calls.slice(seen);
			seen = daemon.calls.length;
			return calls.map((c) => (c.op === "attach" ? `attach ${String(c.args[0])}` : c.op));
		},
		/** Snapshots since the last call. */
		snapped: () => snapshots.splice(0),
		/** Log lines since the last call. */
		logged: () => logs.splice(0),
		/** Let `ms` of keeper time pass, then let the pass it started run. */
		advance: async (ms: number) => {
			t.mock.timers.tick(ms);
			await flush();
		},
	};
	r.ops();
	return r;
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** Assert the phase a row leaves the keeper in, by what the keeper does next. */
async function expectPhase(r: Rig, phase: "attached" | { retryInMs: number }): Promise<void> {
	r.ops();
	if (phase === "attached") {
		await r.advance(60_000);
		assert.deepEqual(r.ops(), [], "attached: no daemon traffic until the daemon closes");
		return;
	}
	await r.advance(phase.retryInMs - 1);
	assert.deepEqual(r.ops(), [], `no retry before ${phase.retryInMs} ms`);
	await r.advance(1);
	assert.notDeepEqual(r.ops(), [], `a retry at ${phase.retryInMs} ms`);
}

/** Start the keeper; resolves once its first pass has ended. */
async function started(r: Rig): Promise<void> {
	let done = false;
	const start = r.keeper.start().then(() => {
		done = true;
	});
	await flush();
	assert.ok(done, "start resolves once the first pass has ended");
	await start;
}

/** The keeper with both sessions attached. */
async function attached(r: Rig): Promise<void> {
	await started(r);
	r.ops();
	r.snapped();
	r.logged();
}

/** The keeper after a first pass in which `a1` would not attach: a retry is due in 10 ms. */
async function retryingA1(r: Rig): Promise<void> {
	r.refuse.add("a1");
	await started(r);
	r.ops();
	r.snapped();
	r.logged();
}

/** The keeper after a first pass whose resync threw: a retry is due in 10 ms. */
async function resyncFailed(r: Rig): Promise<void> {
	r.failLists(1);
	await started(r);
	r.ops();
	r.snapped();
	r.logged();
}

const WHOLE = ["list", "attach a1", "attach a2"];

const keeperRows: {
	phase: string;
	event: string;
	run: (r: Rig) => Promise<void>;
	ops: string[];
	snapshots: string[];
	logs?: string[];
	then: "attached" | { retryInMs: number };
}[] = [
	{
		phase: "disconnected",
		event: "start; every session attaches",
		run: async (r) => started(r),
		ops: ["connect", ...WHOLE],
		snapshots: ["a1", "a2"],
		logs: ["daemon protocol 7, daemon 0.9.6, client 0.9.5"],
		then: "attached",
	},
	{
		phase: "disconnected",
		event: "start; the daemon is not there at first",
		run: async (r) => {
			r.failConnects(1);
			let done = false;
			const start = r.keeper.start().then(() => {
				done = true;
			});
			await flush();
			assert.ok(!done, "start waits for the daemon");
			await r.advance(9);
			assert.ok(!done, "the dial is retried after 10 ms");
			await r.advance(1);
			assert.ok(done);
			await start;
		},
		ops: ["connect", "connect", ...WHOLE],
		snapshots: ["a1", "a2"],
		logs: ["daemon not available (connect ENOENT); retrying in 10 ms", "daemon protocol 7, daemon 0.9.6, client 0.9.5"],
		then: "attached",
	},
	{
		phase: "disconnected",
		event: "start; the resync throws",
		run: async (r) => {
			r.failLists(1);
			await started(r);
		},
		ops: ["connect", "list"],
		snapshots: [],
		logs: ["daemon protocol 7, daemon 0.9.6, client 0.9.5", "daemon resync failed: list: timed out after 30000ms", "retrying the daemon resync in 10 ms"],
		then: { retryInMs: 10 },
	},
	{
		phase: "disconnected",
		event: "start; one session will not attach",
		run: async (r) => {
			r.refuse.add("a1");
			await started(r);
		},
		ops: ["connect", ...WHOLE, "list"],
		snapshots: ["a2"],
		logs: ["daemon protocol 7, daemon 0.9.6, client 0.9.5", "could not reattach session a1: attach: timed out after 60000ms", "retrying the daemon resync in 10 ms"],
		then: { retryInMs: 10 },
	},
	{
		phase: "attached",
		event: "the daemon closes",
		run: async (r) => {
			await attached(r);
			r.daemon.dropConnection();
			await flush();
		},
		ops: ["connect", ...WHOLE],
		snapshots: ["a1", "a2"],
		logs: ["daemon connection closed", "daemon protocol 7, daemon 0.9.6, client 0.9.5"],
		then: "attached",
	},
	{
		phase: "attached",
		event: "the daemon closes and is not there at first",
		run: async (r) => {
			await attached(r);
			r.failConnects(1);
			r.daemon.dropConnection();
			await flush();
			await r.advance(10);
		},
		ops: ["connect", "connect", ...WHOLE],
		snapshots: ["a1", "a2"],
		logs: ["daemon connection closed", "daemon not available (connect ENOENT); retrying in 10 ms", "daemon protocol 7, daemon 0.9.6, client 0.9.5"],
		then: "attached",
	},
	{
		phase: "attached",
		event: "the daemon closes while the reconnect resync is attaching",
		run: async (r) => {
			await attached(r);
			const release = r.holdAttaches();
			r.daemon.dropConnection();
			await flush();
			assert.deepEqual(r.ops(), ["connect", "list", "attach a1"]);
			r.daemon.dropConnection();
			release();
			await flush();
		},
		// The pass that was running ends, then one more pass reconnects at
		// once: it ended whole, so there is no backoff.
		ops: ["attach a2", "connect", ...WHOLE],
		snapshots: ["a1", "a2", "a1", "a2"],
		logs: ["daemon connection closed", "daemon protocol 7, daemon 0.9.6, client 0.9.5", "daemon connection closed", "daemon protocol 7, daemon 0.9.6, client 0.9.5"],
		then: "attached",
	},
	{
		phase: "retrying (a1 would not attach)",
		event: "the retry is due; a1 still will not attach",
		run: async (r) => {
			await retryingA1(r);
			await r.advance(10);
		},
		ops: [...WHOLE, "list"],
		snapshots: ["a2"],
		logs: ["could not reattach session a1: attach: timed out after 60000ms", "retrying the daemon resync in 20 ms"],
		then: { retryInMs: 20 },
	},
	{
		phase: "retrying (a1 would not attach)",
		event: "the retry is due; a1 attaches",
		run: async (r) => {
			await retryingA1(r);
			r.refuse.clear();
			await r.advance(10);
		},
		ops: WHOLE,
		snapshots: ["a1", "a2"],
		logs: [],
		then: "attached",
	},
	{
		phase: "retrying (a1 would not attach)",
		event: "a1 ends before the retry",
		run: async (r) => {
			await retryingA1(r);
			r.daemon.live.delete("a1");
			await r.advance(10);
			assert.deepEqual(
				r.events.filter((e) => e.kind === "session_closed"),
				[{ handle: "a1", kind: "session_closed", reason: "gone" }],
			);
			assert.deepEqual(r.manager.handles(), ["a2"]);
		},
		ops: ["list", "attach a2"],
		snapshots: ["a2"],
		logs: [],
		then: "attached",
	},
	{
		phase: "retrying (a1 would not attach)",
		event: "the service detaches a1 before the retry",
		run: async (r) => {
			await retryingA1(r);
			await r.manager.handle("detach", { session: "a1" });
			assert.deepEqual(r.ops(), ["detach"]);
			await r.advance(10);
		},
		ops: ["list", "attach a2"],
		snapshots: ["a2"],
		logs: [],
		then: "attached",
	},
	{
		phase: "retrying (a1 would not attach)",
		event: "the daemon closes during the wait",
		run: async (r) => {
			await retryingA1(r);
			r.refuse.clear();
			r.daemon.dropConnection();
			await flush();
			assert.deepEqual(r.ops(), [], "the close does not cut the wait short");
			await r.advance(10);
		},
		ops: ["connect", ...WHOLE],
		snapshots: ["a1", "a2"],
		logs: ["daemon connection closed", "daemon protocol 7, daemon 0.9.6, client 0.9.5"],
		then: "attached",
	},
	{
		phase: "resyncing (the resync threw)",
		event: "the retry is due; the resync works",
		run: async (r) => {
			await resyncFailed(r);
			await r.advance(10);
		},
		ops: WHOLE,
		snapshots: ["a1", "a2"],
		logs: [],
		then: "attached",
	},
	{
		phase: "resyncing (the resync threw)",
		event: "the retry is due; the resync throws again",
		run: async (r) => {
			await resyncFailed(r);
			r.failLists(1);
			await r.advance(10);
		},
		ops: ["list"],
		snapshots: [],
		logs: ["daemon resync failed: list: timed out after 30000ms", "retrying the daemon resync in 20 ms"],
		then: { retryInMs: 20 },
	},
	{
		phase: "resyncing (the resync threw)",
		event: "the daemon closes during the wait",
		run: async (r) => {
			await resyncFailed(r);
			r.daemon.dropConnection();
			await flush();
			assert.deepEqual(r.ops(), [], "the close does not cut the wait short");
			await r.advance(10);
		},
		ops: ["connect", ...WHOLE],
		snapshots: ["a1", "a2"],
		logs: ["daemon connection closed", "daemon protocol 7, daemon 0.9.6, client 0.9.5"],
		then: "attached",
	},
];

for (const row of keeperRows) {
	test(`keeper table: ${row.phase} + ${row.event}`, async (t) => {
		const r = await rig(t);
		await row.run(r);
		assert.deepEqual(r.ops(), row.ops, "daemon traffic");
		assert.deepEqual(r.snapped(), row.snapshots, "snapshots sent");
		if (row.logs) assert.deepEqual(r.logged(), row.logs, "log lines");
		await expectPhase(r, row.then);
	});
}

test("keeper table: the retry delay doubles to 30 s and starts again after a whole pass", async (t) => {
	const r = await rig(t, 10_000);
	await retryingA1(r);
	for (const delay of [10_000, 20_000, 30_000, 30_000]) {
		await r.advance(delay - 1);
		assert.deepEqual(r.ops(), [], `nothing before ${delay} ms`);
		await r.advance(1);
		assert.ok(r.ops().includes("attach a1"), `a retry at ${delay} ms`);
	}
	r.refuse.clear();
	await r.advance(30_000);
	assert.ok(r.snapped().includes("a1"));
	await expectPhase(r, "attached");
	r.refuse.add("a1");
	r.daemon.dropConnection();
	await flush();
	await expectPhase(r, { retryInMs: 10_000 });
});

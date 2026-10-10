import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DaemonKeeper } from "../src/daemon_keeper.ts";
import { DaemonCommandError } from "../src/daemon_port.ts";
import { SessionManager } from "../src/sessions.ts";
import { FakeDaemon } from "./fake_daemon.ts";

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

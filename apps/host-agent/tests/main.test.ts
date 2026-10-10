import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DaemonCommandError } from "../src/daemon_port.ts";
import { DaemonKeeper, loadConfig, readToken } from "../src/main.ts";
import { SessionManager } from "../src/sessions.ts";
import { FakeDaemon } from "./fake_daemon.ts";

test("config: one JSON file, ~ expanded, defaults for optional paths", () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "sb-cfg-"));
	const file = path.join(home, "host-agent.json");
	writeFileSync(
		file,
		JSON.stringify({ host_id: "scriptorium", service_url: "wss://switchboard.home.arpa/host", token_file: "~/.config/switchboard/host-token", prime_agent_package: "~/pkg/prime-agent", git_sha: "abc" }),
	);
	const c = loadConfig(file, home);
	assert.equal(c.hostId, "scriptorium");
	assert.equal(c.tokenFile, path.join(home, ".config/switchboard/host-token"));
	assert.equal(c.primeAgentPackage, path.join(home, "pkg/prime-agent"));
	assert.equal(c.stateDir, path.join(home, ".local/state/switchboard/host-agent"));
	assert.match(c.daemonSocket, /prime-agent-\d+\/daemon\.sock$/);
	assert.equal(c.gitSha, "abc");
});

test("config: missing or bad fields are errors; the token comes from its file", () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "sb-cfg-"));
	const file = path.join(home, "c.json");
	writeFileSync(file, JSON.stringify({ host_id: "h", service_url: "https://x", token_file: "t", prime_agent_package: "p" }));
	assert.throws(() => loadConfig(file, home), /service_url/);
	writeFileSync(file, JSON.stringify({ service_url: "wss://x/host" }));
	assert.throws(() => loadConfig(file, home), /host_id/);
	const tokenFile = path.join(home, "token");
	writeFileSync(tokenFile, "  secret-value\n");
	assert.equal(readToken(tokenFile), "secret-value");
	writeFileSync(tokenFile, "\n");
	assert.throws(() => readToken(tokenFile), /empty/);
});

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

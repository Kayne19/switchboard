import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, readToken } from "../src/main.ts";

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
	assert.equal(c.skillSocket, path.join(home, ".cache/switchboard/host-agent.sock"));
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

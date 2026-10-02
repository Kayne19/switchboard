// The installer, run as a child process against a temp HOME and TMPDIR with
// fake systemctl and loginctl programs that log their argv. Nothing here
// touches the real systemd, loginctl, prime-agent or daemon socket: the fake
// prime-agent binary and package are plain files and are never executed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, rmSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const INSTALLER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "install.mjs");
const TOKEN = "test-token-4f1d";

/** Write a fake program once: to a temp name, closed and made executable, then renamed into place. */
function writeExecutable(file: string, body: string): void {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `#!/bin/sh\n${body}`);
	chmodSync(tmp, 0o755);
	renameSync(tmp, file);
}

interface Rig {
	root: string;
	home: string;
	tmp: string;
	state: string;
	bin: string;
	primeAgent: string;
	primePackage: string;
	tokenSource: string;
	caSource: string;
}

function rig(): Rig {
	const root = mkdtempSync(path.join(os.tmpdir(), "sb-install-"));
	process.on("exit", () => rmSync(root, { recursive: true, force: true }));
	const home = path.join(root, "home");
	const tmp = path.join(root, "t");
	const state = path.join(root, "fake");
	const bin = path.join(root, "fakebin");
	for (const d of [home, tmp, state, bin]) mkdirSync(d, { recursive: true });
	// systemctl: logs argv; is-active answers from a state file; start creates it.
	writeExecutable(
		path.join(bin, "systemctl"),
		`d='${state}'
echo "systemctl $*" >> "$d/calls.log"
case "$*" in
  *is-active*prime-agent-daemon.service*)
    if [ -f "$d/daemon-active" ]; then echo active; exit 0; else echo inactive; exit 3; fi ;;
  *" start prime-agent-daemon.service"*) : > "$d/daemon-active" ;;
esac
exit 0
`,
	);
	// loginctl: linger from a state file; enable-linger refused while polkit-refuses exists.
	writeExecutable(
		path.join(bin, "loginctl"),
		`d='${state}'
echo "loginctl $*" >> "$d/calls.log"
case "$1" in
  show-user) if [ -f "$d/linger" ]; then echo Linger=yes; else echo Linger=no; fi ;;
  enable-linger)
    if [ -f "$d/polkit-refuses" ]; then echo "Could not enable linger: Access denied" >&2; exit 1; fi
    : > "$d/linger" ;;
esac
exit 0
`,
	);
	// A prime-agent install laid out like npm's global prefix: bin/ and lib/node_modules/.
	const prefix = path.join(root, "npm");
	const primeAgent = path.join(prefix, "bin", "prime-agent");
	const primePackage = path.join(prefix, "lib", "node_modules", "prime-agent");
	mkdirSync(path.dirname(primeAgent), { recursive: true });
	mkdirSync(path.join(primePackage, "dist"), { recursive: true });
	writeFileSync(primeAgent, "not a real prime-agent\n", { mode: 0o755 });
	writeFileSync(path.join(primePackage, "dist", "index.js"), "export {};\n");
	const tokenSource = path.join(root, "token-from-damocles");
	writeFileSync(tokenSource, `  ${TOKEN}\n`, { mode: 0o600 });
	const caSource = path.join(root, "step-ca-root.crt");
	writeFileSync(caSource, "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n");
	return { root, home, tmp, state, bin, primeAgent, primePackage, tokenSource, caSource };
}

function install(r: Rig, args: string[]) {
	const env = { HOME: r.home, TMPDIR: r.tmp, PATH: `${r.bin}:${path.dirname(r.primeAgent)}:/usr/local/bin:/usr/bin:/bin` };
	const p = spawnSync(process.execPath, [INSTALLER, "--systemctl", path.join(r.bin, "systemctl"), "--loginctl", path.join(r.bin, "loginctl"), ...args], { env, encoding: "utf8" });
	return { status: p.status, stdout: p.stdout, stderr: p.stderr };
}

function calls(r: Rig): string[] {
	const log = path.join(r.state, "calls.log");
	return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

function resetCalls(r: Rig): void {
	writeFileSync(path.join(r.state, "calls.log"), "");
}

function unit(r: Rig, name: string): string {
	return readFileSync(path.join(r.home, ".config/systemd/user", name), "utf8");
}

function execStarts(text: string): string[] {
	return text.split("\n").filter((l) => l.startsWith("ExecStart="));
}

const mode = (p: string) => statSync(p).mode & 0o777;
const uid = process.getuid?.() ?? 0;

test("installer: first install writes the files, both units and enables linger", () => {
	const r = rig();
	const res = install(r, ["--host-id", "scriptorium", "--token-file", r.tokenSource]);
	assert.equal(res.status, 0, res.stderr);
	assert.ok(!res.stdout.includes(TOKEN) && !res.stderr.includes(TOKEN), "the token is never printed");

	// Token and config: directory 0700, files 0600.
	const cfgDir = path.join(r.home, ".config/switchboard");
	assert.equal(mode(cfgDir), 0o700);
	assert.equal(readFileSync(path.join(cfgDir, "host-token"), "utf8"), `${TOKEN}\n`);
	assert.equal(mode(path.join(cfgDir, "host-token")), 0o600);
	const cfgFile = path.join(cfgDir, "host-agent.json");
	assert.equal(mode(cfgFile), 0o600);
	const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
	const sha = cfg.git_sha as string;
	assert.match(sha, /^[0-9a-f]{40}$/);
	const socket = path.join(r.tmp, `prime-agent-${uid}`, "daemon.sock");
	assert.deepEqual(cfg, {
		host_id: "scriptorium",
		service_url: "wss://switchboard.home.arpa/host",
		token_file: path.join(cfgDir, "host-token"),
		git_sha: sha,
		prime_agent: r.primeAgent,
		prime_agent_package: r.primePackage,
		daemon_socket: socket,
		state_dir: path.join(r.home, ".local/state/switchboard/host-agent"),
		skill_socket: path.join(r.home, ".cache/switchboard/host-agent.sock"),
	});

	// The host agent in a versioned directory, as ES modules.
	const version = path.join(r.home, ".local/share/switchboard/host-agent", sha);
	assert.ok(existsSync(path.join(version, "src/main.ts")));
	assert.ok(existsSync(path.join(version, "src/daemon_port.ts")));
	assert.deepEqual(JSON.parse(readFileSync(path.join(version, "package.json"), "utf8")), { type: "module" });

	// The skill, without its tests or caches.
	const skill = path.join(r.home, ".prime/agent/skills/switchboard");
	assert.ok(existsSync(path.join(skill, "SKILL.md")));
	assert.ok(existsSync(path.join(skill, "pyproject.toml")));
	assert.ok(existsSync(path.join(skill, "src/switchboard/__init__.py")));
	assert.ok(!existsSync(path.join(skill, "tests")));
	assert.ok(!existsSync(path.join(skill, "src/switchboard/__pycache__")));

	// The daemon unit is the only one that runs the prime-agent daemon.
	const daemon = unit(r, "prime-agent-daemon.service");
	assert.deepEqual(execStarts(daemon), [`ExecStart=${r.primeAgent} --mode daemon --daemon-socket ${socket}`]);
	assert.match(daemon, /^Restart=always$/m);
	assert.match(daemon, new RegExp(`^Environment=TMPDIR=${r.tmp}$`, "m"));
	const hostAgent = unit(r, "switchboard-host-agent.service");
	assert.deepEqual(execStarts(hostAgent), [`ExecStart=${process.execPath} ${path.join(version, "src/main.ts")} --config ${cfgFile}`]);
	assert.deepEqual(
		hostAgent.split("\n").filter((l) => !l.startsWith("#") && /prime-agent|--mode daemon/.test(l)),
		["After=prime-agent-daemon.service"],
		"the host agent unit does not start the daemon; it is only ordered after it",
	);
	assert.doesNotMatch(hostAgent, /^(Requires|BindsTo|Wants)=/m);
	assert.match(hostAgent, /^After=prime-agent-daemon\.service$/m);
	assert.match(hostAgent, /^Restart=always$/m);
	assert.doesNotMatch(hostAgent, /NODE_EXTRA_CA_CERTS/);
	// Both carry the installer's PATH: user units do not see the login shell's.
	for (const text of [daemon, hostAgent]) assert.match(text, /^Environment=PATH=.*fakebin/m);

	// Linger enabled, both units enabled, the daemon started, the host agent restarted.
	const user = os.userInfo().username;
	assert.deepEqual(calls(r), [
		"systemctl --user is-active prime-agent-daemon.service",
		`loginctl show-user ${user} --property=Linger`,
		`loginctl enable-linger ${user}`,
		"systemctl --user daemon-reload",
		"systemctl --user enable prime-agent-daemon.service switchboard-host-agent.service",
		"systemctl --user start prime-agent-daemon.service",
		"systemctl --user restart switchboard-host-agent.service",
	]);
});

test("installer: a rerun is an idempotent upgrade that never restarts the daemon", () => {
	const r = rig();
	assert.equal(install(r, ["--host-id", "scriptorium", "--token-file", r.tokenSource]).status, 0);
	const unitsBefore = [unit(r, "prime-agent-daemon.service"), unit(r, "switchboard-host-agent.service")];
	resetCalls(r);

	// No flags: host id, token and service URL are the installed ones.
	const res = install(r, []);
	assert.equal(res.status, 0, res.stderr);
	assert.doesNotMatch(res.stdout, /^(wrote|updated|removed|enabled|started)/m, "nothing changed, nothing rewritten");
	assert.deepEqual([unit(r, "prime-agent-daemon.service"), unit(r, "switchboard-host-agent.service")], unitsBefore);
	const user = os.userInfo().username;
	assert.deepEqual(calls(r), [
		"systemctl --user is-active prime-agent-daemon.service",
		`loginctl show-user ${user} --property=Linger`,
		"systemctl --user daemon-reload",
		"systemctl --user enable prime-agent-daemon.service switchboard-host-agent.service",
		"systemctl --user restart switchboard-host-agent.service",
	]);
	assert.ok(!calls(r).some((c) => /(start|restart|stop) prime-agent-daemon/.test(c)));

	// A changed input rewrites only what depends on it, and an old version is pruned.
	const versions = path.join(r.home, ".local/share/switchboard/host-agent");
	mkdirSync(path.join(versions, "0000000000000000000000000000000000000000/src"), { recursive: true });
	writeFileSync(path.join(r.home, ".prime/agent/skills/switchboard/stale.txt"), "left over\n");
	const res2 = install(r, ["--service-url", "wss://other.example/host"]);
	assert.equal(res2.status, 0, res2.stderr);
	const changed = res2.stdout.split("\n").filter((l) => /^(wrote|updated|removed)/.test(l));
	assert.deepEqual(changed.sort(), [
		`removed ${path.join(r.home, ".prime/agent/skills/switchboard/stale.txt")}`,
		`removed ${path.join(versions, "0000000000000000000000000000000000000000")}`,
		`updated ${path.join(r.home, ".config/switchboard/host-agent.json")}`,
	].sort());
	assert.equal(readdirSync(versions).length, 1);
	assert.equal(JSON.parse(readFileSync(path.join(r.home, ".config/switchboard/host-agent.json"), "utf8")).service_url, "wss://other.example/host");
});

test("installer: a rerun reuses the installed prime-agent package while it is still there", () => {
	const r = rig();
	// The host keeps its package away from the binary on PATH (familiar, 2026-10-01).
	rmSync(r.primePackage, { recursive: true });
	const elsewhere = path.join(r.root, "pkgs", "prime-agent");
	mkdirSync(path.join(elsewhere, "dist"), { recursive: true });
	writeFileSync(path.join(elsewhere, "dist", "index.js"), "export {};\n");
	const cfgFile = path.join(r.home, ".config/switchboard/host-agent.json");
	const res = install(r, ["--host-id", "familiar", "--token-file", r.tokenSource, "--prime-agent-package", elsewhere]);
	assert.equal(res.status, 0, res.stderr);

	// No flags: the installed package, not the one derived from the binary.
	const res2 = install(r, []);
	assert.equal(res2.status, 0, res2.stderr);
	assert.doesNotMatch(res2.stdout, /^(wrote|updated|removed)/m, "nothing changed, nothing rewritten");
	assert.equal(JSON.parse(readFileSync(cfgFile, "utf8")).prime_agent_package, elsewhere);

	// A flag still wins over what is installed.
	const other = path.join(r.root, "pkgs2", "prime-agent");
	mkdirSync(path.join(other, "dist"), { recursive: true });
	writeFileSync(path.join(other, "dist", "index.js"), "export {};\n");
	assert.equal(install(r, ["--prime-agent-package", other]).status, 0);
	assert.equal(JSON.parse(readFileSync(cfgFile, "utf8")).prime_agent_package, other);

	// An installed package without dist/index.js is skipped for the derived default.
	rmSync(other, { recursive: true });
	mkdirSync(path.join(r.primePackage, "dist"), { recursive: true });
	writeFileSync(path.join(r.primePackage, "dist", "index.js"), "export {};\n");
	const res3 = install(r, []);
	assert.equal(res3.status, 0, res3.stderr);
	assert.equal(JSON.parse(readFileSync(cfgFile, "utf8")).prime_agent_package, r.primePackage);
});

test("installer: a rerun reuses the installed prime-agent binary while it is still there", () => {
	const r = rig();
	// A second prime-agent, not on PATH, laid out as its own npm prefix.
	const binary = path.join(r.root, "other", "bin", "prime-agent");
	const pkg = path.join(r.root, "other", "lib", "node_modules", "prime-agent");
	mkdirSync(path.dirname(binary), { recursive: true });
	mkdirSync(path.join(pkg, "dist"), { recursive: true });
	writeFileSync(binary, "not a real prime-agent\n", { mode: 0o755 });
	writeFileSync(path.join(pkg, "dist", "index.js"), "export {};\n");
	const cfgFile = path.join(r.home, ".config/switchboard/host-agent.json");
	const res = install(r, ["--host-id", "familiar", "--token-file", r.tokenSource, "--prime-agent", binary]);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(JSON.parse(readFileSync(cfgFile, "utf8")).prime_agent, binary);
	assert.match(execStarts(unit(r, "prime-agent-daemon.service"))[0], new RegExp(`^ExecStart=${binary} `));

	// No flags: the installed binary, not the one on PATH.
	const res2 = install(r, []);
	assert.equal(res2.status, 0, res2.stderr);
	assert.doesNotMatch(res2.stdout, /^(wrote|updated|removed)/m, "nothing changed, nothing rewritten");
	assert.match(execStarts(unit(r, "prime-agent-daemon.service"))[0], new RegExp(`^ExecStart=${binary} `));

	// Once it is gone, the one on PATH and the package next to it.
	rmSync(path.join(r.root, "other"), { recursive: true });
	const res3 = install(r, []);
	assert.equal(res3.status, 0, res3.stderr);
	const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
	assert.equal(cfg.prime_agent, r.primeAgent);
	assert.equal(cfg.prime_agent_package, r.primePackage);
	assert.match(execStarts(unit(r, "prime-agent-daemon.service"))[0], new RegExp(`^ExecStart=${r.primeAgent} `));
});

test("installer: an explicit --prime-agent prefers the package next to it over the installed one", () => {
	const r = rig();
	const elsewhere = path.join(r.root, "pkgs", "prime-agent");
	mkdirSync(path.join(elsewhere, "dist"), { recursive: true });
	writeFileSync(path.join(elsewhere, "dist", "index.js"), "export {};\n");
	const cfgFile = path.join(r.home, ".config/switchboard/host-agent.json");
	assert.equal(install(r, ["--host-id", "familiar", "--token-file", r.tokenSource, "--prime-agent-package", elsewhere]).status, 0);

	// A new prime-agent laid out as its own npm prefix: its package wins.
	const binary = path.join(r.root, "other", "bin", "prime-agent");
	const pkg = path.join(r.root, "other", "lib", "node_modules", "prime-agent");
	mkdirSync(path.dirname(binary), { recursive: true });
	mkdirSync(path.join(pkg, "dist"), { recursive: true });
	writeFileSync(binary, "not a real prime-agent\n", { mode: 0o755 });
	writeFileSync(path.join(pkg, "dist", "index.js"), "export {};\n");
	const res = install(r, ["--prime-agent", binary]);
	assert.equal(res.status, 0, res.stderr);
	let cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
	assert.equal(cfg.prime_agent, binary);
	assert.equal(cfg.prime_agent_package, pkg);

	// No package next to it: the installed one, while it is still there.
	assert.equal(install(r, ["--prime-agent", binary, "--prime-agent-package", elsewhere]).status, 0);
	rmSync(pkg, { recursive: true });
	const res3 = install(r, ["--prime-agent", binary]);
	assert.equal(res3.status, 0, res3.stderr);
	cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
	assert.equal(cfg.prime_agent_package, elsewhere);

	// Neither: the same stop as before.
	rmSync(elsewhere, { recursive: true });
	const res4 = install(r, ["--prime-agent", binary]);
	assert.equal(res4.status, 1);
	assert.match(res4.stderr, new RegExp(`no prime-agent npm package at ${pkg} \\(dist/index\\.js missing\\)`));
});

test("installer: a CA file is copied next to the config and trusted by the host agent only", () => {
	const r = rig();
	const res = install(r, ["--host-id", "familiar", "--token-file", r.tokenSource, "--ca-file", r.caSource]);
	assert.equal(res.status, 0, res.stderr);
	const ca = path.join(r.home, ".config/switchboard/ca.crt");
	assert.equal(readFileSync(ca, "utf8"), readFileSync(r.caSource, "utf8"));
	assert.match(unit(r, "switchboard-host-agent.service"), new RegExp(`^Environment=NODE_EXTRA_CA_CERTS=${ca}$`, "m"));
	assert.doesNotMatch(unit(r, "prime-agent-daemon.service"), /NODE_EXTRA_CA_CERTS/);
	// A rerun without --ca-file keeps it.
	assert.equal(install(r, []).status, 0);
	assert.match(unit(r, "switchboard-host-agent.service"), /NODE_EXTRA_CA_CERTS/);
});

test("installer: stops when polkit refuses linger, before writing anything", () => {
	const r = rig();
	writeFileSync(path.join(r.state, "polkit-refuses"), "");
	const res = install(r, ["--host-id", "scriptorium", "--token-file", r.tokenSource]);
	assert.equal(res.status, 1);
	assert.match(res.stderr, new RegExp(`sudo loginctl enable-linger ${os.userInfo().username}`));
	assert.ok(!existsSync(path.join(r.home, ".config")), "nothing written");
	assert.deepEqual(calls(r).filter((c) => c.startsWith("systemctl")), ["systemctl --user is-active prime-agent-daemon.service"]);
});

test("installer: stops when a daemon already runs outside the unit, and never stops it", () => {
	const r = rig();
	const socket = path.join(r.tmp, `prime-agent-${uid}`, "daemon.sock");
	mkdirSync(path.dirname(socket), { recursive: true });
	writeFileSync(socket, "");
	const res = install(r, ["--host-id", "scriptorium", "--token-file", r.tokenSource]);
	assert.equal(res.status, 1);
	assert.match(res.stderr, /already running outside prime-agent-daemon\.service/);
	assert.match(res.stderr, /prime-agent shutdown/);
	assert.ok(!existsSync(path.join(r.home, ".config")), "nothing written");
	assert.deepEqual(calls(r), ["systemctl --user is-active prime-agent-daemon.service"]);

	// Once the unit owns the socket, the install goes ahead and does not start or restart it.
	writeFileSync(path.join(r.state, "daemon-active"), "");
	resetCalls(r);
	const res2 = install(r, ["--host-id", "scriptorium", "--token-file", r.tokenSource]);
	assert.equal(res2.status, 0, res2.stderr);
	assert.ok(!calls(r).some((c) => /(start|restart|stop) prime-agent-daemon/.test(c)));
});

test("installer: refuses a first install without a host id or token", () => {
	const r = rig();
	assert.match(install(r, ["--token-file", r.tokenSource]).stderr, /--host-id is required/);
	assert.match(install(r, ["--host-id", "h"]).stderr, /--token-file is required/);
	const empty = path.join(r.root, "empty");
	writeFileSync(empty, "\n");
	assert.match(install(r, ["--host-id", "h", "--token-file", empty]).stderr, /is empty/);
	assert.deepEqual(calls(r), []);
});

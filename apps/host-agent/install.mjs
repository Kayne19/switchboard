#!/usr/bin/env node
// Install or redeploy the switchboard host agent on this host, as this user.
//
//   node apps/host-agent/install.mjs --host-id <id> --token-file <path>
//        [--service-url <wss://…/host>] [--ca-file <root.crt>]
//        [--prime-agent <bin>] [--prime-agent-package <dir>]
//
// Run it from a checkout of the pinned commit. A rerun is an upgrade: it
// rewrites only what changed and restarts the host agent. It never restarts
// the prime-agent daemon (that would kill every agent on the host). The
// design, the post-deploy checklist and the stops are in docs/host-agent.md.
//
// Test-only: --systemctl <program> and --loginctl <program> replace the real
// programs. HOME and TMPDIR come from the environment, as for prime-agent.
// Plain Node, no dependencies. The token is never printed.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SERVICE_URL = "wss://switchboard.home.arpa/host";
const DAEMON_UNIT = "prime-agent-daemon.service";
const HOST_AGENT_UNIT = "switchboard-host-agent.service";
const MIN_NODE = [22, 18];

class Stop extends Error {}

function stop(message) {
	throw new Stop(message);
}

function parseArgs(argv) {
	const known = new Set(["--host-id", "--token-file", "--service-url", "--ca-file", "--prime-agent", "--prime-agent-package", "--systemctl", "--loginctl"]);
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--help" || flag === "-h") {
			out.help = true;
			continue;
		}
		if (!known.has(flag)) stop(`unknown argument ${flag} (see --help)`);
		const value = argv[++i];
		if (value === undefined || value === "") stop(`${flag} needs a value`);
		out[flag.slice(2)] = value;
	}
	return out;
}

const USAGE = `usage: node apps/host-agent/install.mjs --host-id <id> --token-file <path>
       [--service-url <url>] [--ca-file <root.crt>] [--prime-agent <bin>] [--prime-agent-package <dir>]
On a rerun, --host-id, --token-file, --service-url and --ca-file default to what is installed.`;

function checkNode() {
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
		stop(`Node ${MIN_NODE.join(".")} or later is required (this is ${process.versions.node})`);
	}
}

function which(cmd) {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const p = path.join(dir, cmd);
		try {
			fs.accessSync(p, fs.constants.X_OK);
			return p;
		} catch {}
	}
	return undefined;
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** Everything the installer writes, derived from HOME, TMPDIR and the checkout. */
function layout(home = os.homedir(), tmpdir = os.tmpdir()) {
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const configDir = path.join(home, ".config", "switchboard");
	return {
		configDir,
		configFile: path.join(configDir, "host-agent.json"),
		tokenFile: path.join(configDir, "host-token"),
		caFile: path.join(configDir, "ca.crt"),
		versionsDir: path.join(home, ".local", "share", "switchboard", "host-agent"),
		skillDir: path.join(home, ".prime", "agent", "skills", "switchboard"),
		unitDir: path.join(home, ".config", "systemd", "user"),
		stateDir: path.join(home, ".local", "state", "switchboard", "host-agent"),
		skillSocket: path.join(home, ".cache", "switchboard", "host-agent.sock"),
		daemonSocket: path.join(tmpdir, `prime-agent-${uid}`, "daemon.sock"),
	};
}

// --- writing only what changed ---------------------------------------------

const report = [];

function note(what, file) {
	report.push(`${what} ${file}`);
}

/** Write `content` to `file` (atomically) unless it already holds it; enforce `mode` either way. */
function writeIfChanged(file, content, mode = 0o644) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const want = Buffer.from(content);
	let have;
	try {
		have = fs.readFileSync(file);
	} catch {}
	if (have && have.equals(want)) {
		if ((fs.statSync(file).mode & 0o777) !== mode) fs.chmodSync(file, mode);
		return false;
	}
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, want, { mode });
	fs.chmodSync(tmp, mode);
	fs.renameSync(tmp, file);
	note(have ? "updated" : "wrote", file);
	return true;
}

/** Make `dest` hold exactly the files `list` names (relative path -> source path). */
function syncTree(dest, files) {
	let changed = false;
	for (const [rel, src] of files) changed = writeIfChanged(path.join(dest, rel), fs.readFileSync(src)) || changed;
	const keep = new Set(files.map(([rel]) => path.join(dest, rel)));
	const prune = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				prune(p);
				if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
			} else if (!keep.has(p)) {
				fs.rmSync(p, { force: true });
				note("removed", p);
				changed = true;
			}
		}
	};
	if (fs.existsSync(dest)) prune(dest);
	return changed;
}

/** Files of a source tree, skipping tests and caches. */
function listTree(root, rel = "") {
	const out = [];
	for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
		if (entry.name === "tests" || entry.name === "__pycache__" || entry.name.endsWith(".pyc") || entry.name.startsWith(".")) continue;
		const r = path.join(rel, entry.name);
		if (entry.isDirectory()) out.push(...listTree(root, r));
		else if (entry.isFile()) out.push([r, path.join(root, r)]);
	}
	return out.sort(([a], [b]) => a.localeCompare(b));
}

// --- systemd ------------------------------------------------------------------

/** Quote one word for a unit file (systemd.syntax): plain words stay bare. */
function unitWord(word) {
	const escaped = word.replaceAll("%", "%%");
	if (/^[A-Za-z0-9_@+=:,./-]+$/.test(escaped)) return escaped;
	return `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function environmentLine(name, value) {
	return `Environment=${unitWord(`${name}=${value}`)}`;
}

function daemonUnit({ primeAgent, daemonSocket, pathEnv, tmpdir }) {
	return `# Installed by switchboard's apps/host-agent/install.mjs. Do not edit; rerun the installer.
[Unit]
Description=Shared prime-agent daemon (every agent session on this host)

[Service]
Type=simple
${environmentLine("PATH", pathEnv)}
${environmentLine("TMPDIR", tmpdir)}
ExecStart=${[primeAgent, "--mode", "daemon", "--daemon-socket", daemonSocket].map(unitWord).join(" ")}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function hostAgentUnit({ node, mainTs, configFile, pathEnv, tmpdir, caFile }) {
	const ca = caFile ? `${environmentLine("NODE_EXTRA_CA_CERTS", caFile)}\n` : "";
	return `# Installed by switchboard's apps/host-agent/install.mjs. Do not edit; rerun the installer.
# Only connects to the daemon; it never starts it.
[Unit]
Description=switchboard host agent
After=${DAEMON_UNIT}

[Service]
Type=simple
${environmentLine("PATH", pathEnv)}
${environmentLine("TMPDIR", tmpdir)}
${ca}ExecStart=${[node, mainTs, "--config", configFile].map(unitWord).join(" ")}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function run(program, args, { allowFail = false } = {}) {
	const r = spawnSync(program, args, { encoding: "utf8" });
	if (r.error) stop(`could not run ${program}: ${r.error.message}`);
	if (r.status !== 0 && !allowFail) stop(`${path.basename(program)} ${args.join(" ")} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim()}`);
	return { status: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

// --- the install ----------------------------------------------------------------

function install(argv) {
	const args = parseArgs(argv);
	if (args.help) {
		console.log(USAGE);
		return;
	}
	checkNode();

	const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	const home = os.homedir();
	const tmpdir = os.tmpdir();
	const L = layout(home, tmpdir);
	const systemctl = args.systemctl ?? "systemctl";
	const loginctl = args.loginctl ?? "loginctl";
	const user = os.userInfo().username;
	const previous = readJson(L.configFile) ?? {};

	// Inputs: flags first, then what a previous install left.
	const hostId = args["host-id"] ?? previous.host_id;
	if (!hostId) stop("--host-id is required on the first install");
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(hostId)) stop(`--host-id ${hostId} is not a plain host name`);
	const serviceUrl = args["service-url"] ?? previous.service_url ?? DEFAULT_SERVICE_URL;
	if (!/^wss?:\/\//.test(serviceUrl)) stop("--service-url must be a ws:// or wss:// URL");

	let token;
	if (args["token-file"]) {
		try {
			token = fs.readFileSync(args["token-file"], "utf8").trim();
		} catch (error) {
			stop(`cannot read --token-file: ${error.message}`);
		}
		if (!token) stop(`--token-file ${args["token-file"]} is empty`);
	} else if (!fs.existsSync(L.tokenFile)) {
		stop("--token-file is required on the first install");
	}

	let caSource;
	if (args["ca-file"]) {
		try {
			caSource = fs.readFileSync(path.resolve(args["ca-file"]), "utf8");
		} catch (error) {
			stop(`cannot read --ca-file: ${error.message}`);
		}
		if (!caSource.includes("BEGIN CERTIFICATE")) stop(`--ca-file ${args["ca-file"]} is not a PEM certificate`);
	}
	const useCa = caSource !== undefined || fs.existsSync(L.caFile);

	const primeLink = args["prime-agent"] ?? which("prime-agent");
	if (!primeLink) stop("prime-agent is not on PATH; pass --prime-agent <absolute path>");
	const primeAgent = path.resolve(primeLink);
	if (!fs.existsSync(primeAgent)) stop(`prime-agent binary ${primeAgent} does not exist`);
	const primePackage = path.resolve(args["prime-agent-package"] ?? path.join(path.dirname(path.dirname(primeAgent)), "lib", "node_modules", "prime-agent"));
	if (!fs.existsSync(path.join(primePackage, "dist", "index.js"))) {
		stop(`no prime-agent npm package at ${primePackage} (dist/index.js missing); pass --prime-agent-package <dir>`);
	}

	let gitSha;
	try {
		gitSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch {
		stop(`${repo} is not a git checkout; run the installer from a checkout of the pinned commit`);
	}

	// Stop: a daemon runs outside the unit. Starting the unit would replace it
	// and kill its agents, so the user ends it at a quiet moment.
	const daemonState = run(systemctl, ["--user", "is-active", DAEMON_UNIT], { allowFail: true }).out;
	const daemonActive = ["active", "activating", "reloading"].includes(daemonState);
	if (fs.existsSync(L.daemonSocket) && !daemonActive) {
		stop(
			`a prime-agent daemon is already running outside ${DAEMON_UNIT} (its socket ${L.daemonSocket} exists). ` +
				"The installer never stops it: that would end every agent session on this host. " +
				"At a quiet moment, when no agent work is running, end it (for example `prime-agent shutdown`) and rerun the installer. " +
				"If no daemon is running, the socket is stale: remove it and rerun.",
		);
	}

	// Stop: linger. Without it the user's units stop when the last login ends.
	const linger = run(loginctl, ["show-user", user, "--property=Linger"], { allowFail: true }).out;
	if (!/^Linger=yes$/m.test(linger)) {
		const r = run(loginctl, ["enable-linger", user], { allowFail: true });
		if (r.status !== 0) {
			stop(`could not enable linger for ${user} (${r.err || `exit ${r.status}`}). Run \`sudo loginctl enable-linger ${user}\` once, then rerun the installer.`);
		}
		note("enabled linger for", user);
	}

	// The host agent, as sources run directly by Node (no build step).
	const versionDir = path.join(L.versionsDir, gitSha);
	const sources = listTree(path.join(repo, "apps", "host-agent", "src")).filter(([rel]) => rel.endsWith(".ts"));
	syncTree(path.join(versionDir, "src"), sources);
	writeIfChanged(path.join(versionDir, "package.json"), '{ "type": "module" }\n');

	// The switchboard skill, for every prime-agent session on this host.
	syncTree(L.skillDir, listTree(path.join(repo, "skills", "switchboard")));

	// Secrets and config: directory 0700, files 0600.
	fs.mkdirSync(L.configDir, { recursive: true, mode: 0o700 });
	fs.chmodSync(L.configDir, 0o700);
	if (token !== undefined) writeIfChanged(L.tokenFile, `${token}\n`, 0o600);
	else fs.chmodSync(L.tokenFile, 0o600);
	if (caSource !== undefined) writeIfChanged(L.caFile, caSource, 0o644);
	const config = {
		host_id: hostId,
		service_url: serviceUrl,
		token_file: L.tokenFile,
		git_sha: gitSha,
		prime_agent_package: primePackage,
		daemon_socket: L.daemonSocket,
		state_dir: L.stateDir,
		skill_socket: L.skillSocket,
	};
	writeIfChanged(L.configFile, `${JSON.stringify(config, null, 2)}\n`, 0o600);

	// The two units. systemd user units do not see the login shell's
	// environment, so PATH and TMPDIR are the installer's own.
	const pathEnv = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
	writeIfChanged(path.join(L.unitDir, DAEMON_UNIT), daemonUnit({ primeAgent, daemonSocket: L.daemonSocket, pathEnv, tmpdir }));
	writeIfChanged(
		path.join(L.unitDir, HOST_AGENT_UNIT),
		hostAgentUnit({ node: process.execPath, mainTs: path.join(versionDir, "src", "main.ts"), configFile: L.configFile, pathEnv, tmpdir, caFile: useCa ? L.caFile : undefined }),
	);

	run(systemctl, ["--user", "daemon-reload"]);
	run(systemctl, ["--user", "enable", DAEMON_UNIT, HOST_AGENT_UNIT]);
	if (!daemonActive) {
		run(systemctl, ["--user", "start", DAEMON_UNIT]);
		note("started", DAEMON_UNIT);
	}
	run(systemctl, ["--user", "restart", HOST_AGENT_UNIT]);
	note("restarted", HOST_AGENT_UNIT);

	// Older host-agent versions are no longer referenced by the unit.
	for (const entry of fs.readdirSync(L.versionsDir)) {
		if (entry === gitSha) continue;
		fs.rmSync(path.join(L.versionsDir, entry), { recursive: true, force: true });
		note("removed", path.join(L.versionsDir, entry));
	}

	for (const line of report) console.log(line);
	console.log(`host agent ${gitSha} installed for host ${hostId}; check it with the post-deploy checklist in docs/host-agent.md`);
}

try {
	install(process.argv.slice(2));
} catch (error) {
	if (!(error instanceof Stop)) throw error;
	console.error(`install: ${error.message}`);
	process.exit(1);
}

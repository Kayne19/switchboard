// Host agent entry point: `node apps/host-agent/src/main.ts [--config <file>]`.
//
// The only reader of host-agent settings. Everything comes from one JSON
// config file (format in docs/host-link.md); the host token is read from the
// file it names and never logged.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type DaemonInfo, type DaemonPort, PrimeDaemonPort } from "./daemon_port.ts";
import { HostLink } from "./link.ts";
import { SessionManager } from "./sessions.ts";
import { SkillSocket } from "./skill_socket.ts";

export interface HostAgentConfig {
	hostId: string;
	serviceUrl: string;
	tokenFile: string;
	gitSha: string;
	daemonSocket: string;
	primeAgentPackage: string;
	stateDir: string;
	skillSocket: string;
}

export const DEFAULT_CONFIG_PATH = "~/.config/switchboard/host-agent.json";

function expandHome(p: string, home: string): string {
	return p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

/** Parse and validate the host-agent config file. */
export function loadConfig(file: string, home = os.homedir()): HostAgentConfig {
	const raw = JSON.parse(readFileSync(expandHome(file, home), "utf8")) as Record<string, unknown>;
	const need = (key: string): string => {
		const v = raw[key];
		if (typeof v !== "string" || v === "") throw new Error(`host-agent config ${file}: missing string "${key}"`);
		return v;
	};
	const opt = (key: string, fallback: string): string => {
		const v = raw[key];
		if (v === undefined) return fallback;
		if (typeof v !== "string" || v === "") throw new Error(`host-agent config ${file}: "${key}" must be a non-empty string`);
		return v;
	};
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const serviceUrl = need("service_url");
	if (!/^wss?:\/\//.test(serviceUrl)) throw new Error(`host-agent config ${file}: "service_url" must be a ws:// or wss:// URL`);
	return {
		hostId: need("host_id"),
		serviceUrl,
		tokenFile: expandHome(need("token_file"), home),
		gitSha: opt("git_sha", "unknown"),
		daemonSocket: expandHome(opt("daemon_socket", path.join(os.tmpdir(), `prime-agent-${uid}`, "daemon.sock")), home),
		primeAgentPackage: expandHome(need("prime_agent_package"), home),
		stateDir: expandHome(opt("state_dir", "~/.local/state/switchboard/host-agent"), home),
		skillSocket: expandHome(opt("skill_socket", "~/.cache/switchboard/host-agent.sock"), home),
	};
}

export function readToken(file: string): string {
	const token = readFileSync(file, "utf8").trim();
	if (!token) throw new Error(`host token file ${file} is empty`);
	return token;
}

function log(message: string): void {
	console.error(`host-agent: ${message}`);
}

/** Connect to the shared daemon, retrying with capped backoff. Never starts it. */
async function connectDaemon(port: DaemonPort): Promise<DaemonInfo> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await port.connect();
		} catch (error) {
			const delay = Math.min(30_000, 1_000 * 2 ** attempt);
			log(`daemon not available (${error instanceof Error ? error.message : String(error)}); retrying in ${delay} ms`);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

export async function main(argv: string[]): Promise<void> {
	const at = argv.indexOf("--config");
	const configPath = at >= 0 && argv[at + 1] ? argv[at + 1] : DEFAULT_CONFIG_PATH;
	const config = loadConfig(configPath);
	const token = readToken(config.tokenFile);
	const port = new PrimeDaemonPort(config.daemonSocket, config.primeAgentPackage);

	let daemon: DaemonInfo | null = null;
	const link: HostLink = new HostLink({
		url: config.serviceUrl,
		hostId: config.hostId,
		token,
		gitSha: config.gitSha,
		versions: () => ({ prime_agent_client: daemon?.clientVersion ?? null, prime_agent_daemon: daemon?.daemonVersion ?? null, daemon_protocol: daemon?.protocolVersion ?? null }),
		command: (name, args) => manager.handle(name, args),
		sessions: () => manager.handles(),
		describe: (handle) => manager.describe(handle),
		onStatus: (s) => {
			if (s.state === "closed" || s.state === "refused") manager.clearCalls();
			log(`link ${s.state}${s.reason ? ` (${s.reason})` : ""}${s.epoch !== undefined ? ` epoch ${s.epoch}` : ""}`);
		},
	});
	const manager = new SessionManager({
		port,
		stateFile: path.join(config.stateDir, "sessions.json"),
		emit: (handle, event) => link.publish(handle, event),
	});

	daemon = await connectDaemon(port);
	log(`daemon protocol ${daemon.protocolVersion}, daemon ${daemon.daemonVersion ?? "?"}, client ${daemon.clientVersion ?? "?"}`);
	await manager.resync();

	// The daemon was replaced (desk update or shutdown): reconnect, reattach,
	// and send the service a fresh snapshot of every session still alive.
	port.onClose(() => {
		log("daemon connection closed");
		void (async () => {
			daemon = await connectDaemon(port);
			const { live } = await manager.resync();
			for (const handle of live) await link.sendSnapshot(handle);
		})().catch((error: unknown) => log(`daemon resync failed: ${error instanceof Error ? error.message : String(error)}`));
	});

	const socket = new SkillSocket({
		socketPath: config.skillSocket,
		lookup: (sessionId) => manager.bySessionId(sessionId),
		relay: (handle, callToken, call, args, timeoutMs) => link.relayModuleCall(handle, callToken, call, args, timeoutMs),
	});
	await socket.listen();
	link.start();

	const shutdown = () => {
		link.stop();
		void socket.close().finally(() => {
			port.close();
			process.exit(0);
		});
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		log(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}

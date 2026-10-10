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
	};
}

/**
 * Where the `switchboard` Python skill looks for the host agent. The skill
 * (`skills/switchboard/src/switchboard/__init__.py`, `_socket_path`) has the
 * same path built in and takes no configuration, so neither does this side: a
 * setting the skill cannot follow would only make every call fail as if the
 * host agent were absent.
 */
export const SKILL_SOCKET_PATH = "~/.cache/switchboard/host-agent.sock";

export function readToken(file: string): string {
	const token = readFileSync(file, "utf8").trim();
	if (!token) throw new Error(`host token file ${file} is empty`);
	return token;
}

function log(message: string): void {
	console.error(`host-agent: ${message}`);
}

/** Delay before retry `attempt` (0-based): doubles from `initialMs`, capped at 30 s. */
function backoff(attempt: number, initialMs: number): number {
	return Math.min(30_000, initialMs * 2 ** attempt);
}

/** Connect to the shared daemon, retrying with capped backoff. Never starts it. */
async function connectDaemon(port: DaemonPort, initialMs: number): Promise<DaemonInfo> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await port.connect();
		} catch (error) {
			const delay = backoff(attempt, initialMs);
			log(`daemon not available (${error instanceof Error ? error.message : String(error)}); retrying in ${delay} ms`);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

export interface DaemonKeeperOptions {
	port: DaemonPort;
	manager: SessionManager;
	/** Called for each session a pass reattached, so the service gets a fresh snapshot. */
	onLive: (handle: string) => Promise<void>;
	/** First retry delay; doubles up to 30 s. */
	backoffInitialMs?: number;
}

/**
 * Keeps the daemon connected and every recorded session attached. A pass
 * connects (if the connection was lost) and runs `SessionManager.resync()`.
 * A pass that throws, or that leaves a session the daemon still lists
 * unattached, is retried with the connect backoff: one bad session must not
 * leave the others silent until the host agent restarts (#232). One loop runs
 * at a time; a daemon close during it makes it go round again instead of
 * starting a second one beside it.
 */
export class DaemonKeeper {
	/** What the daemon said at the last connect. */
	info: DaemonInfo | null = null;
	readonly #o: DaemonKeeperOptions;
	readonly #backoffInitialMs: number;
	#connected = false;
	#again = false;
	#running: Promise<void> | null = null;

	constructor(options: DaemonKeeperOptions) {
		this.#o = options;
		this.#backoffInitialMs = options.backoffInitialMs ?? 1_000;
		// The daemon was replaced (desk update or shutdown): reconnect,
		// reattach, and send the service a fresh snapshot of every session
		// still alive.
		options.port.onClose(() => {
			this.#connected = false;
			log("daemon connection closed");
			void this.#run();
		});
	}

	/**
	 * Start keeping; resolves once the first pass has ended, whole or not, so
	 * startup goes on while a session that would not attach is retried. Call
	 * it once, before anything else: the daemon cannot close before it.
	 */
	start(): Promise<void> {
		return new Promise((resolve) => {
			void this.#run(resolve);
		});
	}

	#run(afterFirstPass?: () => void): Promise<void> {
		this.#again = true;
		this.#running ??= (async () => {
			for (let attempt = 0; this.#again; ) {
				this.#again = false;
				let whole = false;
				try {
					whole = await this.#pass();
				} catch (error) {
					log(`daemon resync failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				afterFirstPass?.();
				afterFirstPass = undefined;
				if (whole) {
					attempt = 0;
					continue;
				}
				this.#again = true;
				const delay = backoff(attempt++, this.#backoffInitialMs);
				log(`retrying the daemon resync in ${delay} ms`);
				await new Promise((r) => setTimeout(r, delay));
			}
		})().finally(() => {
			this.#running = null;
		});
		return this.#running;
	}

	/** True when no session the daemon lists was left unattached. */
	async #pass(): Promise<boolean> {
		if (!this.#connected) {
			const info = await connectDaemon(this.#o.port, this.#backoffInitialMs);
			this.info = info;
			this.#connected = true;
			log(`daemon protocol ${info.protocolVersion}, daemon ${info.daemonVersion ?? "?"}, client ${info.clientVersion ?? "?"}`);
		}
		const { live, failed } = await this.#o.manager.resync();
		for (const handle of live) await this.#o.onLive(handle);
		for (const f of failed) log(`could not reattach session ${f.session}: ${f.error}`);
		return failed.length === 0;
	}
}

export async function main(argv: string[]): Promise<void> {
	const at = argv.indexOf("--config");
	const configPath = at >= 0 && argv[at + 1] ? argv[at + 1] : DEFAULT_CONFIG_PATH;
	const config = loadConfig(configPath);
	const token = readToken(config.tokenFile);
	const port = new PrimeDaemonPort(config.daemonSocket, config.primeAgentPackage);

	const link: HostLink = new HostLink({
		url: config.serviceUrl,
		hostId: config.hostId,
		token,
		gitSha: config.gitSha,
		versions: () => ({ prime_agent_client: keeper.info?.clientVersion ?? null, prime_agent_daemon: keeper.info?.daemonVersion ?? null, daemon_protocol: keeper.info?.protocolVersion ?? null }),
		command: (name, args) => manager.handle(name, args),
		sessions: () => manager.handles(),
		describe: (handle) => manager.describe(handle),
		onStatus: (s) => {
			if (s.state === "closed" || s.state === "refused") manager.clearCalls();
			log(`link ${s.state}${s.reason ? ` (${s.reason})` : ""}${s.epoch !== undefined ? ` epoch ${s.epoch}` : ""}`);
		},
		log: (message) => log(`link: ${message}`),
	});
	const manager = new SessionManager({
		port,
		stateFile: path.join(config.stateDir, "sessions.json"),
		emit: (handle, event) => link.publish(handle, event),
	});
	const keeper = new DaemonKeeper({ port, manager, onLive: (handle) => link.sendSnapshot(handle) });
	await keeper.start();

	const socket = new SkillSocket({
		socketPath: expandHome(SKILL_SOCKET_PATH, os.homedir()),
		lookup: (sessionId) => manager.bySessionId(sessionId),
		relay: (handle, callToken, call, args, timeoutMs, turnId, turnCause) => link.relayModuleCall(handle, callToken, call, args, timeoutMs, turnId, turnCause),
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

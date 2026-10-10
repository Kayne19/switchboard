// Keeps the host agent connected to the shared prime-agent daemon and every
// recorded session attached, at start and after the daemon connection drops.
// It never starts a daemon. See docs/host-link.md ("Snapshots").

import type { DaemonInfo, DaemonPort } from "./daemon_port.ts";
import type { SessionManager } from "./sessions.ts";

/** Delay before retry `attempt` (0-based): doubles from `initialMs`, capped at 30 s. */
function backoff(attempt: number, initialMs: number): number {
	return Math.min(30_000, initialMs * 2 ** attempt);
}

/** Connect to the shared daemon, retrying with capped backoff. Never starts it. */
async function connectDaemon(port: DaemonPort, initialMs: number, log: (message: string) => void): Promise<DaemonInfo> {
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
	log: (message: string) => void;
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
			this.#o.log("daemon connection closed");
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
					this.#o.log(`daemon resync failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				afterFirstPass?.();
				afterFirstPass = undefined;
				if (whole) {
					attempt = 0;
					continue;
				}
				this.#again = true;
				const delay = backoff(attempt++, this.#backoffInitialMs);
				this.#o.log(`retrying the daemon resync in ${delay} ms`);
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
			const info = await connectDaemon(this.#o.port, this.#backoffInitialMs, this.#o.log);
			this.info = info;
			this.#connected = true;
			this.#o.log(`daemon protocol ${info.protocolVersion}, daemon ${info.daemonVersion ?? "?"}, client ${info.clientVersion ?? "?"}`);
		}
		const { live, failed } = await this.#o.manager.resync();
		for (const handle of live) await this.#o.onLive(handle);
		for (const f of failed) this.#o.log(`could not reattach session ${f.session}: ${f.error}`);
		return failed.length === 0;
	}
}

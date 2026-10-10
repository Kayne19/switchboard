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

/**
 * Where the keeper is. Every phase but `attached` has work owed, and the
 * keeping loop runs exactly while the phase is not `attached`.
 */
type KeeperPhase =
	/** No daemon connection: before the first connect, or after the daemon closed. */
	| { kind: "disconnected" }
	/** Connected; the whole resync is owed (it has not run on this connection, or it threw). */
	| { kind: "resyncing" }
	/**
	 * Connected; the last pass left these sessions, which the daemon still
	 * lists, unattached. Only they are tried again: the rest are attached
	 * and were snapshotted when they attached.
	 */
	| { kind: "retrying"; unattached: string[] }
	/** Connected, and every session the daemon lists is attached. Nothing is owed until the daemon closes. */
	| { kind: "attached" };

/**
 * What moves the keeper. A pass's outcome names the phase it ran in, so one
 * that ended after the daemon closed is dropped.
 */
type KeeperEvent =
	| { kind: "closed" }
	| { kind: "connected"; at: KeeperPhase }
	/** A resync or reattach ended; `unattached` are the sessions it could not attach. One that threw sends nothing. */
	| { kind: "passed"; at: KeeperPhase; unattached: string[] };

/** The keeper's transitions. Returns `phase` itself for an event that changes nothing. */
function nextPhase(phase: KeeperPhase, event: KeeperEvent): KeeperPhase {
	switch (event.kind) {
		case "closed":
			return phase.kind === "disconnected" ? phase : { kind: "disconnected" };
		case "connected":
			return event.at === phase ? { kind: "resyncing" } : phase;
		case "passed":
			if (event.at !== phase) return phase;
			return event.unattached.length === 0 ? { kind: "attached" } : { kind: "retrying", unattached: event.unattached };
		default:
			return event satisfies never;
	}
}

export interface DaemonKeeperOptions {
	port: DaemonPort;
	manager: SessionManager;
	/** Called for each session a pass newly attached, so the service gets a fresh snapshot. */
	onLive: (handle: string) => Promise<void>;
	/** First retry delay; doubles up to 30 s. */
	backoffInitialMs?: number;
	log: (message: string) => void;
}

/**
 * Keeps the daemon connected and every recorded session attached. On a new
 * connection a pass runs the whole `SessionManager.resync()`. A pass that
 * throws is retried whole; one that leaves a session the daemon still lists
 * unattached is followed by passes that `reattach` only those sessions
 * (#361). Both wait the connect backoff: one bad session must not leave the
 * others silent until the host agent restarts (#232), nor have them
 * reattached and snapshotted again every 30 s. One loop runs at a time,
 * while the phase is not `attached`; a daemon close during it makes it go
 * round again instead of starting a second one beside it.
 */
export class DaemonKeeper {
	/** What the daemon said at the last connect. */
	info: DaemonInfo | null = null;
	readonly #o: DaemonKeeperOptions;
	readonly #backoffInitialMs: number;
	/** Written only by `#step`. */
	#phase: KeeperPhase = { kind: "disconnected" };

	constructor(options: DaemonKeeperOptions) {
		this.#o = options;
		this.#backoffInitialMs = options.backoffInitialMs ?? 1_000;
		// The daemon was replaced (desk update or shutdown): reconnect,
		// reattach, and send the service a fresh snapshot of every session
		// still alive.
		options.port.onClose(() => {
			this.#o.log("daemon connection closed");
			this.#step({ kind: "closed" });
		});
	}

	/**
	 * Start keeping; resolves once the first pass has ended, whole or not, so
	 * startup goes on while a session that would not attach is retried. Call
	 * it once, before anything else: the daemon cannot close before it.
	 */
	start(): Promise<void> {
		return new Promise((resolve) => {
			void this.#keep(resolve);
		});
	}

	/** The one writer of the phase. Leaving `attached` starts the keeping loop again. */
	#step(event: KeeperEvent): void {
		const from = this.#phase;
		this.#phase = nextPhase(from, event);
		if (from.kind === "attached" && this.#phase !== from) void this.#keep();
	}

	/**
	 * Do what the phase owes until it is `attached`. A pass's step and the
	 * check for `attached` run with no await between them, so a daemon close
	 * either lands before the loop ends (and the loop goes round again) or
	 * after (and `#step` starts a new one): never two loops.
	 */
	async #keep(afterFirstPass?: () => void): Promise<void> {
		for (let attempt = 0; ; ) {
			const at = this.#phase;
			switch (at.kind) {
				case "attached":
					return;
				case "disconnected": {
					const info = await connectDaemon(this.#o.port, this.#backoffInitialMs, this.#o.log);
					this.info = info;
					this.#o.log(`daemon protocol ${info.protocolVersion}, daemon ${info.daemonVersion ?? "?"}, client ${info.clientVersion ?? "?"}`);
					this.#step({ kind: "connected", at });
					continue;
				}
				case "resyncing":
				case "retrying": {
					const unattached = await this.#pass(at);
					afterFirstPass?.();
					afterFirstPass = undefined;
					if (unattached !== null) this.#step({ kind: "passed", at, unattached });
					if (unattached?.length === 0) {
						attempt = 0;
						continue;
					}
					const delay = backoff(attempt++, this.#backoffInitialMs);
					this.#o.log(`retrying the daemon resync in ${delay} ms`);
					await new Promise((r) => setTimeout(r, delay));
					continue;
				}
				default:
					at satisfies never;
			}
		}
	}

	/**
	 * Resync, or reattach what would not attach, and snapshot what attached.
	 * Returns the sessions the daemon still lists that would not attach, or
	 * null when the pass threw.
	 */
	async #pass(at: Extract<KeeperPhase, { kind: "resyncing" | "retrying" }>): Promise<string[] | null> {
		try {
			const { live, failed } = at.kind === "retrying" ? await this.#o.manager.reattach(at.unattached) : await this.#o.manager.resync();
			for (const handle of live) await this.#o.onLive(handle);
			for (const f of failed) this.#o.log(`could not reattach session ${f.session}: ${f.error}`);
			return failed.map((f) => f.session);
		} catch (error) {
			this.#o.log(`daemon resync failed: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	}
}

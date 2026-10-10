// The host link: one outbound WebSocket from the host agent to the service.
//
// See docs/host-link.md for every message. In short:
// - hello (host id, token, protocol, versions, boot id) -> welcome | refused;
// - every command carries the link epoch from the welcome; any other epoch
//   is rejected as stale;
// - JSON ping/pong in both directions; a link that misses 3 pongs is dropped;
// - reconnect with capped backoff; on welcome, replay buffered events after
//   the service's cursor per session, or send a fresh snapshot.

import { randomBytes } from "node:crypto";
import { DaemonCommandError } from "./daemon_port.ts";
import { CommandError, type LinkEvent } from "./sessions.ts";

export const HOST_LINK_PROTOCOL = 1;

export type ModuleStatus = "delivered" | "accepted" | "refused" | "failed";
export const MODULE_STATUSES: readonly ModuleStatus[] = ["delivered", "accepted", "refused", "failed"];

export interface ModuleReply {
	status: ModuleStatus;
	reason: string | null;
	result?: unknown;
}

export interface HostLinkStatus {
	state: "connecting" | "linked" | "refused" | "closed";
	reason?: string;
	epoch?: number;
}

/** Minimal surface of a WebSocket client (Node 22's global WebSocket). */
export interface SocketLike {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void;
}

export interface HostLinkOptions {
	url: string;
	hostId: string;
	token: string;
	gitSha: string;
	/** Versions reported in the hello. */
	versions: () => { prime_agent_client: string | null; prime_agent_daemon: string | null; daemon_protocol: number | null };
	/** Runs one command; throws CommandError or DaemonCommandError to refuse. */
	command: (name: string, args: Record<string, unknown>) => Promise<unknown>;
	/** The sessions whose events the service should know about. */
	sessions: () => string[];
	/** Fresh description of one session for a snapshot, or null if it is gone. */
	describe: (handle: string) => Promise<Record<string, unknown> | null>;
	heartbeatMs?: number;
	missedPongLimit?: number;
	backoffInitialMs?: number;
	backoffMaxMs?: number;
	/** Events kept per session for replay. */
	bufferLimit?: number;
	bootId?: string;
	connect?: (url: string) => SocketLike;
	onStatus?: (status: HostLinkStatus) => void;
	/** Says why a frame was dropped or a call could not go out. */
	log?: (message: string) => void;
}

interface Buffered {
	seq: number;
	event: LinkEvent;
}

interface SessionBuffer {
	events: Buffered[];
	/** Highest sequence evicted from the buffer; replay after it is impossible. */
	evictedThrough: number;
}

const OPEN = 1;

/**
 * A JSON.stringify replacer that writes a lone surrogate in a string, a
 * value or a key, as U+FFFD. JSON.stringify would write it as a `\uXXXX` escape, which the
 * service's serde_json refuses, and the whole frame would be lost: an
 * event, a snapshot, or a command's reply (a saved session's first message
 * cut inside an emoji failed a saved-session listing on every try). The skill
 * module refuses a lone surrogate before it sends one, so a relayed call is
 * not changed in practice. (`isWellFormed` and `toWellFormed` are ES2024,
 * in Node since 20; the type library here is ES2023.)
 */
function wellFormed(_key: string, value: unknown): unknown {
	if (typeof value === "string") return mended(value);
	// A key is written as it is, so an object with a key that is not well
	// formed is written as a copy with that key mended (a tool's `args` and
	// `result` keep the keys the daemon gave them). Two keys that mend to
	// one keep the later value, as a JSON object with a repeated key does.
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const keys = Object.keys(value);
		if (keys.some((key) => mended(key) !== key)) {
			return Object.fromEntries(keys.map((key) => [mended(key), (value as Record<string, unknown>)[key]]));
		}
	}
	return value;
}

/** `text` with each lone surrogate written as U+FFFD. */
function mended(text: string): string {
	const wide = text as unknown as { isWellFormed(): boolean; toWellFormed(): string };
	return wide.isWellFormed() ? text : wide.toWellFormed();
}

export function formatCursor(bootId: string, seq: number): string {
	return `${bootId}:${seq}`;
}

export function parseCursor(cursor: unknown): { bootId: string; seq: number } | null {
	if (typeof cursor !== "string") return null;
	const at = cursor.lastIndexOf(":");
	if (at <= 0) return null;
	const seq = Number(cursor.slice(at + 1));
	if (!Number.isSafeInteger(seq) || seq < 0) return null;
	return { bootId: cursor.slice(0, at), seq };
}

function errorOf(error: unknown): { code: string; message: string } {
	if (error instanceof CommandError) return { code: error.code, message: error.message };
	if (error instanceof DaemonCommandError) return { code: error.unsupported ? "unsupported" : "daemon_error", message: error.message };
	return { code: "failed", message: error instanceof Error ? error.message : String(error) };
}

export class HostLink {
	readonly bootId: string;
	readonly #o: Required<Omit<HostLinkOptions, "onStatus" | "bootId" | "log">> & Pick<HostLinkOptions, "onStatus" | "log">;
	#ws: SocketLike | null = null;
	#epoch: number | null = null;
	#seq = 0;
	#buffers = new Map<string, SessionBuffer>();
	/** Events published while a snapshot of the same session is being taken;
	 * they go out after it. */
	#heldBehindSnapshot = new Map<string, Buffered[]>();
	#missed = 0;
	#heartbeat: ReturnType<typeof setInterval> | null = null;
	#reconnect: ReturnType<typeof setTimeout> | null = null;
	#attempt = 0;
	#stopped = true;
	#moduleSeq = 0;
	#pendingModule = new Map<string, { resolve: (r: ModuleReply) => void; timer: ReturnType<typeof setTimeout> }>();

	constructor(options: HostLinkOptions) {
		this.bootId = options.bootId ?? randomBytes(6).toString("hex");
		this.#o = {
			heartbeatMs: 10_000,
			missedPongLimit: 3,
			backoffInitialMs: 1_000,
			backoffMaxMs: 30_000,
			bufferLimit: 1_000,
			connect: (url: string) => new WebSocket(url) as unknown as SocketLike,
			...options,
		};
	}

	/** The epoch of the current link, or null while not linked. */
	get epoch(): number | null {
		return this.#epoch;
	}

	start(): void {
		if (!this.#stopped) return;
		this.#stopped = false;
		this.#dial();
	}

	stop(): void {
		this.#stopped = true;
		if (this.#reconnect) clearTimeout(this.#reconnect);
		this.#reconnect = null;
		const ws = this.#ws;
		this.#teardown(ws, "stopped");
		ws?.close(1000, "stopped");
	}

	/** Record a session event, assign its cursor, and send it if linked. */
	publish(handle: string, event: LinkEvent): string {
		const seq = ++this.#seq;
		let buffer = this.#buffers.get(handle);
		if (!buffer) {
			buffer = { events: [], evictedThrough: 0 };
			this.#buffers.set(handle, buffer);
		}
		buffer.events.push({ seq, event });
		while (buffer.events.length > this.#o.bufferLimit) {
			const dropped = buffer.events.shift() as Buffered;
			buffer.evictedThrough = dropped.seq;
		}
		const held = this.#heldBehindSnapshot.get(handle);
		if (held) held.push({ seq, event });
		else if (this.#epoch !== null) this.#send({ type: "event", session: handle, cursor: formatCursor(this.bootId, seq), event });
		return formatCursor(this.bootId, seq);
	}

	/**
	 * Send a fresh snapshot of one session (after a daemon resync, for
	 * example). The snapshot's cursor is taken before the session is
	 * described, and an event published while it is being described is sent
	 * after it: the service replaces what it knows with a snapshot, so an
	 * event sent before one but not reflected in it would be lost.
	 */
	async sendSnapshot(handle: string): Promise<void> {
		if (this.#heldBehindSnapshot.has(handle)) return;
		const cursor = this.#buffers.get(handle)?.events.at(-1)?.seq ?? this.#seq;
		this.#heldBehindSnapshot.set(handle, []);
		let info: Record<string, unknown> | null = null;
		try {
			info = await this.#o.describe(handle);
		} finally {
			const held = this.#heldBehindSnapshot.get(handle) ?? [];
			this.#heldBehindSnapshot.delete(handle);
			if (this.#epoch !== null) {
				if (info) this.#send({ type: "snapshot", session: handle, cursor: formatCursor(this.bootId, cursor), info });
				for (const b of held) this.#send({ type: "event", session: handle, cursor: formatCursor(this.bootId, b.seq), event: b.event });
			}
		}
	}

	/**
	 * Relay a module call to the service and wait for its reply, bounded. A
	 * call that cannot go out (no link, or a socket already closing) fails at
	 * once rather than at the deadline.
	 */
	relayModuleCall(handle: string, token: string, call: string, args: Record<string, unknown>, timeoutMs: number, turnId?: string | null, turnCause?: string | null): Promise<ModuleReply> {
		if (this.#epoch === null) return Promise.resolve({ status: "failed", reason: "failed" });
		const id = `m${++this.#moduleSeq}`;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.#pendingModule.delete(id);
				resolve({ status: "failed", reason: "failed" });
			}, timeoutMs);
			this.#pendingModule.set(id, { resolve, timer });
			const sent = this.#send({
				type: "module_call",
				id,
				session: handle,
				token,
				call,
				args,
				...(turnId ? { turn_id: turnId } : {}),
				...(turnCause ? { cause: turnCause } : {}),
			});
			if (!sent) {
				this.#log(`module call ${call} not sent: the link's socket is not open`);
				clearTimeout(timer);
				this.#pendingModule.delete(id);
				resolve({ status: "failed", reason: "failed" });
			}
		});
	}

	#status(status: HostLinkStatus): void {
		this.#o.onStatus?.(status);
	}

	#log(message: string): void {
		this.#o.log?.(message);
	}

	/** Sends one frame if the socket is open; says whether it went out. */
	#send(message: Record<string, unknown>): boolean {
		const ws = this.#ws;
		if (!ws || ws.readyState !== OPEN) return false;
		ws.send(JSON.stringify(message, wellFormed));
		return true;
	}

	#dial(): void {
		if (this.#stopped) return;
		this.#status({ state: "connecting" });
		let ws: SocketLike;
		try {
			ws = this.#o.connect(this.#o.url);
		} catch (error) {
			this.#scheduleReconnect(error instanceof Error ? error.message : String(error));
			return;
		}
		this.#ws = ws;
		ws.addEventListener("open", () => {
			if (this.#ws !== ws) return;
			const v = this.#o.versions();
			// The token goes only into this frame; it is never logged.
			ws.send(
				JSON.stringify({
					type: "hello",
					host_id: this.#o.hostId,
					token: this.#o.token,
					protocol: HOST_LINK_PROTOCOL,
					git_sha: this.#o.gitSha,
					boot_id: this.bootId,
					prime_agent: { client_version: v.prime_agent_client, daemon_version: v.prime_agent_daemon, daemon_protocol: v.daemon_protocol },
				}),
			);
		});
		ws.addEventListener("message", (event) => {
			if (this.#ws !== ws) return;
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(String(event.data)) as Record<string, unknown>;
			} catch (error) {
				// Nothing in it can be answered: a command's id is inside.
				this.#log(`dropped a frame from the service that is not JSON (${error instanceof Error ? error.message : String(error)})`);
				return;
			}
			if (typeof message !== "object" || message === null || Array.isArray(message)) {
				this.#log("dropped a frame from the service that is not a JSON object");
				return;
			}
			void this.#onMessage(ws, message);
		});
		ws.addEventListener("close", () => this.#closed(ws, "closed"));
		ws.addEventListener("error", () => this.#closed(ws, "error"));
	}

	#closed(ws: SocketLike, reason: string): void {
		if (this.#ws !== ws) return;
		this.#teardown(ws, reason);
		this.#scheduleReconnect(reason);
	}

	#teardown(ws: SocketLike | null, reason: string): void {
		if (!ws || this.#ws !== ws) return;
		this.#ws = null;
		this.#epoch = null;
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		this.#heartbeat = null;
		for (const [id, p] of this.#pendingModule) {
			clearTimeout(p.timer);
			p.resolve({ status: "failed", reason: "failed" });
			this.#pendingModule.delete(id);
		}
		this.#status({ state: "closed", reason });
	}

	#scheduleReconnect(reason: string): void {
		if (this.#stopped || this.#reconnect) return;
		const delay = Math.min(this.#o.backoffMaxMs, this.#o.backoffInitialMs * 2 ** this.#attempt);
		this.#attempt++;
		this.#reconnect = setTimeout(() => {
			this.#reconnect = null;
			this.#dial();
		}, delay);
		void reason;
	}

	async #onMessage(ws: SocketLike, message: Record<string, unknown>): Promise<void> {
		switch (message.type) {
			case "welcome":
				await this.#welcome(ws, message);
				return;
			case "refused":
				this.#status({ state: "refused", reason: String(message.reason ?? "refused") });
				this.#teardown(ws, `refused: ${String(message.reason ?? "")}`);
				ws.close(1000, "refused");
				this.#scheduleReconnect("refused");
				return;
			case "ping":
				this.#send({ type: "pong" });
				return;
			case "pong":
				this.#missed = 0;
				return;
			case "command":
				await this.#command(ws, message);
				return;
			case "module_reply": {
				const pending = this.#pendingModule.get(String(message.id));
				if (!pending) {
					// Its call already failed at its deadline, or the link it went out on closed.
					this.#log(`dropped a module reply for ${String(message.id)}: no call is waiting for it`);
					return;
				}
				this.#pendingModule.delete(String(message.id));
				clearTimeout(pending.timer);
				const status = message.status as ModuleStatus;
				if (!MODULE_STATUSES.includes(status)) {
					this.#log(`module reply for ${String(message.id)} has no known status (${JSON.stringify(message.status)}); the call failed`);
					pending.resolve({ status: "failed", reason: "failed" });
					return;
				}
				const reply: ModuleReply = { status, reason: typeof message.reason === "string" ? message.reason : null };
				if (message.result !== undefined) reply.result = message.result;
				pending.resolve(reply);
				return;
			}
			default:
				// A frame of a newer service, not acted on.
				this.#log(`ignored a frame of no known type from the service (${JSON.stringify(message.type)})`);
				return;
		}
	}

	async #welcome(ws: SocketLike, message: Record<string, unknown>): Promise<void> {
		const epoch = message.epoch;
		if (typeof epoch !== "number" || !Number.isSafeInteger(epoch)) {
			this.#teardown(ws, "bad welcome");
			ws.close(1002, "bad welcome");
			this.#scheduleReconnect("bad welcome");
			return;
		}
		this.#epoch = epoch;
		this.#attempt = 0;
		this.#missed = 0;
		this.#heartbeat = setInterval(() => this.#beat(ws), this.#o.heartbeatMs);
		this.#status({ state: "linked", epoch });
		const cursors = (message.cursors ?? {}) as Record<string, unknown>;
		const tracked = new Set(this.#o.sessions());
		for (const handle of new Set([...tracked, ...Object.keys(cursors)])) {
			if (this.#ws !== ws) return;
			const cursor = parseCursor(cursors[handle]);
			const buffer = this.#buffers.get(handle);
			const canReplay = cursor !== null && buffer !== undefined && cursor.bootId === this.bootId && cursor.seq >= buffer.evictedThrough;
			if (canReplay) {
				for (const b of buffer.events) {
					if (b.seq > cursor.seq) this.#send({ type: "event", session: handle, cursor: formatCursor(this.bootId, b.seq), event: b.event, replayed: true });
				}
			} else if (tracked.has(handle)) {
				await this.sendSnapshot(handle);
			} else {
				// The service knows a session this host agent no longer tracks.
				const seq = ++this.#seq;
				this.#send({ type: "event", session: handle, cursor: formatCursor(this.bootId, seq), event: { kind: "session_closed", reason: "gone" } });
			}
		}
		if (this.#ws !== ws) return;
		// Buffers of sessions no longer tracked are not needed after a sync.
		for (const handle of [...this.#buffers.keys()]) if (!tracked.has(handle)) this.#buffers.delete(handle);
		this.#send({ type: "synced", epoch });
	}

	#beat(ws: SocketLike): void {
		if (this.#ws !== ws) return;
		if (this.#missed >= this.#o.missedPongLimit) {
			this.#teardown(ws, "heartbeat");
			ws.close(4000, "heartbeat");
			this.#scheduleReconnect("heartbeat");
			return;
		}
		this.#missed++;
		this.#send({ type: "ping" });
	}

	async #command(ws: SocketLike, message: Record<string, unknown>): Promise<void> {
		const id = message.id;
		const epoch = message.epoch;
		const replyEpoch = this.#epoch;
		// A reply goes back on the link the command came from, or nowhere.
		const reply = (body: Record<string, unknown>) => {
			if (this.#ws === ws && this.#epoch === replyEpoch) this.#send(body);
		};
		if (epoch !== this.#epoch) {
			reply({ type: "reply", id, epoch: replyEpoch, ok: false, error: { code: "stale_epoch", message: `epoch ${String(epoch)} is not the current link epoch` } });
			return;
		}
		const name = String(message.name ?? "");
		const args = (message.args ?? {}) as Record<string, unknown>;
		try {
			const result = await this.#o.command(name, args);
			reply({ type: "reply", id, epoch: replyEpoch, ok: true, result: result ?? null });
		} catch (error) {
			reply({ type: "reply", id, epoch: replyEpoch, ok: false, error: errorOf(error) });
		}
	}
}

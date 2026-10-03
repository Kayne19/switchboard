// The skill socket: a local Unix socket the `switchboard` Python module
// talks to. JSON lines, request/response only; the host agent never pushes.
//
// hello {session_id, depth}           -> {on_call: false} | {on_call: true, token, persona, speech_deadline_ms}
// call  {session_id, depth, token, call, args} -> {status, reason, result?}
//
// Delivery is decided here from the session's call state, so the module's
// surface never changes within a session. See docs/host-link.md.

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ModuleReply } from "./link.ts";
import type { CallMode, CallState, TurnCause } from "./sessions.ts";

/** Calls exposed by the installed switchboard skill. */
export const MODULE_CALLS: readonly string[] = ["speak", "request_to_speak", "display", "view"];

/** Longest request line accepted; a longer one closes the connection. */
const MAX_LINE_BYTES = 1024 * 1024;

export interface SkillSocketOptions {
	socketPath: string;
	/** The call and turn state of the tracked session with this persisted id. */
	lookup: (sessionId: string) => { handle: string; call: CallState | null; turnId: string | null; turnCause: TurnCause | null } | null;
	relay: (handle: string, token: string, call: string, args: Record<string, unknown>, timeoutMs: number, turnId: string | null, turnCause: TurnCause | null) => Promise<ModuleReply>;
	/** Relay timeout for calls other than speak (speak uses the speech deadline). */
	relayTimeoutMs?: number;
}

/** What a call does in a mode: relay it to the service, or refuse it here. */
export function decide(mode: CallMode, call: string): "relay" | ModuleReply {
	if (mode === "background") {
		if (call === "speak") return { status: "refused", reason: "caller_away" };
		return "relay";
	}
	// foreground and active: the caller is listening to this session.
	if (call === "request_to_speak") return { status: "refused", reason: "caller_listening" };
	return "relay";
}

export class SkillSocket {
	readonly #o: SkillSocketOptions;
	#server: net.Server | null = null;

	constructor(options: SkillSocketOptions) {
		this.#o = options;
	}

	async listen(): Promise<void> {
		const dir = path.dirname(this.#o.socketPath);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		rmSync(this.#o.socketPath, { force: true });
		const server = net.createServer((conn) => this.#serve(conn));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.#o.socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
		chmodSync(this.#o.socketPath, 0o600);
		this.#server = server;
	}

	async close(): Promise<void> {
		const server = this.#server;
		this.#server = null;
		if (!server) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(this.#o.socketPath, { force: true });
	}

	#serve(conn: net.Socket): void {
		conn.on("error", () => conn.destroy());
		const lines = createInterface({ input: conn, crlfDelay: Number.POSITIVE_INFINITY });
		// Requests on one connection are answered in order.
		let queue = Promise.resolve();
		lines.on("line", (line) => {
			if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
				conn.destroy();
				return;
			}
			// A handler failure answers that one request and leaves the
			// connection's queue alive for the next line.
			queue = queue.then(async () => {
				const reply = await this.handle(line).catch(() => ({ status: "refused", reason: "bad_request" }));
				if (!conn.destroyed) conn.write(`${JSON.stringify(reply)}\n`);
			});
		});
	}

	/** Answer one request line. Never throws. */
	async handle(line: string): Promise<Record<string, unknown>> {
		let request: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			// JSON.parse accepts `null`, numbers and arrays; a request is an object.
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				return { status: "refused", reason: "bad_request" };
			}
			request = parsed as Record<string, unknown>;
		} catch {
			return { status: "refused", reason: "bad_request" };
		}
		const op = request.op;
		const sessionId = typeof request.session_id === "string" ? request.session_id : "";
		const depth = request.depth;
		if (op !== "hello" && op !== "call") return { status: "refused", reason: "bad_request" };
		if (depth !== 0) {
			return op === "hello" ? { on_call: false, reason: "subagent" } : { status: "refused", reason: "subagent" };
		}
		const session = sessionId ? this.#o.lookup(sessionId) : null;
		const call = session?.call ?? null;
		if (op === "hello") {
			if (!call) return { on_call: false };
			return { on_call: true, token: call.token, persona: call.persona, speech_deadline_ms: call.speechDeadlineMs };
		}
		const name = typeof request.call === "string" ? request.call : "";
		if (!MODULE_CALLS.includes(name)) return { status: "refused", reason: "unknown_call" };
		// A missing call, or a token from an earlier call, is not this call.
		if (!session || !call || request.token !== call.token) return { status: "refused", reason: "not_on_call" };
		const decision = decide(call.mode, name);
		if (decision !== "relay") return { ...decision };
		const args = request.args && typeof request.args === "object" ? (request.args as Record<string, unknown>) : {};
		const timeoutMs = name === "speak" ? call.speechDeadlineMs : (this.#o.relayTimeoutMs ?? 30_000);
		try {
			const reply = await this.#o.relay(session.handle, call.token, name, args, timeoutMs, session.turnId, session.turnCause);
			return { ...reply };
		} catch {
			return { status: "failed", reason: "failed" };
		}
	}
}

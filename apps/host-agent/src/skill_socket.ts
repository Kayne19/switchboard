// The skill socket: a local Unix socket the `switchboard` Python module
// talks to. JSON lines, request/response only; the host agent never pushes.
//
// hello {session_id, depth}           -> {on_call: false} | {on_call: true, token, persona, speech_deadline_ms}
// call  {session_id, depth, token, call, args} -> {status, reason, result?}
//
// The calls the session's call state settles (speak in the background,
// request_to_speak in front) are refused here; display and view are relayed,
// and the service decides them. The module's surface never changes within a
// session. See docs/host-link.md, "Delivery".

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { ModuleReply } from "./link.ts";
import type { CallMode, CallState, TurnCause } from "./sessions.ts";

/** Calls exposed by the installed switchboard skill. */
export const MODULE_CALLS: readonly string[] = ["speak", "request_to_speak", "display", "view"];

/**
 * Longest request line accepted, in bytes before its newline. An image
 * display action may be 12 MiB (MAX_IMAGE_ACTION_BYTES in the service), so a
 * line may carry that and 1 MiB more for its envelope. The relay re-wraps the
 * args in a module_call frame of its own, and the host link refuses frames
 * over 16 MiB (MAX_HOST_FRAME_BYTES in hosts.rs) by dropping the whole link,
 * so the cap stays well under that: a line this accepts always fits a frame.
 * A longer line is answered `refused`, `too_large`, as soon as it passes the
 * cap, its rest is dropped as it arrives, and the connection ends with it.
 * scripts/check_hygiene.mjs checks both margins: 1 MiB over the image action
 * cap, and 1 MiB under the host link's frame cap.
 */
export const MAX_LINE_BYTES = 13 * 1024 * 1024;

/** The answer to a request line longer than MAX_LINE_BYTES. */
const TOO_LARGE = { status: "refused", reason: "too_large" } as const;

/**
 * The most requests one connection may have read and not yet answered, the
 * one being handled included, and the most bytes of request text they may
 * hold together (one line's cap). The module writes a request and waits for
 * its answer, so it never has more than one waiting; a client that writes
 * more without reading is refused rather than held. Without the bound a
 * connection could queue any number of 13 MiB lines behind a call waiting
 * on the service (up to its 30 s relay timeout), and each one was held.
 */
export const MAX_WAITING_REQUESTS = 8;

/** The answer to a request past MAX_WAITING_REQUESTS or the bytes they may hold. */
const QUEUE_FULL = { status: "refused", reason: "queue_full" } as const;

/**
 * How much longer than the speech deadline a relayed `speak` waits for the
 * service's answer. The service starts its own deadline only when it admits
 * the call, after the frame has crossed the link and waited for the session's
 * frame loop, and answers `delivered` when the whole line has played. If this
 * side gave up at the deadline itself, a line the caller heard to the end
 * could be reported `failed`, and the agent would say it again. With the
 * margin the service's answer decides. The module waits one margin more than
 * this (`_SPEAK_MARGIN_S` in skills/switchboard/src/switchboard/__init__.py);
 * scripts/check_hygiene.mjs keeps the two in step.
 */
export const SPEAK_REPLY_MARGIN_MS = 5_000;

export interface SkillSocketOptions {
	socketPath: string;
	/** The call and turn state of the tracked session with this persisted id. */
	lookup: (sessionId: string) => { handle: string; call: CallState | null; turnId: string | null; turnCause: TurnCause | null } | null;
	relay: (handle: string, token: string, call: string, args: Record<string, unknown>, timeoutMs: number, turnId: string | null, turnCause: TurnCause | null) => Promise<ModuleReply>;
	/** Relay timeout for calls other than speak (speak uses the speech deadline and SPEAK_REPLY_MARGIN_MS). */
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
		// Requests on one connection are answered in order.
		let queue = Promise.resolve();
		const answer = (reply: unknown) => {
			if (!conn.destroyed) conn.write(`${JSON.stringify(reply)}\n`);
		};
		// The line still open: its bytes so far, never more than the cap. The
		// cap is checked as the bytes arrive, not once the line is whole.
		// readline used to hold a line until its newline however long it
		// grew: 64 MiB with no newline was 64 MiB held here, and 600 MiB
		// passed V8's longest string and ended the process, and with it every
		// session on the host.
		let open: Buffer[] = [];
		let openBytes = 0;
		// Set once the open line passes the cap: the rest of it is read and
		// dropped as it arrives, and the connection ends where it does.
		let refused = false;
		let ended = false;
		// The requests read and not yet answered, and their bytes.
		let waiting = 0;
		let waitingBytes = 0;
		conn.on("data", (chunk: Buffer) => {
			let from = 0;
			while (!ended && from < chunk.length) {
				const newline = chunk.indexOf(0x0a, from);
				const to = newline < 0 ? chunk.length : newline;
				if (!refused) {
					openBytes += to - from;
					if (openBytes > MAX_LINE_BYTES) {
						// Answered in its turn, without waiting for the newline.
						// The connection stays open to the end of the line: the
						// module writes a line whole before it reads the answer,
						// and a socket closed under that write would lose it.
						refused = true;
						open = [];
						queue = queue.then(() => answer(TOO_LARGE));
					} else if (to > from) {
						open.push(chunk.subarray(from, to));
					}
				}
				if (newline < 0) return;
				from = newline + 1;
				if (refused) {
					// Lines after the refused one are not read.
					ended = true;
					queue = queue.then(() => {
						if (!conn.destroyed) conn.end(() => conn.destroy());
					});
					return;
				}
				const bytes = openBytes;
				if (waiting >= MAX_WAITING_REQUESTS || waitingBytes + bytes > MAX_LINE_BYTES) {
					// Refused in its turn, and the connection ends after the
					// answer; lines after it are not read.
					ended = true;
					queue = queue.then(() => {
						answer(QUEUE_FULL);
						if (!conn.destroyed) conn.end(() => conn.destroy());
					});
					return;
				}
				// A line ends at "\n"; a "\r" before it is part of the break.
				const line = Buffer.concat(open, openBytes).toString("utf8").replace(/\r$/, "");
				open = [];
				openBytes = 0;
				waiting += 1;
				waitingBytes += bytes;
				// A handler failure answers that one request and leaves the
				// connection's queue alive for the next line.
				queue = queue.then(async () => {
					answer(await this.handle(line).catch(() => ({ status: "refused", reason: "bad_request" })));
					waiting -= 1;
					waitingBytes -= bytes;
				});
			}
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
		const timeoutMs = name === "speak" ? call.speechDeadlineMs + SPEAK_REPLY_MARGIN_MS : (this.#o.relayTimeoutMs ?? 30_000);
		try {
			const reply = await this.#o.relay(session.handle, call.token, name, args, timeoutMs, session.turnId, session.turnCause);
			return { ...reply };
		} catch {
			return { status: "failed", reason: "failed" };
		}
	}
}

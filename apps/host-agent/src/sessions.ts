// Session operations on the shared prime-agent daemon, with provenance.
//
// The host agent tracks the sessions it created (`created`) and, later, the
// desk sessions it took over (`taken_over`) in a state file, so a restart keeps
// provenance. It never kills a session it did not create.
//
// Turn rules (docs/host-agent.md, "Settled turn"):
// - a turn is settled when `wait_for_idle`, sent after the last input for that
//   session, resolves; `agent_end` is only "a run ended";
// - an `agent_start` that no input caused opens a turn;
// - `resume_queue` follows every abort;
// - a busy session gets `follow_up` (or `steer`), never `prompt`.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DaemonCommandError, type DaemonEvent, type DaemonPort, type DaemonSession, type SessionConfig } from "./daemon_port.ts";

export type Provenance = "created" | "taken_over";
export type CallMode = "foreground" | "background" | "active";
export const CALL_MODES: readonly CallMode[] = ["foreground", "background", "active"];
export const SESSION_NAME_PREFIX = "sb-";

export interface CallState {
	token: string;
	persona: string;
	speechDeadlineMs: number;
	mode: CallMode;
}

/** A session event body as sent on the host link (`event` field). */
export type LinkEvent = { kind: string; [key: string]: unknown };

/** A command the host agent refuses or cannot run. `code` goes on the wire. */
export class CommandError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "CommandError";
		this.code = code;
	}
}

interface Tracked {
	handle: string;
	sessionId: string;
	name: string | null;
	project: string;
	cwd: string;
	provenance: Provenance;
	turnOpen: boolean;
	/** Inputs sent so far; a wait_for_idle settles only if none came after it. */
	inputs: number;
	/** Inputs in flight, so an agent_start they cause is not taken as autonomous. */
	pending: number;
	call: CallState | null;
	last: DaemonSession | null;
}

interface StateFile {
	version: 1;
	sessions: { handle: string; session_id: string; name: string | null; project: string; cwd: string; provenance: Provenance }[];
	used_names: string[];
}

export interface SessionManagerOptions {
	port: DaemonPort;
	stateFile: string;
	/** Receives every session event; the host link buffers and sends it. */
	emit: (handle: string, event: LinkEvent) => void;
	/** Short id for minted names; random 8 hex digits by default. */
	shortId?: () => string;
}

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function requireString(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || value === "") throw new CommandError("bad_request", `missing string argument: ${key}`);
	return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new CommandError("bad_request", `argument must be a string: ${key}`);
	return value;
}

function textOf(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => (c as Record<string, unknown>)?.type === "text")
		.map((c) => String((c as Record<string, unknown>).text ?? ""))
		.join("");
}

function modelLabel(s: DaemonSession | null): string | null {
	return s?.model ? `${s.model.provider}/${s.model.id}` : null;
}

export class SessionManager {
	readonly #port: DaemonPort;
	readonly #stateFile: string;
	readonly #emit: (handle: string, event: LinkEvent) => void;
	readonly #shortId: () => string;
	readonly #tracked = new Map<string, Tracked>();
	readonly #usedNames = new Set<string>();

	constructor(options: SessionManagerOptions) {
		this.#port = options.port;
		this.#stateFile = options.stateFile;
		this.#emit = options.emit;
		this.#shortId = options.shortId ?? (() => randomBytes(4).toString("hex"));
		this.#port.onEvent((e) => this.#onDaemonEvent(e));
	}

	/** Handles of the sessions this host agent tracks. */
	handles(): string[] {
		return [...this.#tracked.keys()];
	}

	/** The tracked session whose persisted id is `sessionId` (the skill socket's key). */
	bySessionId(sessionId: string): { handle: string; call: CallState | null } | null {
		for (const t of this.#tracked.values()) if (t.sessionId === sessionId) return { handle: t.handle, call: t.call };
		return null;
	}

	/**
	 * Load provenance from the state file and reattach to every recorded
	 * session the daemon still has. Used at start and after the daemon
	 * connection was replaced. Returns the sessions kept and the ones gone.
	 */
	async resync(): Promise<{ live: string[]; closed: string[] }> {
		const state = this.#readState();
		for (const n of state.used_names) this.#usedNames.add(n);
		const recorded = new Map(state.sessions.map((s) => [s.handle, s]));
		for (const [handle, t] of this.#tracked) if (!recorded.has(handle)) recorded.set(handle, { handle, session_id: t.sessionId, name: t.name, project: t.project, cwd: t.cwd, provenance: t.provenance });
		const live = new Set((await this.#port.list()).map((s) => s.handle));
		const kept: string[] = [];
		const closed: string[] = [];
		for (const rec of recorded.values()) {
			if (!live.has(rec.handle)) {
				if (this.#tracked.delete(rec.handle)) this.#emit(rec.handle, { kind: "session_closed", reason: "gone" });
				closed.push(rec.handle);
				continue;
			}
			const snapshot = await this.#port.attach(rec.handle);
			const previous = this.#tracked.get(rec.handle);
			const t: Tracked = previous ?? {
				handle: rec.handle,
				sessionId: rec.session_id,
				name: rec.name,
				project: rec.project,
				cwd: rec.cwd,
				provenance: rec.provenance,
				turnOpen: false,
				inputs: 0,
				pending: 0,
				call: null,
				last: null,
			};
			t.last = snapshot;
			this.#tracked.set(rec.handle, t);
			// Rebuilt from the daemon snapshot: a busy session has an open turn.
			if (snapshot.busy && !t.turnOpen) this.#openTurn(t, "autonomous");
			if (t.turnOpen) this.#settle(t);
			kept.push(rec.handle);
		}
		this.#writeState();
		return { live: kept, closed };
	}

	/** Wire-level description of a tracked session, used in snapshots and replies. */
	async describe(handle: string, fresh = true): Promise<Record<string, unknown> | null> {
		const t = this.#tracked.get(handle);
		if (!t) return null;
		if (fresh) {
			try {
				const state = await this.#port.getState(handle);
				t.last = { ...state, lastText: state.lastText ?? t.last?.lastText ?? null };
			} catch {
				// Keep the last known state; the snapshot says what it knows.
			}
		}
		return this.#info(t);
	}

	#info(t: Tracked): Record<string, unknown> {
		return {
			session: t.handle,
			session_id: t.sessionId,
			name: t.name,
			project: t.project,
			cwd: t.cwd,
			provenance: t.provenance,
			busy: t.turnOpen || (t.last?.busy ?? false),
			turn_open: t.turnOpen,
			model: modelLabel(t.last),
			thinking: t.last?.thinking ?? null,
			call_mode: t.call?.mode ?? null,
			last_text: t.last?.lastText ?? null,
		};
	}

	// -- commands ----------------------------------------------------------

	/** Dispatch one host-link command. Throws CommandError or DaemonCommandError. */
	async handle(name: string, args: Record<string, unknown>): Promise<unknown> {
		switch (name) {
			case "create_session":
				return this.createSession(requireString(args, "project"), (args.config ?? {}) as Record<string, unknown>);
			case "open_session":
				return this.openSession(requireString(args, "session_id"), optionalString(args, "project"));
			case "list_sessions":
				return this.listSessions();
			case "list_saved_sessions":
				return this.listSavedSessions(requireString(args, "cwd"), optionalString(args, "project"));
			case "prompt":
				return this.prompt(requireString(args, "session"), requireString(args, "message"));
			case "steer":
				return this.input(requireString(args, "session"), "steer", requireString(args, "message"));
			case "follow_up":
				return this.input(requireString(args, "session"), "follow_up", requireString(args, "message"));
			case "abort":
				return this.abort(requireString(args, "session"));
			case "kill":
				return this.kill(requireString(args, "session"));
			case "detach":
				return this.detach(requireString(args, "session"));
			case "join_call":
				return this.joinCall(requireString(args, "session"), args);
			case "leave_call":
				return this.leaveCall(requireString(args, "session"));
			case "set_mode":
				return this.setMode(requireString(args, "session"), requireString(args, "mode"));
			case "set_model":
				return this.setModel(requireString(args, "session"), requireString(args, "provider"), requireString(args, "model"));
			case "set_thinking":
				return this.setThinking(requireString(args, "session"), requireString(args, "level"));
			case "list_models":
				return { models: await this.#port.listModels() };
			case "run_prepare":
				return runPrepare({
					cwd: requireString(args, "cwd"),
					command: requireString(args, "command"),
					timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
				});
			default:
				throw new CommandError("unknown_command", `unknown command: ${name}`);
		}
	}

	#mint(project: string): string {
		for (let i = 0; i < 100; i++) {
			const name = `${SESSION_NAME_PREFIX}${project}-${this.#shortId()}`;
			if (!this.#usedNames.has(name)) return name;
		}
		throw new CommandError("failed", "could not mint an unused session name");
	}

	async createSession(project: string, rawConfig: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (!PROJECT_RE.test(project)) throw new CommandError("bad_request", `invalid project id: ${project}`);
		const config: SessionConfig = { cwd: requireString(rawConfig, "cwd") };
		const provider = optionalString(rawConfig, "provider");
		const model = optionalString(rawConfig, "model");
		const thinking = optionalString(rawConfig, "thinking");
		if (provider) config.provider = provider;
		if (model) config.model = model;
		if (thinking) config.thinking = thinking;
		// The tool policy keeps ipython: no noBuiltinTools, no tools list, and
		// no appendSystemPrompt (it would replace the project's APPEND_SYSTEM.md).
		for (const s of await this.#port.list()) if (s.name) this.#usedNames.add(s.name);
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			const name = this.#mint(project);
			this.#usedNames.add(name);
			this.#writeState();
			try {
				const created = await this.#port.create({ lifecycle: "resident", name, config });
				return this.#adopt(created, project, config.cwd, "created");
			} catch (error) {
				// Names are unique for ever; a taken name only costs a new id.
				if (error instanceof DaemonCommandError && /unavailable|already exists/i.test(error.message)) {
					lastError = error;
					continue;
				}
				throw error;
			}
		}
		throw lastError;
	}

	async openSession(sessionId: string, project: string | undefined): Promise<Record<string, unknown>> {
		for (const t of this.#tracked.values()) if (t.sessionId === sessionId) return this.#info(t);
		const opened = await this.#port.open(sessionId);
		const name = opened.name ?? "";
		const expected = project ? `${SESSION_NAME_PREFIX}${project}-` : SESSION_NAME_PREFIX;
		if (!name.startsWith(expected)) {
			throw new CommandError("refused", `session ${sessionId} (${name || "unnamed"}) was not created by the switchboard`);
		}
		const projectId = project ?? name.slice(SESSION_NAME_PREFIX.length).replace(/-[^-]+$/, "");
		return this.#adopt(opened, projectId, opened.cwd, "created");
	}

	async #adopt(session: DaemonSession, project: string, cwd: string, provenance: Provenance): Promise<Record<string, unknown>> {
		const snapshot = await this.#port.attach(session.handle);
		const t: Tracked = {
			handle: session.handle,
			sessionId: session.sessionId || snapshot.sessionId,
			name: session.name ?? snapshot.name,
			project,
			cwd: session.cwd || cwd,
			provenance,
			turnOpen: false,
			inputs: 0,
			pending: 0,
			call: null,
			last: { ...session, lastText: snapshot.lastText ?? null },
		};
		if (t.name) this.#usedNames.add(t.name);
		this.#tracked.set(t.handle, t);
		this.#writeState();
		return this.#info(t);
	}

	async listSessions(): Promise<{ sessions: Record<string, unknown>[] }> {
		const live = await this.#port.list();
		return {
			sessions: live
				.filter((s) => s.depth === 0)
				.map((s) => {
					const t = this.#tracked.get(s.handle);
					return {
						session: s.handle,
						session_id: s.sessionId,
						name: s.name,
						cwd: s.cwd,
						busy: s.busy || (t?.turnOpen ?? false),
						provenance: t?.provenance ?? null,
						project: t?.project ?? null,
						model: modelLabel(s),
						thinking: s.thinking,
					};
				}),
		};
	}

	async listSavedSessions(cwd: string, project: string | undefined): Promise<{ sessions: Record<string, unknown>[] }> {
		const prefix = project ? `${SESSION_NAME_PREFIX}${project}-` : null;
		const saved = await this.#port.listSaved(cwd);
		return {
			sessions: saved
				.filter((s) => prefix === null || (s.name ?? "").startsWith(prefix))
				.map((s) => ({
					session_id: s.sessionId,
					path: s.path,
					name: s.name,
					cwd: s.cwd,
					modified: s.modified,
					message_count: s.messageCount,
					first_message: s.firstMessage,
				})),
		};
	}

	#get(handle: string): Tracked {
		const t = this.#tracked.get(handle);
		if (!t) throw new CommandError("not_found", `session ${handle} is not tracked by this host agent`);
		return t;
	}

	async prompt(handle: string, message: string): Promise<{ sent_as: string }> {
		const t = this.#get(handle);
		if (t.turnOpen) return this.input(handle, "follow_up", message);
		try {
			return await this.#send(t, "prompt", () => this.#port.prompt(handle, message));
		} catch (error) {
			// The session got busy under us (a run we have not seen start yet).
			if (error instanceof DaemonCommandError && /already processing/i.test(error.message)) return this.input(handle, "follow_up", message);
			throw error;
		}
	}

	async input(handle: string, kind: "steer" | "follow_up", message: string): Promise<{ sent_as: string }> {
		const t = this.#get(handle);
		return this.#send(t, kind, () => (kind === "steer" ? this.#port.steer(handle, message) : this.#port.followUp(handle, message)));
	}

	async #send(t: Tracked, kind: string, send: () => Promise<void>): Promise<{ sent_as: string }> {
		t.pending++;
		try {
			await send();
		} finally {
			t.pending--;
		}
		if (!t.turnOpen) this.#openTurn(t, "input");
		this.#settle(t);
		return { sent_as: kind };
	}

	async abort(handle: string): Promise<{ aborted: true }> {
		const t = this.#get(handle);
		await this.#port.abort(handle);
		// Abort suspends queued input until resume_queue; its "No queued work
		// to resume" error is expected and ignored.
		try {
			await this.#port.resumeQueue(handle);
		} catch {
			// ignored on purpose
		}
		if (t.turnOpen) this.#settle(t);
		return { aborted: true };
	}

	async kill(handle: string): Promise<{ killed: true }> {
		const t = this.#tracked.get(handle);
		if (!t) throw new CommandError("refused", `session ${handle} was not created by the switchboard`);
		if (t.provenance !== "created") throw new CommandError("refused", `session ${handle} was taken over; it can only be detached`);
		await this.#port.kill(handle);
		this.#untrack(t, "killed");
		return { killed: true };
	}

	async detach(handle: string): Promise<{ detached: true }> {
		const t = this.#get(handle);
		t.call = null;
		await this.#port.detach(handle);
		this.#untrack(t, "detached");
		return { detached: true };
	}

	#untrack(t: Tracked, reason: string): void {
		this.#tracked.delete(t.handle);
		t.turnOpen = false;
		t.call = null;
		this.#writeState();
		this.#emit(t.handle, { kind: "session_closed", reason });
	}

	joinCall(handle: string, args: Record<string, unknown>): { on_call: true; mode: CallMode } {
		const t = this.#get(handle);
		const mode = (optionalString(args, "mode") ?? "foreground") as CallMode;
		if (!CALL_MODES.includes(mode)) throw new CommandError("bad_request", `invalid mode: ${mode}`);
		const deadline = args.speech_deadline_ms;
		if (typeof deadline !== "number" || !(deadline > 0)) throw new CommandError("bad_request", "speech_deadline_ms must be a positive number");
		t.call = { token: requireString(args, "token"), persona: optionalString(args, "persona") ?? "", speechDeadlineMs: deadline, mode };
		return { on_call: true, mode };
	}

	leaveCall(handle: string): { on_call: false } {
		this.#get(handle).call = null;
		return { on_call: false };
	}

	setMode(handle: string, mode: string): { mode: CallMode } {
		const t = this.#get(handle);
		if (!CALL_MODES.includes(mode as CallMode)) throw new CommandError("bad_request", `invalid mode: ${mode}`);
		if (!t.call) throw new CommandError("refused", `session ${handle} is not on a call`);
		t.call.mode = mode as CallMode;
		return { mode: t.call.mode };
	}

	async setModel(handle: string, provider: string, model: string): Promise<Record<string, unknown>> {
		this.#get(handle);
		await this.#port.setModel(handle, provider, model);
		return this.#reportState(handle);
	}

	async setThinking(handle: string, level: string): Promise<Record<string, unknown>> {
		this.#get(handle);
		await this.#port.setThinking(handle, level);
		return this.#reportState(handle);
	}

	/** Read back model and effective (clamped) thinking level and report them. */
	async #reportState(handle: string): Promise<Record<string, unknown>> {
		const t = this.#get(handle);
		const state = await this.#port.getState(handle);
		t.last = { ...state, lastText: t.last?.lastText ?? null };
		const report = { model: modelLabel(state), thinking: state.thinking };
		this.#emit(handle, { kind: "state", ...report });
		return report;
	}

	// -- turns and events --------------------------------------------------

	#openTurn(t: Tracked, cause: "input" | "autonomous"): void {
		t.turnOpen = true;
		this.#emit(t.handle, { kind: "turn_start", cause });
	}

	/** Send wait_for_idle after the latest input; settle only if it is still the latest. */
	#settle(t: Tracked): void {
		const mark = ++t.inputs;
		this.#port.waitForIdle(t.handle).then(
			() => {
				if (this.#tracked.get(t.handle) !== t || t.inputs !== mark || !t.turnOpen) return;
				t.turnOpen = false;
				if (t.last) t.last = { ...t.last, busy: false };
				this.#emit(t.handle, { kind: "turn_end" });
			},
			(error: unknown) => {
				if (this.#tracked.get(t.handle) !== t || t.inputs !== mark || !t.turnOpen) return;
				t.turnOpen = false;
				this.#emit(t.handle, { kind: "turn_end", error: error instanceof Error ? error.message : String(error) });
			},
		);
	}

	#onDaemonEvent({ handle, event }: DaemonEvent): void {
		const t = this.#tracked.get(handle);
		if (!t) return;
		switch (event.type) {
			case "agent_start":
				if (!t.turnOpen) {
					this.#openTurn(t, t.pending > 0 ? "input" : "autonomous");
					if (t.pending === 0) this.#settle(t);
				}
				return;
			case "tool_execution_start":
				this.#emit(handle, { kind: "tool_start", tool: event.toolName ?? null, call_id: event.toolCallId ?? null });
				return;
			case "tool_execution_end":
				this.#emit(handle, { kind: "tool_end", tool: event.toolName ?? null, call_id: event.toolCallId ?? null, error: event.isError === true });
				return;
			case "message_end": {
				const message = (event.message ?? {}) as Record<string, unknown>;
				if (message.role !== "assistant") return;
				const text = textOf(message);
				if (text) {
					this.#emit(handle, { kind: "text", text });
					if (t.last) t.last = { ...t.last, lastText: text };
				}
				if (message.stopReason === "error") this.#emit(handle, { kind: "error", message: String(message.errorMessage ?? "model error") });
				return;
			}
			case "compaction_start":
			case "compaction_end":
				this.#emit(handle, { kind: "compaction", phase: event.type === "compaction_start" ? "start" : "end", reason: event.reason ?? null });
				return;
			case "auto_retry_end":
				if (event.success === false) this.#emit(handle, { kind: "error", message: String(event.finalError ?? "retries exhausted") });
				return;
			default:
				return;
		}
	}

	// -- state file ----------------------------------------------------------

	#readState(): StateFile {
		try {
			const raw = JSON.parse(readFileSync(this.#stateFile, "utf8")) as Partial<StateFile>;
			return { version: 1, sessions: Array.isArray(raw.sessions) ? raw.sessions : [], used_names: Array.isArray(raw.used_names) ? raw.used_names : [] };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessions: [], used_names: [] };
			throw error;
		}
	}

	#writeState(): void {
		const state: StateFile = {
			version: 1,
			sessions: [...this.#tracked.values()].map((t) => ({ handle: t.handle, session_id: t.sessionId, name: t.name, project: t.project, cwd: t.cwd, provenance: t.provenance })),
			used_names: [...this.#usedNames],
		};
		mkdirSync(path.dirname(this.#stateFile), { recursive: true, mode: 0o700 });
		const tmp = `${this.#stateFile}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, this.#stateFile);
	}
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

/** Output kept per stream; the tail is kept, the head dropped. */
export const PREPARE_OUTPUT_LIMIT = 16 * 1024;
export const PREPARE_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface PrepareResult {
	outcome: "succeeded" | "failed" | "timed_out";
	exit_code: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	duration_ms: number;
}

class Tail {
	#chunks: Buffer[] = [];
	#size = 0;
	truncated = false;
	push(chunk: Buffer): void {
		this.#chunks.push(chunk);
		this.#size += chunk.length;
		while (this.#size > PREPARE_OUTPUT_LIMIT) {
			const extra = this.#size - PREPARE_OUTPUT_LIMIT;
			const head = this.#chunks[0];
			this.truncated = true;
			if (head.length <= extra) {
				this.#chunks.shift();
				this.#size -= head.length;
			} else {
				this.#chunks[0] = head.subarray(extra);
				this.#size -= extra;
			}
		}
	}
	text(): string {
		return Buffer.concat(this.#chunks).toString("utf8");
	}
}

/** Run a project's prepare command with `sh -c` in its folder, bounded in output and time. */
export function runPrepare(options: { cwd: string; command: string; timeoutMs?: number }): Promise<PrepareResult> {
	const timeoutMs = options.timeoutMs ?? PREPARE_DEFAULT_TIMEOUT_MS;
	const started = Date.now();
	return new Promise((resolve) => {
		const stdout = new Tail();
		const stderr = new Tail();
		let timedOut = false;
		const child = spawn("sh", ["-c", options.command], { cwd: options.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", (c: Buffer) => stdout.push(c));
		child.stderr.on("data", (c: Buffer) => stderr.push(c));
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				// Kill the whole process group, not only the shell.
				process.kill(-(child.pid as number), "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, timeoutMs);
		const finish = (code: number | null, signal: string | null, spawnError?: Error) => {
			clearTimeout(timer);
			resolve({
				outcome: timedOut ? "timed_out" : code === 0 ? "succeeded" : "failed",
				exit_code: code,
				signal,
				stdout: stdout.text(),
				stderr: spawnError ? spawnError.message : stderr.text(),
				truncated: stdout.truncated || stderr.truncated,
				duration_ms: Date.now() - started,
			});
		};
		child.on("error", (error) => finish(null, null, error));
		child.on("close", (code, signal) => finish(code, signal));
	});
}

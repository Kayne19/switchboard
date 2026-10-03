// An in-process fake of the prime-agent daemon behind DaemonPort.
import {
	type CreateRequest,
	DaemonCommandError,
	type DaemonEvent,
	type DaemonInfo,
	type DaemonPort,
	type DaemonSession,
	type ModelInfo,
	type SavedSession,
} from "../src/daemon_port.ts";

export interface Call {
	op: string;
	args: unknown[];
}

export class FakeDaemon implements DaemonPort {
	calls: Call[] = [];
	live = new Map<string, DaemonSession>();
	saved = new Map<string, DaemonSession>();
	/** Names ever used; the daemon never frees a name. */
	names = new Set<string>();
	/** Operations this daemon reports as unsupported. */
	unsupported = new Set<string>();
	/** Pending wait_for_idle resolvers per handle. */
	idleWaiters = new Map<string, (() => void)[]>();
	/** When set, prompt fails as the daemon does on a busy session. */
	busy = new Set<string>();
	models: ModelInfo[] = [{ provider: "anthropic", id: "claude-x", name: "Claude X", reasoning: true }];
	#events = new Set<(e: DaemonEvent) => void>();
	#closes = new Set<(e: Error) => void>();
	#next = 1;

	#record(op: string, ...args: unknown[]): void {
		this.calls.push({ op, args });
		if (this.unsupported.has(op)) throw new DaemonCommandError(op, `capability for ${op} is unavailable`, true);
	}

	ops(): string[] {
		return this.calls.map((c) => c.op);
	}

	#session(handle: string): DaemonSession {
		const s = this.live.get(handle);
		if (!s) throw new DaemonCommandError("session", `Unknown session ${handle}`);
		return s;
	}

	/** Add a live session the host agent did not create (a desk session). */
	addLive(partial: Partial<DaemonSession> & { handle: string }): DaemonSession {
		const s: DaemonSession = { sessionId: `sid-${partial.handle}`, name: null, cwd: "/work", busy: false, model: null, thinking: "medium", depth: 0, ...partial };
		this.live.set(s.handle, s);
		if (s.name) this.names.add(s.name);
		return s;
	}

	emit(handle: string, event: DaemonEvent["event"]): void {
		for (const l of this.#events) l({ handle, event });
	}

	/** Resolve every pending wait_for_idle for a session. */
	idle(handle: string): number {
		const waiters = this.idleWaiters.get(handle) ?? [];
		this.idleWaiters.delete(handle);
		for (const w of waiters) w();
		return waiters.length;
	}

	pendingIdle(handle: string): number {
		return this.idleWaiters.get(handle)?.length ?? 0;
	}

	dropConnection(): void {
		for (const l of this.#closes) l(new Error("daemon closed"));
	}

	async connect(): Promise<DaemonInfo> {
		this.#record("connect");
		return { protocolVersion: 7, daemonVersion: "0.9.6", clientVersion: "0.9.5" };
	}

	onEvent(listener: (e: DaemonEvent) => void): () => void {
		this.#events.add(listener);
		return () => this.#events.delete(listener);
	}

	onClose(listener: (e: Error) => void): () => void {
		this.#closes.add(listener);
		return () => this.#closes.delete(listener);
	}

	async create(request: CreateRequest): Promise<DaemonSession> {
		this.#record("create", request);
		if (this.names.has(request.name)) {
			throw new DaemonCommandError("create", `Agent name "${request.name}" is unavailable: an agent of that name already exists at depth 0 under this parent`);
		}
		this.names.add(request.name);
		const n = this.#next++;
		const s: DaemonSession = {
			handle: `a${n}`,
			sessionId: `s${n}`,
			name: request.name,
			cwd: request.config.cwd,
			busy: false,
			model: request.config.model ? { provider: request.config.provider ?? "p", id: request.config.model } : null,
			thinking: request.config.thinking ?? "medium",
			depth: 0,
		};
		this.live.set(s.handle, s);
		return { ...s };
	}

	async open(sessionIdOrPath: string, cwd: string): Promise<DaemonSession> {
		this.#record("open", sessionIdOrPath, cwd);
		for (const s of this.live.values()) if (s.sessionId === sessionIdOrPath) return { ...s };
		const saved = this.saved.get(sessionIdOrPath);
		if (!saved) throw new DaemonCommandError("create", `session ${sessionIdOrPath} not found`);
		// Like the daemon: the reopened session runs in the cwd it is given.
		const s = { ...saved, handle: `a${this.#next++}`, cwd };
		this.live.set(s.handle, s);
		return { ...s };
	}

	async attach(handle: string): Promise<DaemonSession> {
		this.#record("attach", handle);
		return { ...this.#session(handle), lastText: "hello from the snapshot" };
	}

	async list(): Promise<DaemonSession[]> {
		this.#record("list");
		return [...this.live.values()].map((s) => ({ ...s }));
	}

	async listSaved(cwd: string): Promise<SavedSession[]> {
		this.#record("listSaved", cwd);
		return [...this.saved.values()]
			.filter((s) => s.cwd === cwd)
			.map((s) => ({ sessionId: s.sessionId, path: `/saved/${s.sessionId}.jsonl`, name: s.name, cwd: s.cwd, modified: "2026-09-28T00:00:00Z", messageCount: 3, firstMessage: "hi" }));
	}

	async getState(handle: string): Promise<DaemonSession> {
		this.#record("getState", handle);
		return { ...this.#session(handle) };
	}

	async prompt(handle: string, message: string): Promise<void> {
		this.#record("prompt", handle, message);
		this.#session(handle);
		if (this.busy.has(handle)) throw new DaemonCommandError("prompt", "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
	}

	async steer(handle: string, message: string): Promise<void> {
		this.#record("steer", handle, message);
		this.#session(handle);
	}

	async followUp(handle: string, message: string): Promise<void> {
		this.#record("followUp", handle, message);
		this.#session(handle);
	}

	async abort(handle: string): Promise<void> {
		this.#record("abort", handle);
	}

	async resumeQueue(handle: string): Promise<void> {
		this.#record("resumeQueue", handle);
		throw new DaemonCommandError("resume_queue", "No queued work to resume");
	}

	waitForIdle(handle: string): Promise<void> {
		this.#record("waitForIdle", handle);
		return new Promise((resolve) => {
			const list = this.idleWaiters.get(handle) ?? [];
			list.push(resolve);
			this.idleWaiters.set(handle, list);
		});
	}

	async kill(handle: string): Promise<void> {
		this.#record("kill", handle);
		this.closeSession(handle, "killed");
	}

	/**
	 * Like the daemon: a session it stops running is announced to every
	 * attached client with a `session_closed` before the kill is answered,
	 * whoever asked for it. Called directly, it is a kill by another client.
	 */
	closeSession(handle: string, reason: string): void {
		const s = this.#session(handle);
		this.live.delete(handle);
		this.saved.set(s.sessionId, s);
		this.emit(handle, { type: "session_closed", reason });
	}

	async detach(handle: string): Promise<void> {
		this.#record("detach", handle);
	}

	async setModel(handle: string, provider: string, modelId: string): Promise<void> {
		this.#record("setModel", handle, provider, modelId);
		this.#session(handle).model = { provider, id: modelId };
	}

	async setThinking(handle: string, level: string): Promise<void> {
		this.#record("setThinking", handle, level);
		// The daemon clamps levels the model does not have.
		this.#session(handle).thinking = level === "xhigh" || level === "max" ? "high" : level;
	}

	async listModels(): Promise<ModelInfo[]> {
		this.#record("listModels");
		return this.models;
	}

	close(): void {
		this.#record("close");
	}
}

/** Let pending promise callbacks run. */
export async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

// The only coupling between the host agent and prime-agent.
//
// `DaemonPort` lists exactly the daemon operations the host agent uses.
// `PrimeDaemonPort` implements it with the `DaemonClient` exported by the
// host's installed prime-agent package, loaded at runtime. Tests use a fake.
//
// Rules from docs/host-agent.md that live here:
// - connect to the shared daemon's socket, never start a daemon, never use
//   prime-agent's launch helpers;
// - gate on the daemon's protocol version and on each command's
//   compatibility, never on appVersion.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The daemon protocol versions this host agent speaks. */
export const SUPPORTED_DAEMON_PROTOCOLS: readonly number[] = [7];

export interface DaemonInfo {
	protocolVersion: number;
	/** The daemon's app version. Reported, never gated on. */
	daemonVersion: string | null;
	/** The version of the installed package the client was loaded from. */
	clientVersion: string | null;
}

/** Session settings passed to the daemon at create. */
export interface SessionConfig {
	cwd: string;
	provider?: string;
	model?: string;
	thinking?: string;
}

export interface CreateRequest {
	lifecycle: "resident";
	name: string;
	config: SessionConfig;
}

export interface DaemonSession {
	/** The daemon's live handle (`activeSessionId`). */
	handle: string;
	/** The persisted session id; the basename of the kernel's RLM_SESSION_DIR. */
	sessionId: string;
	name: string | null;
	cwd: string;
	busy: boolean;
	model: { provider: string; id: string } | null;
	thinking: string | null;
	depth: number;
	/** Text of the last assistant message, when the daemon reported one. */
	lastText?: string | null;
}

export interface SavedSession {
	sessionId: string;
	path: string;
	name: string | null;
	cwd: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
}

/**
 * One daemon `session_event`, or the daemon's own `session_closed` message
 * for a session it stopped running, delivered the same way with
 * `event.type` `"session_closed"`. `event.type` is the daemon's event type.
 */
export interface DaemonEvent {
	handle: string;
	event: { type: string; [key: string]: unknown };
}

export interface DaemonPort {
	connect(): Promise<DaemonInfo>;
	onEvent(listener: (event: DaemonEvent) => void): () => void;
	onClose(listener: (error: Error) => void): () => void;
	create(request: CreateRequest): Promise<DaemonSession>;
	/**
	 * Reopen a saved session by id or path (`create {sessionPath}`), resident,
	 * in `cwd`: without `config.cwd` the daemon runs it in its own directory.
	 */
	open(sessionIdOrPath: string, cwd: string): Promise<DaemonSession>;
	/** Attach for events; returns the daemon's snapshot of the session. */
	attach(handle: string): Promise<DaemonSession>;
	list(): Promise<DaemonSession[]>;
	listSaved(cwd: string): Promise<SavedSession[]>;
	getState(handle: string): Promise<DaemonSession>;
	prompt(handle: string, message: string): Promise<void>;
	steer(handle: string, message: string): Promise<void>;
	followUp(handle: string, message: string): Promise<void>;
	abort(handle: string): Promise<void>;
	resumeQueue(handle: string): Promise<void>;
	/** Resolves when the session is idle. */
	waitForIdle(handle: string): Promise<void>;
	kill(handle: string): Promise<void>;
	detach(handle: string): Promise<void>;
	setModel(handle: string, provider: string, modelId: string): Promise<void>;
	setThinking(handle: string, level: string): Promise<void>;
	listModels(): Promise<ModelInfo[]>;
	close(): void;
}

/** A daemon command failed. `unsupported` is set when this daemon cannot run it. */
export class DaemonCommandError extends Error {
	readonly command: string;
	readonly unsupported: boolean;
	constructor(command: string, message: string, unsupported = false) {
		super(`${command}: ${message}`);
		this.name = "DaemonCommandError";
		this.command = command;
		this.unsupported = unsupported;
	}
}

/** The daemon speaks a protocol this host agent does not. */
export class DaemonProtocolError extends Error {
	readonly version: number | null;
	constructor(version: number | null) {
		super(`daemon protocol ${version ?? "unknown"} is not supported (supported: ${SUPPORTED_DAEMON_PROTOCOLS.join(", ")})`);
		this.name = "DaemonProtocolError";
		this.version = version;
	}
}

export function checkDaemonProtocol(version: number | null): void {
	if (version === null || !SUPPORTED_DAEMON_PROTOCOLS.includes(version)) throw new DaemonProtocolError(version);
}

// ---------------------------------------------------------------------------
// Production adapter
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

interface RawResponse {
	success: boolean;
	data?: unknown;
	error?: string;
}

interface RawClient {
	readonly hello: { protocol?: { version?: number }; appVersion?: string } | undefined;
	connect(timeoutMs?: number): Promise<void>;
	waitForHello(timeoutMs?: number): Promise<{ protocol?: { version?: number }; appVersion?: string }>;
	onMessage(listener: (message: Json) => void): () => void;
	onClose(listener: (error: Error) => void): () => void;
	request(command: Json, timeoutMs?: number, options?: Json): Promise<RawResponse>;
	close(): void;
}

interface PrimeAgentModule {
	DaemonClient: new (socketPath: string) => RawClient;
	isUnknownDaemonCommandError?: (error: unknown, command: string) => boolean;
	AuthStorage: { create(): unknown };
	ModelRegistry: { create(auth: unknown): { getAvailable(): Json[] } };
}

/** Request timeout for ordinary commands. */
const COMMAND_TIMEOUT_MS = 60_000;
/** `wait_for_idle` resolves only when the turn settles, which can take hours. */
const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function lastAssistantText(messages: unknown): string | null {
	if (!Array.isArray(messages)) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as Json;
		if (m?.role !== "assistant") continue;
		const content = m.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c: Json) => c?.type === "text")
				.map((c: Json) => String(c.text ?? ""))
				.join("");
		}
		return null;
	}
	return null;
}

/** Map a daemon session summary or state object to a `DaemonSession`. */
export function toDaemonSession(raw: Json, handle?: string): DaemonSession {
	const model = raw.model as Json | undefined;
	return {
		handle: str(raw.activeSessionId) ?? handle ?? str(raw.id) ?? "",
		sessionId: str(raw.sessionId) ?? "",
		name: str(raw.sessionName),
		cwd: str(raw.cwd) ?? "",
		busy: raw.isStreaming === true || raw.isCompacting === true,
		model: model && typeof model.provider === "string" && typeof model.id === "string" ? { provider: model.provider, id: model.id } : null,
		thinking: str(raw.thinkingLevel),
		depth: typeof raw.rlmDepth === "number" ? raw.rlmDepth : 0,
	};
}

export class PrimeDaemonPort implements DaemonPort {
	readonly #socketPath: string;
	readonly #packageDir: string;
	#module: PrimeAgentModule | null = null;
	#client: RawClient | null = null;
	#eventListeners = new Set<(event: DaemonEvent) => void>();
	#closeListeners = new Set<(error: Error) => void>();

	constructor(socketPath: string, packageDir: string) {
		this.#socketPath = socketPath;
		this.#packageDir = packageDir;
	}

	async connect(): Promise<DaemonInfo> {
		this.#module ??= (await import(pathToFileURL(path.join(this.#packageDir, "dist", "index.js")).href)) as PrimeAgentModule;
		const client = new this.#module.DaemonClient(this.#socketPath);
		// A client that fails to come up is closed here: its waitForHello
		// leaves the socket open on a timeout, and connectDaemon retries for
		// ever, so each failure would leave one more client on the daemon.
		let version: number | null;
		let hello: { protocol?: { version?: number }; appVersion?: string };
		try {
			// DaemonClient.connect only dials the socket; it never starts a daemon.
			await client.connect(5_000);
			hello = await client.waitForHello(5_000);
			version = typeof hello.protocol?.version === "number" ? hello.protocol.version : null;
			checkDaemonProtocol(version);
		} catch (error) {
			client.close();
			throw error;
		}
		client.onMessage((message) => {
			const handle = str(message.activeSessionId);
			if (!handle) return;
			// The daemon tells attached clients when it stops running a
			// session (a kill by any client, or its own housekeeping) with a
			// top-level message, not a session_event.
			if (message.type === "session_closed") {
				const event = { type: "session_closed", reason: str(message.reason) ?? "closed" };
				for (const l of this.#eventListeners) l({ handle, event });
				return;
			}
			if (message.type !== "session_event") return;
			const event = message.event as DaemonEvent["event"] | undefined;
			if (!event || typeof event.type !== "string") return;
			for (const l of this.#eventListeners) l({ handle, event });
		});
		client.onClose((error) => {
			if (this.#client !== client) return;
			this.#client = null;
			for (const l of this.#closeListeners) l(error);
		});
		this.#client = client;
		return { protocolVersion: version as number, daemonVersion: hello.appVersion ?? null, clientVersion: this.#clientVersion() };
	}

	#clientVersion(): string | null {
		try {
			const pkg = JSON.parse(readFileSync(path.join(this.#packageDir, "package.json"), "utf8")) as Json;
			return str(pkg.version);
		} catch {
			return null;
		}
	}

	onEvent(listener: (event: DaemonEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	onClose(listener: (error: Error) => void): () => void {
		this.#closeListeners.add(listener);
		return () => this.#closeListeners.delete(listener);
	}

	async #request(command: Json, timeoutMs = COMMAND_TIMEOUT_MS, options?: Json): Promise<unknown> {
		const client = this.#client;
		const type = String(command.type);
		if (!client) throw new DaemonCommandError(type, "not connected to the daemon");
		let response: RawResponse;
		try {
			response = await client.request(command, timeoutMs, { recoverable: false, ...options });
		} catch (error) {
			// DaemonClient checks each command against the daemon hello and
			// throws DaemonCapabilityUnavailableError when it is missing.
			const unsupported = error instanceof Error && error.name === "DaemonCapabilityUnavailableError";
			throw new DaemonCommandError(type, error instanceof Error ? error.message : String(error), unsupported);
		}
		if (!response.success) {
			const unsupported = this.#module?.isUnknownDaemonCommandError?.(new Error(response.error ?? ""), type) ?? false;
			throw new DaemonCommandError(type, response.error ?? "failed", unsupported);
		}
		return response.data;
	}

	async create(request: CreateRequest): Promise<DaemonSession> {
		const data = (await this.#request({ type: "create", lifecycle: request.lifecycle, name: request.name, config: request.config }, 180_000)) as Json;
		return toDaemonSession(data);
	}

	async open(sessionIdOrPath: string, cwd: string): Promise<DaemonSession> {
		const data = (await this.#request({ type: "create", lifecycle: "resident", sessionPath: sessionIdOrPath, config: { cwd } }, 180_000)) as Json;
		return toDaemonSession(data);
	}

	async attach(handle: string): Promise<DaemonSession> {
		const data = (await this.#request({ type: "attach", activeSessionId: handle, capabilities: ["attach_snapshot", "event_sequence"] }, 60_000)) as Json;
		const snapshot = (data.snapshot ?? {}) as Json;
		const summary = (snapshot.summary ?? data.state ?? {}) as Json;
		return { ...toDaemonSession(summary, handle), lastText: lastAssistantText(snapshot.messages ?? data.messages) };
	}

	async list(): Promise<DaemonSession[]> {
		const data = (await this.#request({ type: "list" })) as Json;
		const sessions = Array.isArray(data?.sessions) ? (data.sessions as Json[]) : [];
		return sessions.map((s) => toDaemonSession(s));
	}

	async listSaved(cwd: string): Promise<SavedSession[]> {
		const items: Json[] = [];
		const data = (await this.#request({ type: "list_saved_sessions", cwd, scope: "current" }, COMMAND_TIMEOUT_MS, {
			onProgress: (m: Json) => {
				if (m.type === "session_list_item" && m.session) items.push(m.session as Json);
			},
		})) as Json | undefined;
		const rows = Array.isArray(data?.sessions) ? (data.sessions as Json[]) : items;
		return rows.map((s) => ({
			sessionId: str(s.id) ?? "",
			path: str(s.path) ?? "",
			name: str(s.name),
			cwd: str(s.cwd) ?? cwd,
			modified: str(s.modified) ?? "",
			messageCount: typeof s.messageCount === "number" ? s.messageCount : 0,
			firstMessage: str(s.firstMessage) ?? "",
		}));
	}

	async getState(handle: string): Promise<DaemonSession> {
		return toDaemonSession((await this.#request({ type: "get_state", activeSessionId: handle })) as Json, handle);
	}

	async prompt(handle: string, message: string): Promise<void> {
		await this.#request({ type: "prompt", activeSessionId: handle, message });
	}

	async steer(handle: string, message: string): Promise<void> {
		await this.#request({ type: "steer", activeSessionId: handle, message });
	}

	async followUp(handle: string, message: string): Promise<void> {
		await this.#request({ type: "follow_up", activeSessionId: handle, message });
	}

	async abort(handle: string): Promise<void> {
		await this.#request({ type: "abort", activeSessionId: handle });
	}

	async resumeQueue(handle: string): Promise<void> {
		await this.#request({ type: "resume_queue", activeSessionId: handle });
	}

	async waitForIdle(handle: string): Promise<void> {
		await this.#request({ type: "wait_for_idle", activeSessionId: handle }, IDLE_TIMEOUT_MS);
	}

	async kill(handle: string): Promise<void> {
		await this.#request({ type: "kill", activeSessionId: handle });
	}

	async detach(handle: string): Promise<void> {
		await this.#request({ type: "detach", activeSessionId: handle });
	}

	async setModel(handle: string, provider: string, modelId: string): Promise<void> {
		await this.#request({ type: "set_model", activeSessionId: handle, provider, modelId });
	}

	async setThinking(handle: string, level: string): Promise<void> {
		await this.#request({ type: "set_thinking_level", activeSessionId: handle, level });
	}

	async listModels(): Promise<ModelInfo[]> {
		// The daemon only lists models per session; the package's model
		// registry reads the same models.json and auth the daemon uses.
		const mod = this.#module;
		if (!mod) throw new DaemonCommandError("list_models", "not connected to the daemon");
		const registry = mod.ModelRegistry.create(mod.AuthStorage.create());
		return registry.getAvailable().map((m) => ({
			provider: String(m.provider ?? ""),
			id: String(m.id ?? ""),
			name: String(m.name ?? m.id ?? ""),
			reasoning: m.reasoning === true,
		}));
	}

	close(): void {
		const client = this.#client;
		this.#client = null;
		client?.close();
	}
}

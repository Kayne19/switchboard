// An in-process fake of the switchboard service's /host endpoint.
import { type WebSocket, WebSocketServer } from "ws";

export type Message = Record<string, unknown>;

export interface Link {
	socket: WebSocket;
	received: Message[];
	send(message: Message): void;
	next(predicate?: (m: Message) => boolean, timeoutMs?: number): Promise<Message>;
	closed: Promise<void>;
}

export class FakeService {
	readonly server: WebSocketServer;
	readonly links: Link[] = [];
	#waiters: { index: number; resolve: (link: Link) => void }[] = [];
	/** Called on each hello; the default welcomes with an increasing epoch. */
	onHello: (link: Link, hello: Message) => void;
	/** Answer pings (turn off to test the host agent's heartbeat drop). */
	answerPings = true;
	epoch = 0;

	private constructor(server: WebSocketServer) {
		this.server = server;
		this.onHello = (link) => link.send({ type: "welcome", epoch: ++this.epoch, protocol: 1, cursors: {} });
		server.on("connection", (socket) => {
			const received: Message[] = [];
			const waiters: { predicate: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
			let resolveClosed: () => void = () => {};
			const link: Link = {
				socket,
				received,
				send: (m) => socket.send(JSON.stringify(m)),
				next: (predicate = () => true, timeoutMs = 3000) => {
					const i = received.findIndex(predicate);
					if (i >= 0) return Promise.resolve(received.splice(i, 1)[0]);
					return new Promise((resolve, reject) => {
						const w = { predicate, resolve };
						waiters.push(w);
						setTimeout(() => {
							const at = waiters.indexOf(w);
							if (at >= 0) {
								waiters.splice(at, 1);
								reject(new Error("timed out waiting for a message from the host agent"));
							}
						}, timeoutMs).unref();
					});
				},
				closed: new Promise<void>((r) => {
					resolveClosed = r;
				}),
			};
			socket.on("close", () => resolveClosed());
			socket.on("message", (data) => {
				const m = JSON.parse(String(data)) as Message;
				if (m.type === "ping") {
					if (this.answerPings) link.send({ type: "pong" });
					return;
				}
				if (m.type === "pong") return;
				if (m.type === "hello") this.onHello(link, m);
				const at = waiters.findIndex((w) => w.predicate(m));
				if (at >= 0) waiters.splice(at, 1)[0].resolve(m);
				else received.push(m);
			});
			this.links.push(link);
			for (const w of [...this.#waiters]) {
				if (this.links[w.index]) {
					this.#waiters.splice(this.#waiters.indexOf(w), 1);
					w.resolve(this.links[w.index]);
				}
			}
		});
	}

	static async start(): Promise<FakeService> {
		const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		await new Promise<void>((r) => server.once("listening", () => r()));
		return new FakeService(server);
	}

	get url(): string {
		const a = this.server.address();
		if (typeof a === "string") throw new Error("unexpected address");
		return `ws://127.0.0.1:${a.port}/host`;
	}

	/** The next link to connect (or the one already connected at `index`). */
	link(index: number, timeoutMs = 3000): Promise<Link> {
		if (this.links[index]) return Promise.resolve(this.links[index]);
		return new Promise((resolve, reject) => {
			this.#waiters.push({ index, resolve });
			setTimeout(() => reject(new Error(`timed out waiting for link ${index}`)), timeoutMs).unref();
		});
	}

	async close(): Promise<void> {
		for (const c of this.server.clients) c.terminate();
		await new Promise<void>((r) => this.server.close(() => r()));
	}
}

/** Send a command on a link and wait for its reply. */
export async function command(link: Link, epoch: number, id: string, name: string, args: Message = {}): Promise<Message> {
	link.send({ type: "command", id, epoch, name, args });
	return link.next((m) => m.type === "reply" && m.id === id);
}

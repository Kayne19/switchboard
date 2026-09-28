// Minimal types for the parts of `ws` the fake service uses (tests only).
declare module "ws" {
	import type { IncomingMessage } from "node:http";
	import type { AddressInfo } from "node:net";

	export class WebSocket {
		static readonly OPEN: number;
		readonly readyState: number;
		send(data: string): void;
		close(code?: number, reason?: string): void;
		terminate(): void;
		on(event: "message", listener: (data: Buffer) => void): this;
		on(event: "close", listener: (code: number, reason: Buffer) => void): this;
		on(event: "error", listener: (error: Error) => void): this;
	}

	export class WebSocketServer {
		constructor(options: { host?: string; port?: number; path?: string });
		address(): AddressInfo | string;
		on(event: "connection", listener: (socket: WebSocket, request: IncomingMessage) => void): this;
		on(event: "listening", listener: () => void): this;
		once(event: "listening", listener: () => void): this;
		close(callback?: (error?: Error) => void): void;
		readonly clients: Set<WebSocket>;
	}
}

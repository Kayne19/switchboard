// The WebSocket the page and the debug feed open, faked for unit tests: it
// records what is sent, and a test opens it, drops it and feeds it server
// frames by hand. The one fake for every frontend unit test (#411);
// scripts/check_hygiene.mjs refuses a class of its own.
import { vi } from "vitest";

export class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  /** Forgets the sockets opened so far, and makes `new WebSocket(url)` build one of these. */
  static install() {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  }

  static latest(): FakeSocket {
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!socket) throw new Error("FakeSocket.latest: no socket has been opened");
    return socket;
  }

  send(data: unknown) {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data);
  }

  // A real socket reports its own close asynchronously.
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({} as CloseEvent));
  }

  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  drop() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }

  /** The socket reports an error and stays open. */
  error() {
    this.onerror?.({} as Event);
  }

  /** The server sends `message`, as JSON text. */
  receive(message: object) {
    this.receiveRaw(JSON.stringify(message));
  }

  receiveRaw(data: string | ArrayBuffer | Blob) {
    this.onmessage?.({ data } as MessageEvent);
  }

  sentJson(): Array<Record<string, unknown>> {
    return this.sent
      .filter((frame): frame is string => typeof frame === "string")
      .map((frame) => JSON.parse(frame));
  }

  /** What the page sent, as JSON, of one frame `type`. */
  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sentJson().filter((frame) => frame.type === type);
  }
}

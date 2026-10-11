// The WebSocket the call runtime opens, faked for unit tests: it records what
// is sent, and a test opens it, drops it and feeds it server frames by hand.
// One copy for the runtime's tests (#411).

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

  static latest(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1];
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
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }

  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  sentJson(): Array<Record<string, unknown>> {
    return this.sent
      .filter((frame): frame is string => typeof frame === "string")
      .map((frame) => JSON.parse(frame));
  }
}

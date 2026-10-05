import assert from "node:assert/strict";
import { test } from "node:test";
import { DaemonCommandError } from "../src/daemon_port.ts";
import { HOST_LINK_PROTOCOL, HostLink, type HostLinkOptions, type HostLinkStatus, parseCursor, type SocketLike } from "../src/link.ts";
import { CommandError } from "../src/sessions.ts";
import { command, FakeService, type Message } from "./fake_service.ts";

const TOKEN = "test-host-token-not-a-secret";

function makeLink(service: FakeService, overrides: Partial<HostLinkOptions> = {}): { link: HostLink; statuses: HostLinkStatus[] } {
	const statuses: HostLinkStatus[] = [];
	const link = new HostLink({
		url: service.url,
		hostId: "scriptorium",
		token: TOKEN,
		gitSha: "abc123",
		versions: () => ({ prime_agent_client: "0.9.5", prime_agent_daemon: "0.9.6", daemon_protocol: 7 }),
		command: async (name) => ({ ran: name }),
		sessions: () => [],
		describe: async (handle) => ({ session: handle }),
		heartbeatMs: 20,
		backoffInitialMs: 10,
		backoffMaxMs: 40,
		onStatus: (s) => statuses.push(s),
		...overrides,
	});
	return { link, statuses };
}

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("condition not reached");
		await new Promise((r) => setTimeout(r, 5));
	}
}

test("handshake: hello carries host id, token, protocol, versions and boot id; welcome links", async () => {
	const service = await FakeService.start();
	const { link, statuses } = makeLink(service);
	try {
		link.start();
		const l = await service.link(0);
		const hello = await l.next((m) => m.type === "hello");
		assert.equal(hello.host_id, "scriptorium");
		assert.equal(hello.token, TOKEN);
		assert.equal(hello.protocol, HOST_LINK_PROTOCOL);
		assert.equal(hello.git_sha, "abc123");
		assert.equal(hello.boot_id, link.bootId);
		assert.deepEqual(hello.prime_agent, { client_version: "0.9.5", daemon_version: "0.9.6", daemon_protocol: 7 });
		await until(() => statuses.some((s) => s.state === "linked"));
		assert.equal(link.epoch, 1);
		await l.next((m) => m.type === "synced");
	} finally {
		link.stop();
		await service.close();
	}
});

for (const reason of ["bad_token", "incompatible_protocol"]) {
	test(`refusal (${reason}) is reported, never linked, and retried with backoff`, async () => {
		const service = await FakeService.start();
		let hellos = 0;
		service.onHello = (l) => {
			hellos++;
			l.send({ type: "refused", reason, message: "no" });
		};
		const { link, statuses } = makeLink(service);
		try {
			link.start();
			await until(() => hellos >= 2);
			assert.ok(statuses.some((s) => s.state === "refused" && s.reason === reason));
			assert.ok(!statuses.some((s) => s.state === "linked"));
			assert.equal(link.epoch, null);
		} finally {
			link.stop();
			await service.close();
		}
	});
}

test("epoch fencing: a command with another epoch is rejected; a newer link fences the old epoch", async () => {
	const service = await FakeService.start();
	const ran: string[] = [];
	const { link } = makeLink(service, {
		command: async (name) => {
			ran.push(name);
			return { ok: name };
		},
	});
	try {
		link.start();
		const l0 = await service.link(0);
		await l0.next((m) => m.type === "synced");
		const good = await command(l0, 1, "c1", "list_sessions");
		assert.equal(good.ok, true);
		assert.equal(good.epoch, 1);
		const stale = await command(l0, 0, "c2", "kill", { session: "a1" });
		assert.equal(stale.ok, false);
		assert.equal((stale.error as Message).code, "stale_epoch");
		assert.deepEqual(ran, ["list_sessions"]);
		// The service drops the link; the host agent redials and gets epoch 2.
		l0.socket.terminate();
		const l1 = await service.link(1);
		await l1.next((m) => m.type === "synced");
		assert.equal(link.epoch, 2);
		const old = await command(l1, 1, "c3", "list_sessions");
		assert.equal((old.error as Message).code, "stale_epoch");
		const current = await command(l1, 2, "c4", "list_sessions");
		assert.equal(current.ok, true);
		assert.deepEqual(ran, ["list_sessions", "list_sessions"]);
	} finally {
		link.stop();
		await service.close();
	}
});

test("command errors: refused, unsupported and daemon errors come back as coded replies", async () => {
	const service = await FakeService.start();
	const { link } = makeLink(service, {
		command: async (name) => {
			if (name === "kill") throw new CommandError("refused", "taken over");
			if (name === "set_thinking") throw new DaemonCommandError("set_thinking_level", "capability unavailable", true);
			throw new DaemonCommandError("prompt", "boom");
		},
	});
	try {
		link.start();
		const l = await service.link(0);
		await l.next((m) => m.type === "synced");
		assert.equal(((await command(l, 1, "a", "kill")).error as Message).code, "refused");
		assert.equal(((await command(l, 1, "b", "set_thinking")).error as Message).code, "unsupported");
		assert.equal(((await command(l, 1, "c", "prompt")).error as Message).code, "daemon_error");
	} finally {
		link.stop();
		await service.close();
	}
});

test("heartbeat: the host agent answers pings and drops a link that misses 3 pongs", async () => {
	const service = await FakeService.start();
	const { link, statuses } = makeLink(service);
	try {
		link.start();
		const l0 = await service.link(0);
		await l0.next((m) => m.type === "synced");
		l0.send({ type: "ping" });
		// answered pongs keep it alive across several beats
		await new Promise((r) => setTimeout(r, 120));
		assert.ok(!statuses.some((s) => s.state === "closed"));
		service.answerPings = false;
		await l0.closed;
		assert.ok(statuses.some((s) => s.state === "closed" && s.reason === "heartbeat"));
		service.answerPings = true;
		const l1 = await service.link(1);
		await l1.next((m) => m.type === "synced");
		assert.equal(link.epoch, 2);
	} finally {
		link.stop();
		await service.close();
	}
});

test("host answers a service ping with pong", async () => {
	const service = await FakeService.start();
	const { link } = makeLink(service, { heartbeatMs: 10_000 });
	try {
		link.start();
		const l = await service.link(0);
		await l.next((m) => m.type === "synced");
		let pong = false;
		l.socket.on("message", (d) => {
			if (JSON.parse(String(d)).type === "pong") pong = true;
		});
		l.send({ type: "ping" });
		await until(() => pong);
	} finally {
		link.stop();
		await service.close();
	}
});

test("reconnect with cursor: buffered events after the service's cursor are replayed", async () => {
	const service = await FakeService.start();
	const { link } = makeLink(service, { sessions: () => ["a1"] });
	let welcomeCursors: Record<string, string> = {};
	service.onHello = (l) => l.send({ type: "welcome", epoch: ++service.epoch, protocol: 1, cursors: welcomeCursors });
	try {
		link.start();
		const l0 = await service.link(0);
		// no cursor yet for a1: a snapshot comes first
		const snap = await l0.next((m) => m.type === "snapshot");
		assert.equal(snap.session, "a1");
		link.publish("a1", { kind: "turn_start", cause: "input" });
		const e1 = await l0.next((m) => m.type === "event");
		assert.equal(parseCursor(e1.cursor)?.bootId, link.bootId);
		l0.socket.terminate();
		await l0.closed;
		// events while the link is down are buffered, not sent
		link.publish("a1", { kind: "text", text: "while down" });
		link.publish("a1", { kind: "turn_end" });
		welcomeCursors = { a1: String(e1.cursor) };
		const l1 = await service.link(1);
		await l1.next((m) => m.type === "synced");
		const replayed = l1.received.filter((m) => m.type === "event");
		assert.deepEqual(
			replayed.map((m) => (m.event as Message).kind),
			["text", "turn_end"],
		);
		assert.ok(replayed.every((m) => m.replayed === true));
		assert.equal(l1.received.filter((m) => m.type === "snapshot").length, 0);
	} finally {
		link.stop();
		await service.close();
	}
});

test("snapshot order: an event published while the session is described goes out after the snapshot", async () => {
	const service = await FakeService.start();
	let release: (() => void) | null = null;
	const describing = new Promise<void>((r) => (release = r));
	let describes = 0;
	const { link } = makeLink(service, {
		sessions: () => ["a1"],
		describe: async (h) => {
			describes += 1;
			// The first describe (the welcome sync) answers at once; the
			// second holds until the test has published behind it.
			if (describes === 2) await describing;
			return { session: h, busy: describes === 2 };
		},
	});
	try {
		link.start();
		const l0 = await service.link(0);
		await l0.next((m) => m.type === "synced");
		await l0.next((m) => m.type === "snapshot"); // the welcome sync's
		const before = link.publish("a1", { kind: "text", text: "settled" });
		await l0.next((m) => m.type === "event");
		const sending = link.sendSnapshot("a1");
		await until(() => describes === 2);
		// Published while the snapshot is being taken: with the old order
		// this event went out first and the snapshot, carrying its cursor,
		// then replaced it on the service.
		const seen = l0.received.length;
		const during = link.publish("a1", { kind: "turn_start", cause: "input" });
		await new Promise((r) => setTimeout(r, 20));
		// Heartbeat pings aside, nothing goes out until the snapshot is ready.
		assert.deepEqual(
			l0.received
				.slice(seen)
				.filter((m) => m.type !== "ping")
				.map((m) => m.type),
			[],
		);
		(release as unknown as () => void)();
		await sending;
		const snap = await l0.next((m) => m.type === "snapshot");
		assert.equal(snap.cursor, before, "the snapshot claims only what was published before it was taken");
		const event = await l0.next((m) => m.type === "event");
		assert.equal(event.cursor, during);
		assert.equal((event.event as Message).kind, "turn_start");
	} finally {
		link.stop();
		await service.close();
	}
});

test("reconnect: a cursor from another boot or beyond the buffer gets a fresh snapshot", async () => {
	const service = await FakeService.start();
	const { link } = makeLink(service, { sessions: () => ["a1", "a2"], bufferLimit: 2, describe: async (h) => ({ session: h, busy: false }) });
	try {
		for (let i = 0; i < 5; i++) link.publish("a1", { kind: "text", text: `t${i}` });
		link.publish("a2", { kind: "text", text: "x" });
		service.onHello = (l) =>
			l.send({
				type: "welcome",
				epoch: ++service.epoch,
				protocol: 1,
				// a1: our boot, but the buffer no longer reaches back to seq 1; a2: another boot
				cursors: { a1: `${link.bootId}:1`, a2: "previous-boot:6" },
			});
		link.start();
		const l = await service.link(0);
		await l.next((m) => m.type === "synced");
		const snaps = l.received.filter((m) => m.type === "snapshot");
		assert.deepEqual(snaps.map((s) => s.session).sort(), ["a1", "a2"]);
		const a1 = snaps.find((s) => s.session === "a1") as Message;
		assert.equal(a1.cursor, `${link.bootId}:5`);
		assert.equal(l.received.filter((m) => m.type === "event").length, 0);
	} finally {
		link.stop();
		await service.close();
	}
});

test("module calls are relayed to the service; no reply in time means failed", async () => {
	const service = await FakeService.start();
	const { link } = makeLink(service);
	try {
		assert.deepEqual(await link.relayModuleCall("a1", "tok", "speak", { text: "hi" }, 100), { status: "failed", reason: "failed" });
		link.start();
		const l = await service.link(0);
		await l.next((m) => m.type === "synced");
		const pending = link.relayModuleCall("a1", "tok", "speak", { text: "hi" }, 2000);
		const call = await l.next((m) => m.type === "module_call");
		assert.equal(call.session, "a1");
		assert.equal(call.token, "tok");
		assert.equal(call.call, "speak");
		assert.deepEqual(call.args, { text: "hi" });
		l.send({ type: "module_reply", id: call.id, status: "delivered", reason: null });
		assert.deepEqual(await pending, { status: "delivered", reason: null });
		const autonomous = link.relayModuleCall("a1", "tok", "display", {}, 2000, "turn-1", "autonomous");
		const autonomousCall = await l.next((m) => m.type === "module_call");
		assert.equal(autonomousCall.turn_id, "turn-1");
		assert.equal(autonomousCall.cause, "autonomous");
		l.send({ type: "module_reply", id: autonomousCall.id, status: "refused", reason: "stale" });
		assert.deepEqual(await autonomous, { status: "refused", reason: "stale" });
		const late = link.relayModuleCall("a1", "tok", "view", {}, 50);
		assert.deepEqual(await late, { status: "failed", reason: "failed" });
	} finally {
		link.stop();
		await service.close();
	}
});

/** A socket the test drives by hand: it opens, delivers frames and changes state when told. */
class HandSocket implements SocketLike {
	readyState = 0;
	readonly sent: Message[] = [];
	readonly #listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
	addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
		this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
	}
	send(data: string): void {
		this.sent.push(JSON.parse(data) as Message);
	}
	close(): void {
		this.readyState = 3;
	}
	emit(type: string, event: { data?: unknown } = {}): void {
		for (const listener of this.#listeners.get(type) ?? []) listener(event);
	}
}

// The service has begun to close the socket (it is CLOSING) and its close
// event has not come yet: a frame sent now goes nowhere. The call used to
// wait for its deadline; it fails at once.
test("a module call that cannot go out fails at once, not at its deadline", async () => {
	const socket = new HandSocket();
	const logged: string[] = [];
	const link = new HostLink({
		url: "ws://service.invalid/host",
		hostId: "scriptorium",
		token: TOKEN,
		gitSha: "abc123",
		versions: () => ({ prime_agent_client: null, prime_agent_daemon: null, daemon_protocol: null }),
		command: async () => ({}),
		sessions: () => [],
		describe: async () => null,
		heartbeatMs: 60_000,
		connect: () => socket,
		log: (message) => logged.push(message),
	});
	try {
		link.start();
		socket.readyState = 1;
		socket.emit("open");
		socket.emit("message", { data: JSON.stringify({ type: "welcome", epoch: 1, protocol: 1, cursors: {} }) });
		await until(() => socket.sent.some((m) => m.type === "synced"));
		socket.readyState = 2;
		const started = Date.now();
		assert.deepEqual(await link.relayModuleCall("a1", "tok", "display", { action: { op: "clear" } }, 5_000), { status: "failed", reason: "failed" });
		assert.ok(Date.now() - started < 1_000, "answered at once");
		assert.equal(socket.sent.filter((m) => m.type === "module_call").length, 0);
		assert.deepEqual(logged, ["module call display not sent: the link's socket is not open"]);
	} finally {
		link.stop();
	}
});

test("a frame the host agent cannot use is logged with the reason", async () => {
	const service = await FakeService.start();
	const logged: string[] = [];
	const { link } = makeLink(service, { heartbeatMs: 60_000, log: (message) => logged.push(message) });
	try {
		link.start();
		const l = await service.link(0);
		await l.next((m) => m.type === "synced");
		l.socket.send("not json");
		l.socket.send("null");
		l.send({ type: "news" });
		// A reply for a call that already failed at its deadline.
		const late = link.relayModuleCall("a1", "tok", "view", {}, 20);
		const call = await l.next((m) => m.type === "module_call");
		assert.deepEqual(await late, { status: "failed", reason: "failed" });
		l.send({ type: "module_reply", id: call.id, status: "delivered", reason: null });
		const odd = link.relayModuleCall("a1", "tok", "view", {}, 2_000);
		const oddCall = await l.next((m) => m.type === "module_call");
		l.send({ type: "module_reply", id: oddCall.id, status: "maybe", reason: null });
		assert.deepEqual(await odd, { status: "failed", reason: "failed" });
		await until(() => logged.length >= 5);
		assert.match(logged[0], /^dropped a frame from the service that is not JSON \(.+\)$/);
		assert.deepEqual(logged.slice(1), [
			"dropped a frame from the service that is not a JSON object",
			'ignored a frame of no known type from the service ("news")',
			`dropped a module reply for ${String(call.id)}: no call is waiting for it`,
			`module reply for ${String(oddCall.id)} has no known status ("maybe"); the call failed`,
		]);
		// The link is still up and answering.
		assert.equal((await command(l, 1, "c1", "list_sessions")).ok, true);
	} finally {
		link.stop();
		await service.close();
	}
});

test("reconnect: a session closed while the link was down reaches the service", async () => {
	const service = await FakeService.start();
	let tracked = ["a1", "a2"];
	const { link } = makeLink(service, { sessions: () => tracked });
	let cursors: Record<string, string> = {};
	service.onHello = (l) => l.send({ type: "welcome", epoch: ++service.epoch, protocol: 1, cursors });
	try {
		link.start();
		const l0 = await service.link(0);
		await l0.next((m) => m.type === "synced");
		const c1 = link.publish("a1", { kind: "turn_start", cause: "input" });
		const c2 = link.publish("a2", { kind: "turn_start", cause: "input" });
		await l0.next((m) => m.type === "event" && m.session === "a2");
		l0.socket.terminate();
		await l0.closed;
		link.publish("a1", { kind: "session_closed", reason: "killed" });
		tracked = ["a2"];
		// a3: a session from before a host-agent restart that the host no longer has
		cursors = { a1: c1, a2: c2, a3: "old-boot:9" };
		const l1 = await service.link(1);
		await l1.next((m) => m.type === "synced");
		const events = l1.received.filter((m) => m.type === "event");
		assert.deepEqual(
			events.map((m) => [m.session, (m.event as Message).kind, (m.event as Message).reason]),
			[
				["a1", "session_closed", "killed"],
				["a3", "session_closed", "gone"],
			],
		);
		assert.equal(l1.received.filter((m) => m.type === "snapshot").length, 0);
	} finally {
		link.stop();
		await service.close();
	}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { HostLink, parseCursor } from "../src/link.ts";
import { FakeService, type Message } from "./fake_service.ts";

async function until(p: () => boolean): Promise<void> {
	for (let i = 0; !p(); i++) {
		if (i > 600) throw new Error("condition not reached");
		await new Promise((r) => setTimeout(r, 5));
	}
}

test("a snapshot whose describe outlives its link goes out on the next link after that link's catch-up", async () => {
	const service = await FakeService.start();
	let release: (() => void) | null = null;
	const held = new Promise<void>((r) => (release = r));
	let describes = 0;
	const link = new HostLink({
		url: service.url, hostId: "h", token: "t", gitSha: "x",
		versions: () => ({ prime_agent_client: null, prime_agent_daemon: null, daemon_protocol: null }),
		command: async () => ({}),
		sessions: () => ["a0"],
		describe: async (h) => { describes++; if (describes === 1) await held; return { session: h, busy: false }; },
		heartbeatMs: 1000, backoffInitialMs: 10, backoffMaxMs: 40,
	});
	try {
		link.publish("a0", { kind: "text", text: "before" });
		let n = 0;
		service.onHello = (l) => l.send({ type: "welcome", epoch: ++service.epoch, protocol: 2, cursors: n++ === 0 ? {} : { a0: `${link.bootId}:0` } });
		link.start();
		const l0 = await service.link(0);
		await until(() => describes === 1);
		link.publish("a0", { kind: "turn_end", turn_id: "t1" });
		l0.socket.terminate();
		const l1 = await service.link(1);
		await l1.next((m) => m.type === "synced");
		(release as unknown as () => void)();
		await new Promise((r) => setTimeout(r, 50));
		const a0 = l1.received.filter((m: Message) => m.session === "a0").map((m: Message) => `${m.type}:${parseCursor(m.cursor)?.seq}`);
		assert.deepEqual(a0, ["event:1", "event:2"]);
	} finally {
		link.stop();
		await service.close();
	}
});

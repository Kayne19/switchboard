import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HOST_LINK_PROTOCOL, HostLink } from "../src/link.ts";
import { SessionManager } from "../src/sessions.ts";
import { FakeDaemon } from "./fake_daemon.ts";
import { FakeService, type Message } from "./fake_service.ts";
import { hostLinkFixture } from "./host_link_fixture.ts";

// The fixture holds the fakes of the other two peers to this one: the real
// host agent is run here and must send what the fixture says it sends.

const fixture = hostLinkFixture();

test("the fixture's protocol is the one the host agent speaks", () => {
	assert.equal(fixture.protocol, HOST_LINK_PROTOCOL);
	assert.equal(fixture.welcome.protocol, HOST_LINK_PROTOCOL);
});

for (const [name, expected] of Object.entries(fixture.commands)) {
	test(`the real host agent answers ${name} with the frames the fixture lists, in its order`, async () => {
		const daemon = new FakeDaemon();
		const manager = new SessionManager({
			port: daemon,
			stateFile: path.join(mkdtempSync(path.join(os.tmpdir(), "sb-host-")), "sessions.json"),
			emit: (handle, event) => link.publish(handle, event),
		});
		const service = await FakeService.start();
		const link = new HostLink({
			url: service.url,
			hostId: "scriptorium",
			token: "test-host-token-not-a-secret",
			gitSha: "abc123",
			versions: () => ({ prime_agent_client: "0.9.5", prime_agent_daemon: "0.9.6", daemon_protocol: 7 }),
			command: (command, args) => manager.handle(command, args),
			sessions: () => [],
			describe: async (handle) => ({ session: handle }),
			heartbeatMs: 1000,
			backoffInitialMs: 10,
			backoffMaxMs: 40,
		});
		try {
			const created = (await manager.createSession("homelab", { cwd: "/w", provider: "anthropic", model: "claude-x", thinking: "medium" })) as Message;
			link.start();
			const l = await service.link(0);
			await l.next((m) => m.type === "synced");
			l.received.length = 0;
			l.send({ type: "command", id: "c1", epoch: 1, name, args: { session: created.session, ...expected.args } });
			await l.next((m) => m.type === "reply" && m.id === "c1", 3000).then((reply) => l.received.push(reply));
			const frames = l.received.filter((m) => m.type === "event" || m.type === "reply");
			const turn = (frames.find((m) => m.type === "reply")?.result as Message | undefined)?.turn_id;
			const seen = frames.map((m) => withoutRouting(m, turn));
			assert.deepEqual(seen, expected.frames);
		} finally {
			link.stop();
			await service.close();
		}
	});
}

function withoutRouting(frame: Message, turn: unknown): Message {
	const { session: _s, cursor: _c, id: _i, epoch: _e, replayed: _r, ...rest } = frame;
	return JSON.parse(JSON.stringify(rest, (_key, value) => (typeof turn === "string" && value === turn ? "$turn" : value)));
}


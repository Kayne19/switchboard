import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DaemonCommandError } from "../src/daemon_port.ts";
import { HostLink } from "../src/link.ts";
import { clipDetail, type LinkEvent, PREPARE_OUTPUT_LIMIT, runPrepare, SessionManager, TOOL_DETAIL_LIMIT } from "../src/sessions.ts";
import { SkillSocket } from "../src/skill_socket.ts";
import { FakeDaemon, flush } from "./fake_daemon.ts";
import { command, FakeService, type Message } from "./fake_service.ts";

function setup(options: { stateFile?: string; ids?: string[]; daemon?: FakeDaemon } = {}) {
	const daemon = options.daemon ?? new FakeDaemon();
	const events: { handle: string; event: LinkEvent }[] = [];
	const stateFile = options.stateFile ?? path.join(mkdtempSync(path.join(os.tmpdir(), "sb-host-")), "state", "sessions.json");
	const ids = options.ids ? [...options.ids] : null;
	const manager = new SessionManager({
		port: daemon,
		stateFile,
		emit: (handle, event) => events.push({ handle, event }),
		shortId: ids ? () => ids.shift() ?? "zzzz" : undefined,
	});
	const kinds = (handle: string) => events.filter((e) => e.handle === handle).map((e) => e.event.kind);
	return { daemon, manager, events, stateFile, kinds };
}

const CONFIG = { cwd: "/srv/homelab", provider: "anthropic", model: "claude-x", thinking: "high" };

test("create_session sends lifecycle resident, keeps ipython, and mints sb-<project>-<id>", async () => {
	const { daemon, manager } = setup();
	const info = (await manager.handle("create_session", { project: "homelab", config: CONFIG })) as Message;
	const create = daemon.calls.find((c) => c.op === "create");
	const request = create?.args[0] as { lifecycle: string; name: string; config: Record<string, unknown> };
	assert.equal(request.lifecycle, "resident");
	assert.match(request.name, /^sb-homelab-[0-9a-f]{8}$/);
	assert.deepEqual(request.config, CONFIG);
	assert.ok(!("appendSystemPrompt" in request.config));
	assert.ok(!("noBuiltinTools" in request.config));
	assert.ok(!("tools" in request.config));
	assert.equal(info.name, request.name);
	assert.equal(info.provenance, "created");
	assert.equal(info.thinking, "high");
	assert.ok(daemon.ops().includes("attach"), "the host agent attaches for events");
});

test("names are never reused: several per project, after a kill, after a restart, and past a taken name", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "sb-host-"));
	const stateFile = path.join(dir, "sessions.json");
	const daemon = new FakeDaemon();
	daemon.names.add("sb-homelab-00000003"); // a name the daemon already holds (e.g. a desk session)
	const first = setup({ daemon, stateFile, ids: ["00000001", "00000002", "00000001", "00000003", "00000004"] });
	const a = (await first.manager.createSession("homelab", CONFIG)) as Message;
	const b = (await first.manager.createSession("homelab", CONFIG)) as Message;
	await first.manager.kill(String(a.session));
	const c = (await first.manager.createSession("homelab", CONFIG)) as Message;
	assert.deepEqual([a.name, b.name, c.name], ["sb-homelab-00000001", "sb-homelab-00000002", "sb-homelab-00000004"]);
	// A restarted host agent reads the used names from its state file.
	const second = setup({ daemon, stateFile, ids: ["00000001", "00000002", "00000004", "00000005"] });
	await second.manager.resync();
	const d = (await second.manager.createSession("homelab", CONFIG)) as Message;
	assert.equal(d.name, "sb-homelab-00000005");
	const names = daemon.calls.filter((x) => x.op === "create").map((x) => (x.args[0] as { name: string }).name);
	assert.equal(new Set(names).size, names.length, "no create ever asked for a used name twice");
});

test("list_sessions reports provenance; kill is refused for taken_over and foreign sessions", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "sb-host-"));
	const stateFile = path.join(dir, "sessions.json");
	const daemon = new FakeDaemon();
	daemon.addLive({ handle: "desk1", name: "desk", cwd: "/srv/homelab" });
	daemon.addLive({ handle: "desk2", name: null, cwd: "/srv/other" });
	daemon.addLive({ handle: "child", depth: 1 });
	writeFileSync(
		stateFile,
		JSON.stringify({ version: 1, sessions: [{ handle: "desk1", session_id: "sid-desk1", name: "desk", project: "homelab", cwd: "/srv/homelab", provenance: "taken_over" }], used_names: [] }),
	);
	const { manager } = setup({ daemon, stateFile });
	await manager.resync();
	const created = (await manager.createSession("homelab", CONFIG)) as Message;
	const listed = ((await manager.handle("list_sessions", {})) as { sessions: Message[] }).sessions;
	const by = Object.fromEntries(listed.map((s) => [s.session, s]));
	assert.equal(by.desk1.provenance, "taken_over");
	assert.equal(by.desk2.provenance, null);
	assert.equal(by[String(created.session)].provenance, "created");
	assert.equal(by.child, undefined, "subagents are not listed");
	await assert.rejects(manager.handle("kill", { session: "desk1" }), (e: Error & { code?: string }) => e.code === "refused");
	await assert.rejects(manager.handle("kill", { session: "desk2" }), (e: Error & { code?: string }) => e.code === "refused");
	assert.ok(!daemon.ops().includes("kill"));
	await manager.handle("kill", { session: created.session });
	assert.deepEqual(
		daemon.calls.filter((c) => c.op === "kill").map((c) => c.args[0]),
		[created.session],
	);
	// provenance is persisted
	const state = JSON.parse(readFileSync(stateFile, "utf8"));
	assert.deepEqual(
		state.sessions.map((s: Message) => [s.handle, s.provenance]),
		[["desk1", "taken_over"]],
	);
	// detach stops tracking without killing
	await manager.handle("detach", { session: "desk1" });
	assert.ok(daemon.live.has("desk1"));
	assert.deepEqual(manager.handles(), []);
});

test("attach adopts an exact-folder desk session as taken_over and detach never kills it", async () => {
	const { daemon, manager, stateFile } = setup();
	daemon.addLive({ handle: "desk", sessionId: "desk-saved", cwd: "/srv/homelab", name: "notes" });
	const info = (await manager.handle("attach", { session: "desk", project: "homelab", cwd: "/srv/homelab" })) as Message;
	assert.equal(info.provenance, "taken_over");
	assert.equal(info.session_id, "desk-saved");
	const state = JSON.parse(readFileSync(stateFile, "utf8"));
	assert.equal(state.sessions[0].provenance, "taken_over");
	await manager.handle("join_call", { session: "desk", token: "call", persona: "Jev", speech_deadline_ms: 1000 });
	await manager.handle("detach", { session: "desk" });
	assert.equal(daemon.live.has("desk"), true);
	assert.ok(!daemon.ops().includes("kill"));
});

test("attach registers the skill socket and detach unregisters it", async () => {
	const { daemon, manager } = setup();
	daemon.addLive({ handle: "desk", sessionId: "desk-saved", cwd: "/srv/homelab", name: "notes" });
	const socket = new SkillSocket({
		socketPath: path.join(mkdtempSync(path.join(os.tmpdir(), "sb-skill-")), "host-agent.sock"),
		lookup: (sessionId) => manager.bySessionId(sessionId),
		relay: async () => ({ status: "delivered", reason: null }),
	});
	const request = (value: Record<string, unknown>) => socket.handle(JSON.stringify(value));
	await manager.handle("attach", { session: "desk", project: "homelab", cwd: "/srv/homelab" });
	await manager.handle("join_call", { session: "desk", token: "call", persona: "Jev", speech_deadline_ms: 1000 });
	assert.deepEqual(
		await request({ op: "call", session_id: "desk-saved", depth: 0, token: "call", call: "speak", args: { text: "hello" } }),
		{ status: "delivered", reason: null },
	);
	await manager.handle("detach", { session: "desk" });
	assert.deepEqual(await request({ op: "hello", session_id: "desk-saved", depth: 0 }), { on_call: false });
	assert.deepEqual(
		await request({ op: "call", session_id: "desk-saved", depth: 0, token: "call", call: "speak", args: { text: "stale" } }),
		{ status: "refused", reason: "not_on_call" },
	);
	assert.equal(daemon.live.has("desk"), true);
});

test("attach refuses a folder mismatch and an already tracked session", async () => {
	const { daemon, manager } = setup();
	daemon.addLive({ handle: "desk", cwd: "/srv/homelab" });
	await assert.rejects(manager.handle("attach", { session: "desk", project: "homelab", cwd: "/srv/other" }), (e: Error & { code?: string }) => e.code === "refused");
	await manager.handle("attach", { session: "desk", project: "homelab", cwd: "/srv/homelab" });
	await assert.rejects(manager.handle("attach", { session: "desk", project: "homelab", cwd: "/srv/homelab" }), (e: Error & { code?: string }) => e.code === "refused");
});

test("resume: open_session reopens a saved sb- session; a desk session is refused", async () => {
	const { daemon, manager } = setup();
	daemon.saved.set("old1", { handle: "", sessionId: "old1", name: "sb-homelab-1234abcd", cwd: "/srv/homelab", busy: false, model: null, thinking: "low", depth: 0 });
	daemon.saved.set("desk", { handle: "", sessionId: "desk", name: "my-notes", cwd: "/srv/homelab", busy: false, model: null, thinking: "low", depth: 0 });
	const saved = (await manager.handle("list_saved_sessions", { cwd: "/srv/homelab", project: "homelab" })) as { sessions: Message[] };
	assert.deepEqual(
		saved.sessions.map((s) => s.session_id),
		["old1"],
	);
	await assert.rejects(manager.handle("open_session", { session_id: "old1", project: "homelab" }), (e: Error & { code?: string }) => e.code === "bad_request");
	const info = (await manager.handle("open_session", { session_id: "old1", cwd: "/srv/homelab", project: "homelab" })) as Message;
	assert.equal(info.session_id, "old1");
	assert.equal(info.provenance, "created");
	assert.equal(info.project, "homelab");
	// The project folder reaches the daemon: a reopen without it runs in the daemon's own directory.
	assert.deepEqual(daemon.calls.find((c) => c.op === "open")?.args, ["old1", "/srv/homelab"]);
	assert.equal(info.cwd, "/srv/homelab");
	const opensBefore = daemon.calls.filter((c) => c.op === "open").length;
	await assert.rejects(manager.handle("open_session", { session_id: "desk", cwd: "/srv/homelab" }), (e: Error & { code?: string }) => e.code === "refused");
	assert.deepEqual(manager.handles(), [info.session]);
	// The refusal happened on the saved record: the desk session was never
	// made live, where a refused-but-opened session would run unseen.
	assert.equal(daemon.calls.filter((c) => c.op === "open").length, opensBefore);
	assert.equal([...daemon.live.values()].some((s) => s.sessionId === "desk"), false);
});

test("a turn settles on wait_for_idle after the last input, not on agent_end", async () => {
	const { daemon, manager, kinds } = setup();
	const s = String(((await manager.createSession("homelab", CONFIG)) as Message).session);
	await manager.prompt(s, "hello");
	assert.deepEqual(kinds(s), ["turn_start"]);
	daemon.emit(s, { type: "agent_start" });
	daemon.emit(s, { type: "tool_execution_start", toolName: "ipython", toolCallId: "t1" });
	daemon.emit(s, { type: "tool_execution_end", toolName: "ipython", toolCallId: "t1", isError: false });
	daemon.emit(s, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi there" }], stopReason: "stop" } });
	daemon.emit(s, { type: "agent_end" });
	await flush();
	assert.deepEqual(kinds(s), ["turn_start", "tool_start", "tool_end", "text"], "agent_end does not end the turn");
	// a steer arrives before the first wait resolves: only the latest wait settles
	await manager.input(s, "steer", "also this");
	assert.equal(daemon.pendingIdle(s), 2);
	daemon.emit(s, { type: "agent_end" });
	daemon.idle(s);
	await flush();
	assert.deepEqual(kinds(s).slice(-1), ["turn_end"]);
	assert.equal(kinds(s).filter((k) => k === "turn_end").length, 1);
	assert.equal(kinds(s).filter((k) => k === "turn_start").length, 1);
});

test("tool events carry optional args, result and turn id, clipped for the debug page", async () => {
	const { daemon, manager, events } = setup();
	const s = String(((await manager.createSession("homelab", CONFIG)) as Message).session);
	await manager.prompt(s, "hello");
	const turnId = events.find((e) => e.event.kind === "turn_start")?.event.turn_id;
	assert.equal(typeof turnId, "string");
	daemon.emit(s, { type: "tool_execution_start", toolName: "bash", toolCallId: "t1", args: { command: "cargo test" } });
	daemon.emit(s, { type: "tool_execution_end", toolName: "bash", toolCallId: "t1", isError: false, result: { content: [{ type: "text", text: "ok" }] } });
	const big = "x".repeat(TOOL_DETAIL_LIMIT * 2);
	daemon.emit(s, { type: "tool_execution_start", toolName: "read", toolCallId: "t2" });
	daemon.emit(s, { type: "tool_execution_end", toolName: "read", toolCallId: "t2", isError: true, result: { content: [{ type: "text", text: big }] } });
	await flush();
	const tools = events.filter((e) => e.event.kind === "tool_start" || e.event.kind === "tool_end").map((e) => e.event);
	assert.deepEqual(tools[0], { kind: "tool_start", tool: "bash", call_id: "t1", args: { command: "cargo test" }, turn_id: turnId });
	assert.deepEqual(tools[1], { kind: "tool_end", tool: "bash", call_id: "t1", error: false, result: { content: [{ type: "text", text: "ok" }] }, turn_id: turnId });
	assert.equal("args" in tools[2], false, "a start without args sends none");
	const clipped = tools[3].result as { clipped: boolean; bytes: number; preview: string };
	assert.equal(clipped.clipped, true);
	assert.ok(clipped.bytes > TOOL_DETAIL_LIMIT);
	assert.ok(Buffer.byteLength(clipped.preview, "utf8") <= TOOL_DETAIL_LIMIT);
	assert.equal(tools[3].error, true);
});

test("clipDetail cuts multi-byte text on a character boundary", () => {
	const value = "é".repeat(TOOL_DETAIL_LIMIT);
	const clipped = clipDetail(value) as { clipped: boolean; preview: string };
	assert.equal(clipped.clipped, true);
	assert.ok(Buffer.byteLength(clipped.preview, "utf8") <= TOOL_DETAIL_LIMIT);
	assert.equal(clipped.preview.includes("\uFFFD"), false);
	assert.deepEqual(clipDetail({ small: 1 }), { small: 1 });
	assert.equal(clipDetail(undefined), undefined);
});

// The service cannot read a frame with half a surrogate pair in it, and
// drops the whole tool event. A cut at the byte limit used to land inside an
// emoji for about half of all offsets.
test("clipDetail never leaves half a surrogate pair in the preview", () => {
	const isWellFormed = (text: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
	for (const pad of ["", "a", "é", "€", "a€"]) {
		for (let n = 0; n < 8; n++) {
			const clipped = clipDetail({ text: pad.repeat(n) + "😀".repeat(1200) }) as { preview: string };
			assert.ok(isWellFormed(clipped.preview), `${JSON.stringify(pad)} x ${n}`);
			assert.ok(Buffer.byteLength(clipped.preview, "utf8") <= TOOL_DETAIL_LIMIT);
			// Whole characters up to the limit: no more than one emoji short of it.
			assert.ok(Buffer.byteLength(clipped.preview, "utf8") > TOOL_DETAIL_LIMIT - 4);
		}
	}
	// A lone surrogate the value already held reaches the preview as the
	// escape JSON.stringify wrote for it.
	const lone = clipDetail({ text: `${"x".repeat(10)}\ud83d${"y".repeat(TOOL_DETAIL_LIMIT)}` }) as { preview: string };
	assert.ok(isWellFormed(lone.preview));
	assert.ok(lone.preview.includes("x\\ud83dy"));
});

test("an agent_start nobody caused opens a turn that settles the same way", async () => {
	const { daemon, manager, events, kinds } = setup();
	const s = String(((await manager.createSession("homelab", CONFIG)) as Message).session);
	daemon.emit(s, { type: "agent_start" });
	await flush();
	assert.equal((events.at(-1)?.event as Record<string, unknown>).kind, "turn_start");
	assert.equal((events.at(-1)?.event as Record<string, unknown>).cause, "autonomous");
	assert.match(String((events.at(-1)?.event as Record<string, unknown>).turn_id), /^turn-[0-9a-f]{16}$/);
	assert.equal(daemon.pendingIdle(s), 1);
	daemon.emit(s, { type: "agent_start" }); // a second run inside the same turn
	daemon.idle(s);
	await flush();
	assert.deepEqual(kinds(s), ["turn_start", "turn_end"]);
});

test("a busy session gets follow_up, not prompt; abort is followed by resume_queue", async () => {
	const { daemon, manager, kinds } = setup();
	const s = String(((await manager.createSession("homelab", CONFIG)) as Message).session);
	assert.deepEqual(await manager.prompt(s, "one"), { sent_as: "prompt" });
	assert.deepEqual(await manager.prompt(s, "two"), { sent_as: "follow_up" });
	assert.deepEqual(
		daemon.ops().filter((o) => o === "prompt" || o === "followUp"),
		["prompt", "followUp"],
	);
	await manager.handle("abort", { session: s });
	const ops = daemon.ops();
	assert.equal(ops[ops.indexOf("abort") + 1], "resumeQueue", "resume_queue right after abort (its error is ignored)");
	assert.equal(ops.at(-1), "waitForIdle", "wait_for_idle after the abort");
	daemon.idle(s);
	await flush();
	assert.equal(kinds(s).at(-1), "turn_end");
	// a prompt that the daemon refuses as busy is resent as follow_up
	daemon.busy.add(s);
	assert.deepEqual(await manager.prompt(s, "three"), { sent_as: "follow_up" });
});

test("set_thinking reports the effective (clamped) level; set_model reads back the model", async () => {
	const { manager, events } = setup();
	const s = String(((await manager.createSession("homelab", CONFIG)) as Message).session);
	assert.deepEqual(await manager.handle("set_thinking", { session: s, level: "xhigh" }), { model: "anthropic/claude-x", thinking: "high" });
	assert.deepEqual(events.at(-1)?.event, { kind: "state", model: "anthropic/claude-x", thinking: "high" });
	assert.deepEqual(await manager.handle("set_model", { session: s, provider: "openai", model: "gpt-z" }), { model: "openai/gpt-z", thinking: "high" });
});

test("a session the daemon stops running is dropped now, not at the next resync", async () => {
	const { daemon, manager, events } = setup();
	const s = String(((await manager.createSession("homelab", CONFIG)) as Message).session);
	const other = String(((await manager.createSession("notes", CONFIG)) as Message).session);
	// Another daemon client killed it: the daemon's own session_closed is
	// all this host agent hears, and it is enough.
	daemon.closeSession(s, "killed");
	assert.deepEqual(manager.handles(), [other]);
	assert.deepEqual(events.filter((e) => e.handle === s).at(-1)?.event, { kind: "session_closed", reason: "gone" });
	assert.equal(manager.bySessionId("s1"), null);
	await assert.rejects(manager.handle("prompt", { session: s, message: "hi" }), (e: Error & { code?: string }) => e.code === "not_found");
	// Reopening it later is a fresh track, not a leftover.
	daemon.saved.get("s1")!.cwd = "/srv/homelab";
	const reopened = (await manager.handle("open_session", { session_id: "s1", cwd: "/srv/homelab", project: "homelab" })) as Message;
	assert.notEqual(reopened.session, s);
});

test("compaction, errors and session_closed are forwarded as events", async () => {
	const { daemon, manager, events } = setup();
	const s = String(((await manager.createSession("homelab", CONFIG)) as Message).session);
	daemon.emit(s, { type: "compaction_start", reason: "threshold" });
	daemon.emit(s, { type: "compaction_end", reason: "threshold" });
	daemon.emit(s, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "503" } });
	await manager.kill(s);
	assert.deepEqual(
		events.map((e) => e.event),
		[
			{ kind: "compaction", phase: "start", reason: "threshold" },
			{ kind: "compaction", phase: "end", reason: "threshold" },
			{ kind: "error", message: "503" },
			{ kind: "session_closed", reason: "killed" },
		],
	);
});

test("a daemon that reports one command unsupported fails that command cleanly; others work", async () => {
	const { daemon, manager } = setup();
	daemon.unsupported.add("setThinking");
	const s = String(((await manager.createSession("homelab", CONFIG)) as Message).session);
	await assert.rejects(manager.handle("set_thinking", { session: s, level: "low" }), (e: unknown) => e instanceof DaemonCommandError && e.unsupported);
	assert.deepEqual(await manager.handle("prompt", { session: s, message: "still works" }), { sent_as: "prompt" });
	assert.ok(((await manager.handle("list_sessions", {})) as { sessions: unknown[] }).sessions.length === 1);
});

test("catalog: list_models returns the daemon host's models", async () => {
	const { manager } = setup();
	assert.deepEqual(await manager.handle("list_models", {}), { models: [{ provider: "anthropic", id: "claude-x", name: "Claude X", reasoning: true }] });
});

test("prepare: output, failure, bounded output and timeout reports", async () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "sb-prep-"));
	const ok = await runPrepare({ cwd, command: "pwd; echo err >&2" });
	assert.equal(ok.outcome, "succeeded");
	assert.equal(ok.exit_code, 0);
	assert.equal(ok.stdout.trim(), cwd);
	assert.equal(ok.stderr.trim(), "err");
	const failed = await runPrepare({ cwd, command: "exit 3" });
	assert.equal(failed.outcome, "failed");
	assert.equal(failed.exit_code, 3);
	const big = await runPrepare({ cwd, command: "head -c 100000 /dev/zero | tr '\\0' a; echo END" });
	assert.equal(big.truncated, true);
	assert.equal(big.stdout.length, PREPARE_OUTPUT_LIMIT);
	assert.ok(big.stdout.endsWith("END\n"), "the tail is kept");
	const slow = await runPrepare({ cwd, command: "echo started; sleep 5", timeoutMs: 200 });
	assert.equal(slow.outcome, "timed_out");
	assert.equal(slow.stdout.trim(), "started");
	assert.ok(slow.duration_ms < 4000);
	const viaCommand = (await setup().manager.handle("run_prepare", { cwd, command: "true" })) as Message;
	assert.equal(viaCommand.outcome, "succeeded");
});

test("prepare: a shell that exits while a process it started holds the output pipes settles on the shell's exit", async () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "sb-prep-"));
	// The backgrounded sleep inherits stdout and stderr; the shell exits 0 at once.
	const background = await runPrepare({ cwd, command: "sleep 6 & echo started", timeoutMs: 5000 });
	assert.equal(background.outcome, "succeeded", JSON.stringify(background));
	assert.equal(background.exit_code, 0);
	assert.equal(background.stdout, "started\n");
	// A shell that does overrun is killed with its group, and the reply still
	// comes when a process in another session (setsid) keeps the pipes open.
	const overrun = await runPrepare({ cwd, command: "setsid sleep 8 & echo started; sleep 5", timeoutMs: 200 });
	assert.equal(overrun.outcome, "timed_out", JSON.stringify(overrun));
	assert.equal(overrun.stdout, "started\n");
	assert.ok(overrun.duration_ms < 6000, `settled after ${overrun.duration_ms} ms, not when the setsid process let go`);
});

test("a host-agent restart reattaches from the daemon and sends each session a snapshot", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "sb-host-"));
	const stateFile = path.join(dir, "sessions.json");
	const daemon = new FakeDaemon();
	const service = await FakeService.start();
	const cursors: Record<string, string> = {};
	service.onHello = (l) => l.send({ type: "welcome", epoch: ++service.epoch, protocol: 1, cursors });
	const makeAgent = () => {
		const manager: SessionManager = new SessionManager({ port: daemon, stateFile, emit: (h, e) => link.publish(h, e) });
		const link: HostLink = new HostLink({
			url: service.url,
			hostId: "h1",
			token: "t",
			gitSha: "sha",
			versions: () => ({ prime_agent_client: null, prime_agent_daemon: null, daemon_protocol: 7 }),
			command: (n, a) => manager.handle(n, a),
			sessions: () => manager.handles(),
			describe: (h) => manager.describe(h),
			heartbeatMs: 1000,
			backoffInitialMs: 10,
		});
		return { manager, link };
	};
	const first = makeAgent();
	try {
		await first.manager.resync();
		first.link.start();
		const l0 = await service.link(0);
		await l0.next((m) => m.type === "synced");
		const created = (await command(l0, 1, "c1", "create_session", { project: "homelab", config: CONFIG })) as Message;
		assert.equal(created.ok, true);
		const handle = String((created.result as Message).session);
		await command(l0, 1, "c2", "prompt", { session: handle, message: "go" });
		const ev = await l0.next((m) => m.type === "event" && (m.event as Message).kind === "turn_start");
		cursors[handle] = String(ev.cursor);
		first.link.stop();
		await l0.closed;
		// The host agent restarts; the session is still busy in the daemon.
		(daemon.live.get(handle) as { busy: boolean }).busy = true;
		const second = makeAgent();
		const { live } = await second.manager.resync();
		assert.deepEqual(live, [handle]);
		second.link.start();
		const l1 = await service.link(1);
		await l1.next((m) => m.type === "synced");
		const snap = l1.received.find((m) => m.type === "snapshot" && m.session === handle) as Message;
		assert.ok(snap, "a snapshot, not a replay, after a restart");
		const info = snap.info as Message;
		assert.equal(info.provenance, "created");
		assert.equal(info.turn_open, true);
		assert.equal(info.last_text, "hello from the snapshot");
		assert.notEqual(second.link.bootId, first.link.bootId);
		assert.equal(String(snap.cursor).split(":")[0], second.link.bootId);
		// the rebuilt turn settles on wait_for_idle
		daemon.idle(handle);
		await l1.next((m) => m.type === "event" && (m.event as Message).kind === "turn_end");
		second.link.stop();
	} finally {
		first.link.stop();
		await service.close();
	}
});

test("the host agent never starts a daemon: DaemonPort has no start, and a lost daemon is resynced", async () => {
	const { daemon, manager, kinds } = setup();
	const s = String(((await manager.createSession("homelab", CONFIG)) as Message).session);
	daemon.live.delete(s); // the desk replaced the daemon; this worker is gone
	const { live, closed } = await manager.resync();
	assert.deepEqual(live, []);
	assert.deepEqual(closed, [s]);
	assert.equal(kinds(s).at(-1), "session_closed");
	assert.ok(daemon.ops().every((op) => !/start|launch|spawn|ensure/i.test(op)));
});

test("rediscovery restores service-created and taken-over provenance", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "sb-host-"));
	const stateFile = path.join(dir, "sessions.json");
	const daemon = new FakeDaemon();
	daemon.addLive({ handle: "desk", name: "notes", cwd: "/srv/homelab" });
	writeFileSync(stateFile, JSON.stringify({ version: 1, sessions: [
		{ handle: "desk", session_id: "sid-desk", name: "notes", project: "homelab", cwd: "/srv/homelab", provenance: "taken_over" },
	], used_names: [] }));
	const { manager } = setup({ daemon, stateFile });
	const { live } = await manager.resync();
	assert.deepEqual(live, ["desk"]);
	const listed = ((await manager.handle("list_sessions", {})) as { sessions: Message[] }).sessions;
	assert.equal(listed[0]?.provenance, "taken_over");
	assert.equal(listed[0]?.project, "homelab");
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PREPARE_OUTPUT_LIMIT, Prepares, runPrepare } from "../src/prepare.ts";

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

test("prepare: a second run_prepare of the same command in the same folder joins the running one", async () => {
	// The service sends run_prepare again when its link drops mid-prepare;
	// a second copy must not race the first in the same tree (#292).
	const cwd = mkdtempSync(path.join(os.tmpdir(), "sb-prep-"));
	const prepares = new Prepares();
	const command = "echo x >> runs.txt; sleep 1; echo done";
	const [first, second] = await Promise.all([prepares.run({ cwd, command }), prepares.run({ cwd, command })]);
	assert.equal(readFileSync(path.join(cwd, "runs.txt"), "utf8"), "x\n", "the command ran once");
	assert.deepEqual(second, first);
	assert.equal(first.outcome, "succeeded");
	// Once it has finished, the same command runs again.
	await prepares.run({ cwd, command: "echo x >> runs.txt" });
	assert.equal(readFileSync(path.join(cwd, "runs.txt"), "utf8"), "x\nx\n");
});

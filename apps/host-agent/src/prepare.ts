// A project's prepare command, run on this host for the service's
// `run_prepare` (docs/host-link.md, "Commands"): `sh -c` in the project
// folder, bounded in output and time.

import { spawn } from "node:child_process";

/** Output kept per stream; the tail is kept, the head dropped. */
export const PREPARE_OUTPUT_LIMIT = 16 * 1024;
export const PREPARE_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface PrepareResult {
	outcome: "succeeded" | "failed" | "timed_out";
	exit_code: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	duration_ms: number;
}

class Tail {
	#chunks: Buffer[] = [];
	#size = 0;
	truncated = false;
	push(chunk: Buffer): void {
		this.#chunks.push(chunk);
		this.#size += chunk.length;
		while (this.#size > PREPARE_OUTPUT_LIMIT) {
			const extra = this.#size - PREPARE_OUTPUT_LIMIT;
			const head = this.#chunks[0];
			this.truncated = true;
			if (head.length <= extra) {
				this.#chunks.shift();
				this.#size -= head.length;
			} else {
				this.#chunks[0] = head.subarray(extra);
				this.#size -= extra;
			}
		}
	}
	text(): string {
		return Buffer.concat(this.#chunks).toString("utf8");
	}
}

/**
 * How long output is still read after the shell exits. A process the command
 * left running (`server &`) inherits the output pipes and can hold them open
 * for as long as it runs; waiting for them would hold the prepare until its
 * timeout. Output the shell wrote is already in the pipes, so a short wait
 * reads it. Then our ends are closed: a process left behind that writes to
 * them later gets SIGPIPE, which ends it unless it ignores the signal.
 */
export const PREPARE_DRAIN_MS = 500;

/**
 * Run a project's prepare command with `sh -c` in its folder, bounded in
 * output and time. It settles on the shell's exit, after PREPARE_DRAIN_MS
 * at most for the output pipes, not when every process holding them is gone.
 * A shell that overruns `timeoutMs` is killed with its process group.
 */
export function runPrepare(options: { cwd: string; command: string; timeoutMs?: number }): Promise<PrepareResult> {
	const timeoutMs = options.timeoutMs ?? PREPARE_DEFAULT_TIMEOUT_MS;
	const started = Date.now();
	return new Promise((resolve) => {
		const stdout = new Tail();
		const stderr = new Tail();
		let timedOut = false;
		let settled = false;
		let exit: { code: number | null; signal: string | null } = { code: null, signal: null };
		let drain: NodeJS.Timeout | undefined;
		const child = spawn("sh", ["-c", options.command], { cwd: options.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", (c: Buffer) => stdout.push(c));
		child.stderr.on("data", (c: Buffer) => stderr.push(c));
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				// Kill the whole process group, not only the shell.
				process.kill(-(child.pid as number), "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, timeoutMs);
		const finish = (spawnError?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(drain);
			resolve({
				outcome: timedOut ? "timed_out" : exit.code === 0 ? "succeeded" : "failed",
				exit_code: exit.code,
				signal: exit.signal,
				stdout: stdout.text(),
				stderr: spawnError ? spawnError.message : stderr.text(),
				truncated: stdout.truncated || stderr.truncated,
				duration_ms: Date.now() - started,
			});
		};
		child.on("error", (error) => finish(error));
		child.on("exit", (code, signal) => {
			exit = { code, signal };
			clearTimeout(timer);
			drain = setTimeout(() => {
				// Stop reading: a process left behind keeps the pipes open.
				child.stdout.destroy();
				child.stderr.destroy();
				finish();
			}, PREPARE_DRAIN_MS);
		});
		// Every pipe closed after the exit: all the output is in.
		child.on("close", () => finish());
	});
}

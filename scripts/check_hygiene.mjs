#!/usr/bin/env node
// Fails when one of the repo's structural invariants is broken. Each check
// below is a rule in AGENTS.md ("Working here") that a grep can enforce; the
// reasons are there. Prints file:line per finding. Run by `npm test`, so CI
// enforces it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipped = new Set(["node_modules", "dist", "target", ".git", "static", "static-debug", "test-results"]);
const findings = [];

function* files(entry, exts) {
	const stat = statSync(entry);
	if (stat.isFile()) {
		if (exts.has(path.extname(entry))) yield entry;
		return;
	}
	for (const name of readdirSync(entry)) {
		if (!skipped.has(name)) yield* files(path.join(entry, name), exts);
	}
}
const rel = (file) => path.relative(root, file);
const lines = (file) => readFileSync(file, "utf8").split("\n");
function scan(file, pattern, finding) {
	lines(file).forEach((line, index) => {
		if (pattern.test(line)) findings.push(`${rel(file)}:${index + 1}: ${finding}`);
	});
}

// 1. The backend's modules are private, so -D warnings finds dead code.
scan(path.join(root, "apps/backend/src/main.rs"), /^pub mod /, "pub mod: modules stay private (AGENTS.md)");

// 2. No lint allowance in the backend: delete the item, cfg(test) it, or
//    argue with the lint in the commit.
for (const file of files(path.join(root, "apps/backend/src"), new Set([".rs"]))) {
	scan(file, /#!?\[allow\(/, "lint allowance (AGENTS.md: none in the backend)");
}

// 3. Only Config reads the environment (build.rs stamps the commit).
for (const file of files(path.join(root, "apps/backend/src"), new Set([".rs"]))) {
	if (file.endsWith("main.rs")) continue;
	scan(file, /\b(?:std::)?env::(?:var|vars|var_os)\b/, "environment read outside Config (AGENTS.md)");
}

// 4. Every environment name Config reads is in docs/environment.md: the
//    env file is the contract with homelab, and the doc is its text.
{
	const config = readFileSync(path.join(root, "apps/backend/src/main.rs"), "utf8") + readFileSync(path.join(root, "build.rs"), "utf8");
	const doc = readFileSync(path.join(root, "docs/environment.md"), "utf8");
	for (const name of new Set(config.match(/"(?:SWITCHBOARD|ELEVENLABS|JEV)_[A-Z0-9_]+"/g) ?? [])) {
		const bare = name.slice(1, -1);
		if (!doc.includes(bare)) findings.push(`apps/backend/src/main.rs: ${bare} is read but not in docs/environment.md`);
	}
}

// 5. Fake executables go through write_executable_script, which owns the
//    permission and broken-pipe hazards (docs/concurrency-and-test-hazards.md).
for (const file of files(path.join(root, "apps/backend/tests"), new Set([".rs"]))) {
	scan(file, /set_permissions\(|set_mode\(0o7/, "a fake executable written by hand (use write_executable_script)");
}

// 6. The skill socket path is one path, built into both the host agent and
//    the Python skill (#163). Both sides name it; they must agree.
{
	const ts = readFileSync(path.join(root, "apps/host-agent/src/main.ts"), "utf8");
	const py = readFileSync(path.join(root, "skills/switchboard/src/switchboard/__init__.py"), "utf8");
	const tsPath = ts.match(/SKILL_SOCKET_PATH = "~\/([^"]+)"/)?.[1];
	const pyParts = py.match(/_os\.path\.expanduser\("~"\)((?:,\s*"[^"]+")+)\)/)?.[1]?.match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1));
	if (!tsPath || !pyParts) findings.push("skill socket path: could not read it from main.ts or __init__.py (the check needs updating)");
	else if (tsPath !== pyParts.join("/")) findings.push(`skill socket path differs: host agent ~/${tsPath}, skill ~/${pyParts.join("/")}`);
}

// The markdown the doc checks read: the docs and every markdown file in
// the tree (READMEs, AGENTS.md, ARCHITECTURE.md, DESIGN_SYSTEM.md, SKILL.md).
const markdown = () => ["AGENTS.md", "README.md", "docs", "apps", "skills", "extensions"].flatMap((start) => [...files(path.join(root, start), new Set([".md"]))]);

// 7. Every repo path a doc names exists. A bare `src/` or `tests/` is
//    relative to the prose, not the root, and is skipped.
for (const file of markdown()) {
	lines(file).forEach((line, index) => {
		for (const m of line.matchAll(/(?<![\w/.-])((?:apps|docs|skills|extensions|scripts|static|static-debug)\/[\w./-]*)/g)) {
			const target = m[1].replace(/[.,;:)]+$/, "").replace(/\/$/, "");
			if (target.includes("*") || target.includes("<") || !target.includes("/")) continue;
			if (!existsSync(path.join(root, target))) findings.push(`${rel(file)}:${index + 1}: names ${target}, which does not exist`);
		}
	});
}

// 8. Every HTTP route a doc names in a code span, with its method
//    (`POST /connect`), is one the service routes. Agents' display, view
//    and speak calls once had routes; they come over the host link now, and
//    a doc that still names `POST /display` sends a reader to a 404. A route
//    in prose or in a fenced block is not read.
{
	const routes = new Set();
	const methods = /\b(get|post|put|patch|delete)\(/g;
	for (const file of files(path.join(root, "apps/backend/src"), new Set([".rs"]))) {
		// Each `.route("/path", ...)` up to the next route or the end of the
		// chain, so `get(a).post(b)` gives both methods.
		const source = readFileSync(file, "utf8");
		for (const m of source.matchAll(/\.route\(\s*"([^"]+)",([\s\S]*?)(?=\.route\(|\.with_state\(|\.fallback|;)/g)) {
			for (const method of m[2].matchAll(methods)) routes.add(`${method[1].toUpperCase()} ${m[1]}`);
		}
	}
	if (routes.size === 0) findings.push("routes: found none in apps/backend/src (the check needs updating)");
	for (const file of markdown()) {
		lines(file).forEach((line, index) => {
			for (const m of line.matchAll(/`(GET|POST|PUT|PATCH|DELETE) (\/[^`\s?#]*)/g)) {
				const route = `${m[1]} ${m[2]}`;
				if (!routes.has(route)) findings.push(`${rel(file)}:${index + 1}: names ${route}, which the service does not route`);
			}
		});
	}
}

// 9. Every SWITCHBOARD_ name a doc names is one docs/environment.md names,
//    exactly: it writes the live ones in full and the retired ones without
//    the prefix. A doc that names a retired setting in full
//    (`SWITCHBOARD_DISPLAY_URL`) tells a reader to set something nothing
//    reads.
{
	const name = /\bSWITCHBOARD_[A-Z0-9][A-Z0-9_]*/g;
	const documented = new Set(readFileSync(path.join(root, "docs/environment.md"), "utf8").match(name) ?? []);
	for (const file of markdown()) {
		lines(file).forEach((line, index) => {
			for (const m of line.matchAll(name)) {
				if (!documented.has(m[0])) findings.push(`${rel(file)}:${index + 1}: names ${m[0]}, which docs/environment.md does not list`);
			}
		});
	}
}

// 10. The depth a host-link frame may nest is one number on both sides: the
//     service's MAX_FRAME_DEPTH (serde_json's limit; a test in
//     test_hosts.rs pins it) and the skill module's _MAX_FRAME_DEPTH, which
//     holds a display call to it before sending.
{
	const rs = readFileSync(path.join(root, "apps/backend/src/hosts.rs"), "utf8").match(/const MAX_FRAME_DEPTH: usize = (\d+);/)?.[1];
	const py = readFileSync(path.join(root, "skills/switchboard/src/switchboard/__init__.py"), "utf8").match(/^_MAX_FRAME_DEPTH = (\d+)$/m)?.[1];
	if (!rs || !py) findings.push("frame depth: could not read it from hosts.rs or __init__.py (the check needs updating)");
	else if (rs !== py) findings.push(`frame depth differs: service MAX_FRAME_DEPTH ${rs}, skill _MAX_FRAME_DEPTH ${py}`);
}

// 11. The size caps are one set of numbers wherever they are written. The
//     raw image cap is in both validators, in the skill module (which
//     refuses a larger file before sending) and in the schema (as the
//     base64 length of that many bytes); the action caps, general and
//     image, are in both validators and in the skill module, which names
//     them with the skill socket's line cap when a request is too large.
//     Each link the action crosses leaves room around it: the
//     skill socket's line holds the action and 1 MiB of envelope, and the
//     host link's frame holds that line and 1 MiB more. The corpus pins what
//     the validators make of the caps; this pins the copies it cannot run.
{
	// A cap as the source writes it: an integer or a product of integers (`8 * 1024 * 1024`).
	const cap = (file, pattern) => {
		const text = readFileSync(path.join(root, file), "utf8").match(pattern)?.[1];
		if (!text || !/^\d[\d_]*(?:\s*\*\s*\d[\d_]*)*$/.test(text.trim())) {
			findings.push(`image caps: could not read ${pattern.source} from ${file} (the check needs updating)`);
			return NaN;
		}
		return text.split("*").reduce((product, factor) => product * Number(factor.trim().replaceAll("_", "")), 1);
	};
	const mib = 1024 * 1024;
	const image = {
		"validation.ts": cap("apps/frontend/src/controller/validation.ts", /^export const MAX_IMAGE_BYTES = ([^;]+);$/m),
		"visual_protocol.rs": cap("apps/backend/src/visual_protocol.rs", /^pub const MAX_IMAGE_BYTES: usize = ([^;]+);$/m),
		"__init__.py": cap("skills/switchboard/src/switchboard/__init__.py", /^_MAX_IMAGE_BYTES = (.+)$/m),
	};
	const action = {
		"validation.ts": cap("apps/frontend/src/controller/validation.ts", /^export const MAX_IMAGE_ACTION_BYTES = ([^;]+);$/m),
		"visual_protocol.rs": cap("apps/backend/src/visual_protocol.rs", /^pub const MAX_IMAGE_ACTION_BYTES: usize = ([^;]+);$/m),
		"__init__.py": cap("skills/switchboard/src/switchboard/__init__.py", /^_MAX_IMAGE_ACTION_BYTES = (.+)$/m),
	};
	// The general action cap, which the skill module names in its words for
	// a request too large to send.
	const general = {
		"validation.ts": cap("apps/frontend/src/controller/validation.ts", /^const MAX_ACTION_BYTES = ([^;]+);$/m),
		"visual_protocol.rs": cap("apps/backend/src/visual_protocol.rs", /^pub const MAX_ACTION_BYTES: usize = ([^;]+);$/m),
		"__init__.py": cap("skills/switchboard/src/switchboard/__init__.py", /^_MAX_ACTION_BYTES = (.+)$/m),
	};
	const lineCaps = {
		"skill_socket.ts": cap("apps/host-agent/src/skill_socket.ts", /^export const MAX_LINE_BYTES = ([^;]+);$/m),
		"__init__.py": cap("skills/switchboard/src/switchboard/__init__.py", /^_MAX_LINE_BYTES = (.+)$/m),
	};
	const line = lineCaps["skill_socket.ts"];
	const frame = cap("apps/backend/src/hosts.rs", /^const MAX_HOST_FRAME_BYTES: usize = ([^;]+);$/m);
	const schema = JSON.parse(readFileSync(path.join(root, "docs/display-action-v1.schema.json"), "utf8"));
	const base64 = schema.definitions?.ImageData?.properties?.bytes?.maxLength;
	const read = [...Object.values(image), ...Object.values(action), ...Object.values(general), ...Object.values(lineCaps), frame].every((value) => !Number.isNaN(value));
	const same = (what, values) => {
		if (new Set(Object.values(values)).size > 1) findings.push(`${what} differs: ${Object.entries(values).map(([file, value]) => `${file} ${value}`).join(", ")}`);
	};
	if (read) {
		same("raw image cap (MAX_IMAGE_BYTES)", image);
		same("image action cap (MAX_IMAGE_ACTION_BYTES)", action);
		same("action cap (MAX_ACTION_BYTES)", general);
		same("skill socket line cap (MAX_LINE_BYTES)", lineCaps);
		const raw = image["validation.ts"];
		if (base64 !== 4 * Math.ceil(raw / 3)) findings.push(`docs/display-action-v1.schema.json: ImageData.bytes maxLength ${base64} is not the base64 length of ${raw} bytes (${4 * Math.ceil(raw / 3)})`);
		if (line < action["validation.ts"] + mib) findings.push(`apps/host-agent/src/skill_socket.ts: MAX_LINE_BYTES ${line} leaves less than 1 MiB around a ${action["validation.ts"]}-byte image action`);
		if (frame < line + mib) findings.push(`apps/backend/src/hosts.rs: MAX_HOST_FRAME_BYTES ${frame} leaves less than 1 MiB around a ${line}-byte skill socket line`);
	}
}

// 12. A unit-test time budget measures the test thread's CPU time with
//     leastCpuMs (apps/frontend/tests/unit/cpuTime.ts), never the wall
//     clock, which under load measures the machine: wall-clock budgets
//     failed 17 times in 7 loaded runs
//     (docs/concurrency-and-test-hazards.md).
for (const file of files(path.join(root, "apps/frontend/tests/unit"), new Set([".ts", ".tsx"]))) {
	if (path.basename(file) === "cpuTime.ts") continue;
	scan(file, /\b(?:performance\.now|Date\.now|process\.hrtime)\b/, "the wall clock in a unit test (time a budget with leastCpuMs, cpuTime.ts)");
}

// 13. A backend test waits on a channel, a Notify, a watch, a stream, a
//     oneshot or a task's JoinHandle through within()
//     (apps/backend/src/main.rs), which fails the test by name after a
//     generous deadline. libtest has no per-test timeout, so a bare await
//     whose wake-up is lost hangs cargo test forever with no output (#338).
//     A handle aborted on the line before is not waited on. A fake that is
//     meant to wait as long as its test says so on the line before:
//     `// unbounded: <why>`.
{
	// `.recv()`, `.next()`, `.notified()`, `.changed()`, or a bare name (a
	// oneshot receiver, a JoinHandle), awaited on the same line or, split by
	// rustfmt, on the next.
	const wait = /(?:\.(?:recv|next|notified|changed)\(\)|(?<![.\w])([a-z_]\w*))/;
	const sameLine = new RegExp(`${wait.source}\\s*\\.await\\b`);
	const lineEnd = new RegExp(`${wait.source}$`);
	for (const file of files(path.join(root, "apps/backend/tests"), new Set([".rs"]))) {
		const text = lines(file);
		text.forEach((line, index) => {
			const before = text[index - 1] ?? "";
			const match = sameLine.exec(line) ?? (/^\s*\.await\b/.test(text[index + 1] ?? "") ? lineEnd.exec(line.trimEnd()) : null);
			if (!match) return;
			// Inside a timeout(..., async { loop { ... } }) the wait is bounded.
			const bounded = text.slice(Math.max(0, index - 3), index + 1).some((near) => /\b(?:within|timeout)\(/.test(near));
			const aborted = match[1] !== undefined && before.includes(`${match[1]}.abort()`);
			if (!bounded && !aborted && !/\/\/ unbounded: \S/.test(before)) findings.push(`${rel(file)}:${index + 1}: a test await with no deadline (wrap it in within(), or mark a fake \`// unbounded: <why>\`)`);
		});
	}
}

if (findings.length > 0) {
	console.error(`check_hygiene: ${findings.length} finding(s):`);
	for (const finding of findings) console.error(`  ${finding}`);
	process.exit(1);
}
console.log("check_hygiene: private modules, no allowances, one Config, documented environment, one fake writer, one skill socket path, live doc paths, live doc routes, documented doc settings, one frame depth, one set of size caps, CPU-time budgets, bounded test awaits");

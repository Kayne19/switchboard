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
//    argue with the lint in the commit. The tests count: each file in
//    apps/backend/tests is compiled as a module of the crate, and clippy
//    lints it. `expect` silences a lint as `allow` does, `cfg_attr` can
//    hide either, and a `[lints]` table or a `-A` rustflag allows a lint
//    for the whole crate.
for (const start of ["apps/backend/src", "apps/backend/tests", "build.rs"]) {
	for (const file of files(path.join(root, start), new Set([".rs"]))) {
		scan(file, /#!?\[\s*(?:allow|expect)\s*\(|\bcfg_attr\s*\(.*\b(?:allow|expect)\s*\(/, "lint allowance (AGENTS.md: none in the backend)");
	}
}
scan(path.join(root, "Cargo.toml"), /^\s*\[(?:workspace\.)?lints\b/, "a [lints] table (AGENTS.md: no lint allowances in the backend)");
for (const name of ["config", "config.toml"]) {
	const file = path.join(root, ".cargo", name);
	if (existsSync(file)) scan(file, /["'\s](?:-A|--cap-lints)/, "a lint allowed in rustflags (AGENTS.md: no lint allowances in the backend)");
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
//     (docs/concurrency-and-test-hazards.md). The host agent's tests too.
for (const start of ["apps/frontend/tests/unit", "apps/host-agent/tests"]) {
	for (const file of files(path.join(root, start), new Set([".ts", ".tsx"]))) {
		if (path.basename(file) === "cpuTime.ts") continue;
		scan(file, /\b(?:performance\.now|Date\.now|process\.hrtime)\b/, "the wall clock in a unit test (time a budget with leastCpuMs, cpuTime.ts)");
	}
}

// 13. No focused test: a `.only` left in a test makes its runner skip the
//     rest. Playwright fails a CI run that finds one (forbidOnly), but the
//     browser job is not the check master requires, and `node --test` runs
//     every test anyway, so a focused host-agent test hides nothing until it
//     is run by hand. This refuses it in `npm test`, which master requires.
for (const dir of ["apps/frontend/tests", "apps/host-agent/tests"]) {
	for (const file of files(path.join(root, dir), new Set([".ts", ".tsx", ".mjs", ".js"]))) {
		scan(file, /\b(?:test|it|describe)(?:\.\w+)*\.only\(/, "a focused test (.only): it makes its runner skip the rest");
	}
}

// 14. One implementation for both engines (docs/ipad.md): no user-agent
//     check and no CSS that asks which engine it is in. A user-agent branch
//     that cannot be avoided is listed in docs/ipad.md, "Engine-specific
//     code in the tree"; one in a file that table does not name is refused.
{
	const ipad = readFileSync(path.join(root, "docs/ipad.md"), "utf8");
	for (const file of files(path.join(root, "apps/frontend/src"), new Set([".ts", ".tsx", ".js", ".mjs"]))) {
		if (ipad.includes(`\`${rel(file)}\``)) continue;
		scan(file, /\bnavigator\s*\.\s*(?:userAgent|userAgentData|vendor|platform)\b/, "a user-agent check (docs/ipad.md: detect the feature, or list the branch there)");
	}
	for (const file of files(path.join(root, "apps/frontend/src"), new Set([".css", ".ts", ".tsx"]))) {
		scan(file, /@(?:supports|media)\b[^{]*-(?:webkit|apple)-/, "CSS that asks for the engine (docs/ipad.md: no WebKit-only CSS)");
	}
}

// 15. A backend test waits on a channel, a Notify, a watch, a stream, a
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

// 16. The page lays out from the stage's own box (docs/ipad.md). With
//     `viewport-fit=cover` Safari lays the page under the notch and the
//     home indicator, and only `env(safe-area-inset-*)` keeps it out; the
//     page had the one with none of the other (#275).
{
	const shell = readFileSync(path.join(root, "apps/frontend/index.html"), "utf8");
	const styles = readFileSync(path.join(root, "apps/frontend/src/styles/index.css"), "utf8");
	if (/viewport-fit\s*=\s*cover/.test(shell) && !styles.includes("env(safe-area-inset-")) findings.push("apps/frontend/index.html: viewport-fit=cover with no env(safe-area-inset-*) in index.css: the page draws under the notch");
}

// 17. The runtime's ID namespace is one prefix, RUNTIME_ID_PREFIX
//     (apps/frontend/src/controller/types.ts). The reducer routes an ID with
//     it to runtime state and the validator refuses it from an agent; a
//     second copy of the literal lets the two drift, and an agent ID then
//     writes into the runtime's objects.
{
	const copies = [];
	for (const file of files(path.join(root, "apps/frontend/src"), new Set([".ts", ".tsx"]))) {
		lines(file).forEach((line, index) => {
			if (/['"`]__runtime\//.test(line)) copies.push(`${rel(file)}:${index + 1}`);
		});
	}
	if (copies.length !== 1) findings.push(`the '__runtime/' prefix is written ${copies.length} times (${copies.join(", ")}); import RUNTIME_ID_PREFIX from controller/types.ts`);
}

// 18. The layout reads only the stage's own geometry (docs/ipad.md): a
//     size in the stylesheet is in container units, not the viewport's.
//     Safari's `vh` is its large viewport, taller than what shows with
//     its toolbars out, and a focus box sized in it ran under them (#271);
//     `lvh` names that viewport outright and `svh` is no stage either.
//     The stage sizes itself (`100vw`, and `100vh` before `100dvh`).
{
	const stylesheet = path.join(root, "apps/frontend/src/styles/index.css");
	let inStage = false;
	lines(stylesheet).forEach((line, index) => {
		if (/^\.stage \{$/.test(line)) inStage = true;
		else if (inStage && /^\}$/.test(line)) inStage = false;
		else if (!inStage && /\d[ls]?v(?:h|w|i|b|min|max)\b/.test(line)) findings.push(`${rel(stylesheet)}:${index + 1}: a viewport unit (size it in cqw/cqh from the stage)`);
	});
}

// The two lifecycle checks below are written as functions of a file's text,
// so each runs on a sample it must refuse and one it must pass (see
// selfTest) before it runs on the tree (#357 gives every check one).
// A declaration's members: the lines one brace inside `class Name`,
// `struct Name` or `interface Name`, comments and string contents removed.
// Undefined when the declaration is not there or does not close.
function members(text, name) {
	const start = text.findIndex((line) => new RegExp(`^\\s*(?:export\\s+)?(?:pub(?:\\([^)]*\\))?\\s+)?(?:class|struct|interface)\\s+${name}\\b`).test(line));
	if (start < 0) return undefined;
	const result = [];
	let depth = 0;
	let parens = 0;
	let opened = false;
	// A field whose type is an object literal spans lines
	// (`private barrier: {` .. `} | null = null;`): its lines are one member.
	let spanning = undefined;
	for (let index = start; index < text.length; index++) {
		const code = text[index]
			.replace(/^\s*(?:\/\/|\/?\*).*$/, "")
			.replace(/\/\/.*$/, "")
			.replace(/"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
		if (spanning) spanning.code += ` ${code.trim()}`;
		// A parameter of a method or constructor is not a member; a
		// constructor's parameter property (`private x: T`) is.
		else if (opened && depth === 1 && (parens === 0 || /^\s*(?:private|protected|public)\b/.test(code))) {
			result.push({ line: index + 1, code });
			if (/^[^(]*?[\w#]\??!?\s*:[^(]*\{\s*$/.test(code)) spanning = result[result.length - 1];
		}
		for (const char of code) {
			if (char === "{") {
				depth++;
				opened = true;
			} else if (char === "}") depth--;
			else if (char === "(") parens++;
			else if (char === ")") parens--;
		}
		if (spanning && depth <= 1) spanning = undefined;
		if (opened && depth === 0) return result;
	}
	return undefined;
}

// A member that says which phase some work is in: a mutable field (not
// `readonly`; every field of a Rust struct) that is a flag, a nullable or
// optional slot, an atomic, a timer or task handle, or a token, generation,
// epoch or attempt counter.
const phaseField = (code) => {
	const field = code.match(/^\s*(?:(?:private|protected|public|static|declare|override|pub(?:\([^)]*\))?)\s+)*(#?[A-Za-z_]\w*)(\??)!?\s*([:=].*)$/);
	if (!field || /^\s*(?:(?:private|protected|public|static|declare|override)\s+)*readonly\b/.test(code)) return false;
	const [, name, optional, rest] = field;
	return (
		optional === "?" ||
		/(?:token|generation|epoch|attempt)/i.test(name) ||
		/\bbool(?:ean)?\b|\|\s*(?:null|undefined)\b|\b(?:null|undefined)\s*\||^=\s*(?:true|false|null|undefined)\b|\bOption<|\bAtomic\w+|\b\w*Timer\b|\bTimeout\b|setTimeout|setInterval|\bJoinHandle\b|\bAbortHandle\b|\bAbortController\b/.test(rest)
	);
};

// 19. A lifecycle that has become a machine has one writer
//     (AGENTS.md; doctrine 2a): its state is assigned on one line of its
//     file, inside the transition function, and each teardown primitive
//     named in `once` occurs on one line, the phase exit. A row whose
//     pattern matches nothing fails too, so a rename cannot retire it.
//     Each machine's pull request adds its row.
const machines = [
	// debug-feed (#416): `transition` writes the phase; `leave` closes the socket and clears the timer.
	{ file: "apps/frontend/src/debug/connection.ts", writer: /\bthis\.#?phase\s*=(?!=)/, max: 1, once: [/\.close\(\)/, /clearTimeout\(/] },
	// mic-ptt (#434): `transition` writes the phase; `stopTracks` is the one place tracks stop.
	{ file: "apps/frontend/src/runtime/pushToTalk.ts", writer: /\bthis\.#?phase\s*=(?!=)/, max: 1, once: [/\.getTracks\(\)/] },
	// playback (#435): `enter` is the one writer of who holds the element.
	{ file: "apps/frontend/src/runtime/audioPlayback.ts", writer: /\bthis\.holder\s*=(?!=)/, max: 1, once: [] },
	// pi-process (#419): `transition` writes the process state. `release` runs on entry
	// to Closed and from a close that finds it Closed, so it is not a `once`.
	{ file: "apps/backend/src/pi_client.rs", writer: /\*state\s*=\s*to\b/, max: 1, once: [] },
	// session-end (#423): `end` is the one writer of a project session's end of life.
	{ file: "apps/backend/src/project_session.rs", writer: /\*lifecycle\s*=(?!=)/, max: 1, once: [] },
	// floor-front (#421): `serve` takes the phase `step` gives; `leave` is the one teardown.
	{ file: "apps/backend/src/floor.rs", writer: /\bphase\s*=\s*next\b/, max: 1, once: [/\bself\.leave\(/] },
	// host-session (#404): the turn record is written only in `#turnStep`, on its three arms.
	{ file: "apps/host-agent/src/sessions.ts", writer: /\bt\.turn\s*=(?!=)/, max: 3, once: [] },
	// daemon-resync (#418): `#step` is the one writer of the keeper's phase.
	{ file: "apps/host-agent/src/daemon_keeper.ts", writer: /\bthis\.#phase\s*=(?!=)/, max: 1, once: [] },
	// call-line (#437): `CallLifecycle::step` writes the line; `step_locked` sends every candidate notice.
	{ file: "apps/backend/src/lifecycle.rs", writer: /\bself\.line\s*=(?!=)/, max: 1, once: [/\bself\.notify_candidate\(/] },
	// session-turn (#439): `step` is the one writer of a project session's turn phase.
	{ file: "apps/backend/src/session_turn.rs", writer: /\bself\.phase\s*=(?!=)/, max: 1, once: [] },
	// leg-startup: a bring-up is a `Startup`, not a machine. It moves the call line only
	// through the coordinator: `begin_startup` stages, `commit` adopts and ends the
	// intro, and the rollback is written in `abandon` and in `Drop`, nowhere else.
	{ file: "apps/backend/src/leg_transitions.rs", writer: /\.rollback_startup\(/, max: 2, once: [/\.begin_candidate\(/, /\.adopt_candidate\(/, /\.finish_intro\(/] },
	// mic-hf (#366), mic-glue: `transition` writes the state (phase, detectors, follow-up);
	// `releaseGraph` is the one place tracks stop, and `publish` the one call of `onState`.
	{ file: "apps/frontend/src/hands_free.ts", writer: /\bthis\.#?state\s*=(?!=)/, max: 1, once: [/\.getTracks\(\)/, /\.onState\(/] },
	// screen-reports: `transition` writes the report line; `leave` clears the ack deadline.
	{ file: "apps/frontend/src/app/screenReporter.ts", writer: /\bthis\.state\s*=(?!=)/, max: 1, once: [/clearTimeout\(/] },
	// host-turns: `hold_self_woken` holds the admitted self-woken run; `release_self_woken` is its one end.
	{ file: "apps/backend/src/host_turns.rs", writer: /\bself_woken\.lock\(\)\.await\s*=(?!=)/, max: 1, once: [/\.take_if\(/] },
	// session-guard (#359): the active-session guard is derived, not a machine. `name_leg_on_line`
	// is its one writer and the one place the PBX locks it; a rescue's `take` is the only other change.
	{ file: "apps/backend/src/pbx.rs", writer: /\*guard\s*=(?!=)/, max: 1, once: [/\.active_session\.lock\(\)/] },
	// page-control (#369): a page control is a fixed sequence, not a machine. Its quiet begins in
	// `Admitted::rescue` or `rescue_for` and ends in `PageControl::settle`, with the rescue's token or,
	// for a failed operation, its generation. After the rescue no step reads the current generation:
	// `control_generation` reads it, and the superseded delivery logs it, nowhere else.
	{ file: "apps/backend/src/page_controls.rs", writer: /\bcoordinator\.generation\(\)/, max: 2, once: [/\.begin_rescue_at\(/, /\.begin_rescue_of\(/, /\bcoordinator\.settle\(/, /\.settle_at\(/] },
	// modal-focus (#396): `transition` writes a dialog's focus phase; `leave` cancels the give-back's frame.
	{ file: "apps/frontend/src/hooks/useModalFocus.ts", writer: /\bthis\.#?phase\s*=(?!=)/, max: 1, once: [/cancelAnimationFrame\(/] },
	// browser-link: `transition` writes the call socket's link; `leave` clears its timer, and
	// `close` is the one place a socket is closed (on leaving its phase, or after a failed send).
	{ file: "apps/frontend/src/runtime/callLink.ts", writer: /\bthis\.#?phase\s*=(?!=)/, max: 1, once: [/\.close\(\)/, /clearTimeout\(/] },
	// call-identity: the page's call identity is a value, not a machine. `followIdentity` is the one
	// writer, and `follow` (callIdentity.ts) the one place it moves.
	{ file: "apps/frontend/src/runtime/callRuntime.ts", writer: /\bthis\.identity\s*=(?!=)/, max: 1, once: [/\bfollow\(this\.identity,/] },
	// operator-utility (#386): a local process slot, not a machine. `LocalProcess::ensure` is the
	// one place the operator or the utility is started; `close` is the one place a slot is emptied.
	{ file: "apps/backend/src/operator.rs", writer: /\bself\.session\s*=(?!=)/, max: 1, once: [/\.session\.take\(\)/] },
	// residents (#239, #388): one `Resident` per project, not a machine. `admit` is the one way in
	// (the token and the entry), `take_out` the one removal (the entry and the token), which
	// `retire` and a refused admission call; `retire` is the one exit, its `Leaving` the reason.
	{ file: "apps/backend/src/residents.rs", writer: /\bresidents\.remove\(/, max: 1, once: [/\bresidents\.insert\(/, /\.register_background\(/, /\.remove_background\(/] },
	// residents: `AgentProjection::apply` is the one writer of an agent's phase, which `AgentPhase::on` moves.
	{ file: "apps/backend/src/app_state.rs", writer: /\bphases\.insert\(/, max: 1, once: [/\bAgentPhase::on\(/] },
];
function machineFindings(file, text, machine) {
	const out = [];
	const where = (pattern) => text.flatMap((line, index) => (pattern.test(line) ? [index + 1] : []));
	const writers = where(machine.writer);
	if (writers.length !== machine.max) out.push(`${file}: state written on ${writers.length} line(s) (${writers.join(", ")}), want ${machine.max}: one transition function (doctrine 2a)`);
	for (const pattern of machine.once) {
		const hits = where(pattern);
		if (hits.length !== 1) out.push(`${file}: ${pattern} on ${hits.length} line(s) (${hits.join(", ")}), want 1: teardown hangs on the phase exit (doctrine 2a)`);
	}
	return out;
}

// 20. The lifecycle owners that are not machines yet do not grow
//     phase fields (AGENTS.md; doctrine 2a). `fields` is the count on
//     master when the check landed, and the check wants it exactly: one
//     more is the flag rule 2a says to extract the machine before adding,
//     and one fewer lowers the number here, so it cannot creep back. When
//     an owner becomes a machine, it takes a row in check 19 and keeps its
//     row here at what is left beside the machine, 0 included: a flag
//     added next to a machine is the same mistake.
const owners = [
	{ file: "apps/frontend/src/hands_free.ts", owner: "HandsFreeController", fields: 0 },
	{ file: "apps/frontend/src/hands_free_machine.ts", owner: "Capture", fields: 1 },
	{ file: "apps/frontend/src/runtime/pushToTalk.ts", owner: "PushToTalk", fields: 0 },
	{ file: "apps/frontend/src/runtime/callRuntime.ts", owner: "CallRuntime", fields: 5 },
	{ file: "apps/frontend/src/runtime/callLink.ts", owner: "CallLink", fields: 0 },
	{ file: "apps/frontend/src/runtime/audioPlayback.ts", owner: "AudioPlayback", fields: 2 },
	{ file: "apps/frontend/src/debug/connection.ts", owner: "SocketFeed", fields: 0 },
	{ file: "apps/frontend/src/app/screenReporter.ts", owner: "ScreenReporter", fields: 0 },
	{ file: "apps/frontend/src/hooks/useModalFocus.ts", owner: "ModalFocus", fields: 0 },
	{ file: "apps/backend/src/lifecycle.rs", owner: "CallLifecycle", fields: 1 },
	{ file: "apps/backend/src/pi_client.rs", owner: "SessionInner", fields: 6 },
	{ file: "apps/backend/src/project_session.rs", owner: "ProjectInner", fields: 7 },
	{ file: "apps/backend/src/floor.rs", owner: "FloorState", fields: 1 },
	{ file: "apps/backend/src/leg_transitions.rs", owner: "Startup", fields: 1 },
	{ file: "apps/backend/src/turns.rs", owner: "TurnState", fields: 3 },
	{ file: "apps/backend/src/host_turns.rs", owner: "HostTurns", fields: 1 },
	{ file: "apps/host-agent/src/sessions.ts", owner: "Tracked", fields: 5 },
	{ file: "apps/backend/src/residents.rs", owner: "Resident", fields: 1 },
	{ file: "apps/backend/src/residents.rs", owner: "BackgroundRegistry", fields: 1 },
];
function ownerFindings(file, text, row) {
	const body = members(text, row.owner);
	if (!body) return [`${file}: could not read ${row.owner} (the check needs updating)`];
	const lines = body.filter((member) => phaseField(member.code)).map((member) => member.line);
	if (lines.length > row.fields) return [`${file}: ${row.owner} has ${lines.length} phase fields (lines ${lines.join(", ")}), the table allows ${row.fields}: extract the machine first (doctrine 2a)`];
	if (lines.length < row.fields) return [`${file}: ${row.owner} has ${lines.length} phase fields, fewer than the table's ${row.fields}: lower the number in check 20`];
	return [];
}

// Each check runs on a sample it must refuse and one it must pass. A check
// that finds nothing in its own violation, or something in the clean
// sample, fails the gate: an edit to its pattern has made it pass all.
function selfTest(check, run, violation, clean) {
	if (run(violation.split("\n")).length === 0) findings.push(`self-test: check ${check} finds nothing in its violation sample`);
	const wrong = run(clean.split("\n"));
	if (wrong.length > 0) findings.push(`self-test: check ${check} refuses its clean sample: ${wrong[0]}`);
}
{
	const machine = { writer: /\bthis\.#?phase\s*=(?!=)/, max: 1, once: [/\.getTracks\(\)/] };
	const run = (text) => machineFindings("sample.ts", text, machine);
	const transition = "class M {\n\tprivate phase: Phase = idle;\n\tdispatch(event) {\n\t\tconst next = step(this.phase, event);\n\t\tif (this.phase === next) return;\n\t\tthis.phase = next;\n\t}\n";
	selfTest(19, run, `${transition}\tstop() { this.phase = idle; stream.getTracks(); }\n}`, `${transition}\texit() { stream.getTracks(); }\n}`);
	selfTest(19, run, `${transition}\texit() { stream.getTracks(); }\n\tstop() { stream.getTracks(); }\n}`, `${transition}\texit() { stream.getTracks(); }\n}`);
	selfTest(19, run, "class M {\n\tprivate state = idle;\n}", `${transition}\texit() { stream.getTracks(); }\n}`);
}
{
	const run = (text) => [...ownerFindings("sample.ts", text, { owner: "Owner", fields: 2 }), ...ownerFindings("sample.rs", text, { owner: "Inner", fields: 2 })];
	const clean = [
		"export class Owner {",
		"\tprivate readonly options: Options;",
		"\tprivate readonly done: boolean;",
		"\tprivate stream: MediaStream | null = null; // a slot",
		"\tprivate count = 0;",
		"\tprivate runtimeToken = 0;",
		"\tconstructor(",
		"\t\tprivate readonly url: string,",
		"\t\tschedule?: Schedule,",
		"\t\tfinished: boolean,",
		"\t) {}",
		"\tstart(): void {",
		"\t\tconst starting: boolean = true;",
		"\t\tthis.handlers = { stopped: false, label: \"}\" };",
		"\t}",
		"}",
		"pub(crate) struct Inner {",
		"    label: String,",
		"    /// busy: bool, in a comment",
		"    busy: AtomicBool,",
		"    pub(crate) child: Mutex<Option<Child>>,",
		"}",
	].join("\n");
	selfTest(20, run, clean.replace("\tprivate count = 0;", "\tprivate starting = false;"), clean);
	selfTest(20, run, clean.replace("    label: String,", "    task: Option<JoinHandle<()>>,"), clean);
	selfTest(20, run, clean.replace("\tprivate count = 0;", "\tprivate barrier: {\n\t\tid: string;\n\t} | null = null;"), clean);
	selfTest(20, run, clean.replace("\tprivate count = 0;", "\tprivate pending: string | undefined;"), clean);
	selfTest(20, run, clean.replace("\tprivate count = 0;", "\tprivate attempt = 0;"), clean);
	selfTest(20, run, clean.replace("\tprivate runtimeToken = 0;", ""), clean);
	selfTest(20, run, clean.replace("export class Owner {", "export class Renamed {"), clean);
}
for (const machine of machines) findings.push(...machineFindings(machine.file, lines(path.join(root, machine.file)), machine));
for (const row of owners) findings.push(...ownerFindings(row.file, lines(path.join(root, row.file)), row));

// 21. The composition is built once a render, by SceneRenderer, and handed
//     to the scenes (#380). A scene that builds its own is free to pick its
//     own primary, and one did: the chart scene drew a primary and a chart
//     order the screen state did not name (#266). The screen-state report
//     (deriveScreenState, beside the builder in sceneModel.ts) builds its own.
{
	const builders = new Set(["apps/frontend/src/components/SceneRenderer.tsx", "apps/frontend/src/app/sceneModel.ts"]);
	for (const file of files(path.join(root, "apps/frontend/src"), new Set([".ts", ".tsx"]))) {
		if (builders.has(rel(file))) continue;
		scan(file, /\bbuildCompositionModel\b/, "the composition built outside SceneRenderer (take it from SceneProps.composition)");
	}
}

// 22. A value read from the layout goes through useMeasured (#392): read in
//     a layout effect, each report committed before the frame it reports
//     is painted, and its observers released in one place. Each reader
//     that observed the layout by itself chose its own commit policy, and
//     the one left to React's schedule drew timers a frame, on a loaded
//     WebKit 520 ms, late (#333). An observer elsewhere is named here with
//     why it is not such a value, and a name that observes nothing fails,
//     so the list cannot outlive its reason.
{
	const measured = "apps/frontend/src/hooks/useMeasured.ts";
	const observers = new Map([
		[measured, "the hook"],
		["apps/frontend/src/hooks/usePinnedScroll.ts", "a scroll pinned to its newest line, not a value drawn"],
		["apps/frontend/src/components/ChartNotes.tsx", "the notes' placement pass: its reads set the cards' widths to measure them, and it rests after a resize"],
		["apps/frontend/src/debug/SwitchboardView.tsx", "the debug page's geometry, measured once a frame"],
	]);
	const observer = /\bnew (?:Resize|Mutation)Observer\b/;
	for (const file of files(path.join(root, "apps/frontend/src"), new Set([".ts", ".tsx"]))) {
		const name = rel(file);
		if (!observers.has(name)) scan(file, observer, "a layout observer outside useMeasured: read the value through it (AGENTS.md)");
		if (name !== measured) scan(file, /\bflushSync\b/, "flushSync outside useMeasured: a measured value is committed by the hook (AGENTS.md)");
	}
	for (const name of observers.keys()) {
		const file = path.join(root, name);
		if (!existsSync(file) || !lines(file).some((line) => observer.test(line))) findings.push(`${name}: named in check 22 but observes nothing: take it off the list`);
	}
}

if (findings.length > 0) {
	console.error(`check_hygiene: ${findings.length} finding(s):`);
	for (const finding of findings) console.error(`  ${finding}`);
	process.exit(1);
}
console.log("check_hygiene: private modules, no allowances, one Config, documented environment, one fake writer, one skill socket path, live doc paths, live doc routes, documented doc settings, one frame depth, one set of size caps, CPU-time budgets, no focused tests, no engine checks, bounded test awaits, no page under the notch, one runtime ID prefix, stage-relative sizes, one writer per machine, no new lifecycle flags, one composition a render, one hook for a measured value");

#!/usr/bin/env node
// Fails when one of the repo's structural invariants is broken. Each check
// below is a rule in AGENTS.md ("Working here") that a grep can enforce; the
// reasons are there. Prints file:line per finding. Run by `npm test`, so CI
// enforces it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipped = new Set(["node_modules", "dist", "target", ".git", "static", "static-debug"]);
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

// 7. Every repo path a doc names exists. A bare `src/` or `tests/` is
//    relative to the prose, not the root, and is skipped.
for (const start of ["AGENTS.md", "README.md", "docs"]) {
	for (const file of files(path.join(root, start), new Set([".md"]))) {
		lines(file).forEach((line, index) => {
			for (const m of line.matchAll(/(?<![\w/.-])((?:apps|docs|skills|extensions|scripts|static|static-debug)\/[\w./-]*)/g)) {
				const target = m[1].replace(/[.,;:)]+$/, "").replace(/\/$/, "");
				if (target.includes("*") || target.includes("<") || !target.includes("/")) continue;
				if (!existsSync(path.join(root, target))) findings.push(`${rel(file)}:${index + 1}: names ${target}, which does not exist`);
			}
		});
	}
}

if (findings.length > 0) {
	console.error(`check_hygiene: ${findings.length} finding(s):`);
	for (const finding of findings) console.error(`  ${finding}`);
	process.exit(1);
}
console.log("check_hygiene: private modules, no allowances, one Config, documented environment, one fake writer, one skill socket path, live doc paths");

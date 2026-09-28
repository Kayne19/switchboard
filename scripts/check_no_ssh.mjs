#!/usr/bin/env node
// Fails when the removed SSH transport comes back: scans apps/, docs/ and
// README.md for the strings that only the SSH transport used, and prints
// file:line for each hit. Run by `npm test`, so CI enforces it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["apps", "docs", "README.md"];
const forbidden = [
	"ControlMaster",
	"SWITCHBOARD_SSH_PROGRAM",
	"SWITCHBOARD_REMOTE_CACHE_DIR",
	"remote_shutdown_unverified",
];
// Dependencies and build output are not ours to police.
const skipped = new Set(["node_modules", "dist", "target", ".git"]);

function* files(entry) {
	const stat = statSync(entry);
	if (stat.isFile()) {
		yield entry;
		return;
	}
	for (const name of readdirSync(entry)) {
		if (!skipped.has(name)) yield* files(path.join(entry, name));
	}
}

const hits = [];
for (const start of roots) {
	for (const file of files(path.join(root, start))) {
		const text = readFileSync(file);
		if (text.includes(0)) continue; // binary
		text
			.toString("utf8")
			.split("\n")
			.forEach((line, index) => {
				for (const needle of forbidden) {
					if (line.includes(needle)) {
						hits.push(`${path.relative(root, file)}:${index + 1}: ${needle}`);
					}
				}
			});
	}
}

if (hits.length > 0) {
	console.error("check_no_ssh: the SSH transport is gone; these lines bring it back:");
	for (const hit of hits) console.error(`  ${hit}`);
	process.exit(1);
}
console.log(`check_no_ssh: no SSH transport strings in ${roots.join(", ")}`);

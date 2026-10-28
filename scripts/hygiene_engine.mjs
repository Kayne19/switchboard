// The engine checks of check_hygiene.mjs (docs/ipad.md): no user-agent or
// engine-asking CSS, and the `-webkit-` names listed against their files.
import { scan } from "./hygiene_tree.mjs";

function engineRuleFindings(ipad, sources) {
	const webkitName = /-webkit-[a-z]+(?:-[a-z]+)*/g;
	const namesIn = (text) =>
		new Set(
			text
				.replace(/\bWebkit([A-Z]\w*)/g, (_, rest) => `-webkit-${rest.replace(/(?<=.)[A-Z]/g, (letter) => `-${letter}`).toLowerCase()}`)
				.match(webkitName) ?? [],
		);
	const stale = "docs/ipad.md: no rows in the Engine-specific code table (the check needs updating)";
	const out = [];
	const table = ipad.split("## Engine-specific code in the tree")[1]?.split(/\n## /)[0] ?? "";
	const lines = table.split("\n");
	const rule = lines.findIndex((line) => /^\|[\s:|-]+\|$/.test(line));
	const rows = rule < 0 ? [] : lines.slice(rule + 1).filter((line) => line.startsWith("|"));
	if (rows.length === 0) return [stale];
	const listed = new Map();
	for (const row of rows) {
		const [where = "", what = ""] = row.split("|").slice(1);
		const file = where.match(/^\s*`([^`]+)`/)?.[1];
		if (!file) {
			out.push(`docs/ipad.md: a row of the Engine-specific code table starts with no file: ${row.slice(0, 60)}`);
			continue;
		}
		const names = namesIn(`${where} ${what}`);
		listed.set(file, new Set([...(listed.get(file) ?? []), ...names]));
		if (names.size > 0 && !(file in sources)) out.push(`docs/ipad.md: lists ${[...names].join(", ")} in ${file}, which is not a stylesheet or script in apps/frontend/src`);
	}
	for (const [file, text] of Object.entries(sources)) {
		const claimed = listed.get(file) ?? new Set();
		const used = namesIn(text);
		for (const name of used) if (!claimed.has(name)) out.push(`${file}: uses ${name}, which docs/ipad.md "Engine-specific code in the tree" does not list for it`);
		for (const name of claimed) if (!used.has(name)) out.push(`docs/ipad.md: lists ${name} in ${file}, which does not use it`);
	}
	return out;
}

// What the engine-rules check reads, as sample trees: docs/ipad.md's table
// with `rows`, and the sources it is held to.
const ipadTable = (...rows) => `## Engine-specific code in the tree\n\n| Where | What | Why |\n|---|---|---|\n${rows.join("\n")}\n\n## Next\n`;
const ipadTree = (ipad, sources) => ({ "docs/ipad.md": ipad, ...sources });
const ipadCss = "apps/frontend/src/a.css";
const ipadClamp = "| `apps/frontend/src/a.css`, `.x` | `display: -webkit-box` with `-webkit-line-clamp` | why |";
const ipadBar = "| `apps/frontend/src/a.css`, `::-webkit-scrollbar` beside `scrollbar-width: none` | hiding | unlike -webkit-gone, it stays |";
const ipadUserAgent = "| `apps/frontend/src/b.ts` | a user-agent branch | a WebKit bug |";
const ipadCssClean = ".x { display: -webkit-box; -webkit-line-clamp: 2; }\n.y::-webkit-scrollbar { display: none; }";

export const engineChecks = [
	{
		// One implementation for both engines (docs/ipad.md): no user-agent
		// check and no CSS that asks which engine it is in. A user-agent branch
		// that cannot be avoided is listed in docs/ipad.md, "Engine-specific
		// code in the tree"; one in a file that table does not name is refused.
		name: "no engine checks",
		run(ctx) {
			const ipad = ctx.read("docs/ipad.md");
			for (const file of ctx.files("apps/frontend/src", new Set([".ts", ".tsx", ".js", ".mjs"]))) {
				if (ipad.includes(`\`${file}\``)) continue;
				scan(ctx, file, /\bnavigator\s*\.\s*(?:userAgent|userAgentData|vendor|platform)\b/, "a user-agent check (docs/ipad.md: detect the feature, or list the branch there)");
			}
			for (const file of ctx.files("apps/frontend/src", new Set([".css", ".ts", ".tsx"]))) {
				scan(ctx, file, /@(?:supports|media)\b[^{]*-(?:webkit|apple)-/, "CSS that asks for the engine (docs/ipad.md: no WebKit-only CSS)");
			}
		},
		violations: [
			{ "docs/ipad.md": "", "apps/frontend/src/a.ts": "if (navigator.userAgent.includes('x')) {}\n" },
			{ "docs/ipad.md": "", "apps/frontend/src/a.css": "@supports (-webkit-touch-callout: none) {\n}\n" },
		],
		clean: [{ "docs/ipad.md": "| `apps/frontend/src/a.ts` | UA | bug |", "apps/frontend/src/a.ts": "navigator.userAgent;\n", "apps/frontend/src/b.css": ".a { color: red; }\n" }],
	},
	{
		// Every `-webkit-` name in apps/frontend/src is listed in the "Engine-specific
		// code in the tree" table of docs/ipad.md, against the file that uses it,
		// and every `-webkit-` name a row's Where or What cell lists is used by the
		// file the row names. A rule added without its row, or a row kept after its
		// rule went, leaves the table naming the wrong set. A camelCase style key
		// (`WebkitLineClamp`) counts as its kebab-case name.
		name: "engine rules listed",
		run(ctx) {
			const sources = {};
			for (const file of ctx.files("apps/frontend/src", new Set([".css", ".ts", ".tsx"]))) sources[file] = ctx.read(file);
			for (const finding of engineRuleFindings(ctx.read("docs/ipad.md"), sources)) ctx.report(finding);
		},
		violations: [
			// A rule with no row (the greedy name).
			ipadTree(ipadTable(ipadClamp, ipadBar, ipadUserAgent), { [ipadCss]: `${ipadCssClean}\n.x { -webkit-box-orient: vertical; }` }),
			// A value with no row.
			ipadTree(ipadTable(ipadBar), { [ipadCss]: ".y::-webkit-scrollbar { display: none; }\n.x { display: -webkit-box; }" }),
			// A pseudo-element with no row.
			ipadTree(ipadTable(ipadClamp), { [ipadCss]: ".x { display: -webkit-box; -webkit-line-clamp: 2; }\n.y::-webkit-scrollbar { }" }),
			// An at-rule with no row.
			ipadTree(ipadTable(ipadClamp), { [ipadCss]: ".x { display: -webkit-box; -webkit-line-clamp: 2; }\n@supports (-webkit-appearance: none) { }" }),
			// A camelCase style key with no row.
			ipadTree(ipadTable(ipadBar), { [ipadCss]: ".y::-webkit-scrollbar { }", "apps/frontend/src/c.tsx": "const s = { WebkitLineClamp: 2 };" }),
			// A row for a rule that is gone.
			ipadTree(ipadTable(ipadClamp), { [ipadCss]: ".x { color: red; }" }),
			// A row for a file that is gone.
			ipadTree(ipadTable(ipadClamp), {}),
			// A rule listed under another file.
			ipadTree(ipadTable(ipadClamp), { [ipadCss]: ipadCssClean, "apps/frontend/src/b.css": ".y { -webkit-line-clamp: 2; }" }),
			// A row with no file.
			ipadTree(ipadTable("| not a path | `-webkit-x` | why |"), { [ipadCss]: ipadCssClean }),
			// A table that is missing.
			ipadTree("# no table\n", { [ipadCss]: ipadCssClean }),
		],
		clean: [ipadTree(ipadTable(ipadClamp, ipadBar, ipadUserAgent), { [ipadCss]: ipadCssClean })],
	},
];

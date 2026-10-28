#!/usr/bin/env node
// Fails when one of the repo's structural invariants is broken. Each check
// below is a rule in AGENTS.md ("Working here") that a grep can enforce; the
// reasons are there. Prints file:line per finding. Run by `npm test`, so CI
// enforces it.
//
// A check is a named entry in `checks`: `run(ctx, config)` reads the tree
// through `ctx` and reports findings with `ctx.report`. `config` is the
// check's own table (`config` for the real tree, `sampleConfig` for its
// samples). Each check carries `violations` it must report on and `clean`
// trees it must pass, small in-memory trees (a path to its text), so a later
// edit to a pattern that makes the check pass everything fails the gate
// (#357). The self-tests run before the scan of the real tree; `--self-test`
// runs them alone. The summary line is printed from the names, so a check
// cannot run unlisted.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipped = new Set(["node_modules", "dist", "target", ".git", "static", "static-debug", "test-results"]);

// The real tree, as a check reads it. Paths are relative to the root.
function realTree(report) {
	function* files(starts, exts) {
		function* walk(entry) {
			const stat = statSync(path.join(root, entry));
			if (stat.isFile()) {
				if (exts.has(path.extname(entry))) yield entry;
				return;
			}
			for (const name of readdirSync(path.join(root, entry))) {
				if (!skipped.has(name)) yield* walk(path.posix.join(entry, name));
			}
		}
		for (const start of [starts].flat()) yield* walk(start);
	}
	return {
		files,
		read: (file) => readFileSync(path.join(root, file), "utf8"),
		exists: (file) => existsSync(path.join(root, file)),
		report,
	};
}

// A sample tree: `{ "path/to/file": "text" }`, read the way the real one is.
function sampleTree(tree, report) {
	return {
		*files(starts, exts) {
			for (const file of Object.keys(tree)) {
				if ([starts].flat().some((start) => file === start || file.startsWith(`${start}/`)) && exts.has(path.extname(file))) yield file;
			}
		},
		read(file) {
			if (!(file in tree)) throw new Error(`the sample tree has no ${file}`);
			return tree[file];
		},
		exists: (file) => file in tree || Object.keys(tree).some((name) => name.startsWith(`${file}/`)),
		report,
	};
}

const lines = (ctx, file) => ctx.read(file).split("\n");
function scan(ctx, file, pattern, finding) {
	lines(ctx, file).forEach((line, index) => {
		if (pattern.test(line)) ctx.report(`${file}:${index + 1}: ${finding}`);
	});
}

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
	// host-session (#404): the turn record is written only in `#turnStep`, on its three arms;
	// its held failed call only in `#swapHeldFailedCall`, which `#turnStep` calls.
	{ file: "apps/host-agent/src/sessions.ts", writer: /\bt\.turn\s*=(?!=)/, max: 3, once: [/\.heldFailedCall\s*=(?!=)/] },
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
	// pinned-scroll (#415): `send` is the one writer of the scroll state; the effect's cleanup is the one disconnect.
	{ file: "apps/frontend/src/hooks/usePinnedScroll.ts", writer: /\bstate\.current\s*=(?!=)/, max: 1, once: [/\.disconnect\(\)/] },
	// browser-link: `transition` writes the call socket's link; `leave` clears its timer, and
	// `close` is the one place a socket is closed (on leaving its phase, or after a failed send).
	{ file: "apps/frontend/src/runtime/callLink.ts", writer: /\bthis\.#?phase\s*=(?!=)/, max: 1, once: [/\.close\(\)/, /clearTimeout\(/] },
	// call-identity: the page's call identity is a value, not a machine. `followIdentity` is the one
	// writer, and `follow` (callIdentity.ts) the one place it moves.
	{ file: "apps/frontend/src/runtime/callRuntime.ts", writer: /\bthis\.identity\s*=(?!=)/, max: 1, once: [/\bfollow\(this\.identity,/] },
	// status-source (#354): the status line's errors are keyed by their source, not a machine.
	// `say` is the one writer of the newest status and the one place an error is set.
	{ file: "apps/frontend/src/runtime/statusLine.ts", writer: /\bthis\.said\s*=(?!=)/, max: 1, once: [/\.errors\.set\(/] },
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
	if (lines.length < row.fields) return [`${file}: ${row.owner} has ${lines.length} phase fields, fewer than the table's ${row.fields}: lower the number in "no new lifecycle flags"`];
	return [];
}

// The markdown the doc checks read.
const markdown = (ctx) => ["AGENTS.md", "README.md", "docs", "apps", "skills", "extensions"].flatMap((start) => [...ctx.files(start, new Set([".md"]))]);

const rustFiles = new Set([".rs"]);
const tsFiles = new Set([".ts", ".tsx"]);

// What the size-caps check reads, as one sample tree: each cap as the
// source writes it. `change` replaces a value by the file and name it is
// written under.
function capsTree(change = {}) {
	const mib = 1024 * 1024;
	const v = {
		image: "3 * 1024 * 1024",
		imageAction: "4 * 1024 * 1024",
		action: "1024 * 1024",
		line: "5 * 1024 * 1024",
		frame: "6 * 1024 * 1024",
		typed: "100",
		...change,
	};
	return {
		"apps/frontend/src/controller/validation/image.ts": `export const MAX_IMAGE_BYTES = ${v.image};\n`,
		"apps/frontend/src/controller/validation.ts": `export const MAX_IMAGE_ACTION_BYTES = ${v.imageAction};\nconst MAX_ACTION_BYTES = ${v.action};\n`,
		"apps/backend/src/visual_protocol.rs": `pub const MAX_IMAGE_BYTES: usize = ${v.imageRs ?? v.image};\npub const MAX_IMAGE_ACTION_BYTES: usize = ${v.imageActionRs ?? v.imageAction};\npub const MAX_ACTION_BYTES: usize = ${v.actionRs ?? v.action};\n`,
		"skills/switchboard/src/switchboard/__init__.py": `_MAX_IMAGE_BYTES = ${v.image}\n_MAX_IMAGE_ACTION_BYTES = ${v.imageAction}\n_MAX_ACTION_BYTES = ${v.action}\n_MAX_LINE_BYTES = ${v.linePy ?? v.line}\n`,
		"apps/host-agent/src/skill_socket.ts": `export const MAX_LINE_BYTES = ${v.line};\n`,
		"apps/frontend/src/protocol.ts": `export const MAX_TYPED_TURN_CHARS = ${v.typed};\n`,
		"apps/backend/src/caller_input.rs": `pub(crate) const MAX_TYPED_TURN_CHARS: usize = ${v.typedRs ?? v.typed};\n`,
		"apps/backend/src/hosts.rs": `const MAX_HOST_FRAME_BYTES: usize = ${v.frame};\n`,
		"docs/display-action-v1.schema.json": JSON.stringify({ definitions: { ImageData: { properties: { bytes: { maxLength: v.base64 ?? 4 * Math.ceil((3 * mib) / 3) } } } } }),
	};
}

const ownerSample = [
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
	'\t\tthis.handlers = { stopped: false, label: "}" };',
	"\t}",
	"}",
	"pub(crate) struct Inner {",
	"    label: String,",
	"    /// busy: bool, in a comment",
	"    busy: AtomicBool,",
	"    pub(crate) child: Mutex<Option<Child>>,",
	"}",
].join("\n");

const ownerTree = (text) => ({ "sample.ts": text, "sample.rs": text });

const machineSample = { file: "sample.ts", writer: /\bthis\.#?phase\s*=(?!=)/, max: 1, once: [/\.getTracks\(\)/] };
const transition = "class M {\n\tprivate phase: Phase = idle;\n\tdispatch(event) {\n\t\tconst next = step(this.phase, event);\n\t\tif (this.phase === next) return;\n\t\tthis.phase = next;\n\t}\n";

function observerFiles() {
	return {
		"apps/frontend/src/hooks/useMeasured.ts": "new ResizeObserver(cb); flushSync(fn);\n",
		"apps/frontend/src/hooks/usePinnedScroll.ts": "new MutationObserver(cb);\n",
		"apps/frontend/src/components/ChartNotes.tsx": "new ResizeObserver(cb);\n",
		"apps/frontend/src/debug/SwitchboardView.tsx": "new ResizeObserver(cb);\n",
	};
}

const checks = [
	{
		// The backend's modules are private, so -D warnings finds dead code.
		name: "private modules",
		run(ctx) {
			scan(ctx, "apps/backend/src/main.rs", /^pub mod /, "pub mod: modules stay private (AGENTS.md)");
		},
		violations: [{ "apps/backend/src/main.rs": "pub mod pbx;\n" }],
		clean: [{ "apps/backend/src/main.rs": "mod pbx;\n" }],
	},
	{
		// No lint allowance in the backend: delete the item, cfg(test) it, or
		// argue with the lint in the commit. The tests count: each file in
		// apps/backend/tests is compiled as a module of the crate, and clippy
		// lints it. `expect` silences a lint as `allow` does, `cfg_attr` can
		// hide either, and a `[lints]` table or a `-A` rustflag allows a lint
		// for the whole crate.
		name: "no allowances",
		run(ctx) {
			for (const file of ctx.files(["apps/backend/src", "apps/backend/tests", "build.rs"], rustFiles)) {
				scan(ctx, file, /#!?\[\s*(?:allow|expect)\s*\(|\bcfg_attr\s*\(.*\b(?:allow|expect)\s*\(/, "lint allowance (AGENTS.md: none in the backend)");
			}
			scan(ctx, "Cargo.toml", /^\s*\[(?:workspace\.)?lints\b/, "a [lints] table (AGENTS.md: no lint allowances in the backend)");
			for (const name of ["config", "config.toml"]) {
				const file = `.cargo/${name}`;
				if (ctx.exists(file)) scan(ctx, file, /["'\s](?:-A|--cap-lints)/, "a lint allowed in rustflags (AGENTS.md: no lint allowances in the backend)");
			}
		},
		violations: [
			{ "Cargo.toml": "", "apps/backend/src/a.rs": "#[allow(dead_code)]\nfn a() {}\n" },
			{ "Cargo.toml": "", "apps/backend/tests/a.rs": "#![expect(unused)]\n" },
			{ "Cargo.toml": "", "build.rs": "#[cfg_attr(test, allow(unused))]\n" },
			{ "Cargo.toml": "[workspace.lints.rust]\n" },
			{ "Cargo.toml": "", ".cargo/config.toml": 'rustflags = ["-A", "dead_code"]\n' },
		],
		clean: [{ "Cargo.toml": "[package]\n", "apps/backend/src/a.rs": "#[cfg(test)]\nfn a() {}\n", ".cargo/config.toml": 'rustflags = ["-D", "warnings"]\n' }],
	},
	{
		// Only Config reads the environment (build.rs stamps the commit).
		name: "one Config",
		run(ctx) {
			for (const file of ctx.files("apps/backend/src", rustFiles)) {
				if (file.endsWith("main.rs")) continue;
				scan(ctx, file, /\b(?:std::)?env::(?:var|vars|var_os)\b/, "environment read outside Config (AGENTS.md)");
			}
		},
		violations: [{ "apps/backend/src/pbx.rs": 'let a = std::env::var("A");\n' }],
		clean: [{ "apps/backend/src/main.rs": 'let a = std::env::var("A");\n', "apps/backend/src/pbx.rs": "let a = 1;\n" }],
	},
	{
		// Every environment name Config reads is in docs/environment.md: the
		// env file is the contract with homelab, and the doc is its text.
		name: "documented environment",
		run(ctx) {
			const config = ctx.read("apps/backend/src/main.rs") + ctx.read("build.rs");
			const doc = ctx.read("docs/environment.md");
			for (const name of new Set(config.match(/"(?:SWITCHBOARD|ELEVENLABS|JEV)_[A-Z0-9_]+"/g) ?? [])) {
				const bare = name.slice(1, -1);
				if (!doc.includes(bare)) ctx.report(`apps/backend/src/main.rs: ${bare} is read but not in docs/environment.md`);
			}
		},
		violations: [{ "apps/backend/src/main.rs": 'env("SWITCHBOARD_NEW")', "build.rs": "", "docs/environment.md": "SWITCHBOARD_OLD" }],
		clean: [{ "apps/backend/src/main.rs": 'env("SWITCHBOARD_OLD")', "build.rs": "", "docs/environment.md": "SWITCHBOARD_OLD" }],
	},
	{
		// Fake executables go through write_executable_script, which owns the
		// permission and broken-pipe hazards (docs/concurrency-and-test-hazards.md).
		name: "one fake writer",
		run(ctx) {
			for (const file of ctx.files("apps/backend/tests", rustFiles)) {
				scan(ctx, file, /set_permissions\(|set_mode\(0o7/, "a fake executable written by hand (use write_executable_script)");
			}
		},
		violations: [{ "apps/backend/tests/a.rs": "perms.set_mode(0o755);\n" }, { "apps/backend/tests/a.rs": "fs::set_permissions(&p, perms);\n" }],
		clean: [{ "apps/backend/tests/a.rs": "write_executable_script(&p, body);\n" }],
	},
	{
		// The skill socket path is one path, built into both the host agent and
		// the Python skill (#163). Both sides name it; they must agree.
		name: "one skill socket path",
		run(ctx) {
			const ts = ctx.read("apps/host-agent/src/main.ts");
			const py = ctx.read("skills/switchboard/src/switchboard/__init__.py");
			const tsPath = ts.match(/SKILL_SOCKET_PATH = "~\/([^"]+)"/)?.[1];
			const pyParts = py.match(/_os\.path\.expanduser\("~"\)((?:,\s*"[^"]+")+)\)/)?.[1]?.match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1));
			if (!tsPath || !pyParts) ctx.report("skill socket path: could not read it from main.ts or __init__.py (the check needs updating)");
			else if (tsPath !== pyParts.join("/")) ctx.report(`skill socket path differs: host agent ~/${tsPath}, skill ~/${pyParts.join("/")}`);
		},
		violations: [
			{ "apps/host-agent/src/main.ts": 'SKILL_SOCKET_PATH = "~/.a/b.sock"', "skills/switchboard/src/switchboard/__init__.py": '_os.path.join(_os.path.expanduser("~"), ".a", "c.sock")' },
			{ "apps/host-agent/src/main.ts": "const x = 1;", "skills/switchboard/src/switchboard/__init__.py": "" },
		],
		clean: [{ "apps/host-agent/src/main.ts": 'SKILL_SOCKET_PATH = "~/.a/b.sock"', "skills/switchboard/src/switchboard/__init__.py": '_os.path.join(_os.path.expanduser("~"), ".a", "b.sock")' }],
	},
	{
		// Every repo path a doc names exists. A bare `src/` or `tests/` is
		// relative to the prose, not the root, and is skipped.
		name: "live doc paths",
		run(ctx) {
			for (const file of markdown(ctx)) {
				lines(ctx, file).forEach((line, index) => {
					for (const m of line.matchAll(/(?<![\w/.-])((?:apps|docs|skills|extensions|scripts|static|static-debug)\/[\w./-]*)/g)) {
						const target = m[1].replace(/[.,;:)]+$/, "").replace(/\/$/, "");
						if (target.includes("*") || target.includes("<") || !target.includes("/")) continue;
						if (!ctx.exists(target)) ctx.report(`${file}:${index + 1}: names ${target}, which does not exist`);
					}
				});
			}
		},
		violations: [{ "docs/a.md": "see `docs/gone.md`\n" }],
		clean: [{ "docs/a.md": "see `docs/a.md` and tests/ and docs/*.md\n" }],
	},
	{
		// Every HTTP route a doc names in a code span, with its method
		// (`POST /connect`), is one the service routes. Agents' display, view
		// and speak calls once had routes; they come over the host link now, and
		// a doc that still names `POST /display` sends a reader to a 404. A route
		// in prose or in a fenced block is not read.
		name: "live doc routes",
		run(ctx) {
			const routes = new Set();
			const methods = /\b(get|post|put|patch|delete)\(/g;
			for (const file of ctx.files("apps/backend/src", rustFiles)) {
				// Each `.route("/path", ...)` up to the next route or the end of the
				// chain, so `get(a).post(b)` gives both methods.
				const source = ctx.read(file);
				for (const m of source.matchAll(/\.route\(\s*"([^"]+)",([\s\S]*?)(?=\.route\(|\.with_state\(|\.fallback|;)/g)) {
					for (const method of m[2].matchAll(methods)) routes.add(`${method[1].toUpperCase()} ${m[1]}`);
				}
			}
			if (routes.size === 0) ctx.report("routes: found none in apps/backend/src (the check needs updating)");
			for (const file of markdown(ctx)) {
				lines(ctx, file).forEach((line, index) => {
					for (const m of line.matchAll(/`(GET|POST|PUT|PATCH|DELETE) (\/[^`\s?#]*)/g)) {
						const route = `${m[1]} ${m[2]}`;
						if (!routes.has(route)) ctx.report(`${file}:${index + 1}: names ${route}, which the service does not route`);
					}
				});
			}
		},
		violations: [
			{ "apps/backend/src/a.rs": 'Router::new().route("/a", get(h));', "docs/a.md": "call `POST /display`\n" },
			{ "apps/backend/src/a.rs": "fn main() {}", "docs/a.md": "" },
		],
		clean: [{ "apps/backend/src/a.rs": 'Router::new().route("/a", get(h).post(g));', "docs/a.md": "call `GET /a` or `POST /a`; prose POST /display\n" }],
	},
	{
		// Every SWITCHBOARD_ name a doc names is one docs/environment.md names,
		// exactly: it writes the live ones in full and the retired ones without
		// the prefix. A doc that names a retired setting in full
		// (`SWITCHBOARD_DISPLAY_URL`) tells a reader to set something nothing
		// reads.
		name: "documented doc settings",
		run(ctx) {
			const name = /\bSWITCHBOARD_[A-Z0-9][A-Z0-9_]*/g;
			const documented = new Set(ctx.read("docs/environment.md").match(name) ?? []);
			for (const file of markdown(ctx)) {
				lines(ctx, file).forEach((line, index) => {
					for (const m of line.matchAll(name)) {
						if (!documented.has(m[0])) ctx.report(`${file}:${index + 1}: names ${m[0]}, which docs/environment.md does not list`);
					}
				});
			}
		},
		violations: [{ "docs/environment.md": "SWITCHBOARD_A", "docs/a.md": "set SWITCHBOARD_B\n" }],
		clean: [{ "docs/environment.md": "SWITCHBOARD_A and DISPLAY_URL", "docs/a.md": "set SWITCHBOARD_A\n" }],
	},
	{
		// The depth a host-link frame may nest is one number on both sides: the
		// service's MAX_FRAME_DEPTH (serde_json's limit; a test in
		// test_hosts.rs pins it) and the skill module's _MAX_FRAME_DEPTH, which
		// holds a display call to it before sending.
		name: "one frame depth",
		run(ctx) {
			const rs = ctx.read("apps/backend/src/hosts.rs").match(/const MAX_FRAME_DEPTH: usize = (\d+);/)?.[1];
			const py = ctx.read("skills/switchboard/src/switchboard/__init__.py").match(/^_MAX_FRAME_DEPTH = (\d+)$/m)?.[1];
			if (!rs || !py) ctx.report("frame depth: could not read it from hosts.rs or __init__.py (the check needs updating)");
			else if (rs !== py) ctx.report(`frame depth differs: service MAX_FRAME_DEPTH ${rs}, skill _MAX_FRAME_DEPTH ${py}`);
		},
		violations: [
			{ "apps/backend/src/hosts.rs": "const MAX_FRAME_DEPTH: usize = 128;", "skills/switchboard/src/switchboard/__init__.py": "_MAX_FRAME_DEPTH = 64\n" },
			{ "apps/backend/src/hosts.rs": "", "skills/switchboard/src/switchboard/__init__.py": "_MAX_FRAME_DEPTH = 128\n" },
		],
		clean: [{ "apps/backend/src/hosts.rs": "const MAX_FRAME_DEPTH: usize = 128;", "skills/switchboard/src/switchboard/__init__.py": "_MAX_FRAME_DEPTH = 128\n" }],
	},
	{
		// The size caps are one set of numbers wherever they are written. The
		// raw image cap is in both validators, in the skill module (which
		// refuses a larger file before sending) and in the schema (as the
		// base64 length of that many bytes); the action caps, general and
		// image, are in both validators and in the skill module, which names
		// them with the skill socket's line cap when a request is too large.
		// Each link the action crosses leaves room around it: the
		// skill socket's line holds the action and 1 MiB of envelope, and the
		// host link's frame holds that line and 1 MiB more. The page refuses a
		// typed turn the service would refuse (`MAX_TYPED_TURN_CHARS`). The
		// corpus pins what the validators make of the caps; this pins the
		// copies it cannot run.
		name: "one set of size caps",
		run(ctx) {
			const cap = (file, pattern) => {
				const text = ctx.read(file).match(pattern)?.[1];
				if (!text || !/^\d[\d_]*(?:\s*\*\s*\d[\d_]*)*$/.test(text.trim())) {
					ctx.report(`size caps: could not read ${pattern.source} from ${file} (the check needs updating)`);
					return NaN;
				}
				return text.split("*").reduce((product, factor) => product * Number(factor.trim().replaceAll("_", "")), 1);
			};
			const mib = 1024 * 1024;
			const image = {
				"validation/image.ts": cap("apps/frontend/src/controller/validation/image.ts", /^export const MAX_IMAGE_BYTES = ([^;]+);$/m),
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
			const typedTurn = {
				"protocol.ts": cap("apps/frontend/src/protocol.ts", /^export const MAX_TYPED_TURN_CHARS = ([^;]+);$/m),
				"caller_input.rs": cap("apps/backend/src/caller_input.rs", /^pub\(crate\) const MAX_TYPED_TURN_CHARS: usize = ([^;]+);$/m),
			};
			const line = lineCaps["skill_socket.ts"];
			const frame = cap("apps/backend/src/hosts.rs", /^const MAX_HOST_FRAME_BYTES: usize = ([^;]+);$/m);
			const schema = JSON.parse(ctx.read("docs/display-action-v1.schema.json"));
			const base64 = schema.definitions?.ImageData?.properties?.bytes?.maxLength;
			const read = [...Object.values(image), ...Object.values(action), ...Object.values(general), ...Object.values(lineCaps), ...Object.values(typedTurn), frame].every((value) => !Number.isNaN(value));
			const same = (what, values) => {
				if (new Set(Object.values(values)).size > 1) ctx.report(`${what} differs: ${Object.entries(values).map(([file, value]) => `${file} ${value}`).join(", ")}`);
			};
			if (read) {
				same("raw image cap (MAX_IMAGE_BYTES)", image);
				same("image action cap (MAX_IMAGE_ACTION_BYTES)", action);
				same("action cap (MAX_ACTION_BYTES)", general);
				same("skill socket line cap (MAX_LINE_BYTES)", lineCaps);
				same("typed turn cap (MAX_TYPED_TURN_CHARS)", typedTurn);
				const raw = image["validation/image.ts"];
				if (base64 !== 4 * Math.ceil(raw / 3)) ctx.report(`docs/display-action-v1.schema.json: ImageData.bytes maxLength ${base64} is not the base64 length of ${raw} bytes (${4 * Math.ceil(raw / 3)})`);
				if (line < action["validation.ts"] + mib) ctx.report(`apps/host-agent/src/skill_socket.ts: MAX_LINE_BYTES ${line} leaves less than 1 MiB around a ${action["validation.ts"]}-byte image action`);
				if (frame < line + mib) ctx.report(`apps/backend/src/hosts.rs: MAX_HOST_FRAME_BYTES ${frame} leaves less than 1 MiB around a ${line}-byte skill socket line`);
			}
		},
		violations: [
			capsTree({ imageRs: "2 * 1024 * 1024" }),
			capsTree({ imageActionRs: "5 * 1024 * 1024" }),
			capsTree({ actionRs: "2 * 1024 * 1024" }),
			capsTree({ linePy: "4 * 1024 * 1024" }),
			capsTree({ typedRs: "99" }),
			capsTree({ base64: 1 }),
			capsTree({ line: "4 * 1024 * 1024" }),
			capsTree({ frame: "5 * 1024 * 1024" }),
			capsTree({ action: "lots" }),
		],
		clean: [capsTree()],
	},
	{
		// A unit-test time budget measures the test thread's CPU time with
		// leastCpuMs (apps/frontend/tests/unit/cpuTime.ts), never the wall
		// clock, which under load measures the machine: wall-clock budgets
		// failed 17 times in 7 loaded runs
		// (docs/concurrency-and-test-hazards.md). The host agent's tests too.
		name: "CPU-time budgets",
		run(ctx) {
			for (const file of ctx.files(["apps/frontend/tests/unit", "apps/host-agent/tests"], tsFiles)) {
				if (path.basename(file) === "cpuTime.ts") continue;
				scan(ctx, file, /\b(?:performance\.now|Date\.now|process\.hrtime)\b/, "the wall clock in a unit test (time a budget with leastCpuMs, cpuTime.ts)");
			}
		},
		violations: [{ "apps/frontend/tests/unit/a.test.ts": "const t = performance.now();\n" }, { "apps/host-agent/tests/a.test.ts": "Date.now();\n" }],
		clean: [{ "apps/frontend/tests/unit/a.test.ts": "leastCpuMs(fn);\n", "apps/frontend/tests/unit/cpuTime.ts": "process.hrtime();\n" }],
	},
	{
		// No focused test: a `.only` left in a test makes its runner skip the
		// rest. Playwright fails a CI run that finds one (forbidOnly), but the
		// browser job is not the check master requires, and `node --test` runs
		// every test anyway, so a focused host-agent test hides nothing until it
		// is run by hand. This refuses it in `npm test`, which master requires.
		name: "no focused tests",
		run(ctx) {
			for (const file of ctx.files(["apps/frontend/tests", "apps/host-agent/tests"], new Set([".ts", ".tsx", ".mjs", ".js"]))) {
				scan(ctx, file, /\b(?:test|it|describe)(?:\.\w+)*\.only\(/, "a focused test (.only): it makes its runner skip the rest");
			}
		},
		violations: [{ "apps/frontend/tests/a.spec.ts": "test.only('a', () => {});\n" }, { "apps/host-agent/tests/a.test.ts": "describe.serial.only('a', () => {});\n" }],
		clean: [{ "apps/frontend/tests/a.spec.ts": "test('only the one', () => {});\n" }],
	},
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
		// A backend test waits on a channel, a Notify, a watch, a stream, a
		// oneshot or a task's JoinHandle through within()
		// (apps/backend/src/main.rs), which fails the test by name after a
		// generous deadline. libtest only warns after its default timeout and never fails a test, so a
		// bare await whose wake-up is lost hangs cargo test with no output (#338).
		// A handle aborted on the line before is not waited on. A fake that is
		// meant to wait as long as its test says so on the line before:
		// `// unbounded: <why>`.
		name: "bounded test awaits",
		run(ctx) {
			const wait = /(?:\.(?:recv|next|notified|changed)\(\)|(?<![.\w])([a-z_]\w*))/;
			const sameLine = new RegExp(`${wait.source}\\s*\\.await\\b`);
			const lineEnd = new RegExp(`${wait.source}$`);
			for (const file of ctx.files("apps/backend/tests", rustFiles)) {
				const text = lines(ctx, file);
				text.forEach((line, index) => {
					const before = text[index - 1] ?? "";
					const match = sameLine.exec(line) ?? (/^\s*\.await\b/.test(text[index + 1] ?? "") ? lineEnd.exec(line.trimEnd()) : null);
					if (!match) return;
					const bounded = text.slice(Math.max(0, index - 3), index + 1).some((near) => /\b(?:within|timeout)\(/.test(near));
					const aborted = match[1] !== undefined && before.includes(`${match[1]}.abort()`);
					if (!bounded && !aborted && !/\/\/ unbounded: \S/.test(before)) ctx.report(`${file}:${index + 1}: a test await with no deadline (wrap it in within(), or mark a fake \`// unbounded: <why>\`)`);
				});
			}
		},
		violations: [
			{ "apps/backend/tests/a.rs": "    let v = rx.recv().await;\n" },
			{ "apps/backend/tests/a.rs": "    let v = done\n        .await;\n" },
		],
		clean: [
			{
				"apps/backend/tests/a.rs": [
					'    within("x", async {',
					"        rx.recv().await",
					"    }).await;",
					"    handle.abort();",
					"    handle.await.ok();",
					"    // unbounded: a fake that waits as long as its test",
					"    rx.recv().await;",
					"",
				].join("\n"),
			},
		],
	},
	{
		// The page lays out from the stage's own box (docs/ipad.md). With
		// `viewport-fit=cover` Safari lays the page under the notch and the
		// home indicator, and only `env(safe-area-inset-*)` keeps it out; the
		// page had the one with none of the other (#275).
		name: "no page under the notch",
		run(ctx) {
			const shell = ctx.read("apps/frontend/index.html");
			const styles = ctx.read("apps/frontend/src/styles/index.css");
			if (/viewport-fit\s*=\s*cover/.test(shell) && !styles.includes("env(safe-area-inset-")) ctx.report("apps/frontend/index.html: viewport-fit=cover with no env(safe-area-inset-*) in index.css: the page draws under the notch");
		},
		violations: [{ "apps/frontend/index.html": '<meta content="width=device-width, viewport-fit=cover">', "apps/frontend/src/styles/index.css": ".a { top: 0; }\n" }],
		clean: [
			{ "apps/frontend/index.html": '<meta content="viewport-fit=cover">', "apps/frontend/src/styles/index.css": ".a { top: env(safe-area-inset-top); }\n" },
			{ "apps/frontend/index.html": '<meta content="width=device-width">', "apps/frontend/src/styles/index.css": ".a { top: 0; }\n" },
		],
	},
	{
		// The runtime's ID namespace is one prefix, RUNTIME_ID_PREFIX
		// (apps/frontend/src/controller/types.ts). The reducer routes an ID with
		// it to runtime state and the validator refuses it from an agent; a
		// second copy of the literal lets the two drift, and an agent ID then
		// writes into the runtime's objects.
		name: "one runtime ID prefix",
		run(ctx) {
			const copies = [];
			for (const file of ctx.files("apps/frontend/src", tsFiles)) {
				lines(ctx, file).forEach((line, index) => {
					if (/['"`]__runtime\//.test(line)) copies.push(`${file}:${index + 1}`);
				});
			}
			if (copies.length !== 1) ctx.report(`the '__runtime/' prefix is written ${copies.length} times (${copies.join(", ")}); import RUNTIME_ID_PREFIX from controller/types.ts`);
		},
		violations: [
			{ "apps/frontend/src/controller/types.ts": "export const RUNTIME_ID_PREFIX = '__runtime/';\n", "apps/frontend/src/a.ts": 'const id = "__runtime/x";\n' },
			{ "apps/frontend/src/controller/types.ts": "export const RUNTIME_ID_PREFIX = 'runtime';\n" },
		],
		clean: [{ "apps/frontend/src/controller/types.ts": "export const RUNTIME_ID_PREFIX = '__runtime/';\n", "apps/frontend/src/a.ts": "import { RUNTIME_ID_PREFIX } from './controller/types';\n" }],
	},
	{
		// The layout reads only the stage's own geometry (docs/ipad.md): a
		// size in the stylesheet is in container units, not the viewport's.
		// Safari's `vh` is its large viewport, taller than what shows with
		// its toolbars out, and a focus box sized in it ran under them (#271);
		// `lvh` names that viewport outright and `svh` is no stage either.
		// The stage sizes itself (`100vw`, and `100vh` before `100dvh`).
		name: "stage-relative sizes",
		run(ctx) {
			const stylesheet = "apps/frontend/src/styles/index.css";
			let inStage = false;
			lines(ctx, stylesheet).forEach((line, index) => {
				if (/^\.stage \{$/.test(line)) inStage = true;
				else if (inStage && /^\}$/.test(line)) inStage = false;
				else if (!inStage && /\d[ls]?v(?:h|w|i|b|min|max)\b/.test(line)) ctx.report(`${stylesheet}:${index + 1}: a viewport unit (size it in cqw/cqh from the stage)`);
			});
		},
		violations: [
			{ "apps/frontend/src/styles/index.css": ".box {\n  height: 100vh;\n}\n" },
			{ "apps/frontend/src/styles/index.css": ".stage {\n  width: 100vw;\n}\n.box {\n  height: 50lvh;\n}\n" },
		],
		clean: [{ "apps/frontend/src/styles/index.css": ".stage {\n  height: 100vh;\n  height: 100dvh;\n}\n.box {\n  height: 50cqh;\n}\n" }],
	},
	{
		// A lifecycle that has become a machine has one writer
		// (AGENTS.md; doctrine 2a): its state is assigned on one line of its
		// file, inside the transition function, and each teardown primitive
		// named in `once` occurs on one line, the phase exit. A row whose
		// pattern matches nothing fails too, so a rename cannot retire it.
		// Each machine's pull request adds its row.
		name: "one writer per machine",
		config: { machines },
		sampleConfig: { machines: [machineSample] },
		run(ctx, { machines: rows }) {
			for (const machine of rows) for (const finding of machineFindings(machine.file, lines(ctx, machine.file), machine)) ctx.report(finding);
		},
		violations: [
			{ "sample.ts": `${transition}\tstop() { this.phase = idle; stream.getTracks(); }\n}` },
			{ "sample.ts": `${transition}\texit() { stream.getTracks(); }\n\tstop() { stream.getTracks(); }\n}` },
			{ "sample.ts": "class M {\n\tprivate state = idle;\n}" },
		],
		clean: [{ "sample.ts": `${transition}\texit() { stream.getTracks(); }\n}` }],
	},
	{
		// The lifecycle owners that are not machines yet do not grow
		// phase fields (AGENTS.md; doctrine 2a). `fields` is the count on
		// master when the check landed, and the check wants it exactly: one
		// more is the flag rule 2a says to extract the machine before adding,
		// and one fewer lowers the number here, so it cannot creep back. When
		// an owner becomes a machine, it takes a row in the machines table and
		// keeps its row here at what is left beside the machine, 0 included: a
		// flag added next to a machine is the same mistake.
		name: "no new lifecycle flags",
		config: { owners },
		sampleConfig: { owners: [{ file: "sample.ts", owner: "Owner", fields: 2 }, { file: "sample.rs", owner: "Inner", fields: 2 }] },
		run(ctx, { owners: rows }) {
			for (const row of rows) for (const finding of ownerFindings(row.file, lines(ctx, row.file), row)) ctx.report(finding);
		},
		violations: [
			ownerTree(ownerSample.replace("\tprivate count = 0;", "\tprivate starting = false;")),
			ownerTree(ownerSample.replace("    label: String,", "    task: Option<JoinHandle<()>>,")),
			ownerTree(ownerSample.replace("\tprivate count = 0;", "\tprivate barrier: {\n\t\tid: string;\n\t} | null = null;")),
			ownerTree(ownerSample.replace("\tprivate count = 0;", "\tprivate pending: string | undefined;")),
			ownerTree(ownerSample.replace("\tprivate count = 0;", "\tprivate attempt = 0;")),
			ownerTree(ownerSample.replace("\tprivate runtimeToken = 0;", "")),
			ownerTree(ownerSample.replace("export class Owner {", "export class Renamed {")),
		],
		clean: [ownerTree(ownerSample)],
	},
	{
		// The composition is built once a render, by SceneRenderer, and handed
		// to the scenes (#380). A scene that builds its own is free to pick its
		// own primary, and one did: the chart scene drew a primary and a chart
		// order the screen state did not name (#266). The screen-state report
		// (deriveScreenState, beside the builder in sceneModel.ts) builds its own.
		name: "one composition a render",
		run(ctx) {
			const builders = new Set(["apps/frontend/src/components/SceneRenderer.tsx", "apps/frontend/src/app/sceneModel.ts"]);
			for (const file of ctx.files("apps/frontend/src", tsFiles)) {
				if (builders.has(file)) continue;
				scan(ctx, file, /\bbuildCompositionModel\b/, "the composition built outside SceneRenderer (take it from SceneProps.composition)");
			}
		},
		violations: [{ "apps/frontend/src/components/Scenes.tsx": "const c = buildCompositionModel(state);\n" }],
		clean: [{ "apps/frontend/src/components/SceneRenderer.tsx": "buildCompositionModel(state);\n", "apps/frontend/src/components/Scenes.tsx": "props.composition;\n" }],
	},
	{
		// A value read from the layout goes through useMeasured (#392): read in
		// a layout effect, each report committed before the frame it reports
		// is painted, and its observers released in one place. Each reader
		// that observed the layout by itself chose its own commit policy, and
		// the one left to React's schedule drew timers a frame, on a loaded
		// WebKit 520 ms, late (#333). An observer elsewhere is named here with
		// why it is not such a value, and a name that observes nothing fails,
		// so the list cannot outlive its reason.
		name: "one hook for a measured value",
		run(ctx) {
			const measured = "apps/frontend/src/hooks/useMeasured.ts";
			const observers = new Map([
				[measured, "the hook"],
				["apps/frontend/src/hooks/usePinnedScroll.ts", "a scroll pinned to its newest line, not a value drawn"],
				["apps/frontend/src/components/ChartNotes.tsx", "the notes' placement pass: its reads set the cards' widths to measure them, and it rests after a resize"],
				["apps/frontend/src/debug/SwitchboardView.tsx", "the debug page's geometry, measured once a frame"],
			]);
			const observer = /\bnew (?:Resize|Mutation)Observer\b/;
			for (const file of ctx.files("apps/frontend/src", tsFiles)) {
				if (!observers.has(file)) scan(ctx, file, observer, "a layout observer outside useMeasured: read the value through it (AGENTS.md)");
				if (file !== measured) scan(ctx, file, /\bflushSync\b/, "flushSync outside useMeasured: a measured value is committed by the hook (AGENTS.md)");
			}
			for (const name of observers.keys()) {
				if (!ctx.exists(name) || !lines(ctx, name).some((line) => observer.test(line))) ctx.report(`${name}: named in "one hook for a measured value" but observes nothing: take it off the list`);
			}
		},
		violations: [
			{ ...observerFiles(), "apps/frontend/src/a.tsx": "const o = new ResizeObserver(cb);\n" },
			{ ...observerFiles(), "apps/frontend/src/a.tsx": "flushSync(() => set(1));\n" },
			{ ...observerFiles(), "apps/frontend/src/hooks/usePinnedScroll.ts": "const x = 1;\n" },
		],
		clean: [observerFiles()],
	},
	{
		// A backend test captures logs with debug::capture_logs, never with a
		// subscriber scoped to its thread. The scope is one thread, but tracing
		// caches each callsite's interest for the whole process, from the thread
		// that reaches it first: another test's thread, which has no subscriber,
		// caches it as never, and the capturing test loses its line (#368;
		// docs/concurrency-and-test-hazards.md).
		name: "one log capture",
		run(ctx) {
			for (const file of ctx.files(["apps/backend/src", "apps/backend/tests"], rustFiles)) {
				scan(ctx, file, /\b(?:set|with)_default\b|\.with_subscriber\(/, "a subscriber scoped to one thread (capture logs with debug::capture_logs)");
			}
		},
		violations: [{ "apps/backend/tests/a.rs": "let _g = tracing::subscriber::set_default(s);\n" }, { "apps/backend/src/a.rs": "fut.with_subscriber(s);\n" }],
		clean: [{ "apps/backend/tests/a.rs": "let logs = debug::capture_logs(&bus);\n" }],
	},
	{
		// Every page control runs its body through detached(): hyper drops a
		// handler's future when the client goes away while the response is
		// pending, and a control dropped between its rescue and its settle
		// would leave the quiet with nothing to end it (#462;
		// docs/concurrency-and-test-hazards.md). A handler is a function under
		// the `http` instrument attribute; its body ends at the first `}` in
		// column 0.
		name: "detached page controls",
		run(ctx) {
			const file = "apps/backend/src/page_controls.rs";
			const text = lines(ctx, file);
			text.forEach((line, index) => {
				if (!/#\[tracing::instrument\(name = "http"/.test(line)) return;
				const name = /async fn (\w+)\(/.exec(text[index + 1] ?? "")?.[1] ?? "?";
				let end = index + 1;
				while (end < text.length && text[end] !== "}") end += 1;
				if (!text.slice(index, end).some((body) => /\bdetached\(/.test(body))) ctx.report(`${file}:${index + 2}: page control ${name} awaits its body inline (run it through detached(), so a dropped request still reaches its settle)`);
			});
		},
		violations: [{ "apps/backend/src/page_controls.rs": '#[tracing::instrument(name = "http", skip_all, fields(endpoint = "/x"))]\npub(crate) async fn x(State(state): State<AppState>) -> Response {\n    run_page_control(control, body).await\n}\n' }],
		clean: [{ "apps/backend/src/page_controls.rs": '#[tracing::instrument(name = "http", skip_all, fields(endpoint = "/x"))]\npub(crate) async fn x(State(state): State<AppState>) -> Response {\n    detached(run_page_control(control, body))\n        .await\n}\n\nasync fn helper() {\n    run_page_control(control, body).await\n}\n' }],
	},
	{
		// A frontend unit test fakes the page's WebSocket with the one FakeSocket
		// (tests/unit/fakeSocket.ts), installs it with FakeSocket.install(), and
		// drives it with its open, drop, receive and receiveRaw, not by calling a
		// socket's handlers (#411). Eight copies had drifted: some recorded
		// `send`, some did not, some closed at once and some never reported the
		// close. A MessagePort's `onmessage` is not a socket's, and a send-only
		// literal passed as a socket (pushToTalk) is a sink, not a fake.
		name: "one socket fake",
		run(ctx) {
			const socketFake = /\bclass\s+\w*Socket\b|\bclass\b[^{]*\bextends\s+WebSocket\b|\b\w*Socket\s*=\s*class\b|stubGlobal\(\s*['"]WebSocket['"]\s*,(?!\s*FakeSocket\b)/;
			const socketHandler = /\b(?:\w*[sS]ocket\w*|FakeSocket\.latest\(\))(?:\(\)|\[[^\]]*\])?\??\.on(?:message|open|close|error)\?\.\(/;
			for (const file of ctx.files("apps/frontend/tests/unit", tsFiles)) {
				if (file === "apps/frontend/tests/unit/fakeSocket.ts") continue;
				scan(ctx, file, socketFake, "a socket fake of its own: use FakeSocket from tests/unit/fakeSocket.ts (FakeSocket.install())");
				scan(ctx, file, socketHandler, "a socket's handler called by hand: use FakeSocket's open, drop, receive or receiveRaw");
			}
		},
		violations: [
			{ "apps/frontend/tests/unit/a.test.ts": "class FakeSocket {}\n" },
			{ "apps/frontend/tests/unit/a.test.ts": "vi.stubGlobal('WebSocket', Mine);\n" },
			{ "apps/frontend/tests/unit/a.test.ts": "socket.onmessage?.({ data: '{}' });\n" },
			{ "apps/frontend/tests/unit/a.test.ts": "FakeSocket.latest().onopen?.(new Event('open'));\n" },
		],
		clean: [
			{
				"apps/frontend/tests/unit/fakeSocket.ts": "export class FakeSocket {}\nthis.onmessage?.(event);\n",
				"apps/frontend/tests/unit/a.test.ts": "FakeSocket.install();\nvi.stubGlobal('WebSocket', FakeSocket);\nport.onmessage?.(event);\nFakeSocket.latest().receive({ type: 'x' });\n",
			},
		],
	},
];


const selfTestOnly = process.argv.includes("--self-test");
const failures = [];

const names = checks.map((check) => check.name);
for (const name of names) if (names.indexOf(name) !== names.lastIndexOf(name)) failures.push(`two checks are named "${name}"`);
for (const check of checks) {
	if (!check.violations?.length || !check.clean?.length) {
		failures.push(`self-test: "${check.name}" needs a violation and a clean sample`);
		continue;
	}
	// A sample the check cannot read is a broken sample, not a finding.
	const run = (tree, kind, index) => {
		const found = [];
		try {
			check.run(sampleTree(tree, (finding) => found.push(finding)), check.sampleConfig);
		} catch (error) {
			failures.push(`self-test: "${check.name}" threw on ${kind} sample ${index + 1}: ${error.message}`);
			return undefined;
		}
		return found;
	};
	check.violations.forEach((tree, index) => {
		if (run(tree, "violation", index)?.length === 0) failures.push(`self-test: "${check.name}" finds nothing in violation sample ${index + 1}`);
	});
	check.clean.forEach((tree, index) => {
		const wrong = run(tree, "clean", index);
		if (wrong?.length > 0) failures.push(`self-test: "${check.name}" refuses clean sample ${index + 1}: ${wrong[0]}`);
	});
}

if (!selfTestOnly) {
	const ctx = realTree((finding) => failures.push(finding));
	for (const check of checks) check.run(ctx, check.config);
}

if (failures.length > 0) {
	console.error(`check_hygiene: ${failures.length} finding(s):`);
	for (const finding of failures) console.error(`  ${finding}`);
	process.exit(1);
}
console.log(`check_hygiene: ${selfTestOnly ? `${checks.length} checks pass their self-tests` : names.join(", ")}`);

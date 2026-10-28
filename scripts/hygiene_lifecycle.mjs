// The lifecycle checks of check_hygiene.mjs: the machines table and the
// owners table, with the samples and helpers only they use.
import { lines } from "./hygiene_tree.mjs";

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

export const lifecycleChecks = [
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
];

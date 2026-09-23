/**
 * The switchboard tools a project agent gets: talk to the caller, hand them
 * back, or put them straight through to another project.
 *
 * This file is not installed on project hosts by configuration management —
 * several of them are not Ansible-managed. The switchboard copies it into a
 * cache directory under the ssh user's home the first time it connects to a
 * host, then starts pi with `-e <that path>` (see pbx.Switchboard._stage_extension).
 * If that copy fails, the agent's system prompt tells it to emit a sentinel line
 * instead, which needs nothing installed on the far end.
 *
 * Deliberately not MCP. Pi has no built-in MCP support because tool definitions
 * are expensive context, and an adapter would mean another config file, another
 * process, and another thing to install on every project host. A tool the
 * switchboard already ships to every host it connects to has none of those
 * problems.
 *
 * `return_to_operator`, `transfer_to_project` and `set_model` do not themselves
 * move anyone — the switchboard sees the call in pi's RPC event stream and
 * swings the line. `set_model` especially: an agent cannot restart itself onto
 * another model, because the process it would have to replace is the one making
 * the call. `speak` is the opposite: it does the real work here, because audio
 * has to reach the caller *now*, mid-turn, rather than whenever the turn
 * happens to settle.
 *
 * There is no `list_projects` here to match the operator's set: a project host
 * cannot read the switchboard's registry, so the extensions an agent may hand
 * the caller to are named in its system prompt instead.
 */

// @ts-expect-error Pi supplies these modules on the project host, not in this app's npm tree.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-expect-error Pi supplies these modules on the project host, not in this app's npm tree.
import { Type } from "typebox";

declare const process: { env: Record<string, string | undefined> };

const SPEAK_URL = process.env.SWITCHBOARD_SPEAK_URL ?? "";
const STATE_URL = process.env.SWITCHBOARD_STATE_URL ?? "";
const DISPLAY_URL = process.env.SWITCHBOARD_DISPLAY_URL ?? "";
const SESSION_TOKEN = process.env.SWITCHBOARD_SESSION_TOKEN ?? "";
const parsedSpeechDeadline = Number.parseInt(
	process.env.SWITCHBOARD_SPEECH_DEADLINE_MS ?? "25000",
	10,
);
const SPEECH_DEADLINE_MS =
	Number.isFinite(parsedSpeechDeadline) &&
	parsedSpeechDeadline > 0 &&
	parsedSpeechDeadline <= 120000
		? parsedSpeechDeadline
		: 25000;

async function refusal(resp: Response, action: string): Promise<string> {
	if (resp.status === 422 || resp.status === 404) {
		const screen = action === "line" ? "diagram" : action;
		const description =
			action === "display"
				? "describe it in words"
				: action === "diff"
					? "describe the changes in words"
					: action === "timeline"
						? "describe the timeline in words"
						: "describe the steps in words";
		return `this deployment has no ${screen} screen; ${description}`;
	}
	let detail = "";
	try {
		const text = await resp.text();
		try {
			const data = JSON.parse(text) as { detail?: string; reason?: string };
			detail = data.detail ?? data.reason ?? text;
		} catch {
			detail = text;
		}
	} catch {
		// Ignore body read errors
	}
	detail = detail.trim();
	if (detail.length > 500) {
		detail = `${detail.slice(0, 500)}…`;
	}
	if (detail) {
		return `The switchboard refused that ${action} (HTTP ${resp.status}): ${detail}`;
	}
	return `The switchboard refused that ${action} (HTTP ${resp.status}).`;
}

export default function agentSwitchboard(pi: ExtensionAPI) {
	// The switchboard asks for a thinking level on the command line, but the
	// runtime clamps it to what the model actually exposes — some models have
	// holes in their level map, and the clamp is silent. This session is the only
	// place the effective level is known, so it reports it: the page then states
	// a level the caller can act on rather than one that was merely requested.
	const reportThinking = async () => {
		if (!STATE_URL) return;
		try {
			await fetch(STATE_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					thinking: pi.getThinkingLevel(),
					...(SESSION_TOKEN ? { token: SESSION_TOKEN } : {}),
				}),
				signal: AbortSignal.timeout(10_000),
			});
		} catch {
			// A label on a web page is never worth failing a call over.
		}
	};

	pi.on("session_start", async () => {
		await reportThinking();
	});
	pi.on("thinking_level_select", async () => {
		await reportThinking();
	});

	pi.registerTool({
		name: "speak",
		label: "Speak",
		description:
			"Say something out loud to the caller. This is a voice call: your written output goes to a screen they are probably not looking at, so anything you actually want them to hear has to go through this tool. Use it to answer them, to say what you are about to do before a long stretch of work, and to check in while that work is running \u2014 silence on a phone call reads as a dropped connection. Keep each line to a sentence or two of plain spoken English: no markdown, no file paths, no code, no lists.\n\n" +
			(process.env.SWITCHBOARD_PERSONA ?? ""),
		parameters: Type.Object({
			text: Type.String({
				description: "What to say, written the way a person would say it out loud.",
			}),
		}),
		async execute(_toolCallId, params) {
			if (!SPEAK_URL) {
				return {
					content: [
						{
							type: "text",
							text:
								"No SWITCHBOARD_SPEAK_URL is set, so nothing was spoken. Put your answer in your written reply instead — the switchboard will read it out.",
						},
					],
					details: {},
					isError: true,
				};
			}
			try {
				const resp = await fetch(SPEAK_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						text: params.text,
						...(SESSION_TOKEN ? { token: SESSION_TOKEN } : {}),
					}),
					signal: AbortSignal.timeout(SPEECH_DEADLINE_MS),
				});
				if (!resp.ok) {
					return {
						content: [
							{
								type: "text",
								text: await refusal(resp, "line"),
							},
						],
						details: {},
						isError: true,
					};
				}
				const data = (await resp.json()) as {
					delivered?: boolean;
					reason?: string;
				};
				if (data.delivered === false) {
					// Preserve written fallback whenever audio was not committed.
					// The Rust endpoint has already emitted the bounded reason.
					// Nobody has the page open, so the tool must not claim success.
					// Treat this as a tool error so written fallback remains eligible,
					// while the bounded reason tells the model why audio was not heard.
					return {
						content: [
							{
								type: "text",
								text: `Nothing was played: ${data.reason ?? "no browser connected"}. The caller cannot hear you right now.`,
							},
						],
						details: {},
						isError: true,
					};
				}
				return { content: [{ type: "text", text: "Spoken." }], details: {} };
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Could not reach the switchboard to speak: ${err}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	const SemanticType = Type.Union([
		Type.Literal("red"),
		Type.Literal("orange"),
		Type.Literal("green"),
		Type.Literal("cyan"),
		Type.Literal("amber"),
		Type.Literal("paper"),
		Type.Literal("muted"),
	]);

	const ChartSeriesType = Type.Object(
		{
			name: Type.String({ maxLength: 128 }),
			semantic: Type.Optional(SemanticType),
			values: Type.Array(Type.Number()),
		},
		{ additionalProperties: false },
	);

	const ChartDataType = Type.Object(
		{
			title: Type.Optional(Type.String({ maxLength: 256 })),
			subtitle: Type.Optional(Type.String({ maxLength: 256 })),
			context: Type.Optional(Type.String({ maxLength: 256 })),
			xLabel: Type.Optional(Type.String({ maxLength: 128 })),
			yLabel: Type.Optional(Type.String({ maxLength: 128 })),
			xMax: Type.Optional(Type.Number()),
			yMin: Type.Optional(Type.Number()),
			yMax: Type.Optional(Type.Number()),
			series: Type.Array(ChartSeriesType),
			marker: Type.Optional(
				Type.Object(
					{
						x: Type.Number(),
						series: Type.Optional(Type.String({ maxLength: 128 })),
					},
					{ additionalProperties: false },
				),
			),
			compareLabel: Type.Optional(Type.String({ maxLength: 128 })),
		},
		{ additionalProperties: false },
	);

	const MetricDataType = Type.Object(
		{
			label: Type.String({ maxLength: 128 }),
			value: Type.String({ maxLength: 128 }),
			semantic: Type.Optional(SemanticType),
		},
		{ additionalProperties: false },
	);

	const ProgressDataType = Type.Object(
		{
			label: Type.String({ maxLength: 128 }),
			detail: Type.Optional(Type.String({ maxLength: 256 })),
			value: Type.Number(),
			text: Type.Optional(Type.String({ maxLength: 128 })),
		},
		{ additionalProperties: false },
	);

	const DiagramNodeType = Type.Object(
		{
			id: Type.String({ minLength: 1, maxLength: 128 }),
			label: Type.String({ maxLength: 256 }),
			sub: Type.Optional(Type.String({ maxLength: 256 })),
			detail: Type.Optional(Type.String({ maxLength: 256 })),
			semantic: Type.Optional(SemanticType),
			state: Type.Optional(
				Type.Union([
					Type.Literal("done"),
					Type.Literal("active"),
					Type.Literal("todo"),
					Type.Literal("blocked"),
				]),
			),
		},
		{ additionalProperties: false },
	);

	const DiagramEdgeType = Type.Object(
		{
			from: Type.String({ minLength: 1, maxLength: 128 }),
			to: Type.String({ minLength: 1, maxLength: 128 }),
			label: Type.Optional(Type.String({ maxLength: 256 })),
			semantic: Type.Optional(SemanticType),
			active: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: false },
	);

	const DiagramDataType = Type.Object(
		{
			title: Type.Optional(Type.String({ maxLength: 256 })),
			subtitle: Type.Optional(Type.String({ maxLength: 256 })),
			context: Type.Optional(Type.String({ maxLength: 256 })),
			mode: Type.Literal("graph"),
			nodes: Type.Array(DiagramNodeType, { minItems: 1, maxItems: 100 }),
			edges: Type.Array(DiagramEdgeType, { maxItems: 200 }),
		},
		{ additionalProperties: false },
	);

	const DocumentDataType = Type.Object(
		{
			kind: Type.Optional(
				Type.Union([Type.Literal("email"), Type.Literal("document")]),
			),
			context: Type.Optional(Type.String({ maxLength: 256 })),
			source: Type.Optional(Type.String({ maxLength: 256 })),
			from: Type.Optional(Type.String({ maxLength: 128 })),
			timestamp: Type.Optional(Type.String({ maxLength: 128 })),
			subject: Type.String({ maxLength: 256 }),
			paragraphs: Type.Array(Type.String()),
		},
		{ additionalProperties: false },
	);

	const CodeDataType = Type.Object(
		{
			title: Type.Optional(Type.String({ maxLength: 256 })),
			file: Type.Optional(Type.String({ maxLength: 256 })),
			context: Type.Optional(Type.String({ maxLength: 256 })),
			source: Type.Object(
				{
					language: Type.Optional(Type.String({ maxLength: 64 })),
					text: Type.String({ maxLength: 50000 }),
					highlight: Type.Optional(Type.Array(Type.Number())),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	);

	const RichSegmentType = Type.Object(
		{
			text: Type.String({ maxLength: 50000 }),
			accent: Type.Optional(Type.Boolean()),
			bold: Type.Optional(Type.Boolean()),
			semantic: Type.Optional(SemanticType),
		},
		{ additionalProperties: false },
	);

	const NoteDataType = Type.Object(
		{
			tag: Type.Optional(Type.String({ maxLength: 128 })),
			segments: Type.Array(RichSegmentType),
		},
		{ additionalProperties: false },
	);

	const RoleType = Type.Union([
		Type.Literal("primary"),
		Type.Literal("compare"),
		Type.Literal("secondary"),
		Type.Literal("ambient"),
	]);

	const ShowChartAction = Type.Object(
		{
			op: Type.Literal("show"),
			id: Type.String({ minLength: 1, maxLength: 128 }),
			type: Type.Literal("chart"),
			role: Type.Optional(RoleType),
			data: ChartDataType,
		},
		{ additionalProperties: false },
	);

	const ShowMetricAction = Type.Object(
		{
			op: Type.Literal("show"),
			id: Type.String({ minLength: 1, maxLength: 128 }),
			type: Type.Literal("metric"),
			role: Type.Optional(RoleType),
			data: MetricDataType,
		},
		{ additionalProperties: false },
	);

	const ShowProgressAction = Type.Object(
		{
			op: Type.Literal("show"),
			id: Type.String({ minLength: 1, maxLength: 128 }),
			type: Type.Literal("progress"),
			role: Type.Optional(RoleType),
			data: ProgressDataType,
		},
		{ additionalProperties: false },
	);

	const ShowDiagramAction = Type.Object(
		{
			op: Type.Literal("show"),
			id: Type.String({ minLength: 1, maxLength: 128 }),
			type: Type.Literal("diagram"),
			role: Type.Optional(RoleType),
			data: DiagramDataType,
		},
		{ additionalProperties: false },
	);

	const ShowDocumentAction = Type.Object(
		{
			op: Type.Literal("show"),
			id: Type.String({ minLength: 1, maxLength: 128 }),
			type: Type.Literal("document"),
			role: Type.Optional(RoleType),
			data: DocumentDataType,
		},
		{ additionalProperties: false },
	);

	const ShowCodeAction = Type.Object(
		{
			op: Type.Literal("show"),
			id: Type.String({ minLength: 1, maxLength: 128 }),
			type: Type.Literal("code"),
			role: Type.Optional(RoleType),
			data: CodeDataType,
		},
		{ additionalProperties: false },
	);

	const ShowNoteAction = Type.Object(
		{
			op: Type.Literal("show"),
			id: Type.String({ minLength: 1, maxLength: 128 }),
			type: Type.Literal("note"),
			role: Type.Optional(RoleType),
			data: NoteDataType,
		},
		{ additionalProperties: false },
	);

	const HideAction = Type.Object(
		{
			op: Type.Literal("hide"),
			id: Type.String({ minLength: 1, maxLength: 128 }),
		},
		{ additionalProperties: false },
	);

	const FocusAction = Type.Object(
		{
			op: Type.Literal("focus"),
			id: Type.String({ minLength: 1, maxLength: 128 }),
		},
		{ additionalProperties: false },
	);

	const SpeechAnchorType = Type.Union([
		Type.Object(
			{
				x: Type.Number(),
				series: Type.Optional(Type.String({ maxLength: 128 })),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				x: Type.Optional(Type.Number()),
				series: Type.String({ maxLength: 128 }),
			},
			{ additionalProperties: false },
		),
	]);

	const SayAction = Type.Object(
		{
			op: Type.Literal("say"),
			text: Type.String({ minLength: 1, maxLength: 50000 }),
			target: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			at: Type.Optional(Type.Union([SpeechAnchorType, Type.Null()])),
		},
		{ additionalProperties: false },
	);

	const ClearAction = Type.Object(
		{
			op: Type.Literal("clear"),
		},
		{ additionalProperties: false },
	);

	const DisplayActionType = Type.Union([
		ShowChartAction,
		ShowMetricAction,
		ShowProgressAction,
		ShowDiagramAction,
		ShowDocumentAction,
		ShowCodeAction,
		ShowNoteAction,
		HideAction,
		FocusAction,
		SayAction,
		ClearAction,
	]);

	pi.registerTool({
		name: "display",
		label: "Display",
		description:
			"Show semantic content on the caller's screen. Use one action per call with op show, hide, say, focus, or clear. You can show chart, metric, progress, diagram, document, code, or note objects; compose a scene with roles (primary, compare, secondary, ambient). Reuse a stable id to update an object in place so the renderer can animate continuity. Use short, meaningful labels and let the renderer decide layout: never send markup, CSS, coordinates, or styling. The live transcript is system-owned, so message is not available; use note for on-screen asides and speak for words." +
			"\n\nShapes: chart: {series:[{name,values:[n]}]} | metric: {label,value} | " +
			"progress: {label,value} | diagram: {mode:\"graph\",nodes:[{id,label}],edges:[{from,to}]} | " +
			"document: {subject,paragraphs:[str]} | code: {source:{text}} | note: {segments:[{text}]}. " +
			"Set type to the object you want; each type takes only its own shape.",
		parameters: DisplayActionType,
		async execute(_toolCallId, params) {
			if (!DISPLAY_URL) {
				return {
					content: [{ type: "text", text: "No SWITCHBOARD_DISPLAY_URL is set, so there is no display screen. Describe it in words instead." }],
					details: {},
					isError: true,
				};
			}
			try {
				const resp = await fetch(DISPLAY_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action: params, ...(SESSION_TOKEN ? { token: SESSION_TOKEN } : {}) }),
					signal: AbortSignal.timeout(30_000),
				});
				if (!resp.ok) {
					return { content: [{ type: "text", text: await refusal(resp, "display") }], details: {}, isError: true };
				}
				const data = (await resp.json()) as {
					delivered?: boolean;
					rendered?: boolean;
					rejected?: boolean;
					reason?: string;
				};
				if (data.delivered === false) {
					return {
						content: [{ type: "text", text: `Nobody is looking: ${data.reason ?? "no browser connected"}. It will be there if they open the page.` }],
						details: {},
					};
				}
				if (data.rejected) {
					return {
						content: [{ type: "text", text: `The caller's screen rejected it: ${data.reason ?? "invalid payload"}. Adjust the payload and try again.` }],
						details: {},
						isError: true,
					};
				}
				if (data.rendered === false) {
					return {
						content: [{ type: "text", text: "Sent, but the caller's screen has not confirmed it — it may not be visible. It will appear if they have the page open." }],
						details: {},
					};
				}
				return { content: [{ type: "text", text: "On screen." }], details: {} };
			} catch (err) {
				return { content: [{ type: "text", text: `Could not reach the switchboard to display: ${err}` }], details: {}, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "view",
		label: "View",
		description:
			"Inspect or direct the caller's live screen. Call with no target when what is already visible matters. Set a target when the caller asks to pull up, focus, maximize, dismiss, or return to something. The caller can also click around; their explicit focus wins until they dismiss it.\n\n" +
			"Targets:\n" +
			"- `visual`: Focuses the current diagram, diff, plan, or timeline.\n" +
			"- `comms`: Focuses the conversation and live tool activity.\n" +
			"- `system`: Focuses the active project, model, and route controls.\n" +
			"- `theater`: Gives the current visual the entire display.\n" +
			"- `auto`: Returns composition to the screen's content-aware default.",
		parameters: Type.Object({
			target: Type.Optional(
				Type.String({
					description:
						"Optional screen target: 'visual', 'comms', 'system', 'theater', or 'auto'. Omit to inspect the current screen.",
				}),
			),
			reason: Type.Optional(
				Type.String({
					description: "Brief reason for changing focus.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const viewUrl = DISPLAY_URL
				? new URL("/view", DISPLAY_URL).toString()
				: "";
			if (!viewUrl) {
				return {
					content: [{ type: "text", text: "No screen view URL available." }],
					details: {},
					isError: true,
				};
			}
			try {
				const resp = await fetch(viewUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						target: params.target ?? "",
						reason: params.reason ?? "",
						...(SESSION_TOKEN ? { token: SESSION_TOKEN } : {}),
					}),
					signal: AbortSignal.timeout(10_000),
				});
				if (!resp.ok) {
					return {
						content: [{ type: "text", text: await refusal(resp, "view") }],
						details: {},
						isError: true,
					};
				}
				const data = (await resp.json()) as {
					delivered?: boolean;
					screen?: {
						view?: string;
						has_visual?: boolean;
						visual_kind?: string;
						title?: string;
						stale?: boolean;
						connected?: boolean;
						confirmed?: boolean;
					};
				};
				if (!params.target) {
					const screen = data.screen ?? {};
					const kind = screen.visual_kind || "visual";
					const titled = screen.title ? ` titled '${screen.title}'` : "";
					let text: string;
					if (!screen.has_visual) {
						text = "Nothing is on the caller's screen right now.";
					} else if (screen.confirmed) {
						text = `Showing a ${kind}${titled} on the caller's screen.`;
					} else {
						text = `Requested a ${kind}${titled}, but the caller's screen has not confirmed it yet.`;
					}
					if (screen.connected === false) {
						text += " No browser is connected.";
					}
					return { content: [{ type: "text", text }], details: { screen } };
				}
				return {
					content: [
						{
							type: "text",
							text: `Requested ${params.target} view. The caller's pinned view may take precedence.`,
						},
					],
					details: { target: params.target },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Could not inspect or switch view: ${err}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "return_to_operator",
		label: "Back to operator",
		description:
			"Hand the caller back to the switchboard operator. Call this when they say they are done here, ask for the operator, or ask to be sent to a different project. Do not call it just because you finished a task — they usually have more to say. This session ends when you call it, so anything unfinished should go in `summary`.",
		parameters: Type.Object({
			summary: Type.Optional(
				Type.String({
					description:
						"One or two sentences on what happened here and anything left unfinished. The operator hears this, so the caller does not have to repeat themselves.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [
					{
						type: "text",
						text:
							"Handing the caller back to the operator. Say a short goodbye and nothing else.",
					},
				],
				details: { summary: params.summary ?? "" },
			};
		},
	});

	pi.registerTool({
		name: "transfer_to_project",
		label: "Transfer",
		description:
			"Put the caller straight through to another project's agent, without going back through the operator. Call this when they ask to be sent somewhere else and name a project you were told exists \u2014 the transfer is silent, and the target project addresses the request immediately without a greeting, so say nothing alongside this call. Pass what they want done as `intent`. If you are not sure the project exists, use `return_to_operator` instead.",
		parameters: Type.Object({
			project: Type.String({
				description: "Which project to connect them to, by the id you were given.",
			}),
			intent: Type.Optional(
				Type.String({
					description: "What they want done there, in their own words.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						'Only if the caller asked for a specific model over there. Provider first when you know it, e.g. "anthropic/claude-sonnet-5". Omit to use that project\'s usual model.',
				}),
			),
			thinking: Type.Optional(
				Type.String({
					description:
						"Only if the caller asked for a thinking level over there: off, minimal, low, medium, high, xhigh or max.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [
					{
						type: "text",
						text: `Connecting the caller to ${params.project}. Transfer is silent; say nothing further \u2014 anything you write here is omitted.`,
					},
				],
				details: { project: params.project },
			};
		},
	});

	pi.registerTool({
		name: "set_model",
		label: "Change model",
		description:
			"Re-dial this same project on a different model or thinking level, because the caller asked. Your session is restarted on it \u2014 you keep this conversation unless you ask for it to be cleared \u2014 so say nothing alongside this call; you will be prompted again once you are back. If the model name is ambiguous the switchboard refuses and reads the caller the candidates, so pass what they said rather than guessing a provider.",
		parameters: Type.Object({
			model: Type.Optional(
				Type.String({
					description:
						'The model to run on, provider first when you know it, e.g. "anthropic/claude-opus-5". Omit when only the thinking level is changing.',
				}),
			),
			thinking: Type.Optional(
				Type.String({
					description:
						"Thinking level: off, minimal, low, medium, high, xhigh or max. Omit to leave it as it is.",
				}),
			),
			keep_context: Type.Optional(
				Type.Boolean({
					description:
						"Default true \u2014 the new model picks up this conversation. Pass false only when the caller explicitly wants a clean slate.",
				}),
			),
			intent: Type.Optional(
				Type.String({
					description:
						"Anything they want done once you are back on the new model, in their own words.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [
					{
						type: "text",
						text: `Re-dialling on ${params.model ?? "the same model"}${
							params.thinking ? ` at thinking ${params.thinking}` : ""
						}. Say nothing further \u2014 this session is being restarted and anything you write now is lost.`,
					},
				],
				details: {
					model: params.model ?? "",
					thinking: params.thinking ?? "",
					keep_context: params.keep_context ?? true,
				},
			};
		},
	});
}

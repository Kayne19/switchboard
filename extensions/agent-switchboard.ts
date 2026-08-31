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
const DIAGRAM_URL = process.env.SWITCHBOARD_DIAGRAM_URL ?? "";
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
			action === "diff"
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

	pi.registerTool({
		name: "diagram",
		label: "Diagram",
		description:
			"Draw a diagram on the caller's screen. This is a voice call, so use it whenever the answer is a shape rather than a sentence — an architecture, a call path, a state machine, a sequence, a comparison, a tree of options. Say the point out loud with `speak`; put the structure here. It renders immediately, mid-turn, so send one early and send another when the picture changes.\n\n" +
			"`source` is Mermaid. Keep it readable: a dozen nodes is a diagram, forty is wallpaper. Labels are short phrases, not sentences. Pick the diagram form that best fits the question: `flowchart TD`, `sequenceDiagram`, `stateDiagram-v2`, `timeline`, `gantt`, `gitGraph`, `erDiagram`, `mindmap`.\n\n" +
			"Draw top-down (`flowchart TD`) unless the shape genuinely reads better sideways — the panel is a tall column the caller scrolls and zooms, so left-to-right graphs come out squeezed.\n\n" +
			"The page applies a dark graphite theme from visual tokens. Do NOT use custom `classDef`, `style`, `linkStyle`, `%%{init}`, `click` directives, or hex colors — the server will reject them. Instead, use semantic class names: `:::active` (current step/causal path, max 1 node), `:::done` (completed work), `:::blocked` (waiting/held), `:::muted` (de-emphasized background). Node selection and incident edge highlighting are provided interactively by the page for flowchart and graph forms.\n\n" +
			'Images work. HTML labels are enabled, so `A["<img src=\'https://…\' width=\'48\'/><br/>label"]` puts a picture in a node; any URL the caller\'s browser can reach is fine. Newer Mermaid image and icon shapes (`A@{ img: "https://…", label: "…" }`) also work where the renderer supports them.\n\n' +
			"Each call makes the new diagram live. The caller can review the eight most recent visuals with the page history controls, so update the picture when the structure changes rather than preserving obsolete detail in one crowded diagram.",
		parameters: Type.Object({
			source: Type.String({
				description:
					"The Mermaid source, starting with its diagram type (`flowchart TD`, `sequenceDiagram`, `stateDiagram-v2`, `mindmap`, …). No fences, no surrounding prose.",
			}),
			title: Type.Optional(
				Type.String({
					description:
						"A few words naming what this shows, displayed above the diagram.",
				}),
			),
			notes: Type.Optional(
				Type.String({
					description:
						"One optional line under the diagram for what the picture cannot say — a caveat, a legend, what to look at first.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			if (!DIAGRAM_URL) {
				return {
					content: [
						{
							type: "text",
							text:
								"No SWITCHBOARD_DIAGRAM_URL is set, so there is no screen to draw on. Describe the structure in words instead.",
						},
					],
					details: {},
					isError: true,
				};
			}
			try {
				const resp = await fetch(DIAGRAM_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						source: params.source,
						title: params.title ?? "",
						notes: params.notes ?? "",
						...(SESSION_TOKEN ? { token: SESSION_TOKEN } : {}),
					}),
					signal: AbortSignal.timeout(30_000),
				});
				if (!resp.ok) {
					return {
						content: [
							{
								type: "text",
								text: await refusal(resp, "diagram"),
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
					// Not an error — nobody has the page open. The diagram is held and
					// shown if they open one, so this is information, not a failure.
					return {
						content: [
							{
								type: "text",
								text: `Nobody is looking: ${data.reason ?? "no browser connected"}. It will be there if they open the page.`,
							},
						],
						details: {},
					};
				}
				// The page reports nothing back about whether Mermaid parsed it, so
				// neither does this. Ask the caller if it looks right.
				return { content: [{ type: "text", text: "On screen." }], details: {} };
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Could not reach the switchboard to draw: ${err}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "plan",
		label: "Plan",
		description:
			"Push a structured plan or checklist to the caller's screen. Use this to show progress during multi-step tasks, long operations, or complex workflows. Updates in place on each call.\n\n" +
			"Each item must have a `label` (short phrase) and may specify a `state` (`done`, `active`, `todo`, `blocked`) and optional `detail` (monospace telemetry like paths, counts, durations).\n\n" +
			"At most one item may be `active` at a time. Send 1 to 40 items.",
		parameters: Type.Object({
			items: Type.Array(
				Type.Object({
					label: Type.String({
						description: "The step description or action name.",
					}),
					state: Type.Optional(
						Type.String({
							description:
								"Step status: 'done', 'active', 'todo', or 'blocked'. Default is 'todo'.",
						}),
					),
					detail: Type.Optional(
						Type.String({
							description:
								"Optional monospace detail line: path, symbol, count, duration, or telemetry.",
						}),
					),
				}),
			),
			title: Type.Optional(
				Type.String({
					description:
						"A few words naming what this plan accomplishes, displayed above the list.",
				}),
			),
			notes: Type.Optional(
				Type.String({
					description:
						"One optional line under the plan for context, caveats, or instructions.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			if (!DIAGRAM_URL) {
				return {
					content: [
						{
							type: "text",
							text:
								"No SWITCHBOARD_DIAGRAM_URL is set, so there is no screen to show a plan on. Describe the steps in words instead.",
						},
					],
					details: {},
					isError: true,
				};
			}
			try {
				const resp = await fetch(DIAGRAM_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						kind: "plan",
						source: "",
						items: params.items.map((item) => ({
							label: item.label,
							state: item.state ?? "todo",
							...(item.detail ? { detail: item.detail } : {}),
						})),
						title: params.title ?? "",
						notes: params.notes ?? "",
						...(SESSION_TOKEN ? { token: SESSION_TOKEN } : {}),
					}),
					signal: AbortSignal.timeout(30_000),
				});
				if (!resp.ok) {
					return {
						content: [
							{
								type: "text",
								text: await refusal(resp, "plan"),
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
					return {
						content: [
							{
								type: "text",
								text: `Nobody is looking: ${data.reason ?? "no browser connected"}. It will be there if they open the page.`,
							},
						],
						details: {},
					};
				}
				return {
					content: [{ type: "text", text: "Plan on screen." }],
					details: {},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Could not reach the switchboard to show plan: ${err}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "timeline",
		label: "Timeline",
		description:
			"Push a causal timeline or execution path to the caller's screen. Use this to show execution sequences, active operation progress, or duration metrics for multi-step causal traces.\n\n" +
			"Each item must have a `label` (short phrase) and may specify a `state` (`done`, `active`, `todo`, `blocked`), optional `detail` (monospace telemetry like paths or component names), and optional `ms` (duration in milliseconds, up to 86400000).\n\n" +
			"At most one item may be `active` at a time. Send 1 to 40 items.",
		parameters: Type.Object({
			items: Type.Array(
				Type.Object({
					label: Type.String({
						description: "The hop or phase description.",
					}),
					state: Type.Optional(
						Type.String({
							description:
								"Hop status: 'done', 'active', 'todo', or 'blocked'. Default is 'todo'.",
						}),
					),
					detail: Type.Optional(
						Type.String({
							description:
								"Monospace telemetry detail: component name, route, or status.",
						}),
					),
					ms: Type.Optional(
						Type.Number({
							description: "Duration in milliseconds for this hop (0 to 86400000).",
						}),
					),
				}),
			),
			title: Type.Optional(
				Type.String({
					description:
						"A few words naming what this timeline traces, displayed above the list.",
				}),
			),
			notes: Type.Optional(
				Type.String({
					description:
						"One optional line under the timeline for context or total latency.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			if (!DIAGRAM_URL) {
				return {
					content: [
						{
							type: "text",
							text:
								"No SWITCHBOARD_DIAGRAM_URL is set, so there is no screen to show a timeline on. Describe the timeline in words instead.",
						},
					],
					details: {},
					isError: true,
				};
			}
			try {
				const resp = await fetch(DIAGRAM_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						kind: "timeline",
						source: "",
						items: params.items.map((item) => ({
							label: item.label,
							state: item.state ?? "todo",
							...(item.detail ? { detail: item.detail } : {}),
							...(item.ms === undefined ? {} : { ms: item.ms }),
						})),
						title: params.title ?? "",
						notes: params.notes ?? "",
						...(SESSION_TOKEN ? { token: SESSION_TOKEN } : {}),
					}),
					signal: AbortSignal.timeout(30_000),
				});
				if (!resp.ok) {
					return {
						content: [
							{
								type: "text",
								text: await refusal(resp, "timeline"),
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
					return {
						content: [
							{
								type: "text",
								text: `Nobody is looking: ${data.reason ?? "no browser connected"}. It will be there if they open the page.`,
							},
						],
						details: {},
					};
				}
				return {
					content: [{ type: "text", text: "Timeline on screen." }],
					details: {},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Could not reach the switchboard to show timeline: ${err}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "diff",
		label: "Diff",
		description:
			"Show code or text changes as a unified diff on the caller's screen. Source must contain unified diff format text with at least one `@@` hunk header. Max 600 lines / 20000 bytes.",
		parameters: Type.Object({
			source: Type.String({
				description:
					"The unified diff source containing `@@` hunk headers. No Markdown code fences.",
			}),
			title: Type.Optional(
				Type.String({
					description:
						"A few words naming what this diff shows, displayed above the code.",
				}),
			),
			notes: Type.Optional(
				Type.String({
					description:
						"One optional line under the diff for context, summary, or warnings.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			if (!DIAGRAM_URL) {
				return {
					content: [
						{
							type: "text",
							text:
								"No SWITCHBOARD_DIAGRAM_URL is set, so there is no screen to show a diff on. Describe the changes in words instead.",
						},
					],
					details: {},
					isError: true,
				};
			}
			try {
				const resp = await fetch(DIAGRAM_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						kind: "diff",
						source: params.source,
						title: params.title ?? "",
						notes: params.notes ?? "",
						...(SESSION_TOKEN ? { token: SESSION_TOKEN } : {}),
					}),
					signal: AbortSignal.timeout(30_000),
				});
				if (!resp.ok) {
					return {
						content: [
							{
								type: "text",
								text: await refusal(resp, "diff"),
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
					return {
						content: [
							{
								type: "text",
								text: `Nobody is looking: ${data.reason ?? "no browser connected"}. It will be there if they open the page.`,
							},
						],
						details: {},
					};
				}
				return {
					content: [{ type: "text", text: "Diff on screen." }],
					details: {},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Could not reach the switchboard to show diff: ${err}`,
						},
					],
					details: {},
					isError: true,
				};
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
			const viewUrl = DIAGRAM_URL
				? DIAGRAM_URL.replace(/\/diagram$/, "/view")
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
					};
				};
				if (!params.target) {
					const screen = data.screen ?? {};
					let visual = "no visual";
					if (screen.has_visual) {
						visual = `${screen.stale ? "stale " : ""}${screen.visual_kind || "visual"}`;
						if (screen.title) visual += ` titled '${screen.title}'`;
					}
					const connection =
						screen.connected === false
							? "No browser is connected; last report"
							: "Screen";
					return {
						content: [
							{
								type: "text",
								text: `${connection} is in ${screen.view || "auto"} view with ${visual}.`,
							},
						],
						details: { screen },
					};
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

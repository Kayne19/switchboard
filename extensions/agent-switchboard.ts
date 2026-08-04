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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SPEAK_URL = process.env.SWITCHBOARD_SPEAK_URL ?? "";
const STATE_URL = process.env.SWITCHBOARD_STATE_URL ?? "";
const DIAGRAM_URL = process.env.SWITCHBOARD_DIAGRAM_URL ?? "";

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
				body: JSON.stringify({ thinking: pi.getThinkingLevel() }),
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
							text: "No SWITCHBOARD_SPEAK_URL is set, so nothing was spoken. Put your answer in your written reply instead — the switchboard will read it out.",
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
					body: JSON.stringify({ text: params.text }),
					signal: AbortSignal.timeout(30_000),
				});
				if (!resp.ok) {
					return {
						content: [
							{
								type: "text",
								text: `The switchboard refused that line (HTTP ${resp.status}).`,
							},
						],
						details: {},
						isError: true,
					};
				}
				const data = (await resp.json()) as { delivered?: boolean; reason?: string };
				if (data.delivered === false) {
					// Not an error — nobody has the page open. Worth telling the model so
					// it stops narrating to an empty room.
					return {
						content: [
							{
								type: "text",
								text: `Nothing was played: ${data.reason ?? "no browser connected"}. The caller cannot hear you right now.`,
							},
						],
						details: {},
					};
				}
				return { content: [{ type: "text", text: "Spoken." }], details: {} };
			} catch (err) {
				return {
					content: [{ type: "text", text: `Could not reach the switchboard to speak: ${err}` }],
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
			"`source` is Mermaid. Keep it readable: a dozen nodes is a diagram, forty is wallpaper. Labels are short phrases, not sentences.\n\n" +
			"Draw top-down (`flowchart TD`) unless the shape genuinely reads better sideways — the panel is a tall column the caller scrolls and zooms, so left-to-right graphs come out squeezed.\n\n" +
			"The page renders on a dark background with a neon palette already applied, so do not set a theme. Do colour individual nodes when colour carries meaning — `classDef hot fill:#2a0d1a,stroke:#ff2d78,color:#ffd9e6;` then `A:::hot` — and leave them alone when it does not.\n\n" +
			"Images work. HTML labels are enabled, so `A[\"<img src='https://…' width='48'/><br/>label\"]` puts a picture in a node; any URL the caller's browser can reach is fine. Newer Mermaid image and icon shapes (`A@{ img: \"https://…\", label: \"…\" }`) also work where the renderer supports them.\n\n" +
			"Each call replaces the diagram on screen. There is no history, so do not send a diagram you still need visible.",
		parameters: Type.Object({
			source: Type.String({
				description:
					"The Mermaid source, starting with its diagram type (`flowchart TD`, `sequenceDiagram`, `stateDiagram-v2`, `mindmap`, …). No fences, no surrounding prose.",
			}),
			title: Type.Optional(
				Type.String({
					description: "A few words naming what this shows, displayed above the diagram.",
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
							text: "No SWITCHBOARD_DIAGRAM_URL is set, so there is no screen to draw on. Describe the structure in words instead.",
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
					}),
					signal: AbortSignal.timeout(30_000),
				});
				if (!resp.ok) {
					return {
						content: [
							{ type: "text", text: `The switchboard refused that diagram (HTTP ${resp.status}).` },
						],
						details: {},
						isError: true,
					};
				}
				const data = (await resp.json()) as { delivered?: boolean; reason?: string };
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
					content: [{ type: "text", text: `Could not reach the switchboard to draw: ${err}` }],
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
						text: "Handing the caller back to the operator. Say a short goodbye and nothing else.",
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
			"Put the caller straight through to another project's agent, without going back through the operator. Call this when they ask to be sent somewhere else and name a project you were told exists \u2014 the connection happens the moment you call it, and the next voice they hear is that agent, so say nothing alongside this call. Pass what they want done as `intent`. If you are not sure the project exists, use `return_to_operator` instead.",
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
						"Only if the caller asked for a specific model over there. Provider first when you know it, e.g. \"anthropic/claude-sonnet-5\". Omit to use that project's usual model.",
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
						text: `Connecting the caller to ${params.project}. You are off this call now; say nothing further \u2014 anything you write here is not spoken.`,
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
						"The model to run on, provider first when you know it, e.g. \"anthropic/claude-opus-5\". Omit when only the thinking level is changing.",
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

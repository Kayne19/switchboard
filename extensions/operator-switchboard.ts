/**
 * The two top-level switchboard processes use this extension with different
 * flags. Register every tool while the factory runs, then choose the active
 * set at session_start because pi CLI flags are unavailable in the factory.
 * The conversational process gets `route`; the stateless utility gets
 * `second_opinion`, `rewrite`, and `dispatch_parts`. The backend observes
 * these calls and owns every route change.
 */

// @ts-expect-error Pi supplies these modules on the project host, not in this app's npm tree.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-expect-error Pi supplies these modules on the project host, not in this app's npm tree.
import { Type } from "typebox";

export default function operatorSwitchboard(pi: ExtensionAPI) {
	pi.registerFlag("switchboard-utility", {
		description: "Run the stateless switchboard routing utility",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: "route",
		label: "Route",
		description:
			"Send the caller's request to a registered project. Call it as soon as one project clearly fits. The request goes with the caller and the project's work picks it up at once, so say nothing alongside it.",
		parameters: Type.Object({
			target: Type.String({
				description: "The exact registered project id. Never invent one.",
			}),
			mode: Type.Optional(Type.String({
				description: "Leave out to continue where that project stopped. Use fresh only when the caller wants to start over.",
			})),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `Sent to ${params.target}. Say nothing more this turn.` }],
				details: { target: params.target, mode: params.mode ?? "continue" },
			};
		},
	});

	pi.registerTool({
		name: "second_opinion",
		label: "Second opinion",
		description:
			"Say where the caller's words should go. Give a target only when one project clearly fits.",
		parameters: Type.Object({
			target: Type.Optional(Type.String({
				description: "Exact registered project id. Leave out when the caller should be asked.",
			})),
			mode: Type.Optional(Type.String({
				description: "Leave out to continue. fresh only when the caller asks to start over.",
			})),
			confident: Type.Boolean({
				description: "True only when the project and the intent are both clear enough to act on without asking.",
			}),
			reason: Type.Optional(Type.String({
				description: "A short internal note on why.",
			})),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: "Routing opinion recorded." }],
				details: { target: params.target },
			};
		},
	});

	pi.registerTool({
		name: "rewrite",
		label: "Rewrite floor message",
		description:
			"The message as the caller should hear it next: same voice, same facts, nothing added.",
		parameters: Type.Object({
			text: Type.String({ description: "The spoken message." }),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: "Floor rewrite recorded." }],
				details: { text: params.text },
			};
		},
	});

	pi.registerTool({
		name: "dispatch_parts",
		label: "Dispatch parts",
		description:
			"Split one utterance across several registered projects, one part each, in the caller's own words.",
		parameters: Type.Object({
			parts: Type.Array(Type.Object({
				agent: Type.String({ description: "Exact registered project id." }),
				text: Type.String({ description: "The caller's words for that project." }),
			})),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: "Dispatch parts recorded." }],
				details: { count: params.parts.length },
			};
		},
	});

	pi.on("session_start", () => {
		const utility = Boolean(pi.getFlag("switchboard-utility"));
		pi.setActiveTools(utility
			? ["second_opinion", "rewrite", "dispatch_parts"]
			: ["route"]);
	});
}

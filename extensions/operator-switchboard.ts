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
			"Connect the caller to a project coding agent. Call this as soon as one project is clear; the transfer is silent and the target addresses the request immediately without a greeting.",
		parameters: Type.Object({
			target: Type.String({
				description: "The exact registered project id. Never invent one.",
			}),
			mode: Type.Optional(Type.String({
				description: "continue (the default) to bring back an agent already on the call or its conversation; fresh only when the caller asks to start over.",
			})),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `Connecting the caller to ${params.target}. Transfer is silent; say nothing further.` }],
				details: { target: params.target, mode: params.mode ?? "continue" },
			};
		},
	});

	pi.registerTool({
		name: "second_opinion",
		label: "Second opinion",
		description:
			"Give a routing opinion on the caller's utterance. Use target only when one project is clear; leave it empty when the caller should be asked to clarify.",
		parameters: Type.Object({
			target: Type.Optional(Type.String({
				description: "The exact registered project id, or omit when unclear.",
			})),
			mode: Type.Optional(Type.String({
				description: "continue (the default) for an agent already on the call or its conversation; fresh only when the caller asks to start over.",
			})),
			confident: Type.Boolean({
				description: "True only when the target and intent are clear enough to act without asking.",
			}),
			reason: Type.Optional(Type.String({
				description: "A short internal reason for the routing choice.",
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
			"Rewrite a background agent update for natural spoken delivery. Preserve every fact from the original and add none.",
		parameters: Type.Object({
			text: Type.String({ description: "A faithful, short spoken rewrite of the original message." }),
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
			"Split one caller utterance into parts for registered project agents. Keep each part in the caller's own words and use exact project ids.",
		parameters: Type.Object({
			parts: Type.Array(Type.Object({
				agent: Type.String({ description: "Exact registered project id." }),
				text: Type.String({ description: "The part addressed to that project." }),
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

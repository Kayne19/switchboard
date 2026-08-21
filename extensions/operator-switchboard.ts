/**
 * Switchboard tools for the operator leg.
 *
 * The operator is a phone operator, not an engineer: its transfer tool is the
 * only tool it has (the session runs with --no-builtin-tools). The project
 * catalog is injected into the system prompt before the session starts.
 *
 * Your own model is not one of the things that can change on this call: the
 * operator is the leg the caller lands on when a swap goes wrong, so it always
 * answers on the model it was configured with.
 *
 * Neither tool moves the caller by itself. The switchboard drives this session
 * over pi's RPC protocol and watches the `tool_execution_start` event stream, so
 * calling `transfer_to_project` *is* the transfer — this file only has to
 * acknowledge it so the model gets a sensible tool result and stops talking.
 * Keeping the decision on the switchboard side means a confused operator cannot
 * strand the caller on a leg that does not exist.
 *
 */

// @ts-expect-error Pi supplies these modules on the project host, not in this app's npm tree.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-expect-error Pi supplies these modules on the project host, not in this app's npm tree.
import { Type } from "typebox";

export default function operatorSwitchboard(pi: ExtensionAPI) {
	pi.registerTool({
		name: "transfer_to_project",
		label: "Transfer",
		description:
			"Connect the caller to a project's coding agent, in that project's working directory. Call this as soon as you know where they want to go — the transfer is silent, the target project addresses the request immediately without a greeting, and anything you write alongside this call is omitted. Pass along what they actually asked for as `intent` so the agent opens already working on it.",
		parameters: Type.Object({
			project: Type.String({
				description:
					"Which project to connect to. Use an exact id from the available project catalog when you know it; otherwise pass the caller's own words and the switchboard will match them.",
			}),
			intent: Type.Optional(
				Type.String({
					description:
						"What the caller wants done, in their terms. Omit only if they truly gave no task.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						'Only if the caller asked for a particular model on that leg. Pass it the way they said it, provider first when they gave one, e.g. "anthropic/claude-opus-5". An ambiguous name is refused and the candidates read back, so do not guess a provider. Omit for the project\'s usual model.',
				}),
			),
			thinking: Type.Optional(
				Type.String({
					description:
						"Only if they asked for a thinking or reasoning level: off, minimal, low, medium, high, xhigh or max.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			// The switchboard has already seen this call and is bringing the leg
			// up. Report success so the model finishes its turn cleanly.
			return {
				content: [
					{
						type: "text",
						text: `Connecting the caller to ${params.project}. Transfer is silent; say nothing further — anything you write here is omitted.`,
					},
				],
				details: { project: params.project },
			};
		},
	});
}

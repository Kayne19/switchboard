/**
 * Switchboard tools for the operator leg.
 *
 * The operator is a phone operator, not an engineer: these two tools are the
 * only ones it has (the session runs with --no-builtin-tools).
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
 * The project list is read from the same registry file the switchboard uses
 * (rendered by ansible/roles/damocles), so the two can never disagree.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";

const REGISTRY_PATH = process.env.SWITCHBOARD_PROJECTS_FILE ?? "/etc/switchboard/projects.json";

interface RegistryEntry {
	id: string;
	description?: string;
	aliases?: string[];
	host?: string;
	cwd?: string;
}

function loadProjects(): RegistryEntry[] {
	try {
		const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
		const entries = Array.isArray(raw) ? raw : (raw.projects ?? []);
		return entries.filter((entry: RegistryEntry) => entry && entry.id);
	} catch (err) {
		// A missing or broken registry is not fatal — the operator can still
		// talk, it just has nowhere to send anyone, and should say so.
		return [];
	}
}

export default function operatorSwitchboard(pi: ExtensionAPI) {
	pi.registerTool({
		name: "list_projects",
		label: "List projects",
		description:
			"List the projects the caller can be connected to, with what each one is and where it lives. Use this when you are not sure a project exists, or when the caller asks what is available.",
		parameters: Type.Object({}),
		async execute() {
			const projects = loadProjects();
			if (projects.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "The project registry is empty or unreadable. Tell the caller there is nowhere to connect them yet.",
						},
					],
					details: {},
				};
			}
			const lines = projects.map((p) => {
				const where = p.host ? `${p.host}:${p.cwd ?? "?"}` : (p.cwd ?? "local");
				const aliases = p.aliases?.length ? ` (also: ${p.aliases.join(", ")})` : "";
				return `- ${p.id}${aliases} — ${p.description ?? "no description"} [${where}]`;
			});
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { count: projects.length },
			};
		},
	});

	pi.registerTool({
		name: "transfer_to_project",
		label: "Transfer",
		description:
			"Connect the caller to a project's coding agent, in that project's working directory. Call this as soon as you know where they want to go — the connection happens the moment you call it, and the caller hears the agent's greeting, not you, so say nothing alongside this call. Pass along what they actually asked for as `intent` so the agent opens already working on it.",
		parameters: Type.Object({
			project: Type.String({
				description:
					"Which project to connect to. Use the project id from list_projects when you know it; otherwise pass the caller's own words and the switchboard will match them.",
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
						"Only if the caller asked for a particular model on that leg. Pass it the way they said it, provider first when they gave one, e.g. \"anthropic/claude-opus-5\". An ambiguous name is refused and the candidates read back, so do not guess a provider. Omit for the project's usual model.",
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
						text: `Connecting the caller to ${params.project}. You are off this call now; say nothing further — anything you write here is not spoken.`,
					},
				],
				details: { project: params.project },
			};
		},
	});
}

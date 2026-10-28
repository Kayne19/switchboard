import { readFileSync } from "node:fs";

export interface HostLinkFixture {
	protocol: number;
	welcome: { type: string; epoch: number; protocol: number; cursors: Record<string, string> };
	commands: Record<string, { args: Record<string, unknown>; frames: Record<string, unknown>[] }>;
	module_replies: unknown[];
}

/** The host link's frames and module replies that every peer's fake is held to (`tests/fixtures/host-link.json`). */
export function hostLinkFixture(): HostLinkFixture {
	return JSON.parse(readFileSync(new URL("../../../tests/fixtures/host-link.json", import.meta.url), "utf8")) as HostLinkFixture;
}

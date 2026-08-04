export function decodeServerMessage(text: string): BrowserMessage | null {
	try {
		const value: unknown = JSON.parse(text);
		return value !== null && typeof value === "object"
			? (value as BrowserMessage)
			: null;
	} catch {
		return null;
	}
}

export async function postJson(
	url: string,
	body: Record<string, unknown>,
): Promise<void> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

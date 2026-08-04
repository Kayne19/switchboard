export function decodeServerMessage(text) {
    try {
        const value = JSON.parse(text);
        return value !== null && typeof value === "object"
            ? value
            : null;
    }
    catch {
        return null;
    }
}
export async function postJson(url, body) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok)
        throw new Error(`HTTP ${response.status}`);
}

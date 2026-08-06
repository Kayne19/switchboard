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
/// The text frame that precedes a clip's audio frame.
///
/// `generation` is the server's turn epoch as of when this clip started
/// recording, and the server drops the clip if the epoch has moved on since.
/// That is what stops speech begun before a page transfer from being acted on
/// by the leg that replaced it, so the field has to survive every change to
/// this frame.
export function clipHeader(clip) {
    return JSON.stringify({
        type: "clip",
        id: clip.id,
        mime: clip.mime,
        generation: clip.epoch,
    });
}
export async function postJson(url, body) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok)
        throw new Error(`HTTP ${response.status}`);
    return (await response.json());
}

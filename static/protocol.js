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
export function helloMessage() {
    const mse = typeof MediaSource !== "undefined" &&
        MediaSource.isTypeSupported?.("audio/mpeg") === true;
    return JSON.stringify({
        type: "hello",
        version: 1,
        capabilities: {
            stt_streaming: true,
            audio_streaming: mse,
            mse_mp3: mse,
        },
    });
}
export function screenStateMessage(view, hasVisual, visualKind, title, stale, generation, pinned, objectIds) {
    return JSON.stringify({
        type: "screen_state",
        view,
        has_visual: hasVisual,
        visual_kind: visualKind,
        title,
        stale,
        ...(generation !== undefined ? { generation } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
        ...(objectIds !== undefined ? { object_ids: objectIds } : {}),
    });
}
export function sttStartHeader(clip) {
    return JSON.stringify({
        type: "stt_start",
        clip_id: clip.id,
        generation: clip.epoch,
        mime: clip.mime,
    });
}
export function sttChunkHeader(clip, sequence) {
    return JSON.stringify({
        type: "stt_chunk",
        clip_id: clip.id,
        generation: clip.epoch,
        sequence,
    });
}
export function sttEndHeader(clip) {
    return JSON.stringify({
        type: "stt_end",
        clip_id: clip.id,
        generation: clip.epoch,
    });
}
export function sttCancelHeader(clip) {
    return JSON.stringify({
        type: "stt_cancel",
        clip_id: clip.id,
        generation: clip.epoch,
    });
}
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

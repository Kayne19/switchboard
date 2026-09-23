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

/// The text frame that precedes a clip's audio frame.
///
/// `generation` is the server's turn epoch as of when this clip started
/// recording, and the server drops the clip if the epoch has moved on since.
/// That is what stops speech begun before a page transfer from being acted on
/// by the leg that replaced it, so the field has to survive every change to
/// this frame.
export function helloMessage(): string {
	const mse =
		typeof MediaSource !== "undefined" &&
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

export function screenStateMessage(
	view: string,
	hasVisual: boolean,
	visualKind: string | null,
	title: string,
	stale: boolean,
	generation?: number,
	pinned?: boolean,
	objectIds?: string[],
	appliedSeq?: number,
	rejected?: { seq: number; reason: string },
): string {
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
		...(appliedSeq !== undefined ? { applied_seq: appliedSeq } : {}),
		...(rejected !== undefined ? { rejected } : {}),
	});
}

export function sttStartHeader(clip: {
	id: string;
	mime: string;
	epoch: number;
}): string {
	return JSON.stringify({
		type: "stt_start",
		clip_id: clip.id,
		generation: clip.epoch,
		mime: clip.mime,
	});
}

export function sttChunkHeader(
	clip: { id: string; epoch: number },
	sequence: number,
): string {
	return JSON.stringify({
		type: "stt_chunk",
		clip_id: clip.id,
		generation: clip.epoch,
		sequence,
	});
}

export function sttEndHeader(clip: { id: string; epoch: number }): string {
	return JSON.stringify({
		type: "stt_end",
		clip_id: clip.id,
		generation: clip.epoch,
	});
}

export function sttCancelHeader(clip: { id: string; epoch: number }): string {
	return JSON.stringify({
		type: "stt_cancel",
		clip_id: clip.id,
		generation: clip.epoch,
	});
}

export function clipHeader(clip: {
	id: string;
	mime: string;
	epoch: number;
}): string {
	return JSON.stringify({
		type: "clip",
		id: clip.id,
		mime: clip.mime,
		generation: clip.epoch,
	});
}

/// A turn the caller typed instead of spoke.
///
/// It is a transcript that needs no transcription, and it carries the same
/// epoch guard as a clip: the epoch the browser held when the caller sent it.
/// The server drops it if a transfer has moved the epoch on since, and echoes
/// it back as a `transcript` frame with the same id when it is taken.
export function typedTurnMessage(turn: {
	id: string;
	epoch: number;
	text: string;
}): string {
	return JSON.stringify({
		type: "typed_turn",
		id: turn.id,
		generation: turn.epoch,
		text: turn.text,
	});
}

export async function postJson(
	url: string,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return (await response.json()) as Record<string, unknown>;
}

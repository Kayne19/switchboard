// The WebSocket protocol between the page and the service, both directions.
//
// Server to browser: every message the page can receive, one variant of
// `ServerMessage` per `type`, and `decodeServerMessage`, which admits a text
// frame only as one of them. The service's half is `ServerMessage` in
// `apps/backend/src/protocol.rs`. Both halves are held to the examples in
// `tests/fixtures/server-messages.json`: each one must decode here to exactly
// itself and serialize there to exactly itself, and a type without an example
// fails on both sides.
//
// Browser to server: the builders further down, one per command the service
// handles in `handle_text_frame`.

// --- Server to browser -----------------------------------------------------

/// One line of the call's transcript.
export interface TranscriptEntry {
	role: string;
	text: string;
	route: string;
	/** Seconds since the Unix epoch. */
	ts: number;
	/** The clip or typed turn a caller line came from. */
	id?: string;
}

/// A model the leg's host can run, from its catalog.
export interface ModelEntry {
	provider: string;
	model: string;
	thinks: boolean;
}

/// The answer to `hello`: the protocol version, and which optional transports
/// this socket uses.
export interface HelloAckMessage {
	type: "hello_ack";
	version: number;
	stt_streaming: boolean;
	audio_streaming: boolean;
	mse_mp3: boolean;
}

/// The answer to `ping`, echoing its nonce and time.
export interface PongMessage {
	type: "pong";
	nonce: string;
	time: number;
}

/// The turn epoch. Clips are stamped with it; a new one retires the old leg's
/// clips, audio, and screen.
export interface EpochMessage {
	type: "epoch";
	generation: number;
}

/// A transfer began starting a leg on `route`. Clips recorded until the next
/// `epoch` are addressed to that leg.
export interface CandidateMessage {
	type: "candidate";
	route: string;
	generation: number;
}

/// The candidate leg was adopted, rolled back, or rescued away.
export interface CandidateClearedMessage {
	type: "candidate_cleared";
	generation: number;
}

/// The line's status: who is on it, their model and thinking level, and which
/// of those the caller may change.
export interface StatusMessage {
	type: "status";
	route: string;
	/** Display name for whoever is on the line. */
	label: string;
	/** The model spec the leg was started with, thinking suffix included. */
	model: string;
	/** `provider/model`, without the thinking suffix. */
	model_name: string;
	/** The level the leg reported, else the one it was asked for. */
	thinking: string;
	thinking_requested: string;
	/** Whether the leg has reported its level. */
	thinking_confirmed: boolean;
	thinking_default: string;
	levels: string[];
	models: ModelEntry[];
	models_available: boolean;
	/** Why the catalog is unavailable, when it is. */
	models_diagnostic: string | null;
	model_swaps: boolean;
	projects: string[];
}

/// A clip was taken: whole, or opened as a stream (`streaming`).
export interface AcceptedMessage {
	type: "accepted";
	id: string;
	streaming?: boolean;
}

/// A streaming clip cannot continue as a stream; send it whole instead.
export interface AbandonedMessage {
	type: "abandoned";
	id: string;
	reason: string;
}

/// The final transcript of a clip, or the echo of a typed turn.
export interface TranscriptMessage {
	type: "transcript";
	id: string;
	text: string;
}

/// A transcript was steered into the turn in progress, or queued behind
/// `waiting` turns.
export interface QueuedMessage {
	type: "queued";
	id: string;
	waiting: number;
	steered: boolean;
}

/// Something the caller should see went wrong. `id` names the clip or typed
/// turn it answers, when there is one; `stale_epoch` means that clip was
/// recorded for a leg the call has since left.
export interface ErrorMessage {
	type: "error";
	id?: string;
	code?: "stale_epoch";
	message: string;
}

/// A turn was dispatched to the leg on `route`.
export interface ThinkingMessage {
	type: "thinking";
	route: string;
	waiting: number;
}

/// A tool call on the live leg started or ended (`state` is `start` or
/// `end`); `label` names the leg.
export interface ActivityMessage {
	type: "activity";
	state: string;
	tool: string;
	detail: string;
	label: string;
}

/// A turn settled with this written reply.
export interface ReplyMessage {
	type: "reply";
	text: string;
	route: string;
}

/// A line was spoken to the caller and kept in the transcript.
export interface SpokenMessage {
	type: "spoken";
	entry: TranscriptEntry;
}

/// The transcript so far, in every connection's snapshot.
export interface HistoryMessage {
	type: "history";
	entries: TranscriptEntry[];
}

/// An utterance of synthesized speech begins; its audio follows as binary
/// frames.
export interface AudioStartMessage {
	type: "audio_start";
	generation: number;
	sequence: number;
	mime: string;
	format: string;
}

/// The utterance `sequence` has no more audio.
export interface AudioDoneMessage {
	type: "audio_done";
	generation: number;
	sequence: number;
	done: boolean;
}

/// All audio for the reply to `response_id` has been sent; `success` is false
/// when some of it could not be synthesized.
export interface FinalResponseAudioClosedMessage {
	type: "final_response_audio_closed";
	response_id: string;
	generation: number;
	success: boolean;
}

/// A display action for the stage, with the delivery sequence the page
/// confirms it by. The action is validated separately, by
/// `controller/validation.ts`, against the display protocol.
export interface DisplayMessage {
	type: "display";
	action: unknown;
	seq?: number;
}

/// The agent asked for a view of the workspace.
export interface ViewMessage {
	type: "view";
	target: string;
	reason: string;
}

/// The page's `screen_state` report was applied.
export interface ScreenStateAckMessage {
	type: "screen_state_ack";
}

export type ServerMessage =
	| HelloAckMessage
	| PongMessage
	| EpochMessage
	| CandidateMessage
	| CandidateClearedMessage
	| StatusMessage
	| AcceptedMessage
	| AbandonedMessage
	| TranscriptMessage
	| QueuedMessage
	| ErrorMessage
	| ThinkingMessage
	| ActivityMessage
	| ReplyMessage
	| SpokenMessage
	| HistoryMessage
	| AudioStartMessage
	| AudioDoneMessage
	| FinalResponseAudioClosedMessage
	| DisplayMessage
	| ViewMessage
	| ScreenStateAckMessage;

// Readers: each takes a JSON value and returns it as the type it reads, or
// INVALID. `fields` is checked by the compiler against the interface it
// reads, so a field an interface declares cannot be left unread or read as
// the wrong type.

const INVALID = Symbol("invalid");
type Read<T> = (value: unknown) => T | typeof INVALID;
type Fields<T> = { [Field in keyof T]-?: Read<T[Field]> };

const string: Read<string> = (value) =>
	typeof value === "string" ? value : INVALID;
const number: Read<number> = (value) =>
	typeof value === "number" && Number.isFinite(value) ? value : INVALID;
const boolean: Read<boolean> = (value) =>
	typeof value === "boolean" ? value : INVALID;
/** Any value that is present; its own validation happens elsewhere. */
const present: Read<unknown> = (value) =>
	value === undefined ? INVALID : value;

function literal<T extends string>(expected: T): Read<T> {
	return (value) => (value === expected ? expected : INVALID);
}

function optional<T>(read: Read<T>): Read<T | undefined> {
	return (value) => (value === undefined ? undefined : read(value));
}

function nullable<T>(read: Read<T>): Read<T | null> {
	return (value) => (value === null ? null : read(value));
}

function list<T>(read: Read<T>): Read<T[]> {
	return (value) => {
		if (!Array.isArray(value)) return INVALID;
		const items: T[] = [];
		for (const item of value) {
			const itemValue = read(item);
			if (itemValue === INVALID) return INVALID;
			items.push(itemValue);
		}
		return items;
	};
}

/// Reads exactly the declared fields, leaving out an optional one that is
/// absent. Anything else the value carries is dropped.
function object<T>(fields: Fields<T>): Read<T> {
	return (value) => {
		if (value === null || typeof value !== "object" || Array.isArray(value))
			return INVALID;
		const source = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const field of Object.keys(fields) as Array<keyof T & string>) {
			const fieldValue = fields[field](source[field]);
			if (fieldValue === INVALID) return INVALID;
			if (fieldValue !== undefined) result[field] = fieldValue;
		}
		return result as T;
	};
}

const transcriptEntry = object<TranscriptEntry>({
	role: string,
	text: string,
	route: string,
	ts: number,
	id: optional(string),
});

const modelEntry = object<ModelEntry>({
	provider: string,
	model: string,
	thinks: boolean,
});

type MessageType = ServerMessage["type"];
type MessageFields<Type extends MessageType> = Fields<
	Omit<Extract<ServerMessage, { type: Type }>, "type">
>;

const MESSAGE_FIELDS: { [Type in MessageType]: MessageFields<Type> } = {
	hello_ack: {
		version: number,
		stt_streaming: boolean,
		audio_streaming: boolean,
		mse_mp3: boolean,
	},
	pong: { nonce: string, time: number },
	epoch: { generation: number },
	candidate: { route: string, generation: number },
	candidate_cleared: { generation: number },
	status: {
		route: string,
		label: string,
		model: string,
		model_name: string,
		thinking: string,
		thinking_requested: string,
		thinking_confirmed: boolean,
		thinking_default: string,
		levels: list(string),
		models: list(modelEntry),
		models_available: boolean,
		models_diagnostic: nullable(string),
		model_swaps: boolean,
		projects: list(string),
	},
	accepted: { id: string, streaming: optional(boolean) },
	abandoned: { id: string, reason: string },
	transcript: { id: string, text: string },
	queued: { id: string, waiting: number, steered: boolean },
	error: {
		id: optional(string),
		code: optional(literal("stale_epoch")),
		message: string,
	},
	thinking: { route: string, waiting: number },
	activity: { state: string, tool: string, detail: string, label: string },
	reply: { text: string, route: string },
	spoken: { entry: transcriptEntry },
	history: { entries: list(transcriptEntry) },
	audio_start: {
		generation: number,
		sequence: number,
		mime: string,
		format: string,
	},
	audio_done: { generation: number, sequence: number, done: boolean },
	final_response_audio_closed: {
		response_id: string,
		generation: number,
		success: boolean,
	},
	display: { action: present, seq: optional(number) },
	view: { target: string, reason: string },
	screen_state_ack: {},
};

/// Every `type` the page understands.
export const SERVER_MESSAGE_TYPES = Object.keys(
	MESSAGE_FIELDS,
) as readonly MessageType[];

/// A text frame from the service as the message it is, or null when it is not
/// one: not JSON, a type the page does not know, or a known type with a field
/// missing or of the wrong kind. Fields a message does not declare are
/// dropped.
export function decodeServerMessage(text: string): ServerMessage | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return null;
	const type = (value as { type?: unknown }).type;
	if (typeof type !== "string" || !Object.hasOwn(MESSAGE_FIELDS, type))
		return null;
	const fields = MESSAGE_FIELDS[type as MessageType] as Fields<
		Record<string, unknown>
	>;
	const read = object(fields)(value);
	return read === INVALID ? null : ({ type, ...read } as ServerMessage);
}

// --- Browser to server -----------------------------------------------------

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

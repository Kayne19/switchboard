// The debug listener's WebSocket protocol, read-only, server to browser.
//
// The Rust `DebugEvent`, `DebugRecord`, `DebugLog`, and `DebugFrame` in
// `apps/backend/src/debug.rs` are the source of truth, and
// `tests/fixtures/debug-events.json` holds one example of every event kind.
// `parseDebugFrame` admits a text frame only as one of the frames below. An
// unknown frame type or a malformed event is rejected, never guessed at; a
// numbered event of an unknown kind is kept raw, unprojected.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface AgentState {
  project: string;
  /** `busy`, `idle`, `finished`, or `waiting`. */
  state: string;
  pending_request?: { message: string; [key: string]: JsonValue };
}

export interface DebugConfig {
  jev_for_current_agent_lower: number;
  jev_for_current_agent_upper: number;
  jev_action_threshold: number;
}

export interface CallerUtteranceEvent {
  kind: 'caller_utterance';
  utterance_id: string;
  text: string;
  talking_to: string;
}
export interface JevRequestEvent {
  kind: 'jev_request';
  /** Absent for a `good_moment` request, which is keyed by `floor_id`. */
  utterance_id?: string;
  purpose: string;
  state: JsonValue;
  floor_id?: string;
}
export interface JevResponseEvent {
  kind: 'jev_response';
  /** Absent for a `good_moment` request, which is keyed by `floor_id`. */
  utterance_id?: string;
  purpose: string;
  latency_ms: number;
  outcome: string;
  answers: JsonValue;
  error?: string;
  floor_id?: string;
}
export interface RouteDecisionEvent {
  kind: 'route_decision';
  utterance_id: string;
  rule: string;
  reason: string;
  action: string;
  target?: string;
  mode: string;
  decided_by: string;
}
export interface PbxBranchEvent {
  kind: 'pbx_branch';
  utterance_id: string;
  branch: string;
  reason: string;
}
export interface UtilityRequestEvent {
  kind: 'utility_request';
  utterance_id: string;
  attempt: string;
  prompt: string;
}
export interface UtilityDecisionEvent {
  kind: 'utility_decision';
  utterance_id: string;
  attempt: string;
  decision: JsonValue;
  latency_ms: number;
}
export interface OperatorHopEvent {
  kind: 'operator_hop';
  utterance_id: string;
  text: string;
  outcome: string;
}
export interface OperatorRouteToolEvent {
  kind: 'operator_route_tool';
  utterance_id: string;
  target: string;
  mode: string;
  action: string;
}
export interface RoutedEvent {
  kind: 'routed';
  utterance_id: string;
  to_agent: string;
  text_part: string;
  mode: string;
  via: string;
}
export interface AgentInputEvent {
  kind: 'agent_input';
  agent: string;
  turn_id?: string;
  text: string;
  source: string;
  utterance_id?: string;
}
export interface AgentTextEvent {
  kind: 'agent_text';
  agent: string;
  turn_id?: string;
  text: string;
  final: boolean;
}
export interface ToolStartEvent {
  kind: 'tool_start';
  agent: string;
  call_id?: string;
  tool: string;
  args?: JsonValue;
  turn_id?: string;
}
export interface ToolEndEvent {
  kind: 'tool_end';
  agent: string;
  call_id?: string;
  tool: string;
  result?: JsonValue;
  error?: string;
  turn_id?: string;
}
export interface ModuleCallEvent {
  kind: 'module_call';
  agent: string;
  call_id: string;
  name: string;
  args: JsonValue;
  turn_id?: string;
}
export interface ModuleResultEvent {
  kind: 'module_result';
  agent: string;
  call_id: string;
  ok: boolean;
  detail: JsonValue;
}
export interface TurnStartEvent {
  kind: 'turn_start';
  agent: string;
  turn_id: string;
  generation: number;
  utterance_id?: string;
}
export interface TurnEndEvent {
  kind: 'turn_end';
  agent: string;
  turn_id: string;
  generation: number;
  utterance_id?: string;
}
export interface RescueEvent {
  kind: 'rescue';
  generation: number;
  reason: string;
  leg?: string;
}
export interface SpeechEvent {
  kind: 'speech';
  agent: string;
  text: string;
  delivered: boolean;
  reason?: string;
  /** Set on speech released from the floor: the message it delivers. */
  floor_id?: string;
}
export interface FloorRequestEvent {
  kind: 'floor_request';
  agent: string;
  message: string;
  floor_id?: string;
}
export interface FloorHeldEvent {
  kind: 'floor_held';
  agent: string;
  message: string;
  floor_id?: string;
}
export interface FloorGateEvent {
  kind: 'floor_gate';
  agent: string;
  answer: string;
  latency_ms: number;
  floor_id?: string;
}
export interface FloorRewriteEvent {
  kind: 'floor_rewrite';
  agent: string;
  original: string;
  rewritten: string;
  latency_ms: number;
  floor_id?: string;
}
export interface FloorReleasedEvent {
  kind: 'floor_released';
  agent: string;
  how: string;
  floor_id?: string;
}
export interface AgentsStateEvent {
  kind: 'agents_state';
  agents: AgentState[];
}
export interface HostLinkEvent {
  kind: 'host_link';
  host: string;
  connected: boolean;
}
export interface CallBoundaryEvent {
  kind: 'call_boundary';
  phase: string;
  call_id: string;
  reason?: string;
}

export type DebugEvent =
  | CallerUtteranceEvent
  | JevRequestEvent
  | JevResponseEvent
  | RouteDecisionEvent
  | PbxBranchEvent
  | UtilityRequestEvent
  | UtilityDecisionEvent
  | OperatorHopEvent
  | OperatorRouteToolEvent
  | RoutedEvent
  | AgentInputEvent
  | AgentTextEvent
  | ToolStartEvent
  | ToolEndEvent
  | ModuleCallEvent
  | ModuleResultEvent
  | TurnStartEvent
  | TurnEndEvent
  | RescueEvent
  | SpeechEvent
  | FloorRequestEvent
  | FloorHeldEvent
  | FloorGateEvent
  | FloorRewriteEvent
  | FloorReleasedEvent
  | AgentsStateEvent
  | HostLinkEvent
  | CallBoundaryEvent;

export type DebugEventKind = DebugEvent['kind'];

/**
 * A numbered event: the ring's and the live stream's unit. `clipped` is true
 * when the service cut a field to the record bounds (the cut text ends with
 * `…[clipped]`); it is absent otherwise.
 */
export type DebugRecord = DebugEvent & { seq: number; timestamp_ms: number; clipped?: boolean };

export interface DebugLog {
  seq: number;
  timestamp_ms: number;
  level: string;
  target: string;
  message: string;
  fields: { [key: string]: JsonValue };
  /** True when the service cut the message or a field to the record bounds. */
  clipped?: boolean;
}

export interface SnapshotFrame {
  type: 'snapshot';
  events: DebugRecord[];
  logs: DebugLog[];
  agents: AgentState[];
  config: DebugConfig;
  /** The newest seq the snapshot covers; live frames at or below it are stale. Optional. */
  last_seq?: number;
  /** Parsed only: snapshot events of kinds this page does not know. */
  unknown?: UnknownEventFrame[];
}
export type EventFrame = { type: 'event' } & DebugRecord;
export type LogFrame = { type: 'log' } & DebugLog;
/**
 * A well-numbered event of a kind this page does not know, from a newer
 * backend. It keeps its place in the seq stream and shows in the raw view,
 * but nothing is projected from it.
 */
export interface UnknownEventFrame {
  type: 'unknown_event';
  seq: number;
  timestamp_ms: number;
  kind: string;
  raw: { [key: string]: JsonValue };
}
export type DebugFrame = SnapshotFrame | EventFrame | LogFrame | UnknownEventFrame;

// --- Parsing ---------------------------------------------------------------

type FieldType = 'string' | 'number' | 'boolean' | 'json' | 'agents';
type FieldSpec = Record<string, FieldType | `${FieldType}?`>;

/** Every event kind and its fields, as the Rust enum serializes them. */
export const EVENT_FIELDS: Record<DebugEventKind, FieldSpec> = {
  caller_utterance: { utterance_id: 'string', text: 'string', talking_to: 'string' },
  jev_request: { utterance_id: 'string?', purpose: 'string', state: 'json', floor_id: 'string?' },
  jev_response: { utterance_id: 'string?', purpose: 'string', latency_ms: 'number', outcome: 'string', answers: 'json', error: 'string?', floor_id: 'string?' },
  route_decision: { utterance_id: 'string', rule: 'string', reason: 'string', action: 'string', target: 'string?', mode: 'string', decided_by: 'string' },
  pbx_branch: { utterance_id: 'string', branch: 'string', reason: 'string' },
  utility_request: { utterance_id: 'string', attempt: 'string', prompt: 'string' },
  utility_decision: { utterance_id: 'string', attempt: 'string', decision: 'json', latency_ms: 'number' },
  operator_hop: { utterance_id: 'string', text: 'string', outcome: 'string' },
  operator_route_tool: { utterance_id: 'string', target: 'string', mode: 'string', action: 'string' },
  routed: { utterance_id: 'string', to_agent: 'string', text_part: 'string', mode: 'string', via: 'string' },
  agent_input: { agent: 'string', turn_id: 'string?', text: 'string', source: 'string', utterance_id: 'string?' },
  agent_text: { agent: 'string', turn_id: 'string?', text: 'string', final: 'boolean' },
  tool_start: { agent: 'string', call_id: 'string?', tool: 'string', args: 'json?', turn_id: 'string?' },
  tool_end: { agent: 'string', call_id: 'string?', tool: 'string', result: 'json?', error: 'string?', turn_id: 'string?' },
  module_call: { agent: 'string', call_id: 'string', name: 'string', args: 'json', turn_id: 'string?' },
  module_result: { agent: 'string', call_id: 'string', ok: 'boolean', detail: 'json' },
  turn_start: { agent: 'string', turn_id: 'string', generation: 'number', utterance_id: 'string?' },
  turn_end: { agent: 'string', turn_id: 'string', generation: 'number', utterance_id: 'string?' },
  rescue: { generation: 'number', reason: 'string', leg: 'string?' },
  speech: { agent: 'string', text: 'string', delivered: 'boolean', reason: 'string?', floor_id: 'string?' },
  floor_request: { agent: 'string', message: 'string', floor_id: 'string?' },
  floor_held: { agent: 'string', message: 'string', floor_id: 'string?' },
  floor_gate: { agent: 'string', answer: 'string', latency_ms: 'number', floor_id: 'string?' },
  floor_rewrite: { agent: 'string', original: 'string', rewritten: 'string', latency_ms: 'number', floor_id: 'string?' },
  floor_released: { agent: 'string', how: 'string', floor_id: 'string?' },
  agents_state: { agents: 'agents' },
  host_link: { host: 'string', connected: 'boolean' },
  call_boundary: { phase: 'string', call_id: 'string', reason: 'string?' },
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function checkField(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'json':
      return value !== undefined;
    case 'agents':
      return Array.isArray(value) && value.every(isAgentState);
  }
}

function isAgentState(value: unknown): value is AgentState {
  return isObject(value) && typeof value.project === 'string' && typeof value.state === 'string';
}

function checkNumbered(value: Record<string, unknown>): string | null {
  if (typeof value.seq !== 'number' || !Number.isInteger(value.seq)) return 'seq is not an integer';
  if (typeof value.timestamp_ms !== 'number' || !Number.isFinite(value.timestamp_ms)) return 'timestamp_ms is not a number';
  return null;
}

/** Validate one event body (`kind` plus fields), numbered or not. */
export function parseDebugEvent(value: unknown): ParseResult<DebugEvent> {
  if (!isObject(value)) return { ok: false, error: 'event is not an object' };
  const kind = value.kind;
  if (typeof kind !== 'string' || !Object.hasOwn(EVENT_FIELDS, kind)) {
    return { ok: false, error: `unknown event kind ${JSON.stringify(kind)}` };
  }
  const spec = EVENT_FIELDS[kind as DebugEventKind];
  for (const [name, declared] of Object.entries(spec)) {
    const optional = declared.endsWith('?');
    const type = (optional ? declared.slice(0, -1) : declared) as FieldType;
    const field = value[name];
    if (field === undefined || (optional && field === null)) {
      if (optional) continue;
      return { ok: false, error: `${kind}.${name} is missing` };
    }
    if (!checkField(field, type)) return { ok: false, error: `${kind}.${name} is not ${type}` };
  }
  return { ok: true, value: value as unknown as DebugEvent };
}

export function parseDebugRecord(value: unknown): ParseResult<DebugRecord> {
  if (!isObject(value)) return { ok: false, error: 'record is not an object' };
  const numbered = checkNumbered(value);
  if (numbered) return { ok: false, error: numbered };
  const event = parseDebugEvent(value);
  if (!event.ok) return event;
  return { ok: true, value: value as unknown as DebugRecord };
}

export function parseDebugLog(value: unknown): ParseResult<DebugLog> {
  if (!isObject(value)) return { ok: false, error: 'log is not an object' };
  const numbered = checkNumbered(value);
  if (numbered) return { ok: false, error: numbered };
  for (const name of ['level', 'target', 'message'] as const) {
    if (typeof value[name] !== 'string') return { ok: false, error: `log.${name} is not a string` };
  }
  const fields = value.fields === undefined || value.fields === null ? {} : value.fields;
  if (!isObject(fields)) return { ok: false, error: 'log.fields is not an object' };
  return { ok: true, value: { ...(value as unknown as DebugLog), fields: fields as DebugLog['fields'] } };
}

function parseConfig(value: unknown): DebugConfig | null {
  if (!isObject(value)) return null;
  const keys = ['jev_for_current_agent_lower', 'jev_for_current_agent_upper', 'jev_action_threshold'] as const;
  if (!keys.every((key) => typeof value[key] === 'number')) return null;
  return value as unknown as DebugConfig;
}

/** A snapshot keeps every well-formed entry; malformed ones are counted. */
export interface ParsedFrame {
  frame: DebugFrame;
  /** Entries dropped from a snapshot because they did not parse. */
  skipped: string[];
}

/**
 * Admit one WebSocket text frame (or an already-decoded value). A frame of an
 * unknown type, or a live event of an unknown kind, is rejected whole. A
 * snapshot is admitted with its malformed entries skipped and reported, so one
 * event from a newer backend cannot blank the page.
 */
export function parseDebugFrame(input: unknown): ParseResult<ParsedFrame> {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, error: 'frame is not JSON' };
    }
  }
  if (!isObject(value)) return { ok: false, error: 'frame is not an object' };
  switch (value.type) {
    case 'event': {
      if (typeof value.kind === 'string' && !Object.hasOwn(EVENT_FIELDS, value.kind) && checkNumbered(value) === null) {
        const { type: _type, ...raw } = value;
        const frame: UnknownEventFrame = {
          type: 'unknown_event',
          seq: value.seq as number,
          timestamp_ms: value.timestamp_ms as number,
          kind: value.kind,
          raw: raw as UnknownEventFrame['raw'],
        };
        return { ok: true, value: { frame, skipped: [] } };
      }
      const record = parseDebugRecord(value);
      if (!record.ok) return record;
      const { type: _type, ...rest } = value;
      return { ok: true, value: { frame: { type: 'event', ...(rest as unknown as DebugRecord) }, skipped: [] } };
    }
    case 'log': {
      const log = parseDebugLog(value);
      if (!log.ok) return log;
      const { type: _type, ...rest } = log.value as DebugLog & { type?: string };
      return { ok: true, value: { frame: { type: 'log', ...rest }, skipped: [] } };
    }
    case 'snapshot': {
      const config = parseConfig(value.config);
      if (!config) return { ok: false, error: 'snapshot.config is malformed' };
      if (!Array.isArray(value.events) || !Array.isArray(value.logs)) {
        return { ok: false, error: 'snapshot events or logs are not arrays' };
      }
      const skipped: string[] = [];
      const events: DebugRecord[] = [];
      const unknown: UnknownEventFrame[] = [];
      for (const entry of value.events) {
        if (isObject(entry) && typeof entry.kind === 'string' && !Object.hasOwn(EVENT_FIELDS, entry.kind) && checkNumbered(entry) === null) {
          unknown.push({
            type: 'unknown_event',
            seq: entry.seq as number,
            timestamp_ms: entry.timestamp_ms as number,
            kind: entry.kind,
            raw: entry as UnknownEventFrame['raw'],
          });
          continue;
        }
        const record = parseDebugRecord(entry);
        if (record.ok) events.push(record.value);
        else skipped.push(record.error);
      }
      const logs: DebugLog[] = [];
      for (const entry of value.logs) {
        const log = parseDebugLog(entry);
        if (log.ok) logs.push(log.value);
        else skipped.push(log.error);
      }
      const agents = Array.isArray(value.agents) ? value.agents.filter(isAgentState) : [];
      const frame: SnapshotFrame = { type: 'snapshot', events, logs, agents, config };
      if (unknown.length > 0) frame.unknown = unknown;
      if (typeof value.last_seq === 'number' && Number.isInteger(value.last_seq)) frame.last_seq = value.last_seq;
      return { ok: true, value: { frame, skipped } };
    }
    default:
      return { ok: false, error: `unknown frame type ${JSON.stringify(value.type)}` };
  }
}

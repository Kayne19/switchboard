// The debug page's view model: one pure reducer from debug frames to view
// state. A snapshot replaces the whole projection (the backend also sends one
// after a slow client lags); live frames are folded in seq order, with
// duplicates dropped and gaps remembered so the connection can resync.
import type {
  AgentState,
  DebugConfig,
  DebugFrame,
  DebugLog,
  DebugRecord,
  JevRequestEvent,
  JevResponseEvent,
  JsonValue,
  OperatorHopEvent,
  OperatorRouteToolEvent,
  PbxBranchEvent,
  RouteDecisionEvent,
  RoutedEvent,
  UtilityDecisionEvent,
  UtilityRequestEvent,
  FloorGateEvent,
  FloorRewriteEvent,
  FloorReleasedEvent,
  SpeechEvent,
  UnknownEventFrame,
} from './protocol';

type Numbered<T> = T & { seq: number; timestamp_ms: number };

export const LIMITS = {
  events: 4000,
  logs: 2000,
  traces: 600,
  paneItems: 1500,
  callerItems: 1500,
  turns: 2000,
  floors: 300,
  unknown: 200,
  missing: 1000,
} as const;

/** The two always-present agents; project agents follow in order seen. */
export const OPERATOR = 'operator';
export const UTILITY = 'utility';

export interface UtilityAttempt {
  attempt: string;
  request?: Numbered<UtilityRequestEvent>;
  decision?: Numbered<UtilityDecisionEvent>;
}

/** Every hop one caller utterance took, keyed by its `utterance_id`. */
export interface RouteTrace {
  id: string;
  firstSeq: number;
  firstTs: number;
  lastTs: number;
  text?: string;
  talkingTo?: string;
  jevRequest?: Numbered<JevRequestEvent>;
  jevResponse?: Numbered<JevResponseEvent>;
  decision?: Numbered<RouteDecisionEvent>;
  branch?: Numbered<PbxBranchEvent>;
  utility: UtilityAttempt[];
  operatorHop?: Numbered<OperatorHopEvent>;
  operatorTool?: Numbered<OperatorRouteToolEvent>;
  routed: Numbered<RoutedEvent>[];
  records: DebugRecord[];
}

/** One `request_to_speak` on its way back to the caller. */
export interface FloorTrace {
  id: string;
  agent: string;
  message: string;
  firstSeq: number;
  firstTs: number;
  lastTs: number;
  requested: boolean;
  heldTs?: number;
  gates: Numbered<FloorGateEvent>[];
  jev: DebugRecord[];
  rewrite?: Numbered<FloorRewriteEvent>;
  released?: Numbered<FloorReleasedEvent>;
  speech?: Numbered<SpeechEvent>;
  records: DebugRecord[];
}

export type PaneItem =
  | { type: 'input'; seq: number; ts: number; turnId?: string; text: string; source: string; utteranceId?: string; clipped?: boolean }
  | {
      type: 'text';
      seq: number;
      ts: number;
      turnId?: string;
      text: string;
      final: boolean;
      parts: number;
      /** A piece the turn's final reply has since replaced; shown dimmed. */
      superseded?: boolean;
      /** The service cut this text to the record bounds. */
      clipped?: boolean;
    }
  | {
      type: 'tool';
      seq: number;
      ts: number;
      endTs?: number;
      callId?: string;
      tool: string;
      args?: JsonValue;
      result?: JsonValue;
      error?: string;
      status: 'running' | 'ok' | 'error';
      /** The service cut the call's args, result or error to the record bounds. */
      clipped?: boolean;
    }
  | {
      type: 'module';
      seq: number;
      ts: number;
      endTs?: number;
      callId: string;
      name: string;
      args: JsonValue;
      ok?: boolean;
      detail?: JsonValue;
      /** The service cut the call's args or answer to the record bounds. */
      clipped?: boolean;
    }
  | { type: 'turn'; seq: number; ts: number; turnId: string; generation: number; edge: 'start' | 'end'; startTs?: number }
  | { type: 'speech'; seq: number; ts: number; text: string; delivered: boolean; reason?: string }
  | { type: 'routed'; seq: number; ts: number; utteranceId: string; textPart: string; mode: string; via: string }
  | { type: 'floor'; seq: number; ts: number; floorId: string; message: string }
  | { type: 'rescue'; seq: number; ts: number; generation: number; reason: string }
  | {
      /** A utility routing attempt or floor rewrite, mirrored into its pane. */
      type: 'utility';
      seq: number;
      ts: number;
      purpose: 'route' | 'rewrite';
      utteranceId?: string;
      attempt: string;
      prompt?: string;
      decision?: JsonValue;
      latencyMs?: number;
      done: boolean;
    };

export interface AgentPane {
  agent: string;
  items: PaneItem[];
  firstSeq: number;
  lastTs: number;
  openTurn?: string;
  tools: number;
}

export type CallerItem =
  | { type: 'utterance'; seq: number; ts: number; traceId: string }
  | { type: 'floor'; seq: number; ts: number; floorId: string }
  | { type: 'speech'; seq: number; ts: number; agent: string; text: string; delivered: boolean; reason?: string }
  | { type: 'call'; seq: number; ts: number; callId: string; phase: string; reason?: string };

export interface TurnSpan {
  agent: string;
  turnId: string;
  generation: number;
  startSeq: number;
  startTs: number;
  endTs?: number;
  utteranceId?: string;
}

export interface CallSpan {
  callId: string;
  startTs?: number;
  endTs?: number;
  reason?: string;
}

export interface HostState {
  host: string;
  connected: boolean;
  sinceTs: number;
  flips: { ts: number; connected: boolean }[];
}

export interface DebugState {
  config: DebugConfig | null;
  /** Highest seq seen, events and logs share one sequence space. */
  maxSeq: number;
  /** Seqs skipped over by a live frame and not yet seen. */
  missing: number[];
  gaps: number;
  resyncs: number;
  rejected: number;
  lastRejection?: string;
  events: DebugRecord[];
  logs: DebugLog[];
  traces: Record<string, RouteTrace>;
  traceOrder: string[];
  callerLane: CallerItem[];
  panes: Record<string, AgentPane>;
  paneOrder: string[];
  turns: TurnSpan[];
  rescues: Numbered<{ generation: number; reason: string; leg?: string }>[];
  floors: Record<string, FloorTrace>;
  floorOrder: string[];
  agents: AgentState[];
  hosts: Record<string, HostState>;
  calls: CallSpan[];
  /** Events of kinds this page does not know, kept for the raw view. */
  unknown: UnknownEventFrame[];
}

export function initialDebugState(): DebugState {
  const panes: Record<string, AgentPane> = {};
  for (const agent of [OPERATOR, UTILITY]) panes[agent] = { agent, items: [], firstSeq: 0, lastTs: 0, tools: 0 };
  return {
    config: null,
    maxSeq: 0,
    missing: [],
    gaps: 0,
    resyncs: 0,
    rejected: 0,
    events: [],
    logs: [],
    traces: {},
    traceOrder: [],
    callerLane: [],
    panes,
    paneOrder: [OPERATOR, UTILITY],
    turns: [],
    rescues: [],
    floors: {},
    floorOrder: [],
    agents: [],
    hosts: {},
    calls: [],
    unknown: [],
  };
}

// --- Copy on write ---------------------------------------------------------

// A batch of frames copies each container it touches once, then mutates the
// copy; a snapshot fold starts from fresh containers and so mutates in place.
// Nothing reachable from the previous state is ever written.
class Draft {
  private owned = new WeakSet<object>();
  readonly state: DebugState;

  constructor(previous: DebugState) {
    this.state = this.fresh({ ...previous });
  }

  fresh<T extends object>(value: T): T {
    this.owned.add(value);
    return value;
  }

  /** The child at `parent[key]`, copied first unless this batch owns it. */
  own<P extends object, K extends keyof P>(parent: P, key: K): P[K] {
    const child = parent[key] as unknown as object;
    if (this.owned.has(child)) return parent[key];
    const copy = (Array.isArray(child) ? child.slice() : { ...child }) as P[K];
    this.owned.add(copy as unknown as object);
    parent[key] = copy;
    return copy;
  }
}

function trimFront<T>(items: T[], limit: number): T[] {
  // Trim in steps so a full ring costs one splice per tenth, not per frame.
  return items.length > limit + Math.ceil(limit / 10) ? items.slice(items.length - limit) : items;
}

// --- Reducer ---------------------------------------------------------------

export function reduceFrame(state: DebugState, frame: DebugFrame): DebugState {
  return reduceFrames(state, [frame]);
}

export function reduceFrames(state: DebugState, frames: readonly DebugFrame[]): DebugState {
  if (frames.length === 0) return state;
  let draft = new Draft(state);
  for (const frame of frames) {
    if (frame.type === 'snapshot') {
      draft = applySnapshot(draft.state, frame);
      continue;
    }
    if (!admitSeq(draft, frame.seq)) continue;
    if (frame.type === 'unknown_event') {
      const unknown = draft.own(draft.state, 'unknown');
      unknown.push(frame);
      draft.state.unknown = trimFront(unknown, LIMITS.unknown);
    } else if (frame.type === 'log') {
      const { type: _type, ...log } = frame;
      const logs = draft.own(draft.state, 'logs');
      logs.push(log);
      draft.state.logs = trimFront(logs, LIMITS.logs);
    } else {
      const { type: _type, ...record } = frame;
      applyEvent(draft, record as DebugRecord);
    }
  }
  return draft.state;
}

/** Record a frame the parser refused; the page shows the count. */
export function noteRejected(state: DebugState, error: string): DebugState {
  return { ...state, rejected: state.rejected + 1, lastRejection: error };
}

function applySnapshot(previous: DebugState, frame: Extract<DebugFrame, { type: 'snapshot' }>): Draft {
  const base = initialDebugState();
  // The first snapshot is the connection; every later one is a resync.
  base.resyncs = previous.config === null ? previous.resyncs : previous.resyncs + 1;
  base.rejected = previous.rejected;
  base.lastRejection = previous.lastRejection;
  base.gaps = previous.gaps;
  const draft = new Draft(base);
  const state = draft.state;
  for (const key of [
    'events',
    'logs',
    'traces',
    'traceOrder',
    'callerLane',
    'panes',
    'paneOrder',
    'turns',
    'rescues',
    'floors',
    'floorOrder',
    'hosts',
    'calls',
    'unknown',
  ] as const) {
    draft.own(state, key);
  }
  for (const agent of state.paneOrder) draft.own(state.panes, agent);
  state.config = frame.config;
  state.agents = frame.agents;
  for (const agent of frame.agents) ensurePane(draft, agent.project, 0, 0);
  const merged: ({ log: DebugLog } | { event: DebugRecord })[] = [...frame.events.map((event) => ({ event })), ...frame.logs.map((log) => ({ log }))];
  merged.sort((a, b) => ('event' in a ? a.event.seq : a.log.seq) - ('event' in b ? b.event.seq : b.log.seq));
  for (const entry of merged) {
    if ('log' in entry) {
      state.logs.push(entry.log);
      state.maxSeq = Math.max(state.maxSeq, entry.log.seq);
    } else {
      state.maxSeq = Math.max(state.maxSeq, entry.event.seq);
      applyEvent(draft, entry.event);
    }
  }
  for (const unknown of frame.unknown ?? []) {
    state.unknown.push(unknown);
    state.maxSeq = Math.max(state.maxSeq, unknown.seq);
  }
  state.unknown = trimFront(state.unknown, LIMITS.unknown);
  if (frame.last_seq !== undefined) state.maxSeq = Math.max(state.maxSeq, frame.last_seq);
  // The two rings evict at different rates, so holes inside a snapshot are
  // expected; only gaps in the live stream after it count.
  state.missing = [];
  return draft;
}

/** Drop duplicates, note skipped seqs, and admit late arrivals of those. */
function admitSeq(draft: Draft, seq: number): boolean {
  const state = draft.state;
  if (seq <= state.maxSeq) {
    const index = state.missing.indexOf(seq);
    if (index < 0) return false;
    draft.own(state, 'missing').splice(index, 1);
    return true;
  }
  if (state.maxSeq > 0 && seq > state.maxSeq + 1) {
    const missing = draft.own(state, 'missing');
    for (let skipped = state.maxSeq + 1; skipped < seq && missing.length < LIMITS.missing; skipped += 1) missing.push(skipped);
    state.gaps += 1;
  }
  state.maxSeq = seq;
  return true;
}

function ensurePane(draft: Draft, agent: string, seq: number, ts: number): AgentPane {
  const state = draft.state;
  const panes = draft.own(state, 'panes');
  if (!panes[agent]) {
    panes[agent] = draft.fresh({ agent, items: draft.fresh([] as PaneItem[]), firstSeq: seq, lastTs: ts, tools: 0 });
    draft.own(state, 'paneOrder').push(agent);
    return panes[agent];
  }
  const pane = draft.own(panes, agent);
  if (ts > pane.lastTs) pane.lastTs = ts;
  return pane;
}

function paneItems(draft: Draft, pane: AgentPane): PaneItem[] {
  return draft.own(pane, 'items');
}

function pushPaneItem(draft: Draft, pane: AgentPane, item: PaneItem): void {
  const items = paneItems(draft, pane);
  items.push(item);
  pane.items = trimFront(items, LIMITS.paneItems);
}

/** Find a pane item from the end, and copy it for writing. */
function ownPaneItem<T extends PaneItem>(draft: Draft, pane: AgentPane, match: (item: PaneItem) => item is T, depth = 400): T | undefined {
  const items = pane.items;
  for (let index = items.length - 1; index >= 0 && index >= items.length - depth; index -= 1) {
    if (match(items[index])) {
      const owned = paneItems(draft, pane);
      return draft.own(owned, index) as T;
    }
  }
  return undefined;
}

function ensureTrace(draft: Draft, record: DebugRecord & { utterance_id: string }): RouteTrace {
  const state = draft.state;
  const traces = draft.own(state, 'traces');
  const id = record.utterance_id;
  let trace = traces[id];
  if (!trace) {
    trace = draft.fresh({
      id,
      firstSeq: record.seq,
      firstTs: record.timestamp_ms,
      lastTs: record.timestamp_ms,
      utility: draft.fresh([]),
      routed: draft.fresh([]),
      records: draft.fresh([]),
    });
    traces[id] = trace;
    const order = draft.own(state, 'traceOrder');
    order.push(id);
    if (order.length > LIMITS.traces + LIMITS.traces / 10) {
      const dropped = order.splice(0, order.length - LIMITS.traces);
      for (const old of dropped) delete traces[old];
    }
    pushCaller(draft, { type: 'utterance', seq: record.seq, ts: record.timestamp_ms, traceId: id });
    return trace;
  }
  trace = draft.own(traces, id);
  trace.lastTs = Math.max(trace.lastTs, record.timestamp_ms);
  return trace;
}

function pushCaller(draft: Draft, item: CallerItem): void {
  const lane = draft.own(draft.state, 'callerLane');
  lane.push(item);
  draft.state.callerLane = trimFront(lane, LIMITS.callerItems);
}

function ownFloor(draft: Draft, id: string): FloorTrace | undefined {
  return draft.state.floors[id] ? draft.own(draft.own(draft.state, 'floors'), id) : undefined;
}

/** The agent's open floor message: by `floor_id` when the event has one. */
function openFloor(draft: Draft, agent: string, floorId?: string): FloorTrace | undefined {
  if (floorId !== undefined) return ownFloor(draft, floorId);
  const state = draft.state;
  for (let index = state.floorOrder.length - 1; index >= 0; index -= 1) {
    const floor = state.floors[state.floorOrder[index]];
    if (floor.agent === agent && !floor.released) return draft.own(draft.own(state, 'floors'), floor.id);
  }
  return undefined;
}

function newFloor(draft: Draft, record: DebugRecord, agent: string, message: string, floorId?: string): FloorTrace {
  const state = draft.state;
  const id = floorId ?? `floor-${record.seq}`;
  const floor: FloorTrace = draft.fresh({
    id,
    agent,
    message,
    firstSeq: record.seq,
    firstTs: record.timestamp_ms,
    lastTs: record.timestamp_ms,
    requested: false,
    gates: draft.fresh([]),
    jev: draft.fresh([]),
    records: draft.fresh([]),
  });
  const floors = draft.own(state, 'floors');
  floors[id] = floor;
  const order = draft.own(state, 'floorOrder');
  order.push(id);
  if (order.length > LIMITS.floors + LIMITS.floors / 10) {
    for (const old of order.splice(0, order.length - LIMITS.floors)) delete floors[old];
  }
  pushCaller(draft, { type: 'floor', seq: record.seq, ts: record.timestamp_ms, floorId: id });
  pushPaneItem(draft, ensurePane(draft, agent, record.seq, record.timestamp_ms), {
    type: 'floor',
    seq: record.seq,
    ts: record.timestamp_ms,
    floorId: id,
    message,
  });
  return floor;
}

function touchFloor(draft: Draft, floor: FloorTrace, record: DebugRecord): void {
  draft.own(floor, 'records').push(record);
  floor.lastTs = Math.max(floor.lastTs, record.timestamp_ms);
}

/** The newest floor still waiting on Jev's good-moment answer. */
function floorAwaitingGate(draft: Draft, floorId?: string): FloorTrace | undefined {
  if (floorId !== undefined) return ownFloor(draft, floorId);
  const state = draft.state;
  for (let index = state.floorOrder.length - 1; index >= 0; index -= 1) {
    const floor = state.floors[state.floorOrder[index]];
    if (!floor.released) return draft.own(draft.own(state, 'floors'), floor.id);
  }
  return undefined;
}

function applyEvent(draft: Draft, record: DebugRecord): void {
  const state = draft.state;
  const events = draft.own(state, 'events');
  events.push(record);
  state.events = trimFront(events, LIMITS.events);
  const seq = record.seq;
  const ts = record.timestamp_ms;

  switch (record.kind) {
    case 'caller_utterance': {
      const trace = ensureTrace(draft, record);
      draft.own(trace, 'records').push(record);
      trace.text = record.text;
      trace.talkingTo = record.talking_to;
      return;
    }
    case 'jev_request':
    case 'jev_response': {
      if (record.purpose !== 'route') {
        const floor = floorAwaitingGate(draft, record.floor_id);
        if (floor) {
          draft.own(floor, 'jev').push(record);
          touchFloor(draft, floor, record);
        }
        return;
      }
      // A route call always names its utterance; one without is malformed.
      if (record.utterance_id === undefined) return;
      const trace = ensureTrace(draft, { ...record, utterance_id: record.utterance_id });
      draft.own(trace, 'records').push(record);
      if (record.kind === 'jev_request') trace.jevRequest = record;
      else trace.jevResponse = record;
      return;
    }
    case 'route_decision':
    case 'pbx_branch':
    case 'operator_hop':
    case 'operator_route_tool': {
      const trace = ensureTrace(draft, record);
      draft.own(trace, 'records').push(record);
      if (record.kind === 'route_decision') trace.decision = record;
      else if (record.kind === 'pbx_branch') trace.branch = record;
      else if (record.kind === 'operator_hop') trace.operatorHop = record;
      else trace.operatorTool = record;
      return;
    }
    case 'utility_request':
    case 'utility_decision': {
      const trace = ensureTrace(draft, record);
      draft.own(trace, 'records').push(record);
      const attempts = draft.own(trace, 'utility');
      let index = -1;
      for (let i = attempts.length - 1; i >= 0; i -= 1) {
        const open = record.kind === 'utility_request' ? !attempts[i].request : !attempts[i].decision;
        if (attempts[i].attempt === record.attempt && open) {
          index = i;
          break;
        }
      }
      if (index < 0) {
        attempts.push(draft.fresh({ attempt: record.attempt }));
        index = attempts.length - 1;
      }
      const attempt = draft.own(attempts, index);
      if (record.kind === 'utility_request') attempt.request = record;
      else attempt.decision = record;
      mirrorUtility(draft, record);
      return;
    }
    case 'routed': {
      const trace = ensureTrace(draft, record);
      draft.own(trace, 'records').push(record);
      draft.own(trace, 'routed').push(record);
      const pane = ensurePane(draft, record.to_agent, seq, ts);
      pushPaneItem(draft, pane, { type: 'routed', seq, ts, utteranceId: record.utterance_id, textPart: record.text_part, mode: record.mode, via: record.via });
      return;
    }
    case 'agent_input': {
      const pane = ensurePane(draft, record.agent, seq, ts);
      pushPaneItem(draft, pane, {
        type: 'input',
        seq,
        ts,
        turnId: record.turn_id,
        text: record.text,
        source: record.source,
        utteranceId: record.utterance_id,
        clipped: clippedFlag(record),
      });
      return;
    }
    case 'agent_text': {
      const pane = ensurePane(draft, record.agent, seq, ts);
      const last = pane.items[pane.items.length - 1];
      // Non-final frames are pieces to append; a final frame is the turn's
      // whole reply and replaces its pieces.
      if (last && last.type === 'text' && !last.final && last.turnId === record.turn_id) {
        const pieces = record.final && record.turn_id !== undefined ? countPieces(pane, record.turn_id) : 1;
        if (pieces <= 1) {
          const item = draft.own(paneItems(draft, pane), pane.items.length - 1) as Extract<PaneItem, { type: 'text' }>;
          if (record.final) item.text = record.text || item.text;
          else item.text += record.text;
          if (record.final) item.clipped = clippedFlag(record);
          else if (record.clipped) item.clipped = true;
          item.final = record.final;
          item.parts += 1;
          return;
        }
      }
      if (record.final && record.turn_id !== undefined) supersedePieces(draft, pane, record.turn_id);
      pushPaneItem(draft, pane, { type: 'text', seq, ts, turnId: record.turn_id, text: record.text, final: record.final, parts: 1, clipped: clippedFlag(record) });
      return;
    }
    case 'tool_start': {
      const pane = ensurePane(draft, record.agent, seq, ts);
      pane.tools += 1;
      pushPaneItem(draft, pane, { type: 'tool', seq, ts, callId: record.call_id, tool: record.tool, args: record.args, status: 'running', clipped: clippedFlag(record) });
      return;
    }
    case 'tool_end': {
      const pane = ensurePane(draft, record.agent, seq, ts);
      const matchTool = (item: PaneItem): item is Extract<PaneItem, { type: 'tool' }> =>
        item.type === 'tool' && item.status === 'running' && (record.call_id ? item.callId === record.call_id : item.tool === record.tool);
      const item = ownPaneItem(draft, pane, matchTool);
      const status = record.error ? 'error' : 'ok';
      if (item) {
        item.result = record.result;
        item.error = record.error;
        item.status = status;
        item.endTs = ts;
        if (record.clipped) item.clipped = true;
      } else {
        pushPaneItem(draft, pane, {
          type: 'tool',
          seq,
          ts,
          endTs: ts,
          callId: record.call_id,
          tool: record.tool,
          result: record.result,
          error: record.error,
          status,
          clipped: clippedFlag(record),
        });
      }
      return;
    }
    case 'module_call': {
      const pane = ensurePane(draft, record.agent, seq, ts);
      pushPaneItem(draft, pane, { type: 'module', seq, ts, callId: record.call_id, name: record.name, args: record.args, clipped: clippedFlag(record) });
      return;
    }
    case 'module_result': {
      const pane = ensurePane(draft, record.agent, seq, ts);
      const item = ownPaneItem(
        draft,
        pane,
        (candidate): candidate is Extract<PaneItem, { type: 'module' }> => candidate.type === 'module' && candidate.callId === record.call_id,
      );
      if (item) {
        item.ok = record.ok;
        item.detail = record.detail;
        item.endTs = ts;
        if (record.clipped) item.clipped = true;
      } else {
        pushPaneItem(draft, pane, {
          type: 'module',
          seq,
          ts,
          endTs: ts,
          callId: record.call_id,
          name: '(result)',
          args: null,
          ok: record.ok,
          detail: record.detail,
          clipped: clippedFlag(record),
        });
      }
      return;
    }
    case 'turn_start': {
      const pane = ensurePane(draft, record.agent, seq, ts);
      pane.openTurn = record.turn_id;
      pushPaneItem(draft, pane, { type: 'turn', seq, ts, turnId: record.turn_id, generation: record.generation, edge: 'start' });
      const turns = draft.own(state, 'turns');
      turns.push({ agent: record.agent, turnId: record.turn_id, generation: record.generation, startSeq: seq, startTs: ts, utteranceId: record.utterance_id });
      state.turns = trimFront(turns, LIMITS.turns);
      return;
    }
    case 'turn_end': {
      const pane = ensurePane(draft, record.agent, seq, ts);
      if (pane.openTurn === record.turn_id) pane.openTurn = undefined;
      let startTs: number | undefined;
      const turns = state.turns;
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index];
        if (turn.agent === record.agent && turn.turnId === record.turn_id && turn.endTs === undefined) {
          const owned = draft.own(draft.own(state, 'turns'), index);
          owned.endTs = ts;
          startTs = owned.startTs;
          break;
        }
      }
      pushPaneItem(draft, pane, { type: 'turn', seq, ts, turnId: record.turn_id, generation: record.generation, edge: 'end', startTs });
      return;
    }
    case 'rescue': {
      draft.own(state, 'rescues').push(record);
      if (record.leg) {
        const pane = ensurePane(draft, record.leg, seq, ts);
        pushPaneItem(draft, pane, { type: 'rescue', seq, ts, generation: record.generation, reason: record.reason });
      }
      return;
    }
    case 'speech': {
      const pane = ensurePane(draft, record.agent, seq, ts);
      pushPaneItem(draft, pane, { type: 'speech', seq, ts, text: record.text, delivered: record.delivered, reason: record.reason });
      const floor = latestFloorAwaitingSpeech(draft, record.agent, record.text, ts);
      if (floor) {
        floor.speech = record;
        touchFloor(draft, floor, record);
        return;
      }
      pushCaller(draft, { type: 'speech', seq, ts, agent: record.agent, text: record.text, delivered: record.delivered, reason: record.reason });
      return;
    }
    case 'floor_request': {
      const existing = record.floor_id !== undefined ? ownFloor(draft, record.floor_id) : undefined;
      const floor = existing ?? newFloor(draft, record, record.agent, record.message, record.floor_id);
      floor.requested = true;
      touchFloor(draft, floor, record);
      return;
    }
    case 'floor_held': {
      let floor = openFloor(draft, record.agent, record.floor_id);
      if (!floor || (record.floor_id === undefined && floor.heldTs !== undefined))
        floor = newFloor(draft, record, record.agent, record.message, record.floor_id);
      floor.heldTs = ts;
      touchFloor(draft, floor, record);
      return;
    }
    case 'floor_gate':
    case 'floor_rewrite':
    case 'floor_released': {
      const floor = openFloor(draft, record.agent, record.floor_id) ?? newFloor(draft, record, record.agent, '', record.floor_id);
      if (record.kind === 'floor_gate') draft.own(floor, 'gates').push(record);
      else if (record.kind === 'floor_rewrite') {
        floor.rewrite = record;
        pushPaneItem(draft, ensurePane(draft, UTILITY, seq, ts), {
          type: 'utility',
          seq,
          ts,
          purpose: 'rewrite',
          attempt: `floor rewrite for ${record.agent}`,
          prompt: record.original,
          decision: record.rewritten,
          latencyMs: record.latency_ms,
          done: true,
        });
      } else floor.released = record;
      touchFloor(draft, floor, record);
      return;
    }
    case 'agents_state': {
      state.agents = record.agents;
      for (const agent of record.agents) ensurePane(draft, agent.project, seq, ts);
      return;
    }
    case 'call_boundary': {
      const calls = draft.own(state, 'calls');
      let index = calls.findIndex((call) => call.callId === record.call_id);
      if (index < 0) {
        calls.push({ callId: record.call_id });
        index = calls.length - 1;
      }
      const call = draft.own(calls, index);
      if (record.phase === 'ended') {
        call.endTs = ts;
        call.reason = record.reason;
      } else {
        call.startTs = ts;
      }
      if (calls.length > 60) state.calls = calls.slice(-50);
      pushCaller(draft, { type: 'call', seq, ts, callId: record.call_id, phase: record.phase, reason: record.reason });
      return;
    }
    case 'host_link': {
      const hosts = draft.own(state, 'hosts');
      const previous = hosts[record.host];
      const flips = previous ? [...previous.flips, { ts, connected: record.connected }].slice(-50) : [{ ts, connected: record.connected }];
      hosts[record.host] = {
        host: record.host,
        connected: record.connected,
        sinceTs: previous && previous.connected === record.connected ? previous.sinceTs : ts,
        flips,
      };
      return;
    }
  }
}

const PIECE_SCAN = 200;

function countPieces(pane: AgentPane, turnId: string): number {
  let count = 0;
  for (let index = pane.items.length - 1; index >= 0 && index >= pane.items.length - PIECE_SCAN; index -= 1) {
    const item = pane.items[index];
    if (item.type === 'text' && item.turnId === turnId && !item.final) count += 1;
  }
  return count;
}

/** `true` when the service cut a field of `record`; absent otherwise. */
function clippedFlag(record: DebugRecord): true | undefined {
  return record.clipped === true ? true : undefined;
}

function supersedePieces(draft: Draft, pane: AgentPane, turnId: string): void {
  for (let index = pane.items.length - 1; index >= 0 && index >= pane.items.length - PIECE_SCAN; index -= 1) {
    const item = pane.items[index];
    if (item.type === 'text' && item.turnId === turnId && !item.final && !item.superseded) {
      (draft.own(paneItems(draft, pane), index) as Extract<PaneItem, { type: 'text' }>).superseded = true;
    }
  }
}

/** Show each utility routing attempt in the utility pane, request then answer. */
function mirrorUtility(draft: Draft, record: Numbered<UtilityRequestEvent> | Numbered<UtilityDecisionEvent>): void {
  const pane = ensurePane(draft, UTILITY, record.seq, record.timestamp_ms);
  if (record.kind === 'utility_decision') {
    const item = ownPaneItem(
      draft,
      pane,
      (candidate): candidate is Extract<PaneItem, { type: 'utility' }> =>
        candidate.type === 'utility' && !candidate.done && candidate.utteranceId === record.utterance_id && candidate.attempt === record.attempt,
    );
    if (item) {
      item.decision = record.decision;
      item.latencyMs = record.latency_ms;
      item.done = true;
      return;
    }
  }
  pushPaneItem(draft, pane, {
    type: 'utility',
    seq: record.seq,
    ts: record.timestamp_ms,
    purpose: 'route',
    utteranceId: record.utterance_id,
    attempt: record.attempt,
    prompt: record.kind === 'utility_request' ? record.prompt : undefined,
    decision: record.kind === 'utility_decision' ? record.decision : undefined,
    latencyMs: record.kind === 'utility_decision' ? record.latency_ms : undefined,
    done: record.kind === 'utility_decision',
  });
}

/**
 * The floor message a speech line delivers: the same text as its rewrite or
 * message, or the first line within a few seconds of its release.
 */
function latestFloorAwaitingSpeech(draft: Draft, agent: string, text: string, ts: number): FloorTrace | undefined {
  const state = draft.state;
  for (let index = state.floorOrder.length - 1; index >= 0; index -= 1) {
    const floor = state.floors[state.floorOrder[index]];
    if (floor.agent !== agent) continue;
    if (floor.speech) return undefined;
    const sameText = text === floor.rewrite?.rewritten || text === floor.message;
    const justReleased = floor.released !== undefined && ts - floor.released.timestamp_ms <= 3_000;
    if (!sameText && !justReleased) return undefined;
    return draft.own(draft.own(state, 'floors'), floor.id);
  }
  return undefined;
}

// --- Route paths -----------------------------------------------------------

export type Stage = 'jev' | 'utility' | 'operator';

export interface RouteSegment {
  from: 'caller' | Stage;
  to: Stage;
  label: string;
}

export interface RouteDestination {
  agent: string;
  from: 'caller' | Stage;
  label: string;
  via: string;
  mode: string;
  textPart: string;
  /** The `routed` seq; the pane anchors its line there. Absent if implied. */
  seq?: number;
}

export interface RoutePath {
  stages: Stage[];
  segments: RouteSegment[];
  destinations: RouteDestination[];
  /** No destination yet: the line ends at the last stage reached. */
  pending: boolean;
}

const STAGE_OF: Partial<Record<DebugRecord['kind'], Stage>> = {
  jev_request: 'jev',
  jev_response: 'jev',
  route_decision: 'jev',
  utility_request: 'utility',
  utility_decision: 'utility',
  operator_hop: 'operator',
  operator_route_tool: 'operator',
};

export function decisionKind(decision: JsonValue | undefined): string {
  if (decision && typeof decision === 'object' && !Array.isArray(decision) && typeof decision.kind === 'string') return decision.kind;
  return 'unknown';
}

function attemptLabel(attempt: UtilityAttempt | undefined): string {
  if (!attempt?.decision) return attempt ? `${attempt.attempt}…` : '';
  const decision = attempt.decision.decision;
  const kind = decisionKind(decision);
  if (kind === 'second_opinion' && decision && typeof decision === 'object' && !Array.isArray(decision) && decision.confident === false) {
    return 'second_opinion · unsure';
  }
  return kind;
}

/** The hops one utterance actually took, in the order it took them. */
export function routePath(trace: RouteTrace): RoutePath {
  // Walk the trace in seq order: each new stage remembers the PBX branch and
  // the utility answer that sent the utterance there.
  const visits: { stage: Stage; branch?: string; attempt?: UtilityAttempt }[] = [];
  let branch: string | undefined;
  let attempt: UtilityAttempt | undefined;
  for (const record of trace.records) {
    if (record.kind === 'pbx_branch') branch = record.branch;
    if (record.kind === 'utility_decision') attempt = trace.utility.find((entry) => entry.decision?.seq === record.seq);
    const stage = STAGE_OF[record.kind];
    if (stage && visits[visits.length - 1]?.stage !== stage) visits.push({ stage, branch, attempt });
  }
  const stages = visits.map((visit) => visit.stage);
  const segments: RouteSegment[] = [];
  let from: 'caller' | Stage = 'caller';
  for (const visit of visits) {
    let label = '';
    if (from === 'caller') {
      // The Jev node shows its own latency; the wire only flags a failure.
      const response = trace.jevResponse;
      label = visit.stage === 'jev' && response && response.outcome !== 'ok' ? response.outcome : '';
    } else if (from === 'jev') {
      label = visit.branch ?? trace.decision?.rule ?? '';
    } else if (from === 'utility') {
      label = attemptLabel(visit.attempt);
    } else {
      label = trace.operatorHop?.outcome ?? '';
    }
    segments.push({ from, to: visit.stage, label });
    from = visit.stage;
  }
  const last: 'caller' | Stage = stages[stages.length - 1] ?? 'caller';
  const sourceFor = (via: string): 'caller' | Stage => {
    const wanted: Stage | null = via === 'utility' ? 'utility' : via === 'operator' ? 'operator' : via === 'jev' || via === 'pbx' ? 'jev' : null;
    if (wanted && stages.includes(wanted)) {
      // A destination leaves from the latest stage that sent it, so a line
      // never runs backward past a hop the utterance already took.
      return wanted === 'jev' && via === 'pbx' ? last : wanted;
    }
    return last;
  };
  const destinations: RouteDestination[] = trace.routed.map((routed) => ({
    agent: routed.to_agent,
    from: sourceFor(routed.via),
    label: trace.routed.length > 1 ? `part · ${routed.mode}` : `${routed.via === 'pbx' && trace.branch ? trace.branch.branch : routed.via} · ${routed.mode}`,
    via: routed.via,
    mode: routed.mode,
    textPart: routed.text_part,
    seq: routed.seq,
  }));
  if (destinations.length === 0 && trace.operatorHop && trace.operatorHop.outcome !== 'route_tool') {
    destinations.push({ agent: OPERATOR, from: 'operator', label: trace.operatorHop.outcome, via: 'operator', mode: '', textPart: trace.operatorHop.text });
  }
  return { stages, segments, destinations, pending: destinations.length === 0 };
}

/** The newest route trace, the one the page animates. */
export function newestTraceId(state: DebugState): string | undefined {
  return state.traceOrder[state.traceOrder.length - 1];
}

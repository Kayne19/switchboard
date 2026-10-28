import type {
  DiagramData,
  DiagramEdge,
  DiagramNode,
  DiagramObjectData,
  SequenceActor,
  SequenceDiagramData,
  SequenceMessage,
} from '../types';
import { SEMANTICS, STEP_STATES, checkItemId, checkString, checkUnknownKeys, copyFrameText, copyOptionalBoolean, copyOptionalName, copyOptionalString, invalidName, isRecord } from './shared';

const DIAGRAM_MODES = ['graph', 'sequence'] as const;
const MESSAGE_KINDS: readonly NonNullable<SequenceMessage['kind']>[] = ['call', 'return', 'async'];

// The two diagram modes are told apart by `mode` before anything else is
// read, so a graph payload is judged by the graph rules and a sequence
// payload by the sequence rules; each refuses the other's arrays by name.
export function validateDiagramData(data: Record<string, unknown>): { ok: true; data: DiagramObjectData } | { ok: false; error: string } {
  if ('source' in data) {
    return { ok: false, error: 'diagram data source field is forbidden in v1' };
  }
  switch (data.mode) {
    case 'graph':
      return validateGraphDiagramData(data);
    case 'sequence':
      return validateSequenceDiagramData(data);
    default:
      return { ok: false, error: invalidName('diagram.mode', DIAGRAM_MODES) };
  }
}

function validateGraphDiagramData(data: Record<string, unknown>): { ok: true; data: DiagramData } | { ok: false; error: string } {
  if ('actors' in data || 'messages' in data) {
    return { ok: false, error: 'diagram.actors and diagram.messages belong to mode "sequence"' };
  }
  const allowed = new Set(['title', 'subtitle', 'context', 'caption', 'mode', 'nodes', 'edges']);
  const unknownKey = checkUnknownKeys(data, allowed, 'diagram data');
  if (unknownKey) return { ok: false, error: unknownKey };

  if (!Array.isArray(data.nodes) || data.nodes.length < 1 || data.nodes.length > 100) {
    return { ok: false, error: 'diagram.nodes must be an array of 1 to 100 items' };
  }
  if (!Array.isArray(data.edges) || data.edges.length > 200) {
    return { ok: false, error: 'diagram.edges must be an array of at most 200 items' };
  }

  const nodeAllowed = new Set(['id', 'label', 'sub', 'detail', 'semantic', 'state']);
  const nodeIds = new Set<string>();
  const nodes: DiagramNode[] = [];

  for (const n of data.nodes) {
    if (!isRecord(n)) return { ok: false, error: 'diagram node must be an object' };
    const nUnknown = checkUnknownKeys(n, nodeAllowed, 'diagram node');
    if (nUnknown) return { ok: false, error: nUnknown };

    const id = checkItemId(n.id, nodeIds, 'diagram node');
    if (!id.ok) return id;

    const labelErr = checkString(n.label, 256, 'diagram node.label');
    if (labelErr) return { ok: false, error: labelErr };

    const nodeItem: DiagramNode = { id: id.id, label: n.label as string };
    const err =
      copyOptionalString(n, nodeItem, 'sub', 256, 'diagram node.sub') ??
      copyOptionalString(n, nodeItem, 'detail', 256, 'diagram node.detail') ??
      copyOptionalName(n, nodeItem, 'semantic', SEMANTICS, 'diagram node.semantic') ??
      copyOptionalName(n, nodeItem, 'state', STEP_STATES, 'diagram node.state');
    if (err) return { ok: false, error: err };
    nodes.push(nodeItem);
  }

  const edgeAllowed = new Set(['from', 'to', 'label', 'semantic', 'active']);
  const edgePairs = new Set<string>();
  const edges: DiagramEdge[] = [];

  for (const e of data.edges) {
    if (!isRecord(e)) return { ok: false, error: 'diagram edge must be an object' };
    const eUnknown = checkUnknownKeys(e, edgeAllowed, 'diagram edge');
    if (eUnknown) return { ok: false, error: eUnknown };

    if (typeof e.from !== 'string' || typeof e.to !== 'string') {
      return { ok: false, error: 'diagram edge from and to must be strings' };
    }
    if (!nodeIds.has(e.from)) {
      return { ok: false, error: `diagram edge from endpoint "${e.from}" not found in nodes` };
    }
    if (!nodeIds.has(e.to)) {
      return { ok: false, error: `diagram edge to endpoint "${e.to}" not found in nodes` };
    }
    if (e.from === e.to) {
      return { ok: false, error: `diagram edge self-loop is forbidden: ${e.from}` };
    }
    // JSON keeps the two ids apart whatever they contain: `a-->b` to `c`
    // and `a` to `b-->c` are two pairs, as the backend's tuple keeps them.
    const pairKey = JSON.stringify([e.from, e.to]);
    if (edgePairs.has(pairKey)) {
      return { ok: false, error: `duplicate diagram edge pair: ${e.from} -> ${e.to}` };
    }
    edgePairs.add(pairKey);

    const edgeItem: DiagramEdge = { from: e.from, to: e.to };
    const err =
      copyOptionalString(e, edgeItem, 'label', 256, 'diagram edge.label') ??
      copyOptionalName(e, edgeItem, 'semantic', SEMANTICS, 'diagram edge.semantic') ??
      copyOptionalBoolean(e, edgeItem, 'active', 'diagram edge.active');
    if (err) return { ok: false, error: err };
    edges.push(edgeItem);
  }

  const result: DiagramData = {
    mode: 'graph',
    nodes,
    edges,
  };
  const err = copyFrameText(data, result, 'diagram');
  if (err) return { ok: false, error: err };
  return { ok: true, data: result };
}

function validateSequenceDiagramData(data: Record<string, unknown>): { ok: true; data: SequenceDiagramData } | { ok: false; error: string } {
  if ('nodes' in data || 'edges' in data) {
    return { ok: false, error: 'diagram.nodes and diagram.edges belong to mode "graph"' };
  }
  const allowed = new Set(['title', 'subtitle', 'context', 'caption', 'mode', 'actors', 'messages']);
  const unknownKey = checkUnknownKeys(data, allowed, 'diagram data');
  if (unknownKey) return { ok: false, error: unknownKey };

  if (!Array.isArray(data.actors) || data.actors.length < 1 || data.actors.length > 12) {
    return { ok: false, error: 'diagram.actors must be an array of 1 to 12 items' };
  }
  if (!Array.isArray(data.messages) || data.messages.length > 100) {
    return { ok: false, error: 'diagram.messages must be an array of at most 100 items' };
  }

  const actorAllowed = new Set(['id', 'label', 'sub', 'semantic']);
  const actorIds = new Set<string>();
  const actors: SequenceActor[] = [];

  for (const a of data.actors) {
    if (!isRecord(a)) return { ok: false, error: 'diagram actor must be an object' };
    const aUnknown = checkUnknownKeys(a, actorAllowed, 'diagram actor');
    if (aUnknown) return { ok: false, error: aUnknown };

    const id = checkItemId(a.id, actorIds, 'diagram actor');
    if (!id.ok) return id;

    const labelErr = checkString(a.label, 256, 'diagram actor.label');
    if (labelErr) return { ok: false, error: labelErr };

    const actorItem: SequenceActor = { id: id.id, label: a.label as string };
    const err =
      copyOptionalString(a, actorItem, 'sub', 256, 'diagram actor.sub') ??
      copyOptionalName(a, actorItem, 'semantic', SEMANTICS, 'diagram actor.semantic');
    if (err) return { ok: false, error: err };
    actors.push(actorItem);
  }

  const messageAllowed = new Set(['from', 'to', 'label', 'kind', 'active']);
  const messages: SequenceMessage[] = [];

  // A self-message and a repeated pair are both ordinary in a sequence, so
  // unlike graph edges neither is refused.
  for (const m of data.messages) {
    if (!isRecord(m)) return { ok: false, error: 'diagram message must be an object' };
    const mUnknown = checkUnknownKeys(m, messageAllowed, 'diagram message');
    if (mUnknown) return { ok: false, error: mUnknown };

    if (typeof m.from !== 'string' || typeof m.to !== 'string') {
      return { ok: false, error: 'diagram message from and to must be strings' };
    }
    if (!actorIds.has(m.from)) {
      return { ok: false, error: `diagram message from endpoint "${m.from}" not found in actors` };
    }
    if (!actorIds.has(m.to)) {
      return { ok: false, error: `diagram message to endpoint "${m.to}" not found in actors` };
    }
    const labelErr = checkString(m.label, 256, 'diagram message.label');
    if (labelErr) return { ok: false, error: labelErr };

    const messageItem: SequenceMessage = { from: m.from, to: m.to, label: m.label as string };
    const err =
      copyOptionalName(m, messageItem, 'kind', MESSAGE_KINDS, 'diagram message.kind') ??
      copyOptionalBoolean(m, messageItem, 'active', 'diagram message.active');
    if (err) return { ok: false, error: err };
    messages.push(messageItem);
  }

  const result: SequenceDiagramData = {
    mode: 'sequence',
    actors,
    messages,
  };
  const err = copyFrameText(data, result, 'diagram');
  if (err) return { ok: false, error: err };
  return { ok: true, data: result };
}

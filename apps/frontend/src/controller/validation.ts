import type {
  ChartData,
  ChartKind,
  ChartSeries,
  CodeData,
  DiagramData,
  DiagramEdge,
  DiagramNode,
  DiagramObjectData,
  DisplayAction,
  DocumentData,
  ImageData,
  ImageFormat,
  MetricData,
  MetricTrend,
  NoteData,
  ProgressData,
  ProgressStep,
  ProgressStepState,
  RichSegment,
  SceneObjectRole,
  Semantic,
  SequenceActor,
  SequenceDiagramData,
  SequenceMessage,
  SpeechState,
  TableCell,
  TableColumn,
  TableData,
} from './types';

/**
 * Progress values arrive as a percentage (0–100). Values outside
 * 0–100 are clamped to [0, 100], and rounded to two decimal places.
 */
export function normalizeProgressValue(value: number): number {
  const bounded = Math.min(100, Math.max(0, value));
  return Math.round(bounded * 100) / 100;
}

const ALLOWED_OPERATIONS = new Set(['show', 'hide', 'say', 'focus', 'clear']);
const ALLOWED_OBJECT_TYPES = new Set([
  'chart',
  'metric',
  'progress',
  'diagram',
  'document',
  'code',
  'table',
  'note',
  'image',
]);
const ALLOWED_ROLES = new Set<SceneObjectRole>(['primary', 'compare', 'secondary', 'ambient']);
const ALLOWED_SEMANTICS = new Set<Semantic>([
  'red',
  'orange',
  'green',
  'cyan',
  'amber',
  'paper',
  'muted',
]);

const CHART_KINDS = new Set<ChartKind>(['line', 'bar', 'area', 'scatter']);
const MAX_CHART_LABELS = 100;
const MAX_CHART_LABEL_UTF16 = 64;

const MAX_ID_UTF16 = 128;
const MAX_TEXT_UTF16 = 50_000;
const MAX_ACTION_BYTES = 48_000;
/**
 * An image action carries raster bytes, so it gets its own cap: the raw
 * image is at most 8 MiB, and the action around its base64 at most 12 MiB.
 * Every other type keeps the 48,000-byte cap. Both socket links allow
 * 16 MiB frames, so one image action always fits one frame; the reconnect
 * snapshot replays each action as its own frame for the same reason.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_ACTION_BYTES = 12 * 1024 * 1024;
const RESERVED_ID_PREFIX = '__runtime/';
const MAX_PROGRESS_STEPS = 30;
const MAX_METRIC_DELTA_UTF16 = 32;
const METRIC_TRENDS = new Set<MetricTrend>(['up', 'down', 'flat']);
const PROGRESS_STEP_STATES = new Set<ProgressStepState>(['done', 'active', 'todo', 'blocked']);

const FORBIDDEN_LAYOUT_KEYS = new Set([
  'layout',
  'style',
  'css',
  'className',
  'width',
  'height',
  'left',
  'right',
  'top',
  'bottom',
]);

const HTML_JS_PATTERNS = [
  /<script/i,
  /<iframe/i,
  /<html/i,
  /<style/i,
  /<svg/i,
  /<object/i,
  /<embed/i,
  /javascript:/i,
  /data:text\/html/i,
];

const EXTERNAL_URL_REGEX = /(?:https?:\/\/|ftp:\/\/|^\/\/|\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;

export type ActionValidationResult =
  | { ok: true; action: DisplayAction }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializedSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function checkIdentifier(val: unknown, fieldName: string): { ok: true; id: string } | { ok: false; error: string } {
  if (typeof val !== 'string' || val.trim().length === 0) {
    return { ok: false, error: `${fieldName} must be a non-empty identifier` };
  }
  if (val.length > MAX_ID_UTF16) {
    return { ok: false, error: `${fieldName} exceeds maximum length of ${MAX_ID_UTF16} UTF-16 code units` };
  }
  if (val.startsWith(RESERVED_ID_PREFIX)) {
    return { ok: false, error: `reserved identifier namespace: ${val}` };
  }
  return { ok: true, id: val };
}

function findForbiddenLayoutKey(val: unknown): string | null {
  if (Array.isArray(val)) {
    for (const item of val) {
      const found = findForbiddenLayoutKey(item);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(val)) {
    for (const [key, nested] of Object.entries(val)) {
      if (FORBIDDEN_LAYOUT_KEYS.has(key)) return key;
      const found = findForbiddenLayoutKey(nested);
      if (found) return found;
    }
  }
  return null;
}

function findUnsafeString(val: unknown): string | null {
  if (typeof val === 'string') {
    for (const pattern of HTML_JS_PATTERNS) {
      if (pattern.test(val)) return `raw markup or script injection is forbidden`;
    }
    if (EXTERNAL_URL_REGEX.test(val)) {
      return `external resource URL is forbidden`;
    }
    return null;
  }
  if (Array.isArray(val)) {
    for (const item of val) {
      const found = findUnsafeString(item);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(val)) {
    for (const nested of Object.values(val)) {
      const found = findUnsafeString(nested);
      if (found) return found;
    }
  }
  return null;
}

function hasNonFiniteNumber(val: unknown): boolean {
  if (typeof val === 'number') {
    return !Number.isFinite(val);
  }
  if (Array.isArray(val)) {
    return val.some(hasNonFiniteNumber);
  }
  if (isRecord(val)) {
    return Object.values(val).some(hasNonFiniteNumber);
  }
  return false;
}

function checkUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>, context: string): string | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return `unknown field in ${context}: ${key}`;
    }
  }
  return null;
}

function checkString(val: unknown, maxLen: number, name: string): string | null {
  if (typeof val !== 'string') return `${name} must be a string`;
  if (val.length > maxLen) return `${name} exceeds maximum length of ${maxLen} UTF-16 code units`;
  return null;
}

function validateChartData(data: Record<string, unknown>): { ok: true; data: ChartData } | { ok: false; error: string } {
  const allowed = new Set(['title', 'subtitle', 'context', 'caption', 'kind', 'labels', 'xLabel', 'yLabel', 'xMax', 'yMin', 'yMax', 'series', 'marker', 'compareLabel']);
  const unknownKey = checkUnknownKeys(data, allowed, 'chart data');
  if (unknownKey) return { ok: false, error: unknownKey };

  if (data.kind !== undefined && !CHART_KINDS.has(data.kind as ChartKind)) {
    return { ok: false, error: 'invalid chart.kind' };
  }
  let labels: string[] | undefined;
  if (data.labels !== undefined) {
    if (!Array.isArray(data.labels) || data.labels.length < 1 || data.labels.length > MAX_CHART_LABELS) {
      return { ok: false, error: `chart.labels must be an array of 1 to ${MAX_CHART_LABELS} strings` };
    }
    for (const label of data.labels) {
      const err = checkString(label, MAX_CHART_LABEL_UTF16, 'chart label');
      if (err) return { ok: false, error: err };
    }
    labels = data.labels as string[];
  }

  if (!Array.isArray(data.series)) {
    return { ok: false, error: 'chart.series must be an array' };
  }
  const seriesList: ChartSeries[] = [];
  const seriesAllowed = new Set(['name', 'semantic', 'values']);
  for (const s of data.series) {
    if (!isRecord(s)) return { ok: false, error: 'chart series item must be an object' };
    const sUnknown = checkUnknownKeys(s, seriesAllowed, 'chart series item');
    if (sUnknown) return { ok: false, error: sUnknown };
    const nameErr = checkString(s.name, 128, 'series.name');
    if (nameErr) return { ok: false, error: nameErr };
    if (!Array.isArray(s.values)) return { ok: false, error: 'series.values must be an array' };
    for (const v of s.values) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: 'series.values must contain finite numbers' };
    }
    if (labels && s.values.length > labels.length) {
      return { ok: false, error: 'series.values is longer than chart.labels' };
    }
    if (s.semantic !== undefined && !ALLOWED_SEMANTICS.has(s.semantic as Semantic)) {
      return { ok: false, error: 'invalid series.semantic' };
    }
    seriesList.push({
      name: s.name as string,
      values: s.values as number[],
      ...(s.semantic !== undefined ? { semantic: s.semantic as Semantic } : {}),
    });
  }

  const result: ChartData = { series: seriesList };
  if (data.kind !== undefined) result.kind = data.kind as ChartKind;
  if (labels) result.labels = labels;
  for (const k of ['title', 'subtitle', 'context'] as const) {
    if (data[k] !== undefined) {
      const err = checkString(data[k], 256, `chart.${k}`);
      if (err) return { ok: false, error: err };
      result[k] = data[k] as string;
    }
  }
  for (const k of ['caption', 'xLabel', 'yLabel', 'compareLabel'] as const) {
    if (data[k] !== undefined) {
      const err = checkString(data[k], 128, `chart.${k}`);
      if (err) return { ok: false, error: err };
      result[k] = data[k] as string;
    }
  }
  for (const k of ['xMax', 'yMin', 'yMax'] as const) {
    if (data[k] !== undefined) {
      if (typeof data[k] !== 'number' || !Number.isFinite(data[k])) {
        return { ok: false, error: `chart.${k} must be a finite number` };
      }
      result[k] = data[k] as number;
    }
  }
  if (data.marker !== undefined) {
    if (!isRecord(data.marker)) return { ok: false, error: 'chart.marker must be an object' };
    const markerAllowed = new Set(['x', 'series']);
    const mUnknown = checkUnknownKeys(data.marker, markerAllowed, 'chart marker');
    if (mUnknown) return { ok: false, error: mUnknown };
    if (typeof data.marker.x !== 'number' || !Number.isFinite(data.marker.x)) {
      return { ok: false, error: 'chart.marker.x must be a finite number' };
    }
    const markerObj: { x: number; series?: string } = { x: data.marker.x };
    if (data.marker.series !== undefined) {
      const err = checkString(data.marker.series, 128, 'chart.marker.series');
      if (err) return { ok: false, error: err };
      markerObj.series = data.marker.series as string;
    }
    result.marker = markerObj;
  }

  return { ok: true, data: result };
}

function validateMetricData(data: Record<string, unknown>): { ok: true; data: MetricData } | { ok: false; error: string } {
  const allowed = new Set(['label', 'value', 'semantic', 'caption', 'trend', 'delta']);
  const unknownKey = checkUnknownKeys(data, allowed, 'metric data');
  if (unknownKey) return { ok: false, error: unknownKey };

  const labelErr = checkString(data.label, 128, 'metric.label');
  if (labelErr) return { ok: false, error: labelErr };
  const valErr = checkString(data.value, 128, 'metric.value');
  if (valErr) return { ok: false, error: valErr };

  if (data.semantic !== undefined && !ALLOWED_SEMANTICS.has(data.semantic as Semantic)) {
    return { ok: false, error: 'invalid metric.semantic' };
  }

  const result: MetricData = {
    label: data.label as string,
    value: data.value as string,
    ...(data.semantic !== undefined ? { semantic: data.semantic as Semantic } : {}),
  };
  if (data.caption !== undefined) {
    const err = checkString(data.caption, 128, 'metric.caption');
    if (err) return { ok: false, error: err };
    result.caption = data.caption as string;
  }
  if (data.trend !== undefined) {
    if (!METRIC_TRENDS.has(data.trend as MetricTrend)) {
      return { ok: false, error: 'invalid metric.trend' };
    }
    result.trend = data.trend as MetricTrend;
  }
  if (data.delta !== undefined) {
    const err = checkString(data.delta, MAX_METRIC_DELTA_UTF16, 'metric.delta');
    if (err) return { ok: false, error: err };
    result.delta = data.delta as string;
  }
  return {
    ok: true,
    data: result,
  };
}

/**
 * The percent a step list stands for when the agent gives no `value`: the
 * share of its steps that are done. The backend's `progress_value_of_steps`
 * computes it the same way, so a filled-in value agrees on both sides.
 */
function progressValueOfSteps(steps: ProgressStep[]): number {
  const done = steps.filter((step) => step.state === 'done').length;
  return normalizeProgressValue((done * 100) / steps.length);
}

function validateProgressSteps(value: unknown): { ok: true; steps: ProgressStep[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PROGRESS_STEPS) {
    return { ok: false, error: `progress.steps must be an array of 1 to ${MAX_PROGRESS_STEPS} items` };
  }
  const stepAllowed = new Set(['label', 'state', 'detail']);
  const steps: ProgressStep[] = [];
  for (const s of value) {
    if (!isRecord(s)) return { ok: false, error: 'progress step must be an object' };
    const sUnknown = checkUnknownKeys(s, stepAllowed, 'progress step');
    if (sUnknown) return { ok: false, error: sUnknown };
    const labelErr = checkString(s.label, 128, 'progress step.label');
    if (labelErr) return { ok: false, error: labelErr };
    const step: ProgressStep = { label: s.label as string };
    if (s.state !== undefined) {
      if (!PROGRESS_STEP_STATES.has(s.state as ProgressStepState)) {
        return { ok: false, error: 'invalid progress step.state' };
      }
      step.state = s.state as ProgressStepState;
    }
    if (s.detail !== undefined) {
      const err = checkString(s.detail, 256, 'progress step.detail');
      if (err) return { ok: false, error: err };
      step.detail = s.detail as string;
    }
    steps.push(step);
  }
  return { ok: true, steps };
}

function validateProgressData(data: Record<string, unknown>): { ok: true; data: ProgressData } | { ok: false; error: string } {
  const allowed = new Set(['label', 'detail', 'value', 'text', 'caption', 'steps']);
  const unknownKey = checkUnknownKeys(data, allowed, 'progress data');
  if (unknownKey) return { ok: false, error: unknownKey };

  const labelErr = checkString(data.label, 128, 'progress.label');
  if (labelErr) return { ok: false, error: labelErr };

  let steps: ProgressStep[] | undefined;
  if (data.steps !== undefined) {
    const res = validateProgressSteps(data.steps);
    if (!res.ok) return res;
    steps = res.steps;
  }

  // The bar needs a percent: the agent's own, or the share of steps done.
  let value: number;
  if (data.value !== undefined) {
    if (typeof data.value !== 'number' || !Number.isFinite(data.value)) {
      return { ok: false, error: 'progress.value must be a finite number' };
    }
    value = normalizeProgressValue(data.value);
  } else if (steps) {
    value = progressValueOfSteps(steps);
  } else {
    return { ok: false, error: 'progress requires value or steps' };
  }

  const result: ProgressData = {
    label: data.label as string,
    value,
    ...(steps ? { steps } : {}),
  };

  if (data.detail !== undefined) {
    const err = checkString(data.detail, 256, 'progress.detail');
    if (err) return { ok: false, error: err };
    result.detail = data.detail as string;
  }
  if (data.text !== undefined) {
    const err = checkString(data.text, 128, 'progress.text');
    if (err) return { ok: false, error: err };
    result.text = data.text as string;
  }
  if (data.caption !== undefined) {
    const err = checkString(data.caption, 128, 'progress.caption');
    if (err) return { ok: false, error: err };
    result.caption = data.caption as string;
  }

  return { ok: true, data: result };
}

// The two diagram modes are told apart by `mode` before anything else is
// read, so a graph payload is judged by the graph rules and a sequence
// payload by the sequence rules; each refuses the other's arrays by name.
function validateDiagramData(data: Record<string, unknown>): { ok: true; data: DiagramObjectData } | { ok: false; error: string } {
  if ('source' in data) {
    return { ok: false, error: 'diagram data source field is forbidden in v1' };
  }
  switch (data.mode) {
    case 'graph':
      return validateGraphDiagramData(data);
    case 'sequence':
      return validateSequenceDiagramData(data);
    default:
      return { ok: false, error: 'diagram.mode must be "graph" or "sequence"' };
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
  const nodeStates = new Set(['done', 'active', 'todo', 'blocked']);
  const nodeIds = new Set<string>();
  const nodes: DiagramNode[] = [];

  for (const n of data.nodes) {
    if (!isRecord(n)) return { ok: false, error: 'diagram node must be an object' };
    const nUnknown = checkUnknownKeys(n, nodeAllowed, 'diagram node');
    if (nUnknown) return { ok: false, error: nUnknown };

    if (typeof n.id !== 'string' || n.id.trim().length === 0 || n.id.length > 128) {
      return { ok: false, error: 'diagram node id must be non-empty and <= 128 UTF-16 code units' };
    }
    if (nodeIds.has(n.id)) {
      return { ok: false, error: `duplicate diagram node id: ${n.id}` };
    }
    nodeIds.add(n.id);

    const labelErr = checkString(n.label, 256, 'diagram node.label');
    if (labelErr) return { ok: false, error: labelErr };

    const nodeItem: DiagramNode = { id: n.id, label: n.label as string };
    if (n.sub !== undefined) {
      const err = checkString(n.sub, 256, 'diagram node.sub');
      if (err) return { ok: false, error: err };
      nodeItem.sub = n.sub as string;
    }
    if (n.detail !== undefined) {
      const err = checkString(n.detail, 256, 'diagram node.detail');
      if (err) return { ok: false, error: err };
      nodeItem.detail = n.detail as string;
    }
    if (n.semantic !== undefined) {
      if (!ALLOWED_SEMANTICS.has(n.semantic as Semantic)) return { ok: false, error: 'invalid diagram node.semantic' };
      nodeItem.semantic = n.semantic as Semantic;
    }
    if (n.state !== undefined) {
      if (!nodeStates.has(n.state as string)) return { ok: false, error: 'invalid diagram node.state' };
      nodeItem.state = n.state as DiagramNode['state'];
    }
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
    if (e.label !== undefined) {
      const err = checkString(e.label, 256, 'diagram edge.label');
      if (err) return { ok: false, error: err };
      edgeItem.label = e.label as string;
    }
    if (e.semantic !== undefined) {
      if (!ALLOWED_SEMANTICS.has(e.semantic as Semantic)) return { ok: false, error: 'invalid diagram edge.semantic' };
      edgeItem.semantic = e.semantic as Semantic;
    }
    if (e.active !== undefined) {
      if (typeof e.active !== 'boolean') return { ok: false, error: 'diagram edge.active must be boolean' };
      edgeItem.active = e.active;
    }
    edges.push(edgeItem);
  }

  const result: DiagramData = {
    mode: 'graph',
    nodes,
    edges,
  };
  for (const k of ['title', 'subtitle', 'context'] as const) {
    if (data[k] !== undefined) {
      const err = checkString(data[k], 256, `diagram.${k}`);
      if (err) return { ok: false, error: err };
      result[k] = data[k] as string;
    }
  }
  if (data.caption !== undefined) {
    const err = checkString(data.caption, 128, 'diagram.caption');
    if (err) return { ok: false, error: err };
    result.caption = data.caption as string;
  }

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

    if (typeof a.id !== 'string' || a.id.trim().length === 0 || a.id.length > 128) {
      return { ok: false, error: 'diagram actor id must be non-empty and <= 128 UTF-16 code units' };
    }
    if (actorIds.has(a.id)) {
      return { ok: false, error: `duplicate diagram actor id: ${a.id}` };
    }
    actorIds.add(a.id);

    const labelErr = checkString(a.label, 256, 'diagram actor.label');
    if (labelErr) return { ok: false, error: labelErr };

    const actorItem: SequenceActor = { id: a.id, label: a.label as string };
    if (a.sub !== undefined) {
      const err = checkString(a.sub, 256, 'diagram actor.sub');
      if (err) return { ok: false, error: err };
      actorItem.sub = a.sub as string;
    }
    if (a.semantic !== undefined) {
      if (!ALLOWED_SEMANTICS.has(a.semantic as Semantic)) return { ok: false, error: 'invalid diagram actor.semantic' };
      actorItem.semantic = a.semantic as Semantic;
    }
    actors.push(actorItem);
  }

  const messageAllowed = new Set(['from', 'to', 'label', 'kind', 'active']);
  const messageKinds = new Set(['call', 'return', 'async']);
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
    if (m.kind !== undefined) {
      if (!messageKinds.has(m.kind as string)) return { ok: false, error: 'invalid diagram message.kind' };
      messageItem.kind = m.kind as SequenceMessage['kind'];
    }
    if (m.active !== undefined) {
      if (typeof m.active !== 'boolean') return { ok: false, error: 'diagram message.active must be boolean' };
      messageItem.active = m.active;
    }
    messages.push(messageItem);
  }

  const result: SequenceDiagramData = {
    mode: 'sequence',
    actors,
    messages,
  };
  for (const k of ['title', 'subtitle', 'context'] as const) {
    if (data[k] !== undefined) {
      const err = checkString(data[k], 256, `diagram.${k}`);
      if (err) return { ok: false, error: err };
      result[k] = data[k] as string;
    }
  }
  if (data.caption !== undefined) {
    const err = checkString(data.caption, 128, 'diagram.caption');
    if (err) return { ok: false, error: err };
    result.caption = data.caption as string;
  }

  return { ok: true, data: result };
}

function validateDocumentData(data: Record<string, unknown>): { ok: true; data: DocumentData } | { ok: false; error: string } {
  const allowed = new Set(['kind', 'context', 'caption', 'source', 'from', 'timestamp', 'subject', 'paragraphs']);
  const unknownKey = checkUnknownKeys(data, allowed, 'document data');
  if (unknownKey) return { ok: false, error: unknownKey };

  const subjErr = checkString(data.subject, 256, 'document.subject');
  if (subjErr) return { ok: false, error: subjErr };

  if (!Array.isArray(data.paragraphs)) return { ok: false, error: 'document.paragraphs must be an array' };
  for (const p of data.paragraphs) {
    const err = checkString(p, 50_000, 'document paragraph');
    if (err) return { ok: false, error: err };
  }

  const result: DocumentData = {
    subject: data.subject as string,
    paragraphs: data.paragraphs as string[],
  };

  if (data.kind !== undefined) {
    if (data.kind !== 'email' && data.kind !== 'document') {
      return { ok: false, error: 'invalid document.kind' };
    }
    result.kind = data.kind;
  }
  for (const k of ['context', 'source'] as const) {
    if (data[k] !== undefined) {
      const err = checkString(data[k], 256, `document.${k}`);
      if (err) return { ok: false, error: err };
      result[k] = data[k] as string;
    }
  }
  for (const k of ['from', 'timestamp'] as const) {
    if (data[k] !== undefined) {
      const err = checkString(data[k], 128, `document.${k}`);
      if (err) return { ok: false, error: err };
      result[k] = data[k] as string;
    }
  }
  if (data.caption !== undefined) {
    const err = checkString(data.caption, 128, 'document.caption');
    if (err) return { ok: false, error: err };
    result.caption = data.caption as string;
  }

  return { ok: true, data: result };
}

function validateCodeData(data: Record<string, unknown>): { ok: true; data: CodeData } | { ok: false; error: string } {
  const allowed = new Set(['title', 'file', 'context', 'caption', 'source']);
  const unknownKey = checkUnknownKeys(data, allowed, 'code data');
  if (unknownKey) return { ok: false, error: unknownKey };

  if (!isRecord(data.source)) return { ok: false, error: 'code.source must be an object' };
  const sourceAllowed = new Set(['language', 'text', 'highlight']);
  const sUnknown = checkUnknownKeys(data.source, sourceAllowed, 'code.source');
  if (sUnknown) return { ok: false, error: sUnknown };

  const textErr = checkString(data.source.text, 50_000, 'code.source.text');
  if (textErr) return { ok: false, error: textErr };

  const sourceObj: CodeData['source'] = { text: data.source.text as string };
  if (data.source.language !== undefined) {
    const err = checkString(data.source.language, 64, 'code.source.language');
    if (err) return { ok: false, error: err };
    sourceObj.language = data.source.language as string;
  }
  if (data.source.highlight !== undefined) {
    if (!Array.isArray(data.source.highlight)) return { ok: false, error: 'code.source.highlight must be an array' };
    for (const h of data.source.highlight) {
      if (typeof h !== 'number' || !Number.isFinite(h)) {
        return { ok: false, error: 'code.source.highlight must contain finite numbers' };
      }
    }
    sourceObj.highlight = data.source.highlight as number[];
  }

  const result: CodeData = { source: sourceObj };
  for (const k of ['title', 'file', 'context'] as const) {
    if (data[k] !== undefined) {
      const err = checkString(data[k], 256, `code.${k}`);
      if (err) return { ok: false, error: err };
      result[k] = data[k] as string;
    }
  }
  if (data.caption !== undefined) {
    const err = checkString(data.caption, 128, 'code.caption');
    if (err) return { ok: false, error: err };
    result.caption = data.caption as string;
  }

  return { ok: true, data: result };
}

// The table contract (docs/display-tool.md, "Table v1 rules"): 1 to 12
// columns, 0 to 200 rows of exactly one cell per column, a cell a string, a
// finite number or `{ text, semantic?, bold? }`, and `highlight` naming row
// indices. Alignment is the page's to infer, so there is no `align`.
const MAX_TABLE_COLUMNS = 12;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLUMN_LABEL_UTF16 = 64;
const MAX_TABLE_CELL_UTF16 = 256;

function validateTableData(data: Record<string, unknown>): { ok: true; data: TableData } | { ok: false; error: string } {
  const allowed = new Set(['title', 'subtitle', 'context', 'caption', 'columns', 'rows', 'highlight']);
  const unknownKey = checkUnknownKeys(data, allowed, 'table data');
  if (unknownKey) return { ok: false, error: unknownKey };

  if (!Array.isArray(data.columns) || data.columns.length < 1 || data.columns.length > MAX_TABLE_COLUMNS) {
    return { ok: false, error: `table.columns must be an array of 1 to ${MAX_TABLE_COLUMNS} items` };
  }
  const columnAllowed = new Set(['label', 'semantic']);
  const columns: TableColumn[] = [];
  for (const c of data.columns) {
    if (!isRecord(c)) return { ok: false, error: 'table column must be an object' };
    const cUnknown = checkUnknownKeys(c, columnAllowed, 'table column');
    if (cUnknown) return { ok: false, error: cUnknown };
    const labelErr = checkString(c.label, MAX_TABLE_COLUMN_LABEL_UTF16, 'table column.label');
    if (labelErr) return { ok: false, error: labelErr };
    const column: TableColumn = { label: c.label as string };
    if (c.semantic !== undefined) {
      if (!ALLOWED_SEMANTICS.has(c.semantic as Semantic)) return { ok: false, error: 'invalid table column.semantic' };
      column.semantic = c.semantic as Semantic;
    }
    columns.push(column);
  }

  if (!Array.isArray(data.rows) || data.rows.length > MAX_TABLE_ROWS) {
    return { ok: false, error: `table.rows must be an array of at most ${MAX_TABLE_ROWS} items` };
  }
  const cellAllowed = new Set(['text', 'semantic', 'bold']);
  const rows: TableCell[][] = [];
  for (const [rowIndex, r] of data.rows.entries()) {
    if (!Array.isArray(r)) return { ok: false, error: `table row ${rowIndex} must be an array` };
    if (r.length !== columns.length) {
      return { ok: false, error: `table row ${rowIndex} has ${r.length} cells; the table has ${columns.length} columns` };
    }
    const row: TableCell[] = [];
    for (const cell of r) {
      if (typeof cell === 'number') {
        if (!Number.isFinite(cell)) return { ok: false, error: 'table cell must be a finite number' };
        row.push(cell);
        continue;
      }
      if (typeof cell === 'string') {
        const err = checkString(cell, MAX_TABLE_CELL_UTF16, 'table cell');
        if (err) return { ok: false, error: err };
        row.push(cell);
        continue;
      }
      if (!isRecord(cell)) return { ok: false, error: 'table cell must be a string, a number or an object' };
      const cellUnknown = checkUnknownKeys(cell, cellAllowed, 'table cell');
      if (cellUnknown) return { ok: false, error: cellUnknown };
      const textErr = checkString(cell.text, MAX_TABLE_CELL_UTF16, 'table cell.text');
      if (textErr) return { ok: false, error: textErr };
      const cellObj: TableCell = { text: cell.text as string };
      if (cell.semantic !== undefined) {
        if (!ALLOWED_SEMANTICS.has(cell.semantic as Semantic)) return { ok: false, error: 'invalid table cell.semantic' };
        cellObj.semantic = cell.semantic as Semantic;
      }
      if (cell.bold !== undefined) {
        if (typeof cell.bold !== 'boolean') return { ok: false, error: 'table cell.bold must be boolean' };
        cellObj.bold = cell.bold;
      }
      row.push(cellObj);
    }
    rows.push(row);
  }

  const result: TableData = { columns, rows };
  if (data.highlight !== undefined) {
    if (!Array.isArray(data.highlight)) return { ok: false, error: 'table.highlight must be an array' };
    for (const h of data.highlight) {
      if (typeof h !== 'number' || !Number.isInteger(h) || h < 0 || h >= rows.length) {
        return { ok: false, error: 'table.highlight must contain row indices' };
      }
    }
    result.highlight = data.highlight as number[];
  }
  for (const k of ['title', 'subtitle', 'context'] as const) {
    if (data[k] !== undefined) {
      const err = checkString(data[k], 256, `table.${k}`);
      if (err) return { ok: false, error: err };
      result[k] = data[k] as string;
    }
  }
  if (data.caption !== undefined) {
    const err = checkString(data.caption, 128, 'table.caption');
    if (err) return { ok: false, error: err };
    result.caption = data.caption as string;
  }

  return { ok: true, data: result };
}

// ---- image -----------------------------------------------------------------

const IMAGE_FORMATS = new Set<ImageFormat>(['png', 'jpeg', 'webp']);
/** The fewest bytes a signature check needs: WebP's `WEBP` ends at byte 12. */
const IMAGE_SIGNATURE_BYTES = 12;

/** The index of `code` in the standard base64 alphabet, or -1. */
function base64Index(code: number): number {
  if (code >= 65 && code <= 90) return code - 65; // A-Z
  if (code >= 97 && code <= 122) return code - 71; // a-z
  if (code >= 48 && code <= 57) return code + 4; // 0-9
  if (code === 43) return 62; // +
  if (code === 47) return 63; // /
  return -1;
}

/**
 * The decoded length of `text` when it is strict standard base64 -- the
 * `A-Za-z0-9+/` alphabet, a multiple of four characters long, at most two
 * `=` at the end and nothing else (no whitespace, no URL-safe variant) --
 * or null when it is not. Linear in the length; the text itself is never
 * copied, since an image's base64 runs to megabytes.
 */
export function base64DecodedLength(text: string): number | null {
  if (text.length === 0 || text.length % 4 !== 0) return null;
  let padding = 0;
  while (padding < 2 && text.charCodeAt(text.length - 1 - padding) === 61 /* = */) padding += 1;
  const body = text.length - padding;
  for (let i = 0; i < body; i += 1) {
    if (base64Index(text.charCodeAt(i)) < 0) return null;
  }
  return (text.length / 4) * 3 - padding;
}

/** Decodes a prefix of strict base64 to bytes: the first `count` bytes at most. */
export function decodeBase64Head(text: string, count: number): Uint8Array {
  const chars = Math.ceil(count / 3) * 4;
  const head = text.slice(0, chars);
  const out: number[] = [];
  for (let i = 0; i + 3 < head.length; i += 4) {
    const a = base64Index(head.charCodeAt(i));
    const b = base64Index(head.charCodeAt(i + 1));
    const c = head.charCodeAt(i + 2) === 61 ? -1 : base64Index(head.charCodeAt(i + 2));
    const d = head.charCodeAt(i + 3) === 61 ? -1 : base64Index(head.charCodeAt(i + 3));
    out.push(((a << 2) | (b >> 4)) & 0xff);
    if (c >= 0) out.push(((b << 4) | (c >> 2)) & 0xff);
    if (c >= 0 && d >= 0) out.push(((c << 6) | d) & 0xff);
  }
  return Uint8Array.from(out.slice(0, count));
}

/**
 * Whether `bytes` start with `format`'s file signature: PNG
 * `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, WebP `RIFF....WEBP`. The
 * backend's `image_signature_matches` sniffs the same bytes.
 */
export function imageSignatureMatches(format: ImageFormat, bytes: Uint8Array): boolean {
  const at = (index: number, expected: number[]) => expected.every((value, offset) => bytes[index + offset] === value);
  switch (format) {
    case 'png':
      return at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpeg':
      return at(0, [0xff, 0xd8, 0xff]);
    case 'webp':
      return at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50]);
    default:
      return false;
  }
}

/**
 * Unicode White_Space, the set Rust's `char::is_whitespace` uses. Not
 * `String.prototype.trim`: that also strips U+FEFF and keeps U+0085, so the
 * two validators would disagree on what a blank alt is.
 */
const NOT_WHITE_SPACE = /[^\t\n\u000b\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;

function isBlank(text: string): boolean {
  return !NOT_WHITE_SPACE.test(text);
}

// Raster only: the format names the bytes' encoding, and the bytes must
// carry that encoding's signature, so `format` can never label markup (an
// SVG) or anything else as an image. The page builds the only `img` source
// there is from these two fields once they have passed here.
function validateImageData(data: Record<string, unknown>): { ok: true; data: ImageData } | { ok: false; error: string } {
  const allowed = new Set(['format', 'bytes', 'alt', 'title', 'subtitle', 'context', 'caption']);
  const unknownKey = checkUnknownKeys(data, allowed, 'image data');
  if (unknownKey) return { ok: false, error: unknownKey };

  if (data.format === 'svg' || data.format === 'svg+xml') {
    return { ok: false, error: 'image.format svg is refused: an image is raster bytes, not markup' };
  }
  if (typeof data.format !== 'string' || !IMAGE_FORMATS.has(data.format as ImageFormat)) {
    return { ok: false, error: 'image.format must be one of png, jpeg, webp' };
  }
  const format = data.format as ImageFormat;

  if (typeof data.bytes !== 'string') return { ok: false, error: 'image.bytes must be a base64 string' };
  const decodedLength = base64DecodedLength(data.bytes);
  if (decodedLength === null) {
    return { ok: false, error: 'image.bytes must be standard base64: the A-Za-z0-9+/ alphabet, padded with =, no data: prefix' };
  }
  if (decodedLength > MAX_IMAGE_BYTES) {
    return { ok: false, error: `image.bytes decode to more than ${MAX_IMAGE_BYTES} bytes` };
  }
  if (decodedLength < IMAGE_SIGNATURE_BYTES) {
    return { ok: false, error: `image.bytes are too short to be a ${format}` };
  }
  if (!imageSignatureMatches(format, decodeBase64Head(data.bytes, IMAGE_SIGNATURE_BYTES))) {
    return { ok: false, error: `image.bytes do not start with the ${format} signature` };
  }

  const altErr = checkString(data.alt, 256, 'image.alt');
  if (altErr) return { ok: false, error: altErr };
  if (isBlank(data.alt as string)) return { ok: false, error: 'image.alt must not be empty' };

  const result: ImageData = { format, bytes: data.bytes, alt: data.alt as string };
  for (const k of ['title', 'subtitle', 'context'] as const) {
    if (data[k] !== undefined) {
      const err = checkString(data[k], 256, `image.${k}`);
      if (err) return { ok: false, error: err };
      result[k] = data[k] as string;
    }
  }
  if (data.caption !== undefined) {
    const err = checkString(data.caption, 128, 'image.caption');
    if (err) return { ok: false, error: err };
    result.caption = data.caption as string;
  }
  return { ok: true, data: result };
}

// ---- note ------------------------------------------------------------------

function validateNoteData(data: Record<string, unknown>): { ok: true; data: NoteData } | { ok: false; error: string } {
  const allowed = new Set(['tag', 'segments', 'caption', 'anchor']);
  const unknownKey = checkUnknownKeys(data, allowed, 'note data');
  if (unknownKey) return { ok: false, error: unknownKey };

  if (!Array.isArray(data.segments)) return { ok: false, error: 'note.segments must be an array' };
  const segmentAllowed = new Set(['text', 'accent', 'bold', 'semantic']);
  const segments: RichSegment[] = [];

  for (const seg of data.segments) {
    if (!isRecord(seg)) return { ok: false, error: 'note segment must be an object' };
    const segUnknown = checkUnknownKeys(seg, segmentAllowed, 'note segment');
    if (segUnknown) return { ok: false, error: segUnknown };

    const textErr = checkString(seg.text, 50_000, 'note segment.text');
    if (textErr) return { ok: false, error: textErr };

    const segObj: RichSegment = { text: seg.text as string };
    if (seg.accent !== undefined) {
      if (typeof seg.accent !== 'boolean') return { ok: false, error: 'note segment.accent must be boolean' };
      segObj.accent = seg.accent;
    }
    if (seg.bold !== undefined) {
      if (typeof seg.bold !== 'boolean') return { ok: false, error: 'note segment.bold must be boolean' };
      segObj.bold = seg.bold;
    }
    if (seg.semantic !== undefined) {
      if (!ALLOWED_SEMANTICS.has(seg.semantic as Semantic)) return { ok: false, error: 'invalid note segment.semantic' };
      segObj.semantic = seg.semantic as Semantic;
    }
    segments.push(segObj);
  }

  const result: NoteData = { segments };
  if (data.tag !== undefined) {
    const err = checkString(data.tag, 128, 'note.tag');
    if (err) return { ok: false, error: err };
    result.tag = data.tag as string;
  }
  if (data.caption !== undefined) {
    const err = checkString(data.caption, 128, 'note.caption');
    if (err) return { ok: false, error: err };
    result.caption = data.caption as string;
  }
  if (data.anchor !== undefined) {
    if (!isRecord(data.anchor)) return { ok: false, error: 'note.anchor must be an object' };
    const anchorUnknown = checkUnknownKeys(data.anchor, new Set(['target', 'x', 'series', 'node']), 'note anchor');
    if (anchorUnknown) return { ok: false, error: anchorUnknown };
    const target = checkIdentifier(data.anchor.target, 'note.anchor.target');
    if (!target.ok) return target;
    const anchor: NonNullable<NoteData['anchor']> = { target: target.id };
    if (data.anchor.x !== undefined) {
      if (typeof data.anchor.x !== 'number' || !Number.isFinite(data.anchor.x)) {
        return { ok: false, error: 'note.anchor.x must be a finite number' };
      }
      anchor.x = data.anchor.x;
    }
    for (const key of ['series', 'node'] as const) {
      if (data.anchor[key] !== undefined) {
        const err = checkString(data.anchor[key], 128, `note.anchor.${key}`);
        if (err) return { ok: false, error: err };
        anchor[key] = data.anchor[key] as string;
      }
    }
    result.anchor = anchor;
  }

  return { ok: true, data: result };
}

export function validateControllerAction(value: unknown): ActionValidationResult {
  if (!isRecord(value)) return { ok: false, error: 'action must be an object' };
  // An image action is the one kind allowed past the general cap; its own
  // fields are capped below, so nothing else can ride in under its limit.
  const sizeCap = value.op === 'show' && value.type === 'image' ? MAX_IMAGE_ACTION_BYTES : MAX_ACTION_BYTES;
  if (serializedSize(value) > sizeCap) return { ok: false, error: 'action exceeds size limit' };
  if (typeof value.op !== 'string' || !ALLOWED_OPERATIONS.has(value.op)) {
    return { ok: false, error: 'unknown operation' };
  }

  const layoutError = findForbiddenLayoutKey(value);
  if (layoutError) return { ok: false, error: `model-controlled layout field is forbidden: ${layoutError}` };

  const unsafeError = findUnsafeString(value);
  if (unsafeError) return { ok: false, error: unsafeError };

  if (hasNonFiniteNumber(value)) {
    return { ok: false, error: 'action contains a non-finite number' };
  }

  switch (value.op) {
    case 'show': {
      const allowedKeys = new Set(['op', 'id', 'type', 'role', 'data']);
      const unknownKey = checkUnknownKeys(value, allowedKeys, 'show action');
      if (unknownKey) return { ok: false, error: unknownKey };

      const idCheck = checkIdentifier(value.id, 'show.id');
      if (!idCheck.ok) return idCheck;

      if (typeof value.type !== 'string' || !ALLOWED_OBJECT_TYPES.has(value.type)) {
        return { ok: false, error: 'show.type is unknown' };
      }

      if (value.role !== undefined && (typeof value.role !== 'string' || !ALLOWED_ROLES.has(value.role as SceneObjectRole))) {
        return { ok: false, error: 'show.role is unknown' };
      }

      if (!isRecord(value.data)) return { ok: false, error: 'show.data must be an object' };

      let validatedData: DisplayAction extends { op: 'show'; data: infer D } ? D : unknown;
      switch (value.type) {
        case 'chart': {
          const res = validateChartData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'metric': {
          const res = validateMetricData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'progress': {
          const res = validateProgressData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'diagram': {
          const res = validateDiagramData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'document': {
          const res = validateDocumentData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'code': {
          const res = validateCodeData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'table': {
          const res = validateTableData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'note': {
          const res = validateNoteData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'image': {
          const res = validateImageData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        default:
          return { ok: false, error: 'show.type is unknown' };
      }

      // The switch above validated `type` and `data` together; TypeScript
      // cannot correlate the two across it, so the pair is asserted once here.
      const action = {
        op: 'show',
        id: idCheck.id,
        type: value.type,
        ...(value.role !== undefined ? { role: value.role as SceneObjectRole } : {}),
        data: validatedData,
      } as DisplayAction;
      return { ok: true, action };
    }
    case 'hide': {
      const allowedKeys = new Set(['op', 'id']);
      const unknownKey = checkUnknownKeys(value, allowedKeys, 'hide action');
      if (unknownKey) return { ok: false, error: unknownKey };

      const idCheck = checkIdentifier(value.id, 'hide.id');
      if (!idCheck.ok) return idCheck;
      return { ok: true, action: { op: 'hide', id: idCheck.id } };
    }
    case 'focus': {
      const allowedKeys = new Set(['op', 'id']);
      const unknownKey = checkUnknownKeys(value, allowedKeys, 'focus action');
      if (unknownKey) return { ok: false, error: unknownKey };

      const idCheck = checkIdentifier(value.id, 'focus.id');
      if (!idCheck.ok) return idCheck;
      return { ok: true, action: { op: 'focus', id: idCheck.id } };
    }
    case 'say': {
      const allowedKeys = new Set(['op', 'text', 'target', 'at']);
      const unknownKey = checkUnknownKeys(value, allowedKeys, 'say action');
      if (unknownKey) return { ok: false, error: unknownKey };

      if (typeof value.text !== 'string' || value.text.length === 0 || value.text.length > MAX_TEXT_UTF16) {
        return { ok: false, error: 'say.text must be non-empty and within the text limit' };
      }

      let targetVal: string | undefined = undefined;
      if (value.target !== undefined && value.target !== null) {
        const targetCheck = checkIdentifier(value.target, 'say.target');
        if (!targetCheck.ok) return targetCheck;
        targetVal = targetCheck.id;
      }

      let atVal: SpeechState['at'] = null;
      if (value.at !== undefined && value.at !== null) {
        if (!isRecord(value.at)) return { ok: false, error: 'say.at is invalid' };
        const atAllowed = new Set(['x', 'series']);
        const atUnknown = checkUnknownKeys(value.at, atAllowed, 'say.at');
        if (atUnknown) return { ok: false, error: atUnknown };

        const hasX = value.at.x !== undefined;
        const hasSeries = value.at.series !== undefined;
        if (!hasX && !hasSeries) {
          return { ok: false, error: 'say.at must contain at least one of x or series' };
        }
        const atObj: { x?: number; series?: string } = {};
        if (hasX) {
          if (typeof value.at.x !== 'number' || !Number.isFinite(value.at.x)) {
            return { ok: false, error: 'say.at.x must be a finite number' };
          }
          atObj.x = value.at.x;
        }
        if (hasSeries) {
          const err = checkString(value.at.series, 128, 'say.at.series');
          if (err) return { ok: false, error: err };
          atObj.series = value.at.series as string;
        }
        atVal = atObj;
      }

      return {
        ok: true,
        action: {
          op: 'say',
          text: value.text,
          ...(targetVal !== undefined ? { target: targetVal } : {}),
          at: atVal,
        },
      };
    }
    case 'clear': {
      const allowedKeys = new Set(['op']);
      const unknownKey = checkUnknownKeys(value, allowedKeys, 'clear action');
      if (unknownKey) return { ok: false, error: unknownKey };
      return { ok: true, action: { op: 'clear' } };
    }
    default:
      return { ok: false, error: 'unknown operation' };
  }
}

export function assertControllerAction(value: unknown): DisplayAction {
  const result = validateControllerAction(value);
  if (!result.ok) throw new TypeError(`Invalid Switchboard action: ${result.error}`);
  return result.action;
}

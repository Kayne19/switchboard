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
  CalendarData,
  CalendarEvent,
  TaskItem,
  TasksData,
  Timer,
  TimerData,
  WeatherCurrent,
  WeatherDay,
  WeatherHour,
  WeatherData,
  InboxData,
  InboxMessage,
} from './types';

/**
 * Progress values arrive as a percentage (0–100). Values outside
 * 0–100 are clamped to [0, 100], and rounded to two decimal places.
 */
export function normalizeProgressValue(value: number): number {
  const bounded = Math.min(100, Math.max(0, value));
  return Math.round(bounded * 100) / 100;
}

// The names a field takes from a fixed set, each in the schema's order. A
// refused name is `invalidName`'s text, which lists them.
const OPERATIONS = ['show', 'hide', 'focus', 'say', 'clear'] as const;
const OBJECT_TYPES = [
  'chart',
  'metric',
  'progress',
  'diagram',
  'document',
  'code',
  'table',
  'note',
  'image',
  'calendar',
  'tasks',
  'timer',
  'weather',
  'inbox',
] as const;
const ROLES: readonly SceneObjectRole[] = ['primary', 'compare', 'secondary', 'ambient'];
const SEMANTICS: readonly Semantic[] = ['red', 'orange', 'green', 'cyan', 'amber', 'paper', 'muted'];
const CHART_KINDS: readonly ChartKind[] = ['line', 'bar', 'area', 'scatter'];
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
const METRIC_TRENDS: readonly MetricTrend[] = ['up', 'down', 'flat'];
/** A progress step's state and a diagram node's state. */
const STEP_STATES: readonly ProgressStepState[] = ['done', 'active', 'todo', 'blocked'];
const DIAGRAM_MODES = ['graph', 'sequence'] as const;
const MESSAGE_KINDS: readonly NonNullable<SequenceMessage['kind']>[] = ['call', 'return', 'async'];
const DOCUMENT_KINDS: readonly NonNullable<DocumentData['kind']>[] = ['email', 'document'];

/**
 * The one refusal of a name outside its set, required or optional alike
 * (docs/display-tool.md, "How the two validators agree"): the field and
 * every name it takes, so an agent can mend the action from the error
 * alone. The backend's `invalid_name` writes the same text.
 */
function invalidName(field: string, allowed: readonly string[]): string {
  return `invalid ${field}: expected one of ${allowed.join(', ')}`;
}

/** Whether `value` is one of `allowed`: a string, and in the set. */
function isName<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

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

/**
 * An external resource, in any string: a `scheme://` of any scheme, a
 * leading `//`, or a `//` followed by a host name with a dot and a top-level
 * part of two letters or more (`see //cdn.example.com`). The backend's
 * `names_external_resource` is the same rule, written out by hand.
 */
const EXTERNAL_URL_REGEX = /:\/\/|^\/\/|\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

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

/**
 * Anything but Unicode White_Space, the one whitespace set both validators
 * use (docs/display-tool.md, "How the two validators agree"): the 25 code
 * points listed here, which the backend's `WHITE_SPACE` lists too. Not
 * `String.prototype.trim`, which also strips U+FEFF and keeps U+0085.
 */
const NOT_WHITE_SPACE = /[^\t\n\u000b\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;

/** Whether `text` is empty or White_Space only: a blank identifier or alt. */
export function isBlank(text: string): boolean {
  return !NOT_WHITE_SPACE.test(text);
}

function checkIdentifier(val: unknown, fieldName: string): { ok: true; id: string } | { ok: false; error: string } {
  if (typeof val !== 'string' || isBlank(val)) {
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

/**
 * Code point order. The default sort compares UTF-16 units, which puts an
 * astral key before one in U+E000-U+FFFF; the backend's byte order of UTF-8
 * does not, and code point order is what both agree on.
 */
function compareCodePoints(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(i) as number;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

/**
 * An object's keys in code point order, the one order both validators walk
 * an object in (docs/display-tool.md, "How the two validators agree"): with
 * two unknown or forbidden keys, or two unsafe strings, the error is about
 * the first in this order, wherever the agent put it. The backend's
 * `entries_in_order` sorts the same way.
 */
function keysInOrder(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort(compareCodePoints);
}

/** The first forbidden key met walking depth first, keys in code point order. */
function findForbiddenLayoutKey(val: unknown): string | null {
  if (Array.isArray(val)) {
    for (const item of val) {
      const found = findForbiddenLayoutKey(item);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(val)) {
    for (const key of keysInOrder(val)) {
      if (FORBIDDEN_LAYOUT_KEYS.has(key)) return key;
      const found = findForbiddenLayoutKey(val[key]);
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
    for (const key of keysInOrder(val)) {
      const found = findUnsafeString(val[key]);
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
  for (const key of keysInOrder(obj)) {
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

// ---- field helpers ---------------------------------------------------------
//
// The checks the type validators share: each reads one field, copies it into
// the result when it passes, and otherwise returns its error text. The
// backend's validators have their own set (`copy_optional_string` and the
// rest).

/**
 * A result built key by key and cast to its type once it is whole. A helper
 * also writes into a typed result (`ChartData`, `DiagramNode`, ...); its
 * `key` is then one the type has, so a call cannot write a field the type
 * lacks.
 */
type Fields = Record<string, unknown>;

/** The four scene-frame strings most types carry, each optional. */
interface FrameText {
  title?: string;
  subtitle?: string;
  context?: string;
  caption?: string;
}

/** The scene-frame text every type may carry, checked last. */
function copyFrameText(data: Fields, out: FrameText, kind: string): string | null {
  for (const key of ['title', 'subtitle', 'context'] as const) {
    const err = copyOptionalString(data, out, key, 256, `${kind}.${key}`);
    if (err) return err;
  }
  return copyOptionalString(data, out, 'caption', 128, `${kind}.caption`);
}

function copyOptionalString<T extends object>(data: Fields, out: T, key: keyof T & string, maxLen: number, field: string): string | null {
  if (data[key] === undefined) return null;
  const err = checkString(data[key], maxLen, field);
  if (err) return err;
  (out as Fields)[key] = data[key];
  return null;
}

function copyOptionalBoolean<T extends object>(data: Fields, out: T, key: keyof T & string, field: string): string | null {
  if (data[key] === undefined) return null;
  if (typeof data[key] !== 'boolean') return `${field} must be boolean`;
  (out as Fields)[key] = data[key];
  return null;
}

/** An optional name from `allowed`; anything else, `null` included, is `invalidName`'s refusal. */
function copyOptionalName<T extends object>(data: Fields, out: T, key: keyof T & string, allowed: readonly string[], field: string): string | null {
  const value = data[key];
  if (value === undefined) return null;
  if (!isName(value, allowed)) return invalidName(field, allowed);
  (out as Fields)[key] = value;
  return null;
}

function copyNumber<T extends object>(data: Fields, out: T, key: keyof T & string, field: string, required: boolean): string | null {
  const value = data[key];
  if (value === undefined && !required) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${field} must be a finite number`;
  (out as Fields)[key] = value;
  return null;
}

function copyOptionalPercent<T extends object>(data: Fields, out: T, key: keyof T & string, field: string): string | null {
  const value = data[key];
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    return `${field} must be a number from 0 to 100`;
  }
  (out as Fields)[key] = value;
  return null;
}

/** An item's id: non-blank, within the id cap, and the first of its name in `seen`. */
function checkItemId(value: unknown, seen: Set<string>, context: string): { ok: true; id: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || isBlank(value) || value.length > MAX_ID_UTF16) {
    return { ok: false, error: `${context} id must be non-empty and <= ${MAX_ID_UTF16} UTF-16 code units` };
  }
  if (seen.has(value)) return { ok: false, error: `duplicate ${context} id: ${value}` };
  seen.add(value);
  return { ok: true, id: value };
}

function validateChartData(data: Record<string, unknown>): { ok: true; data: ChartData } | { ok: false; error: string } {
  const allowed = new Set(['title', 'subtitle', 'context', 'caption', 'kind', 'labels', 'xLabel', 'yLabel', 'xMax', 'yMin', 'yMax', 'series', 'marker', 'compareLabel']);
  const unknownKey = checkUnknownKeys(data, allowed, 'chart data');
  if (unknownKey) return { ok: false, error: unknownKey };

  const result: ChartData = { series: [] };
  const kindErr = copyOptionalName(data, result, 'kind', CHART_KINDS, 'chart.kind');
  if (kindErr) return { ok: false, error: kindErr };
  if (data.labels !== undefined) {
    if (!Array.isArray(data.labels) || data.labels.length < 1 || data.labels.length > MAX_CHART_LABELS) {
      return { ok: false, error: `chart.labels must be an array of 1 to ${MAX_CHART_LABELS} strings` };
    }
    for (const label of data.labels) {
      const err = checkString(label, MAX_CHART_LABEL_UTF16, 'chart label');
      if (err) return { ok: false, error: err };
    }
    result.labels = data.labels as string[];
  }

  if (!Array.isArray(data.series)) {
    return { ok: false, error: 'chart.series must be an array' };
  }
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
    if (result.labels && s.values.length > result.labels.length) {
      return { ok: false, error: 'series.values is longer than chart.labels' };
    }
    const series: ChartSeries = { name: s.name as string, values: s.values as number[] };
    const semanticErr = copyOptionalName(s, series, 'semantic', SEMANTICS, 'series.semantic');
    if (semanticErr) return { ok: false, error: semanticErr };
    result.series.push(series);
  }

  const err =
    copyFrameText(data, result, 'chart') ??
    copyOptionalString(data, result, 'xLabel', 128, 'chart.xLabel') ??
    copyOptionalString(data, result, 'yLabel', 128, 'chart.yLabel') ??
    copyOptionalString(data, result, 'compareLabel', 128, 'chart.compareLabel') ??
    copyNumber(data, result, 'xMax', 'chart.xMax', false) ??
    copyNumber(data, result, 'yMin', 'chart.yMin', false) ??
    copyNumber(data, result, 'yMax', 'chart.yMax', false);
  if (err) return { ok: false, error: err };
  if (data.marker !== undefined) {
    if (!isRecord(data.marker)) return { ok: false, error: 'chart.marker must be an object' };
    const markerAllowed = new Set(['x', 'series']);
    const mUnknown = checkUnknownKeys(data.marker, markerAllowed, 'chart marker');
    if (mUnknown) return { ok: false, error: mUnknown };
    const marker = {} as NonNullable<ChartData['marker']>;
    const markerErr =
      copyNumber(data.marker, marker, 'x', 'chart.marker.x', true) ??
      copyOptionalString(data.marker, marker, 'series', 128, 'chart.marker.series');
    if (markerErr) return { ok: false, error: markerErr };
    result.marker = marker;
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

  const result: MetricData = { label: data.label as string, value: data.value as string };
  const err =
    copyOptionalName(data, result, 'semantic', SEMANTICS, 'metric.semantic') ??
    copyOptionalString(data, result, 'caption', 128, 'metric.caption') ??
    copyOptionalName(data, result, 'trend', METRIC_TRENDS, 'metric.trend') ??
    copyOptionalString(data, result, 'delta', MAX_METRIC_DELTA_UTF16, 'metric.delta');
  if (err) return { ok: false, error: err };
  return { ok: true, data: result };
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
    const err =
      copyOptionalName(s, step, 'state', STEP_STATES, 'progress step.state') ??
      copyOptionalString(s, step, 'detail', 256, 'progress step.detail');
    if (err) return { ok: false, error: err };
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
  const err =
    copyOptionalString(data, result, 'detail', 256, 'progress.detail') ??
    copyOptionalString(data, result, 'text', 128, 'progress.text') ??
    copyOptionalString(data, result, 'caption', 128, 'progress.caption');
  if (err) return { ok: false, error: err };
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

    if (typeof n.id !== 'string' || isBlank(n.id) || n.id.length > 128) {
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
      if (!isName(n.semantic, SEMANTICS)) return { ok: false, error: invalidName('diagram node.semantic', SEMANTICS) };
      nodeItem.semantic = n.semantic as Semantic;
    }
    if (n.state !== undefined) {
      if (!isName(n.state, STEP_STATES)) return { ok: false, error: invalidName('diagram node.state', STEP_STATES) };
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
      if (!isName(e.semantic, SEMANTICS)) return { ok: false, error: invalidName('diagram edge.semantic', SEMANTICS) };
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

    if (typeof a.id !== 'string' || isBlank(a.id) || a.id.length > 128) {
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
      if (!isName(a.semantic, SEMANTICS)) return { ok: false, error: invalidName('diagram actor.semantic', SEMANTICS) };
      actorItem.semantic = a.semantic as Semantic;
    }
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
    if (m.kind !== undefined) {
      if (!isName(m.kind, MESSAGE_KINDS)) return { ok: false, error: invalidName('diagram message.kind', MESSAGE_KINDS) };
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
    if (!isName(data.kind, DOCUMENT_KINDS)) {
      return { ok: false, error: invalidName('document.kind', DOCUMENT_KINDS) };
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
      if (!isName(c.semantic, SEMANTICS)) return { ok: false, error: invalidName('table column.semantic', SEMANTICS) };
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
        if (!isName(cell.semantic, SEMANTICS)) return { ok: false, error: invalidName('table cell.semantic', SEMANTICS) };
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

const IMAGE_FORMATS: readonly ImageFormat[] = ['png', 'jpeg', 'webp'];
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

// Raster only: the format names the bytes' encoding, and the bytes must
// carry that encoding's signature, so `format` can never label markup (an
// SVG) or anything else as an image. The page builds the only `img` source
// there is from these two fields once they have passed here.
function validateImageData(data: Record<string, unknown>): { ok: true; data: ImageData } | { ok: false; error: string } {
  const allowed = new Set(['format', 'bytes', 'alt', 'title', 'subtitle', 'context', 'caption']);
  const unknownKey = checkUnknownKeys(data, allowed, 'image data');
  if (unknownKey) return { ok: false, error: unknownKey };

  if (data.format === 'svg' || data.format === 'svg+xml') {
    return { ok: false, error: `${invalidName('image.format', IMAGE_FORMATS)} (svg is refused: an image is raster bytes, not markup)` };
  }
  if (!isName(data.format, IMAGE_FORMATS)) {
    return { ok: false, error: invalidName('image.format', IMAGE_FORMATS) };
  }
  const format = data.format;

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

// ---- time values -------------------------------------------------------------

/**
 * How a time is written (docs/display-tool.md, "Time values"): a `date`
 * (`YYYY-MM-DD`), a `wall` time on the caller's clock (`YYYY-MM-DDTHH:MM`),
 * or an `instant` (RFC 3339 with seconds and an offset). Only a timer takes
 * an instant: it is the one thing measured against the page clock.
 */
export type TimeForm = 'date' | 'wall' | 'instant';

/** A time as `parseTimeValue` read it. Fields a form does not write are 0. */
export interface TimeValue {
  form: TimeForm;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** The fraction of a second an instant carries, in nanoseconds. */
  nanos: number;
  /** An instant's offset, in minutes east of UTC; 0 for `Z` and `-00:00`. */
  offset: number;
  /** Days from 1970-01-01 to the date as written, so 0 is a Thursday. */
  dayNumber: number;
}

const MIN_TIME_YEAR = 1970;
const MAX_TIME_YEAR = 2199;

/**
 * The three forms in one pattern, upper-case `T` and `Z` only, ASCII digits
 * only (`\d` is ASCII in a JavaScript pattern), and nothing around them. The
 * backend's `parse_time_value` reads the same text by hand.
 */
const TIME_VALUE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2})))?)?$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Days from 1970-01-01 to a Gregorian date (Howard Hinnant's days_from_civil). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/**
 * Reads a time value, the one time parser the page has: every type that
 * carries a time goes through it, and so may a renderer. A real Gregorian
 * date in the years 1970-2199; hours 00-23 (no 24:00), minutes and seconds
 * 00-59 (no leap second); an instant's fraction 1 to 9 digits and its
 * offset `Z` or `+HH:MM`/`-HH:MM` (hours 00-23). Anything else is null.
 */
export function parseTimeValue(value: unknown): TimeValue | null {
  if (typeof value !== 'string') return null;
  const match = TIME_VALUE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_TIME_YEAR || year > MAX_TIME_YEAR || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  const time: TimeValue = {
    form: 'date', year, month, day, hour: 0, minute: 0, second: 0, nanos: 0, offset: 0, dayNumber: daysFromCivil(year, month, day),
  };
  if (match[4] === undefined) return time;
  time.hour = Number(match[4]);
  time.minute = Number(match[5]);
  if (time.hour > 23 || time.minute > 59) return null;
  if (match[6] === undefined) return { ...time, form: 'wall' };
  time.second = Number(match[6]);
  if (time.second > 59) return null;
  if (match[7] !== undefined) time.nanos = Number(match[7].padEnd(9, '0'));
  if (match[8] !== 'Z') {
    const hours = Number(match[10]);
    const minutes = Number(match[11]);
    if (hours > 23 || minutes > 59) return null;
    time.offset = match[9] === '-' ? -(hours * 60 + minutes) : hours * 60 + minutes;
    if (time.offset === 0) time.offset = 0; // `-00:00` is UTC, as `Z` is; never -0
  }
  return { ...time, form: 'instant' };
}

/**
 * Orders two times of one form: days for a date, minutes for a wall time,
 * and for an instant the moment it names, its offset applied.
 */
export function compareTimeValues(a: TimeValue, b: TimeValue): number {
  const place = (t: TimeValue) =>
    t.form === 'date'
      ? t.dayNumber
      : t.form === 'wall'
        ? t.dayNumber * 1440 + t.hour * 60 + t.minute
        : t.dayNumber * 86_400 + t.hour * 3600 + t.minute * 60 + t.second - t.offset * 60;
  return place(a) - place(b) || a.nanos - b.nanos;
}

const TIME_FORM_TEXT: Record<TimeForm, string> = {
  date: 'a date (YYYY-MM-DD)',
  wall: 'a wall time (YYYY-MM-DDTHH:MM)',
  instant: 'an instant (YYYY-MM-DDTHH:MM:SS with Z or an offset like -07:00)',
};

/** A field that holds a time of one of `forms`; the error names them. */
function readTime(value: unknown, forms: TimeForm[], field: string): { ok: true; time: TimeValue } | { ok: false; error: string } {
  const time = parseTimeValue(value);
  if (time && forms.includes(time.form)) return { ok: true, time };
  return { ok: false, error: `${field} must be ${forms.map((form) => TIME_FORM_TEXT[form]).join(' or ')}, on a real day in 1970-2199` };
}

// ---- personal-assistant types -------------------------------------------------
//
// calendar, tasks, timer, weather and inbox (docs/display-tool.md,
// "Personal-assistant types"). Each item id is checked as a diagram node id
// is (non-blank, <= 128 UTF-16 units) and is unique in its list; the
// backend's validators hold the same rules in the same order.

const CALENDAR_VIEWS = ['day', 'week', 'month', 'agenda'];
/** The most days a view may show; the day and month views take no `days`. */
const CALENDAR_MAX_DAYS: Record<string, number> = { week: 7, agenda: 31 };
const MAX_CALENDAR_EVENTS = 200;
const CALENDAR_EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'];

function validateCalendarEvent(e: unknown, seen: Set<string>): { ok: true; event: CalendarEvent } | { ok: false; error: string } {
  if (!isRecord(e)) return { ok: false, error: 'calendar event must be an object' };
  const unknownKey = checkUnknownKeys(
    e,
    new Set(['id', 'title', 'start', 'end', 'location', 'detail', 'semantic', 'status', 'active']),
    'calendar event',
  );
  if (unknownKey) return { ok: false, error: unknownKey };
  const id = checkItemId(e.id, seen, 'calendar event');
  if (!id.ok) return id;
  const titleErr = checkString(e.title, 256, 'calendar event.title');
  if (titleErr) return { ok: false, error: titleErr };
  const start = readTime(e.start, ['date', 'wall'], 'calendar event.start');
  if (!start.ok) return start;
  const out: Fields = { id: id.id, title: e.title, start: e.start };
  if (e.end !== undefined) {
    const end = readTime(e.end, ['date', 'wall'], 'calendar event.end');
    if (!end.ok) return end;
    if (end.time.form !== start.time.form) {
      return { ok: false, error: 'calendar event.end must be written like its start: both dates or both wall times' };
    }
    if (compareTimeValues(end.time, start.time) < 0) return { ok: false, error: 'calendar event.end is before its start' };
    out.end = e.end;
  }
  const err =
    copyOptionalString(e, out, 'location', 128, 'calendar event.location') ??
    copyOptionalString(e, out, 'detail', 256, 'calendar event.detail') ??
    copyOptionalName(e, out, 'semantic', SEMANTICS, 'calendar event.semantic') ??
    copyOptionalName(e, out, 'status', CALENDAR_EVENT_STATUSES, 'calendar event.status') ??
    copyOptionalBoolean(e, out, 'active', 'calendar event.active');
  if (err) return { ok: false, error: err };
  return { ok: true, event: out as unknown as CalendarEvent };
}

function validateCalendarData(data: Fields): { ok: true; data: CalendarData } | { ok: false; error: string } {
  const unknownKey = checkUnknownKeys(
    data,
    new Set(['title', 'subtitle', 'context', 'caption', 'view', 'start', 'days', 'today', 'now', 'events']),
    'calendar data',
  );
  if (unknownKey) return { ok: false, error: unknownKey };

  if (!isName(data.view, CALENDAR_VIEWS)) {
    return { ok: false, error: invalidName('calendar.view', CALENDAR_VIEWS) };
  }
  const view = data.view;
  const start = readTime(data.start, ['date'], 'calendar.start');
  if (!start.ok) return start;
  const out: Fields = { view, start: data.start };
  if (data.days !== undefined) {
    const max = CALENDAR_MAX_DAYS[view];
    if (max === undefined) return { ok: false, error: 'calendar.days applies only to the week and agenda views' };
    if (typeof data.days !== 'number' || !Number.isInteger(data.days) || data.days < 1 || data.days > max) {
      return { ok: false, error: `calendar.days must be an integer from 1 to ${max} on the ${view} view` };
    }
    out.days = data.days;
  }
  let today: TimeValue | undefined;
  if (data.today !== undefined) {
    const read = readTime(data.today, ['date'], 'calendar.today');
    if (!read.ok) return read;
    today = read.time;
    out.today = data.today;
  }
  if (data.now !== undefined) {
    const read = readTime(data.now, ['wall'], 'calendar.now');
    if (!read.ok) return read;
    if (today && read.time.dayNumber !== today.dayNumber) return { ok: false, error: 'calendar.now must fall on calendar.today' };
    out.now = data.now;
  }

  if (!Array.isArray(data.events) || data.events.length > MAX_CALENDAR_EVENTS) {
    return { ok: false, error: `calendar.events must be an array of at most ${MAX_CALENDAR_EVENTS} items` };
  }
  const seen = new Set<string>();
  const events: CalendarEvent[] = [];
  for (const e of data.events) {
    const res = validateCalendarEvent(e, seen);
    if (!res.ok) return res;
    events.push(res.event);
  }
  out.events = events;

  const err = copyFrameText(data, out, 'calendar');
  if (err) return { ok: false, error: err };
  return { ok: true, data: out as unknown as CalendarData };
}

const MAX_TASKS = 100;
const TASK_STATES = ['todo', 'active', 'done', 'blocked'];
const TASK_PRIORITIES = ['high', 'low'];
const MAX_TASK_TAGS = 4;
const MAX_TASK_TAG_UTF16 = 32;

function validateTask(t: unknown, seen: Set<string>): { ok: true; task: TaskItem } | { ok: false; error: string } {
  if (!isRecord(t)) return { ok: false, error: 'task must be an object' };
  const unknownKey = checkUnknownKeys(t, new Set(['id', 'text', 'state', 'due', 'priority', 'group', 'detail', 'tags']), 'task');
  if (unknownKey) return { ok: false, error: unknownKey };
  const id = checkItemId(t.id, seen, 'task');
  if (!id.ok) return id;
  const textErr = checkString(t.text, 256, 'task.text');
  if (textErr) return { ok: false, error: textErr };
  const out: Fields = { id: id.id, text: t.text };
  const stateErr = copyOptionalName(t, out, 'state', TASK_STATES, 'task.state');
  if (stateErr) return { ok: false, error: stateErr };
  if (t.due !== undefined) {
    const due = readTime(t.due, ['date', 'wall'], 'task.due');
    if (!due.ok) return due;
    out.due = t.due;
  }
  const err =
    copyOptionalName(t, out, 'priority', TASK_PRIORITIES, 'task.priority') ??
    copyOptionalString(t, out, 'group', 128, 'task.group') ??
    copyOptionalString(t, out, 'detail', 256, 'task.detail');
  if (err) return { ok: false, error: err };
  if (t.tags !== undefined) {
    if (!Array.isArray(t.tags) || t.tags.length > MAX_TASK_TAGS) {
      return { ok: false, error: `task.tags must be an array of at most ${MAX_TASK_TAGS} strings` };
    }
    for (const tag of t.tags) {
      const tagErr = checkString(tag, MAX_TASK_TAG_UTF16, 'task tag');
      if (tagErr) return { ok: false, error: tagErr };
    }
    out.tags = t.tags;
  }
  return { ok: true, task: out as unknown as TaskItem };
}

function validateTasksData(data: Fields): { ok: true; data: TasksData } | { ok: false; error: string } {
  const unknownKey = checkUnknownKeys(data, new Set(['title', 'subtitle', 'context', 'caption', 'today', 'items']), 'tasks data');
  if (unknownKey) return { ok: false, error: unknownKey };
  const out: Fields = {};
  if (data.today !== undefined) {
    const today = readTime(data.today, ['date'], 'tasks.today');
    if (!today.ok) return today;
    out.today = data.today;
  }
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > MAX_TASKS) {
    return { ok: false, error: `tasks.items must be an array of 1 to ${MAX_TASKS} items` };
  }
  const seen = new Set<string>();
  const items: TaskItem[] = [];
  for (const t of data.items) {
    const res = validateTask(t, seen);
    if (!res.ok) return res;
    items.push(res.task);
  }
  out.items = items;
  const err = copyFrameText(data, out, 'tasks');
  if (err) return { ok: false, error: err };
  return { ok: true, data: out as unknown as TasksData };
}

const MAX_TIMERS = 8;
const TIMER_STATES = ['running', 'paused'];

function validateTimer(t: unknown, seen: Set<string>): { ok: true; timer: Timer } | { ok: false; error: string } {
  if (!isRecord(t)) return { ok: false, error: 'timer must be an object' };
  const unknownKey = checkUnknownKeys(t, new Set(['id', 'label', 'endsAt', 'startedAt', 'state', 'remaining']), 'timer');
  if (unknownKey) return { ok: false, error: unknownKey };
  const id = checkItemId(t.id, seen, 'timer');
  if (!id.ok) return id;
  const labelErr = checkString(t.label, 128, 'timer.label');
  if (labelErr) return { ok: false, error: labelErr };
  const endsAt = readTime(t.endsAt, ['instant'], 'timer.endsAt');
  if (!endsAt.ok) return endsAt;
  const out: Fields = { id: id.id, label: t.label, endsAt: t.endsAt };
  if (t.startedAt !== undefined) {
    const startedAt = readTime(t.startedAt, ['instant'], 'timer.startedAt');
    if (!startedAt.ok) return startedAt;
    if (compareTimeValues(startedAt.time, endsAt.time) >= 0) {
      return { ok: false, error: 'timer.startedAt must be before timer.endsAt' };
    }
    out.startedAt = t.startedAt;
  }
  const stateErr = copyOptionalName(t, out, 'state', TIMER_STATES, 'timer.state');
  if (stateErr) return { ok: false, error: stateErr };
  // A running timer is counted down on the page clock; a paused one is not,
  // so it says how much is left, and a running one may not.
  const paused = t.state === 'paused';
  if (t.remaining === undefined) {
    if (paused) return { ok: false, error: 'timer.remaining is required when the timer is paused' };
  } else {
    if (!paused) return { ok: false, error: 'timer.remaining is only for a paused timer' };
    if (typeof t.remaining !== 'number' || !Number.isFinite(t.remaining) || t.remaining < 0) {
      return { ok: false, error: 'timer.remaining must be a number of seconds, 0 or more' };
    }
    out.remaining = t.remaining;
  }
  return { ok: true, timer: out as unknown as Timer };
}

function validateTimerData(data: Fields): { ok: true; data: TimerData } | { ok: false; error: string } {
  const unknownKey = checkUnknownKeys(data, new Set(['title', 'subtitle', 'context', 'caption', 'timers']), 'timer data');
  if (unknownKey) return { ok: false, error: unknownKey };
  if (!Array.isArray(data.timers) || data.timers.length < 1 || data.timers.length > MAX_TIMERS) {
    return { ok: false, error: `timer.timers must be an array of 1 to ${MAX_TIMERS} items` };
  }
  const seen = new Set<string>();
  const timers: Timer[] = [];
  for (const t of data.timers) {
    const res = validateTimer(t, seen);
    if (!res.ok) return res;
    timers.push(res.timer);
  }
  const out: Fields = { timers };
  const err = copyFrameText(data, out, 'timer');
  if (err) return { ok: false, error: err };
  return { ok: true, data: out as unknown as TimerData };
}

const WEATHER_CONDITIONS = [
  'clear', 'partly-cloudy', 'cloudy', 'fog', 'drizzle', 'rain', 'heavy-rain', 'thunder', 'snow', 'sleet', 'hail', 'wind', 'haze',
];
const WEATHER_UNITS = ['C', 'F'];
const MAX_WEATHER_HOURS = 48;
const MAX_WEATHER_DAYS = 14;

function copyCondition(data: Fields, out: Fields, field: string): string | null {
  if (!isName(data.condition, WEATHER_CONDITIONS)) return invalidName(field, WEATHER_CONDITIONS);
  out.condition = data.condition;
  return null;
}

function validateWeatherCurrent(c: unknown): { ok: true; current: WeatherCurrent } | { ok: false; error: string } {
  if (!isRecord(c)) return { ok: false, error: 'weather.current must be an object' };
  const unknownKey = checkUnknownKeys(
    c,
    new Set(['temp', 'condition', 'summary', 'high', 'low', 'feelsLike', 'humidity', 'precip', 'wind']),
    'weather current',
  );
  if (unknownKey) return { ok: false, error: unknownKey };
  const out: Fields = {};
  const err =
    copyNumber(c, out, 'temp', 'weather current.temp', true) ??
    copyCondition(c, out, 'weather current.condition') ??
    copyOptionalString(c, out, 'summary', 256, 'weather current.summary') ??
    copyNumber(c, out, 'high', 'weather current.high', false) ??
    copyNumber(c, out, 'low', 'weather current.low', false) ??
    copyNumber(c, out, 'feelsLike', 'weather current.feelsLike', false) ??
    copyOptionalPercent(c, out, 'humidity', 'weather current.humidity') ??
    copyOptionalPercent(c, out, 'precip', 'weather current.precip') ??
    copyOptionalString(c, out, 'wind', 128, 'weather current.wind');
  if (err) return { ok: false, error: err };
  return { ok: true, current: out as unknown as WeatherCurrent };
}

function validateWeatherHour(h: unknown, seen: Set<string>): { ok: true; hour: WeatherHour } | { ok: false; error: string } {
  if (!isRecord(h)) return { ok: false, error: 'weather hour must be an object' };
  const unknownKey = checkUnknownKeys(h, new Set(['time', 'temp', 'condition', 'precip']), 'weather hour');
  if (unknownKey) return { ok: false, error: unknownKey };
  const time = readTime(h.time, ['wall'], 'weather hour.time');
  if (!time.ok) return time;
  // A note names an hour by its time, so no two hours share one.
  if (seen.has(h.time as string)) return { ok: false, error: `duplicate weather hour: ${h.time as string}` };
  seen.add(h.time as string);
  const out: Fields = { time: h.time };
  const err =
    copyNumber(h, out, 'temp', 'weather hour.temp', true) ??
    copyCondition(h, out, 'weather hour.condition') ??
    copyOptionalPercent(h, out, 'precip', 'weather hour.precip');
  if (err) return { ok: false, error: err };
  return { ok: true, hour: out as unknown as WeatherHour };
}

function validateWeatherDay(d: unknown, seen: Set<string>): { ok: true; day: WeatherDay } | { ok: false; error: string } {
  if (!isRecord(d)) return { ok: false, error: 'weather day must be an object' };
  const unknownKey = checkUnknownKeys(d, new Set(['date', 'high', 'low', 'condition', 'precip']), 'weather day');
  if (unknownKey) return { ok: false, error: unknownKey };
  const date = readTime(d.date, ['date'], 'weather day.date');
  if (!date.ok) return date;
  // A note names a day by its date, so no two days share one.
  if (seen.has(d.date as string)) return { ok: false, error: `duplicate weather day: ${d.date as string}` };
  seen.add(d.date as string);
  const out: Fields = { date: d.date };
  const err =
    copyNumber(d, out, 'high', 'weather day.high', true) ??
    copyNumber(d, out, 'low', 'weather day.low', true) ??
    copyCondition(d, out, 'weather day.condition') ??
    copyOptionalPercent(d, out, 'precip', 'weather day.precip');
  if (err) return { ok: false, error: err };
  return { ok: true, day: out as unknown as WeatherDay };
}

function validateWeatherData(data: Fields): { ok: true; data: WeatherData } | { ok: false; error: string } {
  const unknownKey = checkUnknownKeys(
    data,
    new Set(['title', 'subtitle', 'context', 'caption', 'location', 'units', 'current', 'today', 'hourly', 'daily', 'alert']),
    'weather data',
  );
  if (unknownKey) return { ok: false, error: unknownKey };
  const locationErr = checkString(data.location, 128, 'weather.location');
  if (locationErr) return { ok: false, error: locationErr };
  if (!isName(data.units, WEATHER_UNITS)) return { ok: false, error: invalidName('weather.units', WEATHER_UNITS) };
  const current = validateWeatherCurrent(data.current);
  if (!current.ok) return current;
  const out: Fields = { location: data.location, units: data.units, current: current.current };
  // The day the forecast is read on, as calendar, tasks and inbox take it:
  // the page has no clock of its own to tell it.
  if (data.today !== undefined) {
    const today = readTime(data.today, ['date'], 'weather.today');
    if (!today.ok) return today;
    out.today = data.today;
  }
  if (data.hourly !== undefined) {
    if (!Array.isArray(data.hourly) || data.hourly.length > MAX_WEATHER_HOURS) {
      return { ok: false, error: `weather.hourly must be an array of at most ${MAX_WEATHER_HOURS} items` };
    }
    const seen = new Set<string>();
    const hourly: WeatherHour[] = [];
    for (const h of data.hourly) {
      const res = validateWeatherHour(h, seen);
      if (!res.ok) return res;
      hourly.push(res.hour);
    }
    out.hourly = hourly;
  }
  if (data.daily !== undefined) {
    if (!Array.isArray(data.daily) || data.daily.length > MAX_WEATHER_DAYS) {
      return { ok: false, error: `weather.daily must be an array of at most ${MAX_WEATHER_DAYS} items` };
    }
    const seen = new Set<string>();
    const daily: WeatherDay[] = [];
    for (const d of data.daily) {
      const res = validateWeatherDay(d, seen);
      if (!res.ok) return res;
      daily.push(res.day);
    }
    out.daily = daily;
  }
  const err = copyOptionalString(data, out, 'alert', 256, 'weather.alert') ?? copyFrameText(data, out, 'weather');
  if (err) return { ok: false, error: err };
  return { ok: true, data: out as unknown as WeatherData };
}

const MAX_INBOX_MESSAGES = 50;
const MAX_INBOX_CHANNEL_UTF16 = 32;

function validateInboxMessage(m: unknown, seen: Set<string>): { ok: true; message: InboxMessage } | { ok: false; error: string } {
  if (!isRecord(m)) return { ok: false, error: 'inbox message must be an object' };
  const unknownKey = checkUnknownKeys(
    m,
    new Set(['id', 'from', 'subject', 'snippet', 'time', 'channel', 'unread', 'flagged', 'semantic']),
    'inbox message',
  );
  if (unknownKey) return { ok: false, error: unknownKey };
  const id = checkItemId(m.id, seen, 'inbox message');
  if (!id.ok) return id;
  const fromErr = checkString(m.from, 128, 'inbox message.from');
  if (fromErr) return { ok: false, error: fromErr };
  const out: Fields = { id: id.id, from: m.from };
  const textErr =
    copyOptionalString(m, out, 'subject', 256, 'inbox message.subject') ??
    copyOptionalString(m, out, 'snippet', 256, 'inbox message.snippet');
  if (textErr) return { ok: false, error: textErr };
  const time = readTime(m.time, ['date', 'wall'], 'inbox message.time');
  if (!time.ok) return time;
  out.time = m.time;
  const err =
    copyOptionalString(m, out, 'channel', MAX_INBOX_CHANNEL_UTF16, 'inbox message.channel') ??
    copyOptionalBoolean(m, out, 'unread', 'inbox message.unread') ??
    copyOptionalBoolean(m, out, 'flagged', 'inbox message.flagged') ??
    copyOptionalName(m, out, 'semantic', SEMANTICS, 'inbox message.semantic');
  if (err) return { ok: false, error: err };
  return { ok: true, message: out as unknown as InboxMessage };
}

function validateInboxData(data: Fields): { ok: true; data: InboxData } | { ok: false; error: string } {
  const unknownKey = checkUnknownKeys(data, new Set(['title', 'subtitle', 'context', 'caption', 'today', 'messages']), 'inbox data');
  if (unknownKey) return { ok: false, error: unknownKey };
  const out: Fields = {};
  if (data.today !== undefined) {
    const today = readTime(data.today, ['date'], 'inbox.today');
    if (!today.ok) return today;
    out.today = data.today;
  }
  if (!Array.isArray(data.messages) || data.messages.length < 1 || data.messages.length > MAX_INBOX_MESSAGES) {
    return { ok: false, error: `inbox.messages must be an array of 1 to ${MAX_INBOX_MESSAGES} items` };
  }
  const seen = new Set<string>();
  const messages: InboxMessage[] = [];
  for (const m of data.messages) {
    const res = validateInboxMessage(m, seen);
    if (!res.ok) return res;
    messages.push(res.message);
  }
  out.messages = messages;
  const err = copyFrameText(data, out, 'inbox');
  if (err) return { ok: false, error: err };
  return { ok: true, data: out as unknown as InboxData };
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
      if (!isName(seg.semantic, SEMANTICS)) return { ok: false, error: invalidName('note segment.semantic', SEMANTICS) };
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
    const anchorUnknown = checkUnknownKeys(data.anchor, new Set(['target', 'x', 'series', 'node', 'item']), 'note anchor');
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
    // An item inside the target, named as the item names itself: an id, or
    // a forecast hour's `time` or day's `date`. Like `node` and `series`, it
    // is not looked up here: the note and its target are separate objects,
    // and the page marks the item only when the target has one of that name.
    if (data.anchor.item !== undefined) {
      const item = data.anchor.item;
      if (typeof item !== 'string' || isBlank(item) || item.length > MAX_ID_UTF16) {
        return { ok: false, error: `note.anchor.item must be non-empty and <= ${MAX_ID_UTF16} UTF-16 code units` };
      }
      anchor.item = item;
    }
    result.anchor = anchor;
  }

  return { ok: true, data: result };
}

/**
 * The byte cap an action is held to. An image action is the one kind allowed
 * past the general cap; its own fields are capped in validateImageData, so
 * nothing else can ride in under its limit.
 */
function actionSizeCap(value: Record<string, unknown>): number {
  return value.op === 'show' && value.type === 'image' ? MAX_IMAGE_ACTION_BYTES : MAX_ACTION_BYTES;
}

/**
 * Checks one display action and returns it normalized. The order of the
 * checks is the backend's too (docs/display-tool.md, "How the two
 * validators agree"): an object, within its size cap, with a known `op`;
 * then no layout key, no unsafe string and no non-finite number anywhere in
 * it; then the op's own rules; and last the normalized action, which may
 * have gained a field (a say's `at: null`), is held to the same cap.
 */
export function validateControllerAction(value: unknown): ActionValidationResult {
  const result = validateActionFields(value);
  if (result.ok && isRecord(value) && serializedSize(result.action) > actionSizeCap(value)) {
    return { ok: false, error: 'action exceeds size limit' };
  }
  return result;
}

function validateActionFields(value: unknown): ActionValidationResult {
  if (!isRecord(value)) return { ok: false, error: 'action must be an object' };
  if (serializedSize(value) > actionSizeCap(value)) return { ok: false, error: 'action exceeds size limit' };
  if (!isName(value.op, OPERATIONS)) {
    return { ok: false, error: invalidName('op', OPERATIONS) };
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

      if (!isName(value.type, OBJECT_TYPES)) {
        return { ok: false, error: invalidName('show.type', OBJECT_TYPES) };
      }

      if (value.role !== undefined && !isName(value.role, ROLES)) {
        return { ok: false, error: invalidName('show.role', ROLES) };
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
        case 'calendar': {
          const res = validateCalendarData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'tasks': {
          const res = validateTasksData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'timer': {
          const res = validateTimerData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'weather': {
          const res = validateWeatherData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'inbox': {
          const res = validateInboxData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        default:
          return { ok: false, error: invalidName('show.type', OBJECT_TYPES) };
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
      return { ok: false, error: invalidName('op', OPERATIONS) };
  }
}

export function assertControllerAction(value: unknown): DisplayAction {
  const result = validateControllerAction(value);
  if (!result.ok) throw new TypeError(`Invalid Switchboard action: ${result.error}`);
  return result.action;
}

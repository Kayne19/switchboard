import type {
  ChartData,
  ChartSeries,
  CodeData,
  DiagramData,
  DiagramEdge,
  DiagramNode,
  DisplayAction,
  DocumentData,
  MetricData,
  NoteData,
  ProgressData,
  RichSegment,
  SceneObjectRole,
  Semantic,
  SpeechState,
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
  'note',
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

const MAX_ID_UTF16 = 128;
const MAX_TEXT_UTF16 = 50_000;
const MAX_ACTION_BYTES = 48_000;
const RESERVED_ID_PREFIX = '__runtime/';

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
  const allowed = new Set(['title', 'subtitle', 'context', 'caption', 'xLabel', 'yLabel', 'xMax', 'yMin', 'yMax', 'series', 'marker', 'compareLabel']);
  const unknownKey = checkUnknownKeys(data, allowed, 'chart data');
  if (unknownKey) return { ok: false, error: unknownKey };

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
  const allowed = new Set(['label', 'value', 'semantic', 'caption']);
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
  return {
    ok: true,
    data: result,
  };
}

function validateProgressData(data: Record<string, unknown>): { ok: true; data: ProgressData } | { ok: false; error: string } {
  const allowed = new Set(['label', 'detail', 'value', 'text', 'caption']);
  const unknownKey = checkUnknownKeys(data, allowed, 'progress data');
  if (unknownKey) return { ok: false, error: unknownKey };

  const labelErr = checkString(data.label, 128, 'progress.label');
  if (labelErr) return { ok: false, error: labelErr };

  if (typeof data.value !== 'number' || !Number.isFinite(data.value)) {
    return { ok: false, error: 'progress.value must be a finite number' };
  }
  const value = normalizeProgressValue(data.value);

  const result: ProgressData = {
    label: data.label as string,
    value,
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

function validateDiagramData(data: Record<string, unknown>): { ok: true; data: DiagramData } | { ok: false; error: string } {
  if ('source' in data) {
    return { ok: false, error: 'diagram data source field is forbidden in v1' };
  }
  const allowed = new Set(['title', 'subtitle', 'context', 'caption', 'mode', 'nodes', 'edges']);
  const unknownKey = checkUnknownKeys(data, allowed, 'diagram data');
  if (unknownKey) return { ok: false, error: unknownKey };

  if (data.mode !== 'graph') {
    return { ok: false, error: 'diagram.mode must be "graph"' };
  }

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
    const pairKey = `${e.from}-->${e.to}`;
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
  if (serializedSize(value) > MAX_ACTION_BYTES) return { ok: false, error: 'action exceeds size limit' };
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
        case 'note': {
          const res = validateNoteData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        default:
          return { ok: false, error: 'show.type is unknown' };
      }

      const action: DisplayAction = {
        op: 'show',
        id: idCheck.id,
        type: value.type as any,
        ...(value.role !== undefined ? { role: value.role as SceneObjectRole } : {}),
        data: validatedData as any,
      };
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

import type {
  ChartData,
  ChartKind,
  ChartSeries,
} from '../types';
import { SEMANTICS, checkString, checkUnknownKeys, copyFrameText, copyNumber, copyOptionalName, copyOptionalString, isRecord } from './shared';
import type { Fields } from './shared';

const CHART_KINDS: readonly ChartKind[] = ['line', 'bar', 'area', 'scatter'];
const MAX_CHART_LABELS = 100;
const MAX_CHART_LABEL_UTF16 = 64;

export function validateChartData(data: Record<string, unknown>): { ok: true; data: ChartData } | { ok: false; error: string } {
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
    for (const [index, label] of data.labels.entries()) {
      const err = checkString(label, MAX_CHART_LABEL_UTF16, `chart.labels[${index}]`);
      if (err) return { ok: false, error: err };
    }
    result.labels = data.labels as string[];
  }

  if (!Array.isArray(data.series)) {
    return { ok: false, error: 'chart.series must be an array' };
  }
  const seriesAllowed = new Set(['name', 'semantic', 'values']);
  // A series is known by its name (the legend, `marker.series`, a note's
  // `anchor.series`, `say at.series`), so no two may share one.
  const seriesNames = new Map<string, number>();
  for (const [index, s] of data.series.entries()) {
    if (!isRecord(s)) return { ok: false, error: 'chart series item must be an object' };
    const sUnknown = checkUnknownKeys(s, seriesAllowed, 'chart series item');
    if (sUnknown) return { ok: false, error: sUnknown };
    const nameErr = checkString(s.name, 128, 'series.name');
    if (nameErr) return { ok: false, error: nameErr };
    const name = s.name as string;
    const first = seriesNames.get(name);
    if (first !== undefined) {
      return { ok: false, error: `duplicate chart series name "${name}": chart.series[${first}] and chart.series[${index}]` };
    }
    seriesNames.set(name, index);
    if (!Array.isArray(s.values)) return { ok: false, error: 'series.values must be an array' };
    for (const v of s.values) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: 'series.values must contain finite numbers' };
    }
    if (result.labels && s.values.length > result.labels.length) {
      return {
        ok: false,
        error: `chart.series[${index}].values is longer than chart.labels (${s.values.length} values, ${result.labels.length} labels)`,
      };
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
  // Ends that leave no span draw an empty plot with every point off it.
  if (result.yMin !== undefined && result.yMax !== undefined && result.yMin >= result.yMax) {
    return { ok: false, error: 'chart.yMin must be below chart.yMax' };
  }
  if (data.marker !== undefined) {
    if (!isRecord(data.marker)) return { ok: false, error: 'chart.marker must be an object' };
    const markerAllowed = new Set(['x', 'series']);
    const mUnknown = checkUnknownKeys(data.marker, markerAllowed, 'chart marker');
    if (mUnknown) return { ok: false, error: mUnknown };
    const marker: Fields = {};
    const markerErr =
      copyNumber(data.marker, marker, 'x', 'chart.marker.x', true) ??
      copyOptionalString(data.marker, marker, 'series', 128, 'chart.marker.series');
    if (markerErr) return { ok: false, error: markerErr };
    result.marker = marker as NonNullable<ChartData['marker']>;
  }

  return { ok: true, data: result };
}

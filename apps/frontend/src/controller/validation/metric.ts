import type {
  MetricData,
  MetricTrend,
} from '../types';
import { SEMANTICS, checkString, checkUnknownKeys, copyOptionalName, copyOptionalString } from './shared';

const MAX_METRIC_DELTA_UTF16 = 32;
const METRIC_TRENDS: readonly MetricTrend[] = ['up', 'down', 'flat'];

export function validateMetricData(data: Record<string, unknown>): { ok: true; data: MetricData } | { ok: false; error: string } {
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

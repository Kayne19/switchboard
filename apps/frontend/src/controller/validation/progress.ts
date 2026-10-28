import type {
  ProgressData,
  ProgressStep,
} from '../types';
import { STEP_STATES, checkString, checkUnknownKeys, copyOptionalName, copyOptionalString, isRecord } from './shared';

/**
 * Progress values arrive as a percentage (0–100). Values outside
 * 0–100 are clamped to [0, 100], and rounded to two decimal places.
 */
export function normalizeProgressValue(value: number): number {
  const bounded = Math.min(100, Math.max(0, value));
  return Math.round(bounded * 100) / 100;
}

const MAX_PROGRESS_STEPS = 30;

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

export function validateProgressData(data: Record<string, unknown>): { ok: true; data: ProgressData } | { ok: false; error: string } {
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

// Plain words for the routing decisions the debug page shows.
import type { DebugConfig, JsonValue } from './protocol';

// One sentence for every value the service emits. The lists are the Rust
// `RouteRule::as_str` (router.rs) and the `pbx_branch` branches (pbx.rs,
// turns.rs); `debugExplain.test.ts` reads those sources and fails on a gap.
export const RULES: Record<string, string> = {
  stop_confirms: 'Stopping a project always asks the caller to confirm, whatever the confidence.',
  stayed_with_current:
    'On a project, Jev was sure the caller is still talking to the current agent (for_current_agent at or above the upper threshold), so the line stayed where it was.',
  current_agent_unsure:
    'On a project, Jev was unsure whether the caller is still talking to the current agent (for_current_agent between the lower and upper thresholds), so the routing utility gives a second opinion.',
  action_below_threshold: 'Jev’s action confidence was below the action threshold, so the routing utility gives a second opinion.',
  jev_action: 'Jev’s action confidence met the action threshold, so the PBX acted on Jev’s answer directly.',
  jev_unavailable: 'Jev gave no usable answer (timeout, error, or an invalid answer), so the router used its explicit fallback.',
};

export const BRANCHES: Record<string, string> = {
  stop_confirmed: 'The caller confirmed a stop; the project leg is ended.',
  stop_asked: 'A stop was requested; the switchboard asks the caller to confirm first.',
  take_over: 'The caller takes over a desk session.',
  answer_waiting: 'The caller is answering an agent that is waiting on them.',
  utility: 'The PBX asked the routing utility for a second opinion or a split.',
  multi_unresolved: 'The routing utility could not split a multi-target line, so the operator asks the caller.',
  go_to_project: 'A transfer to a project leg.',
  continue_current: 'The line continues on the current leg.',
  operator: 'The operator (front desk) handles the line.',
  refused_unknown_target:
    'The chosen target is not a registered project, so the switchboard refused it: the line went to the operator, or that split part was dropped.',
  dropped_stale: 'A newer generation discarded this line, or a page rescue cancelled its turn; its trace ends here.',
  failed: 'The turn worker failed, so nothing answered this line; its trace ends here.',
};

/** Branches that end a trace: with no `routed`, or after one when a rescue
 * cancelled the routed turn. */
export const TERMINAL_BRANCHES: Record<string, string> = {
  dropped_stale: 'dropped (stale generation)',
  failed: 'failed',
};

export function ruleText(rule: string): string {
  return RULES[rule] ?? `Rule “${rule}”.`;
}

export function branchText(branch: string): string {
  return BRANCHES[branch] ?? `Branch “${branch}”.`;
}

export interface AnswerBar {
  label: string;
  value: number;
  selected: boolean;
}

export interface AnswerMarker {
  value: number;
  label: string;
}

/** One Jev question's answer, ready to draw as bars. */
export interface AnswerRow {
  question: string;
  selected?: string;
  confidence?: number;
  noul?: number;
  bars: AnswerBar[];
  markers: AnswerMarker[];
  /** Whether the thresholds that apply to this question were met, in words. */
  verdict?: string;
}

const asObject = (value: JsonValue | undefined): Record<string, JsonValue> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const asNumber = (value: JsonValue | undefined): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * Turn a Jev `answers` object into rows. Jev names the chosen option
 * `choice`; the fixture's older shape says `selected`, so both are read.
 */
export function answerRows(answers: JsonValue, config: DebugConfig | null): AnswerRow[] {
  const object = asObject(answers);
  if (!object) return [];
  return Object.entries(object).map(([question, raw]) => {
    const answer = asObject(raw) ?? {};
    const selected = typeof answer.choice === 'string' ? answer.choice : typeof answer.selected === 'string' ? answer.selected : undefined;
    const probabilities = asObject(answer.probabilities) ?? {};
    const bars = Object.entries(probabilities)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value, selected: label === selected }));
    const confidence = asNumber(answer.confidence) ?? (selected !== undefined ? (probabilities[selected] as number | undefined) : undefined);
    const noul = asNumber(answer.noul);
    const markers: AnswerMarker[] = [];
    let verdict: string | undefined;
    if (config && question === 'action' && confidence !== undefined) {
      markers.push({ value: config.jev_action_threshold, label: 'action' });
      verdict =
        confidence >= config.jev_action_threshold
          ? `confidence ${confidence.toFixed(2)} ≥ action threshold ${config.jev_action_threshold.toFixed(2)}`
          : `confidence ${confidence.toFixed(2)} < action threshold ${config.jev_action_threshold.toFixed(2)}: unsure`;
    }
    if (config && question === 'for_current_agent' && noul !== undefined) {
      markers.push({ value: config.jev_for_current_agent_lower, label: 'lower' }, { value: config.jev_for_current_agent_upper, label: 'upper' });
      const { jev_for_current_agent_lower: lower, jev_for_current_agent_upper: upper } = config;
      verdict =
        noul >= upper
          ? `${noul.toFixed(2)} ≥ upper ${upper.toFixed(2)}: stays with the current agent`
          : noul > lower
            ? `${noul.toFixed(2)} between ${lower.toFixed(2)} and ${upper.toFixed(2)}: unsure, ask the utility`
            : `${noul.toFixed(2)} ≤ lower ${lower.toFixed(2)}: not for the current agent`;
    }
    if (question === 'multi_target' && noul !== undefined) {
      markers.push({ value: 0.5, label: 'multi' });
      verdict = noul >= 0.5 ? 'names more than one target' : 'one target';
    }
    return { question, selected, confidence, noul, bars, markers, verdict };
  });
}

/** A one-line summary of a utility decision object. */
export function decisionSummary(decision: JsonValue | undefined): string {
  const object = asObject(decision);
  if (!object) return decision === undefined ? 'pending' : JSON.stringify(decision);
  switch (object.kind) {
    case 'second_opinion':
      return `second opinion → ${String(object.target ?? '?')} (${String(object.mode ?? '?')}${object.confident === false ? ', not confident' : object.confident === true ? ', confident' : ''})`;
    case 'dispatch_parts': {
      const parts = Array.isArray(object.parts) ? object.parts : [];
      return `dispatch ${parts.length} part${parts.length === 1 ? '' : 's'} → ${parts.map((part) => String(asObject(part)?.project ?? '?')).join(', ')}`;
    }
    case 'none':
      return 'no decision';
    case 'error':
      return `error: ${String(object.error ?? object.message ?? 'unknown')}`;
    default:
      return JSON.stringify(object);
  }
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function clockTime(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** A short single-line preview of any JSON value. */
export function preview(value: JsonValue | undefined, limit = 80): string {
  if (value === undefined) return '';
  let text: string;
  const object = asObject(value);
  if (object && object.clipped === true) {
    // The backend's stand-in for a value too large to forward.
    text = `[clipped ${String(object.bytes ?? '?')} B] ${typeof object.preview === 'string' ? object.preview : ''}`;
  } else if (object) {
    text = Object.entries(object)
      .map(([key, entry]) => `${key}=${typeof entry === 'string' ? entry : JSON.stringify(entry)}`)
      .join(' ');
  } else {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  }
  text = text.replace(/\s+/g, ' ');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

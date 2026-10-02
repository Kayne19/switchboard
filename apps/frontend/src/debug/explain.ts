// Plain words for the routing decisions the debug page shows.
import type { DebugConfig, JsonValue } from './protocol';

const RULES: Record<string, string> = {
  stayed_with_current:
    'Jev was sure the caller is still talking to the current agent (for_current_agent at or above the upper threshold), so the line stayed where it was.',
  jev_action: 'Jev’s action answer met the action threshold, so the PBX acted on Jev’s answer directly.',
  asked_llm:
    'Jev was unsure (for_current_agent between the lower and upper thresholds, or action confidence below the action threshold), so the decision went to the utility LLM.',
  jev_unavailable: 'Jev did not answer (timeout or error), so the router used its explicit fallback.',
  stop_confirms: 'Stopping a project always asks the caller to confirm, whatever the confidence.',
};

const BRANCHES: Record<string, string> = {
  stop_confirmed: 'The caller confirmed a stop; the project leg is ended.',
  stop_asked: 'A stop was requested; the operator asks the caller to confirm first.',
  take_over: 'The caller takes over the waiting agent’s pending request.',
  answer_waiting: 'The caller is answering an agent that is waiting on them.',
  utility: 'The PBX asked the utility LLM for a second opinion or a split.',
  multi_unresolved_to_operator: 'The utility could not resolve the target, so the operator (front desk) handles it.',
  go_to_project: 'A transfer to a project leg.',
  continue_current: 'The utterance continues on the current leg.',
  operator: 'The operator (front desk) handles the utterance.',
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
            ? `${noul.toFixed(2)} between ${lower.toFixed(2)} and ${upper.toFixed(2)}: unsure, ask the LLM`
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

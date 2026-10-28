import type {
  ProgressStepState,
  Semantic,
} from '../types';
import { RUNTIME_ID_PREFIX } from '../types';

export const SEMANTICS: readonly Semantic[] = ['red', 'orange', 'green', 'cyan', 'amber', 'paper', 'muted'];

export const MAX_ID_UTF16 = 128;
/** A progress step's state and a diagram node's state. */
export const STEP_STATES: readonly ProgressStepState[] = ['done', 'active', 'todo', 'blocked'];

/**
 * The one refusal of a name outside its set, required or optional alike
 * (docs/display-tool.md, "How the two validators agree"): the field and
 * every name it takes, so an agent can mend the action from the error
 * alone. The backend's `invalid_name` writes the same text.
 */
export function invalidName(field: string, allowed: readonly string[]): string {
  return `invalid ${field}: expected one of ${allowed.join(', ')}`;
}

/** Whether `value` is one of `allowed`: a string, and in the set. */
export function isName<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export function checkIdentifier(val: unknown, fieldName: string): { ok: true; id: string } | { ok: false; error: string } {
  if (typeof val !== 'string' || isBlank(val)) {
    return { ok: false, error: `${fieldName} must be a non-empty identifier` };
  }
  if (val.length > MAX_ID_UTF16) {
    return { ok: false, error: `${fieldName} exceeds maximum length of ${MAX_ID_UTF16} UTF-16 code units` };
  }
  if (val.startsWith(RUNTIME_ID_PREFIX)) {
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
export function keysInOrder(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort(compareCodePoints);
}

export function checkUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>, context: string): string | null {
  for (const key of keysInOrder(obj)) {
    if (!allowed.has(key)) {
      return `unknown field in ${context}: ${key}`;
    }
  }
  return null;
}

export function checkString(val: unknown, maxLen: number, name: string): string | null {
  if (typeof val !== 'string') return `${name} must be a string`;
  if (val.length > maxLen) return `${name} exceeds maximum length of ${maxLen} UTF-16 code units`;
  return null;
}

// ---- field helpers ---------------------------------------------------------
//
// The checks the type validators share: each reads one field and copies it
// into the result when it passes (checkItemId returns the id instead), and
// otherwise returns its error text. A result is a typed one (`ChartData`,
// `DiagramNode`, ...), whose type names the keys a helper may write, or
// `Fields`. The backend's validators have their own set
// (`copy_optional_string` and the rest).

/** A JSON object as a validator reads it, or a result built key by key and cast once it is whole. */
export type Fields = Record<string, unknown>;

/** The four scene-frame strings most types carry, each optional. */
interface FrameText {
  title?: string;
  subtitle?: string;
  context?: string;
  caption?: string;
}

/**
 * The scene-frame strings, in this order: title, subtitle and context (256
 * units), then caption (128). Most types check them last.
 */
export function copyFrameText(data: Fields, out: FrameText, kind: string): string | null {
  for (const key of ['title', 'subtitle', 'context'] as const) {
    const err = copyOptionalString(data, out, key, 256, `${kind}.${key}`);
    if (err) return err;
  }
  return copyOptionalString(data, out, 'caption', 128, `${kind}.caption`);
}

export function copyOptionalString<T extends object>(data: Fields, out: T, key: keyof T & string, maxLen: number, field: string): string | null {
  if (data[key] === undefined) return null;
  const err = checkString(data[key], maxLen, field);
  if (err) return err;
  (out as Fields)[key] = data[key];
  return null;
}

export function copyOptionalBoolean<T extends object>(data: Fields, out: T, key: keyof T & string, field: string): string | null {
  if (data[key] === undefined) return null;
  if (typeof data[key] !== 'boolean') return `${field} must be boolean`;
  (out as Fields)[key] = data[key];
  return null;
}

/** An optional name from `allowed`; anything else, `null` included, is `invalidName`'s refusal. */
export function copyOptionalName<T extends object>(data: Fields, out: T, key: keyof T & string, allowed: readonly string[], field: string): string | null {
  const value = data[key];
  if (value === undefined) return null;
  if (!isName(value, allowed)) return invalidName(field, allowed);
  (out as Fields)[key] = value;
  return null;
}

export function copyNumber<T extends object>(data: Fields, out: T, key: keyof T & string, field: string, required: boolean): string | null {
  const value = data[key];
  if (value === undefined && !required) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${field} must be a finite number`;
  (out as Fields)[key] = value;
  return null;
}

/**
 * An item's id: non-blank, within the id cap, and the first of its name in `seen`.
 * Each id of a calendar, to-do list, timer, forecast or inbox item goes through
 * it, as a diagram node or actor id does (docs/display-tool.md,
 * "Personal-assistant types"); the backend's validators hold the same rules in
 * the same order.
 */
export function checkItemId(value: unknown, seen: Set<string>, context: string): { ok: true; id: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || isBlank(value) || value.length > MAX_ID_UTF16) {
    return { ok: false, error: `${context} id must be non-empty and <= ${MAX_ID_UTF16} UTF-16 code units` };
  }
  if (seen.has(value)) return { ok: false, error: `duplicate ${context} id: ${value}` };
  seen.add(value);
  return { ok: true, id: value };
}

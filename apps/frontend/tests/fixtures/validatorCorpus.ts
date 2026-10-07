// The shared validator corpus, validator-corpus.json beside this file, as the
// page's tests read it. The backend's test_visual_protocol.rs reads the same
// file (`agrees_with_the_shared_validator_corpus`).
//
// The file is read with JSON.parse, as the page reads a display frame, rather
// than imported: a JSON import becomes an object literal, which would take a
// `__proto__` key for the prototype.
import { readFileSync } from 'node:fs';

export interface CorpusCase {
  name: string;
  action: unknown;
  /** The exact error both validators give, when they refuse the action. */
  error?: string;
  /** Present when both accept it. */
  accepted?: true;
  /** The validated action, when it is not the action as sent. */
  normalized?: unknown;
}

export const corpusCases: CorpusCase[] = (
  JSON.parse(readFileSync(new URL('./validator-corpus.json', import.meta.url), 'utf8')) as { cases: CorpusCase[] }
).cases;

/**
 * `{"$repeat": s, "times": n}` stands for `s` repeated `n` times, so a case
 * at a length cap stays one readable line; the backend expands it the same
 * way. Keys are copied as own data properties, in the order sent.
 */
export function expandCorpusValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expandCorpusValue);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 2 && typeof record.$repeat === 'string' && typeof record.times === 'number') {
    return record.$repeat.repeat(record.times);
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    Object.defineProperty(out, key, { value: expandCorpusValue(record[key]), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

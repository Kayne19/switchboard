import { describe, expect, it } from 'vitest';
import type { AgentObjectType, DisplayAction } from '../../src/controller/types';
import { validateControllerAction } from '../../src/controller/validation';
import { corpusCases, expandCorpusValue as expand } from '../fixtures/validatorCorpus';

// The two validators agree rule for rule (AGENTS.md). Each case in
// validator-corpus.json is an action and what both must make of it: the
// exact error, or acceptance with the normalized action (`normalized`, when
// it is not the action as sent). The backend's test_visual_protocol.rs runs
// the same file (`agrees_with_the_shared_validator_corpus`).

// Every op and every show type, as the compiler knows them: a new one fails
// to compile here until the corpus has cases for it.
const OPS: Record<DisplayAction['op'], true> = { show: true, hide: true, focus: true, say: true, clear: true };
const TYPES: Record<AgentObjectType, true> = {
  chart: true, metric: true, progress: true, diagram: true, document: true, code: true, table: true, note: true, image: true,
};

describe('the shared validator corpus', () => {
  it('holds uniquely named cases that each name one outcome', () => {
    const names = new Set<string>();
    for (const testCase of corpusCases) {
      expect(names.has(testCase.name), testCase.name).toBe(false);
      names.add(testCase.name);
      expect(typeof testCase.error === 'string' || testCase.accepted === true, testCase.name).toBe(true);
      expect(testCase.error !== undefined && testCase.accepted !== undefined, testCase.name).toBe(false);
    }
  });

  it('accepts and refuses every op and every show type', () => {
    const covered = { accepted: new Set<string>(), refused: new Set<string>() };
    for (const testCase of corpusCases) {
      const action = testCase.action as { op?: unknown; type?: unknown } | null;
      if (typeof action !== 'object' || action === null || typeof action.op !== 'string') continue;
      const kind = action.op === 'show' && typeof action.type === 'string' ? `show ${action.type}` : action.op;
      covered[testCase.error === undefined ? 'accepted' : 'refused'].add(kind);
    }
    const wanted = [...Object.keys(OPS).filter((op) => op !== 'show'), ...Object.keys(TYPES).map((type) => `show ${type}`)];
    for (const outcome of ['accepted', 'refused'] as const) {
      expect(wanted.filter((kind) => !covered[outcome].has(kind)), outcome).toEqual([]);
    }
  });

  for (const testCase of corpusCases) {
    it(testCase.name, () => {
      const result = validateControllerAction(expand(testCase.action));
      if (testCase.error !== undefined) {
        expect(result).toEqual({ ok: false, error: testCase.error });
        return;
      }
      expect(result).toEqual({ ok: true, action: expand(testCase.normalized ?? testCase.action) });
      // The page validates what the backend normalized: that passes unchanged.
      if (result.ok) expect(validateControllerAction(result.action)).toEqual(result);
    });
  }
});

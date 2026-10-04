import { describe, expect, it } from 'vitest';
import fixtures from '../fixtures/display-actions.json';
import {
  assertControllerAction,
  normalizeProgressValue,
  validateControllerAction,
} from '../../src/controller/validation';

describe('progress value normalization', () => {
  it('normalizes progress values as percentages clamped to 0-100', () => {
    expect(normalizeProgressValue(0)).toBe(0);
    expect(normalizeProgressValue(1)).toBe(1);
    expect(normalizeProgressValue(1.02)).toBe(1.02);
    expect(normalizeProgressValue(65)).toBe(65);
    expect(normalizeProgressValue(100)).toBe(100);
    expect(normalizeProgressValue(-5)).toBe(0);
    expect(normalizeProgressValue(150)).toBe(100);
  });

  // The backend's normalize_progress_value rounds the same way; its test
  // pins the same cases.
  it('rounds to two decimal places', () => {
    expect(normalizeProgressValue(33.333)).toBe(33.33);
    expect(normalizeProgressValue(66.666)).toBe(66.67);
  });

  it('rejects non-finite progress values in show actions', () => {
    for (const val of [NaN, Infinity, -Infinity]) {
      const result = validateControllerAction({
        op: 'show',
        id: 'deploy',
        type: 'progress',
        data: { label: 'DEPLOY', value: val },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/non-finite number/);
      }
    }
    const nonNumber = validateControllerAction({
      op: 'show',
      id: 'deploy',
      type: 'progress',
      data: { label: 'DEPLOY', value: 'not-a-number' as unknown as number },
    });
    expect(nonNumber.ok).toBe(false);
    if (!nonNumber.ok) {
      expect(nonNumber.error).toBe('progress.value must be a finite number');
    }
  });

  it('normalizes the value on validated show actions', () => {
    const result = validateControllerAction({
      op: 'show', id: 'deploy', type: 'progress',
      data: { label: 'DEPLOY', value: 65, text: '65% COMPLETE' },
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok && result.action.op === 'show') {
      expect((result.action.data as { value: number }).value).toBe(65);
    }
  });
});

describe('display protocol validation', () => {
  it('accepts and normalizes all canonical valid fixtures', () => {
    for (const testCase of fixtures.valid) {
      const result = validateControllerAction(testCase.action);
      expect(result.ok, `Expected valid fixture "${testCase.name}" to pass`).toBe(true);
      if (result.ok) {
        expect(result.action, `Normalized action for "${testCase.name}" should match`).toEqual(testCase.normalized);
      }
    }
  });

  it('rejects all canonical invalid fixtures', () => {
    for (const testCase of fixtures.invalid) {
      const result = validateControllerAction(testCase.action);
      expect(result.ok, `Expected invalid fixture "${testCase.name}" to be rejected`).toBe(false);
    }
  });

  it('rejects non-finite mutations (NaN, Infinity, -Infinity)', () => {
    for (const mutation of fixtures.nonFiniteMutations) {
      const cloned = JSON.parse(JSON.stringify(mutation.baseAction));
      let target: any = cloned;
      for (let i = 0; i < mutation.path.length - 1; i++) {
        target = target[mutation.path[i]];
      }
      const lastKey = mutation.path[mutation.path.length - 1];
      if (mutation.value === 'Infinity') {
        target[lastKey] = Number.POSITIVE_INFINITY;
      } else if (mutation.value === '-Infinity') {
        target[lastKey] = Number.NEGATIVE_INFINITY;
      } else if (mutation.value === 'NaN') {
        target[lastKey] = Number.NaN;
      }

      const result = validateControllerAction(cloned);
      expect(result.ok, `Expected non-finite mutation "${mutation.name}" to be rejected`).toBe(false);
    }
  });

  it('assertControllerAction returns action on valid input and throws on invalid input', () => {
    const valid = fixtures.valid[0].action;
    expect(() => assertControllerAction(valid)).not.toThrow();
    const action = assertControllerAction(valid);
    expect(action.op).toBe('show');

    expect(() => assertControllerAction({ op: 'listen', on: true })).toThrow(/unknown operation/);
    expect(() => assertControllerAction({ op: 'show', id: '__runtime/x', type: 'metric', data: { label: 'L', value: '1' } })).toThrow(/reserved identifier namespace/);
  });

  it('validates persistent note anchors and configurable captions', () => {
    const valid = validateControllerAction({
      op: 'show',
      id: 'spike-note',
      type: 'note',
      role: 'secondary',
      data: {
        tag: 'LOOK HERE',
        caption: 'ANNOTATION / VALIDATION SPIKE',
        segments: [{ text: 'Validation turns upward here.' }],
        anchor: { target: 'loss-chart', x: 32, series: 'VAL LOSS' },
      },
    });
    expect(valid).toEqual({
      ok: true,
      action: {
        op: 'show',
        id: 'spike-note',
        type: 'note',
        role: 'secondary',
        data: {
          tag: 'LOOK HERE',
          caption: 'ANNOTATION / VALIDATION SPIKE',
          segments: [{ text: 'Validation turns upward here.' }],
          anchor: { target: 'loss-chart', x: 32, series: 'VAL LOSS' },
        },
      },
    });

    expect(validateControllerAction({
      op: 'show', id: 'bad-note', type: 'note',
      data: { segments: [{ text: 'No target.' }], anchor: { x: 3 } },
    })).toMatchObject({ ok: false });
    expect(validateControllerAction({
      op: 'show', id: 'bad-note', type: 'note',
      data: { segments: [{ text: 'Reserved.' }], anchor: { target: '__runtime/conversation' } },
    })).toMatchObject({ ok: false });
  });
});

// The table rules the schema cannot state (docs/display-tool.md, "Table v1
// rules"). The backend's test_visual_protocol.rs pins the same cases.
describe('table validation', () => {
  const table = (data: Record<string, unknown>) => validateControllerAction({ op: 'show', id: 'results', type: 'table', data });
  const error = (data: Record<string, unknown>) => {
    const result = table(data);
    return result.ok ? null : result.error;
  };
  const two = [{ label: 'a' }, { label: 'b' }];
  const one = [{ label: 'a' }];

  it('requires every row to have one cell per column', () => {
    expect(table({ columns: two, rows: [['x', 1]] }).ok).toBe(true);
    expect(error({ columns: two, rows: [['x', 1], ['y']] })).toBe('table row 1 has 1 cells; the table has 2 columns');
    expect(error({ columns: two, rows: ['x'] })).toBe('table row 0 must be an array');
  });

  it('takes at most 200 rows', () => {
    const rows = (n: number) => Array.from({ length: n }, () => ['x']);
    expect(table({ columns: one, rows: rows(200) }).ok).toBe(true);
    expect(error({ columns: one, rows: rows(201) })).toBe('table.rows must be an array of at most 200 items');
    expect(error({ columns: one })).toBe('table.rows must be an array of at most 200 items');
  });

  it('requires highlight to name rows', () => {
    const rows = [['x'], ['y']];
    for (const index of [0, 1, 1.0]) {
      expect(table({ columns: one, rows, highlight: [index] }).ok).toBe(true);
    }
    for (const index of [2, -1, 0.5, '0']) {
      expect(error({ columns: one, rows, highlight: [index] })).toBe('table.highlight must contain row indices');
    }
  });

  it('accepts text, numbers and styled text as cells, and nothing else', () => {
    const data = { columns: one, rows: [['x'], [1.5], [{ text: 'y', semantic: 'red', bold: true }]] };
    const result = table(data);
    expect(result.ok).toBe(true);
    if (result.ok && result.action.op === 'show') expect(result.action.data).toEqual(data);
    const cases: Array<[unknown, string]> = [
      [true, 'table cell must be a string, a number or an object'],
      [null, 'table cell must be a string, a number or an object'],
      [{ semantic: 'red' }, 'table cell.text must be a string'],
      [{ text: 'y', semantic: 'pink' }, 'invalid table cell.semantic'],
      [{ text: 'y', bold: 'yes' }, 'table cell.bold must be boolean'],
      [{ text: 'y', align: 'right' }, 'unknown field in table cell: align'],
      ['x'.repeat(257), 'table cell exceeds maximum length of 256 UTF-16 code units'],
      [{ text: 'x'.repeat(257) }, 'table cell.text exceeds maximum length of 256 UTF-16 code units'],
    ];
    for (const [cell, message] of cases) {
      expect(error({ columns: one, rows: [[cell]] }), JSON.stringify(cell)).toBe(message);
    }
  });

  it('takes one to twelve labelled columns with no alignment of their own', () => {
    const columns = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `c${i}` }));
    expect(table({ columns: columns(12), rows: [] }).ok).toBe(true);
    for (const n of [0, 13]) {
      expect(error({ columns: columns(n), rows: [] })).toBe('table.columns must be an array of 1 to 12 items');
    }
    expect(error({ columns: [{ label: 'a', align: 'right' }], rows: [] })).toBe('unknown field in table column: align');
    expect(error({ columns: [{ label: 'x'.repeat(65) }], rows: [] })).toBe('table column.label exceeds maximum length of 64 UTF-16 code units');
  });
});

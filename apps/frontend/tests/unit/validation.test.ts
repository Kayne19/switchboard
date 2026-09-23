import { describe, expect, it } from 'vitest';
import fixtures from '../fixtures/display-actions.json';
import { assertControllerAction, validateControllerAction } from '../../src/controller/validation';

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

import { describe, expect, it } from 'vitest';
import { assertControllerAction, validateControllerAction } from '../../src/controller/validation';

describe('display protocol validation', () => {
  it('accepts the six semantic operations', () => {
    const actions = [
      { op: 'show', id: 'gpu', type: 'metric', data: { label: 'GPU', value: '94%' } },
      { op: 'hide', id: 'gpu' },
      { op: 'say', target: 'loss', at: { x: 32, series: 'VAL LOSS' }, text: 'Divergence begins here.' },
      { op: 'focus', id: 'loss' },
      { op: 'listen', on: true },
      { op: 'clear' },
    ];

    for (const action of actions) expect(validateControllerAction(action).ok).toBe(true);
  });

  it('rejects layout instructions and unknown object types', () => {
    expect(validateControllerAction({
      op: 'show', id: 'gpu', type: 'metric', width: 400, data: { label: 'GPU', value: '94%' },
    })).toEqual({ ok: false, error: 'model-controlled layout field is forbidden: width' });

    expect(validateControllerAction({
      op: 'show', id: 'thing', type: 'card', data: {},
    }).ok).toBe(false);
  });

  it('throws a useful error at the external transport boundary', () => {
    expect(() => assertControllerAction({ op: 'listen', on: 'yes' })).toThrow(/listen\.on must be boolean/);
  });
});

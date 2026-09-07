import { describe, expect, it } from 'vitest';
import { assertControllerAction, validateControllerAction } from '../../src/controller/validation';

describe('display protocol validation', () => {
  it('accepts the six semantic operations', () => {
    const actions = [
      { op: 'show', id: 'gpu', type: 'metric', data: { label: 'GPU', value: '94%' } },
      { op: 'hide', id: 'gpu' },
      { op: 'say', target: 'loss', at: { x: 32, series: 'VAL LOSS' }, text: 'Divergence begins here.' },
      { op: 'focus', id: 'loss' },
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

  it('accepts all agent display object shapes', () => {
    const actions = [
      { op: 'show', id: 'd', type: 'diagram', data: { nodes: [], edges: [{ from: 'a', to: 'b', label: 'next' }] } },
      { op: 'show', id: 'c', type: 'code', data: { source: { text: 'const x = 1' } } },
      { op: 'show', id: 'm', type: 'metric', data: { label: 'L', value: '1' } },
      { op: 'show', id: 'p', type: 'progress', data: { label: 'L', value: 0.5 } },
      { op: 'show', id: 'n', type: 'note', data: { segments: [{ text: 'hello' }] } },
      { op: 'show', id: 'e', type: 'document', data: { subject: 'S', paragraphs: [] } },
    ];
    for (const action of actions) expect(validateControllerAction(action).ok).toBe(true);
  });

  it('rejects unknown operations and non-finite chart values, including nested layout fields', () => {
    expect(validateControllerAction({ op: 'listen', on: true }).ok).toBe(false);
    expect(validateControllerAction({ op: 'show', id: 'c', type: 'chart', data: { series: [{ values: [Infinity] }] } }).ok).toBe(false);
    expect(validateControllerAction({ op: 'show', id: 'c', type: 'chart', data: { series: [{ values: [1], style: 'x' }] } }).ok).toBe(false);
  });

  it('throws a useful error at the external transport boundary', () => {
    expect(() => assertControllerAction({ op: 'listen', on: 'yes' })).toThrow(/unknown operation/);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { controllerReducer, createInitialState, reduceActions } from '../../src/controller/reducer';
import type { ControllerAction } from '../../src/controller/types';

const metric: ControllerAction = {
  op: 'show',
  id: 'gpu',
  type: 'metric',
  data: { label: 'GPU', value: '91%' },
};

describe('controller reducer', () => {
  it('upserts by stable object ID without duplicating order', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200);
    const first = controllerReducer(createInitialState(), metric);
    const second = controllerReducer(first, {
      ...metric,
      data: { label: 'GPU', value: '94%' },
    });

    expect(second.order).toEqual(['gpu']);
    expect(second.objects.gpu.data).toEqual({ label: 'GPU', value: '94%' });
    expect(second.objects.gpu.createdAt).toBe(100);
    expect(second.objects.gpu.updatedAt).toBe(200);
    vi.restoreAllMocks();
  });

  it('removes focus and targeted speech when an object is hidden', () => {
    const state = reduceActions(createInitialState(), [
      metric,
      { op: 'focus', id: 'gpu' },
      { op: 'say', target: 'gpu', text: 'GPU is saturated.' },
    ]);
    const hidden = controllerReducer(state, { op: 'hide', id: 'gpu' });

    expect(hidden.objects.gpu).toBeUndefined();
    expect(hidden.focusId).toBeNull();
    expect(hidden.speech).toBeNull();
  });

  it('does not focus an unknown object', () => {
    const state = controllerReducer(createInitialState(), { op: 'focus', id: 'missing' });
    expect(state.focusId).toBeNull();
  });

  it('keeps the protocol semantic and clears back to idle', () => {
    const state = reduceActions(createInitialState(), [
      metric,
      { op: 'listen', on: true },
      { op: 'say', text: 'Working.' },
      { op: 'clear' },
    ]);
    expect(state.objects).toEqual({});
    expect(state.order).toEqual([]);
    expect(state.listening).toBe(false);
    expect(state.speech).toBeNull();
  });
});

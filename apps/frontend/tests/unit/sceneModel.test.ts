import { describe, expect, it } from 'vitest';
import { createInitialState, reduceActions } from '../../src/controller/reducer';
import { fixtures } from '../../src/fixtures/scenes';
import { besideVisuals, buildCompositionModel, sceneKind } from '../../src/app/sceneModel';
import type { ControllerAction } from '../../src/controller/types';

const expected = {
  idle: 'idle',
  conversation: 'conversation',
  training: 'training',
  architecture: 'architecture',
  email: 'document',
  code: 'code',
  results: 'table',
  comparison: 'training',
  figure: 'image',
  composed: 'architecture',
} as const;

describe('scene classification', () => {
  for (const [fixture, kind] of Object.entries(expected)) {
    it(`classifies ${fixture} as ${kind}`, () => {
      const state = reduceActions(createInitialState(), fixtures[fixture as keyof typeof fixtures]);
      expect(sceneKind(state)).toBe(kind);
    });
  }
});

const show = (id: string, type: 'chart' | 'table' | 'image' | 'code' | 'metric' | 'note' | 'progress', role?: 'primary' | 'compare' | 'secondary' | 'ambient'): ControllerAction => ({
  op: 'show', id, type, ...(role ? { role } : {}), data: {},
});

describe('visuals beside the primary', () => {
  it('lists every visual but the primary: compare, then secondary, then ambient, each in show order', () => {
    const state = reduceActions(createInitialState(), [
      show('ambient-chart', 'chart', 'ambient'),
      show('main', 'table', 'primary'),
      show('second-image', 'image'),
      show('compare-code', 'code', 'compare'),
      show('second-chart', 'chart', 'secondary'),
      show('compare-table', 'table', 'compare'),
    ]);
    expect(besideVisuals(buildCompositionModel(state)).map((object) => object.id)).toEqual([
      'compare-code', 'compare-table', 'second-image', 'second-chart', 'ambient-chart',
    ]);
  });

  it('leaves out what the rail carries', () => {
    const state = reduceActions(createInitialState(), [
      show('main', 'chart', 'primary'),
      show('m', 'metric', 'compare'),
      show('n', 'note'),
      show('p', 'progress', 'ambient'),
    ]);
    expect(besideVisuals(buildCompositionModel(state))).toEqual([]);
  });

  it('leaves out every metric holding the primary role', () => {
    const state = reduceActions(createInitialState(), [
      show('a', 'metric', 'primary'),
      show('b', 'metric', 'primary'),
      show('fig', 'image'),
    ]);
    expect(besideVisuals(buildCompositionModel(state)).map((object) => object.id)).toEqual(['fig']);
  });
});

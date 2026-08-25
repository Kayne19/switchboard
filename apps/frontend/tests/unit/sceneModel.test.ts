import { describe, expect, it } from 'vitest';
import { createInitialState, reduceActions } from '../../src/controller/reducer';
import { fixtures } from '../../src/fixtures/scenes';
import { sceneKind } from '../../src/app/sceneModel';

const expected = {
  idle: 'idle',
  conversation: 'conversation',
  training: 'training',
  architecture: 'architecture',
  email: 'document',
  code: 'code',
} as const;

describe('scene classification', () => {
  for (const [fixture, kind] of Object.entries(expected)) {
    it(`classifies ${fixture} as ${kind}`, () => {
      const state = reduceActions(createInitialState(), fixtures[fixture as keyof typeof fixtures]);
      expect(sceneKind(state)).toBe(kind);
    });
  }
});

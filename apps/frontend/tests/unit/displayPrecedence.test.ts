import { describe, expect, it } from 'vitest';
import fixtures from '../fixtures/display-precedence.json';
import { createInitialState, reduceActions } from '../../src/controller/reducer';
import { deriveScreenState } from '../../src/app/sceneModel';
import type { ControllerAction } from '../../src/controller/types';

// The display precedence rule -- which object is primary, its kind and
// title, and which ids are visible -- is implemented once here (via the
// reducer and sceneModel.ts, for rendering without a round trip) and once in
// the backend's DisplayProjection (apps/backend/src/display.rs, for /view and
// the snapshot). Both stay, on purpose (see docs/architecture.md's known
// non-purity). apps/backend/tests/test_display.rs checks the Rust side
// against these same cases; a mismatch here means the two have disagreed on
// what the stage shows.
describe('display precedence fixture', () => {
  for (const testCase of fixtures.cases) {
    it(`matches the shared fixture: ${testCase.name}`, () => {
      const state = reduceActions(
        createInitialState(),
        testCase.actions as unknown as ControllerAction[],
      );
      const report = deriveScreenState(state, 0);

      expect(report.has_visual).toBe(testCase.expected.has_visual);
      expect(report.visual_kind).toBe(testCase.expected.kind);
      expect(report.title).toBe(testCase.expected.title ?? '');
      expect(report.object_ids).toEqual(testCase.expected.visible_ids);
    });
  }
});

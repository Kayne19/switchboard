// @vitest-environment jsdom
// Which surfaces lay out in the panel frame's rows (`expandable-surface--framed`):
// the primaries that fill the frame to its inner box, and the training chart.
import { describe, expect, it } from 'vitest';
import { fixtures } from '../../src/fixtures/scenes';
import { lastScene, renderScene, stubResizeObserver } from './sceneHarness';

stubResizeObserver();

const framedIn = (within: string) =>
  lastScene().querySelector(`${within} .expandable-surface`)!.classList.contains('expandable-surface--framed');

describe('the framed surface', () => {
  it.each([
    ['calendar', fixtures.calendar, true],
    ['tasks', fixtures.tasks, true],
    ['inbox', fixtures.inbox, true],
    ['image', fixtures.figure, true],
    ['code', fixtures.code, false],
    ['diagram', fixtures.architecture, false],
    ['timer', fixtures.timer, false],
    ['weather', fixtures.weather, false],
  ])('a %s primary is framed: %s', (_type, actions, framed) => {
    renderScene(actions);
    expect(framedIn('.content-main')).toBe(framed);
  });

  it('is on the training chart', () => {
    renderScene(fixtures.training);
    expect(framedIn('.chart-object')).toBe(true);
  });
});

// @vitest-environment jsdom
// The theater view (#277): an agent's view("theater") gives the primary
// the stage. The page draws it alone, at the size focus gives an object,
// with the notes about it beside it, a header naming it and an EXIT, the
// corner stack and a compact Damocles; no rail, no aux row, no heading.
// EXIT leaves the view for auto, as the caller dismissing it.
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { deriveScreenState } from '../../src/app/sceneModel';
import type { ControllerAction } from '../../src/controller/types';
import { fixtures } from '../../src/fixtures/scenes';
import { controllerState, lastScene, renderScene, runActions, stubResizeObserver } from './sceneHarness';

stubResizeObserver();

const theater: ControllerAction = { op: 'set_view', view: 'theater' };

describe('the theater view', () => {
  it('draws the primary alone, with its note, a header, EXIT, the corner stack and a compact Damocles', () => {
    renderScene([...fixtures.training, theater]);
    const scene = lastScene();
    expect(scene.getAttribute('data-scene')).toBe('theater');
    const box = scene.querySelector('.theater__box')!;
    expect(box).not.toBeNull();
    expect(box.querySelector('.theater__header')!.textContent).toContain('THEATER / CHART');
    expect(box.querySelectorAll('.chart-primitive, [data-chart]').length).toBeGreaterThan(0);
    // The note about the chart stands beside it, as focus keeps it.
    expect(box.querySelector('.focus-layer__note')!.textContent).toContain('Validation loss turns upward');
    // Nothing else on stage is drawn: no rail, no aux row, no heading, no footer.
    expect(scene.querySelector('.content-rail')).toBeNull();
    expect(scene.querySelector('.composed-aux')).toBeNull();
    expect(scene.querySelector('.scene-heading')).toBeNull();
    expect(scene.querySelectorAll('.channel-stack')).toHaveLength(1);
    const presences = scene.querySelectorAll('[data-testid="damocles-presence"]');
    expect(presences).toHaveLength(1);
    expect(presences[0].classList.contains('damocles-presence--compact')).toBe(true);
    expect(deriveScreenState(controllerState(), 1).view).toBe('theater');
  });

  it('leaves for auto on EXIT, and the report says so', () => {
    renderScene([...fixtures.code, theater]);
    const exit = lastScene().querySelector<HTMLButtonElement>('.theater__header .return-control')!;
    expect(exit.textContent).toContain('EXIT');
    act(() => exit.click());
    expect(controllerState().workspace.requestedView).toBe('auto');
    expect(document.querySelector('.stage')!.getAttribute('data-scene-kind')).toBe('code');
    expect(deriveScreenState(controllerState(), 1).view).toBe('auto');
  });

  it('draws the primary a later show makes, and the idle page when the stage empties', () => {
    renderScene([...fixtures.code, theater]);
    runActions([{ op: 'show', id: 'fig', type: 'table', role: 'primary', data: { title: 'RESULTS', columns: ['A'], rows: [['1']] } }]);
    expect(lastScene().querySelector('.theater__header')!.textContent).toContain('THEATER / TABLE');
    runActions([{ op: 'clear' }]);
    // The theater scene leaves through its exit; the stage names the kind drawn now.
    expect(document.querySelector('.stage')!.getAttribute('data-scene-kind')).toBe('idle');
    expect(deriveScreenState(controllerState(), 1).view).toBe('auto');
  });

  it('ends with the leg: a new epoch draws auto', () => {
    renderScene([...fixtures.code, theater]);
    runActions([{ op: 'epoch_reset' }, ...fixtures.code]);
    expect(document.querySelector('.stage')!.getAttribute('data-scene-kind')).toBe('code');
  });
});

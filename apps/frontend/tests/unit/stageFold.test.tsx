// @vitest-environment jsdom
// A primary that outgrows the column it shares with a rail standing under
// it takes the stage's height, the rail folded to a strip of its note and
// Damocles under it (app/stageFold.ts). Before, the rail always took its
// share: on a phone a forty-step pipeline was read through a slot of 374 px
// of 844, the note and the emblem under it.
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { columnNeed, STAGE_PAST, UNSTAGE_UNDER, wantsStage } from '../../src/app/stageFold';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { ControllerProvider, useController } from '../../src/controller/context';
import type { ControllerAction } from '../../src/controller/types';
import { fixtures } from '../../src/fixtures/scenes';

describe('when the primary takes the stage', () => {
  const shared = 498;
  const stacked = { stacked: true, column: shared, shared };
  // In the shared column a viewport of 374 px: what it lacks grows the column by that share.
  const at = (excess: number, column = shared, viewport = 374) => columnNeed(column, [{ excess, viewport }]);

  it('keeps the shared layout for a primary that reads whole in it', () => {
    expect(wantsStage({ ...stacked, need: at(-40) }, false)).toBe(false);
    expect(wantsStage({ ...stacked, need: at(0) }, false)).toBe(false);
    // A region a few pixels short for its last line keeps the rail.
    expect(wantsStage({ ...stacked, need: shared + STAGE_PAST }, false)).toBe(false);
    expect(wantsStage({ ...stacked, need: at(12) }, false)).toBe(false);
  });

  it('takes the stage for a primary past the shared column', () => {
    expect(wantsStage({ ...stacked, need: shared + STAGE_PAST + 1 }, false)).toBe(true);
    expect(wantsStage({ ...stacked, need: at(5000) }, false)).toBe(true);
  });

  it('never where the rail stands beside the primary, or while nothing has said what it needs', () => {
    expect(wantsStage({ ...stacked, stacked: false, need: at(5000) }, false)).toBe(false);
    expect(wantsStage({ ...stacked, need: null }, false)).toBe(false);
    expect(columnNeed(shared, [])).toBeNull();
    expect(wantsStage({ stacked: true, column: 0, shared: 0, need: 9999 }, false)).toBe(false);
  });

  it('reads the column a primary needs from the share of its viewport it lacks, the largest of several', () => {
    // A viewport of 460 in a column of 606 that lacks 60: the frame grows with it.
    expect(columnNeed(606, [{ excess: 60, viewport: 460 }])).toBeCloseTo((606 * 520) / 460);
    expect(columnNeed(606, [{ excess: -100, viewport: 460 }, { excess: 60, viewport: 460 }])).toBeCloseTo((606 * 520) / 460);
  });

  it('gives the stage back only with room to spare, so a need on the line does not flicker', () => {
    // Folded, the column is the stage's.
    const staged = { stacked: true, column: 620, shared };
    // Still past the shared column: it keeps the stage.
    expect(wantsStage({ ...staged, need: shared + 20 }, true)).toBe(true);
    // Within the band between the two thresholds it keeps the layout it has.
    expect(wantsStage({ ...staged, need: shared + UNSTAGE_UNDER + 1 }, true)).toBe(true);
    expect(wantsStage({ ...stacked, need: shared + UNSTAGE_UNDER + 1 }, false)).toBe(false);
    // It reads whole in the shared column: the rail comes back.
    expect(wantsStage({ ...staged, need: shared + UNSTAGE_UNDER }, true)).toBe(false);
  });
});

// The shell, on a stage laid out as a phone lays it out: the main column a
// fixed share over the rail (or the rail beside it), the drawing's viewport
// a few hundred pixels tall. jsdom has no layout, so the boxes are given.
let landscape = false;
const SHARED = 400;
const STAGED = 520;
function layoutBox(element: HTMLElement): { top: number; height: number; width: number } {
  const staged = element.closest('.content-grid--staged') !== null;
  if (element.classList.contains('content-grid__probe')) return { top: 0, height: SHARED, width: 0 };
  if (element.classList.contains('composed-main')) return { top: 0, height: landscape ? 600 : staged ? STAGED : SHARED, width: 360 };
  if (element.classList.contains('content-rail')) return { top: landscape ? 0 : staged ? STAGED + 12 : SHARED + 18, height: landscape ? 600 : staged ? 90 : 170, width: 360 };
  if (element.classList.contains('drawing-viewport') || element.classList.contains('diagram-primitive') || element.classList.contains('sequence-primitive')) {
    return { top: 60, height: staged ? 460 : 374, width: 330 };
  }
  return { top: 0, height: 0, width: 0 };
}
const stubbed = ['offsetTop', 'offsetHeight', 'offsetWidth'] as const;
const originals = new Map<string, PropertyDescriptor | undefined>();

let host: HTMLDivElement | undefined;
let root: Root;
let runActions: (actions: ControllerAction[]) => void = () => {};
function Scene({ actions }: { actions: ControllerAction[] }) {
  const { run } = useController();
  runActions = (more) => run(more);
  useEffect(() => run(actions), [actions, run]);
  return null;
}
function render(actions: ControllerAction[]): Element {
  const element = document.createElement('div');
  host = element;
  document.body.append(element);
  root = createRoot(element);
  act(() => root.render(
    <ControllerProvider>
      <Scene actions={actions} />
      <SceneRenderer />
    </ControllerProvider>,
  ));
  return [...element.querySelectorAll('[data-scene]')].at(-1)!;
}
const handle = (page: Element) => page.querySelector<HTMLButtonElement>('button.rail-handle');

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  for (const key of stubbed) {
    originals.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get(this: HTMLElement) {
        const laid = layoutBox(this);
        return key === 'offsetTop' ? laid.top : key === 'offsetHeight' ? laid.height : laid.width;
      },
    });
  }
});

afterAll(() => {
  for (const key of stubbed) {
    const original = originals.get(key);
    if (original) Object.defineProperty(HTMLElement.prototype, key, original);
  }
});

afterEach(() => {
  if (!host) return;
  act(() => root.unmount());
  host.remove();
  host = undefined;
  landscape = false;
});

describe('a primary that outgrows a rail standing under it', () => {
  it('takes the stage, the rail folded to its note and Damocles', () => {
    const page = render([...fixtures.pipeline]);
    expect(page.querySelector('.content-grid--staged')).not.toBeNull();
    const rail = page.querySelector('.content-rail')!;
    expect(rail.classList.contains('content-rail--folded')).toBe(true);
    // The note stays, its NOTE badge the twin of the marker on its node.
    expect(rail.querySelector('.rail-note .annotation-card__node-badge')?.textContent).toBe('NOTE');
    expect(rail.querySelector('[data-testid="damocles-presence"]')).not.toBeNull();
  });

  it('keeps the rest of the rail folded behind a handle that names it, and the caller can open it and fold it again', () => {
    const page = render([...fixtures.plan]);
    const rail = page.querySelector('.content-rail')!;
    expect(rail.classList.contains('content-rail--folded')).toBe(true);
    expect(rail.querySelector('[data-testid="metrics"]')).toBeNull();
    expect(rail.querySelector('[data-testid="progress"]')).toBeNull();
    expect(handle(page)?.textContent).toContain('02 METRICS / PROGRESS');
    expect(handle(page)?.getAttribute('aria-expanded')).toBe('false');

    act(() => handle(page)!.click());
    expect(page.querySelector('.content-grid--staged')).toBeNull();
    expect(rail.classList.contains('content-rail--open')).toBe(true);
    expect(rail.querySelector('[data-testid="metrics"]')).not.toBeNull();
    expect(rail.querySelector('[data-testid="progress"]')).not.toBeNull();
    expect(handle(page)?.getAttribute('aria-expanded')).toBe('true');
    expect(handle(page)?.textContent).toContain('FOLD');

    act(() => handle(page)!.click());
    expect(page.querySelector('.content-grid--staged')).not.toBeNull();
    expect(rail.classList.contains('content-rail--folded')).toBe(true);
  });

  it('draws a stage with the rail beside the primary as it was', () => {
    landscape = true;
    const page = render([...fixtures.pipeline]);
    expect(page.querySelector('.content-grid--staged')).toBeNull();
    expect(page.querySelector('.content-rail--foldable')).toBeNull();
    expect(handle(page)).toBeNull();
  });

  it('keeps the shared layout for a primary that says nothing of its height', () => {
    // A chart is drawn to its slot; its notes lie over it.
    const page = render([...fixtures.training]);
    expect(page.querySelector('.content-grid--staged')).toBeNull();
    expect(page.querySelector('.content-rail--foldable')).toBeNull();
  });

  it('gives the rail back when the primary is replaced by one that fits', () => {
    const page = render([...fixtures.pipeline]);
    expect(page.querySelector('.content-grid--staged')).not.toBeNull();
    act(() => runActions([
      { op: 'clear' },
      { op: 'show', id: 'small', type: 'diagram', role: 'primary', data: { mode: 'graph', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] } },
    ]));
    const shown = [...host!.querySelectorAll('[data-scene]')].at(-1)!;
    expect(shown.querySelector('.content-grid--staged')).toBeNull();
    expect(shown.querySelector('.content-rail--foldable')).toBeNull();
  });
});

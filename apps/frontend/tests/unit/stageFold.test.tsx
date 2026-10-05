// @vitest-environment jsdom
// A primary that outgrows the column it shares with a rail standing under
// it takes the stage's height, the rail folded to a strip of its note and
// Damocles under it (app/stageFold.ts). Before, the rail always took its
// share: on a phone a forty-step pipeline was read through a slot of 374 px
// of 844, the note and the emblem under it.
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { STAGE_PAST, UNSTAGE_UNDER, sharedExcess, stageReport, wantsStage, type StageReport } from '../../src/app/stageFold';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { ControllerProvider, useController } from '../../src/controller/context';
import type { ControllerAction } from '../../src/controller/types';
import { fixtures } from '../../src/fixtures/scenes';

describe('when the primary takes the stage', () => {
  // In the shared layout the column is 498 px and the viewport 374.
  const column = 498;
  const shared = (excess: number, viewport = 374) => stageReport({ excess, viewport }, true, column, undefined);
  // The same content measured on the stage, its viewport `viewport` there.
  const staged = (content: number, viewport: number, before: StageReport | undefined = shared(0)) =>
    stageReport({ excess: content - viewport, viewport }, false, column, before);

  it('keeps the shared layout for a primary that reads whole in it', () => {
    expect(wantsStage(true, [shared(-40)], false, column)).toBe(false);
    expect(wantsStage(true, [shared(0)], false, column)).toBe(false);
    // A region a few pixels short for its last line keeps the rail.
    expect(wantsStage(true, [shared(STAGE_PAST)], false, column)).toBe(false);
  });

  it('takes the stage for a primary past its shared viewport, the most any of its parts lacks', () => {
    expect(wantsStage(true, [shared(STAGE_PAST + 1)], false, column)).toBe(true);
    expect(wantsStage(true, [shared(-100), shared(5000)], false, column)).toBe(true);
  });

  it('never where the rail stands beside the primary, or while nothing has said what it needs', () => {
    expect(wantsStage(false, [shared(5000)], false, column)).toBe(false);
    expect(wantsStage(true, [], true, column)).toBe(false);
  });

  it('weighs a content measured on the stage against the viewport it had in the shared layout', () => {
    // 400 px of content in a 374 px viewport: past it by 26, on the stage too.
    const first = shared(26);
    expect(sharedExcess(staged(400, 482, first), column)).toBe(26);
    // The stage resized: the shared column grew by 20, so did its viewport.
    expect(sharedExcess(staged(400, 482, first), column + 20)).toBe(6);
    // Never measured in the shared layout: past even the stage is past it for certain; else it cannot tell.
    expect(sharedExcess(stageReport({ excess: 10, viewport: 482 }, false, column, undefined), column)).toBe(Number.POSITIVE_INFINITY);
    expect(sharedExcess(stageReport({ excess: -10, viewport: 482 }, false, column, undefined), column)).toBeNull();
  });

  // A graph laid out again for the stage's taller viewport asks what that
  // drawing needs, which says nothing of the shared layout. It kept the
  // stage, sent again small enough to read whole in its share, until
  // another primary came (phone-tidy open 3). It is weighed as it would be
  // laid out for the viewport it had there: the word the shared layout
  // would give, so nothing it decides the shared layout undoes.
  it('weighs a graph laid out again for the stage by what it would ask laid out for its shared viewport', () => {
    const graph = stageReport({ excess: 600 - 374, viewport: 374 }, true, column, undefined);
    // What it asks laid out for a viewport `height` tall: `shared` for the shared one's.
    const asked: number[] = [];
    const laidOut = (shared: number) => (height: number) => {
      asked.push(height);
      return height === 374 ? shared : height === 394 ? shared - 20 : 9999;
    };
    // On the stage (482 px) it reads whole, whatever it would ask in its share.
    const relaid = (shared: number) => stageReport({ excess: -30, viewport: 482, relaid: laidOut(shared) }, false, column, graph);
    expect(sharedExcess(relaid(300), column)).toBe(300 - 374);
    expect(asked).toEqual([374]);
    expect(sharedExcess(relaid(400), column)).toBe(400 - 374);
    // The stage resized: the shared viewport moved with its column.
    expect(sharedExcess(relaid(400), column + 20)).toBe(380 - 394);
    // Folded, it gives the stage back once it would read whole in its share, with the same room to spare as any content.
    expect(wantsStage(true, [relaid(300)], true, column)).toBe(false);
    expect(wantsStage(true, [relaid(374 + UNSTAGE_UNDER)], true, column)).toBe(false);
    expect(wantsStage(true, [relaid(374 + UNSTAGE_UNDER + 1)], true, column)).toBe(true);
    // Never measured in the shared layout, it cannot tell that viewport: past even the stage is past it for certain.
    expect(sharedExcess(stageReport({ excess: -30, viewport: 482, relaid: laidOut(300) }, false, column, undefined), column)).toBeNull();
    expect(sharedExcess(stageReport({ excess: 40, viewport: 482, relaid: laidOut(300) }, false, column, undefined), column)).toBe(Number.POSITIVE_INFINITY);
  });

  it('keeps the layout it has while a part cannot tell', () => {
    const unknown = stageReport({ excess: -10, viewport: 482 }, false, column, undefined);
    expect(wantsStage(true, [unknown], true, column)).toBe(true);
    expect(wantsStage(true, [unknown], false, column)).toBe(false);
  });

  it('gives the stage back only with room to spare, so a need on the line does not flicker', () => {
    // Folded: still past the shared viewport, it keeps the stage.
    expect(wantsStage(true, [staged(374 + 20, 482)], true, column)).toBe(true);
    // Within the band between the two thresholds it keeps the layout it has.
    expect(wantsStage(true, [staged(374 + UNSTAGE_UNDER + 1, 482)], true, column)).toBe(true);
    expect(wantsStage(true, [shared(UNSTAGE_UNDER + 1)], false, column)).toBe(false);
    // It reads whole in the shared viewport: the rail comes back.
    expect(wantsStage(true, [staged(374 + UNSTAGE_UNDER, 482)], true, column)).toBe(false);
  });

  it('does not fold and unfold a content framed by fixed chrome (a document, a table over an aux row)', () => {
    // A document whose heading and meta take 150 px of a 515 px column: its
    // viewport is 365 there and 473 on the stage. 400 px of text folds the
    // rail; on the stage, the same text against the same 365 keeps it.
    const document = shared(400 - 365, 365);
    expect(wantsStage(true, [document], false, column)).toBe(true);
    expect(wantsStage(true, [staged(400, 473, document)], true, column)).toBe(true);
    // 380 px of text keeps the shared layout, and would never have folded.
    expect(wantsStage(true, [shared(380 - 365, 365)], false, column)).toBe(false);
  });
});

// The shell, on a stage laid out as a phone lays it out: the main column a
// fixed share over the rail (or the rail beside it), the drawing's viewport
// a few hundred pixels tall. jsdom has no layout, so the boxes are given,
// and the resize observers report when the test says the layout settled.
let landscape = false;
let stagedViewport = 460;
const SHARED = 400;
const STAGED = 520;
function layoutBox(element: HTMLElement): { top: number; height: number; width: number } {
  const staged = element.closest('.content-grid--staged') !== null;
  if (element.classList.contains('content-grid__probe')) return { top: 0, height: SHARED, width: 0 };
  if (element.classList.contains('composed-main')) return { top: 0, height: landscape ? 600 : staged ? STAGED : SHARED, width: 360 };
  if (element.classList.contains('content-rail')) return { top: landscape ? 0 : staged ? STAGED + 12 : SHARED + 18, height: landscape ? 600 : staged ? 90 : 170, width: 360 };
  if (element.classList.contains('drawing-viewport') || element.classList.contains('diagram-primitive') || element.classList.contains('sequence-primitive')) {
    return { top: 60, height: staged ? stagedViewport : 374, width: 330 };
  }
  return { top: 0, height: 0, width: 0 };
}
const stubbed = ['offsetTop', 'offsetHeight', 'offsetWidth'] as const;
const originals = new Map<string, PropertyDescriptor | undefined>();
const observers = new Set<{ report: () => void }>();
// What a browser does after a layout: every observer reports its boxes.
const settle = () => act(() => {
  for (const observer of [...observers]) observer.report();
});

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
  settle();
  return [...element.querySelectorAll('[data-scene]')].at(-1)!;
}
const handle = (page: Element) => page.querySelector<HTMLButtonElement>('button.rail-handle');

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class {
    private live = false;
    constructor(private readonly callback: () => void) {}
    observe() {
      this.live = true;
      observers.add(this);
    }
    unobserve() {}
    disconnect() {
      this.live = false;
      observers.delete(this);
    }
    report() {
      if (this.live) this.callback();
    }
  } as unknown as typeof ResizeObserver;
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
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

beforeEach(() => {
  landscape = false;
  stagedViewport = 460;
});

afterEach(() => {
  if (!host) return;
  act(() => root.unmount());
  host.remove();
  host = undefined;
  observers.clear();
});

describe('a primary that outgrows a rail standing under it', () => {
  it('takes the stage, the rail folded to its note and Damocles', () => {
    const page = render([...fixtures.pipeline]);
    expect(page.querySelector('.content-grid--staged')).not.toBeNull();
    const rail = page.querySelector('.content-rail')!;
    expect(rail.classList.contains('content-rail--folded')).toBe(true);
    // The note stays, its NOTE badge the twin of the marker on its node.
    expect(rail.querySelector('.rail-note .note-badge')?.textContent).toBe('NOTE');
    expect(rail.querySelector('[data-testid="damocles-presence"]')).not.toBeNull();
  });

  it('keeps the rest of the rail folded behind a handle that names it, and the caller can open it and fold it again', () => {
    const page = render([...fixtures.plan]);
    const rail = page.querySelector('.content-rail')!;
    expect(rail.classList.contains('content-rail--folded')).toBe(true);
    // Set aside, not dropped: folding draws nothing afresh.
    expect(rail.querySelector('[data-testid="metrics"]')).not.toBeNull();
    expect(handle(page)?.textContent).toContain('02 METRICS / PROGRESS');
    expect(handle(page)?.getAttribute('aria-expanded')).toBe('false');
    // Its name holds what it shows, and it says what it opens.
    expect(handle(page)?.getAttribute('aria-label')).toContain('02 METRICS / PROGRESS');
    expect(handle(page)?.getAttribute('aria-controls')).toBe(rail.querySelector('.content-rail__details')?.id);

    act(() => handle(page)!.click());
    settle();
    expect(page.querySelector('.content-grid--staged')).toBeNull();
    expect(rail.classList.contains('content-rail--open')).toBe(true);
    expect(handle(page)?.getAttribute('aria-expanded')).toBe('true');
    expect(handle(page)?.textContent).toContain('FOLD');

    act(() => handle(page)!.click());
    settle();
    expect(page.querySelector('.content-grid--staged')).not.toBeNull();
    expect(rail.classList.contains('content-rail--folded')).toBe(true);
  });

  it('keeps the handle, and the caller\'s place on it, when the rail opens over a primary that reads whole on the stage', () => {
    // The plan's diagram reads whole in a viewport of 800 px on the stage.
    stagedViewport = 800;
    const page = render([...fixtures.plan]);
    const button = handle(page)!;
    button.focus();
    act(() => button.click());
    expect(handle(page)).toBe(button);
    settle();
    settle();
    expect(page.querySelector('.content-rail--open')).not.toBeNull();
    expect(handle(page)).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it('keeps the stage while a drawing that reads whole there is laid out again for a box a few pixels shorter', () => {
    stagedViewport = 800;
    const page = render([...fixtures.plan]);
    expect(page.querySelector('.content-grid--staged')).not.toBeNull();
    // The strip grows by a line: the drawing's box is 3 px shorter before its fit follows.
    stagedViewport = 797;
    settle();
    expect(page.querySelector('.content-grid--staged')).not.toBeNull();
    settle();
    expect(page.querySelector('.content-grid--staged')).not.toBeNull();
  });

  // The same graph sent again small: on the stage it reads whole, and laid
  // out for its share it would too. It kept the stage until another
  // primary came (phone-tidy open 3).
  it('gives the rail back when the same graph is sent again small enough to read whole in its share', () => {
    const page = render([...fixtures.pipeline]);
    expect(page.querySelector('.content-grid--staged')).not.toBeNull();
    act(() => runActions([
      { op: 'show', id: 'pipeline', type: 'diagram', role: 'primary', data: { mode: 'graph', nodes: [{ id: 'lint', label: 'LINT' }, { id: 'unit', label: 'UNIT' }, { id: 'visual', label: 'VISUAL' }], edges: [{ from: 'lint', to: 'unit' }, { from: 'unit', to: 'visual' }] } },
    ]));
    settle();
    settle();
    expect(page.querySelector('.content-grid--staged')).toBeNull();
    expect(page.querySelector('.content-rail--foldable')).toBeNull();
    // And the shared layout keeps it there: it does not take the stage again.
    settle();
    expect(page.querySelector('.content-grid--staged')).toBeNull();
  });

  it('keeps the stage when the same graph is sent again still too large for its share', () => {
    const page = render([...fixtures.pipeline]);
    expect(page.querySelector('.content-grid--staged')).not.toBeNull();
    const pipeline = fixtures.pipeline[0] as Extract<ControllerAction, { op: 'show' }>;
    const data = pipeline.data as { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string }> };
    // One stage fewer: still forty-odd steps.
    const nodes = data.nodes.slice(1);
    const kept = new Set(nodes.map((node) => node.id));
    act(() => runActions([{ ...pipeline, data: { ...data, nodes, edges: data.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)) } } as ControllerAction]));
    settle();
    settle();
    expect(page.querySelector('.content-grid--staged')).not.toBeNull();
  });

  it('draws a stage with the rail beside the primary as it was', () => {
    landscape = true;
    const page = render([...fixtures.pipeline]);
    expect(page.querySelector('.content-grid--staged')).toBeNull();
    expect(page.querySelector('.content-rail--foldable')).toBeNull();
    expect(handle(page)).toBeNull();
  });

  it('keeps the shared layout for a primary that says nothing of its height', () => {
    // A line chart is drawn to its slot; its notes lie over it.
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
    settle();
    settle();
    const shown = [...host!.querySelectorAll('[data-scene]')].at(-1)!;
    expect(shown.querySelector('.content-grid--staged')).toBeNull();
    expect(shown.querySelector('.content-rail--foldable')).toBeNull();
  });
});

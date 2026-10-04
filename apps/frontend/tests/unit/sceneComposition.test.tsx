// @vitest-environment jsdom
// A visual primary used to fill the main slot alone, and a secondary or
// compare visual beside it was accepted, counted in the screen state, and
// never drawn. Every content scene now draws each visual on stage once: in
// its own main slot when it has a place for it (a chart beside a chart
// primary), and otherwise in the aux row under the primary.
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import { ControllerProvider, useController } from '../../src/controller/context';
import type { ControllerAction, SceneObjectRole, SceneObjectType } from '../../src/controller/types';
import { fixtures } from '../../src/fixtures/scenes';

// A 1x1 PNG: the smallest picture both validators accept.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// The smallest data each type draws from, and the test id of the primitive
// that draws it.
const samples = {
  chart: { type: 'chart', testId: 'chart', data: { title: 'TREND', series: [{ name: 'S', values: [1, 2, 3] }] } },
  graph: { type: 'diagram', testId: 'diagram', data: { mode: 'graph', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] } },
  sequence: { type: 'diagram', testId: 'sequence', data: { mode: 'sequence', actors: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], messages: [{ from: 'a', to: 'b', label: 'call' }] } },
  document: { type: 'document', testId: 'document', data: { subject: 'Review', paragraphs: ['One line.'] } },
  code: { type: 'code', testId: 'code', data: { source: { text: 'const a = 1;' } } },
  table: { type: 'table', testId: 'table', data: { columns: [{ label: 'SUITE' }], rows: [['backend']] } },
  image: { type: 'image', testId: 'image', data: { format: 'png', bytes: PNG_1X1, alt: 'A dot' } },
  metric: { type: 'metric', testId: 'metrics', data: { label: 'P95', value: '182 ms' } },
  progress: { type: 'progress', testId: 'progress', data: { label: 'DEPLOY', value: 40 } },
  note: { type: 'note', testId: null, data: { segments: [{ text: 'A note.' }] } },
} as const;
type Sample = keyof typeof samples;
const visuals = ['chart', 'graph', 'sequence', 'document', 'code', 'table', 'image'] as const satisfies readonly Sample[];
const primaries: Sample[] = [...visuals, 'metric', 'progress', 'note'];

function show(id: string, sample: Sample, role?: SceneObjectRole): ControllerAction {
  const { type, data } = samples[sample];
  return { op: 'show', id, type: type as SceneObjectType, ...(role ? { role } : {}), data };
}

let host: HTMLDivElement;
let root: Root;
let runActions: (actions: ControllerAction[]) => void = () => {};

function Scene({ actions }: { actions: ControllerAction[] }) {
  const { run } = useController();
  runActions = (more) => run(more);
  useEffect(() => run(actions), [actions, run]);
  return null;
}

function render(actions: ControllerAction[]): Element {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(
    <ControllerProvider>
      <Scene actions={actions} />
      <SceneRenderer />
    </ControllerProvider>,
  ));
  // A scene that is leaving stays in the page until its exit ends; the one
  // just drawn is the last.
  return [...host.querySelectorAll('[data-scene]')].at(-1)!;
}

const drawn = (page: Element, testId: string) => page.querySelectorAll(`[data-testid="${testId}"]`).length;
const inAux = (page: Element, testId: string) => page.querySelectorAll(`.composed-aux [data-testid="${testId}"]`).length;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a visual beside the primary', () => {
  it('a diagram primary with a secondary table renders the table', () => {
    const page = render([show('map', 'graph', 'primary'), show('matrix', 'table', 'secondary')]);
    expect(page.getAttribute('data-scene')).toBe('architecture');
    expect(drawn(page, 'diagram')).toBe(1);
    expect(inAux(page, 'diagram')).toBe(0);
    expect(inAux(page, 'table')).toBe(1);
  });

  it('a table primary with a secondary image renders the image', () => {
    const page = render([show('matrix', 'table', 'primary'), show('figure', 'image', 'secondary')]);
    expect(page.getAttribute('data-scene')).toBe('table');
    expect(inAux(page, 'table')).toBe(0);
    expect(inAux(page, 'image')).toBe(1);
  });

  it('a code primary with a secondary document renders the document', () => {
    const page = render([show('source', 'code', 'primary'), show('review', 'document')]);
    expect(page.getAttribute('data-scene')).toBe('code');
    expect(inAux(page, 'document')).toBe(1);
  });

  it('a chart primary draws a compare chart beside it and the other visuals under it', () => {
    const page = render([
      show('loss', 'chart', 'primary'),
      show('previous', 'chart', 'compare'),
      show('figure', 'image', 'secondary'),
      show('matrix', 'table', 'compare'),
    ]);
    expect(page.getAttribute('data-scene')).toBe('training');
    expect(page.querySelectorAll('.training-charts [data-testid="chart"]')).toHaveLength(2);
    expect(inAux(page, 'chart')).toBe(0);
    // Compare first, as the composed workspace orders its aux row.
    expect([...page.querySelectorAll('.composed-aux [data-testid]')].map((node) => node.getAttribute('data-testid')))
      .toEqual(['table', 'image']);
  });

  it('an ambient visual takes the last place in the aux row; the rail has no room for one', () => {
    const page = render([show('map', 'graph', 'primary'), show('figure', 'image', 'ambient'), show('matrix', 'table')]);
    expect([...page.querySelectorAll('.composed-aux [data-testid]')].map((node) => node.getAttribute('data-testid')))
      .toEqual(['table', 'image']);
  });

  // Every primary against every visual beside it: each visual on stage is
  // drawn exactly once, whatever the scene.
  for (const primary of primaries) {
    for (const beside of visuals) {
      it(`is drawn once beside a ${primary} primary: ${beside}`, () => {
        const page = render([show('main', primary, 'primary'), show('beside', beside, 'secondary')]);
        for (const sample of visuals) {
          const testId = samples[sample].testId;
          const expected = [primary, beside].filter((s) => samples[s].testId === testId).length;
          expect(drawn(page, testId), `${testId} on a ${primary} page`).toBe(expected);
        }
      });
    }
  }

  for (const role of ['compare', 'ambient'] as const) {
    for (const primary of ['graph', 'image', 'metric'] as const) {
      it(`is drawn when it holds the ${role} role beside a ${primary} primary`, () => {
        const page = render([show('main', primary, 'primary'), show('t', 'table', role), show('c', 'code', role)]);
        expect(inAux(page, 'table')).toBe(1);
        expect(inAux(page, 'code')).toBe(1);
      });
    }
  }
});

describe('a primary alone', () => {
  const alone = (Object.keys(fixtures) as Array<keyof typeof fixtures>).filter((name) => name !== 'idle' && name !== 'conversation');

  it.each(alone)('the %s fixture draws no aux row', (name) => {
    const page = render(fixtures[name]);
    expect(page.querySelector('.composed-aux')).toBeNull();
  });

  it('keeps its element when a visual arrives beside it, so it resizes in place rather than redrawing', () => {
    const page = render(fixtures.architecture);
    const diagram = page.querySelector('[data-testid="diagram"]');
    expect(diagram).not.toBeNull();
    act(() => runActions([show('matrix', 'table', 'secondary')]));
    expect(page.querySelector('.composed-aux [data-testid="table"]')).not.toBeNull();
    expect(page.querySelector('[data-testid="diagram"]')).toBe(diagram);
  });
});

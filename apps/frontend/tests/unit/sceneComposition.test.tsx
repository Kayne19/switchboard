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
import { validateControllerAction } from '../../src/controller/validation';
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
  calendar: { type: 'calendar', testId: 'calendar', data: { view: 'day', start: '2026-10-05', events: [{ id: 'standup', title: 'Standup', start: '2026-10-05T09:30' }] } },
  tasks: { type: 'tasks', testId: 'tasks', data: { items: [{ id: 'passport', text: 'Renew passport' }] } },
  timer: { type: 'timer', testId: 'timer', data: { timers: [{ id: 'pasta', label: 'Pasta', endsAt: '2026-10-05T18:42:00-07:00' }] } },
  weather: { type: 'weather', testId: 'weather', data: { location: 'San Francisco', units: 'F', current: { temp: 61, condition: 'fog' } } },
  inbox: { type: 'inbox', testId: 'inbox', data: { messages: [{ id: 'm1', from: 'Ana', time: '2026-10-05T08:12' }] } },
} as const;
type Sample = keyof typeof samples;
const visuals = [
  'chart', 'graph', 'sequence', 'document', 'code', 'table', 'image', 'calendar', 'tasks', 'timer', 'weather', 'inbox',
] as const satisfies readonly Sample[];
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

  it('an ambient chart beside a chart primary shares the chart row', () => {
    const page = render([show('loss', 'chart', 'primary'), show('context', 'chart', 'ambient')]);
    expect(page.querySelectorAll('.training-charts [data-testid="chart"]')).toHaveLength(2);
    expect(page.querySelector('.composed-aux')).toBeNull();
  });

  it('a chart primary keeps its progress under the charts until a visual stands beside it', () => {
    const alone = render([show('loss', 'chart', 'primary'), show('deploy', 'progress')]);
    expect(alone.querySelectorAll('.training-progress [data-testid="progress"]')).toHaveLength(1);
    act(() => runActions([show('matrix', 'table')]));
    // Then it joins the table in the aux row, so the charts keep their share.
    expect(alone.querySelector('.training-progress')).toBeNull();
    expect([...alone.querySelectorAll('.composed-aux [data-testid]')].map((node) => node.getAttribute('data-testid')))
      .toEqual(['table', 'progress']);
    expect(alone.querySelectorAll('[data-testid="progress"]')).toHaveLength(1);
  });

  it('a compare metric or the rail note beside a metric primary is drawn once', () => {
    const page = render([
      show('main', 'metric', 'primary'),
      show('other', 'metric', 'compare'),
      show('remark', 'note', 'compare'),
      show('matrix', 'table', 'compare'),
    ]);
    expect(page.getAttribute('data-scene')).toBe('composed');
    expect(page.querySelectorAll('.content-rail .metric-row')).toHaveLength(1);
    expect(page.querySelectorAll('.composed-aux [data-testid="metrics"]')).toHaveLength(0);
    expect(page.querySelectorAll('.annotation-card')).toHaveLength(1);
    expect(inAux(page, 'table')).toBe(1);
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
  const composedFixtures = new Set(['composed', 'today', 'idle', 'conversation']);
  const alone = (Object.keys(fixtures) as Array<keyof typeof fixtures>).filter((name) => !composedFixtures.has(name));

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

describe('the composed fixture', () => {
  it('is a diagram primary with a table and a figure under it, a note and two metrics beside it', () => {
    const page = render(fixtures.composed);
    expect(page.getAttribute('data-scene')).toBe('architecture');
    expect(drawn(page, 'diagram')).toBe(1);
    expect(inAux(page, 'table')).toBe(1);
    expect(inAux(page, 'image')).toBe(1);
    expect(page.querySelectorAll('.content-rail .metric-row')).toHaveLength(2);
  });

  it('holds only actions the validators accept', () => {
    for (const action of fixtures.composed) {
      expect(validateControllerAction(action)).toMatchObject({ ok: true });
    }
  });
});

describe('the personal-assistant fixtures', () => {
  // The five types draw through one stand-in until the render slice gives
  // each a primitive of its own (primitives/TemporaryAssistantList.tsx);
  // these hold what the scenes are, whatever draws them.
  const names = ['calendar', 'tasks', 'timer', 'weather', 'inbox', 'today'] as const;

  it.each(names)('the %s fixture holds only actions the validators accept', (name) => {
    for (const action of fixtures[name]) {
      expect(validateControllerAction(action), `${name} / ${'id' in action ? action.id : action.op}`).toMatchObject({ ok: true });
    }
  });

  it.each(['calendar', 'tasks', 'timer', 'weather', 'inbox'] as const)('the %s fixture is its type, drawn in the main slot', (name) => {
    const page = render(fixtures[name]);
    expect(page.getAttribute('data-scene')).toBe(name);
    expect(page.querySelectorAll(`.content-grid > .content-main [data-testid="${name}"]`)).toHaveLength(1);
  });

  it('today is the agenda, with the forecast, the to-do list and the inbox under it and the note in the rail', () => {
    const page = render(fixtures.today);
    expect(page.getAttribute('data-scene')).toBe('calendar');
    expect(drawn(page, 'calendar')).toBe(1);
    expect([...page.querySelectorAll('.composed-aux [data-testid]')].map((node) => node.getAttribute('data-testid')))
      .toEqual(['weather', 'tasks', 'inbox']);
    expect(page.querySelectorAll('.content-rail .annotation-card')).toHaveLength(1);
  });

  it('the stand-in names each object by its title, where no frame does', () => {
    const page = render(fixtures.today);
    expect([...page.querySelectorAll('.composed-aux .temporary-assistant__head')].map((node) => node.textContent))
      .toEqual(['WEATHER / SAN FRANCISCO', 'TO DO / THIS WEEK', 'INBOX / UNREAD FIRST']);
  });

  it('the calendar note names the dentist appointment by its id', () => {
    const note = fixtures.calendar.find((action) => action.op === 'show' && action.type === 'note');
    const week = fixtures.calendar.find((action) => action.op === 'show' && action.type === 'calendar');
    const anchor = note && 'data' in note ? (note.data as { anchor?: { target: string; item?: string } }).anchor : undefined;
    const events = week && 'data' in week ? (week.data as { events: Array<{ id: string }> }).events : [];
    expect(anchor).toEqual({ target: 'week', item: 'dentist' });
    expect(events.map((event) => event.id)).toContain('dentist');
  });
});

describe('the plan fixture', () => {
  it('is a diagram of the work, with the plan as a module in the rail between the metrics and the note', () => {
    const page = render(fixtures.plan);
    expect(page.getAttribute('data-scene')).toBe('architecture');
    expect(page.querySelector('.content-grid > .content-main [data-testid="progress"]')).toBeNull();
    const rail = [...page.querySelectorAll('.content-rail__details > *')].map((node) => node.className.split(' ')[0]);
    expect(rail.slice(0, 3)).toEqual(['metrics', 'rail-progress', 'rail-note']);
    expect(page.querySelector('.rail-progress .progress-primitive--rail')).not.toBeNull();
  });
});

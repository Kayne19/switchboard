// @vitest-environment jsdom
// A value read from the layout -- a box's size, whether a line overflows,
// where the rail stands -- reaches the page through one lifecycle: read in
// a layout effect, so the first frame painted has it; read again on each
// report of its observers; released on unmount. Each reader is held here to
// the same table, through the component that draws it: what the first
// commit shows, what a changed report shows when the observer's callback
// returns (before the frame it reports is painted) and once React's
// schedule has run, that a report of the value held commits nothing, and
// that unmounting leaves no observer behind (#392). jsdom lays nothing
// out, so each reader's boxes are given here, in two layouts, `a` and `b`.
import { act, Profiler, useEffect, useRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxData, NoteData, ProgressData, SceneObject, TimerData, WeatherData } from '../../src/controller/types';
import { createInitialState } from '../../src/controller/reducer';
import { RailDetails } from '../../src/components/Rail';
import { fixtures } from '../../src/fixtures/scenes';
import { useElementSize } from '../../src/hooks/useElementSize';
import { InboxPrimitive } from '../../src/primitives/InboxPrimitive';
import { ListViewport } from '../../src/primitives/ListViewport';
import { TimerPrimitive } from '../../src/primitives/TimerPrimitive';
import { WeatherPrimitive } from '../../src/primitives/WeatherPrimitive';
import { ControllerProvider, useController } from '../../src/controller/context';
import { SceneRenderer } from '../../src/components/SceneRenderer';
import type { ControllerAction } from '../../src/controller/types';
import { mount, unmountAll } from './sceneHarness';

// ---- the layout jsdom does not do ------------------------------------------

type Metric = 'offsetWidth' | 'offsetHeight' | 'offsetTop' | 'clientWidth' | 'clientHeight' | 'scrollWidth' | 'scrollHeight';
const METRICS: Metric[] = ['offsetWidth', 'offsetHeight', 'offsetTop', 'clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight'];
/** What the layout gives an element: its metrics, and the computed style it resolves to. */
interface Layout {
  metric(element: HTMLElement, key: Metric): number;
  style?(element: HTMLElement): Record<string, string> | undefined;
}
const NOTHING: Layout = { metric: () => 0 };
let layout: Layout = NOTHING;

// Every observer the page holds now, and every report one makes.
const resizeObservers = new Set<FakeResizeObserver>();
let mutationObservers = 0;
class FakeResizeObserver {
  private readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.targets.add(target);
    resizeObservers.add(this);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    resizeObservers.delete(this);
  }
  report() {
    const entries = [...this.targets].map((target) => {
      const element = target as HTMLElement;
      const height = parseFloat(getComputedStyle(element).height) || element.offsetHeight;
      const width = element.offsetWidth;
      return { target, borderBoxSize: [{ blockSize: height, inlineSize: width }], contentRect: { width, height } } as unknown as ResizeObserverEntry;
    });
    if (entries.length > 0) this.callback(entries, this as unknown as ResizeObserver);
  }
}
const RealMutationObserver = globalThis.MutationObserver;
class CountedMutationObserver extends RealMutationObserver {
  private live = false;
  observe(target: Node, options?: MutationObserverInit) {
    if (!this.live) mutationObservers += 1;
    this.live = true;
    super.observe(target, options);
  }
  disconnect() {
    if (this.live) mutationObservers -= 1;
    this.live = false;
    super.disconnect();
  }
}

// What a browser does after a layout: every observer reports its boxes.
function reportAll() {
  for (const observer of [...resizeObservers]) observer.report();
}

let restore: Array<() => void> = [];
beforeEach(() => {
  layout = NOTHING;
  const savedResize = globalThis.ResizeObserver;
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  globalThis.MutationObserver = CountedMutationObserver;
  restore.push(() => {
    globalThis.ResizeObserver = savedResize;
    globalThis.MutationObserver = RealMutationObserver;
  });
  for (const key of METRICS) {
    // Some are the element's own (jsdom's Element), not HTMLElement's: those are shadowed, then the shadow removed.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get(this: HTMLElement) { return layout.metric(this, key); } });
    restore.push(() => (descriptor ? Object.defineProperty(HTMLElement.prototype, key, descriptor) : delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]));
  }
  const realStyle = window.getComputedStyle;
  window.getComputedStyle = (element: Element, pseudo?: string | null) => {
    const style = realStyle.call(window, element, pseudo);
    const given = element instanceof HTMLElement ? layout.style?.(element) : undefined;
    if (!given) return style;
    return new Proxy(style, {
      get(target, key) {
        if (typeof key === 'string' && key in given) return given[key];
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  restore.push(() => {
    window.getComputedStyle = realStyle;
  });
});
afterEach(() => {
  unmountAll();
  for (const undo of restore.reverse()) undo();
  restore = [];
  resizeObservers.clear();
  mutationObservers = 0;
  commits = 0;
});

// ---- the readers --------------------------------------------------------------

/** One reader: how it is mounted, what it draws from its value, and its two layouts. */
interface Reader {
  /** What is mounted to draw the reader. */
  node(): ReactNode;
  /** What it draws from its value, read from the element it was mounted in. */
  drawn(page: HTMLElement): string | null;
  layouts: { a: Layout; b: Layout };
  /** What it draws in each layout. */
  expected: { a: string | null; b: string | null };
}

const has = (element: HTMLElement, name: string) => element.classList.contains(name);
const inside = (element: HTMLElement, selector: string) => element.closest(selector) !== null;

function SizeProbe() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  return <div ref={ref} className="size-probe" data-size={`${size.width}x${size.height}`} />;
}

// Days to go are too wide for readable digits in 200 px: the field asks the rows' height.
const timers: TimerData = {
  timers: [
    { id: 'trip', label: 'Trip', endsAt: '2099-01-02T00:00:00Z' },
    { id: 'pasta', label: 'Pasta', endsAt: '2099-01-01T00:00:00Z' },
  ],
};
const timerLayout = (rows: number): Layout => ({
  metric: (_element, key) => (key === 'offsetWidth' ? 200 : key === 'offsetHeight' ? 600 : 0),
  style: (element) => (has(element, 'timer-list__rows') && inside(element, '.timer-primitive__measure') ? { height: `${rows}px` } : undefined),
});

const inbox = (fixtures.inbox[0] as { data: InboxData }).data;
const inboxLayout = (width: number): Layout => ({
  metric: (element, key) => (key === 'clientWidth' && has(element, 'inbox-primitive__scroll') ? width : 0),
  style: (element) => (has(element, 'inbox-primitive__scroll') ? { fontSize: '15px' } : undefined),
});

const listLayout = (rows: number): Layout => ({
  metric: (element, key) => {
    if (!has(element, 'list-viewport__scroll')) return 0;
    if (key === 'clientHeight' || key === 'offsetHeight') return 100;
    if (key === 'scrollHeight') return rows * 30;
    return 0;
  },
});

const forecast: WeatherData = {
  location: 'San Francisco, CA', units: 'F',
  current: { temp: 61, condition: 'fog', summary: 'Fog burning off by noon', high: 68, low: 54, feelsLike: 59, humidity: 84, precip: 10, wind: 'W 12 mph' },
  hourly: Array.from({ length: 24 }, (_, index) => ({
    time: `2026-10-${index < 14 ? '07' : '08'}T${String((10 + index) % 24).padStart(2, '0')}:00`,
    temp: 60 + (index % 6), condition: index < 12 ? 'clear' : 'rain', precip: index * 4,
  })),
  daily: [
    { date: '2026-10-07', high: 68, low: 54, condition: 'partly-cloudy', precip: 20 },
    { date: '2026-10-08', high: 61, low: 55, condition: 'rain', precip: 80 },
    { date: '2026-10-09', high: 66, low: 52, condition: 'clear' },
  ],
  alert: 'Small craft advisory on the bay until 21:00',
};
// The box every part of the forecast measures, the condition line's parts
// and the spot line's room and parts (weatherPrimitive.test.tsx's layout).
const weatherLayout = (box: { width: number; height: number; condition: number[]; spot?: { room: number; parts: number[] } }): Layout => ({
  metric: (element, key) => {
    if (key === 'offsetWidth') return box.width;
    if (key === 'offsetHeight') return box.height;
    if (key === 'scrollWidth') {
      const line = element.parentElement;
      const index = line ? Array.from(line.children).indexOf(element) : -1;
      if (line && has(line, 'weather-now__condition')) return box.condition[index] ?? 0;
      if (line && has(line, 'weather-spot')) return box.spot?.parts[index] ?? 0;
      return 0;
    }
    if (key === 'clientWidth') return has(element, 'weather-spot') ? (box.spot?.room ?? 0) : 0;
    return 0;
  },
});
const spotParts = [40, 70, 16, 70, 25];

// A phone's scene: the main column 498 px over the rail (portrait), or the
// rail beside a 600 px column (landscape), as railFit.test.tsx gives it.
const sceneLayout = (portrait: boolean): Layout => ({
  metric: (element, key) => {
    const room = () => {
      const floor = parseFloat(element.closest<HTMLElement>('.content-grid')?.style.getPropertyValue('--rail-floor') ?? '') || 0;
      return portrait ? Math.min(Math.max(172, floor), 335) : 600;
    };
    const height = () => {
      if (has(element, 'composed-main')) return portrait ? 498 : 600;
      if (has(element, 'content-rail') || has(element, 'content-rail__details')) return room();
      if (has(element, 'rail-note')) return 182;
      return 0;
    };
    if (key === 'offsetTop') return has(element, 'content-rail') && portrait ? 516 : 0;
    if (key === 'offsetHeight' || key === 'clientHeight' || key === 'scrollHeight') return height();
    return 0;
  },
});

// The page's scene renderer with `actions` run through its controller.
function Runner({ actions }: { actions: readonly ControllerAction[] }) {
  const { run } = useController();
  useEffect(() => run([...actions]), [actions, run]);
  return null;
}
function Scene({ actions }: { actions: readonly ControllerAction[] }) {
  return (
    <ControllerProvider>
      <Runner actions={actions} />
      <SceneRenderer />
    </ControllerProvider>
  );
}

const note: NoteData = { segments: [{ text: 'A note the rail carries.' }] };
const progress: SceneObject<ProgressData> = { id: 'plan', type: 'progress', data: { label: 'Plan', value: 40 }, createdAt: 1, updatedAt: 1 };
// The rail's column: a note and a progress, `room` tall, carrying `content` px.
const railLayout = (room: number, content: number): Layout => ({
  metric: (element, key) => {
    if (has(element, 'content-rail__details')) return key === 'clientHeight' || key === 'offsetHeight' ? room : key === 'scrollHeight' ? Math.max(room, content) : 0;
    if (key !== 'offsetHeight') return 0;
    if (has(element, 'rail-note')) return content / 2;
    if (has(element, 'rail-progress')) return content / 2;
    return 0;
  },
});
const rail = (under: boolean) => (
  <RailDetails state={createInitialState()} metrics={[]} note={note} progressList={[progress]} onFocus={() => {}} noteLeads under={under} />
);
const leads = (page: HTMLElement) => (page.querySelector('.rail-note--leads') ? 'leads' : 'follows');

const readers: Record<string, Reader> = {
  'useElementSize (a box\'s size)': {
    node: () => <SizeProbe />,
    drawn: (page) => page.querySelector('.size-probe')!.getAttribute('data-size'),
    layouts: {
      a: { metric: (element, key) => (has(element, 'size-probe') ? ({ offsetWidth: 300, offsetHeight: 200 } as Record<string, number>)[key] ?? 0 : 0) },
      b: { metric: (element, key) => (has(element, 'size-probe') ? ({ offsetWidth: 300, offsetHeight: 245 } as Record<string, number>)[key] ?? 0 : 0) },
    },
    expected: { a: '300x200', b: '300x245' },
  },
  'TimerPrimitive (the rows\' height the field asks)': {
    node: () => <TimerPrimitive data={timers} slot="aux" />,
    drawn: (page) => page.querySelector<HTMLElement>('.timer-primitive__field')!.style.getPropertyValue('--timer-ask'),
    layouts: { a: timerLayout(130), b: timerLayout(150.5) },
    expected: { a: '130px', b: '150.5px' },
  },
  'InboxPrimitive (the list\'s width and type)': {
    node: () => <InboxPrimitive data={inbox} slot="primary" />,
    drawn: (page) => page.querySelector('.inbox-primitive__rows')!.className.replace('inbox-primitive__rows ', ''),
    layouts: { a: inboxLayout(500), b: inboxLayout(800) },
    expected: { a: 'inbox-primitive__rows--stack', b: 'inbox-primitive__rows--line' },
  },
  'ListViewport (whether the list scrolls)': {
    node: () => (
      <ListViewport>
        {Array.from({ length: 10 }, (_, index) => <div key={index} data-item={`t${index}`}>task {index}</div>)}
      </ListViewport>
    ),
    drawn: (page) => (page.querySelector('.list-viewport--scrolling') ? 'scrolls' : 'still'),
    layouts: { a: listLayout(3), b: listLayout(10) },
    expected: { a: 'still', b: 'scrolls' },
  },
  'WeatherPrimitive (whether the spot line sets the chance of rain aside)': {
    node: () => <WeatherPrimitive data={forecast} slot="aux" marked="2026-10-08T03:00" />,
    drawn: (page) => (page.querySelector('.weather-spot__precip--dropped') ? 'dropped' : 'kept'),
    layouts: {
      a: weatherLayout({ width: 252, height: 88, condition: [24, 66], spot: { room: 240, parts: spotParts } }),
      b: weatherLayout({ width: 252, height: 88, condition: [24, 66], spot: { room: 200, parts: spotParts } }),
    },
    expected: { a: 'kept', b: 'dropped' },
  },
  'WeatherPrimitive (the condition line\'s width beside an outlook)': {
    node: () => <WeatherPrimitive data={forecast} slot="aux" />,
    drawn: (page) => page.querySelector<HTMLElement>('[style*="--outlook-figure"]')?.style.getPropertyValue('--outlook-figure') ?? null,
    layouts: {
      a: weatherLayout({ width: 334, height: 128, condition: [24, 59] }),
      b: weatherLayout({ width: 334, height: 128, condition: [24, 90] }),
    },
    expected: { a: '140px', b: '171px' },
  },
  'the scene (whether the rail stands under the main column)': {
    node: () => <Scene actions={fixtures.architecture} />,
    drawn: (page) => [...page.querySelectorAll<HTMLElement>('.content-grid')].at(-1)!.style.getPropertyValue('--rail-floor'),
    layouts: { a: sceneLayout(false), b: sceneLayout(true) },
    expected: { a: '', b: '182px' },
  },
  'RailDetails beside the column (whether the note leads a crowded column)': {
    node: () => rail(false),
    drawn: leads,
    layouts: { a: railLayout(400, 200), b: railLayout(150, 200) },
    expected: { a: 'follows', b: 'leads' },
  },
  'RailDetails under the column (whether the note leads, by useRailFit)': {
    node: () => rail(true),
    drawn: leads,
    layouts: { a: railLayout(400, 200), b: railLayout(150, 200) },
    expected: { a: 'follows', b: 'leads' },
  },
};

// Every commit under the reader is counted.
let commits = 0;
const mountReader = (reader: Reader) =>
  mount(
    <Profiler id="reader" onRender={() => (commits += 1)}>
      {reader.node()}
    </Profiler>,
  );

// Reports outside act(), as the browser makes them: what the page holds when
// the callbacks return is what the frame is painted with. Then React's own
// schedule runs.
async function reportedOutsideAct(page: HTMLElement, reader: Reader): Promise<{ inCallback: string | null; settled: string | null }> {
  const flag = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  flag.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    reportAll();
    const inCallback = reader.drawn(page);
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    return { inCallback, settled: reader.drawn(page) };
  } finally {
    flag.IS_REACT_ACT_ENVIRONMENT = true;
  }
}

describe.each(Object.keys(readers))('%s', (name) => {
  const reader = readers[name];

  it('draws the layout\'s value in the first commit', () => {
    layout = reader.layouts.a;
    expect(reader.drawn(mountReader(reader))).toBe(reader.expected.a);
    unmountAll();
    layout = reader.layouts.b;
    expect(reader.drawn(mountReader(reader))).toBe(reader.expected.b);
  });

  it('commits a changed report in the observer\'s callback, before the frame it reports is painted', async () => {
    layout = reader.layouts.a;
    const page = mountReader(reader);
    layout = reader.layouts.b;
    const { inCallback, settled } = await reportedOutsideAct(page, reader);
    expect(inCallback).toBe(reader.expected.b);
    expect(settled).toBe(reader.expected.b);
  });

  it('commits nothing for a report of the value it holds', () => {
    layout = reader.layouts.a;
    const host = mountReader(reader);
    act(() => reportAll());
    const before = commits;
    act(() => reportAll());
    act(() => reportAll());
    expect(commits).toBe(before);
    expect(reader.drawn(host)).toBe(reader.expected.a);
  });

  it('leaves no observer behind when it unmounts', () => {
    layout = reader.layouts.a;
    mountReader(reader);
    expect(resizeObservers.size + mutationObservers).toBeGreaterThan(0);
    unmountAll();
    expect(resizeObservers.size).toBe(0);
    expect(mutationObservers).toBe(0);
  });
});

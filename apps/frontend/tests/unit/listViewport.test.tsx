// @vitest-environment jsdom
// A list that outgrows its slot scrolls inside it, and each edge it
// continues past says how many items lie that way, as a scrolled drawing's
// rails do. jsdom draws no boxes, so the rows' boxes are given here.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { countPast, leadScrollTop, ListViewport } from '../../src/primitives/ListViewport';

let host: HTMLDivElement | undefined;
let root: Root | undefined;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

const ROW = 30;

// A scroll 100px tall over `rows` rows of 30px, scrolled to `scrollTop`.
function layOut(scroll: HTMLElement, scrollTop: number) {
  const rows = Array.from(scroll.querySelectorAll<HTMLElement>('[data-item], [data-lead], h3'));
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 100 });
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: rows.length * ROW });
  scroll.scrollTop = scrollTop;
  scroll.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 200, width: 200, height: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => {
      const top = index * ROW - scroll.scrollTop;
      return { top, bottom: top + ROW, left: 0, right: 200, width: 200, height: ROW, x: 0, y: top, toJSON() {} } as DOMRect;
    };
  });
}

let surfaceClicks = 0;

// The list inside a surface that expands on a click, as a primitive sits.
function render(children: React.ReactNode, props: { lead?: string } = {}) {
  surfaceClicks = 0;
  const element = document.createElement('div');
  document.body.append(element);
  host = element;
  root = createRoot(element);
  act(() => root!.render(
    <div onClick={() => (surfaceClicks += 1)}>
      <ListViewport noun={['TASK', 'TASKS']} {...props}>{children}</ListViewport>
    </div>,
  ));
  return element.querySelector<HTMLElement>('.list-viewport__scroll')!;
}

const page = () => host!;

const rows = (count: number) => Array.from({ length: count }, (_, index) => <div key={index} data-item={`t${index}`}>task {index}</div>);

describe('countPast', () => {
  it('counts only items wholly past an edge; one the edge cuts is in view', () => {
    const items = [0, 30, 60, 90, 120].map((top) => ({ top, bottom: top + 30 }));
    expect(countPast(items, { top: 35, bottom: 95 })).toEqual({ above: 1, below: 1 });
    expect(countPast(items, { top: 30, bottom: 120 })).toEqual({ above: 1, below: 1 });
    expect(countPast(items, { top: 0, bottom: 150 })).toEqual({ above: 0, below: 0 });
  });

  it('counts items laid several to a row by their boxes', () => {
    const grid = [{ top: 0, bottom: 20 }, { top: 0, bottom: 20 }, { top: 200, bottom: 260 }, { top: 210, bottom: 240 }];
    expect(countPast(grid, { top: 30, bottom: 190 })).toEqual({ above: 2, below: 2 });
  });
});

describe('leadScrollTop', () => {
  it('stays put when the lead is in view', () => {
    expect(leadScrollTop({ top: 40, bottom: 70 }, 20, 100, 400)).toBe(20);
  });
  it('brings a lead below the view a quarter of the way down', () => {
    expect(leadScrollTop({ top: 300, bottom: 330 }, 0, 100, 400)).toBe(275);
  });
  it('never scrolls past either end', () => {
    expect(leadScrollTop({ top: 390, bottom: 400 }, 0, 100, 400)).toBe(300);
    expect(leadScrollTop({ top: -40, bottom: -10 }, 50, 100, 400)).toBe(0);
  });
});

describe('ListViewport', () => {
  it('a list that fits draws no rail and does not scroll', () => {
    const scroll = render(rows(3));
    layOut(scroll, 0);
    act(() => scroll.dispatchEvent(new Event('scroll')));
    expect(page().querySelector('.list-viewport__rim')).toBeNull();
    expect(scroll.tabIndex).toBe(-1);
  });

  it('counts the items past each edge in the noun given, and takes keys while it scrolls', async () => {
    const scroll = render(rows(10));
    layOut(scroll, 90);
    await act(async () => {
      scroll.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const rims = Array.from(page().querySelectorAll<HTMLElement>('.list-viewport__rim'));
    expect(rims.map((rim) => [rim.className.includes('--top') ? 'top' : 'bottom', rim.textContent])).toEqual([
      ['top', '3 TASKS'],
      ['bottom', '3 TASKS'],
    ]);
    expect(page().querySelectorAll('.drawing-viewport__rail')).toHaveLength(2);
    expect(scroll.tabIndex).toBe(0);
  });

  it('names one item in the singular', async () => {
    const scroll = render(rows(5));
    layOut(scroll, 0);
    await act(async () => {
      scroll.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(page().querySelector('.list-viewport__rim--bottom, .drawing-viewport__rim--bottom')!.textContent).toBe('1 TASK');
  });

  it('does not count what is not an item: a group heading', async () => {
    const scroll = render([...rows(4), <h3 key="h">LATER</h3>, ...[0, 1, 2, 3].map((index) => <div key={`b${index}`} data-item={`b${index}`}>b</div>)]);
    layOut(scroll, 0);
    await act(async () => {
      scroll.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    // Rows 0-3 (one cut at the edge), the heading at 4, rows 5-8 below.
    expect(page().querySelector('.drawing-viewport__rim--bottom')!.textContent).toBe('4 TASKS');
  });

  it("opens on its lead once per shape, and keeps the reader's place after", () => {
    const scroll = render(rows(10));
    layOut(scroll, 0);
    const again = (lead: string) =>
      act(() => root!.render(
        <div>
          <ListViewport noun={['TASK', 'TASKS']} lead={lead}>{rows(10)}</ListViewport>
        </div>,
      ));
    again('t8');
    // Row 8 (240-270) would rest a quarter view down, at 215; the list's
    // end stops it at 200.
    expect(scroll.scrollTop).toBe(200);
    scroll.scrollTop = 40;
    again('t8');
    expect(scroll.scrollTop).toBe(40);
  });

  it('a tap on a count turns a page and does not reach the surface around it', async () => {
    const scroll = render(rows(10));
    layOut(scroll, 0);
    await act(async () => {
      scroll.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const calls: ScrollToOptions[] = [];
    scroll.scrollBy = ((options: ScrollToOptions) => calls.push(options)) as typeof scroll.scrollBy;
    act(() => page().querySelector<HTMLElement>('.drawing-viewport__rim--bottom')!.click());
    expect(calls).toEqual([{ top: 85, behavior: expect.any(String) }]);
    expect(surfaceClicks).toBe(0);
  });
});

// @vitest-environment jsdom
// A list that outgrows its slot scrolls inside it, and each edge it
// continues past says how many items lie that way, as a scrolled drawing's
// rails do. jsdom draws no boxes, so the rows' boxes are given here.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FocusableSurface } from '../../src/primitives/FocusableSurface';
import { countPast, drawnScale, keyScrollTop, leadScrollTop, ListViewport } from '../../src/primitives/ListViewport';

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

// A scroll 100px tall over `rows` rows of 30px, scrolled to `scrollTop`,
// drawn at `scale` on screen (a focus opening scales the box it moves:
// its rects shrink, its layout sizes do not).
function layOut(scroll: HTMLElement, scrollTop: number, scale = 1) {
  const rows = Array.from(scroll.querySelectorAll<HTMLElement>('[data-item], [data-lead], h3'));
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 100 });
  Object.defineProperty(scroll, 'offsetHeight', { configurable: true, value: 100 });
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: rows.length * ROW });
  scroll.scrollTop = scrollTop;
  const at = (top: number, height: number, width = 200) => ({ top: 40 + top * scale, bottom: 40 + (top + height) * scale, left: 0, right: width * scale, width: width * scale, height: height * scale, x: 0, y: 40 + top * scale, toJSON() {} }) as DOMRect;
  scroll.getBoundingClientRect = () => at(0, 100);
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => at(index * ROW - scroll.scrollTop, ROW);
  });
}

async function measured(scroll: HTMLElement) {
  await act(async () => {
    scroll.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

let surfaceClicks = 0;

// The list inside the surface that expands its object, as a primitive sits.
function render(children: React.ReactNode, props: { lead?: string } = {}) {
  surfaceClicks = 0;
  const element = document.createElement('div');
  document.body.append(element);
  host = element;
  root = createRoot(element);
  act(() => root!.render(
    <FocusableSurface onActivate={() => (surfaceClicks += 1)} ariaLabel="Expand tasks">
      <ListViewport noun={['TASK', 'TASKS']} {...props}>{children}</ListViewport>
    </FocusableSurface>,
  ));
  return element.querySelector<HTMLElement>('.list-viewport__scroll')!;
}

const page = () => host!;

const rows = (count: number) => Array.from({ length: count }, (_, index) => <div key={index} data-item={`t${index}`}>task {index}</div>);

describe('countPast', () => {
  it('counts items past an edge; one the edge cuts is in view when more than a sliver of it shows', () => {
    const items = [0, 30, 60, 90, 120].map((top) => ({ top, bottom: top + 30 }));
    // 0-30 is past the top; 90-120 shows 5px (under its 12px sliver) and
    // counts as below with 120-150.
    expect(countPast(items, { top: 35, bottom: 95 })).toEqual({ above: 1, below: 2 });
    // 0-30 shows 15px at the top and 60-90 15px at the bottom: more than
    // their slivers, in view.
    expect(countPast(items, { top: 15, bottom: 75 })).toEqual({ above: 0, below: 2 });
    expect(countPast(items, { top: 30, bottom: 120 })).toEqual({ above: 1, below: 1 });
    expect(countPast(items, { top: 0, bottom: 150 })).toEqual({ above: 0, below: 0 });
  });

  it('a tall row showing only its padding is past the edge (16px at most)', () => {
    // A 36px row 7px into view: its top padding, not its words.
    expect(countPast([{ top: 469, bottom: 505 }], { top: 173, bottom: 476 })).toEqual({ above: 0, below: 1 });
    // A 200px card 17px into view is in view.
    expect(countPast([{ top: 459, bottom: 659 }], { top: 173, bottom: 476 })).toEqual({ above: 0, below: 0 });
  });

  it('counts items laid several to a row by their boxes', () => {
    const grid = [{ top: 0, bottom: 20 }, { top: 0, bottom: 20 }, { top: 200, bottom: 260 }, { top: 210, bottom: 240 }];
    expect(countPast(grid, { top: 30, bottom: 190 })).toEqual({ above: 2, below: 2 });
  });
});

describe('drawnScale', () => {
  it('is the drawn height over the laid-out one, and 1 before there is a box', () => {
    expect(drawnScale(50, 100)).toBe(0.5);
    expect(drawnScale(100, 100)).toBe(1);
    expect(drawnScale(0, 100)).toBe(1);
    expect(drawnScale(80, 0)).toBe(1);
  });
});

describe('leadScrollTop', () => {
  it('stays put when the lead is in view', () => {
    expect(leadScrollTop({ top: 40, bottom: 70 }, 20, 100, 400)).toBe(20);
  });
  it('brings a lead below the view a quarter of the way down', () => {
    expect(leadScrollTop({ top: 300, bottom: 330 }, 0, 100, 400)).toBe(275);
  });
  it('a lead under the fade at an edge the list continues past is not in view', () => {
    // In the box (60-90 of 0-100) but under the bottom band of 20.
    expect(leadScrollTop({ top: 75, bottom: 95 }, 0, 100, 400, 20)).toBe(50);
    // At the list's end there is no band: the last row is in view.
    expect(leadScrollTop({ top: 375, bottom: 395 }, 300, 100, 400, 20)).toBe(300);
    // Nor at the top when the list stands at its start.
    expect(leadScrollTop({ top: 0, bottom: 20 }, 0, 100, 400, 20)).toBe(0);
    expect(leadScrollTop({ top: 105, bottom: 115 }, 100, 100, 400, 20)).toBe(80);
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
      // Rows 7-9, and row 6 of which 10px of 30 show.
      ['bottom', '4 TASKS'],
    ]);
    expect(page().querySelectorAll('.drawing-viewport__rail')).toHaveLength(2);
    expect(scroll.tabIndex).toBe(0);
  });

  it('counts the same while a focus opening draws it scaled', async () => {
    const scroll = render(rows(10));
    layOut(scroll, 90, 0.5);
    await measured(scroll);
    expect(Array.from(page().querySelectorAll('.list-viewport__rim')).map((rim) => rim.textContent)).toEqual(['3 TASKS', '4 TASKS']);
  });

  it('counts only what countSelector picks', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    host = element;
    root = createRoot(element);
    act(() => root!.render(
      <ListViewport noun={['DAY', 'DAYS']} countSelector=".day">
        {Array.from({ length: 10 }, (_, index) => <div key={index} data-item={`i${index}`} className={index % 2 ? 'day' : 'hour'}>x</div>)}
      </ListViewport>,
    ));
    const scroll = element.querySelector<HTMLElement>('.list-viewport__scroll')!;
    layOut(scroll, 0);
    await measured(scroll);
    // Rows 3-9 lie below (10px of row 3 shows); the days among them are 3, 5, 7, 9.
    expect(element.querySelector('.list-viewport__rim')!.textContent).toBe('4 DAYS');
  });

  it('names one item in the singular', async () => {
    const scroll = render(rows(4));
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
    // Row 3 shows 10px, the heading is 4, rows 5-8 below: five tasks, the heading not one.
    expect(page().querySelector('.drawing-viewport__rim--bottom')!.textContent).toBe('5 TASKS');
  });

  it("opens on its lead once per shape, and keeps the reader's place after", () => {
    const scroll = render(rows(10));
    layOut(scroll, 0);
    const again = (lead: string) =>
      act(() => root!.render(
        <FocusableSurface onActivate={() => (surfaceClicks += 1)} ariaLabel="Expand tasks">
          <ListViewport noun={['TASK', 'TASKS']} lead={lead}>{rows(10)}</ListViewport>
        </FocusableSurface>,
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
    // The page hears every click (the audio unlock): the tap is marked
    // handled, never stopped.
    let heard = 0;
    const hear = () => (heard += 1);
    document.addEventListener('click', hear);
    act(() => page().querySelector<HTMLElement>('.drawing-viewport__rim--bottom')!.click());
    document.removeEventListener('click', hear);
    expect(calls).toEqual([{ top: 85, behavior: expect.any(String) }]);
    expect(surfaceClicks).toBe(0);
    expect(heard).toBe(1);
  });

  it('scrolls by its keys while it scrolls; Space does not expand the object, Enter still does', async () => {
    const scroll = render(rows(10));
    layOut(scroll, 0);
    await act(async () => {
      scroll.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const calls: ScrollToOptions[] = [];
    scroll.scrollTo = ((options: ScrollToOptions) => calls.push(options)) as typeof scroll.scrollTo;
    const press = (key: string) => act(() => scroll.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
    press(' ');
    press('End');
    expect(calls.map((call) => call.top)).toEqual([85, 200]);
    expect(surfaceClicks).toBe(0);
    press('Enter');
    expect(surfaceClicks).toBe(1);
  });
});

describe('keyScrollTop', () => {
  it('moves a line, a page, or to either end, and no further', () => {
    expect(keyScrollTop('ArrowDown', false, 0, 100, 400)).toBe(40);
    expect(keyScrollTop('ArrowUp', false, 10, 100, 400)).toBe(0);
    expect(keyScrollTop('PageDown', false, 250, 100, 400)).toBe(300);
    expect(keyScrollTop(' ', true, 200, 100, 400)).toBe(115);
    expect(keyScrollTop('Home', false, 200, 100, 400)).toBe(0);
    expect(keyScrollTop('End', false, 0, 100, 400)).toBe(300);
    expect(keyScrollTop('Enter', false, 0, 100, 400)).toBeNull();
    expect(keyScrollTop('a', false, 0, 100, 400)).toBeNull();
  });
});

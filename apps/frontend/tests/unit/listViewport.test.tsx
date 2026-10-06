// @vitest-environment jsdom
// A list that outgrows its slot scrolls inside it, and each edge it
// continues past says how many items lie that way, as a scrolled drawing's
// rails do. jsdom draws no boxes, so the rows' boxes are given here.
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { FocusableSurface } from '../../src/primitives/FocusableSurface';
import { drawnScale } from '../../src/hooks/useStageDemand';
import { keyStop } from '../../src/primitives/drawingScroll';
import { continuesPast, countPast, keyScrollTop, leadScrollTop, ListViewport } from '../../src/primitives/ListViewport';
import { mount, rerender, stubResizeObserver, unmountAll } from './sceneHarness';

let host: HTMLDivElement | undefined;

stubResizeObserver();

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
  host = mount(
    <FocusableSurface onActivate={() => (surfaceClicks += 1)} ariaLabel="Expand tasks">
      <ListViewport noun={['TASK', 'TASKS']} {...props}>{children}</ListViewport>
    </FocusableSurface>,
  );
  return host.querySelector<HTMLElement>('.list-viewport__scroll')!;
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

describe('continuesPast', () => {
  it('is an edge more than a sliver of the list lies past', () => {
    expect(continuesPast(0, 100, 400)).toEqual({ top: false, bottom: true });
    expect(continuesPast(150, 100, 400)).toEqual({ top: true, bottom: true });
    expect(continuesPast(290, 100, 400)).toEqual({ top: true, bottom: false });
    expect(continuesPast(10, 100, 115)).toEqual({ top: false, bottom: false });
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
  it('a list that fits draws no rail and does not scroll', async () => {
    const scroll = render(rows(3));
    layOut(scroll, 0);
    await measured(scroll);
    expect(page().querySelector('.scroll-rim__count, .scroll-rim__rail')).toBeNull();
    expect(page().querySelector('.list-viewport--scrolling')).toBeNull();
    expect(scroll.tabIndex).toBe(-1);
  });

  it('stays a tab stop when it overflows only sideways, and leaves Space to the surface', async () => {
    const scroll = render(rows(3));
    layOut(scroll, 0);
    Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(scroll, 'scrollWidth', { configurable: true, value: 600 });
    await measured(scroll);
    expect(scroll.tabIndex).toBe(0);
    expect(page().querySelector('.scroll-rim__count')).toBeNull();
    act(() => scroll.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })));
    expect(surfaceClicks).toBe(1);
  });

  it('counts the items past each edge in the noun given, and takes keys while it scrolls', async () => {
    const scroll = render(rows(10));
    layOut(scroll, 90);
    await act(async () => {
      scroll.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    const rims = Array.from(page().querySelectorAll<HTMLElement>('.list-viewport .scroll-rim__count'));
    expect(rims.map((rim) => [rim.className.includes('--top') ? 'top' : 'bottom', rim.textContent])).toEqual([
      ['top', '03 TASKS'],
      // Rows 7-9, and row 6 of which 10px of 30 show.
      ['bottom', '04 TASKS'],
    ]);
    expect(page().querySelectorAll('.scroll-rim__rail')).toHaveLength(2);
    expect(scroll.tabIndex).toBe(0);
  });

  it('counts the same while a focus opening draws it scaled', async () => {
    const scroll = render(rows(10));
    layOut(scroll, 90, 0.5);
    await measured(scroll);
    expect(Array.from(page().querySelectorAll('.list-viewport .scroll-rim__count')).map((rim) => rim.textContent)).toEqual(['03 TASKS', '04 TASKS']);
  });

  it('counts in its own pixels, so a count read while a cell settles scaled up is the count at rest', async () => {
    // A row 50px tall of which 10px show at the foot is past the edge (under
    // the 16px sliver). Drawn three times its size mid-animation, it shows
    // 30px on screen: still the same 10px of the list. The aux row's
    // inbox read '3 MESSAGES' or '4 MESSAGES' by which frame it was read
    // in, and nothing reads it again once such an animation ends.
    const counts: string[][] = [];
    for (const scale of [1, 3]) {
      const scroll = render(rows(6));
      Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 110 });
      Object.defineProperty(scroll, 'offsetHeight', { configurable: true, value: 110 });
      Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 300 });
      const at = (top: number, height: number) => ({ top: 40 + top * scale, bottom: 40 + (top + height) * scale, left: 0, right: 200, width: 200, height: height * scale, x: 0, y: 40 + top * scale, toJSON() {} }) as DOMRect;
      scroll.getBoundingClientRect = () => at(0, 110);
      scroll.querySelectorAll<HTMLElement>('[data-item]').forEach((row, index) => {
        row.getBoundingClientRect = () => at(index * 50, 50);
      });
      await measured(scroll);
      counts.push(Array.from(page().querySelectorAll('.scroll-rim__count')).map((rim) => rim.textContent ?? ''));
      unmountAll();
    }
    expect(counts).toEqual([['04 TASKS'], ['04 TASKS']]);
  });

  it('counts only what countSelector picks', async () => {
    const element = mount(
      <ListViewport noun={['DAY', 'DAYS']} countSelector=".day">
        {Array.from({ length: 10 }, (_, index) => <div key={index} data-item={`i${index}`} className={index % 2 ? 'day' : 'hour'}>x</div>)}
      </ListViewport>,
    );
    const scroll = element.querySelector<HTMLElement>('.list-viewport__scroll')!;
    layOut(scroll, 0);
    await measured(scroll);
    // Rows 3-9 lie below (10px of row 3 shows); the days among them are 3, 5, 7, 9.
    expect(element.querySelector('.list-viewport .scroll-rim__count')!.textContent).toBe('04 DAYS');
  });

  it('marks an edge it continues past where no item lies that way, as MORE', async () => {
    // A header taller than the view above the rows, as a forecast's
    // conditions stand above its days: scrolled to the rows, the top edge
    // has no row past it, and still says the list goes on.
    const element = mount(
      <ListViewport noun={['DAY', 'DAYS']} countSelector=".day">
        {[<h3 key="h">NOW</h3>, <h3 key="h2">HOURS</h3>, <h3 key="h3">MORE</h3>, ...[0, 1, 2, 3].map((index) => <div key={index} data-item={`d${index}`} className="day">day</div>)]}
      </ListViewport>,
    );
    const scroll = element.querySelector<HTMLElement>('.list-viewport__scroll')!;
    layOut(scroll, 90);
    await measured(scroll);
    const rims = Array.from(element.querySelectorAll('.list-viewport .scroll-rim__count')).map((rim) => [rim.className.includes('--top') ? 'top' : 'bottom', rim.textContent]);
    // 210 tall: the view 90-190 shows the days at 90-180 and a sliver of the last.
    expect(rims).toEqual([['top', 'MORE'], ['bottom', '01 DAY']]);
  });

  it('counts, draws its top edge and pages below a band pinned at its top (a table header)', async () => {
    const element = mount(
      <ListViewport noun={['ROW', 'ROWS']} pinned=".band">
        {[<div key="band" className="band">HEAD</div>, ...rows(10)]}
      </ListViewport>,
    );
    const scroll = element.querySelector<HTMLElement>('.list-viewport__scroll')!;
    layOut(scroll, 90);
    // The band covers the view's top 30px (40-70 on screen).
    element.querySelector<HTMLElement>('.band')!.getBoundingClientRect = () => ({ top: 40, bottom: 70, left: 0, right: 200, width: 200, height: 30, x: 0, y: 40, toJSON() {} }) as DOMRect;
    await measured(scroll);
    // Row 3 (40-70) lies under the band: past the top edge, with rows 0-2.
    const rims = Array.from(element.querySelectorAll<HTMLElement>('.scroll-rim__count'));
    expect(rims.map((rim) => rim.textContent)).toEqual(['04 ROWS', '04 ROWS']);
    expect(rims[0].style.top).toBe('30px');
    expect(element.querySelector<HTMLElement>('.scroll-rim__fade--top')!.style.top).toBe('30px');
    const calls: ScrollToOptions[] = [];
    scroll.scrollTo = ((options: ScrollToOptions) => calls.push(options)) as typeof scroll.scrollTo;
    act(() => scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true })));
    // A page of the 70px that show under the band.
    expect(calls.map((call) => call.top)).toEqual([90 + 61]);
  });

  it('names one item in the singular', async () => {
    const scroll = render(rows(4));
    layOut(scroll, 0);
    await act(async () => {
      scroll.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(page().querySelector('.scroll-rim__count--bottom')!.textContent).toBe('01 TASK');
  });

  it('does not count what is not an item: a group heading', async () => {
    const scroll = render([...rows(4), <h3 key="h">LATER</h3>, ...[0, 1, 2, 3].map((index) => <div key={`b${index}`} data-item={`b${index}`}>b</div>)]);
    layOut(scroll, 0);
    await act(async () => {
      scroll.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    // Row 3 shows 10px, the heading is 4, rows 5-8 below: five tasks, the heading not one.
    expect(page().querySelector('.scroll-rim__count--bottom')!.textContent).toBe('05 TASKS');
  });

  it("opens on its lead once per shape, and keeps the reader's place after", () => {
    const scroll = render(rows(10));
    layOut(scroll, 0);
    const again = (lead: string) =>
      rerender(page(),
        <FocusableSurface onActivate={() => (surfaceClicks += 1)} ariaLabel="Expand tasks">
          <ListViewport noun={['TASK', 'TASKS']} lead={lead}>{rows(10)}</ListViewport>
        </FocusableSurface>,
      );
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
    act(() => page().querySelector<HTMLElement>('.scroll-rim__count--bottom')!.click());
    document.removeEventListener('click', hear);
    expect(calls).toEqual([{ top: 88, behavior: expect.any(String) }]);
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
    expect(calls.map((call) => call.top)).toEqual([88, 200]);
    expect(surfaceClicks).toBe(0);
    press('Enter');
    expect(surfaceClicks).toBe(1);
  });
});

describe('keyScrollTop', () => {
  it('takes the keys a drawing takes, by the one rule (scrollMove)', () => {
    for (const key of [' ', 'PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab', 'a']) {
      expect(keyScrollTop(key, false, 0, 200, 600) === null, key).toBe(keyStop(key, false, false, [0, 300], 0, 200) === null);
    }
  });

  it('moves a line, a page, or to either end, and no further', () => {
    expect(keyScrollTop('ArrowDown', false, 0, 100, 400)).toBe(40);
    expect(keyScrollTop('ArrowUp', false, 10, 100, 400)).toBe(0);
    expect(keyScrollTop('PageDown', false, 250, 100, 400)).toBe(300);
    expect(keyScrollTop(' ', true, 200, 100, 400)).toBe(112);
    expect(keyScrollTop('Home', false, 200, 100, 400)).toBe(0);
    expect(keyScrollTop('End', false, 0, 100, 400)).toBe(300);
    expect(keyScrollTop('Enter', false, 0, 100, 400)).toBeNull();
    expect(keyScrollTop('a', false, 0, 100, 400)).toBeNull();
  });
});

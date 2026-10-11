// @vitest-environment jsdom
// A list that outgrows its slot scrolls inside it and takes the keys every
// scroller takes. It draws nothing on an edge it continues past: no rim,
// and no fade (#177). jsdom draws no boxes, so the rows' boxes are given
// here.
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { FocusableSurface } from '../../src/primitives/FocusableSurface';
import { drawnScale } from '../../src/hooks/useMeasured';
import { keyStop } from '../../src/primitives/drawingScroll';
import { keyScrollLeft, keyScrollTop, leadScrollTop, ListViewport } from '../../src/primitives/ListViewport';
import { mount, rerender, stubResizeObserver } from './sceneHarness';

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

// Nothing the viewport reads moves with the scroll: it measures when the
// list or its box changes (useMeasured's MutationObserver), which a
// comment appended to the scroll stands in for here.
async function measured(scroll: HTMLElement) {
  await act(async () => {
    scroll.append(document.createComment('measured'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let surfaceClicks = 0;

// The list inside the surface that expands its object, as a primitive sits.
function render(children: React.ReactNode, props: { lead?: string } = {}) {
  surfaceClicks = 0;
  host = mount(
    <FocusableSurface onActivate={() => (surfaceClicks += 1)} ariaLabel="Expand tasks">
      <ListViewport {...props}>{children}</ListViewport>
    </FocusableSurface>,
  );
  return host.querySelector<HTMLElement>('.list-viewport__scroll')!;
}

const page = () => host!;

const rows = (count: number) => Array.from({ length: count }, (_, index) => <div key={index} data-item={`t${index}`}>task {index}</div>);

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
  // A lead resting against an edge the list continues past is cut there,
  // and its NOTE badge was clipped by the frame around it (calendar.spec,
  // "no calendar part crosses its frame's inner box").
  it('keeps the lead clear of an edge the list continues past', () => {
    // In the box (75-95 of 0-100) but inside the bottom band of 20.
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
  it('a list that fits does not scroll', async () => {
    const scroll = render(rows(3));
    layOut(scroll, 0);
    await measured(scroll);
    expect(page().querySelector('.list-viewport--scrolling')).toBeNull();
    expect(scroll.tabIndex).toBe(-1);
  });

  // The rim a scroller drew on each edge it continues past -- a fade, a
  // dashed cut line, and a tag counting what lay that way, which a tap
  // turned a page by -- is gone (#177): the rows are cut at the edge and
  // nothing is drawn over them.
  it('draws nothing on an edge it continues past', async () => {
    const scroll = render(rows(10));
    layOut(scroll, 90);
    await measured(scroll);
    expect(page().querySelector('.scroll-rim__fade, .scroll-rim__rail, .scroll-rim__count')).toBeNull();
    expect(page().querySelector('.list-viewport__port')!.children).toHaveLength(1);
    expect(page().textContent).not.toMatch(/TASKS|MORE/);
  });

  // A list clips what sticks out sideways (.list-viewport__scroll is
  // overflow-x: hidden), and scrollWidth still counts it. Taken as a pane
  // that scrolls across, it was an empty tab stop, and its keys slid the
  // clipped rows sideways with nothing to slide them back; in a paged week
  // the hours took the keys that turn the days.
  it('a list that clips what sticks out sideways is no tab stop, and leaves its keys to what is around it', async () => {
    const scroll = render(rows(3));
    layOut(scroll, 0);
    scroll.style.overflowX = 'hidden';
    Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(scroll, 'scrollWidth', { configurable: true, value: 600 });
    await measured(scroll);
    expect(scroll.tabIndex).toBe(-1);
    const calls: ScrollToOptions[] = [];
    scroll.scrollTo = ((options: ScrollToOptions) => calls.push(options)) as typeof scroll.scrollTo;
    act(() => scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })));
    expect(calls).toEqual([]);
    act(() => scroll.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })));
    expect(surfaceClicks).toBe(1);
  });

  it('stays a tab stop when it overflows only sideways, and takes the keys across; Space does not expand the object', async () => {
    const scroll = render(rows(3));
    layOut(scroll, 0);
    // A pane that scrolls across (a table's, source's or document's).
    scroll.style.overflowX = 'auto';
    Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(scroll, 'scrollWidth', { configurable: true, value: 600 });
    await measured(scroll);
    expect(scroll.tabIndex).toBe(0);
    const calls: ScrollToOptions[] = [];
    scroll.scrollTo = ((options: ScrollToOptions) => calls.push(options)) as typeof scroll.scrollTo;
    const press = (key: string) => act(() => scroll.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
    press(' ');
    press('ArrowRight');
    press('End');
    // The arrows up and down are not its keys: they go on, unmarked.
    press('ArrowDown');
    expect(calls.map((call) => [call.left, call.top])).toEqual([[175, undefined], [40, undefined], [400, undefined]]);
    expect(surfaceClicks).toBe(0);
    press('Enter');
    expect(surfaceClicks).toBe(1);
  });

  it('pages below a band pinned at its top (a table header)', async () => {
    const element = mount(
      <ListViewport pinned=".band">
        {[<div key="band" className="band">HEAD</div>, ...rows(10)]}
      </ListViewport>,
    );
    const scroll = element.querySelector<HTMLElement>('.list-viewport__scroll')!;
    layOut(scroll, 90);
    // The band covers the view's top 30px (40-70 on screen).
    element.querySelector<HTMLElement>('.band')!.getBoundingClientRect = () => ({ top: 40, bottom: 70, left: 0, right: 200, width: 200, height: 30, x: 0, y: 40, toJSON() {} }) as DOMRect;
    await measured(scroll);
    const calls: ScrollToOptions[] = [];
    scroll.scrollTo = ((options: ScrollToOptions) => calls.push(options)) as typeof scroll.scrollTo;
    act(() => scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true })));
    // A page of the 70px that show under the band.
    expect(calls.map((call) => call.top)).toEqual([90 + 61]);
  });

  it("opens on its lead once per shape, and keeps the reader's place after", () => {
    const scroll = render(rows(10));
    layOut(scroll, 0);
    const again = (lead: string) =>
      rerender(page(),
        <FocusableSurface onActivate={() => (surfaceClicks += 1)} ariaLabel="Expand tasks">
          <ListViewport lead={lead}>{rows(10)}</ListViewport>
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

  it('scrolls by its keys while it scrolls; Space does not expand the object, Enter still does', async () => {
    const scroll = render(rows(10));
    layOut(scroll, 0);
    await measured(scroll);
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

describe('keyScrollLeft', () => {
  it('takes the keys a drawing that scrolls only across takes, by the one rule (scrollMove, across)', () => {
    for (const key of [' ', 'PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab', 'a']) {
      expect(keyScrollLeft(key, false, 0, 200, 600) === null, key).toBe(keyStop(key, false, true, [0, 300], 0, 200) === null);
    }
  });

  it('moves a line, a page, or to either side, and no further', () => {
    expect(keyScrollLeft('ArrowRight', false, 0, 100, 400)).toBe(40);
    expect(keyScrollLeft('ArrowLeft', false, 10, 100, 400)).toBe(0);
    expect(keyScrollLeft(' ', false, 250, 100, 400)).toBe(300);
    expect(keyScrollLeft(' ', true, 200, 100, 400)).toBe(112);
    expect(keyScrollLeft('Home', false, 200, 100, 400)).toBe(0);
    expect(keyScrollLeft('End', false, 0, 100, 400)).toBe(300);
    expect(keyScrollLeft('ArrowDown', false, 0, 100, 400)).toBeNull();
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

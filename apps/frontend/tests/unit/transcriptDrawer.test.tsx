// @vitest-environment jsdom
// The history follows its newest line while the caller is at the bottom, and
// stays where they are when they have scrolled up to reread (#267). It used
// to scroll on a change of the line count, which stops changing once the
// page's history holds its 200 lines: from then on a new line taller than
// the one it pushed out landed below the window.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptDrawer } from '../../src/components/TranscriptDrawer';
import { mount, rerender, unmountAll } from './sceneHarness';

type Line = { key: number; speaker: string; text: string };

// jsdom lays nothing out. Here a line is 50px tall, or 150px for a long one,
// the body's window is 300px, and the body scrolls as a browser does: never
// past its content.
const WINDOW_PX = 300;
const CAP = 200;
const LONG = 'A reply long enough to take three lines in the history.';

const isBody = (element: Element) => element.classList.contains('transcript__body');
const heightOf = (row: Element) => (row.textContent?.includes(LONG) ? 150 : 50);
const scrolled = new WeakMap<Element, number>();

function scrollHeightOf(element: Element): number {
  return [...element.querySelectorAll('.transcript-line')].reduce((total, row) => total + heightOf(row), 0);
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return isBody(this) ? WINDOW_PX : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return isBody(this) ? scrollHeightOf(this) : 0;
  });
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) {
    return scrolled.get(this) ?? 0;
  });
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, top: number) {
    const most = isBody(this) ? Math.max(0, scrollHeightOf(this) - WINDOW_PX) : 0;
    scrolled.set(this, Math.max(0, Math.min(most, top)));
  });
});

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

// Lines 1 to 400, each with its key, as the page runtime numbers them.
// Line 201 is long. Each window is new objects: a row is the line's key's,
// not its object's, so a clone on the way to the drawer keeps it (#398).
const said: Line[] = Array.from({ length: 2 * CAP }, (_, index) => ({
  key: index,
  speaker: index % 2 ? 'DAMOCLES' : 'CALLER',
  text: index + 1 === CAP + 1 ? LONG : `Line ${index + 1}.`,
}));
const lines = (from: number, to: number) => said.slice(from - 1, to).map((line) => ({ ...line }));

const drawer = (shown: Line[]) => <TranscriptDrawer open lines={shown} onClose={() => {}} />;
const bodyOf = (host: HTMLElement) => host.querySelector<HTMLElement>('.transcript__body')!;
const bottom = (body: HTMLElement) => body.scrollHeight - body.clientHeight;

function scrollTo(element: HTMLElement, top: number) {
  act(() => {
    element.scrollTop = top;
    element.dispatchEvent(new Event('scroll'));
  });
}

describe('TranscriptDrawer', () => {
  it('opens at the newest line', () => {
    const host = mount(drawer(lines(1, 10)));
    const body = bodyOf(host);
    expect(body.scrollTop).toBe(bottom(body));
  });

  it('follows a new line once the history is at its cap', () => {
    const host = mount(drawer(lines(1, CAP)));
    const body = bodyOf(host);
    expect(body.scrollTop).toBe(bottom(body));
    // The page keeps the last 200 lines: the long line 201 pushes out line
    // 1, and the count stays where it was.
    rerender(host, drawer(lines(2, CAP + 1)));
    expect(body.scrollTop).toBe(bottom(body));
  });

  it('stays where the caller scrolled up to while new lines arrive', () => {
    const host = mount(drawer(lines(1, 10)));
    const body = bodyOf(host);
    scrollTo(body, 40);
    rerender(host, drawer(lines(1, 11)));
    expect(body.scrollTop).toBe(40);
    // Back at the bottom, it follows again.
    scrollTo(body, bottom(body));
    rerender(host, drawer(lines(1, 12)));
    expect(body.scrollTop).toBe(bottom(body));
  });

  it('keeps each row it already drew when the oldest line drops off', () => {
    const host = mount(drawer(lines(1, CAP)));
    const kept = host.querySelectorAll('.transcript-line')[1];
    rerender(host, drawer(lines(2, CAP + 1)));
    // Line 2 is now the first row, and it is the same element.
    expect(host.querySelectorAll('.transcript-line')[0]).toBe(kept);
  });
});

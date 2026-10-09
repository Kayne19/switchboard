// @vitest-environment jsdom
// The live response is a scrolling log of what was said (#113): new lines are
// added at the bottom, it stays pinned there while they arrive, and the
// caller can scroll back up to read earlier lines.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageData, SpokenLine } from '../../src/controller/types';
import { LiveChatCard } from '../../src/primitives/LiveChatCard';
import { SpokenLog } from '../../src/primitives/SpokenLog';
import { mount, rerender, unmountAll } from './sceneHarness';

let host: HTMLDivElement;

beforeEach(() => {
  height = () => 40;
  layOut();
  host = mount(null);
});

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

function message(lines: SpokenLine[]): MessageData {
  return { segments: lines.length ? [{ text: lines.at(-1)!.text }] : [], lines };
}

const said = (count: number): SpokenLine[] =>
  Array.from({ length: count }, (_, index) => ({ id: index, text: `Line ${index + 1}.` }));

// jsdom lays nothing out. Here each line is `height(line)` tall (40px unless
// a test says otherwise), the log's window is 100px, and the newest section
// of a log is at least one window tall, as the stylesheet makes it (#178,
// #213): `.spoken-log-box .spoken-log__line--current`.
let height: (line: Element) => number = () => 40;
const WINDOW_PX = 100;

function linesOf(log: Element): Element[] {
  return [...log.querySelectorAll('.spoken-log__line')];
}

function layOut() {
  const scroller = (element: Element) => element.closest('[data-testid="spoken-log"]');
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return scroller(this) === this ? WINDOW_PX : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    const box = this.classList.contains('spoken-log-box');
    return linesOf(this).reduce((total, line) => {
      const newest = box && line.classList.contains('spoken-log__line--current');
      return total + (newest ? Math.max(WINDOW_PX, height(line)) : height(line));
    }, 0);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const log = scroller(this);
    if (!log || log === this) return { top: 0 } as DOMRect;
    const lines = linesOf(log);
    const above = lines.slice(0, lines.indexOf(this)).reduce((total, line) => total + height(line), 0);
    return { top: above - log.scrollTop } as DOMRect;
  });
}

function render(lines: SpokenLine[]) {
  rerender(host, <SpokenLog message={message(lines)} className="log" />);
  return host.querySelector<HTMLElement>('[data-testid="spoken-log"]')!;
}

function scrollTo(element: HTMLElement, top: number) {
  act(() => {
    element.scrollTop = top;
    element.dispatchEvent(new Event('scroll'));
  });
}

describe('SpokenLog', () => {
  it('lists the lines oldest first, the line being heard last', () => {
    render(said(3));
    const lines = [...host.querySelectorAll('.spoken-log__line')];
    expect(lines.map((line) => line.textContent)).toEqual(['Line 1.', 'Line 2.', 'Line 3.']);
    expect(lines.map((line) => line.classList.contains('spoken-log__line--current'))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('shows the segments before any line is heard', () => {
    rerender(host, <SpokenLog message={{ segments: [{ text: 'Line open.' }] }} className="log" />);
    expect(host.querySelector('.spoken-log')).toBeNull();
    expect(host.textContent).toBe('Line open.');
  });

  // #178: the newest section rests at the top of the box, the blank space
  // under it taking the rest; the earlier sections are above, out of view.
  it('rests with the newest section at the top of the box while sections arrive', () => {
    const log = render(said(3));
    render(said(4));
    // Four 40px sections: the fourth starts at 120, and its being a box
    // tall is what lets it rest there.
    expect(log.scrollTop).toBe(120);
    render(said(5));
    expect(log.scrollTop).toBe(160);
  });

  // #213: the blank space under the newest section is the section's own (the
  // stylesheet's least height for it in a `spoken-log-box`), not a box-tall
  // spacer after it, which let the caller scroll a whole box past its end.
  it('ends the log at its newest section: there is nothing after it to scroll to', () => {
    const log = render(said(2));
    expect(log.classList.contains('spoken-log-box')).toBe(true);
    expect(log.lastElementChild!.querySelector('[aria-current="true"]')).not.toBeNull();
    expect(log.querySelector('[role="log"]')!.lastElementChild!.getAttribute('aria-current')).toBe('true');
    expect(log.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('keeps no blank space under a message that is not a log', () => {
    rerender(host, <SpokenLog message={{ segments: [{ text: 'An agent message.' }] }} className="log" />);
    const log = host.querySelector<HTMLElement>('[data-testid="spoken-log"]')!;
    expect(log.classList.contains('spoken-log-box')).toBe(false);
  });

  it('lets the caller scroll back while lines arrive, and pins again at the newest section', () => {
    const log = render(said(4));
    render(said(5));
    expect(log.scrollTop).toBe(160);

    // Scrolled up to read an earlier section: a new one does not move it.
    scrollTo(log, 40);
    render(said(6));
    expect(log.scrollTop).toBe(40);

    // Back at the newest section (six of them), it is pinned again.
    scrollTo(log, 200);
    render(said(7));
    expect(log.scrollTop).toBe(240);
  });

  it('starts a section taller than the window at its first words', () => {
    height = (line) => (line.textContent === 'Line 3.' ? 300 : 40);
    const log = render(said(3));
    // Lines 1 and 2 take 80px; the section being heard starts there.
    expect(log.scrollTop).toBe(80);
    // Reading on through it keeps the log pinned.
    scrollTo(log, 200);
    render(said(4));
    expect(log.scrollTop).toBe(380);
  });

  it('leaves a message that is not a log where the reader put it', () => {
    rerender(host, <SpokenLog message={{ segments: [{ text: 'An agent message.' }] }} className="log" />);
    const log = host.querySelector<HTMLElement>('[data-testid="spoken-log"]')!;
    expect(log.scrollTop).toBe(0);
  });

  it("is the live chat card's own text area, not a second card", () => {
    rerender(host, <LiveChatCard message={message(said(2))} />);
    expect(host.querySelectorAll('[data-testid="live-chat"]')).toHaveLength(1);
    const text = host.querySelector('.live-chat-card__text')!;
    expect(text.querySelector('[role="log"]')).not.toBeNull();
    expect(text.getAttribute('data-testid')).toBe('spoken-log');
    expect(text.querySelectorAll('.spoken-log__line')).toHaveLength(2);
  });

  // The fades the card drew over the lines its box cuts are gone (#177):
  // the text is cut at the box's edge and nothing is drawn over it.
  it('draws nothing over the lines its box cuts', async () => {
    rerender(host, <SpokenLog message={message(said(6))} className="log" />);
    const log = host.querySelector<HTMLElement>('[data-testid="spoken-log"]')!;
    expect(host.querySelector('.scroll-rim__fade--top, .scroll-rim__fade--bottom')).toBeNull();
    scrollTo(log, 0);
    await act(() => new Promise((done) => requestAnimationFrame(() => done(undefined))));
    expect(host.querySelector('.scroll-rim__fade--top, .scroll-rim__fade--bottom')).toBeNull();
    rerender(host, <LiveChatCard message={message(said(6))} />);
    expect(host.querySelector('[class*="scroll-rim"]')).toBeNull();
  });
});

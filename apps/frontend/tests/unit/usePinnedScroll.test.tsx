// @vitest-environment jsdom
// What a reader of a pinned log sees: it follows its newest line, stays where
// the reader scrolled to, and a held log (paused, or not a log) is left alone.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePinnedScroll } from '../../src/hooks/usePinnedScroll';
import { mount, rerender, unmountAll } from './sceneHarness';

let content = 400;
let report: () => void = () => {};

class ReportingObserver {
  constructor(callback: () => void) {
    report = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function Log({ lines, enabled }: { lines: number; enabled: boolean }) {
  const { ref, onScroll } = usePinnedScroll<HTMLDivElement>(lines, enabled);
  return <div ref={ref} onScroll={onScroll} data-testid="log" />;
}

let host: HTMLDivElement;

beforeEach(() => {
  content = 400;
  vi.stubGlobal('ResizeObserver', ReportingObserver);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => content);
  host = mount(null);
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function draw(lines: number, enabled = true) {
  rerender(host, <Log lines={lines} enabled={enabled} />);
  return host.querySelector<HTMLElement>('[data-testid="log"]')!;
}

function scrollTo(log: HTMLElement, top: number) {
  act(() => {
    log.scrollTop = top;
    log.dispatchEvent(new Event('scroll'));
  });
}

describe('usePinnedScroll', () => {
  it('follows new content and a resize while it rests at the bottom', () => {
    const log = draw(1);
    expect(log.scrollTop).toBe(300);
    content = 500;
    draw(2);
    expect(log.scrollTop).toBe(400);
    content = 600;
    act(() => report());
    expect(log.scrollTop).toBe(500);
  });

  it('counts a log a few pixels short of the bottom as resting there', () => {
    const log = draw(1);
    scrollTo(log, 295);
    content = 500;
    draw(2);
    expect(log.scrollTop).toBe(400);
  });

  it('stays where the reader scrolled to until they scroll back to the bottom', () => {
    const log = draw(1);
    scrollTo(log, 100);
    content = 500;
    draw(2);
    act(() => report());
    expect(log.scrollTop).toBe(100);
    scrollTo(log, 400);
    content = 600;
    draw(3);
    expect(log.scrollTop).toBe(500);
  });

  it('leaves a held log where it is, and follows again when released', () => {
    const log = draw(1);
    content = 500;
    draw(2, false);
    act(() => report());
    expect(log.scrollTop).toBe(300);
    draw(2, true);
    expect(log.scrollTop).toBe(400);
  });

  it('resumes reading, not following, when it was held while the reader was reading', () => {
    const log = draw(1);
    scrollTo(log, 100);
    draw(1, false);
    draw(1, true);
    expect(log.scrollTop).toBe(100);
  });

  it('does not read a scroll made while held', () => {
    const log = draw(1, false);
    scrollTo(log, 100);
    draw(1, true);
    expect(log.scrollTop).toBe(300);
  });
});

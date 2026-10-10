// @vitest-environment jsdom
// useElementSize (src/hooks/useElementSize.ts). A size its observer reports
// is committed in the observer's own callback, before the frame it reports
// is painted: left to React's schedule it reached the page a frame or more
// late, and timers in an aux cell were drawn as a list in a field a grid's
// height (#333). And a report of the size already held commits nothing, so
// the report every observe() makes costs no render in the frame.
import { act, useLayoutEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useElementSize } from '../../src/hooks/useElementSize';
import { mount, unmountAll } from './sceneHarness';

const box = { width: 300, height: 200 };
const reports = new Set<() => void>();
let commits = 0;

let restore: Array<() => void> = [];
beforeEach(() => {
  const before = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    private readonly report: () => void;
    constructor(callback: () => void) {
      this.report = () => callback();
    }
    observe() {
      reports.add(this.report);
    }
    unobserve() {}
    disconnect() {
      reports.delete(this.report);
    }
  } as unknown as typeof ResizeObserver;
  restore.push(() => {
    globalThis.ResizeObserver = before;
  });
  for (const key of ['offsetWidth', 'offsetHeight'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)!;
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => (key === 'offsetWidth' ? box.width : box.height) });
    restore.push(() => Object.defineProperty(HTMLElement.prototype, key, descriptor));
  }
});
afterEach(() => {
  unmountAll();
  for (const undo of restore) undo();
  restore = [];
  reports.clear();
  Object.assign(box, { width: 300, height: 200 });
  commits = 0;
});

function Sized() {
  const ref = useRef<HTMLDivElement>(null);
  const size = useElementSize(ref);
  useLayoutEffect(() => {
    commits += 1;
  });
  return <div ref={ref} data-size={`${size.width}x${size.height}`} />;
}

const drawn = (host: HTMLElement) => host.firstElementChild?.getAttribute('data-size');

describe('useElementSize', () => {
  it('commits a size its observer reports in the callback, not on a later task', () => {
    const host = mount(<Sized />);
    expect(drawn(host)).toBe('300x200');
    box.height = 245;
    // Reported as the browser reports it, outside act(): what the page holds
    // when the callback returns is what the frame is painted with.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      reports.forEach((report) => report());
      expect(drawn(host)).toBe('300x245');
    } finally {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      act(() => {});
    }
  });

  it('commits nothing for a report of the size it holds', () => {
    const host = mount(<Sized />);
    const before = commits;
    act(() => reports.forEach((report) => report()));
    act(() => reports.forEach((report) => report()));
    expect(commits).toBe(before);
    expect(drawn(host)).toBe('300x200');
  });
});

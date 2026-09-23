// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLingeringValue } from '../../src/hooks/useLingeringValue';

function Probe({ value }: { value: string | null }) {
  return <span>{useLingeringValue(value, 1000) ?? 'none'}</span>;
}

// Every frame the probe rendered, so a test can prove none of them was empty.
let frames: string[];

function HeldProbe({ value }: { value: string | null }) {
  const shown = useLingeringValue(value, 1000, 1600) ?? 'none';
  frames.push(shown);
  return <span>{shown}</span>;
}

let host: HTMLDivElement;
let root: Root;
const show = (value: string | null) => act(() => root.render(<Probe value={value} />));
const hold = (value: string | null) => act(() => root.render(<HeldProbe value={value} />));
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  frames = [];
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('useLingeringValue', () => {
  it('shows a new value at once and holds the last one briefly after it goes', () => {
    show(null);
    expect(host.textContent).toBe('none');
    show('read');
    expect(host.textContent).toBe('read');
    show(null);
    act(() => vi.advanceTimersByTime(999));
    expect(host.textContent).toBe('read');
    act(() => vi.advanceTimersByTime(1));
    expect(host.textContent).toBe('none');
  });

  it('reads a run of short values as one steady status', () => {
    show('read');
    for (const value of [null, 'bash', null, 'edit', null]) {
      show(value);
      act(() => vi.advanceTimersByTime(200));
      // Never falls back to nothing between calls.
      expect(host.textContent).not.toBe('none');
    }
    expect(host.textContent).toBe('edit');
  });
});

describe('useLingeringValue with a minimum on-screen time', () => {
  it('keeps a near-instant value up for the minimum, counted from when it appeared', () => {
    hold('read');
    advance(50);
    hold(null);
    // The linger alone would have cleared it 1000 ms after it ended.
    advance(1000);
    expect(host.textContent).toBe('read');
    advance(549);
    expect(host.textContent).toBe('read');
    advance(1);
    expect(host.textContent).toBe('none');
  });

  it('still lingers after a long-running value ends', () => {
    hold('bash');
    advance(5000);
    hold(null);
    advance(999);
    expect(host.textContent).toBe('bash');
    advance(1);
    expect(host.textContent).toBe('none');
  });

  it('replaces the shown value the moment a new one arrives', () => {
    hold('read');
    advance(50);
    hold('bash');
    expect(host.textContent).toBe('bash');

    hold(null);
    advance(100);
    hold('edit');
    expect(host.textContent).toBe('edit');
  });

  it('restarts the minimum for the value that replaced the last one', () => {
    hold('read');
    advance(1000);
    hold('bash');
    advance(50);
    hold(null);
    // bash appeared at 1000 ms; its minimum runs to 2600 ms, past both
    // read's minimum and bash's own linger.
    advance(1549);
    expect(host.textContent).toBe('bash');
    advance(1);
    expect(host.textContent).toBe('none');
  });

  it('never renders an empty frame between back-to-back values', () => {
    for (const value of ['read', null, 'bash', null, 'edit']) {
      hold(value);
      advance(40);
    }
    hold(null);
    expect(frames.slice(0, frames.lastIndexOf('edit') + 1)).not.toContain('none');
    advance(1600);
    expect(host.textContent).toBe('none');
  });
});

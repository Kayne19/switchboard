// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLingeringValue } from '../../src/hooks/useLingeringValue';

function Probe({ value }: { value: string | null }) {
  return <span>{useLingeringValue(value, 1000) ?? 'none'}</span>;
}

let host: HTMLDivElement;
let root: Root;
const show = (value: string | null) => act(() => root.render(<Probe value={value} />));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
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

// @vitest-environment jsdom
// The debug page renders the fixture end to end: panes, wires, and the drawer.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugApp } from '../../src/debug/App';

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
});

beforeEach(() => {
  window.history.replaceState(null, '', '/?fixture=1&instant=1');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function settle() {
  for (let round = 0; round < 10; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe('debug page', () => {
  it('shows every pane, draws the routes, and opens a trace', async () => {
    act(() => root.render(<DebugApp />));
    await settle();
    const panes = [...host.querySelectorAll('.pane-name')].map((element) => element.textContent);
    expect(panes).toEqual(['operator', 'utility', 'alpha', 'beta']);
    expect(host.querySelector('.status')?.textContent).toContain('fixture');
    expect(host.querySelectorAll('.overlay path.wire').length).toBeGreaterThan(10);
    expect(host.querySelectorAll('.pi-tool').length).toBeGreaterThan(3);
    const fanOut = host.querySelector('[data-anchor="utt-u-103"]') as HTMLButtonElement;
    act(() => fanOut.click());
    const drawer = host.querySelector('.drawer');
    expect(drawer?.textContent).toContain('dispatch 2 parts → alpha, beta');
    expect(drawer?.textContent).toContain('current_agent_unsure');
    expect(drawer?.textContent).toContain('for_current_agent between the lower and upper thresholds');
    expect(drawer?.querySelectorAll('.bar-row').length).toBeGreaterThan(5);
    const dropped = host.querySelector('[data-anchor="utt-u-106"]') as HTMLButtonElement;
    expect(dropped.textContent).toContain('dropped (stale generation)');
    expect(dropped.textContent).not.toContain('routing…');
    expect(dropped.classList.contains('pending')).toBe(false);
    expect(host.querySelector('[data-anchor="utt-u-107"]')?.textContent).toContain('routing…');
    act(() => dropped.click());
    expect(host.querySelector('.drawer')?.textContent).toContain('no destination: the line changed before this was acted on');
    for (const tab of ['Timeline', 'Floor gate', 'Agents & hosts', 'Raw log']) {
      const button = [...host.querySelectorAll('.tabs button')].find((element) => element.textContent === tab) as HTMLButtonElement;
      act(() => button.click());
      expect(host.querySelector('.panel h2')?.textContent).toBeTruthy();
    }
    expect(host.querySelectorAll('.log-row').length).toBeGreaterThan(3);
  });
});

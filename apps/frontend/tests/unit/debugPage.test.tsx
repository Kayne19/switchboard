// @vitest-environment jsdom
// The debug page renders the fixture end to end: panes, wires, and the drawer.
import { act } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugApp } from '../../src/debug/App';
import { mount, rerender, stubResizeObserver } from './sceneHarness';

let host: HTMLDivElement;

beforeAll(() => {
  stubResizeObserver();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
});

beforeEach(() => {
  window.history.replaceState(null, '', '/?fixture=1&instant=1');
  host = mount(null);
});

/** Wait for fixture mode to load and play: its last utterance is on screen. */
async function settle() {
  // The fixture loads through a dynamic import, which can be slow on a busy
  // machine, so wait for its result instead of a fixed number of ticks.
  for (let round = 0; round < 300 && !host.querySelector('[data-anchor="utt-u-107"]'); round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe('debug page', () => {
  it('shows every pane, draws the routes, and opens a trace', async () => {
    rerender(host, <DebugApp />);
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

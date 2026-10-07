// @vitest-environment jsdom
// Under reduced motion the focused object's slot copy is hidden while it is
// focused (useFocusCopyHidden), as motion hides it where the copy and the
// focus share one identity. Before, the page gave motion no identity under
// reduced motion and the copy stayed in its slot under the 96.5% backdrop.
// The browser sees the pixels (tests/visual/focusModal.spec.ts); this sees
// which box stands aside.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderScene, runActions, stubResizeObserver } from './sceneHarness';

stubResizeObserver();

// Motion reads the setting from the media query once, when it first asks.
const realMatchMedia = window.matchMedia;
beforeAll(() => {
  window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
});
afterAll(() => {
  window.matchMedia = realMatchMedia;
});

const copies = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-focus-copy]')];

describe('the focused object under reduced motion', () => {
  it('hides its slot copy while it is focused, and only that one', () => {
    const host = renderScene([
      { op: 'show', id: 'build', type: 'progress', role: 'primary', data: { label: 'BUILD', value: 40 } },
      { op: 'show', id: 'cpu', type: 'metric', data: { label: 'CPU', value: '45%' } },
    ] as never);
    expect(copies(host)).toEqual([]);
    runActions([{ op: 'focus', id: 'build' }] as never);
    const hidden = copies(host);
    expect(hidden).toHaveLength(1);
    expect(hidden[0].closest('.focus-layer')).toBeNull();
    expect(hidden[0].textContent).toContain('BUILD');
    runActions([{ op: 'focus', id: null }] as never);
    expect(copies(host)).toEqual([]);
  });
});

// @vitest-environment jsdom
// Space on a focused table, code or document that scrolls turns a page, as
// it does on a list or a drawing (the one key rule, drawingScroll
// `scrollMove`): the scroller takes the key and marks it handled, so the
// surface around it does not open focus. Enter, which it does not take,
// still opens focus. jsdom draws no boxes, so the scroller's sizes are given.
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { ControllerAction } from '../../src/controller/types';
import { lastScene, renderScene, stubResizeObserver } from './sceneHarness';

stubResizeObserver();

const panes: Array<[string, string, ControllerAction]> = [
  ['table', '.table-viewport__scroll', { op: 'show', id: 'pane', type: 'table', role: 'primary', data: { title: 'RUNS', columns: [{ label: 'RUN' }], rows: Array.from({ length: 40 }, (_, row) => [`#${row}`]) } }],
  ['code', '.code-viewport__scroll', { op: 'show', id: 'pane', type: 'code', role: 'primary', data: { title: 'LONG', file: 'long.ts', source: { text: Array.from({ length: 80 }, (_, line) => `const line${line} = ${line};`).join('\n') } } }],
  ['document', '.document-viewport__body', { op: 'show', id: 'pane', type: 'document', role: 'primary', data: { subject: 'A long note', paragraphs: Array.from({ length: 30 }, (_, at) => `Paragraph ${at}.`) } }],
];

const press = (element: HTMLElement, key: string) => act(() => element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));

// A pane that overflows only sideways (a wide table on a phone, source with
// long lines) is a tab stop too, and took no keys: Space reached the
// surface and opened focus. It takes them across, as a drawing that
// scrolls only across does.
const sideways: Array<[string, string, ControllerAction]> = [
  ['table', '.table-viewport__scroll', { op: 'show', id: 'pane', type: 'table', role: 'primary', data: { title: 'WIDE', columns: Array.from({ length: 12 }, (_, column) => ({ label: `COLUMN ${column}` })), rows: [Array.from({ length: 12 }, (_, column) => `cell ${column}`), Array.from({ length: 12 }, (_, column) => column)] } }],
  ['code', '.code-viewport__scroll', { op: 'show', id: 'pane', type: 'code', role: 'primary', data: { title: 'WIDE', file: 'wide.ts', source: { text: `const wide = '${'x'.repeat(300)}';` } } }],
  ['document', '.document-viewport__body', { op: 'show', id: 'pane', type: 'document', role: 'primary', data: { subject: 'A wide note', paragraphs: [`\`${'x'.repeat(300)}\``] } }],
];

describe('a table, code or document pane that scrolls only sideways', () => {
  it.each(sideways)('%s: Space turns a page across and does not open focus; Enter still does', async (_type, selector, show) => {
    const host = renderScene([show]);
    const scroll = lastScene().querySelector<HTMLElement>(selector)!;
    // A view 200 px wide over 1000 px of content, and as tall as it.
    for (const [name, value] of [['clientHeight', 200], ['offsetHeight', 200], ['scrollHeight', 200], ['clientWidth', 200], ['offsetWidth', 200], ['scrollWidth', 1000]] as const) {
      Object.defineProperty(scroll, name, { configurable: true, value });
    }
    // Its stylesheet lets it scroll across (jsdom loads none).
    scroll.style.overflowX = 'auto';
    const moves: ScrollToOptions[] = [];
    scroll.scrollTo = ((options: ScrollToOptions) => moves.push(options)) as typeof scroll.scrollTo;
    await act(async () => {
      scroll.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(scroll.tabIndex).toBe(0);
    scroll.focus();
    press(scroll, ' ');
    expect(host.querySelector('.focus-layer')).toBeNull();
    press(scroll, 'End');
    // A page across (the view less its last eighth), then to the far side.
    expect(moves.map((move) => [move.left, move.top])).toEqual([[175, undefined], [800, undefined]]);
    press(scroll, 'Enter');
    expect(host.querySelector('.focus-layer')).not.toBeNull();
  });
});

describe('a scrolling table, code or document pane', () => {
  it.each(panes)('%s: Space turns a page and does not open focus; Enter still does', async (_type, selector, show) => {
    const host = renderScene([show]);
    const scroll = lastScene().querySelector<HTMLElement>(selector)!;
    // A view 200 px tall over 1000 px of rows.
    for (const [name, value] of [['clientHeight', 200], ['offsetHeight', 200], ['scrollHeight', 1000]] as const) {
      Object.defineProperty(scroll, name, { configurable: true, value });
    }
    const moves: number[] = [];
    scroll.scrollTo = ((options: ScrollToOptions) => moves.push(options.top ?? Number.NaN)) as typeof scroll.scrollTo;
    await act(async () => {
      scroll.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    scroll.focus();
    press(scroll, ' ');
    expect(host.querySelector('.focus-layer')).toBeNull();
    // A page: the view less its last eighth.
    expect(moves).toEqual([175]);
    press(scroll, 'Enter');
    expect(host.querySelector('.focus-layer')).not.toBeNull();
  });
});

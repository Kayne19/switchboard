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

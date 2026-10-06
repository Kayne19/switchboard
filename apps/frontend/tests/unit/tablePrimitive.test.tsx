// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { TablePrimitive, inferColumnAlignment } from '../../src/primitives/TablePrimitive';
import type { TableData } from '../../src/controller/types';
import { fixtures } from '../../src/fixtures/scenes';
import { mount, stubResizeObserver } from './sceneHarness';

// The rows scroll in a list viewport, which watches its box.
stubResizeObserver();

// In an aux cell, where no frame names the table and its meta line leads with its title.
function render(data: TableData) {
  return mount(<TablePrimitive data={data} slot="aux" />).querySelector('[data-testid="table"]') as HTMLElement;
}

const results = fixtures.results[0] as { data: TableData };

const table = (columns: string[], rows: TableData['rows']): TableData => ({
  columns: columns.map((label) => ({ label })),
  rows,
});

describe('inferColumnAlignment', () => {
  it('sets a column of quantities to the end and text to the start', () => {
    expect(inferColumnAlignment(table(['suite', 'passed', 'duration', 'rate', 'share', 'eta', 'host'], [
      ['backend', 442, '38.4s', '1,204 req/s', '91%', '01:42:18', 'damocles'],
      ['frontend', 318, '1m 48s', '-3.5e2', '0.5 %', '12:04', '10.0.0.4'],
    ]))).toEqual(['start', 'end', 'end', 'end', 'end', 'end', 'start']);
  });

  it('reads a currency amount as a quantity', () => {
    expect(inferColumnAlignment(table(['cost', 'delta', 'label'], [
      ['$1,200', '-$40', '$ for dollars'],
      ['\u20ac3.50', '+\u00a312', 'USD'],
      ['\u00a50', '\u2212\u20b9 5', 'n/a'],
    ]))).toEqual(['end', 'end', 'start']);
  });

  it('ignores blank cells and dashes, but one word turns the column to text', () => {
    expect(inferColumnAlignment(table(['a', 'b', 'c'], [
      [12, '', 'n/a'],
      ['\u2014', 3, '-'],
    ]))).toEqual(['end', 'end', 'start']);
    expect(inferColumnAlignment(table(['a'], [[12], ['twelve']]))).toEqual(['start']);
  });

  it('reads styled cells by their text, and sets an empty column to the start', () => {
    expect(inferColumnAlignment(table(['a', 'b'], [[{ text: '2', bold: true }, { text: 'two' }]]))).toEqual(['end', 'start']);
    expect(inferColumnAlignment(table(['a'], []))).toEqual(['start']);
  });
});

describe('TablePrimitive', () => {
  it('draws every column header and every cell as text, numbers included', () => {
    const view = render(results.data);
    const heads = [...view.querySelectorAll('th')].map((node) => node.textContent);
    expect(heads).toEqual(['SUITE', 'PASSED', 'FAILED', 'SKIPPED', 'DURATION']);
    const rows = [...view.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(results.data.rows.length);
    expect([...rows[0].querySelectorAll('td')].map((node) => node.textContent)).toEqual(['backend / unit', '442', '0', '3', '38.4s']);
    expect(view.querySelector('.table-viewport__meta')?.textContent).toBe('TESTS / MATRIX5 ROWS / 5 COLS');
  });

  it('aligns the inferred quantity columns to the end, header and cells alike', () => {
    const view = render(results.data);
    const heads = [...view.querySelectorAll('th')];
    expect(heads.map((node) => node.classList.contains('table-grid__cell--end'))).toEqual([false, true, true, true, true]);
    const firstRow = [...view.querySelectorAll('tbody tr')[0].querySelectorAll('td')];
    expect(firstRow.map((node) => node.classList.contains('table-grid__cell--end'))).toEqual([false, true, true, true, true]);
  });

  it('marks exactly the highlighted rows', () => {
    const view = render(results.data);
    const hot = [...view.querySelectorAll('tbody tr')].map((row) => row.classList.contains('table-grid__row--hot'));
    expect(hot).toEqual([false, false, true, false, false]);
  });

  it('colours a header by its column semantic and a cell by its own, and emboldens a bold cell', () => {
    const view = render(results.data);
    expect(view.querySelectorAll('th')[1].querySelector('.semantic-green')).not.toBeNull();
    const failedCell = view.querySelectorAll('tbody tr')[2].querySelectorAll('td')[2];
    const text = failedCell.querySelector('.table-grid__text')!;
    expect(text.classList.contains('semantic-red')).toBe(true);
    expect(text.classList.contains('table-grid__text--bold')).toBe(true);
    const plainCell = view.querySelectorAll('tbody tr')[0].querySelectorAll('td')[1];
    expect(plainCell.querySelector('[class*="semantic-"]')).toBeNull();
  });

  it('keeps model text as text, never markup', () => {
    const view = render(table(['a'], [['<b onclick=alert(1)>bold</b>']]));
    expect(view.querySelector('b')).toBeNull();
    expect(view.querySelector('td')?.textContent).toBe('<b onclick=alert(1)>bold</b>');
  });

  it('keeps the meta line out of the scroll, so rows scroll only under the sticky header', () => {
    const view = render(results.data);
    // In the mask's top row, beside the frame's top-right step; the scroll stands in the row under it.
    expect(view.querySelector('.table-viewport__mask > .table-viewport__meta + .list-viewport')).not.toBeNull();
    expect(view.querySelector('.table-viewport__scroll .table-viewport__meta')).toBeNull();
    expect(view.querySelector('.table-viewport__scroll')?.firstElementChild?.tagName).toBe('TABLE');
  });

  it('says so when there are no rows, and scrolls inside the frame mask', () => {
    const view = render(table(['a', 'b'], []));
    expect(view.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(view.querySelector('.table-grid__empty')?.textContent).toBe('NO ROWS');
    expect(view.querySelector('.table-viewport__mask .list-viewport__port > .table-viewport__scroll')).not.toBeNull();
    expect(view.querySelector('.tech-frame')).not.toBeNull();
  });
});

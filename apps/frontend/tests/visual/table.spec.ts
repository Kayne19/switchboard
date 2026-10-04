import { expect, test, type Page } from '@playwright/test';

// Table layout the unit tests cannot see: jsdom draws no boxes.

async function showTable(page: Page, data: Record<string, unknown>) {
  await page.goto('/?scene=architecture&chrome=0');
  await expect(page.locator('.stage')).toBeVisible();
  await page.evaluate((tableData) => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({ op: 'show', id: 'table', type: 'table', role: 'primary', data: tableData });
  }, data);
  await expect(page.locator('[data-scene="table"] .table-grid')).toBeVisible();
}

const fleet = {
  title: 'FLEET / HOSTS',
  columns: [{ label: 'HOST' }, { label: 'STATE' }, { label: 'CPU' }, { label: 'P95' }, { label: 'UPTIME' }],
  rows: Array.from({ length: 40 }, (_, i) => [`host-${i}`, i % 2 ? 'up' : 'down', `${i}%`, `${i * 13} ms`, `${i}h ${i}m`]),
};

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`a scrolled table shows no row above its header, and the header clears the frame's cut / ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await showTable(page, fleet);
    const geometry = await page.evaluate(async () => {
      const scroll = document.querySelector<HTMLElement>('.table-viewport__scroll')!;
      scroll.scrollTop = 400;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const mask = document.querySelector<HTMLElement>('.table-viewport__mask')!.getBoundingClientRect();
      const head = document.querySelector<HTMLElement>('.table-grid__head')!.getBoundingClientRect();
      const port = scroll.getBoundingClientRect();
      return { scrolled: scroll.scrollTop, headTop: head.top, portTop: port.top, maskTop: mask.top, maskHeight: mask.height };
    });
    expect(geometry.scrolled).toBeGreaterThan(0);
    // The header is the scrollport's top edge, so a row scrolling up passes
    // under it and never shows in a band above it.
    expect(Math.abs(geometry.headTop - geometry.portTop)).toBeLessThanOrEqual(1);
    // The mask cuts its top-right corner down to 5.7% of its height; the
    // header, labels right-aligned to that corner, sits below the cut.
    expect(geometry.headTop - geometry.maskTop).toBeGreaterThanOrEqual(geometry.maskHeight * 0.057);
  });
}

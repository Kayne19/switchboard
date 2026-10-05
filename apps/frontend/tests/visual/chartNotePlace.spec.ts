import { expect, test, type Page } from '@playwright/test';

// A note a chart has no clear place for stays readable beside the chart:
// where the rail stands under the charts (a portrait stage) it lies in a
// band under them, carved from their slot, rather than in the rail under
// the metrics, below what the rail shows; where the rail stands beside a
// short chart (a phone on its side) it leads the rail, whole, and a card
// on the chart is never so short that its text is cut to nothing.

const uptime = [
  { op: 'clear' },
  {
    op: 'show', id: 'uptime', type: 'chart', role: 'primary',
    data: {
      kind: 'bar', title: 'FLEET / NODE UPTIME', labels: ['us-east', 'us-west', 'eu-west', 'eu-north', 'ap-south', 'ap-east'],
      // The domain is given, and every bar stands to its top: no place on
      // the chart is clear of the data.
      yMax: 100,
      series: [
        { name: 'THIS MONTH', semantic: 'green', values: [99.9, 99.7, 100, 99.8, 99.95, 99.6] },
        { name: 'LAST MONTH', semantic: 'muted', values: [99.8, 99.9, 99.9, 99.95, 100, 99.7] },
      ],
    },
  },
  { op: 'show', id: 'm1', type: 'metric', data: { label: 'FLEET', value: '99.8%' } },
  { op: 'show', id: 'm2', type: 'metric', data: { label: 'NODES', value: '412' } },
  { op: 'show', id: 'm3', type: 'metric', data: { label: 'INCIDENTS', value: '5' } },
  {
    op: 'show', id: 'uptime-note', type: 'note',
    data: { tag: 'OBSERVATION / EU-WEST', anchor: { target: 'uptime', x: 2, series: 'THIS MONTH' }, segments: [{ text: 'eu-west held a full month without an outage, the first since the move to the new provider.' }] },
  },
];

async function show(page: Page, scene: string, actions: unknown[] = []) {
  await page.goto(`/?scene=${scene}&chrome=0`);
  await expect(page.locator('.stage')).toBeVisible();
  if (actions.length > 0) {
    await page.evaluate((list) => {
      const run = window.SwitchboardController?.run;
      if (!run) throw new Error('controller unavailable');
      run(list);
    }, actions);
  }
  await page.waitForTimeout(900);
}

for (const size of [{ width: 390, height: 844 }, { width: 820, height: 1180 }]) {
  test(`a note with no clear place on its chart lies in a band under it at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await show(page, 'comparison', uptime);
    const band = page.locator('.chart-note-band');
    await expect(band).toContainText('eu-west held a full month without an outage');
    await expect(band.locator('.annotation-card__anchor')).toHaveText(/^TARGET \/ eu-west \/ THIS MONTH$/i);
    // Not in the rail as well, and not on the chart.
    await expect(page.locator('.content-rail .rail-note')).toHaveCount(0);
    await expect(page.locator('.chart-note[data-note="uptime-note"]')).toHaveCount(0);
    // The bar it names stays marked.
    await expect(page.locator('.chart-callout[data-index="2"][data-series="THIS MONTH"]')).toHaveCount(1);
    const geometry = await page.evaluate(() => {
      const card = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        const { left, top, right, bottom } = element.getBoundingClientRect();
        return { left, top, right, bottom };
      };
      const text = document.querySelector<HTMLElement>('.chart-note-band .annotation-card__text')!;
      return {
        band: card('.chart-note-band'),
        chart: card('.chart-object'),
        main: card('.content-grid > .content-main'),
        rail: card('.content-rail'),
        whole: text.scrollHeight <= text.clientHeight + 1,
      };
    });
    // Under the chart, in the main column, above the rail; its text whole.
    expect(geometry.band.top).toBeGreaterThanOrEqual(geometry.chart.bottom);
    expect(geometry.band.bottom).toBeLessThanOrEqual(geometry.main.bottom + 1);
    expect(geometry.band.bottom).toBeLessThanOrEqual(geometry.rail.top);
    expect(geometry.whole).toBe(true);
  });
}

test('a note with no clear place on its chart stays in the rail beside it on a landscape stage', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await show(page, 'comparison', uptime);
  await expect(page.locator('.chart-note-band')).toHaveCount(0);
  await expect(page.locator('.content-rail .rail-note')).toContainText('eu-west held a full month without an outage');
});

for (const scene of ['training', 'comparison']) {
  test(`on a phone on its side the ${scene} note is read whole, on the chart or leading the rail`, async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await show(page, scene);
    const geometry = await page.evaluate(() => {
      const whole = (element: HTMLElement | null) => {
        const text = element?.querySelector<HTMLElement>('.annotation-card__text');
        return text ? text.scrollHeight <= text.clientHeight + 1 && text.clientHeight > 0 : null;
      };
      const cards = [...document.querySelectorAll<HTMLElement>('.chart-note:not(.chart-note--away)')].map(whole);
      const details = document.querySelector<HTMLElement>('.content-rail__details')!;
      const note = details.querySelector<HTMLElement>('.rail-note');
      const column = details.getBoundingClientRect();
      const noteBox = note?.getBoundingClientRect();
      return {
        cards,
        rail: note ? { whole: whole(note), first: details.firstElementChild === note, inView: noteBox!.top >= column.top - 1 && noteBox!.bottom <= column.bottom + 1 } : null,
      };
    });
    for (const card of geometry.cards) expect(card).toBe(true);
    if (geometry.rail) {
      expect(geometry.rail).toEqual({ whole: true, first: true, inView: true });
    }
    expect(geometry.cards.length + (geometry.rail ? 1 : 0)).toBe(1);
  });
}

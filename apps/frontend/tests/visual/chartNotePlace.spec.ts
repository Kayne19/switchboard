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
        // First in the column as it is read: above everything else shown there.
        rail: note
          ? {
              whole: whole(note),
              first: [...details.children].every((other) => other === note || other.getBoundingClientRect().height === 0 || other.getBoundingClientRect().top >= noteBox!.bottom - 1),
              inView: noteBox!.top >= column.top - 1 && noteBox!.bottom <= column.bottom + 1,
            }
          : null,
      };
    });
    for (const card of geometry.cards) expect(card).toBe(true);
    if (geometry.rail) {
      expect(geometry.rail).toEqual({ whole: true, first: true, inView: true });
    }
    expect(geometry.cards.length + (geometry.rail ? 1 : 0)).toBe(1);
  });
}

test('a card on the chart keeps clear of the value printed for the note in the band', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await show(page, 'comparison', [{
    op: 'show', id: 'backend-note', type: 'note',
    data: { tag: 'OBSERVATION / BACKEND', segments: [{ text: 'The backend suite is the other long pole, and it grew by two seconds.' }], anchor: { target: 'durations', x: 0, series: 'PREVIOUS RUN' } },
  }]);
  await expect(page.locator('.chart-note-band')).toHaveCount(1);
  const geometry = await page.evaluate(() => {
    const box = (element: Element) => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    return {
      cards: [...document.querySelectorAll('.chart-note:not(.chart-note--away)')].map(box),
      values: [...document.querySelectorAll('.chart-object :is(.chart-marker__value, .chart-callout__value)')].map(box),
    };
  });
  // Both notes' points print their values: the one on the chart and the one in the band.
  expect(geometry.values.length).toBeGreaterThanOrEqual(2);
  for (const card of geometry.cards) {
    for (const value of geometry.values) {
      const apart = card.right <= value.left || value.right <= card.left || card.bottom <= value.top || value.bottom <= card.top;
      expect(apart).toBe(true);
    }
  }
});

test('a compare pair on a portrait phone keeps its second chart in view, the note leading the rail', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await show(page, 'training', [{"op": "show", "id": "previous-run", "type": "chart", "role": "compare", "data": {"xLabel": "EPOCH", "yLabel": "LOSS", "xMax": 40, "yMin": 0.08, "yMax": 0.3, "series": [{"name": "VAL LOSS", "semantic": "cyan", "values": [0.292, 0.278, 0.263, 0.249, 0.237, 0.226, 0.216, 0.207, 0.199, 0.192, 0.186, 0.181, 0.177, 0.174, 0.172, 0.171, 0.172, 0.174, 0.177, 0.181, 0.186, 0.192, 0.199, 0.207, 0.216, 0.224]}], "title": "RUN / GRAPE-AMODAL-03", "subtitle": "COMPARISON / PREVIOUS", "context": "TRAINING RUN", "compareLabel": "PREVIOUS"}}]);
  await expect(page.locator('.chart-object')).toHaveCount(2);
  // A band would push the compare chart out of the scrolling row.
  await expect(page.locator('.chart-note-band')).toHaveCount(0);
  const geometry = await page.evaluate(() => {
    const row = document.querySelector('.training-charts')!.getBoundingClientRect();
    const compare = document.querySelectorAll('.chart-object')[1].getBoundingClientRect();
    const note = document.querySelector('.content-rail .rail-note')?.getBoundingClientRect() ?? null;
    const details = document.querySelector('.content-rail__details')!.getBoundingClientRect();
    return { row: { top: row.top, bottom: row.bottom }, compareTop: compare.top, note: note && { top: note.top, bottom: note.bottom }, details: { top: details.top, bottom: details.bottom } };
  });
  expect(geometry.compareTop).toBeLessThan(geometry.row.bottom - 40);
  if (geometry.note) expect(geometry.note.top).toBeLessThanOrEqual(geometry.details.top + 2);
});

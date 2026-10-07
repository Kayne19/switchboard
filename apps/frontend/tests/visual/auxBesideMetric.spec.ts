import { expect, test } from '@playwright/test';
import { FRAME_GEOMETRIES, openScene, runActions } from './helpers';

// A metric primary with a chart beside it. On a phone on its side (844x390)
// the chart's cell ran past the main column and the stage's foot, its x axis
// out of view (REPORT-fix-drawing.md, Open 4): the metric card kept its
// height and the row under it its cells' floor, and the two did not fit.
// On a stage twice as wide as tall the row stands beside the card; on any
// other it takes what the card leaves and scrolls inside it.
const actions = [
  { op: 'show', id: 'p95', type: 'metric', role: 'primary', data: { label: 'P95 LATENCY', value: '182 ms', trend: 'down', delta: '-12 ms' } },
  { op: 'show', id: 'trend', type: 'chart', data: { title: 'TREND', xLabel: 'DAY', yLabel: 'MS', xMax: 9, series: [{ name: 'P95', values: [200, 195, 190, 188, 186, 185, 184, 183, 182, 182] }] } },
];

for (const size of FRAME_GEOMETRIES) {
  test(`${size.width}x${size.height}: a chart beside a metric primary is drawn whole inside the main column`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await openScene(page, 'idle');
    await runActions(page, actions);
    await expect(page.locator('.composed-aux [data-testid="chart"]')).toBeVisible();
    await page.waitForTimeout(600);
    const boxes = await page.evaluate(() => {
      const box = (selector: string) => {
        const { top, bottom, left, right } = document.querySelector(selector)!.getBoundingClientRect();
        return { top, bottom, left, right };
      };
      return { main: box('.content-grid > .content-main'), row: box('.composed-aux'), chart: box('.composed-aux [data-testid="chart"] svg'), card: box('.composed-primary-object') };
    });
    expect(boxes.row.bottom).toBeLessThanOrEqual(boxes.main.bottom + 1);
    // The chart, its x axis included, is in view: inside the row it scrolls in.
    expect(boxes.chart.top).toBeGreaterThanOrEqual(boxes.row.top - 1);
    expect(boxes.chart.bottom).toBeLessThanOrEqual(boxes.row.bottom + 1);
    // Card and chart do not overlap.
    const apart = boxes.chart.top >= boxes.card.bottom - 1 || boxes.chart.left >= boxes.card.right - 1;
    expect(apart).toBe(true);
  });
}

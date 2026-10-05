import { expect, test } from '@playwright/test';

// A stepped progress where the unit tests cannot see it: jsdom draws no
// boxes. In the rail it reads as the metrics above it do.

const railSteps = Array.from({ length: 7 }, (_, i) => ({ label: `STEP ${i + 1}`, state: i < 4 ? 'done' : i === 4 ? 'active' : 'todo' }));

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`the plan in the rail reads as the metrics above it / ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/?scene=architecture&chrome=0');
    await page.evaluate((plan) => {
      const controller = window.SwitchboardController;
      if (!controller) throw new Error('controller unavailable');
      controller.run([
        { op: 'clear' },
        { op: 'show', id: 'map', type: 'diagram', role: 'primary', data: { mode: 'graph', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] } },
        { op: 'show', id: 'tests', type: 'metric', data: { label: 'TESTS PASSING', value: '418', trend: 'up', delta: '+31' } },
        { op: 'show', id: 'plan', type: 'progress', data: { label: 'SHIP', steps: plan } },
      ]);
    }, railSteps);
    await expect(page.locator('.rail-progress .progress-primitive--rail')).toBeVisible();
    const rows = await page.evaluate(() => {
      const metric = document.querySelector<HTMLElement>('.metrics--rail .metric-row')!;
      const head = document.querySelector<HTMLElement>('.progress-primitive__head')!;
      const label = (row: HTMLElement) => getComputedStyle(row.querySelector('.metric-row__label')!);
      const step = getComputedStyle(document.querySelector('.rail-progress .progress-step')!);
      return {
        metricHeight: metric.getBoundingClientRect().height,
        headHeight: head.getBoundingClientRect().height,
        metricLabel: [label(metric).fontFamily, label(metric).fontSize, label(metric).letterSpacing],
        headLabel: [label(head).fontFamily, label(head).fontSize, label(head).letterSpacing],
        stepRule: step.borderTopWidth,
      };
    });
    expect(Math.abs(rows.headHeight - rows.metricHeight)).toBeLessThanOrEqual(1);
    expect(rows.headLabel).toEqual(rows.metricLabel);
    expect(rows.stepRule).toBe('1px');
  });
}

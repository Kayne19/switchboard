import { expect, test, type Page } from '@playwright/test';
import { FRAME_GEOMETRIES, openScene, runActions } from './helpers';

// A stepped progress where the unit tests cannot see it: jsdom draws no
// boxes. As the primary it is framed to its own height; in the rail it reads
// as the metrics above it do.

const steps = (count: number, firstOpen: number) => Array.from({ length: count }, (_, i) => ({
  label: `STEP ${i + 1}`,
  state: i < firstOpen ? 'done' : i === firstOpen ? 'active' : 'todo',
  detail: 'DETAIL',
}));

async function show(page: Page, actions: unknown[]) {
  await openScene(page, 'architecture');
  await runActions(page, [{ op: 'clear' }, ...actions]);
  await page.waitForTimeout(600);
}

async function primaryGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const list = document.querySelector<HTMLElement>('.composed-primary-object--progress .progress-primitive__steps')!;
    return {
      column: box('.content-grid > .content-main'),
      panel: box('.composed-primary-object--progress'),
      listScrolls: list.scrollHeight > list.clientHeight + 1,
    };
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  const size = `${viewport.width}x${viewport.height}`;

  test(`a short plan as the primary is framed to its height and centred / ${size}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await show(page, [{ op: 'show', id: 'plan', type: 'progress', role: 'primary', data: { label: 'SHIP', steps: steps(4, 2) } }]);
    const { column, panel, listScrolls } = await primaryGeometry(page);
    expect(panel.height).toBeLessThan(column.height * 0.8);
    expect(Math.abs((panel.top + panel.bottom) / 2 - (column.top + column.bottom) / 2)).toBeLessThanOrEqual(2);
    expect(listScrolls).toBe(false);
  });

  test(`a long plan as the primary fills the column and scrolls its list inside / ${size}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await show(page, [{ op: 'show', id: 'plan', type: 'progress', role: 'primary', data: { label: 'MIGRATION', steps: steps(30, 12) } }]);
    const { column, panel, listScrolls } = await primaryGeometry(page);
    expect(panel.top).toBeGreaterThanOrEqual(column.top - 1);
    expect(panel.bottom).toBeLessThanOrEqual(column.bottom + 1);
    expect(panel.height).toBeGreaterThan(column.height - 2);
    expect(listScrolls).toBe(true);
  });
}

const railSteps = Array.from({ length: 7 }, (_, i) => ({ label: `STEP ${i + 1}`, state: i < 4 ? 'done' : i === 4 ? 'active' : 'todo' }));

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`the plan in the rail reads as the metrics above it / ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openScene(page, 'architecture');
    await runActions(page, [
      { op: 'clear' },
      { op: 'show', id: 'map', type: 'diagram', role: 'primary', data: { mode: 'graph', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] } },
      { op: 'show', id: 'tests', type: 'metric', data: { label: 'TESTS PASSING', value: '418', trend: 'up', delta: '+31' } },
      { op: 'show', id: 'plan', type: 'progress', data: { label: 'SHIP', steps: railSteps } },
    ]);
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

// A label with no space to break at (a path, a long name) wraps inside its
// column: it ran out of it, under the bar and past the frame (a 74-character
// path reached 754 px of a 390 px phone).
for (const geometry of FRAME_GEOMETRIES) {
  test(`an unbroken progress label stays in its column / ${geometry.name}`, async ({ page }) => {
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    for (const label of ['/home/kayne19/projects/switchboard/apps/frontend/src/primitives/notePlacement.ts', 'P'.repeat(128)]) {
      await show(page, [{ op: 'show', id: 'run', type: 'progress', role: 'primary', data: { label, value: 27 } }]);
      const boxes = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        return { label: box('.scene .progress-primitive__label'), strong: box('.scene .progress-primitive__label strong'), track: box('.scene .progress-primitive__track'), frame: box('.scene [data-testid="progress"]') };
      });
      expect(boxes.strong.right, label).toBeLessThanOrEqual(boxes.label.right + 1);
      expect(boxes.strong.right, label).toBeLessThanOrEqual(boxes.track.left);
      expect(boxes.strong.left, label).toBeGreaterThanOrEqual(boxes.frame.left - 1);
    }
  });
}

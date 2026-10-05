import { expect, test, type Page } from '@playwright/test';

// The aux row's geometry, which the unit tests cannot see: jsdom draws no
// boxes. tests/unit/auxRowLayout.test.ts pins the stylesheet rules these
// boxes come from.

// A 1x1 PNG: the smallest picture both validators accept. The page fits it
// to its cell, whatever its own size.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const table = {
  title: 'TESTS / MATRIX',
  columns: [{ label: 'SUITE' }, { label: 'PASSED' }, { label: 'FAILED' }, { label: 'DURATION' }],
  rows: [['backend / unit', 442, 0, '38.4s'], ['frontend / unit', 318, 2, '9.7s'], ['frontend / visual', 24, 0, '1m 48s']],
};

// A metric primary with every kind of cell under it: more than a portrait
// column has room for.
const crowded = [
  { op: 'show', id: 'latency', type: 'metric', role: 'primary', data: { label: 'P95 LATENCY', value: '182 ms', trend: 'down', delta: '-12 ms' } },
  { op: 'show', id: 'trend', type: 'chart', data: { title: 'TREND', series: [{ name: 'P95', values: [220, 198, 190, 186, 182] }] } },
  { op: 'show', id: 'source', type: 'code', data: { source: { text: 'export function route(r) {\n  return attach(resolve(r));\n}' } } },
  { op: 'show', id: 'matrix', type: 'table', data: table },
  { op: 'show', id: 'figure', type: 'image', data: { format: 'png', bytes: PNG_1X1, alt: 'A dot' } },
  { op: 'show', id: 'deploy', type: 'progress', data: { label: 'DEPLOY', steps: [{ label: 'BUILD', state: 'done' }, { label: 'PUSH', state: 'active' }, { label: 'VERIFY' }] } },
];

async function show(page: Page, actions: unknown[]) {
  await page.goto('/?scene=architecture&chrome=0');
  await expect(page.locator('.stage')).toBeVisible();
  await page.evaluate((list) => {
    const controller = window.SwitchboardController;
    if (!controller) throw new Error('controller unavailable');
    controller.run([{ op: 'clear' }, ...list]);
  }, actions);
  await expect(page.locator('.composed-aux')).toBeVisible();
  await page.waitForTimeout(600);
}

// Each aux cell's box, the boxes of the image inside it, and the row's.
async function auxGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element | null) => {
      if (!element) return null;
      const { left, top, right, bottom, height } = element.getBoundingClientRect();
      return { left, top, right, bottom, height };
    };
    const row = document.querySelector<HTMLElement>('.composed-aux')!;
    return {
      row: { ...box(row)!, scrollHeight: row.scrollHeight, clientHeight: row.clientHeight },
      main: box(document.querySelector('.content-grid > .content-main')),
      cells: [...row.querySelectorAll('.composed-aux-object')].map((cell) => ({
        visual: cell.classList.contains('composed-aux-object--visual'),
        kind: [...cell.classList].find((name) => name.startsWith('composed-aux-object--') && name !== 'composed-aux-object--visual'),
        cell: box(cell)!,
        image: box(cell.querySelector('.image-primitive__img')),
        caption: box(cell.querySelector('.image-primitive__caption')),
      })),
    };
  });
}

// Wide, portrait, and a landscape phone: the shortest stage, where a crowded
// row has the least room.
const viewports = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }];
// The least a visual's cell may get: the floor's clamp minimum on a short
// stage, its share of the stage height on a taller one.
const floorFor = (viewport: { height: number }) => (viewport.height < 500 ? 100 : 120);

for (const viewport of viewports) {
  const size = `${viewport.width}x${viewport.height}`;
  test(`no visual in a crowded aux row collapses; the row scrolls instead / ${size}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await show(page, crowded);
    const geometry = await auxGeometry(page);
    expect(geometry.cells.map((cell) => cell.kind)).toEqual([
      'composed-aux-object--chart', 'composed-aux-object--code', 'composed-aux-object--table',
      'composed-aux-object--image', 'composed-aux-object--progress',
    ]);
    for (const cell of geometry.cells) {
      expect(cell.cell.height, cell.kind).toBeGreaterThanOrEqual(cell.visual ? floorFor(viewport) : 40);
    }
    // The row stays inside the main column (its bleed aside) and scrolls
    // whatever it cannot show.
    expect(geometry.row.bottom).toBeLessThanOrEqual(geometry.main!.bottom + 8);
    if (viewport.width < viewport.height) expect(geometry.row.scrollHeight).toBeGreaterThan(geometry.row.clientHeight);
  });

  test(`under a visual primary a crowded aux row keeps to its share and scrolls / ${size}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await show(page, [
      { op: 'show', id: 'map', type: 'diagram', role: 'primary', data: { mode: 'graph', nodes: [{ id: 'a', label: 'CALLER' }, { id: 'b', label: 'PBX' }], edges: [{ from: 'a', to: 'b' }] } },
      ...crowded.filter((action) => action.type !== 'metric' && action.type !== 'progress'),
    ]);
    const geometry = await auxGeometry(page);
    expect(geometry.cells).toHaveLength(4);
    for (const cell of geometry.cells) expect(cell.cell.height, cell.kind).toBeGreaterThanOrEqual(floorFor(viewport));
    // Two fifths of the column at most; the rest is the diagram's.
    expect(geometry.row.bottom - geometry.row.top).toBeLessThanOrEqual(geometry.main!.height * 0.4 + 13);
    expect(geometry.row.scrollHeight).toBeGreaterThan(geometry.row.clientHeight);
  });

  test(`a chart primary keeps its share when a progress and a table stand beside it / ${size}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await show(page, [
      { op: 'show', id: 'loss', type: 'chart', role: 'primary', data: { title: 'LOSS', series: [{ name: 'TRAIN', values: [0.3, 0.25, 0.2, 0.18] }] } },
      crowded.find((action) => action.id === 'deploy'),
      { op: 'show', id: 'matrix', type: 'table', data: table },
    ]);
    const heights = await page.evaluate(() => {
      const height = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().height ?? 0;
      return { charts: height('.training-charts'), aux: height('.composed-aux'), underCharts: height('.training-progress') };
    });
    // The progress joins the table in the aux row rather than taking the
    // charts' height from under them.
    expect(heights.underCharts).toBe(0);
    expect(await page.locator('.composed-aux [data-testid="progress"]').count()).toBe(1);
    expect(heights.charts).toBeGreaterThan(heights.aux);
  });

  test(`an image in a crowded aux row is contained, not cropped / ${size}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    // The mix that cropped the picture to its top band at 390x844.
    await show(page, crowded.filter((action) => ['latency', 'figure', 'trend', 'deploy'].includes(action.id)));
    await expect(page.locator('.composed-aux [data-testid="image"]')).toHaveAttribute('data-state', 'ready');
    const image = (await auxGeometry(page)).cells.find((cell) => cell.kind === 'composed-aux-object--image')!;
    // The picture is fitted (object-fit: contain) to its box; the box and
    // the caption under it lie inside the cell.
    expect(image.image!.height).toBeGreaterThan(0);
    expect(image.image!.top).toBeGreaterThanOrEqual(image.cell.top);
    expect(image.image!.bottom).toBeLessThanOrEqual(image.cell.bottom);
    expect(image.caption!.bottom).toBeLessThanOrEqual(image.cell.bottom);
  });

  test(`a visual primary keeps the larger share over a table and an image beside it / ${size}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/?scene=composed&chrome=0');
    await expect(page.locator('[data-scene="architecture"] .composed-aux [data-testid="table"]')).toBeVisible();
    await expect(page.locator('.composed-aux [data-testid="image"]')).toHaveAttribute('data-state', 'ready');
    const shares = await page.evaluate(() => {
      const height = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().height;
      return { main: height('.content-grid > .content-main'), diagram: height('.diagram-object'), aux: height('.composed-aux') };
    });
    expect(shares.diagram).toBeGreaterThan(shares.aux);
    expect(shares.aux).toBeLessThanOrEqual(shares.main * 0.4 + 13);
  });
}

// In a narrow aux cell a table scrolls sideways inside its viewport; it
// never splits a word to fit.
test('a table in a narrow aux cell breaks between words, never inside one', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await show(page, crowded);
  const broken = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.composed-aux .table-grid td .table-grid__text')]
    .filter((node) => !/\s/.test(node.textContent ?? ''))
    .filter((node) => node.getClientRects().length > 1)
    .map((node) => node.textContent));
  expect(broken).toEqual([]);
});

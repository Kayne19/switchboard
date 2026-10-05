import { expect, test, type Page } from '@playwright/test';

// A primary that outgrows the column it shares with a rail standing under it
// takes the stage's height; the rail folds to a strip of its note and
// Damocles (apps/frontend/src/app/stageFold.ts). Before, on a 390x844 phone
// the diagram slot kept 59% of the stage whatever it held, and a forty-step
// pipeline was read through a viewport of 374 px, two steps at a time, the
// note and the emblem under it. tests/unit/stageFold.test.tsx pins the rule;
// these pin the boxes, which jsdom does not draw.

const rows = Array.from({ length: 40 }, (_, index) => [`suite-${String(index).padStart(2, '0')}`, 10 + ((index * 37) % 880), index % 3 ? 'ok' : 'slow', `${(index * 1.7).toFixed(1)} s`]);
const longTable = [
  { op: 'clear' },
  { op: 'show', id: 'suites', type: 'table', role: 'primary', data: { title: 'CI / ALL SUITES', columns: [{ label: 'SUITE' }, { label: 'TESTS' }, { label: 'STATE' }, { label: 'TIME' }], rows } },
  { op: 'show', id: 'suites-note', type: 'note', data: { tag: 'OBSERVATION / SUITES', segments: [{ text: 'Three suites run past a minute.' }], anchor: { target: 'suites' } } },
  { op: 'show', id: 'total', type: 'metric', data: { label: 'TOTAL', value: '148 s' } },
];
const longCode = [
  { op: 'clear' },
  { op: 'show', id: 'steps', type: 'code', role: 'primary', data: { title: 'SOURCE / STEPS', source: { text: Array.from({ length: 80 }, (_, index) => `const step${index} = run(${index});`).join('\n') } } },
  { op: 'show', id: 'steps-note', type: 'note', data: { segments: [{ text: 'Step 12 is where the off-by-one enters.' }], anchor: { target: 'steps' } } },
];
const longDocument = [
  { op: 'clear' },
  { op: 'show', id: 'thread', type: 'document', role: 'primary', data: { kind: 'email', subject: 'Re: a long thread', paragraphs: Array.from({ length: 12 }, (_, index) => `Paragraph ${index}: the residual correction should stay framed as a lightweight final-stage adjustment rather than a second model.`) } },
  { op: 'show', id: 'thread-note', type: 'note', data: { segments: [{ text: 'Arden agrees; nothing to do yet.' }] } },
];
const shortTable = [
  { op: 'clear' },
  { op: 'show', id: 'suites', type: 'table', role: 'primary', data: { columns: [{ label: 'SUITE' }, { label: 'TESTS' }], rows: [['backend', 442], ['frontend', 318]] } },
  { op: 'show', id: 'suites-note', type: 'note', data: { segments: [{ text: 'All green.' }] } },
];

async function open(page: Page, scene: string, actions: unknown[] = []) {
  await page.goto(`/?scene=${scene}&chrome=0`);
  await expect(page.locator('.stage')).toBeVisible();
  if (actions.length > 0) {
    await page.evaluate((list) => {
      const controller = window.SwitchboardController;
      if (!controller) throw new Error('controller unavailable');
      controller.run(list);
    }, actions);
  }
  await expect(page.locator('.content-grid')).toBeVisible();
  // Long enough for every primitive to have said what it needs.
  await page.waitForTimeout(700);
}

async function boxes(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
      return { left, top, right, bottom, width, height };
    };
    const main = '.content-grid > .content-main';
    return {
      stage: box('.stage')!,
      main: box(main)!,
      rail: box('.content-rail')!,
      note: box('.content-rail .rail-note'),
      presence: box('.content-rail [data-testid="damocles-presence"]'),
      footer: box('.scene-footer'),
      viewport: box(`${main} :is(.drawing-viewport, .table-viewport__scroll, .code-viewport__scroll, .document-viewport__body)`),
      marker: box(`${main} :is(.diagram-node__marker, .sequence-actor__marker)`),
      folded: document.querySelector('.content-rail--folded') !== null,
      foldable: document.querySelector('.content-rail--foldable') !== null,
    };
  });
}

const inside = (inner: { top: number; bottom: number; left: number; right: number }, outer: { top: number; bottom: number; left: number; right: number }) =>
  inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1 && inner.left >= outer.left - 1 && inner.right <= outer.right + 1;

const outgrowing: Array<{ name: string; scene: string; actions?: unknown[]; sizes: Array<{ width: number; height: number }> }> = [
  { name: 'pipeline', scene: 'pipeline', sizes: [{ width: 390, height: 844 }] },
  { name: 'topology', scene: 'topology', sizes: [{ width: 390, height: 844 }] },
  { name: 'trace', scene: 'trace', sizes: [{ width: 390, height: 844 }, { width: 820, height: 1180 }] },
  { name: 'a long table', scene: 'idle', actions: longTable, sizes: [{ width: 390, height: 844 }, { width: 820, height: 1180 }] },
  { name: 'long code', scene: 'idle', actions: longCode, sizes: [{ width: 390, height: 844 }] },
  { name: 'a long document', scene: 'idle', actions: longDocument, sizes: [{ width: 390, height: 844 }] },
];

for (const { name, scene, actions, sizes } of outgrowing) {
  for (const size of sizes) {
    test(`${name} takes the stage's height at ${size.width}x${size.height}, its rail folded to a strip`, async ({ page }) => {
      await page.setViewportSize(size);
      await open(page, scene, actions);
      await expect(page.locator('.content-rail--folded')).toBeVisible();
      const laid = await boxes(page);
      const shared = laid.stage.height * 0.59;
      // The primary gains a tenth of the stage at the least, the strip
      // keeping under a sixth of it.
      expect(laid.main.height).toBeGreaterThan(shared + laid.stage.height * 0.1);
      expect(laid.rail.height).toBeLessThan(laid.stage.height / 6);
      expect(laid.rail.top).toBeGreaterThanOrEqual(laid.main.bottom);
      // Damocles stays present, and the note stays on the stage, in the strip.
      expect(laid.presence).not.toBeNull();
      expect(inside(laid.presence!, laid.rail)).toBe(true);
      expect(laid.note).not.toBeNull();
      expect(inside(laid.note!, laid.rail)).toBe(true);
      expect(inside(laid.rail, laid.stage)).toBe(true);
      // The strip stands clear of the footer's metadata.
      expect(laid.rail.bottom).toBeLessThanOrEqual(laid.footer!.top);
    });
  }
}

test('a note on a folded rail stays matched to the node it names', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'pipeline');
  await expect(page.locator('.content-rail--folded')).toBeVisible();
  await expect(page.locator('.content-rail .annotation-card__node-badge')).toHaveText('NOTE');
  const laid = await boxes(page);
  // The drawing opens on the node the note names, its marker in view.
  expect(laid.marker).not.toBeNull();
  expect(inside(laid.marker!, laid.viewport!)).toBe(true);
});

const fitting: Array<{ name: string; scene: string; actions?: unknown[] }> = [
  { name: 'training', scene: 'training' },
  { name: 'comparison', scene: 'comparison' },
  { name: 'email', scene: 'email' },
  { name: 'code', scene: 'code' },
  { name: 'results', scene: 'results' },
  { name: 'figure', scene: 'figure' },
  { name: 'composed', scene: 'composed' },
  { name: 'a short table', scene: 'idle', actions: shortTable },
];
for (const size of [{ width: 390, height: 844 }, { width: 820, height: 1180 }]) {
  for (const { name, scene, actions } of fitting) {
    test(`${name} reads whole in its share at ${size.width}x${size.height} and keeps the rail`, async ({ page }) => {
      await page.setViewportSize(size);
      await open(page, scene, actions);
      const laid = await boxes(page);
      expect(laid.foldable).toBe(false);
      expect(Math.abs(laid.main.height - laid.stage.height * 0.59)).toBeLessThan(1.5);
    });
  }
}

for (const size of [{ width: 844, height: 390 }, { width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 2560, height: 1080 }]) {
  test(`a rail beside the primary never folds at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await open(page, 'pipeline');
    const laid = await boxes(page);
    expect(laid.foldable).toBe(false);
    expect(laid.rail.left).toBeGreaterThanOrEqual(laid.main.right);
  });
}

test('the caller opens the folded rail and folds it again', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'plan');
  const handle = page.locator('button.rail-handle');
  await expect(handle).toHaveText(/02 METRICS \/ PROGRESS/);
  await expect(page.locator('.content-rail [data-testid="metrics"]')).toHaveCount(0);
  await handle.click();
  await expect(page.locator('.content-rail--open')).toBeVisible();
  await expect(page.locator('.content-rail [data-testid="metrics"]')).toBeVisible();
  await page.waitForTimeout(500);
  const opened = await boxes(page);
  expect(Math.abs(opened.main.height - opened.stage.height * 0.59)).toBeLessThan(1.5);
  await expect(handle).toHaveText(/FOLD/);
  await handle.click();
  await expect(page.locator('.content-rail--folded')).toBeVisible();
  await expect(page.locator('.content-rail [data-testid="metrics"]')).toHaveCount(0);
});

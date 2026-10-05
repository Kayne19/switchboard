import { expect, test, type Page } from '@playwright/test';
import { DisplayFixtureServer } from '../integration/display-fixture-server.mjs';
import { transcriptEntry } from '../fixtures/serverMessages';

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

const longPlan = [
  { op: 'clear' },
  {
    op: 'show', id: 'migration', type: 'progress', role: 'primary',
    data: { label: 'MIGRATION / 30 SHARDS', steps: Array.from({ length: 30 }, (_, index) => ({ label: `MIGRATE SHARD ${index}`, state: index < 12 ? 'done' : index === 12 ? 'active' : 'todo', detail: `node ${index % 5}` })) },
  },
  { op: 'show', id: 'migration-note', type: 'note', data: { segments: [{ text: 'Shard 12 is moving now.' }], anchor: { target: 'migration' } } },
];
const manyBars = [
  { op: 'clear' },
  {
    op: 'show', id: 'minutes', type: 'chart', role: 'primary',
    data: { kind: 'bar', title: 'CI / 45 SERVICES', labels: Array.from({ length: 45 }, (_, index) => `service-${String(index).padStart(2, '0')}`), series: [{ name: 'THIS WEEK', values: Array.from({ length: 45 }, (_, index) => 10 + ((index * 37) % 80)) }] },
  },
];
// A stepped plan under a chart is not the primary: its list scrolls in
// its own row and the rail stays.
const chartOverPlan = [
  { op: 'show', id: 'progress', type: 'progress', data: { label: 'EPOCH 41 / 80', value: 51, steps: Array.from({ length: 12 }, (_, index) => ({ label: `STAGE ${index}`, state: index < 5 ? 'done' : 'todo' })) } },
];
// A long table in the aux row under a diagram that fits: the row scrolls,
// and the primary, which reads whole, keeps the rail.
const tableBeside = [
  { op: 'clear' },
  { op: 'show', id: 'flow', type: 'diagram', role: 'primary', data: { mode: 'graph', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] } },
  { op: 'show', id: 'suites', type: 'table', data: { columns: [{ label: 'SUITE' }, { label: 'TESTS' }], rows: rows.map((row) => [row[0], row[1]]) } },
];

// A picture three times as tall as it is wide, drawn by the page itself.
async function tallFigure(page: Page) {
  const bytes = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 1200;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#222';
    context.fillRect(0, 0, 400, 1200);
    context.strokeStyle = '#f60';
    for (let y = 0; y < 1200; y += 60) context.strokeRect(20, y + 5, 360, 45);
    return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
  });
  return [
    { op: 'clear' },
    { op: 'show', id: 'settings', type: 'image', role: 'primary', data: { format: 'png', bytes, alt: 'The settings list, all of it' } },
    { op: 'show', id: 'settings-note', type: 'note', data: { segments: [{ text: 'The toggle is in row seven.' }], anchor: { target: 'settings' } } },
  ];
}

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
      viewport: box(`${main} :is(.drawing-viewport, .table-viewport__scroll, .code-viewport__scroll, .document-viewport__body, .image-primitive__field, .progress-primitive__steps, .chart-primitive)`),
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
  { name: 'a long plan', scene: 'idle', actions: longPlan, sizes: [{ width: 390, height: 844 }, { width: 820, height: 1180 }] },
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
  await expect(page.locator('.content-rail .note-badge')).toHaveText('NOTE');
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
  // Set aside, not dropped: the metrics are in the page, out of view.
  await expect(page.locator('.content-rail [data-testid="metrics"]')).toBeHidden();
  await handle.click();
  await expect(page.locator('.content-rail--open')).toBeVisible();
  await expect(page.locator('.content-rail [data-testid="metrics"]')).toBeVisible();
  await page.waitForTimeout(500);
  const opened = await boxes(page);
  expect(Math.abs(opened.main.height - opened.stage.height * 0.59)).toBeLessThan(1.5);
  await expect(handle).toHaveText(/FOLD/);
  await handle.click();
  await expect(page.locator('.content-rail--folded')).toBeVisible();
  await expect(page.locator('.content-rail [data-testid="metrics"]')).toBeHidden();
});

test('a figure taller than its field takes the stage, drawn larger', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?scene=idle&chrome=0');
  await open(page, 'idle', await tallFigure(page));
  await expect(page.locator('.content-rail--folded')).toBeVisible();
  const laid = await boxes(page);
  expect(laid.main.height).toBeGreaterThan(laid.stage.height * 0.69);
  const picture = await page.locator('.image-primitive__img').boundingBox();
  // Held to its field's height, it is drawn taller than the shared column's field could hold.
  expect(picture!.height).toBeGreaterThan(laid.stage.height * 0.59 * 0.8);
});

test('a bar chart of forty-five categories takes the stage and gives each a labelled row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'idle', manyBars);
  await expect(page.locator('.content-rail--folded')).toBeVisible();
  // On its side, every category named.
  const labels = await page.locator('.chart-primitive svg text').allTextContents();
  for (const index of [0, 22, 44]) expect(labels).toContain(`service-${String(index).padStart(2, '0')}`);
});

for (const { name, scene, actions } of [
  { name: 'a stepped plan under a chart', scene: 'training', actions: chartOverPlan },
  { name: 'a long table beside a diagram that fits', scene: 'idle', actions: tableBeside },
]) {
  test(`${name} keeps the rail: only the primary asks for the stage`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, scene, actions);
    const laid = await boxes(page);
    expect(laid.foldable).toBe(false);
  });
}

test('a long live response on a folded strip is held to its newest lines, the strip no taller', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 7 });
  try {
    const { wsUrl } = await fixtureServer.start();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
    fixtureServer.broadcast({ type: 'display', action: longTable[1] });
    await expect(page.locator('.content-rail--folded')).toBeVisible();
    const before = await boxes(page);
    const speech = Array.from({ length: 12 }, (_, index) => `Sentence ${index} about which suite runs longest and why.`).join(' ');
    fixtureServer.broadcast({ type: 'spoken', entry: transcriptEntry({ role: 'agent', text: speech, id: 'reply-1' }) });
    await expect(page.locator('.content-rail .live-chat-card')).toBeVisible();
    await page.waitForTimeout(600);
    const after = await boxes(page);
    // Still folded, the strip no taller than three lines and its header make it.
    expect(after.folded).toBe(true);
    expect(after.rail.height).toBeLessThan(before.stage.height / 6);
    expect(after.main.height).toBeGreaterThan(before.main.height - 80);
    // The handle says the response goes on past the strip.
    await expect(page.locator('button.rail-handle')).toContainText('LIVE');
  } finally {
    await fixtureServer.stop();
  }
});

for (const scene of ['tasks', 'inbox']) {
  test(`a ${scene} list longer than its share takes the stage at 390x844`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, scene);
    await expect(page.locator('.content-rail--folded')).toBeVisible();
    const laid = await boxes(page);
    expect(laid.main.height).toBeGreaterThan(laid.stage.height * 0.69);
  });
}

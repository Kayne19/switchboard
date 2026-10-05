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

// Folded, a diagram's frame gave some 150px of the phone to what earns
// nothing while the primary has the stage: the subtitle's own line over
// the frame, and rail bands of a tenth of the slot each, above and below
// the drawing.
const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

test('folded, the frame\'s subtitle runs after its title and the primary starts a line higher', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'topology');
  await expect(page.locator('.content-rail--folded')).toBeVisible();
  const title = await box(page, '.scene-heading__title');
  const sub = await box(page, '.scene-heading__sub');
  // One line: the subtitle after the title, both inside the stage.
  expect(Math.abs(sub.y + sub.height - (title.y + title.height))).toBeLessThan(2);
  expect(sub.x).toBeGreaterThan(title.x + title.width);
  expect(sub.x + sub.width).toBeLessThanOrEqual(390);
  expect((await box(page, '.content-grid > .content-main')).y).toBeLessThan(title.y + title.height + 16);
  // Opened, the frame's words are as they were: the subtitle on its own line.
  await page.locator('button.rail-handle').click();
  await expect(page.locator('.content-rail--open')).toBeVisible();
  await page.waitForTimeout(500);
  const openTitle = await box(page, '.scene-heading__title');
  expect((await box(page, '.scene-heading__sub')).y).toBeGreaterThanOrEqual(openTitle.y + openTitle.height - 1);
});

test('folded, a diagram\'s rails keep the depth they have in a slot of some 400px, the drawing taking the rest', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'topology');
  await expect(page.locator('.content-rail--folded')).toBeVisible();
  const object = await box(page, '.content-grid > .content-main .diagram-object');
  const view = await box(page, '.content-grid > .content-main .drawing-viewport');
  expect(view.y - object.y).toBeLessThanOrEqual(51);
  expect(object.y + object.height - (view.y + view.height)).toBeLessThanOrEqual(51);
  // 458px of the 844 before; some 518 now.
  expect(view.height).toBeGreaterThan(844 * 0.6);
  // Opened, the bands are a tenth of the slot, as they were.
  await page.locator('button.rail-handle').click();
  await expect(page.locator('.content-rail--open')).toBeVisible();
  await page.waitForTimeout(500);
  const shared = await box(page, '.content-grid > .content-main .diagram-object');
  const sharedView = await box(page, '.content-grid > .content-main .drawing-viewport');
  expect(Math.abs(sharedView.y - shared.y - (shared.height * 0.1 + 10))).toBeLessThan(1.5);
});

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

// Past what even the stage holds a row each for, the bars stood upright
// again on a phone, a few of sixty names under bars a few pixels wide.
const sixtyBars = [
  { op: 'clear' },
  {
    op: 'show', id: 'minutes', type: 'chart', role: 'primary',
    data: { kind: 'bar', title: 'CI / 60 SERVICES', labels: Array.from({ length: 60 }, (_, index) => `service-${String(index).padStart(2, '0')}`), series: [{ name: 'THIS WEEK', values: Array.from({ length: 60 }, (_, index) => 10 + ((index * 37) % 80)) }] },
  },
];

test('a bar chart of sixty categories on a phone lies on its side and scrolls in its frame, every row named', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'idle', sixtyBars);
  const chart = page.locator('.chart-primitive');
  await expect(chart).toHaveAttribute('data-orientation', 'horizontal');
  await expect(chart).toHaveClass(/chart-primitive--scrolls/);
  // Every category has its row, its name at a readable size.
  const labels = chart.locator('.chart-grid__category');
  await expect(labels).toHaveCount(60);
  const sizes = await labels.evaluateAll((texts) => texts.map((text) => text.getBoundingClientRect().height));
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(8);
  // The rows past the foot are counted there, and a tap turns a page.
  const rim = chart.locator('.drawing-viewport__rim--bottom');
  await expect(rim).toHaveText(/\d+ BARS/);
  // The last row is reached inside the frame, the value axis still over it.
  await chart.locator('.list-viewport__scroll').evaluate((scroll) => scroll.scrollTo({ top: scroll.scrollHeight }));
  await page.waitForTimeout(300);
  const view = (await chart.locator('.list-viewport__port').boundingBox())!;
  const last = (await labels.last().boundingBox())!;
  expect(last.y).toBeGreaterThanOrEqual(view.y - 1);
  expect(last.y + last.height).toBeLessThanOrEqual(view.y + view.height + 1);
  await expect(chart.locator('.chart-primitive__axis text').first()).toBeVisible();
  await expect(chart.locator('.drawing-viewport__rim--top')).toHaveText(/\d+ BARS/);
});

// A note on a scrolled chart lies on its canvas, so its card and leader
// keep to the bar they name as the rows scroll.
const hundredShortBars = [
  { op: 'clear' },
  {
    op: 'show', id: 'minutes', type: 'chart', role: 'primary',
    data: { kind: 'bar', title: 'CI / 100 SERVICES', labels: Array.from({ length: 100 }, (_, index) => `service-${String(index).padStart(2, '0')}`), series: [{ name: 'THIS WEEK', values: Array.from({ length: 100 }, (_, index) => (index === 3 ? 100 : 5 + ((index * 7) % 20))) }] },
  },
  { op: 'show', id: 'slow-note', type: 'note', data: { tag: 'SLOWEST', segments: [{ text: 'service-71 doubled since last week.' }], anchor: { target: 'minutes', x: 71 } } },
];

test('a note on a scrolled bar chart opens on its bar and keeps to it as the rows scroll', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await open(page, 'idle', hundredShortBars);
  const chart = page.locator('.chart-primitive');
  await expect(chart).toHaveClass(/chart-primitive--scrolls/);
  const card = page.locator('.chart-primitive__canvas > .chart-notes .chart-note[data-note="slow-note"]');
  await expect(card).toBeVisible();
  const row = chart.locator('.chart-grid__category[data-item="71"]');
  const offset = async () => (await card.boundingBox())!.y - (await row.boundingBox())!.y;
  // It opened on the named bar, in view.
  const view = (await chart.locator('.list-viewport__port').boundingBox())!;
  const named = (await row.boundingBox())!;
  expect(named.y).toBeGreaterThanOrEqual(view.y);
  expect(named.y + named.height).toBeLessThanOrEqual(view.y + view.height);
  const before = await offset();
  await chart.locator('.list-viewport__scroll').evaluate((scroll) => scroll.scrollBy({ top: -240 }));
  await page.waitForTimeout(300);
  expect(Math.abs((await offset()) - before)).toBeLessThan(1);
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

// A calendar week on a phone outgrows its share and folds the rail; a
// small primary in its place gives the stage back. (The next test is the
// one that holds the grid's `least`: this one passes without it, since a
// new primary drops the week's reports.)
const smallMetric = [
  { op: 'show', id: 'week', type: 'metric', role: 'primary', data: { label: 'STEPS TODAY', value: '6,214' } },
];

test('a calendar week takes the stage at 390x844, and a small primary in its place gives it back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'calendar');
  await expect(page.locator('.content-rail--folded')).toBeVisible();
  const staged = await boxes(page);
  expect(staged.main.height).toBeGreaterThan(staged.stage.height * 0.69);
  expect(staged.rail.height).toBeLessThan(staged.stage.height / 6);
  await page.evaluate((list) => window.SwitchboardController!.run(list), smallMetric);
  await expect(page.locator('.content-rail--folded')).toHaveCount(0);
  await page.waitForTimeout(700);
  const shared = await boxes(page);
  expect(shared.foldable).toBe(false);
});

// The grid's `least` is what lets a calendar give the stage back. A long
// day is a time grid in its share too (it has room for eight hours there)
// and folds the rail. Sent again as one short appointment, the same grid on
// the stage stretched its hours to fill the stage, so asked by its scroll
// it read as needing all of it and kept the stage; asked by its least
// readable height it reads whole in its share.
const quietDay = [
  {
    op: 'show', id: 'week', type: 'calendar', role: 'primary', data: {
      view: 'day', start: '2026-10-07', today: '2026-10-07', now: '2026-10-07T09:40',
      events: [{ id: 'dentist', title: 'Dentist', start: '2026-10-07T10:30', end: '2026-10-07T11:30' }],
    },
  },
];

test('a long calendar day takes the stage at 390x844, and gives it back once the day is short', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'calendar-day');
  await expect(page.locator('.content-rail--folded')).toBeVisible();
  await expect(page.locator('[data-testid="calendar"]')).toHaveAttribute('data-layout', 'grid');
  await page.evaluate((list) => window.SwitchboardController!.run(list), quietDay);
  await expect(page.locator('.content-rail--folded')).toHaveCount(0);
  await page.waitForTimeout(700);
  const shared = await boxes(page);
  expect(shared.foldable).toBe(false);
  expect(Math.abs(shared.main.height - shared.stage.height * 0.59)).toBeLessThan(1.5);
});

// The same week sent again with one appointment in it is the same object:
// it gives the stage back once it reads whole in its share. Before, the
// week's first measure turned its grid to pages, and the hours viewport was
// mounted afresh on the stage, with no measure from the shared layout to be
// weighed against, so the week kept the stage until another primary came.
const quietWeek = [
  {
    op: 'show', id: 'week', type: 'calendar', role: 'primary', data: {
      view: 'week', start: '2026-10-05', today: '2026-10-07', now: '2026-10-07T09:40',
      events: [{ id: 'dentist', title: 'Dentist', start: '2026-10-07T10:30', end: '2026-10-07T11:30' }],
    },
  },
];

test('a calendar week that takes the stage at 390x844 gives it back once it quiets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'calendar');
  await expect(page.locator('.content-rail--folded')).toBeVisible();
  await expect(page.locator('[data-testid="calendar"]')).toHaveAttribute('data-layout', 'grid');
  await page.evaluate((list) => window.SwitchboardController!.run(list), quietWeek);
  await expect(page.locator('.content-rail--folded')).toHaveCount(0);
  await page.waitForTimeout(700);
  const shared = await boxes(page);
  expect(shared.foldable).toBe(false);
  expect(Math.abs(shared.main.height - shared.stage.height * 0.59)).toBeLessThan(1.5);
});

// A week whose busy Monday lies before the days a phone shows (it opens on
// today, Wednesday, three days a page). Before its body is measured the
// calendar draws all seven days as a stand-in, and the stand-in's hours,
// Monday's among them, would not fit its share; the three days drawn do.
const busyMonday = [
  { op: 'clear' },
  {
    op: 'show', id: 'week', type: 'calendar', role: 'primary', data: {
      view: 'week', start: '2026-10-05', today: '2026-10-07', now: '2026-10-07T09:40',
      events: [
        ...Array.from({ length: 19 }, (_, index) => ({ id: `mon-${index}`, title: `Call ${index}`, start: `2026-10-05T${String(4 + index).padStart(2, '0')}:00`, end: `2026-10-05T${String(4 + index).padStart(2, '0')}:50` })),
        { id: 'dentist', title: 'Dentist', start: '2026-10-07T10:30', end: '2026-10-07T11:30' },
        { id: 'review', title: 'Review', start: '2026-10-08T10:00', end: '2026-10-08T11:00' },
      ],
    },
  },
];

test('a week whose drawn days fit its share at 390x844 never takes the stage, not even for a frame', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { stageSeen: string[] }).stageSeen = seen;
    // Each change's value before it: a stage taken and given back within
    // one task is gone from the page by the time the records are read.
    new MutationObserver((records) => {
      for (const record of records) seen.push(String(record.oldValue), String((record.target as Element).getAttribute('data-stage')));
    }).observe(document, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-stage'] });
  });
  await open(page, 'idle', busyMonday);
  await expect(page.locator('[data-testid="calendar"]')).toHaveAttribute('data-columns', '3');
  const laid = await boxes(page);
  expect(laid.foldable).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { stageSeen: string[] }).stageSeen)).not.toContain('primary');
});

// A forecast laid down the box fills its view, so its scroll content
// always measured the view: on the stage it read as needing all of it, and
// a forecast sent again with only the next three days kept the stage. It
// asks by the height its parts read whole in.
const quietForecast = [
  {
    op: 'show', id: 'weather', type: 'weather', role: 'primary', data: {
      location: 'San Francisco, CA', units: 'F', current: { temp: 61, condition: 'fog', high: 68, low: 54 },
      daily: [
        { date: '2026-10-07', high: 68, low: 54, condition: 'partly-cloudy', precip: 20 },
        { date: '2026-10-08', high: 61, low: 55, condition: 'rain', precip: 80 },
        { date: '2026-10-09', high: 63, low: 53, condition: 'cloudy', precip: 30 },
      ],
    },
  },
];

test('a forecast that takes the stage at 390x844 gives it back once it is short', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'weather');
  await expect(page.locator('.content-rail--folded')).toBeVisible();
  await page.evaluate((list) => window.SwitchboardController!.run(list), quietForecast);
  await expect(page.locator('.content-rail--folded')).toHaveCount(0);
  await page.waitForTimeout(700);
  const shared = await boxes(page);
  expect(shared.foldable).toBe(false);
  expect(Math.abs(shared.main.height - shared.stage.height * 0.59)).toBeLessThan(1.5);
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

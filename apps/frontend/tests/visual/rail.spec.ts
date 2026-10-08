import { expect, test, type Page } from '@playwright/test';
import { DisplayFixtureServer } from '../integration/display-fixture-server.mjs';
import { openScene, runActions } from './helpers';

// On a portrait stage the rail stands under the main column: Damocles at
// the size it has in every scene, beside the note read whole. Kayne
// approved the portrait-phone architecture golden so, and rejected a stage
// fold that gave a large primary the stage's height by folding the rail to
// a strip with Damocles at a third of its size and the note cut to three
// lines. A primary that outgrows its share scrolls in it (a drawing, a
// table, a list) or is drawn smaller (a figure); it never takes the rail's
// room. The rail takes what its note needs, the main column keeping the
// larger share. tests/unit/railFit.test.tsx pins the rule; these pin the
// boxes, which jsdom does not draw.

const PORTRAIT = [
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
] as const;

// Every fixture whose primary outgrew its share at one of these sizes
// before, and one whose primary always fit (code), which sets the size.
const LARGE = ['architecture', 'topology', 'pipeline', 'trace', 'handoff', 'plan', 'calendar', 'calendar-day', 'tasks', 'inbox', 'weather', 'today'];

async function rail(page: Page) {
  await expect(page.locator('.content-rail')).toBeVisible();
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const { top, bottom, width, height } = element.getBoundingClientRect();
      return { top, bottom, width, height };
    };
    return {
      presence: box('.content-rail [data-testid="damocles-presence"]')!,
      glyph: box('.content-rail [data-testid="damocles-presence"] svg')!,
      main: box('.content-grid > .content-main')!,
      rail: box('.content-rail')!,
    };
  });
}

for (const size of PORTRAIT) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    for (const scene of LARGE) {
      test(`${scene}: Damocles keeps its size under the primary, and the rail its place`, async ({ page }) => {
        await openScene(page, 'code');
        const shared = await rail(page);
        await openScene(page, scene);
        const now = await rail(page);
        expect(now.glyph.width).toBeCloseTo(shared.glyph.width, 0);
        expect(now.glyph.height).toBeCloseTo(shared.glyph.height, 0);
        expect(now.presence.height).toBeCloseTo(shared.presence.height, 0);
        // The rail stands under the column, down to the footer's band, as it does under code.
        expect(now.rail.top).toBeGreaterThanOrEqual(now.main.bottom);
        expect(now.rail.bottom).toBeCloseTo(shared.rail.bottom, 0);
      });
    }
  });
}

// How the rail's note stands: its text whole (nothing past its box), the
// card inside the rail and in view in the column.
async function note(page: Page) {
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const box = (element: Element) => {
      const { top, bottom } = element.getBoundingClientRect();
      return { top, bottom };
    };
    const column = document.querySelector('.content-rail__details')!;
    const card = document.querySelector('.content-rail .rail-note')!;
    const text = document.querySelector<HTMLElement>('.content-rail .annotation-card__text')!;
    return {
      textWhole: text.scrollHeight <= text.clientHeight + 1,
      card: box(card),
      column: box(column),
      rail: box(document.querySelector('.content-rail')!),
      main: box(document.querySelector('.content-grid > .content-main')!),
      grid: box(document.querySelector('.content-grid')!),
      leads: card.classList.contains('rail-note--leads'),
      // Nothing is drawn over an edge the column continues past (#177).
      rims: document.querySelectorAll('.content-rail [class*="scroll-rim"]').length,
      // The activity panel's slot where it stands in the column's flow (not set aside).
      slot: (() => {
        const slot = document.querySelector('.content-rail__details > .tool-activity-slot:not(.tool-activity-slot--away)');
        return slot && slot.getBoundingClientRect().height > 0 ? box(slot) : null;
      })(),
    };
  });
}

// Fixtures whose rail carries a note, each of a few lines, some with
// metrics over it (composed).
const NOTED = ['architecture', 'topology', 'trace', 'handoff', 'pipeline', 'email', 'results', 'figure', 'code', 'composed', 'calendar', 'weather', 'today'];

// The golden portrait sizes, and a smaller phone, where a rail with a
// metric over its note is shortest.
for (const size of [...PORTRAIT, { width: 360, height: 780 }]) {
  test.describe(`${size.width}x${size.height} note`, () => {
    test.use({ viewport: size });

    for (const scene of NOTED) {
      test(`${scene}: the rail's note reads whole`, async ({ page }) => {
        await openScene(page, scene);
        const now = await note(page);
        expect(now.textWhole, 'the note\'s text is whole').toBe(true);
        expect(now.card.top).toBeGreaterThanOrEqual(now.column.top - 1);
        expect(now.card.bottom).toBeLessThanOrEqual(now.column.bottom + 1);
        expect(now.rims).toBe(0);
        // The activity panel's slot, where it stands in the column, ends inside it.
        if (now.slot) expect(now.slot.bottom).toBeLessThanOrEqual(now.column.bottom + 1);
      });
    }
  });
}

// The composed golden's scene: a metric over a one-line note. Its rail
// holds all it carries, so nothing leads, and the activity
// panel's slot stands inside the column or is set aside -- never cut at
// its foot (the parts' margins count).
const goldenComposed = [
  { op: 'clear' },
  { op: 'show', id: 'composed-diagram', type: 'diagram', role: 'primary', data: { mode: 'graph', title: 'COMPOSED / SYSTEM FLOW', nodes: [{ id: 'input', label: 'INPUT' }, { id: 'active', label: 'ACTIVE', state: 'active' }, { id: 'output', label: 'OUTPUT' }], edges: [{ from: 'input', to: 'active', label: 'route' }, { from: 'active', to: 'output', label: 'emit' }] } },
  { op: 'show', id: 'composed-note', type: 'note', role: 'secondary', data: { tag: 'COMPOSED', segments: [{ text: 'Active path highlighted.' }] } },
  { op: 'show', id: 'composed-metric', type: 'metric', role: 'secondary', data: { label: 'THROUGHPUT', value: '98.4%' } },
];
for (const size of [{ width: 390, height: 844 }, { width: 360, height: 780 }]) {
  test(`a metric over a short note holds whole at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await openScene(page, 'architecture');
    await runActions(page, goldenComposed);
    const rail = await note(page);
    expect(rail.leads).toBe(false);
    expect(rail.rims).toBe(0);
    expect(rail.textWhole).toBe(true);
    if (rail.slot) expect(rail.slot.bottom).toBeLessThanOrEqual(rail.column.bottom + 1);
  });
}

test.describe('390x844 rail', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a note too long for the rail\'s share grows it, and the main column keeps the larger share', async ({ page }) => {
    await openScene(page, 'architecture');
    const words = 'The operator hands the caller to the project agent once the session is up, and the voice stays the same.';
    await runActions(page, [{ op: 'show', id: 'architecture-note', type: 'note', data: { tag: 'NOTE', anchor: { target: 'system-map', node: 'session' }, segments: [{ text: `${words} ${words} ${words}` }] } }]);
    const grown = await note(page);
    expect(grown.textWhole).toBe(true);
    expect(grown.rail.bottom - grown.rail.top).toBeGreaterThan(172 + 20);
    expect(grown.card.bottom).toBeLessThanOrEqual(grown.column.bottom + 1);
    // Far too long: the rail stops at half the grid and the note scrolls in it.
    await runActions(page, [{ op: 'show', id: 'architecture-note', type: 'note', data: { tag: 'NOTE', segments: [{ text: Array(6).fill(words).join(' ') }] } }]);
    const capped = await note(page);
    expect(capped.main.bottom - capped.main.top).toBeGreaterThanOrEqual(capped.rail.bottom - capped.rail.top - 1);
    expect(capped.rims).toBe(0);
  });

  test('a rail too short for all it carries leads with its note, whole', async ({ page }) => {
    await openScene(page, 'plan');
    const plan = await note(page);
    expect(plan.leads).toBe(true);
    expect(plan.textWhole).toBe(true);
    expect(plan.card.top).toBeCloseTo(plan.column.top, 0);
    expect(plan.rims).toBe(0);
  });

  test('the activity panel stands aside where the rail has no room for it whole, and Damocles names the tool', async ({ page }) => {
    const server = new DisplayFixtureServer({ initialGeneration: 91 });
    const { wsUrl } = await server.start();
    try {
      await page.goto(`/?ws=${encodeURIComponent(wsUrl)}&chrome=0`);
      await expect.poll(() => server.frames.some((frame) => frame.type === 'hello')).toBe(true);
      await page.evaluate(() => window.SwitchboardController?.load('architecture'));
      await expect(page.locator('.content-rail .rail-note')).toBeVisible();
      const before = await note(page);
      server.broadcast({ type: 'activity', state: 'start', tool: 'shell', label: 'Working', detail: 'npm test' });
      await expect(page.locator('.content-rail [data-testid="damocles-presence"]')).toContainText(/WORKING \/ shell/i);
      await expect(page.locator('.content-rail__details .tool-activity-slot--away')).toHaveCount(1);
      // Unseen, and left to assistive technology.
      expect(await page.locator('.content-rail__details .tool-activity-slot').evaluate((slot) => getComputedStyle(slot).opacity)).toBe('0');
      await expect(page.locator('.content-rail__details .tool-activity')).toBeAttached();
      const during = await note(page);
      expect(during.textWhole).toBe(true);
      expect(during.card).toEqual(before.card);
    } finally {
      await server.stop();
    }
  });
});

// Damocles stands in the rail, never past it: at 820x1180 he was about
// 266 px tall in a 241 px rail and overflowed each edge by 13 px, at
// 768x1024 by 28 px. The rail is at least as tall as he is.
for (const viewport of [{ width: 390, height: 844 }, { width: 600, height: 960 }, { width: 768, height: 1024 }, { width: 820, height: 1180 }]) {
  test(`Damocles stands inside the rail at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const scene of ['architecture', 'code', 'tasks']) {
      await openScene(page, scene);
      await expect(page.locator('.content-rail [data-testid="damocles-presence"]')).toBeVisible();
      await page.waitForTimeout(500);
      const [rail, presence] = await Promise.all([page.locator('.content-rail').boundingBox(), page.locator('.content-rail [data-testid="damocles-presence"]').boundingBox()]);
      expect(presence!.y, scene).toBeGreaterThanOrEqual(rail!.y - 1);
      expect(presence!.y + presence!.height, scene).toBeLessThanOrEqual(rail!.y + rail!.height + 1);
    }
  });
}

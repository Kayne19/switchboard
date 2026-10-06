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
      handles: document.querySelectorAll('.rail-handle').length,
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
        expect(now.handles, 'no handle folds the rail').toBe(0);
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
      fades: column.classList.contains('content-rail__details--more'),
    };
  });
}

// Fixtures whose rail carries a note, each of a few lines.
const NOTED = ['architecture', 'topology', 'trace', 'handoff', 'pipeline', 'email', 'results', 'figure', 'code', 'calendar', 'weather', 'today'];

for (const size of PORTRAIT) {
  test.describe(`${size.width}x${size.height} note`, () => {
    test.use({ viewport: size });

    for (const scene of NOTED) {
      test(`${scene}: the rail's note reads whole`, async ({ page }) => {
        await openScene(page, scene);
        const now = await note(page);
        expect(now.textWhole, 'the note\'s text is whole').toBe(true);
        expect(now.card.top).toBeGreaterThanOrEqual(now.column.top - 1);
        expect(now.card.bottom).toBeLessThanOrEqual(now.column.bottom + 1);
        expect(now.fades).toBe(false);
      });
    }
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
    // Far too long: the rail stops at half the grid, the note scrolls in it and its foot fades.
    await runActions(page, [{ op: 'show', id: 'architecture-note', type: 'note', data: { tag: 'NOTE', segments: [{ text: Array(6).fill(words).join(' ') }] } }]);
    const capped = await note(page);
    expect(capped.main.bottom - capped.main.top).toBeGreaterThanOrEqual(capped.rail.bottom - capped.rail.top - 1);
    expect(capped.fades).toBe(true);
  });

  test('a rail too short for all it carries leads with its note, whole', async ({ page }) => {
    await openScene(page, 'plan');
    const plan = await note(page);
    expect(plan.leads).toBe(true);
    expect(plan.textWhole).toBe(true);
    expect(plan.card.top).toBeCloseTo(plan.column.top, 0);
    expect(plan.fades).toBe(true);
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
      await expect(page.locator('.content-rail__details .tool-activity')).toBeHidden();
      const during = await note(page);
      expect(during.textWhole).toBe(true);
      expect(during.card).toEqual(before.card);
    } finally {
      await server.stop();
    }
  });
});

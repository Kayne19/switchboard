import { expect, test, type Page } from '@playwright/test';
import { openScene } from './helpers';

// On a portrait stage the rail stands under the main column: Damocles at
// the size it has in every scene, beside the note. Kayne approved the
// portrait-phone architecture golden so, and rejected a stage fold that
// gave a large primary the stage's height by folding the rail to a strip
// with Damocles at a third of its size. A primary that outgrows its share
// scrolls in it (a drawing, a table, a list) or is drawn smaller (a
// figure); it never takes the rail's room.

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

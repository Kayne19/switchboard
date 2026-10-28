import { expect, test } from '@playwright/test';
import { DisplayFixtureServer } from '../integration/display-fixture-server.mjs';
import { FRAME_GEOMETRIES, openTheater } from './helpers';

// The theater view (#277), where jsdom cannot see it
// (tests/unit/theaterView.test.tsx covers what it draws and its EXIT): an
// agent's view("theater") over the page's own socket gives the primary the
// stage, in the focus box, clear of the corner stack and of Damocles, with
// EXIT reachable; Esc and EXIT leave it, and the page's report follows.
// Its goldens are in visual.spec.ts, with every other golden.

const reportedView = (server: DisplayFixtureServer) => server.reports.at(-1)?.view;

/** The boxes that must not meet, as the page draws them. */
function boxes() {
  const box = (selector: string) => {
    const rect = document.querySelector(selector)!.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  };
  const exit = document.querySelector<HTMLElement>('.theater__header .return-control')!.getBoundingClientRect();
  const hit = document.elementFromPoint(exit.left + exit.width / 2, exit.top + exit.height / 2);
  // What the box draws, overflow and all: every part in it with a size,
  // each cut to the boxes that clip it on the way up (a scroller's hidden
  // rows are not drawn).
  const drawn = (selector: string) => {
    const root = document.querySelector(selector)!;
    const shown = (part: Element) => {
      const rect = part.getBoundingClientRect();
      let [left, top, right, bottom] = [rect.left, rect.top, rect.right, rect.bottom];
      for (let up = part.parentElement; up && up !== root.parentElement; up = up.parentElement) {
        const style = getComputedStyle(up);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const clip = up.getBoundingClientRect();
        [left, top, right, bottom] = [Math.max(left, clip.left), Math.max(top, clip.top), Math.min(right, clip.right), Math.min(bottom, clip.bottom)];
      }
      return { left, top, right, bottom };
    };
    const parts = [root, ...root.querySelectorAll('*')]
      .map(shown)
      .filter((rect) => rect.right - rect.left > 0 && rect.bottom - rect.top > 0);
    return {
      left: Math.min(...parts.map((rect) => rect.left)),
      top: Math.min(...parts.map((rect) => rect.top)),
      right: Math.max(...parts.map((rect) => rect.right)),
      bottom: Math.max(...parts.map((rect) => rect.bottom)),
    };
  };
  return {
    stage: box('.stage'),
    staged: drawn('.theater__box'),
    header: box('.theater__header'),
    stack: box('.channel-stack'),
    presence: box('.theater__presence [data-testid="damocles-presence"]'),
    exitHit: Boolean(hit?.closest('.theater__header .return-control')),
  };
}

type Box = { left: number; top: number; right: number; bottom: number };
const meets = (a: Box, b: Box) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const inside = (a: Box, b: Box) => a.left >= b.left - 0.5 && a.top >= b.top - 0.5 && a.right <= b.right + 0.5 && a.bottom <= b.bottom + 0.5;

for (const geometry of FRAME_GEOMETRIES) {
  test(`theater gives the primary the stage, clear of the corner stack and Damocles / ${geometry.name}`, async ({ page }) => {
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    const server = new DisplayFixtureServer({ initialGeneration: 3 });
    try {
      await openTheater(page, server);
      await page.waitForTimeout(500);
      // Nothing else on stage is drawn.
      await expect(page.locator('.content-rail')).toHaveCount(0);
      await expect(page.locator('.scene-heading')).toHaveCount(0);
      await expect(page.locator('.theater__box .chart-primitive')).toBeVisible();
      const seen = await page.evaluate(boxes);
      expect(inside(seen.staged, seen.stage), 'the box on the stage').toBe(true);
      expect(inside(seen.header, seen.stage), 'its header on the stage').toBe(true);
      expect(inside(seen.presence, seen.stage), 'Damocles on the stage').toBe(true);
      expect(meets(seen.staged, seen.stack), 'the box and the corner stack').toBe(false);
      expect(meets(seen.staged, seen.presence), 'the box and Damocles').toBe(false);
      expect(meets(seen.header, seen.presence), 'the header and Damocles').toBe(false);
      expect(seen.exitHit, 'EXIT takes its tap').toBe(true);
      // Damocles still takes a turn's tap.
      await expect(page.locator('.theater__presence .damocles-presence__button')).toBeEnabled();
      await expect.poll(() => reportedView(server)).toBe('theater');
    } finally {
      await server.stop();
    }
  });
}

// Each kind of primary keeps clear of the corner stack and Damocles where
// the room is least: a phone upright and a phone on its side.
for (const scene of ['code', 'results', 'architecture', 'email', 'today', 'composed'] as const) {
  for (const geometry of FRAME_GEOMETRIES.filter((each) => each.name === 'portrait-phone' || each.name === 'landscape-short')) {
    test(`theater draws the ${scene} primary clear of the corner stack and Damocles / ${geometry.name}`, async ({ page }) => {
      await page.setViewportSize({ width: geometry.width, height: geometry.height });
      const server = new DisplayFixtureServer({ initialGeneration: 3 });
      try {
        await openTheater(page, server, scene);
        await page.waitForTimeout(500);
        const seen = await page.evaluate(boxes);
        expect(inside(seen.staged, seen.stage), 'the box on the stage').toBe(true);
        expect(meets(seen.staged, seen.stack), 'the box and the corner stack').toBe(false);
        expect(meets(seen.staged, seen.presence), 'the box and Damocles').toBe(false);
        expect(seen.exitHit, 'EXIT takes its tap').toBe(true);
      } finally {
        await server.stop();
      }
    });
  }
}

test('Esc and EXIT leave the theater for auto, and the report says so', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = new DisplayFixtureServer({ initialGeneration: 3 });
  try {
    await openTheater(page, server);
    await expect.poll(() => reportedView(server)).toBe('theater');
    await page.keyboard.press('Escape');
    await expect(page.locator('.stage')).toHaveAttribute('data-view', 'auto');
    await expect(page.locator('.stage')).toHaveAttribute('data-scene-kind', 'training');
    await expect.poll(() => reportedView(server)).toBe('auto');

    server.broadcast({ type: 'view', target: 'theater', reason: '' });
    await expect(page.locator('.stage')).toHaveAttribute('data-view', 'theater');
    await page.locator('.theater__header .return-control').click();
    await expect(page.locator('.stage')).toHaveAttribute('data-view', 'auto');
    await expect.poll(() => reportedView(server)).toBe('auto');
  } finally {
    await server.stop();
  }
});

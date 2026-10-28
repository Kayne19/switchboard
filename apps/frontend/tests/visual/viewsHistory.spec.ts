import { expect, test, type Page } from '@playwright/test';
import { DisplayFixtureServer } from '../integration/display-fixture-server.mjs';
import { FRAME_GEOMETRIES, openSystem, openTheater } from './helpers';

const VIEWS = {
  theater: { open: openTheater, box: '.theater__box' },
  system: { open: openSystem, box: '.system' },
} as const;
type View = keyof typeof VIEWS;

const toggleIn = (view: View) => `[data-scene="${view}"] .transcript-reveal .transcript-toggle`;

function seen({ view, boxSelector }: { view: View; boxSelector: string }) {
  const scene = document.querySelector(`[data-scene="${view}"]`)!;
  const rect = (element: Element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  };
  const band = scene.querySelector('.transcript-reveal');
  const toggle = band?.querySelector('.transcript-toggle');
  if (!band || !toggle) return null;
  const middle = toggle.getBoundingClientRect();
  const hit = document.elementFromPoint(middle.left + middle.width / 2, middle.top + middle.height / 2);
  const box = scene.querySelector(boxSelector)!;
  const pointsTheBandTakes = (element: Element) => {
    // A short stage scrolls the system panel: read each control where it is scrolled to.
    element.scrollIntoView({ block: 'nearest' });
    const { left, top, width, height } = element.getBoundingClientRect();
    const taken: string[] = [];
    for (let column = 0; column < 7; column += 1) {
      for (let row = 0; row < 7; row += 1) {
        const x = left + ((column + 0.5) / 7) * width;
        const y = top + ((row + 0.5) / 7) * height;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
        if (document.elementFromPoint(x, y)?.closest('.transcript-reveal')) taken.push(`${element.className || element.tagName} at ${Math.round(x)},${Math.round(y)}`);
      }
    }
    return taken;
  };
  const others = [box, ...scene.querySelectorAll('button, select, [tabindex]')].filter((element) => !band.contains(element));
  return {
    band: rect(band),
    box: rect(box),
    presence: rect(scene.querySelector('[data-testid="damocles-presence"]')!),
    toggleHit: hit?.closest('.transcript-toggle') === toggle,
    taken: others.flatMap(pointsTheBandTakes),
  };
}

async function expectToggleClearOfTheView(page: Page, view: View) {
  const found = await page.evaluate(seen, { view, boxSelector: VIEWS[view].box });
  expect(found, 'a toggle into the history, in its band').not.toBeNull();
  expect(found!.band.top, 'the band stands under the box').toBeGreaterThanOrEqual(found!.box.bottom - 0.5);
  expect(found!.band.top, 'the band stands under Damocles').toBeGreaterThanOrEqual(found!.presence.bottom - 0.5);
  expect(found!.taken, 'points of another control the band takes').toEqual([]);
  expect(found!.toggleHit, 'the toggle takes its own tap').toBe(true);
  return found!;
}

async function expectHistoryOpensOverTheView(page: Page, view: View) {
  const history = page.getByRole('dialog', { name: 'Conversation history' });
  await expect(history).toBeVisible();
  await expect(page.locator('.stage'), 'the view stands under the history').toHaveAttribute('data-view', view);
  return history;
}

for (const view of Object.keys(VIEWS) as View[]) {
  for (const geometry of FRAME_GEOMETRIES) {
    test(`the ${view} view keeps the history in reach, clear of every other control / ${geometry.name}`, async ({ page }) => {
      await page.setViewportSize({ width: geometry.width, height: geometry.height });
      const server = new DisplayFixtureServer({ initialGeneration: 3 });
      try {
        await VIEWS[view].open(page, server);
        await page.waitForTimeout(400);
        const { band } = await expectToggleClearOfTheView(page, view);

        const toggle = page.locator(toggleIn(view));
        await expect(toggle, 'hidden at rest where a pointer can hover').toHaveCSS('opacity', '0');
        // Three quarters across, clear of the toggle: the band shows it, not a hover on the toggle itself.
        const inBand = { x: band.left + (band.right - band.left) * 0.75, y: (band.top + band.bottom) / 2 };
        await page.mouse.move(inBand.x, inBand.y);
        await expect(toggle, 'shown with the pointer in the band').toHaveCSS('opacity', '1');
        await page.mouse.move(inBand.x, band.top - 40);
        await expect(toggle, 'hidden again with the pointer out of the band').toHaveCSS('opacity', '0');

        await toggle.click();
        await expectHistoryOpensOverTheView(page, view);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog', { name: 'Conversation history' })).toHaveCount(0);
        await expect(page.locator('.stage'), 'Esc closes the history, not the view').toHaveAttribute('data-view', view);
      } finally {
        await server.stop();
      }
    });
  }
}

test.describe('where nothing can hover', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const view of Object.keys(VIEWS) as View[]) {
    for (const geometry of FRAME_GEOMETRIES.filter((each) => each.name === 'portrait-phone' || each.name === 'portrait-tablet')) {
      test(`the ${view} view's toggle rests in view and a tap opens the history / ${geometry.name}`, async ({ page }) => {
        await page.setViewportSize({ width: geometry.width, height: geometry.height });
        const server = new DisplayFixtureServer({ initialGeneration: 3 });
        try {
          await VIEWS[view].open(page, server);
          expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
          await page.waitForTimeout(400);
          await expectToggleClearOfTheView(page, view);

          const toggle = page.locator(toggleIn(view));
          await expect(toggle).toHaveCSS('opacity', '1');
          await toggle.tap();
          const history = await expectHistoryOpensOverTheView(page, view);
          await history.getByRole('button', { name: 'RETURN / ESC' }).tap();
          await expect(history).toHaveCount(0);
          await expect(page.locator('.stage'), 'RETURN closes the history, not the view').toHaveAttribute('data-view', view);
        } finally {
          await server.stop();
        }
      });
    }
  }
});

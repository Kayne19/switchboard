import { expect, test } from '@playwright/test';
import { openScene } from './helpers';

// An object's surface opens it in focus, and what it holds may scroll: a
// list, a document, a table, a scrolled drawing, a calendar's paged days.
// The surface was a role="button" wrapped round those scrolls, and ARIA
// makes a button's children presentational: VoiceOver could read a whole
// table as one button named "Expand table", and the scroll inside it was a
// region of a button (axe's nested-interactive). The surface is now a plain
// box with a real button of its own, beside what it holds (#269), and every
// tab stop has a name.

const fixtures = ['email', 'code', 'tasks', 'composed', 'results', 'architecture', 'calendar', 'inbox', 'topology'];

const faults = () =>
  [...document.querySelectorAll('[role="button"]')].flatMap((button) =>
    [...button.querySelectorAll('[tabindex], [role="region"], button, a[href], input, select, textarea')].map(
      (inner) => `${button.className} holds ${inner.tagName.toLowerCase()}.${inner.className}`,
    ),
  );

const unnamed = () =>
  [...document.querySelectorAll<HTMLElement>('.stage [tabindex="0"], .stage button')].flatMap((stop) => {
    if (stop.closest('[inert]')) return [];
    const name = stop.getAttribute('aria-label') ?? (stop.tagName === 'BUTTON' ? stop.textContent : '');
    return name?.trim() ? [] : [`${stop.tagName.toLowerCase()}.${stop.className}`];
  });

// The button stands over its whole surface, so focus brings all of it into
// view; a rule that places what a surface holds in a row of its grid
// (`> *`) placed the button in that row too, and cut it to the row.
const uncovered = () =>
  [...document.querySelectorAll('.focusable-content__expand')].flatMap((button) => {
    const own = button.getBoundingClientRect();
    const surface = button.parentElement!.getBoundingClientRect();
    const off = Math.max(...(['top', 'right', 'bottom', 'left'] as const).map((side) => Math.abs(own[side] - surface[side])));
    return off < 1 ? [] : [`${button.getAttribute('aria-label')} is ${Math.round(own.height)}px of a ${Math.round(surface.height)}px surface`];
  });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`no surface is a button round a scroll, every tab stop is named, and a surface's button covers it / ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const scene of fixtures) {
      await openScene(page, scene);
      await page.waitForTimeout(400);
      expect(await page.evaluate(faults), scene).toEqual([]);
      expect(await page.evaluate(unnamed), scene).toEqual([]);
      expect(await page.evaluate(uncovered), scene).toEqual([]);
    }
  });
}

test('the surface opens its object in focus from its own button, by key and by a tap on what it holds', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openScene(page, 'results');
  const expand = page.getByRole('button', { name: 'Expand table' }).first();
  await expand.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.focus-layer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.focus-layer')).toHaveCount(0);
  await expect(expand).toBeFocused();
  await page.keyboard.press(' ');
  await expect(page.locator('.focus-layer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.focus-layer')).toHaveCount(0);
  await page.locator('.content-main .focusable-content').first().click({ position: { x: 40, y: 40 } });
  await expect(page.locator('.focus-layer')).toBeVisible();
});

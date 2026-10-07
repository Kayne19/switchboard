import { expect, test, type Page } from '@playwright/test';
import { FRAME_GEOMETRIES, openScene, runActions } from './helpers';

// The focus layer is a modal dialog (FocusLayer: role="dialog",
// aria-modal="true"), and acts as one: focus moves into it, Tab stays in
// it, and closing it gives focus back to what opened it. Under reduced
// motion (this suite's setting) the focused object's slot copy is hidden
// under it, as motion hides it where the two share one identity.

/** Where the page's focus is: in the focus layer, elsewhere on the page (named by class), or nowhere. */
const where = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return 'nowhere';
    if (active.closest('.focus-layer')) return 'layer';
    return `outside: ${active.className || active.tagName}`;
  });

const visibility = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('[data-focus-copy]')].map((element) => getComputedStyle(element).visibility));

for (const geometry of FRAME_GEOMETRIES) {
  test.describe(geometry.name, () => {
    test.use({ viewport: { width: geometry.width, height: geometry.height } });

    test('the focused object\'s slot copy is hidden under the focus, and back when it closes', async ({ page }) => {
      await openScene(page, 'results');
      await runActions(page, [{ op: 'focus', id: 'test-matrix' }]);
      await expect(page.locator('.focus-layer')).toBeVisible();
      expect(await visibility(page)).toEqual(['hidden']);
      await page.keyboard.press('Escape');
      await expect(page.locator('.focus-layer')).toHaveCount(0);
      expect(await visibility(page)).toEqual([]);
    });

    test('focus moves into the layer, Tab stays in it, and closing gives focus back to the surface that opened it', async ({ page }) => {
      await openScene(page, 'results');
      const surface = page.locator('.content-main .focusable-content[role="button"]').first();
      await surface.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.focus-layer')).toBeVisible();
      await expect(page.locator('.focus-layer__return')).toBeFocused();
      // Opened from the keyboard, RETURN draws the page's ring.
      expect(await page.locator('.focus-layer__return').evaluate((element) => element.matches(':focus-visible'))).toBe(true);
      // Two walks round the layer's controls: Tab never reaches behind it
      // (past its last control focus leaves for the browser, as a native
      // modal dialog's does, and comes back into the layer).
      const seen = new Set<string>();
      for (let step = 0; step < 24; step += 1) {
        await page.keyboard.press('Tab');
        seen.add(await where(page));
      }
      for (let step = 0; step < 6; step += 1) {
        await page.keyboard.press('Shift+Tab');
        seen.add(await where(page));
      }
      expect([...seen].filter((place) => place.startsWith('outside')), 'Tab reaches nothing behind the layer').toEqual([]);
      expect(seen.has('layer')).toBe(true);
      await page.keyboard.press('Escape');
      await expect(page.locator('.focus-layer')).toHaveCount(0);
      await expect(surface).toBeFocused();
    });

    test('focus the agent opens takes focus in, and gives it back to nothing', async ({ page }) => {
      await openScene(page, 'results');
      await runActions(page, [{ op: 'focus', id: 'test-matrix' }]);
      await expect(page.locator('.focus-layer__return')).toBeFocused();
      // No key was pressed: no ring on RETURN until one is.
      expect(await page.locator('.focus-layer__return').evaluate((element) => element.matches(':focus-visible'))).toBe(false);
      await page.locator('.focus-layer__return').click();
      await expect(page.locator('.focus-layer')).toHaveCount(0);
      expect(await where(page)).toBe('nowhere');
    });
  });
}

test.describe('normal motion', () => {
  // The slot copy is hidden by motion's shared identity, and shown again in
  // motion's frame after the layer closes, not in its commit.
  test.use({ contextOptions: { reducedMotion: 'no-preference' }, viewport: { width: 390, height: 844 } });
  test('closing gives focus back to the surface that opened it', async ({ page }) => {
    await openScene(page, 'results');
    await page.waitForTimeout(600);
    const surface = page.locator('.content-main .focusable-content[role="button"]').first();
    await surface.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.focus-layer__return')).toBeFocused();
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    await expect(page.locator('.focus-layer')).toHaveCount(0);
    await expect(surface).toBeFocused();
  });
});

test('a closed demo panel keeps its controls out of the tab order', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?scene=results');
  await expect(page.locator('.stage')).toBeVisible();
  const reached = new Set<string>();
  for (let step = 0; step < 60; step += 1) {
    await page.keyboard.press('Tab');
    reached.add(await page.evaluate(() => (document.activeElement?.closest('.controller-panel, .ir-drawer') ? 'panel' : 'page')));
  }
  expect(reached.has('panel'), 'no control of a closed panel takes focus').toBe(false);
  // Open, the panel's controls are reached.
  await page.keyboard.press('c');
  await expect(page.locator('.controller-panel--open')).toBeVisible();
  await page.locator('.controller-panel button').first().focus();
  await expect(page.locator('.controller-panel button').first()).toBeFocused();
});

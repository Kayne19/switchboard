import { expect, test, type Page } from '@playwright/test';
import { FRAME_GEOMETRIES, openScene, runActions } from './helpers';

// The focus layer is a modal dialog (FocusLayer: role="dialog",
// aria-modal="true"), and acts as one: focus moves into it, Tab stays in
// it, and closing it gives focus back to what opened it. Under reduced
// motion (this suite's setting) the focused object's slot copy is hidden
// under it, as motion hides it where the two share one identity.

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
  });
}

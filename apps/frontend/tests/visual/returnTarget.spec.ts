import { expect, test, type Locator, type Page } from '@playwright/test';
import { openScene, runActions } from './helpers';

// RETURN is the way out of focus and of the history, and on a touch screen,
// with no Esc key, the only one but a tap on the focus layer's thin margin.
// Its words are a micro line, 12-15px tall, and that was all a tap could hit
// (#276). Its hit area is now 44px tall round them, and reaches past each
// end, while the words stay where they were drawn.

/** Whether a tap at each point round `button`'s words lands on it. */
async function reach(page: Page, button: Locator, selector: string): Promise<Record<string, boolean>> {
  const box = (await button.boundingBox())!;
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const points: Record<string, { x: number; y: number }> = {
    above: { x: middle.x, y: middle.y - 20 },
    below: { x: middle.x, y: middle.y + 20 },
    before: { x: box.x - 8, y: middle.y },
    after: { x: box.x + box.width + 8, y: middle.y },
  };
  const hits: Record<string, boolean> = {};
  for (const [name, point] of Object.entries(points)) {
    hits[name] = await page.evaluate(({ x, y, selector }) => Boolean(document.elementFromPoint(x, y)?.closest(selector)), { ...point, selector });
  }
  return hits;
}

const everywhere = { above: true, below: true, before: true, after: true };

for (const viewport of [{ width: 820, height: 1180 }, { width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('RETURN in focus takes a tap 44px tall round its words', async ({ page }) => {
      await openScene(page, 'results');
      await runActions(page, [{ op: 'focus', id: 'test-matrix' }]);
      const button = page.locator('.focus-layer__return');
      await expect(button).toBeVisible();
      await page.waitForTimeout(600);
      expect(await reach(page, button, '.focus-layer__return')).toEqual(everywhere);
      // A tap under the words, on no word of them, still returns.
      const box = (await button.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 18);
      await expect(page.locator('.focus-layer')).toHaveCount(0);
    });

    test('RETURN in the history takes a tap 44px tall round its words', async ({ page }) => {
      await openScene(page, 'conversation');
      await page.locator('.transcript-toggle').click();
      const button = page.locator('.transcript__return');
      await expect(button).toBeVisible();
      await page.waitForTimeout(400);
      expect(await reach(page, button, '.transcript__return')).toEqual(everywhere);
    });
  });
}

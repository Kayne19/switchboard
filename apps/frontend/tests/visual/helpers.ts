import { expect, type Page } from '@playwright/test';

// What the browser specs share, written once: the geometries the goldens are
// drawn at, opening a fixture scene, and running actions through the page's
// controller. Each spec keeps its own waits.

/** The four geometries the goldens are drawn at (visual.spec.ts). */
export const GEOMETRIES = [
  { name: 'portrait-phone', width: 390, height: 844 },
  { name: 'portrait-tablet', width: 820, height: 1180 },
  { name: 'landscape', width: 1440, height: 900 },
  { name: 'ultrawide', width: 2560, height: 1080 },
] as const;

/** Opens a canonical fixture scene without the page chrome, and waits for the stage. */
export async function openScene(page: Page, scene: string): Promise<void> {
  await page.goto(`/?scene=${scene}&chrome=0`);
  await expect(page.locator('.stage')).toBeVisible();
}

/** Runs actions through the page's controller, in order, as an agent's display calls arrive. */
export async function runActions(page: Page, actions: unknown[]): Promise<void> {
  await page.evaluate((list) => {
    const controller = window.SwitchboardController;
    if (!controller) throw new Error('controller unavailable');
    controller.run(list);
  }, actions);
}

import { expect, test } from '@playwright/test';

const scenes = ['idle', 'conversation', 'training', 'architecture', 'email', 'code'] as const;
const geometries = [
  { name: 'portrait-phone', width: 390, height: 844 },
  { name: 'portrait-tablet', width: 820, height: 1180 },
  { name: 'landscape', width: 1440, height: 900 },
  { name: 'ultrawide', width: 2560, height: 1080 },
] as const;

for (const geometry of geometries) {
  test.describe(geometry.name, () => {
    test.use({ viewport: { width: geometry.width, height: geometry.height } });

    for (const scene of scenes) {
      test(`${scene} remains visually locked`, async ({ page }) => {
        await page.goto(`/?scene=${scene}&chrome=0`);
        await page.waitForSelector(`[data-scene="${scene === 'email' ? 'document' : scene}"]`, { state: 'visible' });
        await page.evaluate(() => document.body.classList.add('presentation-mode'));
        await expect(page.locator('.stage')).toHaveScreenshot(`${geometry.name}-${scene}.png`, {
          animations: 'disabled',
          caret: 'hide',
          maxDiffPixelRatio: 0.008,
        });
      });
    }
  });
}

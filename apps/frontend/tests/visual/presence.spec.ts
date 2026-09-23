import { expect, test, type Page } from '@playwright/test';

// The listening signal below the glyph is wider than the presence on narrow
// geometries. It must overflow around the presence's centre, never widen the
// column the glyph is sized from: that is what made the glyph grow and drift
// off-centre each time listening started or stopped.
const geometries = [
  { name: 'portrait-phone', width: 390, height: 844 },
  { name: 'portrait-tablet', width: 820, height: 1180 },
  { name: 'landscape', width: 1440, height: 900 },
  { name: 'ultrawide', width: 2560, height: 1080 },
] as const;

async function glyphGeometry(page: Page) {
  return page.evaluate(() => {
    const presence = document.querySelector('[data-testid="damocles-presence"]');
    const glyph = presence?.querySelector('.damocles-presence__float svg');
    if (!presence || !glyph) throw new Error('presence not rendered');
    const outer = presence.getBoundingClientRect();
    const inner = glyph.getBoundingClientRect();
    return {
      presenceWidth: outer.width,
      glyphWidth: inner.width,
      glyphHeight: inner.height,
      centreOffset: inner.x + inner.width / 2 - (outer.x + outer.width / 2),
    };
  });
}

for (const geometry of geometries) {
  test(`presence keeps its glyph geometry across listening / ${geometry.name}`, async ({ page }) => {
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    await page.goto('/?scene=architecture&chrome=0');
    await page.waitForSelector('[data-testid="damocles-presence"]');
    await page.waitForTimeout(600);
    const resting = await glyphGeometry(page);
    expect(resting.glyphWidth).toBeLessThanOrEqual(resting.presenceWidth + 0.5);
    expect(Math.abs(resting.centreOffset)).toBeLessThan(1);

    await page.keyboard.press('l');
    await expect(page.locator('.voice-indicator')).toBeVisible();
    await page.waitForTimeout(600);
    const listening = await glyphGeometry(page);

    await page.keyboard.press('l');
    await expect(page.locator('.voice-indicator')).toHaveCount(0);
    await page.waitForTimeout(600);
    const stopped = await glyphGeometry(page);

    for (const sample of [listening, stopped]) {
      expect(sample.glyphWidth).toBeCloseTo(resting.glyphWidth, 1);
      expect(sample.glyphHeight).toBeCloseTo(resting.glyphHeight, 1);
      expect(Math.abs(sample.centreOffset)).toBeLessThan(1);
    }
  });
}

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

// What sits under the glyph -- the voice bars and their label while
// listening, the caption otherwise -- is centred on the sword itself: the
// line through its pommel and grip, x = 451 of the glyph's 944 units. That
// is not the centre of the glyph's box, which the diagonal hilt pulls right.
async function centrelines(page: Page) {
  return page.evaluate(() => {
    const presence = document.querySelector('[data-testid="damocles-presence"]');
    const grip = presence?.querySelector('polygon[points="442,176 460,176 460,441 442,423"]');
    if (!presence || !grip) throw new Error('presence not rendered');
    const centre = (selector: string) => {
      const element = presence.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return box.x + box.width / 2;
    };
    const axis = centre('polygon[points="442,176 460,176 460,441 442,423"]')!;
    const offset = (value: number | null) => (value === null ? null : value - axis);
    return {
      presenceWidth: presence.getBoundingClientRect().width,
      glyphWidth: presence.querySelector('.damocles-presence__float svg')!.getBoundingClientRect().width,
      bars: offset(centre('.voice-indicator__bars')),
      label: offset(centre('.voice-indicator__label')),
      caption: offset(centre('.damocles-presence__caption')),
    };
  });
}

const resizeRun = [
  [1440, 900], [1280, 860], [1100, 820], [960, 900], [820, 1180], [700, 1100],
  [600, 1000], [480, 900], [390, 844], [2560, 1080], [1440, 900],
] as const;

test('presence stays centred on the sword through a continuous resize', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?scene=architecture&chrome=0');
  await page.waitForSelector('[data-testid="damocles-presence"]');
  await page.waitForTimeout(600);

  for (const listening of [true, false]) {
    await page.keyboard.press('l');
    await (listening
      ? expect(page.locator('.voice-indicator')).toBeVisible()
      : expect(page.locator('.voice-indicator')).toHaveCount(0));
    for (const [width, height] of resizeRun) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(350);
      const sample = await centrelines(page);
      const where = `${width}x${height} ${listening ? 'listening' : 'caption'}`;
      expect(sample.glyphWidth, where).toBeCloseTo(sample.presenceWidth, 0);
      const signal = listening ? [sample.bars, sample.label] : [sample.caption];
      for (const offset of signal) {
        expect(offset, where).not.toBeNull();
        expect(Math.abs(offset!), where).toBeLessThan(1);
      }
    }
  }
});

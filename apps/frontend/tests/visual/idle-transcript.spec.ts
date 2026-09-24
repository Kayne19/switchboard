import { expect, test, type Page } from '@playwright/test';
import { DisplayFixtureServer } from '../integration/display-fixture-server.mjs';

// The idle stage keeps a voice-free way onto the line: the conversation
// page's transcript toggle, in the same place, out of sight until the pointer
// reaches the bottom of the stage. It must never show at rest where a pointer
// can hover (the idle goldens depend on it), and must rest in view where
// nothing can.

const geometries = [
  { name: 'portrait-phone', width: 390, height: 844 },
  { name: 'portrait-tablet', width: 820, height: 1180 },
  { name: 'landscape', width: 1440, height: 900 },
  { name: 'ultrawide', width: 2560, height: 1080 },
] as const;

const idleToggle = '.scene--idle .transcript-reveal .transcript-toggle';

async function box(page: Page, selector: string) {
  const found = await page.locator(selector).boundingBox();
  if (!found) throw new Error(`${selector} has no box`);
  return found;
}

async function openIdle(page: Page, query = '?scene=idle&chrome=0') {
  await page.goto(`/${query}`);
  await expect(page.locator('main.stage[data-scene-kind="idle"]')).toBeVisible();
  await expect(page.locator(idleToggle)).toHaveCount(1);
}

for (const geometry of geometries) {
  test(`the idle toggle rests hidden where the conversation shows it / ${geometry.name}`, async ({ page }) => {
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    await openIdle(page);
    const toggle = page.locator(idleToggle);
    await expect(toggle).toHaveCSS('opacity', '0');
    const idle = await box(page, idleToggle);
    const band = await box(page, '.transcript-reveal');
    const presence = await box(page, '.scene--idle [data-testid="damocles-presence"]');

    // A full-width band along the bottom that holds the toggle and stops
    // short of the glyph, with its float's travel to spare.
    expect(band.x).toBe(0);
    expect(band.width).toBe(geometry.width);
    expect(band.y + band.height).toBe(geometry.height);
    expect(idle.y).toBeGreaterThan(band.y);
    expect(presence.y + presence.height + 16).toBeLessThan(band.y);

    await page.goto('/?scene=conversation&chrome=0');
    const conversation = await box(page, '.scene--conversation > .transcript-toggle');
    expect(idle.x).toBeCloseTo(conversation.x, 0);
    expect(idle.y).toBeCloseTo(conversation.y, 0);
    expect(idle.width).toBeCloseTo(conversation.width, 0);
    expect(idle.height).toBeCloseTo(conversation.height, 0);
  });
}

test.describe('landscape', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the pointer in the bottom band reveals the toggle, and clicking it opens the drawer over idle', async ({ page }) => {
    await openIdle(page);
    const toggle = page.locator(idleToggle);
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(true);
    await expect(toggle).toHaveCSS('opacity', '0');

    // Anywhere in the band, not only over the toggle.
    await page.mouse.move(200, 880);
    await expect(toggle).toHaveCSS('opacity', '1');
    await page.mouse.move(200, 500);
    await expect(toggle).toHaveCSS('opacity', '0');

    await toggle.hover();
    await expect(toggle).toHaveCSS('opacity', '1');
    await toggle.click();
    const drawer = page.getByRole('dialog', { name: 'Conversation history' });
    await expect(drawer).toBeVisible();
    await expect(page.locator('main.stage')).toHaveAttribute('data-scene-kind', 'idle');

    await drawer.getByRole('button', { name: 'RETURN / ESC' }).click();
    await expect(drawer).toHaveCount(0);
    await page.mouse.move(200, 300);
    await expect(toggle).toHaveCSS('opacity', '0');
  });

  test('the band never takes a click meant for the glyph', async ({ page }) => {
    await openIdle(page);
    const presence = await box(page, '.scene--idle .damocles-presence__button');
    const centre = { x: presence.x + presence.width / 2, y: presence.y + presence.height / 2 };
    const hit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return Boolean(element?.closest('.damocles-presence__button'));
    }, centre);
    expect(hit).toBe(true);

    const button = page.locator('.scene--idle .damocles-presence__button');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await page.mouse.click(centre.x, centre.y);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  test('content scenes carry no band', async ({ page }) => {
    for (const scene of ['training', 'architecture', 'email', 'code']) {
      await page.goto(`/?scene=${scene}&chrome=0`);
      await expect(page.locator('main.stage')).not.toHaveAttribute('data-scene-kind', 'idle');
      await expect(page.locator('.scene--content')).toHaveCount(1);
      await expect(page.locator('.transcript-reveal')).toHaveCount(0);
    }
  });

  test('reduced motion shows and hides the toggle at once', async ({ page }) => {
    await openIdle(page);
    const durations = await page.locator(idleToggle).evaluate((element) =>
      getComputedStyle(element).transitionDuration.split(',').map((value) => parseFloat(value)),
    );
    expect(Math.max(...durations)).toBeLessThan(0.001);
  });

  test.describe('without reduced motion', () => {
    test.use({ contextOptions: { reducedMotion: 'no-preference' } });

    test('the toggle fades in and out', async ({ page }) => {
      await openIdle(page);
      const toggle = page.locator(idleToggle);
      const transition = await toggle.evaluate((element) => {
        const style = getComputedStyle(element);
        const properties = style.transitionProperty.split(',').map((value) => value.trim());
        const durations = style.transitionDuration.split(',').map((value) => parseFloat(value));
        return durations[properties.indexOf('opacity')];
      });
      expect(transition).toBeCloseTo(0.24, 2);

      await page.mouse.move(200, 880);
      await expect(toggle).toHaveCSS('opacity', '1');
      await page.mouse.move(200, 300);
      await expect(toggle).toHaveCSS('opacity', '0');
    });
  });
});

test('keyboard focus reveals the toggle, and the drawer it opens takes the typing', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 1 });
  const { wsUrl } = await fixtureServer.start();
  try {
    await openIdle(page, `?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'epoch' || frame.type === 'hello')).toBe(true);
    const toggle = page.locator(idleToggle);
    await expect(toggle).toHaveCSS('opacity', '0');

    for (let presses = 0; presses < 6; presses += 1) {
      await page.keyboard.press('Tab');
      if (await toggle.evaluate((element) => element === document.activeElement)) break;
    }
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveCSS('opacity', '1');

    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: 'Conversation history' });
    await expect(drawer).toBeVisible();
    const input = drawer.getByRole('textbox', { name: 'Conversation input' });
    await expect(input).toBeEnabled();
    await expect(input).toBeFocused();

    await page.keyboard.type('l 1 hello');
    await expect(input).toHaveValue('l 1 hello');
    await expect(page.locator('main.stage')).toHaveAttribute('data-scene-kind', 'idle');
    await expect(page.locator('.scene--idle .damocles-presence__button')).toHaveAttribute('aria-pressed', 'false');
    expect(fixtureServer.frames.some((frame) => frame.type === 'clip' || String(frame.type).startsWith('stt_'))).toBe(false);

    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  } finally {
    await fixtureServer.stop();
  }
});

test.describe('where nothing can hover', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the idle toggle rests in view and a tap opens the drawer', async ({ page }) => {
    await openIdle(page);
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    const toggle = page.locator(idleToggle);
    await expect(toggle).toHaveCSS('opacity', '1');
    await expect(toggle).toHaveCSS('color', 'rgba(232, 230, 223, 0.42)');

    await toggle.tap();
    await expect(page.getByRole('dialog', { name: 'Conversation history' })).toBeVisible();
  });
});

import { expect, test, type Page } from '@playwright/test';
import { DisplayFixtureServer } from '../integration/display-fixture-server.mjs';
import { FRAME_GEOMETRIES, focusRingFault, openScene } from './helpers';

// The CHANNEL / MODE stack in every page's bottom-left corner (#180), where
// jsdom cannot see it (tests/unit/channelMode.test.tsx covers what it draws
// and what it switches): where it stands, and that both controls in the
// bottom band keep their clicks.
//
// MODE and the centred transcript toggle overlap by 25px on a 390px-wide
// phone. The toggle keeps all of its clicks on the conversation page, as
// issues.spec.ts pins; MODE keeps all of its clicks on the idle page, where
// the bottom hover band (`transcript-reveal`) would otherwise take them.

/** Whether each of the three points across `selector` reaches that element. */
async function hits(page: Page, selector: string): Promise<boolean[]> {
  return page.evaluate((sel) => {
    const element = document.querySelector<HTMLElement>(sel)!;
    const box = element.getBoundingClientRect();
    return [0.1, 0.5, 0.9].map((fraction) => {
      const hit = document.elementFromPoint(box.left + box.width * fraction, box.top + box.height / 2);
      return Boolean(hit && element.contains(hit));
    });
  }, selector);
}

for (const geometry of FRAME_GEOMETRIES) {
  test(`the corner stack stands in the bottom-left of every page, clear of what it shares the band with / ${geometry.name}`, async ({ page }) => {
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    for (const scene of ['idle', 'conversation', 'training', 'code', 'today']) {
      await openScene(page, scene);
      await page.waitForTimeout(400);
      const stack = page.locator('.channel-stack');
      await expect(stack, scene).toHaveCount(1);
      await expect(stack, scene).toContainText('CHANNEL / VOICE');
      await expect(stack, scene).toContainText('MODE / PUSH-TO-TALK');
      const box = (await stack.boundingBox())!;
      // The bottom-left corner: in the lower and left quarters of the stage.
      const stage = (await page.locator('.stage').boundingBox())!;
      expect(box.x - stage.x, `${scene} left`).toBeLessThan(stage.width / 4);
      expect(box.y - stage.y, `${scene} bottom`).toBeGreaterThan(stage.height * 0.75);
    }

    await openScene(page, 'conversation');
    await page.waitForTimeout(400);
    expect(await hits(page, '.transcript-toggle'), 'the conversation toggle').toEqual([true, true, true]);

    await openScene(page, 'idle');
    await page.waitForTimeout(400);
    expect(await hits(page, '.channel-stack__mode'), 'MODE under the idle band').toEqual([true, true, true]);
  });
}

test('MODE is the call page\'s hands-free control: reached by the keyboard, drawing the page\'s ring', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 7 });
  try {
    const { wsUrl } = await fixtureServer.start();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
    const mode = page.locator('.channel-stack__mode');
    // On a call there is a transport to switch, so the control is live.
    await expect(mode).toBeEnabled();
    await expect(mode).toHaveAttribute('aria-pressed', 'false');
    await mode.focus();
    await expect(mode).toBeFocused();
    expect(await page.evaluate(focusRingFault)).toBeNull();
  } finally {
    await fixtureServer.stop();
  }
});

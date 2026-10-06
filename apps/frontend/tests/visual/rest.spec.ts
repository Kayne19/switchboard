import { expect, test } from '@playwright/test';
import { GEOMETRIES, openScene } from './helpers';

// At rest nothing on the stage keeps the blur an entrance resolved out of.
// Motion leaves the value it animated to; `blur(0px)` looks like no filter
// but is one, and Chrome drew a box under it through a surface of its own
// or not as its compositor decided from load to load: the portrait list and
// calendar scenes then drew their text a pixel higher or lower between two
// loads with the same layout (ObjectMotion `SHARP`).
const scenes = ['today', 'tasks', 'inbox', 'calendar-agenda', 'weather', 'timer', 'code', 'email', 'architecture', 'composed'];

for (const geometry of GEOMETRIES) {
  test(`no object keeps its entrance blur at rest / ${geometry.name}`, async ({ page }) => {
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    const kept: string[] = [];
    for (const scene of scenes) {
      await openScene(page, scene);
      // Past every entrance (0.42 s at most).
      await page.waitForTimeout(900);
      kept.push(...(await page.evaluate((name) => [...document.querySelectorAll('.stage *')]
        .filter((element) => /blur\(/.test(getComputedStyle(element).filter))
        .map((element) => `${name} ${String(element.getAttribute('class') ?? element.tagName).split(' ').slice(0, 2).join('.')} ${getComputedStyle(element).filter}`), scene)));
    }
    expect(kept).toEqual([]);
  });
}

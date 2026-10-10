import { expect, test } from '@playwright/test';
import { openScene, runActions } from './helpers';

// The focus box is sized from the stage, not from the large viewport
// (issue #271). Safari's large viewport (`vh`) is taller than what shows
// while its toolbars are out: a box sized in `vh` ran past the bottom of the
// visible stage, and the end of a focused document, or the note under it,
// could not be reached. Chromium's `vh` is its visible height, so each case
// holds the stage and the layer at a visible height shorter than the window,
// as Safari's are with its toolbars shown, and the box must stand inside it.

const CASES = [
  // An iPhone in portrait: the large viewport 844, the small one 664.
  { name: 'phone portrait, toolbars out', width: 390, height: 844, visible: 664 },
  { name: 'phone portrait, toolbars part out', width: 390, height: 844, visible: 754 },
  // On its side, Safari's bar takes some 50 px of 390.
  { name: 'phone landscape, toolbar out', width: 844, height: 390, visible: 340 },
  { name: 'tablet portrait, toolbar out', width: 820, height: 1180, visible: 1110 },
] as const;

const FOCUSED = [
  { scene: 'email', id: 'mail' },
  { scene: 'code', id: 'source' },
  { scene: 'training', id: 'loss' },
  { scene: 'results', id: 'test-matrix' },
] as const;

for (const geometry of CASES) {
  test.describe(geometry.name, () => {
    test.use({ viewport: { width: geometry.width, height: geometry.height } });

    for (const { scene, id } of FOCUSED) {
      test(`${scene}: the focused ${id} stands inside the visible stage`, async ({ page }) => {
        await openScene(page, scene);
        await page.addStyleTag({
          content: `.stage { height: ${geometry.visible}px !important; } .focus-layer { bottom: auto !important; height: ${geometry.visible}px !important; }`,
        });
        await runActions(page, [{ op: 'focus', id }]);
        await expect(page.locator('.focus-layer')).toBeVisible();
        const boxes = await page.evaluate(() => {
          const stage = document.querySelector('.stage')!.getBoundingClientRect();
          const content = document.querySelector('.focus-layer__content')!.getBoundingClientRect();
          const back = document.querySelector('.focus-layer__return')!.getBoundingClientRect();
          return { stage: { top: stage.top, bottom: stage.bottom }, content: { top: content.top, bottom: content.bottom }, back: { top: back.top, bottom: back.bottom } };
        });
        expect(boxes.content.bottom, 'the box ends inside the visible stage').toBeLessThanOrEqual(boxes.stage.bottom + 0.5);
        expect(boxes.back.top, 'RETURN starts inside the visible stage').toBeGreaterThanOrEqual(boxes.stage.top - 0.5);
        expect(boxes.back.bottom, 'RETURN ends inside the visible stage').toBeLessThanOrEqual(boxes.stage.bottom + 0.5);
      });
    }
  });
}

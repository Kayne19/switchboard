import { expect, test } from '@playwright/test';

// A scrolled diagram's map stands in a strip of its own and covers no part
// of the drawing, and focus keeps the note about the diagram. jsdom has no
// layout, so the unit tests see the strip's structure; this sees the boxes.
const geometries = [
  { name: 'portrait-phone', width: 390, height: 844 },
  { name: 'portrait-tablet', width: 820, height: 1180 },
  { name: 'landscape', width: 1440, height: 900 },
  { name: 'ultrawide', width: 2560, height: 1080 },
];
const scenes = [
  { scene: 'topology', id: 'topology' },
  { scene: 'pipeline', id: 'pipeline' },
  { scene: 'trace', id: 'trace' },
];

for (const geometry of geometries) {
  test.describe(geometry.name, () => {
    test.use({ viewport: { width: geometry.width, height: geometry.height } });
    for (const { scene, id } of scenes) {
      test(`${scene}: the map stays off the drawing, in the slot and in focus, and focus keeps the note`, async ({ page }) => {
        await page.goto(`/?scene=${scene}&chrome=0`);
        await expect(page.locator('.drawing-viewport').first()).toBeVisible();
        await page.waitForTimeout(400);
        const apart = () =>
          page.evaluate(() =>
            [...document.querySelectorAll('.drawing-viewport')].map((viewport) => {
              const map = viewport.querySelector('.drawing-viewport__map')?.getBoundingClientRect();
              const view = viewport.querySelector('.drawing-viewport__scroll')!.getBoundingClientRect();
              if (!map) return true;
              return map.right <= view.left + 0.5 || map.left >= view.right - 0.5 || map.bottom <= view.top + 0.5 || map.top >= view.bottom - 0.5;
            }),
          );
        expect((await apart()).every(Boolean)).toBe(true);
        await page.evaluate((target) => window.SwitchboardController?.dispatch({ op: 'focus', id: target }), id);
        const layer = page.locator('.focus-layer');
        await expect(layer.locator('.focus-layer__note .annotation-card')).toBeVisible();
        await expect(layer.locator('.diagram-node__marker, .sequence-actor__marker').first()).toBeVisible();
        await page.waitForTimeout(400);
        expect((await apart()).every(Boolean)).toBe(true);
        // The note's panel lies beside or under the drawing, not over it.
        const boxes = await page.evaluate(() => {
          const note = document.querySelector('.focus-layer__note')!.getBoundingClientRect();
          const drawing = document.querySelector('.focus-layer .drawing-viewport')!.getBoundingClientRect();
          return { note: [note.left, note.top, note.right, note.bottom], drawing: [drawing.left, drawing.top, drawing.right, drawing.bottom] };
        });
        const [nl, nt, nr, nb] = boxes.note;
        const [dl, dt, dr, db] = boxes.drawing;
        expect(nr <= dl + 0.5 || nl >= dr - 0.5 || nb <= dt + 0.5 || nt >= db - 0.5).toBe(true);
      });
    }
  });
}

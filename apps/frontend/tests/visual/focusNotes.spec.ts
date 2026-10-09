import { expect, test } from '@playwright/test';
import { GEOMETRIES, openScene, runActions } from './helpers';

// Focus keeps the notes about any object (FocusLayer `focusNotes`): beside
// it when the box is wide, under it when it is tall. jsdom has no layout,
// so the unit tests see which notes are kept; this sees the boxes: the
// cards and RETURN on the screen, each card's TARGET line whole, the panel
// clear of the object, at every geometry the page is drawn at.
const geometries = [
  ...GEOMETRIES,
  { name: 'landscape-short', width: 844, height: 390 },
  { name: 'landscape-hd', width: 1280, height: 720 },
];

const long = 'The static rebuild waits on the graph layout, which waits on two goldens Kayne has not approved yet. '.repeat(6);
const note = (id: string, target: string, text: string, anchor: Record<string, unknown> = {}) => ({
  op: 'show', id, type: 'note', data: { tag: 'DAMOCLES / NOTE', anchor: { target, ...anchor }, segments: [{ text }] },
});

const cases = [
  // A chart keeps every note about it; each names its point.
  { name: 'a chart and its two notes', scene: 'training', focus: 'loss', cards: 2, actions: [note('early-note', 'loss', 'Both losses fall together through the warmup.', { x: 6, series: 'TRAIN LOSS' })] },
  { name: 'a table and its note', scene: 'results', focus: 'test-matrix', cards: 1, actions: [{ op: 'hide', id: 'results-note' }, note('results-note', 'test-matrix', 'Two frontend unit failures, both in notePlacement.test.ts.')] },
  // A long note on an object whose box is as tall as its content: the box
  // is held to the screen, and the card scrolls (review: RETURN went off it).
  { name: 'a progress and a long note', scene: 'plan', focus: 'ship-plan', cards: 1, actions: [{ op: 'hide', id: 'plan-note' }, note('plan-note', 'ship-plan', long)] },
  { name: 'a metric and a long note', scene: 'plan', focus: 'build-time', cards: 1, actions: [note('build-note', 'build-time', long)] },
];

for (const geometry of geometries) {
  test.describe(geometry.name, () => {
    test.use({ viewport: { width: geometry.width, height: geometry.height } });
    for (const { name, scene, focus, cards, actions } of cases) {
      test(`focus keeps ${name} on the screen, its TARGET lines whole`, async ({ page }) => {
        await openScene(page, scene);
        await expect(page.locator('.stage')).toBeVisible();
        await runActions(page, actions);
        await page.evaluate((target) => window.SwitchboardController?.dispatch({ op: 'focus', id: target }), focus);
        const layer = page.locator('.focus-layer');
        await expect(layer.locator('.focus-layer__note .annotation-card')).toHaveCount(cards);
        await page.waitForTimeout(400);
        const seen = await page.evaluate(() => {
          const box = (element: Element | null) => {
            const rect = element!.getBoundingClientRect();
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
          };
          const content = document.querySelector('.focus-layer__content')!;
          const object = content.querySelector(':scope > :not(.focus-layer__header):not(.focus-layer__note)');
          return {
            view: { width: window.innerWidth, height: window.innerHeight },
            button: box(document.querySelector('.focus-layer__header button')),
            content: box(content),
            panel: box(document.querySelector('.focus-layer__note')),
            object: object ? box(object) : null,
            cards: [...document.querySelectorAll('.focus-layer__note .annotation-card')].map((card) => {
              const anchor = card.querySelector<HTMLElement>('.annotation-card__anchor')!;
              return { box: box(card), cut: anchor.scrollWidth > anchor.clientWidth + 1 };
            }),
          };
        });
        const onScreen = (rect: { left: number; top: number; right: number; bottom: number }) =>
          rect.left >= -0.5 && rect.top >= -0.5 && rect.right <= seen.view.width + 0.5 && rect.bottom <= seen.view.height + 0.5;
        expect(onScreen(seen.button), 'RETURN stays on the screen').toBe(true);
        expect(onScreen(seen.content), 'the focus box stays on the screen').toBe(true);
        for (const card of seen.cards) {
          expect(onScreen(card.box), 'every card stays on the screen').toBe(true);
          expect(card.cut, 'a TARGET line is never cut').toBe(false);
        }
        // The panel lies beside or under the object, not over it.
        if (seen.object) {
          const [p, o] = [seen.panel, seen.object];
          expect(p.right <= o.left + 0.5 || p.left >= o.right - 0.5 || p.bottom <= o.top + 0.5 || p.top >= o.bottom - 0.5).toBe(true);
        }
      });
    }
  });
}

import { expect, test } from '@playwright/test';
import type { ControllerAction } from '../../src/controller/types';
import { FRAME_GEOMETRIES, openScene, runActions } from './helpers';

// Every note on stage is shown (pr/issues.md, "The rail shows one note"):
// the rail carries them all after the one about the primary, each whole,
// and where they do not all fit its column scrolls, the edge it continues
// past fading as a scroller's does. tests/unit/railNotes.test.tsx pins which
// notes go where; this pins the boxes, which jsdom does not draw.

const note = (id: string, anchor?: { target: string }): ControllerAction => ({
  op: 'show', id, type: 'note', data: { tag: id.toUpperCase(), ...(anchor ? { anchor } : {}), segments: [{ text: `${id}: the second suite took four times as long as the first, and the third one never finished on this runner.` }] },
});
const table: ControllerAction = { op: 'show', id: 'grid', type: 'table', role: 'primary', data: { title: 'SUITES', columns: [{ label: 'SUITE' }, { label: 'MS' }], rows: [['backend', 38], ['frontend', 108]] } };
const notes = [note('about-grid', { target: 'grid' }), note('general'), note('later'), note('last')];

for (const size of FRAME_GEOMETRIES) {
  test(`${size.width}x${size.height}: the rail shows every note, each whole, and fades an edge it continues past`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await openScene(page, 'idle');
    await runActions(page, [table, ...notes]);
    await expect(page.locator('.content-rail .annotation-card')).toHaveCount(notes.length);
    await page.waitForTimeout(700);
    const seen = await page.evaluate(() => {
      const column = document.querySelector<HTMLElement>('.content-rail__details')!;
      const cards = [...column.querySelectorAll<HTMLElement>('.rail-note .annotation-card')];
      return {
        tags: cards.map((card) => card.querySelector('.annotation-card__tag')?.textContent),
        // Each card reads whole: its text does not scroll inside it.
        cut: cards.filter((card) => card.scrollHeight > card.clientHeight + 1).length,
        overflows: column.scrollHeight > column.clientHeight + 1,
        fadeBelow: document.querySelector('.content-rail .scroll-rim__fade--bottom') !== null,
      };
    });
    expect(seen.tags).toEqual(['ABOUT-GRID', 'GENERAL', 'LATER', 'LAST']);
    expect(seen.cut).toBe(0);
    expect(seen.fadeBelow).toBe(seen.overflows);
  });
}

// A diagram that carries its note as a callout marks that note's node; a
// second note about another node of it, in the rail, must not carry the
// badge, for its node is not marked (review-fix-charts M1).
test('a second note about a diagram whose first is a callout carries no badge', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openScene(page, 'idle');
  await runActions(page, [
    { op: 'show', id: 'flow', type: 'diagram', role: 'primary', data: { mode: 'graph', nodes: [{ id: 'gate', label: 'GATE' }, { id: 'planner', label: 'PLANNER' }, { id: 'pool', label: 'POOL' }], edges: [{ from: 'gate', to: 'planner' }, { from: 'planner', to: 'pool' }] } },
    { op: 'show', id: 'gate-note', type: 'note', data: { tag: 'GATE', anchor: { target: 'flow', node: 'gate' }, segments: [{ text: 'The gate stamps each action.' }] } },
  ]);
  await expect(page.locator('.diagram-callout')).toBeVisible();
  await runActions(page, [{ op: 'show', id: 'planner-note', type: 'note', data: { tag: 'PLANNER', anchor: { target: 'flow', node: 'planner' }, segments: [{ text: 'The planner writes the plan.' }] } }]);
  const card = page.locator('.content-rail .annotation-card');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.annotation-card__tag')).toHaveText('PLANNER');
  await expect(card.locator('.note-badge')).toHaveCount(0);
  await expect(page.locator('.diagram-node__body--anchored')).toHaveCount(1);
});

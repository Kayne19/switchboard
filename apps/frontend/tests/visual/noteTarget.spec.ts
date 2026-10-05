import { expect, test, type Page } from '@playwright/test';

// A note's card names what it is about in its object's words (noteTarget,
// apps/frontend/src/app/noteItems.ts), and the words are its point: where
// they do not fit beside the tag they take a line of their own rather than
// be cut. Before, a note about a table read "TARGET / test-matrix", an id,
// and a note about a node in a phone's folded strip read "TARG…".
// tests/unit/noteItems.test.tsx pins the words; these pin the boxes, which
// jsdom does not draw.

const geometries = [
  { name: 'portrait-phone', width: 390, height: 844 },
  { name: 'portrait-tablet', width: 820, height: 1180 },
  { name: 'landscape', width: 1440, height: 900 },
  { name: 'ultrawide', width: 2560, height: 1080 },
  { name: 'short', width: 844, height: 390 },
  { name: 'hd', width: 1280, height: 720 },
] as const;

const aboutTable = [
  { op: 'show', id: 'results-note', type: 'note', data: { tag: 'DAMOCLES / FAILURES', anchor: { target: 'test-matrix' }, segments: [{ text: 'Two frontend unit failures, both in notePlacement.test.ts.' }] } },
];

async function open(page: Page, scene: string, actions: unknown[] = []) {
  await page.goto(`/?scene=${scene}&chrome=0`);
  await expect(page.locator('.stage')).toBeVisible();
  if (actions.length > 0) await page.evaluate((list) => window.SwitchboardController!.run(list), actions);
  await page.waitForTimeout(700);
}

// The card's TARGET line: its words, and whether they are cut.
async function railTarget(page: Page) {
  return page.locator('.content-rail .annotation-card__anchor').evaluate((anchor) => {
    const badge = anchor.closest('.annotation-card')!.querySelector<HTMLElement>('.annotation-card__header .note-badge');
    const middle = (element: Element) => { const box = element.getBoundingClientRect(); return box.top + box.height / 2; };
    return {
      text: anchor.textContent,
      cut: anchor.scrollWidth > anchor.clientWidth + 1,
      badge: badge !== null,
      // The badge stands beside the words it matches, on their line.
      ...(badge ? { besideBadge: Math.abs(middle(badge) - middle(anchor)) < 4 } : {}),
    };
  });
}

for (const geometry of geometries) {
  test(`a rail card names a table by its title, whole, at ${geometry.width}x${geometry.height}`, async ({ page }) => {
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    await open(page, 'results', aboutTable);
    expect(await railTarget(page)).toEqual({ text: 'TARGET / TESTS / MATRIX', cut: false, badge: false });
  });

  test(`a rail card names a node by its label, whole, with its badge, at ${geometry.width}x${geometry.height}`, async ({ page }) => {
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    await open(page, 'topology');
    expect(await railTarget(page)).toEqual({ text: 'TARGET / Display gate', cut: false, badge: true, besideBadge: true });
  });
  test(`a rail card names a forecast's day with the badge beside it at ${geometry.width}x${geometry.height}`, async ({ page }) => {
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    await open(page, 'weather');
    expect(await railTarget(page)).toEqual({ text: 'TARGET / THU OCT 8', cut: false, badge: true, besideBadge: true });
  });
}

test('the folded strip on a phone names the node whole', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'topology');
  await expect(page.locator('.content-rail--folded')).toBeVisible();
  const target = await railTarget(page);
  expect(target).toEqual({ text: 'TARGET / Display gate', cut: false, badge: true, besideBadge: true });
  // On a line of its own, under the tag.
  const [tag, anchor] = await Promise.all(['.annotation-card__tag', '.annotation-card__anchor'].map((selector) =>
    page.locator(`.content-rail ${selector}`).evaluate((element) => element.getBoundingClientRect().top)));
  expect(anchor).toBeGreaterThan(tag + 4);
});

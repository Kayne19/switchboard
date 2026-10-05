import { expect, test, type Page } from '@playwright/test';

// The calendar in a real browser, at each geometry the visual suite uses:
// what jsdom cannot see because it draws no boxes. No golden is compared;
// each test asks a question of the layout.

const geometries = [
  { name: 'portrait-phone', width: 390, height: 844 },
  { name: 'portrait-tablet', width: 820, height: 1180 },
  { name: 'landscape', width: 1440, height: 900 },
  { name: 'ultrawide', width: 2560, height: 1080 },
] as const;

const scenes = ['calendar', 'calendar-day', 'calendar-month', 'calendar-agenda', 'today'] as const;

async function open(page: Page, scene: string, focus = false) {
  await page.goto(`/?scene=${scene}&chrome=0`);
  await expect(page.locator('[data-testid="calendar"]').first()).toBeVisible();
  if (focus) {
    await page.evaluate(() => window.SwitchboardController?.run([{ op: 'focus', id: 'week' }]));
    await expect(page.locator('.focus-layer [data-testid="calendar"]')).toBeVisible();
  }
  // Let the body be measured and the layout settle on it.
  await page.waitForTimeout(400);
}

/** Every calendar text smaller than the page's type floors (micro 7 px, tech 8 px, prose 10 px). */
function textBelowFloors(scope: string) {
  return [...document.querySelectorAll<HTMLElement>(`${scope} [data-testid="calendar"] *`)]
    .filter((node) => [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim()))
    .filter((node) => node.getClientRects().length > 0)
    .map((node) => {
      const size = parseFloat(getComputedStyle(node).fontSize);
      const mono = /monospace/.test(getComputedStyle(node).fontFamily);
      const floor = node.closest('.micro') ? 7 : node.closest('.tech') || mono ? 8 : 10;
      return { text: node.textContent?.trim().slice(0, 24), size, floor };
    })
    .filter(({ size, floor }) => size < floor - 0.01);
}

/** Boxes of one day column that lie over one another where they stand side by side. */
function sideBySideOverlaps() {
  const hits: string[] = [];
  for (const column of document.querySelectorAll('.calendar-grid__column')) {
    const slots = [...column.querySelectorAll<HTMLElement>(':scope > .calendar-event-slot')].filter((slot) => !slot.querySelector('.calendar-event--stepped'));
    const boxes = slots.map((slot) => ({ id: slot.dataset.item, box: slot.getBoundingClientRect(), stepped: slot.style.right !== '' }));
    for (let a = 0; a < boxes.length; a += 1) {
      for (let b = a + 1; b < boxes.length; b += 1) {
        const [x, y] = [boxes[a], boxes[b]];
        if (x.stepped || y.stepped) continue;
        const across = Math.min(x.box.right, y.box.right) - Math.max(x.box.left, y.box.left);
        const down = Math.min(x.box.bottom, y.box.bottom) - Math.max(x.box.top, y.box.top);
        if (across > 1 && down > 1) hits.push(`${x.id} / ${y.id}`);
      }
    }
  }
  return hits;
}

for (const geometry of geometries) {
  test.describe(geometry.name, () => {
    test.use({ viewport: { width: geometry.width, height: geometry.height } });

    for (const scene of scenes) {
      test(`${scene}: no text below the type floors, nothing wider than its box, the marked event badged once and in view`, async ({ page }) => {
        await open(page, scene);
        expect(await page.evaluate(textBelowFloors, '.scene')).toEqual([]);
        const fit = await page.evaluate(() => {
          const calendar = document.querySelector<HTMLElement>('.scene [data-testid="calendar"]')!;
          const box = calendar.getBoundingClientRect();
          const scrolls = [...calendar.querySelectorAll<HTMLElement>('.list-viewport__scroll')].map((scroll) => scroll.scrollWidth - scroll.clientWidth);
          const badges = [...calendar.querySelectorAll<HTMLElement>('.note-badge')];
          const badge = badges[0]?.getBoundingClientRect();
          const port = badges[0]?.closest('.list-viewport__port, .calendar-month__grid')?.getBoundingClientRect() ?? box;
          return {
            sideways: Math.max(0, ...scrolls),
            badges: badges.length,
            badgeInView: badge ? badge.bottom > port.top && badge.top < port.bottom : false,
            right: Math.round(box.right),
            widest: Math.round(Math.max(...[...calendar.querySelectorAll<HTMLElement>('*')].filter((node) => node.getClientRects().length > 0 && !node.closest('.drawing-viewport__rim')).map((node) => node.getBoundingClientRect().right))),
          };
        });
        expect(fit.sideways).toBeLessThanOrEqual(1);
        expect(fit.widest).toBeLessThanOrEqual(fit.right + 1);
        expect(fit.badges).toBe(1);
        expect(fit.badgeInView).toBe(true);
        expect(await page.evaluate(sideBySideOverlaps)).toEqual([]);
      });
    }

    test('the week in focus: no text below the floors, the note beside it, every column readable', async ({ page }) => {
      await open(page, 'calendar', true);
      expect(await page.evaluate(textBelowFloors, '.focus-layer')).toEqual([]);
      const columns = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.focus-layer .calendar-grid__column')].map((column) => column.getBoundingClientRect().width));
      expect(columns.length).toBeGreaterThanOrEqual(3);
      for (const width of columns) expect(width).toBeGreaterThanOrEqual(70);
      await expect(page.locator('.focus-layer .annotation-card')).toBeVisible();
    });
  });
}

test('a week on a phone pages its columns from today, names the hidden days, and turns on a tap', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'calendar');
  const days = () => page.locator('.scene .calendar-grid__weekday').allTextContents();
  expect(await days()).toEqual(['WED', 'THU', 'FRI']);
  const rims = page.locator('.scene .calendar-pages__rim');
  await expect(rims).toHaveCount(2);
  await expect(rims.first()).toContainText('MON-TUE');
  await rims.last().click();
  expect(await days()).toEqual(['FRI', 'SAT', 'SUN']);
  // The tap turned a page and did not open focus.
  await expect(page.locator('.focus-layer')).toHaveCount(0);
});

test('the now line opens in view, and the agenda opens on it with the marked event below', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const scene of ['calendar', 'calendar-day', 'today'] as const) {
    await open(page, scene);
    const placed = await page.evaluate(() => {
      const now = document.querySelector<HTMLElement>('.scene [data-testid="calendar"] [data-lead]')!.getBoundingClientRect();
      const port = document.querySelector<HTMLElement>('.scene [data-testid="calendar"] .list-viewport__port')!.getBoundingClientRect();
      const dentist = document.querySelector<HTMLElement>('.scene [data-item="dentist"]')!.getBoundingClientRect();
      return { nowIn: now.top >= port.top && now.bottom <= port.bottom, dentistBelow: dentist.top >= now.bottom - 1 };
    });
    expect(placed, scene).toEqual({ nowIn: true, dentistBelow: true });
  }
});

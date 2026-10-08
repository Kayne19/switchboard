import { expect, test, type Page } from '@playwright/test';
import { FRAME_GEOMETRIES, GEOMETRIES, frameCrossings, openScene, runActions } from './helpers';

// The calendar in a real browser, at each geometry the visual suite uses:
// what jsdom cannot see because it draws no boxes. No golden is compared;
// each test asks a question of the layout.

const scenes = ['calendar', 'calendar-day', 'calendar-month', 'calendar-agenda', 'today'] as const;

async function open(page: Page, scene: string, focus = false) {
  await openScene(page, scene);
  await expect(page.locator('[data-testid="calendar"]').first()).toBeVisible();
  if (focus) {
    await runActions(page, [{ op: 'focus', id: 'week' }]);
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

/** Stepped events whose title a later step lies over before a line of it shows. */
function coveredTitles() {
  const hits: string[] = [];
  for (const column of document.querySelectorAll('.calendar-grid__column')) {
    const steps = [...column.querySelectorAll<HTMLElement>(':scope > .calendar-event-slot')].filter((slot) => slot.style.right !== '');
    for (const earlier of steps) {
      const title = earlier.querySelector('.calendar-event__title')!.getBoundingClientRect();
      for (const later of steps) {
        if (later === earlier || Number(later.style.zIndex) <= Number(earlier.style.zIndex)) continue;
        const box = later.getBoundingClientRect();
        const across = Math.min(box.right, title.right) - Math.max(box.left, title.left);
        if (across > 1 && box.top < title.top + 9 && box.bottom > title.top) hits.push(`${earlier.dataset.item} under ${later.dataset.item}`);
      }
    }
  }
  return hits;
}

for (const geometry of GEOMETRIES) {
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
            widest: Math.round(Math.max(...[...calendar.querySelectorAll<HTMLElement>('*')].filter((node) => node.getClientRects().length > 0).map((node) => node.getBoundingClientRect().right))),
          };
        });
        expect(fit.sideways).toBeLessThanOrEqual(1);
        expect(fit.widest).toBeLessThanOrEqual(fit.right + 1);
        expect(fit.badges).toBe(1);
        expect(fit.badgeInView).toBe(true);
        expect(await page.evaluate(sideBySideOverlaps)).toEqual([]);
        expect(await page.evaluate(coveredTitles)).toEqual([]);
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

test('a week in a narrow portrait box pages its columns from today, names the hidden days in its label, and turns by a key', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'calendar');
  const days = () => page.locator('.scene .calendar-grid__weekday').allTextContents();
  const shown = await days();
  expect(shown.length).toBeGreaterThanOrEqual(2);
  expect(shown.length).toBeLessThan(7);
  const pages = page.locator('.scene .calendar-pages');
  // No rail and no count tag over the days (#177): the days either way are
  // named in the group's label.
  await expect(page.locator('.scene .calendar-pages__rim, .scene [class*="scroll-rim"]')).toHaveCount(0);
  await expect(pages).toHaveAttribute('aria-label', /Earlier: MON/);
  await pages.focus();
  await page.keyboard.press('ArrowRight');
  expect(await days()).not.toEqual(shown);
  // The key turned a page and did not open focus.
  await expect(page.locator('.focus-layer')).toHaveCount(0);
});

// A finger swipe, as a touch screen sends it: down, across in steps, up.
async function swipe(page: Page, x: number, y: number, dx: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let step = 1; step <= 12; step += 1) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * step) / 12, y }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test.describe('a touch screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  // The hours are a scroll of their own, and a browser reads a touch's
  // touch-action only up to the nearest scroll: the days' pan-y did not
  // reach a swipe that started in the hours (most of a phone's grid), the
  // browser took the pan across, cancelled the pointer, and the days
  // stayed. Out of demo mode, where a swipe loads the next fixture.
  test('a swipe across a paged week turns the days, in the hours as on the day row', async ({ page }) => {
    await page.goto('/?chrome=0');
    await expect(page.locator('.stage')).toBeVisible();
    await page.evaluate(() => window.SwitchboardController!.load('calendar'));
    await expect(page.locator('.scene [data-testid="calendar"]')).toBeVisible();
    await page.waitForTimeout(400);
    const days = () => page.locator('.scene .calendar-grid__weekday').allTextContents();
    expect(await days()).toEqual(['WED', 'THU', 'FRI']);
    // The hours still scroll under a finger: they leave the browser the pan up and down, and no more.
    expect(await page.locator('.scene .calendar-grid__scroll').evaluate((element) => getComputedStyle(element).touchAction)).toBe('pan-y');
    const hours = (await page.locator('.scene .calendar-grid__scroll').boundingBox())!;
    await swipe(page, hours.x + hours.width * 0.75, hours.y + hours.height / 2, -180);
    await expect.poll(days).toEqual(['FRI', 'SAT', 'SUN']);
    const head = (await page.locator('.scene .calendar-grid__head').boundingBox())!;
    await swipe(page, head.x + head.width * 0.25, head.y + 18, 180);
    // A page back from Friday: Tuesday on.
    await expect.poll(days).toEqual(['TUE', 'WED', 'THU']);
    // A swipe is not a tap: focus stayed shut.
    await expect(page.locator('.focus-layer')).toHaveCount(0);
  });

  // review-views L3: on a demo page (?scene=, fixture review and this
  // suite) a swipe loads the next fixture, except where something takes the
  // swipe itself. The list named only the old scrollers, so one swipe in a
  // paged calendar loaded the next fixture (calendar-day), and so did one
  // across a list or a scrolled drawing.
  test('on a demo page a swipe that a calendar, a list or a drawing takes loads no other fixture', async ({ page }) => {
    const fixture = () => page.evaluate(() => document.querySelector('.stage')?.getAttribute('data-scene-kind'));
    await openScene(page, 'calendar');
    await expect(page.locator('.scene [data-testid="calendar"]')).toBeVisible();
    await page.waitForTimeout(400);
    const days = () => page.locator('.scene .calendar-grid__weekday').allTextContents();
    expect(await days()).toEqual(['WED', 'THU', 'FRI']);
    const hours = (await page.locator('.scene .calendar-grid__scroll').boundingBox())!;
    await swipe(page, hours.x + hours.width * 0.75, hours.y + hours.height / 2, -180);
    // The days turned (a positive sign the swipe landed), and the fixture stayed.
    await expect.poll(days).toEqual(['FRI', 'SAT', 'SUN']);
    await page.waitForTimeout(800);
    expect(await days()).toEqual(['FRI', 'SAT', 'SUN']);
    for (const [scene, scroller] of [['tasks', '.list-viewport--scrolling .list-viewport__scroll'], ['topology', '.drawing-viewport--scrolling .drawing-viewport__scroll']] as const) {
      await openScene(page, scene);
      await expect(page.locator(`.scene ${scroller}`).first()).toBeVisible();
      await page.waitForTimeout(400);
      const kind = await fixture();
      const box = (await page.locator(`.scene ${scroller}`).first().boundingBox())!;
      await swipe(page, box.x + box.width * 0.75, box.y + Math.min(box.height / 2, 120), -180);
      // Long enough for a fixture to load: the positive case below loads within it.
      await page.waitForTimeout(800);
      expect(await fixture(), `${scene}: the swipe stayed on ${scene}`).toBe(kind);
      await expect(page.locator(`.scene ${scroller}`).first()).toBeVisible();
    }
    // Elsewhere on the stage a swipe still loads the next fixture.
    await openScene(page, 'idle');
    await page.waitForTimeout(400);
    await swipe(page, 300, 120, -180);
    await expect.poll(fixture, { timeout: 800 }).not.toBe('idle');
  });
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

/** The parts matching `selector` that a box clips, so a reader sees part of one or none of it. */
function partsCut(selector: string) {
  return [...document.querySelectorAll<HTMLElement>(selector)].flatMap((part) => {
    const rect = part.getBoundingClientRect();
    const shown = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    for (let clip = part.parentElement; clip; clip = clip.parentElement) {
      const style = getComputedStyle(clip);
      const box = clip.getBoundingClientRect();
      if (style.overflowX !== 'visible') [shown.left, shown.right] = [Math.max(shown.left, box.left), Math.min(shown.right, box.right)];
      if (style.overflowY !== 'visible') [shown.top, shown.bottom] = [Math.max(shown.top, box.top), Math.min(shown.bottom, box.bottom)];
    }
    const across = Math.max(0, shown.right - shown.left);
    const down = Math.max(0, shown.bottom - shown.top);
    if (across >= rect.width - 0.5 && down >= rect.height - 0.5) return [];
    const name = part.closest('[data-item]')?.getAttribute('data-item') ?? part.textContent?.trim() ?? part.className;
    return [`${name}: ${(rect.width - across).toFixed(1)} x ${(rect.height - down).toFixed(1)} px cut`];
  });
}

// Every calendar on the page: as the primary, in focus, or in an aux cell.
const CALENDAR = '[data-testid="calendar"]';

// A primary beside which the calendar stands in the aux row.
const codePrimary = {
  op: 'show', id: 'source', type: 'code', role: 'primary',
  data: { title: 'SOURCE / ROUTER', file: 'router.rs', source: { language: 'rust', text: 'fn route(call: &Call) -> Leg {\n    Leg::operator()\n}' } },
};

for (const geometry of FRAME_GEOMETRIES) {
  test.describe(`${geometry.name} frame`, () => {
    test.use({ viewport: { width: geometry.width, height: geometry.height } });

    for (const scene of scenes) {
      test(`${scene}: no calendar part crosses its frame's inner box, as the primary, in focus, or beside another primary`, async ({ page }) => {
        await open(page, scene);
        expect(await page.evaluate(frameCrossings, CALENDAR), 'primary').toEqual([]);
        expect(await page.evaluate(partsCut, '.content-main [data-testid="calendar"] .note-badge'), 'primary badge').toEqual([]);
        await runActions(page, [{ op: 'focus', id: 'week' }]);
        await expect(page.locator('.focus-layer [data-testid="calendar"]')).toBeVisible();
        // Past the focus layer's layout transition (0.46 s), and the calendar's measure after it.
        await page.waitForTimeout(700);
        expect(await page.evaluate(frameCrossings, CALENDAR), 'focus').toEqual([]);
        await open(page, scene);
        // The same calendar, sent again beside a code primary.
        const week = await page.evaluate(() => window.SwitchboardController!.state().agentObjects.week.data);
        await runActions(page, [{ op: 'show', id: 'week', type: 'calendar', role: 'secondary', data: week }, codePrimary]);
        await expect(page.locator('.composed-aux-object [data-testid="calendar"]')).toBeVisible();
        await page.waitForTimeout(400);
        expect(await page.evaluate(frameCrossings, CALENDAR), 'aux').toEqual([]);
        // However small its cell, the calendar shows the NOTE badge of the event the rail's note names, whole.
        const auxBadge = '.composed-aux-object [data-testid="calendar"] .note-badge';
        expect(await page.locator(auxBadge).count(), 'aux badge drawn').toBeGreaterThan(0);
        expect(await page.evaluate(partsCut, auxBadge), 'aux badge').toEqual([]);
        if (scene !== 'today') {
          // Alone in the aux row, the calendar asks it for its whole share (two fifths of the column): an inset the row
          // is not asked for shrank a calendar that fills its box, a step at a time, to the cell's floor.
          const share = await page.evaluate(() => {
            const height = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().height;
            return height('.composed-aux') / height('.composed-main');
          });
          expect(share).toBeGreaterThan(0.39);
        }
      });
    }
  });
}

test('the now: its time on a tag in the gutter, and a rule across today\u2019s column only, under the events', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'calendar');
  // Hit-testing finds what is painted on top; the mark takes no pointer, so let it for the question.
  await page.addStyleTag({ content: '.calendar-grid__now, .calendar-grid__now * { pointer-events: auto !important; }' });
  const placed = await page.evaluate(() => {
    const scope = document.querySelector('.scene [data-testid="calendar"]')!;
    const rule = scope.querySelector('.calendar-grid__now-line')!.getBoundingClientRect();
    const tag = scope.querySelector('.calendar-grid__now-text')!.getBoundingClientRect();
    const today = scope.querySelector('.calendar-grid__column--today')!.getBoundingClientRect();
    const first = scope.querySelector('.calendar-grid__column')!.getBoundingClientRect();
    // The standup under way covers the now: the event is drawn over the rule.
    const standup = scope.querySelector('[data-item="standup-wed"]')!.getBoundingClientRect();
    const top = document.elementFromPoint(standup.left + standup.width / 2, rule.top + 0.5);
    return {
      spansToday: Math.abs(rule.left - today.left) <= 1 && Math.abs(rule.right - today.right) <= 1,
      thin: rule.height <= 1.01,
      tagInGutter: tag.left >= first.left - 60 && tag.right <= first.left + 0.5,
      eventOnTop: Boolean(top?.closest('[data-item="standup-wed"]')),
    };
  });
  expect(placed).toEqual({ spansToday: true, thin: true, tagInGutter: true, eventOnTop: true });
});

test('a month of marks at its least rows draws every date, mark, count and badge whole, and is the agenda a pixel shorter', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Rows of 36 px (CalendarPrimitive.tsx MARKS_ROW_PX) under the weekday row, in cells of 48 px (the badge alone on its
  // line) and of 100 px (the badge, three marks and a count): the month is held to that box, and the note's dentist
  // is drawn in the grid, which has no room for a list under it.
  for (const [width, height, layout] of [[336, 198, 'month-marks'], [700, 198, 'month-marks'], [336, 197, 'agenda'], [700, 197, 'agenda']] as const) {
    await open(page, 'calendar-month');
    await page.addStyleTag({ content: `.scene .calendar { width: ${width}px !important; } .scene .calendar__body { flex: none !important; height: ${height}px !important; }` });
    const calendar = page.locator('.scene [data-testid="calendar"]');
    await expect(calendar).toHaveAttribute('data-layout', layout);
    await page.waitForTimeout(300);
    const where = `${width} x ${height}`;
    expect(await page.evaluate(partsCut, '.scene .calendar-month__number, .scene .calendar-marks > *'), where).toEqual([]);
    expect(await calendar.locator('.note-badge').count(), where).toBe(1);
    expect(await page.evaluate(partsCut, '.scene [data-testid="calendar"] .note-badge'), where).toEqual([]);
  }
});

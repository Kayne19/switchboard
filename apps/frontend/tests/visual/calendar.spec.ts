import { expect, test, type Page } from '@playwright/test';
import { GEOMETRIES, openScene, runActions } from './helpers';

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
            widest: Math.round(Math.max(...[...calendar.querySelectorAll<HTMLElement>('*')].filter((node) => node.getClientRects().length > 0 && !node.closest('.drawing-viewport__rim')).map((node) => node.getBoundingClientRect().right))),
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

test('a week in a narrow portrait box pages its columns from today, names the hidden days, and turns on a tap', async ({ page }) => {
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

// Every geometry the visual suites use, the two short landscapes included.
const frameGeometries = [
  ...GEOMETRIES,
  { name: 'landscape-short', width: 844, height: 390 },
  { name: 'landscape-hd', width: 1280, height: 720 },
] as const;

/**
 * Every calendar part that crosses the inner box of the frame it is drawn
 * in, as `role layout: part side +px`. The inner box of a TechFrame is the
 * box inside every run of its outline (inside its steps, at its top right
 * and its bottom left for the panel), read from the frame's own paths as
 * drawn; focus has no frame, so it is the focus box. A part is what shows of
 * it: clipped by every box that clips it on the way up.
 */
function frameCrossings() {
  const runs = (d: string) => {
    const found: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    let [x, y] = [0, 0];
    for (const [, op, args] of d.matchAll(/([MLHV])([^MLHV]*)/g)) {
      const n = args.trim().split(/\s+/).map(Number);
      const [nx, ny] = op === 'H' ? [n[0], y] : op === 'V' ? [x, n[0]] : [n[0], n[1]];
      if (op !== 'M') found.push({ x1: x, y1: y, x2: nx, y2: ny });
      [x, y] = [nx, ny];
    }
    return found;
  };
  const hits: string[] = [];
  for (const calendar of document.querySelectorAll<HTMLElement>('[data-testid="calendar"]')) {
    let owner = calendar.parentElement;
    let frame: SVGSVGElement | null = null;
    while (owner && !owner.classList.contains('focus-layer__content') && !(frame = owner.querySelector<SVGSVGElement>(':scope > svg.tech-frame'))) owner = owner.parentElement;
    if (!owner) continue;
    let inner: { left: number; top: number; right: number; bottom: number };
    if (frame) {
      const box = frame.getBoundingClientRect();
      const view = frame.viewBox.baseVal;
      const all = [...frame.querySelectorAll('path')].flatMap((path) => runs(path.getAttribute('d') ?? ''));
      const across = all.filter((run) => run.y1 === run.y2).map((run) => run.y1);
      const down = all.filter((run) => run.x1 === run.x2).map((run) => run.x1);
      const sx = box.width / view.width;
      const sy = box.height / view.height;
      inner = {
        left: box.left + sx * Math.max(0, ...down.filter((at) => at < view.width / 2)),
        right: box.left + sx * Math.min(view.width, ...down.filter((at) => at > view.width / 2)),
        top: box.top + sy * Math.max(0, ...across.filter((at) => at < view.height / 2)),
        bottom: box.top + sy * Math.min(view.height, ...across.filter((at) => at > view.height / 2)),
      };
    } else {
      const box = owner.getBoundingClientRect();
      const style = getComputedStyle(owner);
      inner = { left: box.left, right: box.right, top: box.top + parseFloat(style.borderTopWidth), bottom: box.bottom };
    }
    const role = frame ? (owner.classList.contains('composed-aux-object') ? 'aux' : 'primary') : 'focus';
    for (const part of [calendar, ...calendar.querySelectorAll<HTMLElement>('*')]) {
      if (part.getClientRects().length === 0 || getComputedStyle(part).visibility === 'hidden') continue;
      const rect = part.getBoundingClientRect();
      const shown = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      for (let clip = part.parentElement; clip && clip !== owner; clip = clip.parentElement) {
        const style = getComputedStyle(clip);
        const box = clip.getBoundingClientRect();
        if (style.overflowX !== 'visible') [shown.left, shown.right] = [Math.max(shown.left, box.left), Math.min(shown.right, box.right)];
        if (style.overflowY !== 'visible') [shown.top, shown.bottom] = [Math.max(shown.top, box.top), Math.min(shown.bottom, box.bottom)];
      }
      if (shown.right - shown.left < 0 || shown.bottom - shown.top < 0 || (shown.right - shown.left < 0.5 && shown.bottom - shown.top < 0.5)) continue;
      const over = { top: inner.top - shown.top, bottom: shown.bottom - inner.bottom, left: inner.left - shown.left, right: shown.right - inner.right };
      for (const [side, by] of Object.entries(over)) {
        if (by > 0.5) hits.push(`${role} ${calendar.dataset.layout}: ${String(part.className).split(' ')[0] || part.tagName} ${side} +${by.toFixed(1)}px`);
      }
    }
  }
  return hits;
}

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

// A primary beside which the calendar stands in the aux row.
const codePrimary = {
  op: 'show', id: 'source', type: 'code', role: 'primary',
  data: { title: 'SOURCE / ROUTER', file: 'router.rs', source: { language: 'rust', text: 'fn route(call: &Call) -> Leg {\n    Leg::operator()\n}' } },
};

for (const geometry of frameGeometries) {
  test.describe(`${geometry.name} frame`, () => {
    test.use({ viewport: { width: geometry.width, height: geometry.height } });

    for (const scene of scenes) {
      test(`${scene}: no calendar part crosses its frame's inner box, as the primary, in focus, or beside another primary`, async ({ page }) => {
        await open(page, scene);
        // On a phone the week, the day and the month take the stage (the rail folds): that stage is measured here.
        if (geometry.name === 'portrait-phone' && scene === 'calendar') await expect(page.locator('[data-stage="primary"]')).toHaveCount(1);
        expect(await page.evaluate(frameCrossings), 'primary').toEqual([]);
        expect(await page.evaluate(partsCut, '.content-main [data-testid="calendar"] .note-badge'), 'primary badge').toEqual([]);
        await runActions(page, [{ op: 'focus', id: 'week' }]);
        await expect(page.locator('.focus-layer [data-testid="calendar"]')).toBeVisible();
        // Past the focus layer's layout transition (0.46 s), and the calendar's measure after it.
        await page.waitForTimeout(700);
        expect(await page.evaluate(frameCrossings), 'focus').toEqual([]);
        await open(page, scene);
        // The same calendar, sent again beside a code primary.
        const week = await page.evaluate(() => window.SwitchboardController!.state().agentObjects.week.data);
        await runActions(page, [{ op: 'show', id: 'week', type: 'calendar', role: 'secondary', data: week }, codePrimary]);
        await expect(page.locator('.composed-aux-object [data-testid="calendar"]')).toBeVisible();
        await page.waitForTimeout(400);
        expect(await page.evaluate(frameCrossings), 'aux').toEqual([]);
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

import { expect, test, type Page } from '@playwright/test';

// The timer and the forecast where jsdom cannot see them: the browser's
// clock, reduced motion, and boxes at every canonical geometry. The page
// clock is pinned (Playwright's clock), so every run reads the same.

const T0 = Date.parse('2026-10-07T16:40:00Z');
// An instant `seconds` from T0, written on the caller's Pacific clock.
const at = (seconds: number) => new Date(T0 + seconds * 1000 - 7 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, '-07:00');

const geometries = [
  { name: 'portrait-phone', width: 390, height: 844 },
  { name: 'portrait-tablet', width: 820, height: 1180 },
  { name: 'landscape', width: 1440, height: 900 },
  { name: 'ultrawide', width: 2560, height: 1080 },
] as const;

async function show(page: Page, actions: unknown[]) {
  await page.evaluate((list) => {
    const controller = window.SwitchboardController;
    if (!controller) throw new Error('controller unavailable');
    controller.run([{ op: 'clear' }, ...list]);
  }, actions);
}

// What a reader would call broken, inside one primitive's box: text under
// the page's floors, text cut by its own box, and parts outside the box.
async function readingFaults(page: Page, selector: string) {
  return page.evaluate((root) => {
    const faults: string[] = [];
    const scope = document.querySelector<HTMLElement>(root);
    if (!scope) return [`no ${root}`];
    const frame = scope.getBoundingClientRect();
    for (const element of scope.querySelectorAll<HTMLElement>('*')) {
      const text = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim());
      if (!text) continue;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      if (box.width === 0 || style.visibility === 'hidden') continue;
      if (parseFloat(style.fontSize) < 7) faults.push(`${element.className}: ${style.fontSize}`);
      // Text cut without an ellipsis to say so.
      if (element.scrollWidth > element.clientWidth + 1 && style.textOverflow !== 'ellipsis' && style.overflow !== 'visible') {
        faults.push(`${element.className}: cut ${element.scrollWidth} > ${element.clientWidth}`);
      }
      // Laid out past the primitive's own box across (a scroll region
      // holds the rest down the box).
      if (box.left < frame.left - 1 || box.right > frame.right + 1) faults.push(`${element.className}: outside ${Math.round(box.left)}..${Math.round(box.right)}`);
    }
    return faults;
  }, selector);
}

test.describe('the page clock', () => {
  test('a countdown moves on the clock, stays when paused, and is done at exactly zero, under reduced motion', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.clock.install({ time: T0 });
    await page.goto('/?scene=idle&chrome=0');
    await page.clock.pauseAt(T0 + 20_000);
    await show(page, [{ op: 'show', id: 'kitchen', type: 'timer', role: 'primary', data: { timers: [
      { id: 'eggs', label: 'Eggs', startedAt: at(0), endsAt: at(23) },
      { id: 'bread', label: 'Bread', startedAt: at(-600), endsAt: at(600), state: 'paused', remaining: 300 },
    ] } }]);
    const digits = (id: string) => page.locator(`[data-item="${id}"] .timer__digits`);
    await expect(digits('eggs')).toHaveText('00:03');
    await page.clock.runFor(1000);
    await expect(digits('eggs')).toHaveText('00:02');
    await page.clock.runFor(2000);
    await expect(digits('eggs')).toHaveText('00:00');
    await expect(page.locator('[data-item="eggs"]')).toHaveAttribute('data-phase', 'done');
    await expect(digits('bread')).toHaveText('05:00');
    await page.clock.runFor(5000);
    await expect(digits('bread')).toHaveText('05:00');
    await expect(page.locator('[data-item="eggs"] .timer__meta')).toHaveText('ENDED 09:40 / +00:05');
  });

  test('the bar sweeps between ticks, and with reduced motion it steps', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.clock.setFixedTime(T0);
    await page.goto('/?scene=timer&chrome=0');
    const fill = page.locator('[data-scene="timer"] [data-item="pasta"] .timer__fill');
    await expect(fill).toBeVisible();
    const sweep = () => fill.evaluate((element) => parseFloat(getComputedStyle(element).transitionDuration));
    await expect.poll(sweep).toBeLessThan(0.01);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(sweep).toBe(1);
  });
});

for (const geometry of geometries) {
  test.describe(geometry.name, () => {
    test.use({ viewport: { width: geometry.width, height: geometry.height } });

    test('the timers read whole: digits inside their cells, text at or above the floors', async ({ page }) => {
      await page.clock.setFixedTime(T0);
      await page.goto('/?scene=timer&chrome=0');
      await expect(page.locator('[data-scene="timer"] [data-testid="timer"]')).toBeVisible();
      expect(await readingFaults(page, '[data-scene="timer"] [data-testid="timer"]')).toEqual([]);
      const done = page.locator('[data-item="tea"]');
      await expect(done).toHaveAttribute('data-phase', 'done');
      await expect(done.locator('.timer__phase')).toHaveText('DONE');
    });

    test('the forecast reads whole, its hour labels apart, its days in line, its marked day named in the rail', async ({ page }) => {
      await page.clock.setFixedTime(T0);
      await page.goto('/?scene=weather&chrome=0');
      const weather = page.locator('[data-scene="weather"] [data-testid="weather"]');
      await expect(weather).toBeVisible();
      await page.waitForTimeout(300);
      expect(await readingFaults(page, '[data-scene="weather"] [data-testid="weather"]')).toEqual([]);
      const geometryOf = await weather.evaluate((root) => {
        const labels = [...root.querySelectorAll<HTMLElement>('.weather-hour__time')].filter((label) => label.textContent).map((label) => {
          const range = document.createRange();
          range.selectNodeContents(label);
          const box = range.getBoundingClientRect();
          return [box.left, box.right];
        });
        const glyphs = [...root.querySelectorAll('.weather-day__glyph')].map((glyph) => Math.round(glyph.getBoundingClientRect().left));
        return { labels, glyphs };
      });
      for (let index = 1; index < geometryOf.labels.length; index += 1) {
        expect(geometryOf.labels[index][0]).toBeGreaterThan(geometryOf.labels[index - 1][1] + 2);
      }
      expect(new Set(geometryOf.glyphs).size).toBe(1);
      await expect(page.locator('[data-item="2026-10-08"] .note-badge')).toHaveCount(1);
      await expect(page.locator('.content-rail .annotation-card__anchor')).toHaveText('TARGET / THU OCT 8');
    });

    test('in focus the forecast and the timers read whole', async ({ page }) => {
      await page.clock.setFixedTime(T0);
      for (const [fixture, id, testid] of [['weather', 'weather', 'weather'], ['timer', 'kitchen', 'timer']] as const) {
        await page.goto(`/?scene=${fixture}&chrome=0`);
        await page.evaluate((target) => window.SwitchboardController!.dispatch({ op: 'focus', id: target }), id);
        const focused = page.locator(`.focus-layer [data-testid="${testid}"]`);
        await expect(focused).toBeVisible();
        await page.waitForTimeout(700);
        expect(await readingFaults(page, `.focus-layer [data-testid="${testid}"]`)).toEqual([]);
      }
    });

    test('in the today scene the forecast is a small slot and reads whole', async ({ page }) => {
      await page.clock.setFixedTime(T0);
      await page.goto('/?scene=today&chrome=0');
      const weather = page.locator('.composed-aux [data-testid="weather"]');
      await expect(weather).toHaveAttribute('data-layout', 'compact');
      expect(await readingFaults(page, '.composed-aux [data-testid="weather"]')).toEqual([]);
    });
  });
}

test('a forecast longer than a phone frame scrolls inside it and says so', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(T0);
  await page.goto('/?scene=weather&chrome=0');
  const scroll = page.locator('[data-scene="weather"] .weather__scroll');
  await expect(scroll).toBeVisible();
  expect(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  // It opens on the day the note names, and the edges it continues past say so.
  await expect(page.locator('[data-item="2026-10-08"]')).toBeInViewport();
  await expect(page.locator('[data-scene="weather"] .list-viewport__rim')).not.toHaveCount(0);
});

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
// the page's floors; text cut by a box that clips it (an ellipsis says so
// and is allowed; a scroll region holds the rest down its length); text
// outside the primitive across; and two texts drawn over each other (the
// edge tag of a scrolled list lies over rows by design and is left out).
async function readingFaults(page: Page, selector: string) {
  return page.evaluate((root) => {
    const faults: string[] = [];
    const scope = document.querySelector<HTMLElement>(root);
    if (!scope) return [`no ${root}`];
    const frame = scope.getBoundingClientRect();
    const texts: Array<{ owner: HTMLElement; box: DOMRect }> = [];
    const name = (element: Element) => `${element.className || element.tagName}`.slice(0, 60);
    for (const element of scope.querySelectorAll<HTMLElement>('*')) {
      const nodes = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim());
      if (nodes.length === 0) continue;
      const style = getComputedStyle(element);
      const own = element.getBoundingClientRect();
      if (own.width <= 1 || own.height <= 1 || style.visibility === 'hidden') continue;
      if (element.closest('.drawing-viewport__rim')) continue;
      if (parseFloat(style.fontSize) < 7) faults.push(`${name(element)}: ${style.fontSize}`);
      for (const node of nodes) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const ellipsis = style.textOverflow === 'ellipsis' && style.overflowX !== 'visible';
        for (const drawn of range.getClientRects()) {
          // Text cut by its own ellipsis is drawn only inside its box; and
          // a line is read within its line box (a large face's content
          // area reaches past it, over the line below, where digits have
          // no descenders).
          const left = ellipsis ? Math.max(drawn.left, own.left) : drawn.left;
          const right = ellipsis ? Math.min(drawn.right, own.right) : drawn.right;
          const top = Math.max(drawn.top, own.top);
          const bottom = Math.min(drawn.bottom, own.bottom);
          const box = new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
          if (box.width < 1) continue;
          texts.push({ owner: element, box });
          if (box.left < frame.left - 1 || box.right > frame.right + 1) faults.push(`${name(element)}: outside across ${Math.round(box.left)}..${Math.round(box.right)}`);
          for (let clip = element as HTMLElement | null; clip && clip !== scope.parentElement; clip = clip.parentElement) {
            const clipStyle = getComputedStyle(clip);
            if (clipStyle.overflowX === 'visible' && clipStyle.overflowY === 'visible') continue;
            const edge = clip.getBoundingClientRect();
            const scrollsDown = clip.scrollHeight > clip.clientHeight + 1 && clipStyle.overflowY !== 'hidden';
            if (!ellipsis && (box.left < edge.left - 1 || box.right > edge.right + 1)) faults.push(`${name(element)}: cut across by ${name(clip)}`);
            if (!scrollsDown && (box.top < edge.top - 1 || box.bottom > edge.bottom + 1)) faults.push(`${name(element)}: cut down by ${name(clip)}`);
          }
        }
      }
    }
    for (let a = 0; a < texts.length; a += 1) {
      for (let b = a + 1; b < texts.length; b += 1) {
        if (texts[a].owner === texts[b].owner || texts[a].owner.contains(texts[b].owner) || texts[b].owner.contains(texts[a].owner)) continue;
        const [p, q] = [texts[a].box, texts[b].box];
        const across = Math.min(p.right, q.right) - Math.max(p.left, q.left);
        const down = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
        if (across > 1 && down > 1) faults.push(`${name(texts[a].owner)} over ${name(texts[b].owner)}`);
      }
    }
    return [...new Set(faults)];
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

    test('a cold forecast in tenths reads whole: the conditions alone, and days below zero', async ({ page }) => {
      await page.clock.setFixedTime(T0);
      await page.goto('/?scene=idle&chrome=0');
      const current = { temp: -12.5, condition: 'snow', summary: 'Blowing snow until the evening', high: -8.5, low: -17.5, feelsLike: -21.5, humidity: 88, wind: 'NE 40 km/h, gusts 70' };
      await show(page, [{ op: 'show', id: 'cold', type: 'weather', role: 'primary', data: { location: 'Tromsø', units: 'C', current } }]);
      await expect(page.locator('[data-scene="weather"] .weather__field')).toHaveAttribute('data-parts', 'now');
      expect(await readingFaults(page, '[data-scene="weather"] [data-testid="weather"]')).toEqual([]);
      const daily = Array.from({ length: 6 }, (_, index) => ({ date: `2026-10-${String(7 + index).padStart(2, '0')}`, high: -8.5 - index, low: -17.5 - index, condition: 'snow', precip: 60 }));
      await show(page, [{ op: 'show', id: 'cold', type: 'weather', role: 'primary', data: { location: 'Tromsø', units: 'C', current, daily } }]);
      await expect(page.locator('[data-scene="weather"] .weather-day')).toHaveCount(6);
      await page.waitForTimeout(200);
      expect(await readingFaults(page, '[data-scene="weather"] [data-testid="weather"]')).toEqual([]);
    });

    test('a forecast in a small slot with its note on an hour reads whole', async ({ page }) => {
      await page.clock.setFixedTime(T0);
      await page.goto('/?scene=today&chrome=0');
      await page.evaluate(() => window.SwitchboardController!.dispatch({
        op: 'show', id: 'dentist-note', type: 'note', data: { tag: 'RAIN', anchor: { target: 'weather', item: '2026-10-08T03:00' }, segments: [{ text: 'Heaviest at 3 am.' }] },
      }));
      const weather = page.locator('.composed-aux [data-testid="weather"]');
      await expect(weather).toHaveAttribute('data-layout', 'compact');
      await page.waitForTimeout(200);
      expect(await readingFaults(page, '.composed-aux [data-testid="weather"]')).toEqual([]);
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

test('on a phone the today scene\'s forecast cell stands the days beside the conditions, each column whole', async ({ page }) => {
  // The cell is about 130px tall: too short for a list under the
  // conditions, which once stood there alone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(T0);
  await page.goto('/?scene=today&chrome=0');
  const weather = page.locator('.composed-aux [data-testid="weather"]');
  await expect(weather).toHaveAttribute('data-layout', 'compact');
  const days = weather.locator('.weather-outlook__day');
  await expect.poll(() => days.count()).toBeGreaterThanOrEqual(3);
  // Today's high and low are the figure's: the row opens on the day after.
  await expect(days.first().locator('.weather-outlook__name')).toHaveText('THU 8');
  const cell = (await weather.boundingBox())!;
  for (const box of await days.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON() as DOMRect))) {
    expect(box.left).toBeGreaterThanOrEqual(cell.x - 1);
    expect(box.right).toBeLessThanOrEqual(cell.x + cell.width + 1);
    expect(box.bottom).toBeLessThanOrEqual(cell.y + cell.height + 1);
  }
  expect(await readingFaults(page, '.composed-aux [data-testid="weather"]')).toEqual([]);
});

test('a forecast cell too short for the outlook\'s columns keeps the conditions alone, uncut', async ({ page }) => {
  // 844x390: the today scene's forecast cell is under 100px tall.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.clock.setFixedTime(T0);
  await page.goto('/?scene=today&chrome=0');
  const weather = page.locator('.composed-aux [data-testid="weather"]');
  await expect(weather).toHaveAttribute('data-layout', 'compact');
  await page.waitForTimeout(200);
  await expect(weather.locator('.weather-outlook')).toHaveCount(0);
  expect(await readingFaults(page, '.composed-aux [data-testid="weather"]')).toEqual([]);
});

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

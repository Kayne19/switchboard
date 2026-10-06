import { expect, test, type Page } from '@playwright/test';
import { FRAME_GEOMETRIES, GEOMETRIES, openScene, runActions } from './helpers';

// At rest nothing on the stage keeps the blur an entrance resolved out of.
// Motion leaves the value it animated to; `blur(0px)` looks like no filter
// but is one, and Chrome drew a box under it through a surface of its own
// or not as its compositor decided from load to load: the portrait list and
// calendar scenes then drew their text a pixel higher or lower between two
// loads with the same layout (ObjectMotion `SHARP`).
const scenes = ['today', 'tasks', 'inbox', 'calendar-agenda', 'weather', 'timer', 'code', 'email', 'architecture', 'composed'];

for (const geometry of GEOMETRIES) {
  test(`no object keeps its entrance blur at rest / ${geometry.name}`, async ({ page }) => {
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    const kept: string[] = [];
    for (const scene of scenes) {
      await openScene(page, scene);
      // Past every entrance (0.42 s at most).
      await page.waitForTimeout(900);
      kept.push(...(await page.evaluate((name) => [...document.querySelectorAll('.stage *')]
        .filter((element) => /blur\(/.test(getComputedStyle(element).filter))
        .map((element) => `${name} ${String(element.getAttribute('class') ?? element.tagName).split(' ').slice(0, 2).join('.')} ${getComputedStyle(element).filter}`), scene)));
    }
    expect(kept).toEqual([]);
  });
}

// No box is drawn at a size it no longer has. Under reduced motion motion
// used to run each layout change as an instant layout animation: the box
// drawn at its old size in the flush after the commit (a frame of it, here a
// source stretched to 1.5 times its new height), at its new size in the next
// frame, with one render asked per timestamp. A next frame within the same
// tick of the clock was never drawn, and the box kept its old size for good:
// beside timers, on a phone, the main column stood at scaleY(0.9825), the
// rail and Damocles with it, in about one load in four under Playwright's
// pinned clock, which reads whole milliseconds as Firefox's and Safari's do
// (Chrome's own 0.1 ms tick made it rare). The page now hands motion no
// layout under reduced motion (hooks/useLayoutMotion.ts), so no projection is
// written at all: these tests watch every style the stage is given while
// timers join it, which fails on every load where a projection is drawn, and
// read the stage at rest.
const T0 = Date.parse('2026-10-07T16:40:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000 - 7 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, '-07:00');
const timers = {
  timers: ['Pasta', 'Bread in the oven', 'Tea', 'Leave for the dentist'].map((label, index) => ({
    id: `t${index}`,
    label,
    ...(index % 2 ? {} : { startedAt: at(-3) }),
    endsAt: at(4 + index * 6),
  })),
};
// What motion's projection writes on a box it moves or resizes.
const PROJECTED = /translate3d|scale\(/;
/** Every projection written on the stage from now on (a frame of one counts), and every one left at rest. */
async function watchProjections(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const written: string[] = [];
    (window as unknown as { projectionsWritten: string[] }).projectionsWritten = written;
    new MutationObserver((records) => {
      for (const record of records) {
        const element = record.target as HTMLElement;
        if (/translate3d|scale\(/.test(element.style.transform)) written.push(`${String(element.getAttribute('class') ?? element.tagName).split(' ').slice(0, 2).join('.')} ${element.style.transform}`);
      }
    }).observe(document.querySelector('.stage')!, { subtree: true, attributes: true, attributeFilter: ['style'] });
  });
  return () => page.evaluate(([pattern]) => [
    ...(window as unknown as { projectionsWritten: string[] }).projectionsWritten.map((box) => `drawn ${box}`),
    ...[...document.querySelectorAll<HTMLElement>('.stage *')].filter((element) => new RegExp(pattern).test(element.style.transform)).map((element) => `at rest ${String(element.getAttribute('class') ?? element.tagName).split(' ').slice(0, 2).join('.')} ${element.style.transform}`),
  ], [PROJECTED.source] as const);
}

test('a source joined by timers is never drawn at a size it no longer has / portrait-phone', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(T0);
  const seen: string[] = [];
  for (let load = 0; load < 5; load += 1) {
    await openScene(page, 'code');
    await page.waitForTimeout(700);
    const read = await watchProjections(page);
    await runActions(page, [{ op: 'show', id: 'kitchen', type: 'timer', role: 'secondary', data: timers }]);
    await page.waitForTimeout(1500);
    seen.push(...(await read()).map((box) => `load ${load}: ${box}`));
  }
  expect(seen).toEqual([]);
});

const fixtures = ['conversation', 'training', 'architecture', 'email', 'code', 'results', 'handoff', 'comparison', 'figure', 'plan', 'composed', 'topology', 'pipeline', 'trace', 'calendar', 'calendar-day', 'calendar-month', 'calendar-agenda', 'tasks', 'timer', 'weather', 'inbox', 'today'];
for (const geometry of FRAME_GEOMETRIES) {
  test(`no box is drawn at a size it no longer has as timers join a scene / ${geometry.name}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    await page.clock.setFixedTime(T0);
    const seen: string[] = [];
    for (const scene of fixtures) {
      await openScene(page, scene);
      await page.waitForTimeout(900);
      const read = await watchProjections(page);
      await runActions(page, [{ op: 'show', id: 'rest-timers', type: 'timer', role: 'secondary', data: timers }]);
      await page.waitForTimeout(1200);
      seen.push(...(await read()).map((box) => `${scene}: ${box}`));
    }
    expect(seen).toEqual([]);
  });
}

import { expect, test } from '@playwright/test';
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

// At rest no box keeps a layout projection. Under reduced motion motion used
// to run each layout change as an instant layout animation: the box drawn at
// its old size in the flush after the commit, at its new size in the next
// frame, with one render asked per timestamp. A next frame within the same
// tick of the clock was never drawn, and the box kept its old size for good:
// beside timers, on a phone, the main column stood at scaleY(0.9825), the
// rail and Damocles with it, in about one load in four. The page now hands
// motion no layout under reduced motion (hooks/useLayoutMotion.ts). The
// clock is pinned: Playwright's then reads whole milliseconds, as Firefox's
// and Safari's do, which is what makes the race likely (Chrome's own 0.1 ms
// tick made it rare, so without the pin this test could not fail).
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
// What motion's projection writes on a box it has moved or resized.
const projected = () => [...document.querySelectorAll<HTMLElement>('.stage *')]
  .filter((element) => /translate3d|scale\(/.test(element.style.transform))
  .map((element) => `${String(element.getAttribute('class') ?? element.tagName).split(' ').slice(0, 2).join('.')} ${element.style.transform}`);

test('a source with timers beside it comes to rest at its own size, load after load / portrait-phone', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(T0);
  const kept: string[] = [];
  for (let load = 0; load < 20; load += 1) {
    await openScene(page, 'code');
    const code = await page.evaluate(() => Object.values(window.SwitchboardController.state().agentObjects).find((object) => object.type === 'code')!.data);
    await runActions(page, [{ op: 'clear' }, { op: 'show', id: 'source', type: 'code', role: 'primary', data: code }, { op: 'show', id: 'kitchen', type: 'timer', role: 'secondary', data: timers }]);
    await page.waitForTimeout(1500);
    kept.push(...(await page.evaluate(projected)).map((box) => `load ${load}: ${box}`));
  }
  expect(kept).toEqual([]);
});

const fixtures = ['conversation', 'training', 'architecture', 'email', 'code', 'results', 'handoff', 'comparison', 'figure', 'plan', 'composed', 'topology', 'pipeline', 'trace', 'calendar', 'calendar-day', 'calendar-month', 'calendar-agenda', 'tasks', 'timer', 'weather', 'inbox', 'today'];
for (const geometry of FRAME_GEOMETRIES) {
  test(`no box keeps a layout projection once timers join a scene / ${geometry.name}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    await page.clock.setFixedTime(T0);
    const kept: string[] = [];
    for (const scene of fixtures) {
      await openScene(page, scene);
      await page.waitForTimeout(900);
      await runActions(page, [{ op: 'show', id: 'rest-timers', type: 'timer', role: 'secondary', data: timers }]);
      await page.waitForTimeout(1200);
      kept.push(...(await page.evaluate(projected)).map((box) => `${scene}: ${box}`));
    }
    expect(kept).toEqual([]);
  });
}

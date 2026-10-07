import { expect, test } from '@playwright/test';
import { GEOMETRIES } from './helpers';

// The pixel goldens: each canonical scene as the stage draws it, at the four
// golden geometries, against the images in apps/frontend/reference/golden.
// Every test here is tagged @golden: CI's browser job leaves them out (the
// runner's fonts raster differently from the dev box they were drawn on),
// so `npm run test:visual` runs them before a change that moves pixels.

const GOLDEN = { tag: '@golden' } as const;

const scenes = ['idle', 'conversation', 'training', 'architecture', 'email', 'code'] as const;

/**
 * The later scenes, each by the composition it draws as (its stage's
 * data-scene): the calendar's four views, the to-do list, the
 * inbox, the forecast, the timers, a table, a sequence diagram and the
 * composed morning briefing.
 */
const assistantScenes = [
  ['calendar', 'calendar'],
  ['calendar-day', 'calendar'],
  ['calendar-month', 'calendar'],
  ['calendar-agenda', 'calendar'],
  ['tasks', 'tasks'],
  ['inbox', 'inbox'],
  ['weather', 'weather'],
  ['timer', 'timer'],
  ['results', 'table'],
  ['handoff', 'architecture'],
  ['today', 'calendar'],
] as const;

// The timers count down against the page clock from the moment the fixture
// loads; with the clock held still they read the same on every run. The
// fixture's "now" is this moment too.
const CLOCK = Date.parse('2026-10-07T09:40:00-07:00');

for (const geometry of GEOMETRIES) {
  test.describe(geometry.name, GOLDEN, () => {
    test.use({ viewport: { width: geometry.width, height: geometry.height } });
    for (const scene of scenes) {
      test(`${scene} remains visually locked`, async ({ page }) => {
        await page.goto(`/?scene=${scene}&chrome=0`);
        await page.waitForSelector(`[data-scene="${scene === 'email' ? 'document' : scene}"]`, { state: 'visible' });
        await page.evaluate(() => document.body.classList.add('presentation-mode'));
        await expect(page.locator('.stage')).toHaveScreenshot(`${geometry.name}-${scene}.png`, {
          animations: 'disabled',
          caret: 'hide',
          maxDiffPixelRatio: 0.008,
        });
      });
    }

    for (const [scene, drawnAs] of assistantScenes) {
      test(`${scene} remains visually locked`, async ({ page }) => {
        await page.clock.setFixedTime(CLOCK);
        await page.goto(`/?scene=${scene}&chrome=0`);
        await page.waitForSelector(`[data-scene="${drawnAs}"]`, { state: 'visible' });
        await page.evaluate(() => document.body.classList.add('presentation-mode'));
        await expect(page.locator('.stage')).toHaveScreenshot(`${geometry.name}-${scene}.png`, {
          animations: 'disabled',
          caret: 'hide',
          maxDiffPixelRatio: 0.008,
        });
      });
    }
  });
}

test('primary metric remains visually locked', GOLDEN, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?scene=architecture&chrome=0');
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'latency', type: 'metric', role: 'primary',
      data: {
        label: 'P95 LATENCY', value: '182 ms', semantic: 'cyan',
        caption: 'EDGE / LAST 5 MIN',
      },
    });
  });
  await expect(page.locator('[data-scene="composed"]')).toBeVisible();
  await expect(page.locator('.stage')).toHaveScreenshot('landscape-primary-metric.png', {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixelRatio: 0.008,
  });
});


for (const geometry of GEOMETRIES) {
  test(`composed scene / ${geometry.name}`, GOLDEN, async ({ page }) => {
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    await page.goto('/?scene=architecture&chrome=0');
    await page.waitForSelector('[data-testid="diagram"]', { state: 'visible' });
    await page.evaluate(() => {
      const dispatch = window.SwitchboardController?.dispatch;
      if (!dispatch) throw new Error('controller unavailable');
      dispatch({ op: 'clear' });
      dispatch({ op: 'show', id: 'composed-diagram', type: 'diagram', role: 'primary', data: {
        mode: 'graph', title: 'COMPOSED / SYSTEM FLOW', nodes: [{ id: 'input', label: 'INPUT' }, { id: 'active', label: 'ACTIVE', state: 'active' }, { id: 'output', label: 'OUTPUT' }], edges: [{ from: 'input', to: 'active', label: 'route' }, { from: 'active', to: 'output', label: 'emit' }]
      }});
      dispatch({ op: 'show', id: 'composed-note', type: 'note', role: 'secondary', data: { tag: 'COMPOSED', segments: [{ text: 'Active path highlighted.' }] } });
      dispatch({ op: 'show', id: 'composed-metric', type: 'metric', role: 'secondary', data: { label: 'THROUGHPUT', value: '98.4%' } });
    });
    await page.waitForTimeout(100);
    await expect(page.locator('.stage')).toHaveScreenshot(`${geometry.name}-composed.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.008 });
  });
}

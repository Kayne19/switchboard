import { expect, test } from '@playwright/test';
import { GEOMETRIES } from './helpers';

const scenes = ['idle', 'conversation', 'training', 'architecture', 'email', 'code'] as const;

for (const geometry of GEOMETRIES) {
  test.describe(geometry.name, () => {
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
  });
}

test('primary metric remains visually locked', async ({ page }) => {
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
  test(`composed scene / ${geometry.name}`, async ({ page }) => {
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

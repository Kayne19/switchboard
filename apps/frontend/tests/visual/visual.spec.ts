import { expect, test } from '@playwright/test';

const scenes = ['idle', 'conversation', 'training', 'architecture', 'email', 'code'] as const;
const geometries = [
  { name: 'portrait-phone', width: 390, height: 844 },
  { name: 'portrait-tablet', width: 820, height: 1180 },
  { name: 'landscape', width: 1440, height: 900 },
  { name: 'ultrawide', width: 2560, height: 1080 },
] as const;

for (const geometry of geometries) {
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


for (const geometry of geometries) {
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
      dispatch({ op: 'show', id: 'composed-metric', type: 'metric', role: 'ambient', data: { label: 'THROUGHPUT', value: '98.4%' } });
    });
    await page.waitForTimeout(100);
    await expect(page.locator('.stage')).toHaveScreenshot(`${geometry.name}-composed.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.008 });
  });
}

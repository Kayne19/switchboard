import { expect, test } from '@playwright/test';

test.describe('Primary metric cluster layout and behavior (#38)', () => {
  test('renders 2 primary metrics as a 2-column grid in landscape', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/?scene=architecture&chrome=0');
    await page.waitForSelector('[data-scene]');

    await page.evaluate(() => {
      const dispatch = window.SwitchboardController?.dispatch;
      if (!dispatch) return;
      dispatch({ op: 'clear' });
      dispatch({
        op: 'show', id: 'm1', type: 'metric', role: 'primary',
        data: { label: 'CPU LOAD', value: '38%', semantic: 'cyan' },
      });
      dispatch({
        op: 'show', id: 'm2', type: 'metric', role: 'primary',
        data: { label: 'MEM USAGE', value: '72%', semantic: 'orange' },
      });
      dispatch({
        op: 'show', id: 'm-rail', type: 'metric', role: 'secondary',
        data: { label: 'DISK IO', value: '45 MB/s' },
      });
    });

    const cluster = page.locator('.composed-primary-object--cluster .metrics--primary');
    await expect(cluster).toBeVisible();
    await expect(cluster).toHaveAttribute('data-count', '2');

    // Main area has 2 metric rows
    const mainRows = cluster.locator('.metric-row');
    await expect(mainRows).toHaveCount(2);

    // Rail has 1 metric row (non-primary metric stays in rail)
    const railMetrics = page.locator('.content-rail__details .metrics .metric-row');
    await expect(railMetrics).toHaveCount(1);
    await expect(railMetrics.locator('.metric-row__label')).toHaveText('DISK IO');

    // In landscape, 2 metrics are side-by-side (2 columns)
    const box1 = await mainRows.nth(0).boundingBox();
    const box2 = await mainRows.nth(1).boundingBox();
    expect(box1).not.toBeNull();
    expect(box2).not.toBeNull();
    if (box1 && box2) {
      // Side by side: box2 is to the right of box1, approximately same top Y
      expect(box2.x).toBeGreaterThan(box1.x);
      expect(Math.abs(box2.y - box1.y)).toBeLessThan(10);
    }
  });

  test('recomposes 2 primary metrics vertically in portrait', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 860 });
    await page.goto('/?scene=architecture&chrome=0');
    await page.waitForSelector('[data-scene]');

    await page.evaluate(() => {
      const dispatch = window.SwitchboardController?.dispatch;
      if (!dispatch) return;
      dispatch({ op: 'clear' });
      dispatch({
        op: 'show', id: 'm1', type: 'metric', role: 'primary',
        data: { label: 'CPU LOAD', value: '38%', semantic: 'cyan' },
      });
      dispatch({
        op: 'show', id: 'm2', type: 'metric', role: 'primary',
        data: { label: 'MEM USAGE', value: '72%', semantic: 'orange' },
      });
    });

    const cluster = page.locator('.composed-primary-object--cluster .metrics--primary');
    await expect(cluster).toBeVisible();

    const mainRows = cluster.locator('.metric-row');
    await expect(mainRows).toHaveCount(2);

    // In portrait, 2 metrics stack vertically (1 column)
    const box1 = await mainRows.nth(0).boundingBox();
    const box2 = await mainRows.nth(1).boundingBox();
    expect(box1).not.toBeNull();
    expect(box2).not.toBeNull();
    if (box1 && box2) {
      expect(box2.y).toBeGreaterThan(box1.y);
      expect(Math.abs(box2.x - box1.x)).toBeLessThan(10);
    }
  });

  test('renders 3 primary metrics as 3 columns in landscape and 1 column in portrait', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/?scene=architecture&chrome=0');
    await page.waitForSelector('[data-scene]');

    await page.evaluate(() => {
      const dispatch = window.SwitchboardController?.dispatch;
      if (!dispatch) return;
      dispatch({ op: 'clear' });
      dispatch({
        op: 'show', id: 'm1', type: 'metric', role: 'primary',
        data: { label: 'CPU', value: '40%' },
      });
      dispatch({
        op: 'show', id: 'm2', type: 'metric', role: 'primary',
        data: { label: 'MEM', value: '60%' },
      });
      dispatch({
        op: 'show', id: 'm3', type: 'metric', role: 'primary',
        data: { label: 'GPU', value: '80%' },
      });
    });

    const cluster = page.locator('.composed-primary-object--cluster .metrics--primary');
    await expect(cluster).toBeVisible();
    await expect(cluster).toHaveAttribute('data-count', '3');

    const mainRows = cluster.locator('.metric-row');
    await expect(mainRows).toHaveCount(3);

    // Landscape: 3 across
    const box1 = await mainRows.nth(0).boundingBox();
    const box2 = await mainRows.nth(1).boundingBox();
    const box3 = await mainRows.nth(2).boundingBox();
    if (box1 && box2 && box3) {
      expect(box2.x).toBeGreaterThan(box1.x);
      expect(box3.x).toBeGreaterThan(box2.x);
    }

    // Switch to portrait
    await page.setViewportSize({ width: 420, height: 860 });
    await page.waitForTimeout(100);

    const pBox1 = await mainRows.nth(0).boundingBox();
    const pBox2 = await mainRows.nth(1).boundingBox();
    const pBox3 = await mainRows.nth(2).boundingBox();
    if (pBox1 && pBox2 && pBox3) {
      expect(pBox2.y).toBeGreaterThan(pBox1.y);
      expect(pBox3.y).toBeGreaterThan(pBox2.y);
    }
  });

  test('clicking an individual metric in the cluster activates focus layer on that metric', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/?scene=architecture&chrome=0');
    await page.waitForSelector('[data-scene]');

    await page.evaluate(() => {
      const dispatch = window.SwitchboardController?.dispatch;
      if (!dispatch) return;
      dispatch({ op: 'clear' });
      dispatch({
        op: 'show', id: 'm1', type: 'metric', role: 'primary',
        data: { label: 'CPU', value: '40%' },
      });
      dispatch({
        op: 'show', id: 'm2', type: 'metric', role: 'primary',
        data: { label: 'MEM', value: '60%' },
      });
    });

    const cluster = page.locator('.composed-primary-object--cluster .metrics--primary');
    const mainRows = cluster.locator('.metric-row');

    // Click second metric (m2)
    await mainRows.nth(1).click();

    // Focus layer should appear with MEM metric
    const focusLayer = page.locator('.focus-layer');
    await expect(focusLayer).toBeVisible();
    await expect(focusLayer.locator('.metric-row__label')).toHaveText('MEM');
    await expect(focusLayer.locator('.metric-row__value')).toHaveText('60%');
  });

  for (const geometry of [
    { name: 'portrait-phone', width: 390, height: 844 },
    { name: 'landscape-phone', width: 844, height: 390 },
    { name: 'small-landscape', width: 1024, height: 600 },
    { name: 'landscape', width: 1440, height: 900 },
    { name: 'ultrawide', width: 2560, height: 1080 },
    { name: 'portrait-tablet', width: 820, height: 1180 },
  ]) {
    test(`eight primary metrics all show in the cluster, none truncated (${geometry.name})`, async ({ page }) => {
      // Live feedback on #38: eight metrics sent as primary showed only six.
      await page.setViewportSize({ width: geometry.width, height: geometry.height });
      await page.goto('/?scene=architecture&chrome=0');
      await page.waitForSelector('[data-scene]');

      await page.evaluate(() => {
        const dispatch = window.SwitchboardController?.dispatch;
        if (!dispatch) throw new Error('controller unavailable');
        dispatch({ op: 'clear' });
        for (let n = 0; n < 8; n += 1) {
          dispatch({
            op: 'show', id: `m${n}`, type: 'metric', role: 'primary',
            data: { label: `METRIC ${n}`, value: `01:42:1${n}` },
          });
        }
      });

      await expect(page.locator('.composed-primary-object--cluster .metric-row')).toHaveCount(8);
      await expect(page.locator('.content-rail__details .metrics')).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => {
        const main = document.querySelector('.content-main')!.getBoundingClientRect();
        const rows = [...document.querySelectorAll('.composed-primary-object--cluster .metric-row')];
        return {
          spilled: rows.map((row) => row.getBoundingClientRect())
            .filter((row) => row.top < main.top - 0.5 || row.bottom > main.bottom + 0.5 || row.right > main.right + 0.5).length,
          truncated: rows.map((row) => row.querySelector<HTMLElement>('.metric-row__value')!)
            .filter((value) => value.scrollWidth > value.clientWidth + 1).length,
        };
      })).toEqual({ spilled: 0, truncated: 0 });
    });
  }

  for (const geometry of [
    { name: 'portrait-phone', width: 390, height: 844 },
    { name: 'landscape-phone', width: 844, height: 390 },
    { name: 'small-landscape', width: 1024, height: 600 },
  ]) {
    test(`a claim past the cluster cap never spills the cluster out of the main column (${geometry.name})`, async ({ page }) => {
      await page.setViewportSize({ width: geometry.width, height: geometry.height });
      await page.goto('/?scene=architecture&chrome=0');
      await page.waitForSelector('[data-scene]');

      await page.evaluate(() => {
        const dispatch = window.SwitchboardController?.dispatch;
        if (!dispatch) throw new Error('controller unavailable');
        dispatch({ op: 'clear' });
        // One past the cap of nine.
        for (let n = 0; n < 10; n += 1) {
          dispatch({
            op: 'show', id: `m${n}`, type: 'metric', role: 'primary',
            data: { label: `METRIC ${n}`, value: `${n * 7}%` },
          });
        }
      });

      const mainRows = page.locator('.composed-primary-object--cluster .metric-row');
      await expect(mainRows).toHaveCount(9);
      // The earliest claim gave way and moved to the rail.
      const railMetrics = page.locator('.content-rail__details .metrics .metric-row');
      await expect(railMetrics).toHaveCount(1);
      await expect(railMetrics.locator('.metric-row__label')).toHaveText('METRIC 0');

      // Rows outside the main column are clipped: count them once layout settles.
      await expect.poll(() => page.evaluate(() => {
        const main = document.querySelector('.content-main')!.getBoundingClientRect();
        return [...document.querySelectorAll('.composed-primary-object--cluster .metric-row')]
          .map((row) => row.getBoundingClientRect())
          .filter((row) => row.bottom > main.bottom + 0.5 || row.right > main.right + 0.5).length;
      })).toBe(0);
    });
  }
});

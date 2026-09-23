import { expect, test, type Page } from '@playwright/test';
import { DisplayFixtureServer } from '../integration/display-fixture-server.mjs';

async function openController(page: Page) {
  await page.goto('/?scene=architecture&chrome=0');
  await expect(page.locator('.stage')).toBeVisible();
}

async function showSecondaryMetricAndNote(page: Page, order: 'metric-first' | 'note-first') {
  await page.evaluate((requestedOrder) => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'quality-map', type: 'diagram', role: 'primary',
      data: {
        mode: 'graph', title: 'QUALITY PATH',
        nodes: [{ id: 'sample', label: 'SAMPLE' }, { id: 'score', label: 'SCORE' }],
        edges: [{ from: 'sample', to: 'score' }],
      },
    });
    const metric = {
      op: 'show', id: 'quality', type: 'metric', role: 'secondary',
      data: { label: 'QUALITY', value: '98.4%', semantic: 'green', caption: 'MODEL / HOLDOUT' },
    };
    const note = {
      op: 'show', id: 'quality-note', type: 'note', role: 'secondary',
      data: {
        tag: 'OBSERVATION',
        segments: [{ text: 'Quality remains above the release threshold.' }],
        anchor: { target: 'quality' },
      },
    };
    for (const action of requestedOrder === 'metric-first' ? [metric, note] : [note, metric]) {
      dispatch(action);
    }
  }, order);
  await expect(page.locator('[data-scene="architecture"]')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByText('98.4%', { exact: true })).toBeVisible();
  await expect(page.getByText('Quality remains above the release threshold.', { exact: true })).toHaveCount(1);
}

test('secondary metric and note compose in either action order without oversized metric allocation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);

  for (const order of ['metric-first', 'note-first'] as const) {
    await showSecondaryMetricAndNote(page, order);
    const geometry = await page.evaluate(() => {
      const metric = document.querySelector<HTMLElement>('.metric-row')!;
      const note = document.querySelector<HTMLElement>('.annotation-card')!;
      const main = document.querySelector<HTMLElement>('.content-main')!;
      const rail = document.querySelector<HTMLElement>('.content-rail')!;
      const metricBox = metric.getBoundingClientRect();
      const noteBox = note.getBoundingClientRect();
      return {
        metricHeight: metricBox.height,
        mainHeight: main.getBoundingClientRect().height,
        railHeight: rail.getBoundingClientRect().height,
        overlap: !(
          metricBox.right <= noteBox.left
          || noteBox.right <= metricBox.left
          || metricBox.bottom <= noteBox.top
          || noteBox.bottom <= metricBox.top
        ),
      };
    });
    expect(geometry.overlap, order).toBe(false);
    expect(geometry.metricHeight, order).toBeLessThan(geometry.railHeight * 0.55);
    expect(geometry.metricHeight, order).toBeLessThan(geometry.mainHeight * 0.55);
  }
});

test('primary metric is a compact angular card and uses its configured caption', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'latency', type: 'metric', role: 'primary',
      data: { label: 'P95 LATENCY', value: '182 ms', semantic: 'cyan', caption: 'EDGE / LAST 5 MIN' },
    });
  });

  const metric = page.locator('.metrics--primary .metric-row');
  await expect(metric).toBeVisible();
  await expect(page.locator('.scene-footer span').last()).toHaveText('EDGE / LAST 5 MIN');
  const style = await metric.evaluate((element) => {
    const metricBox = element.getBoundingClientRect();
    const mainBox = document.querySelector<HTMLElement>('.content-main')!.getBoundingClientRect();
    return {
      clipPath: getComputedStyle(element).clipPath,
      metricHeight: metricBox.height,
      mainHeight: mainBox.height,
    };
  });
  expect(style.clipPath).toContain('polygon');
  expect(style.metricHeight).toBeLessThan(style.mainHeight * 0.55);
});

test('progress fill width matches its numeric value', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'deploy-progress', type: 'progress', role: 'primary',
      data: { label: 'DEPLOY', value: 0.65, text: '65% COMPLETE' },
    });
  });

  await expect.poll(() => page.locator('.progress-primitive').evaluate((element) => {
    const track = element.querySelector<HTMLElement>('.progress-primitive__track')!;
    const fill = element.querySelector<HTMLElement>('.progress-primitive__fill')!;
    return fill.getBoundingClientRect().width / track.getBoundingClientRect().width;
  })).toBeCloseTo(0.65, 2);
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '65');
});

test('explicit anchored note survives later chat messages', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 5 });
  const { wsUrl } = await fixtureServer.start();

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
    fixtureServer.broadcast({
      type: 'display',
      action: {
        op: 'show', id: 'loss', type: 'chart', role: 'primary',
        data: {
          title: 'Validation loss', xMax: 40, yMin: 0, yMax: 1,
          series: [{ name: 'VAL LOSS', values: [0.8, 0.5, 0.3, 0.45] }],
        },
      },
    });
    fixtureServer.broadcast({
      type: 'display',
      action: {
        op: 'show', id: 'spike-note', type: 'note', role: 'secondary',
        data: {
          tag: 'LOOK HERE',
          segments: [{ text: 'This annotation stays attached to the validation spike.' }],
          anchor: { target: 'loss', x: 32, series: 'VAL LOSS' },
        },
      },
    });

    const note = page.locator('.training-note .annotation-card');
    await expect(note).toHaveAttribute('data-anchor-target', 'loss');
    await expect(note).toContainText('This annotation stays attached to the validation spike.');
    await expect(page.locator('.training-note')).toHaveClass(/training-note--anchored/);
    const noteOverflow = await note.locator('.annotation-card__text').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(noteOverflow.scrollWidth).toBeLessThanOrEqual(noteOverflow.clientWidth + 1);

    fixtureServer.broadcast({ type: 'spoken', entry: { role: 'agent', text: 'A newer chat response.', id: 'reply-2' } });
    await expect(note).toContainText('This annotation stays attached to the validation spike.');
    await expect(note).not.toContainText('A newer chat response.');
    await expect(note.locator('.annotation-card__history')).toHaveCount(0);
  } finally {
    await fixtureServer.stop();
  }
});

test('long current response scrolls above configurable lower-right caption', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 6 });
  const { wsUrl } = await fixtureServer.start();
  const reply = Array.from({ length: 18 }, (_, index) => `Response paragraph ${index + 1} remains readable.`).join('\n\n');

  try {
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
    fixtureServer.broadcast({
      type: 'spoken',
      entry: { role: 'agent', text: reply, id: 'reply-long', caption: 'MODEL / REVIEWER' },
    });

    const response = page.locator('.conversation-answer__text');
    const caption = page.locator('.conversation-answer__index');
    await expect(response).toBeVisible();
    await expect(caption).toHaveText('MODEL / REVIEWER');
    const geometry = await response.evaluate((element) => {
      const responseBox = element.getBoundingClientRect();
      const captionBox = document.querySelector<HTMLElement>('.conversation-answer__index')!.getBoundingClientRect();
      return {
        overflowY: getComputedStyle(element).overflowY,
        scrollable: element.scrollHeight > element.clientHeight,
        separated: responseBox.bottom <= captionBox.top,
      };
    });
    expect(geometry).toEqual({ overflowY: 'auto', scrollable: true, separated: true });
  } finally {
    await fixtureServer.stop();
  }
});



test('progress value sent as a percentage fills the matching width', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'deploy-progress-pct', type: 'progress', role: 'primary',
      data: { label: 'DEPLOY', value: 65, text: '65% COMPLETE' },
    });
  });

  await expect.poll(() => page.locator('.progress-primitive').evaluate((element) => {
    const track = element.querySelector<HTMLElement>('.progress-primitive__track')!;
    const fill = element.querySelector<HTMLElement>('.progress-primitive__fill')!;
    return fill.getBoundingClientRect().width / track.getBoundingClientRect().width;
  })).toBeCloseTo(0.65, 2);
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '65');
});

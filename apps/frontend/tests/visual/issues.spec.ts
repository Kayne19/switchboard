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

// A value is a percentage, so `1` is one percent, never a full bar (#33).
test('progress value of 1 fills one percent, not the whole bar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'deploy-progress', type: 'progress', role: 'primary',
      data: { label: 'DEPLOY', value: 1 },
    });
  });

  await expect.poll(() => page.locator('.progress-primitive').evaluate((element) => {
    const track = element.querySelector<HTMLElement>('.progress-primitive__track')!;
    const fill = element.querySelector<HTMLElement>('.progress-primitive__fill')!;
    return fill.getBoundingClientRect().width / track.getBoundingClientRect().width;
  })).toBeCloseTo(0.01, 2);
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  await expect(page.locator('.progress-primitive__text')).toHaveText('1% COMPLETE');
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

    const note = page.locator('.chart-note .annotation-card');
    await expect(note).toHaveAttribute('data-anchor-target', 'loss');
    await expect(note).toContainText('This annotation stays attached to the validation spike.');
    await expect(page.locator('.chart-note')).toHaveClass(/chart-note--anchored/);
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

// #49 and #26: every note on a chart is shown over the plot, clear of the
// others, and the chart keeps its size for them; a note that names a point
// runs its leader out of its card's border.
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 2560, height: 1080 }]) {
  test(`every note on a chart shows over it without covering another at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/?scene=training&chrome=0');
    await expect(page.locator('.chart-note')).toHaveCount(1);
    const chartBox = async () => page.locator('.chart-object[data-chart-id="loss"] .chart-primitive > svg').evaluate((svg) => {
      const box = svg.getBoundingClientRect();
      return { width: box.width, height: box.height };
    });
    const before = await chartBox();

    await page.evaluate(() => {
      const dispatch = window.SwitchboardController?.dispatch;
      if (!dispatch) throw new Error('controller unavailable');
      dispatch({
        op: 'show', id: 'general-note', type: 'note',
        data: { tag: 'NOTE / GENERAL', segments: [{ text: 'A second note that names no point. It must still be on screen.' }] },
      });
      dispatch({
        op: 'show', id: 'early-note', type: 'note',
        data: {
          tag: 'EARLY / EPOCH 6', anchor: { target: 'loss', x: 6, series: 'TRAIN LOSS' },
          segments: [{ text: 'Both losses fall together through the warmup.' }],
        },
      });
    });
    await expect(page.locator('.chart-note')).toHaveCount(3);
    await page.waitForTimeout(400);
    expect(await chartBox()).toEqual(before);

    const geometry = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.chart-object[data-chart-id="loss"]')!.getBoundingClientRect();
      const layer = document.querySelector<HTMLElement>('.chart-notes')!.getBoundingClientRect();
      const cards = [...document.querySelectorAll<HTMLElement>('.chart-note')].map((element) => {
        const box = element.getBoundingClientRect();
        return { id: element.dataset.note!, left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      });
      const leaders = [...document.querySelectorAll<SVGGElement>('.chart-note-leader')].map((group) => ({
        id: group.dataset.note!,
        points: group.querySelector('polyline')!.getAttribute('points')!.split(' ').map((pair) => {
          const [x, y] = pair.split(',').map(Number);
          return { x: layer.left + x, y: layer.top + y };
        }),
      }));
      return { panel: { left: panel.left, top: panel.top, right: panel.right, bottom: panel.bottom }, cards, leaders };
    });

    for (const [index, card] of geometry.cards.entries()) {
      expect(card.left).toBeGreaterThanOrEqual(geometry.panel.left - 1);
      expect(card.right).toBeLessThanOrEqual(geometry.panel.right + 1);
      expect(card.top).toBeGreaterThanOrEqual(geometry.panel.top - 1);
      expect(card.bottom).toBeLessThanOrEqual(geometry.panel.bottom + 1);
      for (const other of geometry.cards.slice(index + 1)) {
        const apart = card.right <= other.left + 0.5 || other.right <= card.left + 0.5 || card.bottom <= other.top + 0.5 || other.bottom <= card.top + 0.5;
        expect(apart, `${card.id} and ${other.id} must not overlap`).toBe(true);
      }
    }
    expect(geometry.leaders.map((leader) => leader.id).sort()).toEqual(['early-note', 'training-note']);
    for (const leader of geometry.leaders) {
      const card = geometry.cards.find((candidate) => candidate.id === leader.id)!;
      const start = leader.points[0];
      // It begins on the card's bottom or top border.
      const onEdge = Math.abs(start.y - (card.bottom - 0.5)) <= 1 || Math.abs(start.y - (card.top + 0.5)) <= 1;
      expect(onEdge, `${leader.id} leader starts on its card's border`).toBe(true);
      expect(start.x).toBeGreaterThanOrEqual(card.left);
      expect(start.x).toBeLessThanOrEqual(card.right);
    }
  });
}

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


test('long caption cannot grow into the response text at minimum box height', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 9 });
  const { wsUrl } = await fixtureServer.start();
  const reply = Array.from({ length: 18 }, (_, index) => `Response paragraph ${index + 1} remains readable.`).join('\n\n');

  try {
    await page.setViewportSize({ width: 1440, height: 420 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
    fixtureServer.broadcast({
      type: 'spoken',
      entry: { role: 'agent', text: reply, id: 'reply-long', caption: 'MODEL / GPT OPENAI-CODEX / PROJECT / BAY-2 / REVIEWER' },
    });

    const response = page.locator('.conversation-answer__text');
    const caption = page.locator('.conversation-answer__index');
    await expect(response).toBeVisible();
    const geometry = await response.evaluate((element) => {
      const responseBox = element.getBoundingClientRect();
      const captionBox = document.querySelector<HTMLElement>('.conversation-answer__index')!.getBoundingClientRect();
      return {
        overflowY: getComputedStyle(element).overflowY,
        scrollable: element.scrollHeight > element.clientHeight,
        separated: responseBox.bottom <= captionBox.top + 1,
        captionLines: Math.round(captionBox.height / Math.max(1, parseFloat(getComputedStyle(document.querySelector<HTMLElement>('.conversation-answer__index')!).lineHeight))),
      };
    });
    expect(geometry).toEqual({ overflowY: 'auto', scrollable: true, separated: true, captionLines: 1 });
  } finally {
    await fixtureServer.stop();
  }
});

test('long metric labels and values stay on one line and clear of each other', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'map', type: 'diagram', role: 'primary',
      data: {
        mode: 'graph', title: 'SYSTEM MAP',
        nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        edges: [{ from: 'a', to: 'b' }],
      },
    });
    dispatch({
      op: 'show', id: 'model', type: 'metric', role: 'secondary',
      data: { label: 'ACTIVE MODEL', value: 'GPT openAI-codex-gpt5-mini-2026-07-09' },
    });
    dispatch({
      op: 'show', id: 'provenance', type: 'metric', role: 'secondary',
      data: { label: 'MODEL / FAMILY / BASELINE / CHECKPOINT / EPOCH / BATCH / SEED / SHARD', value: 'OK' },
    });
  });

  const rows = page.locator('.metric-row');
  await expect(rows.first()).toBeVisible();
  await expect(rows).toHaveCount(2);
  for (let i = 0; i < 2; i += 1) {
    const row = rows.nth(i);
    const geometry = await row.evaluate((el) => {
      const label = el.querySelector<HTMLElement>('.metric-row__label')!;
      const value = el.querySelector<HTMLElement>('.metric-row__value')!;
      const rowBox = el.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      const valueBox = value.getBoundingClientRect();
      const overlap = !(
        valueBox.left >= labelBox.right - 1 || labelBox.left >= valueBox.right - 1 ||
        valueBox.top >= labelBox.bottom - 1 || labelBox.top >= valueBox.bottom - 1
      );
      return {
        overlap,
        contained:
          labelBox.left >= rowBox.left - 1 && labelBox.right <= rowBox.right + 1 &&
          valueBox.left >= rowBox.left - 1 && valueBox.right <= rowBox.right + 1 &&
          valueBox.top >= rowBox.top - 1 && valueBox.bottom <= rowBox.bottom + 1,
        singleLine:
          labelBox.height <= parseFloat(getComputedStyle(label).fontSize) * 1.7 &&
          valueBox.height <= parseFloat(getComputedStyle(value).fontSize) * 1.7,
      };
    });
    expect(geometry.overlap).toBe(false);
    expect(geometry.contained).toBe(true);
    expect(geometry.singleLine).toBe(true);
  }
});


test('secondary progress is visible beside the primary diagram', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
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
    dispatch({
      op: 'show', id: 'deploy-progress', type: 'progress', role: 'secondary',
      data: { label: 'Progress demo', value: 67, text: '67%' },
    });
  });

  const progress = page.locator('.rail-progress .progress-primitive');
  await expect(progress).toBeVisible();
  const geometry = await progress.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const stage = document.querySelector<HTMLElement>('.stage')!.getBoundingClientRect();
    return {
      insideStage:
        box.left >= stage.left - 1 && box.top >= stage.top - 1 &&
        box.right <= stage.right + 1 && box.bottom <= stage.bottom + 1,
      size: box.width > 40 && box.height > 20,
    };
  });
  expect(geometry.insideStage).toBe(true);
  expect(geometry.size).toBe(true);
  // The fill animates from an empty track, so poll until it settles.
  await expect.poll(() => progress.evaluate((element) => {
    const track = element.querySelector<HTMLElement>('.progress-primitive__track')!;
    const fill = element.querySelector<HTMLElement>('.progress-primitive__fill')!;
    return fill.getBoundingClientRect().width / track.getBoundingClientRect().width;
  })).toBeCloseTo(0.67, 2);
});


test('secondary progress occupies the visible aux row in a composed workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'throughput', type: 'metric', role: 'primary',
      data: { label: 'THROUGHPUT', value: '98.4%', semantic: 'green' },
    });
    dispatch({
      op: 'show', id: 'coverage', type: 'progress', role: 'secondary',
      data: { label: 'COVERAGE', value: 67, text: '67%' },
    });
  });

  const aux = page.locator('.composed-aux');
  await expect(aux).toBeVisible();
  const progress = aux.locator('.progress-primitive');
  await expect(progress).toBeVisible();
  const geometry = await progress.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const stage = document.querySelector<HTMLElement>('.stage')!.getBoundingClientRect();
    return {
      insideStage:
        box.left >= stage.left - 1 && box.top >= stage.top - 1 &&
        box.right <= stage.right + 1 && box.bottom <= stage.bottom + 1,
      size: box.width > 40 && box.height > 20,
    };
  });
  expect(geometry.insideStage).toBe(true);
  expect(geometry.size).toBe(true);
});


test('compare progress renders once in the composed aux row', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'throughput', type: 'metric', role: 'primary',
      data: { label: 'THROUGHPUT', value: '98.4%', semantic: 'green' },
    });
    dispatch({
      op: 'show', id: 'coverage', type: 'progress', role: 'compare',
      data: { label: 'COVERAGE', value: 67, text: '67%' },
    });
  });

  // A compare-role progress object is both a compare object and a progress
  // object; the aux row still gives it exactly one slot.
  const progress = page.locator('.composed-aux .progress-primitive');
  await expect(progress).toHaveCount(1);
  await expect(progress).toBeVisible();
});


test('every progress object is visible in the training scene', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'loss', type: 'chart', role: 'primary',
      data: {
        title: 'Validation loss', xMax: 40, yMin: 0, yMax: 1,
        series: [{ name: 'VAL LOSS', values: [0.8, 0.5, 0.3, 0.45] }],
      },
    });
    dispatch({
      op: 'show', id: 'epoch', type: 'progress', role: 'secondary',
      data: { label: 'EPOCH', value: 40, text: '40%' },
    });
    dispatch({
      op: 'show', id: 'eval', type: 'progress', role: 'secondary',
      data: { label: 'EVAL', value: 80, text: '80%' },
    });
  });

  const scene = page.locator('[data-scene="training"]');
  await expect(scene).toBeVisible();
  await expect(scene.locator('.progress-primitive')).toHaveCount(2);
  for (const label of ['EPOCH', 'EVAL']) {
    await expect(scene.locator('.progress-primitive', { hasText: label })).toBeVisible();
  }
});


test('note and live chat output coexist; neither mutates the other', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 7 });
  const { wsUrl } = await fixtureServer.start();

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
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

    const note = page.locator('.chart-note .annotation-card');
    await expect(note).toContainText('This annotation stays attached to the validation spike.');

    fixtureServer.broadcast({ type: 'spoken', entry: { role: 'agent', text: 'The spike is contained.', id: 'reply-1' } });
    const live = page.locator('.live-chat-card');
    await expect(live).toBeVisible();
    await expect(live).toContainText('The spike is contained.');
    await expect(note).toContainText('This annotation stays attached to the validation spike.');

    const overlap = await page.evaluate(() => {
      const noteBox = document.querySelector<HTMLElement>('.chart-note')!.getBoundingClientRect();
      const liveBox = document.querySelector<HTMLElement>('.live-chat-card')!.getBoundingClientRect();
      return !(
        noteBox.right <= liveBox.left || liveBox.right <= noteBox.left ||
        noteBox.bottom <= liveBox.top || liveBox.bottom <= noteBox.top
      );
    });
    expect(overlap, 'note and live card must not overlap').toBe(false);

    fixtureServer.broadcast({ type: 'spoken', entry: { role: 'agent', text: 'A newer response replaces the live card only.', id: 'reply-2' } });
    await expect(live).toContainText('A newer response replaces the live card only.');
    await expect(note).toContainText('This annotation stays attached to the validation spike.');

    fixtureServer.broadcast({ type: 'display', action: { op: 'hide', id: 'spike-note' } });
    await expect(page.locator('.chart-note')).toHaveCount(0);
    await expect(live).toContainText('A newer response replaces the live card only.');
  } finally {
    await fixtureServer.stop();
  }
});


test('long chat output scrolls inside the live card', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 8 });
  const { wsUrl } = await fixtureServer.start();
  const reply = Array.from({ length: 24 }, (_, index) => `Card paragraph ${index + 1} stays readable. Card paragraph ${index + 1} stays readable.`).join('\n\n');

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
    fixtureServer.broadcast({
      type: 'display',
      action: {
        op: 'show', id: 'map', type: 'diagram', role: 'primary',
        data: {
          mode: 'graph', title: 'SYSTEM MAP',
          nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
          edges: [{ from: 'a', to: 'b' }],
        },
      },
    });
    fixtureServer.broadcast({ type: 'spoken', entry: { role: 'agent', text: reply, id: 'reply-long' } });

    const card = page.locator('.live-chat-card');
    await expect(card).toBeVisible();
    const geometry = await card.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const stage = document.querySelector<HTMLElement>('.stage')!.getBoundingClientRect();
      const text = element.querySelector<HTMLElement>('.live-chat-card__text')!;
      return {
        insideStage:
          box.left >= stage.left - 1 && box.top >= stage.top - 1 &&
          box.right <= stage.right + 1 && box.bottom <= stage.bottom + 1,
        overflowY: getComputedStyle(text).overflowY,
        scrollable: text.scrollHeight > text.clientHeight,
      };
    });
    expect(geometry.insideStage).toBe(true);
    expect(geometry.overflowY).toBe('auto');
    expect(geometry.scrollable).toBe(true);
  } finally {
    await fixtureServer.stop();
  }
});

// #48: a table row, a path or a hash with no break in it wraps inside the
// live card; the card never scrolls sideways or grows past the rail.
test('wide chat output wraps inside the live card instead of scrolling sideways', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 9 });
  const { wsUrl } = await fixtureServer.start();
  const reply = [
    '| file | status | owner | notes |',
    '|------|--------|-------|-------|',
    '| apps/backend/src/pbx.rs | modified | switchboard | turn epoch is stamped before dispatch |',
    '',
    `Commit ${'0123456789abcdef'.repeat(8)} touched /home/lab/projects/switchboard/apps/frontend/src/components/Scenes.tsx.`,
    '',
    `\`${'very_long_identifier_'.repeat(10)}\``,
  ].join('\n');

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
    fixtureServer.broadcast({
      type: 'display',
      action: {
        op: 'show', id: 'map', type: 'diagram', role: 'primary',
        data: {
          mode: 'graph', title: 'SYSTEM MAP',
          nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
          edges: [{ from: 'a', to: 'b' }],
        },
      },
    });
    fixtureServer.broadcast({ type: 'spoken', entry: { role: 'agent', text: reply, id: 'reply-wide' } });

    const card = page.locator('.live-chat-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('0123456789abcdef');
    const geometry = await card.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const rail = document.querySelector<HTMLElement>('.content-rail__details')!.getBoundingClientRect();
      const text = element.querySelector<HTMLElement>('.live-chat-card__text')!;
      const textBox = text.getBoundingClientRect();
      return {
        insideRail: box.left >= rail.left - 1 && box.right <= rail.right + 1,
        textInsideCard: textBox.left >= box.left - 1 && textBox.right <= box.right + 1,
        overflowX: getComputedStyle(text).overflowX,
        scrollWidth: text.scrollWidth,
        clientWidth: text.clientWidth,
      };
    });
    expect(geometry.insideRail).toBe(true);
    expect(geometry.textInsideCard).toBe(true);
    expect(geometry.overflowX).toBe('hidden');
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  } finally {
    await fixtureServer.stop();
  }
});


test('tool activity panel appears, flips to done, and clears when idle', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 10 });
  const { wsUrl } = await fixtureServer.start();

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
    fixtureServer.broadcast({
      type: 'display',
      action: {
        op: 'show', id: 'map', type: 'diagram', role: 'primary',
        data: {
          mode: 'graph', title: 'SYSTEM MAP',
          nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
          edges: [{ from: 'a', to: 'b' }],
        },
      },
    });

    await expect(page.locator('[data-testid="tool-activity"]')).toHaveCount(0);

    fixtureServer.broadcast({ type: 'activity', state: 'start', tool: 'shell', label: 'Running tests', detail: 'cargo test --locked' });
    const panel = page.locator('[data-testid="tool-activity"]');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('CURRENT ACTIVITY');
    await expect(panel).toContainText('\u25cf RUNNING');
    await expect(panel).toContainText('shell');

    fixtureServer.broadcast({ type: 'activity', state: 'end', tool: 'shell' });
    await expect(panel).toContainText('LAST TOOL USED');
    await expect(panel).toContainText('\u25a0 DONE');

    await page.waitForTimeout(2200);
    await expect(page.locator('[data-testid="tool-activity"]')).toHaveCount(0);
  } finally {
    await fixtureServer.stop();
  }
});


test('every call of one tool registers on the activity panel (#27)', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 91 });
  const { wsUrl } = await fixtureServer.start();

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
    fixtureServer.broadcast({
      type: 'display',
      action: {
        op: 'show', id: 'map', type: 'diagram', role: 'primary',
        data: {
          mode: 'graph', title: 'SYSTEM MAP',
          nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
          edges: [{ from: 'a', to: 'b' }],
        },
      },
    });

    const panel = page.locator('.content-rail__details [data-testid="tool-activity"]');
    const seen: string[] = [];
    for (let n = 0; n < 4; n += 1) {
      fixtureServer.broadcast({ type: 'activity', state: 'start', tool: 'read', label: 'Reading', detail: 'apps/backend/src/api.rs' });
      await expect(panel).toContainText('CURRENT ACTIVITY');
      const call = await panel.getAttribute('data-call');
      expect(call).not.toBeNull();
      seen.push(call!);
      fixtureServer.broadcast({ type: 'activity', state: 'end', tool: 'read' });
      await expect(panel).toContainText('LAST TOOL USED');
    }
    // Four calls of the same tool with the same detail are four calls on the
    // panel, each with a line of its own.
    expect(new Set(seen).size).toBe(4);
    await expect(panel.locator('.tool-activity__call')).toHaveCount(1);
    await expect(panel.locator('.tool-activity__tool')).toHaveText('read');
  } finally {
    await fixtureServer.stop();
  }
});


test('tool activity panel truncates long names and stays clear of the response', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 11 });
  const { wsUrl } = await fixtureServer.start();

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
    fixtureServer.broadcast({
      type: 'display',
      action: {
        op: 'show', id: 'map', type: 'diagram', role: 'primary',
        data: {
          mode: 'graph', title: 'SYSTEM MAP',
          nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
          edges: [{ from: 'a', to: 'b' }],
        },
      },
    });
    const longTool = `exec-repo-worker-${'x'.repeat(64)}`;
    fixtureServer.broadcast({
      type: 'activity', state: 'start', tool: longTool,
      label: 'Long detail', detail: `${'detail '.repeat(24)}trailing`,
    });

    const panel = page.locator('[data-testid="tool-activity"]');
    await expect(panel).toBeVisible();
    const railGeometry = await panel.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const stage = document.querySelector<HTMLElement>('.stage')!.getBoundingClientRect();
      const tool = element.querySelector<HTMLElement>('.tool-activity__tool')!;
      const detail = element.querySelector<HTMLElement>('.tool-activity__detail');
      return {
        insideStage:
          box.left >= stage.left - 1 && box.top >= stage.top - 1 &&
          box.right <= stage.right + 1 && box.bottom <= stage.bottom + 1,
        toolTruncated: tool.scrollWidth > tool.clientWidth,
        detailTruncated: detail ? detail.scrollWidth > detail.clientWidth : true,
      };
    });
    expect(railGeometry.insideStage).toBe(true);
    expect(railGeometry.toolTruncated).toBe(true);
    expect(railGeometry.detailTruncated).toBe(true);

    fixtureServer.broadcast({ type: 'view', target: 'comms' });
    const conversationPanel = page.locator('.tool-activity--conversation');
    await expect(page.locator('[data-scene="conversation"]')).toBeVisible();
    await expect(conversationPanel).toBeVisible();
    const overlap = await conversationPanel.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const answer = document.querySelector<HTMLElement>('.conversation-answer')!.getBoundingClientRect();
      return !(
        box.left >= answer.right || answer.left >= box.right ||
        box.top >= answer.bottom || answer.top >= box.bottom
      );
    });
    expect(overlap, 'panel must not cover the current response').toBe(false);
  } finally {
    await fixtureServer.stop();
  }
});


test('tool activity clears when the route changes', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 12 });
  const { wsUrl } = await fixtureServer.start();

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
    fixtureServer.broadcast({
      type: 'display',
      action: {
        op: 'show', id: 'map', type: 'diagram', role: 'primary',
        data: {
          mode: 'graph', title: 'SYSTEM MAP',
          nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
          edges: [{ from: 'a', to: 'b' }],
        },
      },
    });
    fixtureServer.broadcast({ type: 'activity', state: 'start', tool: 'shell', label: 'Working', detail: 'on it' });
    const panel = page.locator('[data-testid="tool-activity"]');
    await expect(panel).toBeVisible();

    // A handoff is always an epoch frame followed by the new route's status;
    // the epoch reset is what ends the previous line's activity.
    fixtureServer.broadcast({ type: 'epoch', generation: 13 });
    fixtureServer.broadcast({ type: 'status', route: 'damocles', routes: [{ value: 'damocles', label: 'Damocles' }] });
    await expect.poll(async () => (await panel.count()) === 0).toBe(true);
  } finally {
    await fixtureServer.stop();
  }
});


async function openLine(page: Page, fixtureServer: DisplayFixtureServer, viewport = { width: 1440, height: 900 }) {
  const { wsUrl } = await fixtureServer.start();
  await page.setViewportSize(viewport);
  await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
  await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
}

const MAP_ACTION = {
  op: 'show', id: 'map', type: 'diagram', role: 'primary',
  data: {
    mode: 'graph', title: 'SYSTEM MAP',
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    edges: [{ from: 'a', to: 'b' }],
  },
};


test('an agent say and a line error still show beside the live chat card', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 7 });
  try {
    await openLine(page, fixtureServer);
    fixtureServer.broadcast({ type: 'display', action: MAP_ACTION });
    fixtureServer.broadcast({ type: 'spoken', entry: { role: 'agent', text: 'The map is up.', id: 'reply-1' } });
    const live = page.locator('.live-chat-card');
    await expect(live).toContainText('The map is up.');
    // The spoken reply reads in the live card only, never twice.
    await expect(page.locator('.rail-note')).toHaveCount(0);

    fixtureServer.broadcast({ type: 'error', message: 'LINE ERROR / TRANSFER FAILED' });
    await expect(page.locator('.rail-note')).toContainText('LINE ERROR / TRANSFER FAILED');

    fixtureServer.broadcast({ type: 'display', action: { op: 'say', text: 'AGENT SAY EXPLANATION' } });
    await expect(page.locator('.rail-note')).toContainText('AGENT SAY EXPLANATION');
    await expect(live).toContainText('The map is up.');
  } finally {
    await fixtureServer.stop();
  }
});


test('an agent object named message is not taken for the live chat turn', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({ op: 'show', id: 'message', type: 'metric', role: 'primary', data: { label: 'QUEUE', value: '12' } });
  });

  await expect(page.locator('[data-scene="composed"]')).toBeVisible();
  await expect(page.locator('.live-chat-card')).toHaveCount(0);
  expect(errors).toEqual([]);
});


test('no live chat card stands in before the first response', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 7 });
  try {
    await openLine(page, fixtureServer);
    fixtureServer.broadcast({ type: 'display', action: MAP_ACTION });
    fixtureServer.broadcast({ type: 'transcript', text: 'Show me the map.' });
    await expect(page.locator('[data-scene="architecture"]')).toBeVisible();
    await expect(page.locator('.live-chat-card')).toHaveCount(0);

    // The conversation scene keeps its own open-line prompt.
    fixtureServer.broadcast({ type: 'view', target: 'comms' });
    await expect(page.locator('.conversation-answer__text')).toHaveText('Line open. Speak when ready.');
  } finally {
    await fixtureServer.stop();
  }
});


test('rail progress keeps a visible bar with its default text', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'quality-map', type: 'diagram', role: 'primary',
      data: { mode: 'graph', title: 'QUALITY PATH', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] },
    });
    dispatch({ op: 'show', id: 'demo', type: 'progress', role: 'secondary', data: { label: 'Progress demo', value: 57 } });
  });

  const progress = page.locator('.rail-progress .progress-primitive');
  await expect(progress).toBeVisible();
  const geometry = await progress.evaluate((element) => {
    const rail = element.closest('.content-rail')!.getBoundingClientRect();
    const track = element.querySelector('.progress-primitive__track')!.getBoundingClientRect();
    const text = element.querySelector('.progress-primitive__text')!.getBoundingClientRect();
    return {
      trackWidth: track.width,
      withinRail: track.right <= rail.right + 1 && text.right <= rail.right + 1,
      overflows: element.scrollWidth > element.clientWidth + 1,
    };
  });
  expect(geometry.trackWidth).toBeGreaterThan(80);
  expect(geometry.withinRail).toBe(true);
  expect(geometry.overflows).toBe(false);
  await expect(progress.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '57');
});


test('a crowded phone rail scrolls instead of collapsing the response and the note', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 7 });
  try {
    await openLine(page, fixtureServer, { width: 390, height: 844 });
    fixtureServer.broadcast({ type: 'display', action: MAP_ACTION });
    fixtureServer.broadcast({ type: 'display', action: { op: 'show', id: 'm1', type: 'metric', role: 'secondary', data: { label: 'THROUGHPUT', value: '98.4%' } } });
    fixtureServer.broadcast({ type: 'display', action: { op: 'show', id: 'm2', type: 'metric', role: 'secondary', data: { label: 'LATENCY', value: '182 ms' } } });
    fixtureServer.broadcast({ type: 'display', action: { op: 'show', id: 'p1', type: 'progress', role: 'secondary', data: { label: 'DEPLOY', value: 40 } } });
    fixtureServer.broadcast({ type: 'display', action: { op: 'show', id: 'n1', type: 'note', role: 'secondary', data: { segments: [{ text: 'The durable note.' }] } } });
    fixtureServer.broadcast({ type: 'spoken', entry: { role: 'agent', text: 'The current response.', id: 'reply-1' } });
    fixtureServer.broadcast({ type: 'activity', state: 'start', tool: 'shell', label: 'Working', detail: 'ls' });
    await expect(page.locator('[data-testid="tool-activity"]')).toBeAttached();

    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return {
        liveHeight: rect('.live-chat-card__text').height,
        noteHeight: rect('.rail-note').height,
        detailsBottom: rect('.content-rail__details').bottom,
        footerTop: rect('.scene-footer').top,
      };
    });
    expect(geometry.liveHeight).toBeGreaterThan(24);
    expect(geometry.noteHeight).toBeGreaterThan(24);
    expect(geometry.detailsBottom).toBeLessThanOrEqual(geometry.footerTop + 1);
  } finally {
    await fixtureServer.stop();
  }
});


for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 900, height: 800 }, { width: 1440, height: 900 }]) {
  test(`the conversation activity panel leaves the transcript toggle clickable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const fixtureServer = new DisplayFixtureServer({ initialGeneration: 7 });
    try {
      await openLine(page, fixtureServer, viewport);
      fixtureServer.broadcast({ type: 'spoken', entry: { role: 'agent', text: 'Working on it.', id: 'reply-1' } });
      fixtureServer.broadcast({ type: 'activity', state: 'start', tool: 'a_rather_long_tool_name_for_the_panel', label: 'Working', detail: 'a detail long enough to fill the panel width' });
      await expect(page.locator('[data-scene="conversation"]')).toBeVisible();
      await expect(page.locator('[data-testid="tool-activity"]')).toBeVisible();

      const covered = await page.evaluate(() => {
        const toggle = document.querySelector<HTMLElement>('.transcript-toggle')!;
        const box = toggle.getBoundingClientRect();
        const y = box.top + box.height / 2;
        return [0.1, 0.5, 0.9].some((fraction) => {
          const hit = document.elementFromPoint(box.left + box.width * fraction, y);
          return !hit || !toggle.contains(hit);
        });
      });
      expect(covered).toBe(false);
      const answer = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="tool-activity"]')!.getBoundingClientRect();
        const box = document.querySelector('.conversation-answer')!.getBoundingClientRect();
        return panel.top >= box.bottom - 1 && panel.right <= window.innerWidth;
      });
      expect(answer).toBe(true);
    } finally {
      await fixtureServer.stop();
    }
  });
}


test('a short metric value stays at the right edge and leaves the label its room', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'map', type: 'diagram', role: 'primary',
      data: { mode: 'graph', title: 'MAP', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] },
    });
    dispatch({ op: 'show', id: 'rps', type: 'metric', role: 'secondary', data: { label: 'THROUGHPUT / RPS', value: 'OK' } });
  });

  const row = page.locator('.metric-row').first();
  await expect(row).toBeVisible();
  const geometry = await row.evaluate((element) => {
    const rowBox = element.getBoundingClientRect();
    const value = element.querySelector('.metric-row__value')!;
    const range = document.createRange();
    range.selectNodeContents(value);
    const label = element.querySelector<HTMLElement>('.metric-row__label')!;
    return {
      valueGap: rowBox.right - range.getBoundingClientRect().right,
      labelTruncated: label.scrollWidth > label.clientWidth + 1,
    };
  });
  expect(geometry.valueGap).toBeLessThan(4);
  expect(geometry.labelTruncated).toBe(false);
});


test('a secondary chart is drawn in the composed aux row', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({ op: 'show', id: 'tp', type: 'metric', role: 'primary', data: { label: 'THROUGHPUT', value: '98.4%' } });
    dispatch({
      op: 'show', id: 'sc', type: 'chart', role: 'secondary',
      data: { title: 'TREND', series: [{ name: 'TP', values: [0.4, 0.6, 0.9] }] },
    });
  });

  await expect(page.locator('[data-scene="composed"]')).toBeVisible();
  await expect(page.locator('.composed-aux [data-testid="chart"]')).toBeVisible();
});

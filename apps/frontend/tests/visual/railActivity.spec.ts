import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { DisplayFixtureServer } from '../integration/display-fixture-server.mjs';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const viewports = [
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
  { width: 900, height: 800 },
  { width: 1440, height: 900 },
  { width: 2560, height: 1080 },
] as const;

// Common laptop browser viewports, where the band between the answer box and
// the lower corner mark is at its narrowest.
const shortLandscapes = [
  { width: 1366, height: 657 },
  { width: 1536, height: 730 },
] as const;

function overlap(first: Box, second: Box) {
  return !(
    first.x + first.width <= second.x
    || second.x + second.width <= first.x
    || first.y + first.height <= second.y
    || second.y + second.height <= first.y
  );
}

async function openConversation(page: Page, testInfo: TestInfo) {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: testInfo.workerIndex + 30 });
  const { wsUrl } = await fixtureServer.start();
  await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
  await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
  fixtureServer.broadcast({ type: 'spoken', entry: { role: 'agent', text: 'Working on it.', id: 'reply-1' } });
  fixtureServer.broadcast({
    type: 'activity',
    state: 'start',
    tool: 'a_rather_long_tool_name_for_the_panel',
    label: 'Working',
    detail: 'a detail long enough to fill the panel width',
  });
  await expect(page.locator('[data-scene="conversation"]')).toBeVisible();
  await expect(page.locator('.tool-activity--conversation')).toBeVisible();
  // Measure where the panel settles, not its 6px rise in.
  await page.waitForTimeout(300);
  return fixtureServer;
}

for (const viewport of [...viewports, ...shortLandscapes]) {
  test(`conversation activity clears the fixed lower controls at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const fixtureServer = await openConversation(page, testInfo);

    try {
      const activityBox = await page.locator('.tool-activity--conversation').boundingBox();
      const answerBox = await page.locator('.conversation-answer').boundingBox();
      const cornerBox = await page.locator('.corner-mark--bottom').boundingBox();
      const transcriptBox = await page.locator('.transcript-toggle').boundingBox();
      expect(activityBox).not.toBeNull();
      expect(answerBox).not.toBeNull();
      expect(cornerBox).not.toBeNull();
      expect(transcriptBox).not.toBeNull();
      expect(overlap(activityBox!, answerBox!), 'activity overlaps the current response').toBe(false);
      expect(overlap(activityBox!, cornerBox!), 'activity overlaps the approved lower corner mark').toBe(false);
      expect(overlap(activityBox!, transcriptBox!), 'activity overlaps the transcript toggle').toBe(false);
    } finally {
      await fixtureServer.stop();
    }
  });
}

test('the shared content rail keeps one semantic surface order', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 40 });
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
    fixtureServer.broadcast({ type: 'activity', state: 'start', tool: 'shell', label: 'Working', detail: 'npm test' });
    fixtureServer.broadcast({
      type: 'display',
      action: { op: 'show', id: 'deploy', type: 'progress', role: 'secondary', data: { label: 'DEPLOY', value: 40 } },
    });
    fixtureServer.broadcast({
      type: 'display',
      action: { op: 'show', id: 'note', type: 'note', role: 'secondary', data: { segments: [{ text: 'The active path is healthy.' }] } },
    });
    fixtureServer.broadcast({ type: 'spoken', entry: { role: 'agent', text: 'I am checking it now.', id: 'reply-1' } });
    fixtureServer.broadcast({
      type: 'display',
      action: { op: 'show', id: 'latency', type: 'metric', role: 'secondary', data: { label: 'LATENCY', value: '182 ms' } },
    });

    await expect(page.locator('.content-rail__details > *')).toHaveCount(5);
    const surfaces = await page.locator('.content-rail__details > *').evaluateAll((children) => (
      children.map((child) => {
        if (child.classList.contains('metrics')) return 'metrics';
        if (child.classList.contains('live-chat-card')) return 'chat';
        if (child.classList.contains('rail-note')) return 'note';
        if (child.classList.contains('rail-progress')) return 'progress';
        if (child.classList.contains('tool-activity-slot')) return 'activity';
        return child.className;
      })
    ));
    expect(surfaces).toEqual(['metrics', 'chat', 'note', 'progress', 'activity']);
  } finally {
    await fixtureServer.stop();
  }
});

test('rail progress uses spacing instead of a top border', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?scene=architecture&chrome=0');
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
      op: 'show', id: 'note', type: 'note', role: 'secondary',
      data: { segments: [{ text: 'The active path is healthy.' }] },
    });
    dispatch({
      op: 'show', id: 'deploy', type: 'progress', role: 'secondary',
      data: { label: 'DEPLOY', value: 40 },
    });
  });

  const noteBox = await page.locator('.rail-note').boundingBox();
  const progress = page.locator('.rail-progress .progress-primitive');
  const progressBox = await progress.boundingBox();
  expect(noteBox).not.toBeNull();
  expect(progressBox).not.toBeNull();
  expect(await progress.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('0px');
  expect(progressBox!.y - (noteBox!.y + noteBox!.height)).toBeGreaterThan(0);
});

test('rail metrics are framed by rules in the content rail, with no header line', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?scene=architecture&chrome=0');
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
      op: 'show', id: 'latency', type: 'metric', role: 'secondary',
      data: { label: 'LATENCY', value: '182 ms' },
    });
    dispatch({
      op: 'show', id: 'error_rate', type: 'metric', role: 'secondary',
      data: { label: 'ERROR RATE', value: '0.01%' },
    });
  });

  const metrics = page.locator('.content-rail__details .metrics');
  await expect(metrics).toBeVisible();
  await expect(metrics).toHaveClass(/metrics--rail/);

  // Bracketed by rules, not titled: no header line is spent on them (#32).
  await expect(metrics.locator('.metrics__header')).toHaveCount(0);
  await expect(metrics).not.toContainText('TELEMETRY');

  const frame = await metrics.evaluate((el) => {
    const style = getComputedStyle(el);
    const first = el.querySelector('.metric-row')!;
    return {
      top: style.borderTopWidth,
      bottom: style.borderBottomWidth,
      firstRowTop: getComputedStyle(first).borderTopWidth,
      firstRowOffset: first.getBoundingClientRect().top - el.getBoundingClientRect().top,
    };
  });
  expect(frame.top).toBe('1px');
  expect(frame.bottom).toBe('1px');
  // The orange rule is the first row's divider, so the rows start right under it.
  expect(frame.firstRowTop).toBe('0px');
  expect(frame.firstRowOffset).toBeLessThanOrEqual(1);
  const borderRadius = await metrics.evaluate((el) => getComputedStyle(el).borderRadius);
  expect(borderRadius).toBe('0px');
});

for (const viewport of viewports) {
  test(`tool activity mounting and unmounting does not shift metrics or chat at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const fixtureServer = new DisplayFixtureServer({ initialGeneration: testInfo.workerIndex + 60 });
    const { wsUrl } = await fixtureServer.start();

    try {
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
      fixtureServer.broadcast({
        type: 'display',
        action: { op: 'show', id: 'latency', type: 'metric', role: 'secondary', data: { label: 'LATENCY', value: '182 ms' } },
      });
      fixtureServer.broadcast({
        type: 'spoken',
        entry: { role: 'agent', text: 'Monitoring active routes.', id: 'reply-1' },
      });

      await expect(page.locator('.content-rail__details .metrics')).toBeVisible();
      await expect(page.locator('.content-rail__details .live-chat-card')).toBeVisible();
      await page.waitForTimeout(300);

      const metricsBoxBefore = await page.locator('.content-rail__details .metrics').boundingBox();
      const chatBoxBefore = await page.locator('.content-rail__details .live-chat-card').boundingBox();
      expect(metricsBoxBefore).not.toBeNull();
      expect(chatBoxBefore).not.toBeNull();

      // Mount activity
      fixtureServer.broadcast({
        type: 'activity',
        state: 'start',
        tool: 'route_check',
        label: 'Checking',
        detail: 'ping 10.0.0.1',
      });

      await expect(page.locator('.content-rail__details .tool-activity')).toBeVisible();
      await page.waitForTimeout(300);

      const metricsBoxDuring = await page.locator('.content-rail__details .metrics').boundingBox();
      const chatBoxDuring = await page.locator('.content-rail__details .live-chat-card').boundingBox();
      const activityBox = await page.locator('.content-rail__details .tool-activity').boundingBox();
      expect(overlap(activityBox!, metricsBoxDuring!), 'activity covers the metrics').toBe(false);
      expect(overlap(activityBox!, chatBoxDuring!), 'activity covers the live response').toBe(false);

      expect(metricsBoxDuring!.x).toBeCloseTo(metricsBoxBefore!.x, 1);
      expect(metricsBoxDuring!.y).toBeCloseTo(metricsBoxBefore!.y, 1);
      expect(metricsBoxDuring!.width).toBeCloseTo(metricsBoxBefore!.width, 1);
      expect(metricsBoxDuring!.height).toBeCloseTo(metricsBoxBefore!.height, 1);

      expect(chatBoxDuring!.x).toBeCloseTo(chatBoxBefore!.x, 1);
      expect(chatBoxDuring!.y).toBeCloseTo(chatBoxBefore!.y, 1);
      expect(chatBoxDuring!.width).toBeCloseTo(chatBoxBefore!.width, 1);
      expect(chatBoxDuring!.height).toBeCloseTo(chatBoxBefore!.height, 1);

      // Unmount activity (end and linger)
      fixtureServer.broadcast({
        type: 'activity',
        state: 'end',
        tool: 'route_check',
        label: 'Done',
        detail: 'ping 10.0.0.1',
      });

      await expect(page.locator('.content-rail__details .tool-activity')).toBeHidden({ timeout: 5000 });
      await page.waitForTimeout(300);

      const metricsBoxAfter = await page.locator('.content-rail__details .metrics').boundingBox();
      const chatBoxAfter = await page.locator('.content-rail__details .live-chat-card').boundingBox();

      expect(metricsBoxAfter!.x).toBeCloseTo(metricsBoxBefore!.x, 1);
      expect(metricsBoxAfter!.y).toBeCloseTo(metricsBoxBefore!.y, 1);
      expect(metricsBoxAfter!.width).toBeCloseTo(metricsBoxBefore!.width, 1);
      expect(metricsBoxAfter!.height).toBeCloseTo(metricsBoxBefore!.height, 1);

      expect(chatBoxAfter!.x).toBeCloseTo(chatBoxBefore!.x, 1);
      expect(chatBoxAfter!.y).toBeCloseTo(chatBoxBefore!.y, 1);
      expect(chatBoxAfter!.width).toBeCloseTo(chatBoxBefore!.width, 1);
      expect(chatBoxAfter!.height).toBeCloseTo(chatBoxBefore!.height, 1);
    } finally {
      await fixtureServer.stop();
    }
  });
}


// A rail with more than fits: the column scrolls, and the activity panel must
// still take its own place in it rather than land on top of what it holds.
for (const viewport of viewports) {
  test(`tool activity never covers a crowded rail at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const fixtureServer = new DisplayFixtureServer({ initialGeneration: testInfo.workerIndex + 80 });
    const { wsUrl } = await fixtureServer.start();

    try {
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
      for (const [id, label, value] of [['m1', 'VAL LOSS', '0.18'], ['m2', 'TRAIN LOSS', '0.10'], ['m3', 'GPU', '91%']]) {
        fixtureServer.broadcast({ type: 'display', action: { op: 'show', id, type: 'metric', role: 'secondary', data: { label, value } } });
      }
      fixtureServer.broadcast({
        type: 'display',
        action: { op: 'show', id: 'note', type: 'note', role: 'secondary', data: { segments: [{ text: 'The active path is healthy.' }] } },
      });
      fixtureServer.broadcast({ type: 'spoken', entry: { role: 'agent', text: 'Monitoring active routes.', id: 'reply-1' } });
      await expect(page.locator('.content-rail__details .rail-note')).toBeVisible();
      await expect(page.locator('.content-rail__details .live-chat-card')).toBeVisible();

      const surfaces = ['.metrics', '.live-chat-card', '.rail-note'];
      const boxes = async () => Promise.all(surfaces.map(async (selector) => (await page.locator(`.content-rail__details ${selector}`).boundingBox())!));
      // The metrics animate their layout as rows arrive; compare settled boxes.
      const settledBoxes = async () => {
        let last = JSON.stringify(await boxes());
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await page.waitForTimeout(150);
          const next = JSON.stringify(await boxes());
          if (next === last) break;
          last = next;
        }
        return JSON.parse(last) as Box[];
      };
      const before = await settledBoxes();

      fixtureServer.broadcast({ type: 'activity', state: 'start', tool: 'route_check', label: 'Checking', detail: 'ping 10.0.0.1' });
      await expect(page.locator('.content-rail__details .tool-activity')).toBeAttached();
      await page.waitForTimeout(300);

      const during = await settledBoxes();
      const activityBox = (await page.locator('.content-rail__details .tool-activity').boundingBox())!;
      surfaces.forEach((selector, index) => {
        expect(overlap(activityBox, during[index]), `activity covers ${selector}`).toBe(false);
        expect(during[index].y, `${selector} moved when activity appeared`).toBeCloseTo(before[index].y, 1);
        expect(during[index].height, `${selector} resized when activity appeared`).toBeCloseTo(before[index].height, 1);
      });
    } finally {
      await fixtureServer.stop();
    }
  });
}

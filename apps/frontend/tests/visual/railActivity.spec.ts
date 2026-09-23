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
  return fixtureServer;
}

for (const viewport of viewports) {
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
        if (child.classList.contains('tool-activity')) return 'activity';
        return child.className;
      })
    ));
    expect(surfaces).toEqual(['metrics', 'chat', 'note', 'progress', 'activity']);
  } finally {
    await fixtureServer.stop();
  }
});

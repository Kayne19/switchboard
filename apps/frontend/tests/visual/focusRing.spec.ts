import { expect, test, type Page } from '@playwright/test';
import { DisplayFixtureServer } from '../integration/display-fixture-server.mjs';
import { transcriptEntry } from '../fixtures/serverMessages';
import { FRAME_GEOMETRIES, focusRingFault, openScene, runActions } from './helpers';

// The page's focus ring where jsdom cannot see it (DESIGN_SYSTEM.md, "Focus
// ring"; tests/unit/focusRing.test.ts reads the rules): every control the
// keyboard reaches, in every fixture, on the stage, in focus and in the
// history, at every geometry, draws one orange line, never the browser's own
// ring, and no box that clips cuts it. The browser drew its own ring on
// RETURN / ESC, on the scrolls Chrome puts in the tab order (a note's text,
// the answer, a scrolled drawing) and on a calendar's paged days; an object's
// ring was cut away whole by its box, and a metric card's by its own
// chamfer; both HISTORY rings lost their right side to the rail's edge.

const fixtures = ['idle', 'conversation', 'training', 'architecture', 'email', 'code', 'results', 'handoff', 'comparison', 'figure', 'plan', 'composed', 'topology', 'pipeline', 'trace', 'calendar', 'calendar-day', 'calendar-month', 'calendar-agenda', 'tasks', 'timer', 'weather', 'inbox', 'today'];

/** Tabs through every control inside `within` once, and what is wrong with each one's ring. */
async function tabThrough(page: Page, where: string, within: string): Promise<{ reached: string[]; faults: string[] }> {
  const reached: string[] = [];
  const faults: string[] = [];
  // The walk ends where it began: the controls reached are held by the
  // element, so two with one class and one name are two.
  await page.evaluate(() => {
    (window as unknown as { reachedControls: WeakSet<Element> }).reachedControls = new WeakSet();
  });
  for (let step = 0; step < 60; step += 1) {
    await page.keyboard.press('Tab');
    const seen = await page.evaluate((scope) => {
      const control = document.activeElement as HTMLElement | null;
      if (!control || !control.closest(scope)) return null;
      const reachedControls = (window as unknown as { reachedControls: WeakSet<Element> }).reachedControls;
      const again = reachedControls.has(control);
      reachedControls.add(control);
      return { again, key: `${control.className} ${control.getAttribute('aria-label') ?? control.textContent?.slice(0, 40)}`, visible: control.matches(':focus-visible') };
    }, within);
    if (!seen) continue;
    if (seen.again) break;
    const fault = await page.evaluate(focusRingFault);
    reached.push(seen.key);
    if (!seen.visible) faults.push(`${where} ${seen.key}: reached by Tab but not :focus-visible`);
    if (fault) faults.push(`${where} ${fault}`);
  }
  return { reached, faults };
}

for (const geometry of FRAME_GEOMETRIES) {
  test(`every control the keyboard reaches draws the page's ring, uncut / ${geometry.name}`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    const faults: string[] = [];
    let reached = 0;
    for (const scene of fixtures) {
      await openScene(page, scene);
      await page.waitForTimeout(700);
      const stage = await tabThrough(page, `${scene}`, '.stage');
      faults.push(...stage.faults);
      reached += stage.reached.length;
      const primary = await page.evaluate(() => {
        const objects = Object.values(window.SwitchboardController.state().agentObjects);
        return (objects.find((object) => object.role === 'primary' && object.type !== 'note') ?? objects.find((object) => object.type !== 'note'))?.id ?? null;
      });
      if (primary) {
        await runActions(page, [{ op: 'focus', id: primary }]);
        await page.waitForTimeout(700);
        const focus = await tabThrough(page, `${scene} in focus`, '.focus-layer');
        faults.push(...focus.faults);
        reached += focus.reached.length;
      }
    }
    // A metric in a cluster, which no fixture draws: its card is clipped to
    // its chamfer and lights its edge.
    await openScene(page, 'idle');
    await runActions(page, [
      { op: 'clear' },
      ...['GPU', 'MEMORY', 'P95 LATENCY'].map((label, index) => ({ op: 'show', id: `metric-${index}`, type: 'metric', role: 'primary', data: { label, value: `${40 + index}%` } })),
    ]);
    await page.waitForTimeout(700);
    const cluster = await tabThrough(page, 'metric cluster', '.metrics--cluster');
    faults.push(...cluster.faults);
    expect(cluster.reached).toHaveLength(3);
    expect(faults).toEqual([]);
    expect(reached).toBeGreaterThan(fixtures.length);
  });
}

test('the history drawer\'s controls draw the page\'s ring, uncut', async ({ page }) => {
  const server = new DisplayFixtureServer({ initialGeneration: 1 });
  const { wsUrl } = await server.start();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}&chrome=0`);
    await expect.poll(() => server.frames.some((frame) => frame.type === 'hello')).toBe(true);
    server.broadcast({ type: 'history', entries: Array.from({ length: 30 }, (_, index) => transcriptEntry({ role: index % 2 ? 'agent' : 'caller', text: `Line ${index + 1} of a history long enough to scroll.`, id: `line-${index}` })) });
    await page.locator('.transcript-toggle').click();
    await page.getByRole('textbox', { name: 'Conversation input' }).fill('typed');
    const { reached, faults } = await tabThrough(page, 'history', '.transcript');
    expect(faults).toEqual([]);
    expect(reached.join(' | ')).toContain('transcript__return');
    expect(reached.join(' | ')).toContain('transcript__send');
  } finally {
    await server.stop();
  }
});

// The HISTORY buttons, a note's and the live response's, stand at their
// card's right edge, which clips; each keeps its ring's reach from it.
for (const geometry of FRAME_GEOMETRIES) {
  for (const card of ['note', 'live response'] as const) {
    test(`the ${card}'s HISTORY ring is whole / ${geometry.name}`, async ({ page }) => {
      const server = new DisplayFixtureServer({ initialGeneration: 2 });
      const { wsUrl } = await server.start();
      try {
        await page.setViewportSize({ width: geometry.width, height: geometry.height });
        await page.goto(`/?ws=${encodeURIComponent(wsUrl)}&chrome=0`);
        await expect.poll(() => server.frames.some((frame) => frame.type === 'hello')).toBe(true);
        server.broadcast({ type: 'history', entries: [transcriptEntry({ role: 'caller', text: 'Show me the call path.', id: 'clip-1' })] });
        server.broadcast({ type: 'display', action: { op: 'show', id: 'route', type: 'diagram', role: 'primary', data: { mode: 'graph', title: 'Route', nodes: [{ id: 'a', label: 'CALLER' }, { id: 'b', label: 'PBX' }, { id: 'c', label: 'AGENT' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] } } });
        if (card === 'note') server.broadcast({ type: 'display', action: { op: 'say', target: 'route', text: 'The PBX holds the leg while the agent starts.' } });
        else server.broadcast({ type: 'spoken', entry: transcriptEntry({ role: 'agent', text: 'The route held through the deploy.', id: 'reply-1' }) });
        const button = page.locator(card === 'note' ? '.annotation-card__history' : '.live-chat-card__history');
        await expect(button).toBeVisible();
        await expect(button).toHaveAttribute('aria-label', 'Open conversation history');
        await page.waitForTimeout(600);
        await page.keyboard.press('Shift');
        await button.focus();
        expect(await button.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
        expect(await page.evaluate(focusRingFault)).toBeNull();
      } finally {
        await server.stop();
      }
    });
  }
}

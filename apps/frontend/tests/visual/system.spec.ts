import { expect, test, type Page } from '@playwright/test';
import { DisplayFixtureServer } from '../integration/display-fixture-server.mjs';
import { FRAME_GEOMETRIES, focusRingFault, openSystem } from './helpers';

// The system view (#277), where jsdom cannot see it
// (tests/unit/systemView.test.tsx covers what it draws and what it calls):
// an agent's view("system") over the page's own socket gives the stage to
// the line. The panel stays on the stage, clear of the corner stack and of
// Damocles; every control takes a touch-sized tap and draws the page's
// focus ring; each picker and the hangup posts its page control with the
// generation the page holds (rule 7), and the report says system.
// Its goldens are in visual.spec.ts, with every other golden.

const reportedView = (server: DisplayFixtureServer) => server.reports.at(-1)?.view;

type Box = { left: number; top: number; right: number; bottom: number };
const meets = (a: Box, b: Box) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const inside = (a: Box, b: Box) => a.left >= b.left - 0.5 && a.top >= b.top - 0.5 && a.right <= b.right + 0.5 && a.bottom <= b.bottom + 0.5;

function boxes() {
  const box = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  };
  const panel = document.querySelector('[data-scene="system"] .system')!;
  const controls = [...panel.querySelectorAll<HTMLElement>('select, button')];
  return {
    stage: box(document.querySelector('.stage')!),
    panel: box(panel),
    stack: box(document.querySelector('[data-scene="system"] .channel-stack')!),
    presence: box(document.querySelector('[data-scene="system"] [data-testid="damocles-presence"]')!),
    // Each control's tap: its own box, or the 44px its ::before reaches.
    short: controls
      .filter((control) => {
        const before = getComputedStyle(control, '::before');
        const reach = before.content !== 'none' && before.position === 'absolute' ? 44 : 0;
        return Math.max(control.getBoundingClientRect().height, reach) < 44;
      })
      .map((control) => control.className || control.tagName),
    // A control whose middle another element takes, once the panel is
    // scrolled to it (a short stage scrolls the panel).
    covered: controls
      .filter((control) => {
        control.scrollIntoView({ block: 'nearest' });
        const rect = control.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return !hit || !control.contains(hit);
      })
      .map((control) => control.className || control.tagName),
  };
}

for (const geometry of FRAME_GEOMETRIES) {
  test(`system gives the line the stage, clear of the corner stack and Damocles / ${geometry.name}`, async ({ page }) => {
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    const server = new DisplayFixtureServer({ initialGeneration: 3 });
    try {
      await openSystem(page, server);
      await page.waitForTimeout(400);
      await expect(page.locator('.content-rail')).toHaveCount(0);
      const seen = await page.evaluate(boxes);
      expect(inside(seen.panel, seen.stage), 'the panel on the stage').toBe(true);
      expect(meets(seen.panel, seen.stack), 'the panel and the corner stack').toBe(false);
      expect(meets(seen.panel, seen.presence), 'the panel and Damocles').toBe(false);
      expect(seen.short, 'controls shorter than a 44px tap').toEqual([]);
      expect(seen.covered, 'controls another element covers').toEqual([]);
      await expect.poll(() => reportedView(server)).toBe('system');
    } finally {
      await server.stop();
    }
  });
}

test('every control in the system view draws the page\'s focus ring', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = new DisplayFixtureServer({ initialGeneration: 3 });
  try {
    await openSystem(page, server);
    for (const selector of ['.system__header .return-control', 'select[name="route"]', 'select[name="model"]', 'select[name="thinking"]', '.system__hangup']) {
      await page.locator(`[data-scene="system"] ${selector}`).focus();
      // Focus from script draws :focus-visible only where the last input was the keyboard.
      await page.keyboard.press('Shift');
      expect(await page.evaluate(focusRingFault), selector).toBeNull();
    }
  } finally {
    await server.stop();
  }
});

/** The page controls the page posts, by path, with their bodies. */
async function recordControls(page: Page): Promise<Array<{ path: string; body: unknown }>> {
  const posted: Array<{ path: string; body: unknown }> = [];
  for (const path of ['/connect', '/model', '/thinking', '/hangup']) {
    await page.route(`**${path}`, async (route) => {
      posted.push({ path, body: route.request().postDataJSON() });
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
  }
  return posted;
}

test('each picker and the hangup post their page control, with the generation the page holds', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = new DisplayFixtureServer({ initialGeneration: 3 });
  try {
    const posted = await recordControls(page);
    await openSystem(page, server);
    const panel = page.locator('[data-scene="system"] .system');
    await panel.locator('select[name="thinking"]').selectOption('low');
    await expect.poll(() => posted.length).toBe(1);
    await panel.locator('select[name="model"]').selectOption('anthropic/claude-opus-5');
    await expect.poll(() => posted.length).toBe(2);
    await panel.locator('.system__hangup').click();
    await expect.poll(() => posted.length).toBe(3);
    await panel.locator('select[name="route"]').selectOption('homelab');
    await expect.poll(() => posted.length).toBe(4);
    expect(posted).toEqual([
      { path: '/thinking', body: { level: 'low', generation: 3 } },
      { path: '/model', body: { model: 'anthropic/claude-opus-5', generation: 3 } },
      { path: '/hangup', body: { generation: 3 } },
      { path: '/connect', body: { project: 'homelab', generation: 3 } },
    ]);
  } finally {
    await server.stop();
  }
});

test('Esc and EXIT leave the system view for auto, and the report says so', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = new DisplayFixtureServer({ initialGeneration: 3 });
  try {
    await openSystem(page, server);
    await expect.poll(() => reportedView(server)).toBe('system');
    await page.keyboard.press('Escape');
    await expect(page.locator('.stage')).toHaveAttribute('data-view', 'auto');
    await expect(page.locator('.stage')).toHaveAttribute('data-scene-kind', 'training');
    await expect.poll(() => reportedView(server)).toBe('auto');

    server.broadcast({ type: 'view', target: 'system', reason: '' });
    await expect(page.locator('.stage')).toHaveAttribute('data-view', 'system');
    await page.locator('[data-scene="system"] .system__header .return-control').click();
    await expect(page.locator('.stage')).toHaveAttribute('data-view', 'auto');
    await expect.poll(() => reportedView(server)).toBe('auto');
  } finally {
    await server.stop();
  }
});

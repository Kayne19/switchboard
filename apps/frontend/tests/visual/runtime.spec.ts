import { expect, test } from '@playwright/test';

async function publish(page: import('@playwright/test').Page, kind: string, payload: unknown) {
  await page.evaluate(({ kind, payload }) => {
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { source: 'switchboard-legacy-runtime', kind, payload },
    }));
  }, { kind, payload });
}

test('production adapter maps backend traffic into semantic scenes', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.runtime-controls')).toBeVisible();

  await publish(page, 'state', {
    connected: true,
    recording: false,
    status: 'Connected. Tap Talk and speak.',
    handsFree: false,
    handsFreeStatus: 'Standby',
    handsFreeLease: '',
    route: 'switchboard',
    routes: [{ value: 'operator', label: 'Operator' }, { value: 'switchboard', label: 'switchboard' }],
    model: 'openai/gpt-5',
    models: [{ value: 'openai/gpt-5', label: 'openai/gpt-5' }],
    thinking: 'high',
    thinkingLevels: [{ value: 'high', label: 'thinking: high' }],
    onProject: true,
    modelDisabled: false,
    thinkingDisabled: false,
  });
  await expect(page.locator('.runtime-controls')).toContainText('LINK / ONLINE');

  await publish(page, 'server', {
    type: 'history',
    entries: [
      { role: 'caller', text: 'Show me the call path.', id: 'clip-1' },
      { role: 'agent', text: 'I have the route on screen.' },
    ],
  });
  await expect(page.locator('[data-scene="conversation"]')).toBeVisible();
  await expect(page.locator('.conversation-answer')).toContainText('I have the route on screen.');

  await publish(page, 'server', {
    type: 'diagram',
    kind: 'plan',
    title: 'Frontend cutover',
    notes: 'Transport stays isolated.',
    items: [
      { label: 'Connect transport', state: 'done' },
      { label: 'Render V17', state: 'active' },
    ],
  });
  await expect(page.locator('[data-scene="architecture"]')).toBeVisible();
  await expect(page.locator('[data-testid="diagram"]')).toContainText('Render V17');

  await publish(page, 'server', {
    type: 'diagram',
    title: 'Live route',
    source: 'flowchart TD\n  Browser[Browser] --> Agent[Project agent]',
  });
  await expect(page.locator('[data-testid="diagram"] svg')).toBeVisible();
  await expect(page.locator('[data-testid="diagram"]')).toContainText('Project agent');

  await publish(page, 'server', {
    type: 'diagram',
    kind: 'diff',
    title: 'Live changes',
    source: '@@ -1 +1 @@\n-old shell\n+new shell',
  });
  await expect(page.locator('[data-scene="code"]')).toBeVisible();
  await expect(page.locator('[data-testid="code"]')).toContainText('+new shell');

  await publish(page, 'server', { type: 'view', target: 'comms' });
  await expect(page.locator('[data-scene="conversation"]')).toBeVisible();
  await expect(page.locator('.transcript-toggle')).toBeVisible();
});

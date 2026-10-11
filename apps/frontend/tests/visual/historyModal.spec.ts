import { expect, test, type Page } from '@playwright/test';
import { DisplayFixtureServer } from '../integration/display-fixture-server.mjs';
import { transcriptEntry } from '../fixtures/serverMessages';
import { openScene } from './helpers';

// The history is a modal dialog over the scene, as the focus layer is
// (focusModal.spec.ts), and acts as one (#268): the scene it covers is inert,
// focus moves into it as it opens, Tab stays in it, and closing it gives
// focus back to what opened it. Before, it only said it was a dialog: Tab
// walked on into the hidden scene, to the presence's "Start listening".

/** The scene drawn now: the stage draws the one it goes to after one that is leaving. */
const scene = (page: Page) => page.locator('.stage > .scene').last();

/** Where the page's focus is: in the history, elsewhere on the page (named by class), or nowhere. */
const where = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return 'nowhere';
    if (active.closest('.transcript')) return 'history';
    return `outside: ${active.className || active.tagName}`;
  });

async function walk(page: Page): Promise<Set<string>> {
  const seen = new Set<string>();
  for (let step = 0; step < 16; step += 1) {
    await page.keyboard.press('Tab');
    seen.add(await where(page));
  }
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press('Shift+Tab');
    seen.add(await where(page));
  }
  return seen;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 820, height: 1180 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('the history with the line down takes focus to RETURN, keeps Tab in it, and gives focus back', async ({ page }) => {
      await openScene(page, 'conversation');
      const toggle = page.locator('.transcript-toggle');
      await toggle.focus();
      await page.keyboard.press('Enter');
      const drawer = page.getByRole('dialog', { name: 'Conversation history' });
      await expect(drawer).toBeVisible();
      await expect(drawer).toHaveAttribute('aria-modal', 'true');
      await expect(scene(page)).toHaveAttribute('inert', '');
      // The field cannot take focus while the line is down: RETURN does.
      await expect(page.locator('.transcript__return')).toBeFocused();
      const seen = await walk(page);
      expect([...seen].filter((place) => place.startsWith('outside')), 'Tab reaches nothing behind the history').toEqual([]);
      expect(seen.has('history')).toBe(true);
      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);
      await expect(scene(page)).not.toHaveAttribute('inert', /.*/);
      await expect(toggle).toBeFocused();
    });

    test('the history on a live line takes focus to its field, and gives it back to the toggle', async ({ page }) => {
      const server = new DisplayFixtureServer({ initialGeneration: 1 });
      const { wsUrl } = await server.start();
      try {
        await page.goto(`/?ws=${encodeURIComponent(wsUrl)}&chrome=0`);
        await expect.poll(() => server.frames.some((frame) => frame.type === 'hello')).toBe(true);
        server.broadcast({ type: 'history', entries: [transcriptEntry({ role: 'caller', text: 'Show me the call path.', id: 'clip-1' })] });
        const toggle = page.locator('.transcript-toggle');
        await toggle.focus();
        await page.keyboard.press('Enter');
        const drawer = page.getByRole('dialog', { name: 'Conversation history' });
        await expect(drawer.getByRole('textbox', { name: 'Conversation input' })).toBeFocused();
        await expect(scene(page)).toHaveAttribute('inert', '');
        const seen = await walk(page);
        expect([...seen].filter((place) => place.startsWith('outside')), 'Tab reaches nothing behind the history').toEqual([]);
        await page.keyboard.press('Escape');
        await expect(drawer).toHaveCount(0);
        await expect(toggle).toBeFocused();
      } finally {
        await server.stop();
      }
    });

    test('a turn sent from SEND keeps focus in the history, on the field', async ({ page }) => {
      const server = new DisplayFixtureServer({ initialGeneration: 1 });
      const { wsUrl } = await server.start();
      try {
        await page.goto(`/?ws=${encodeURIComponent(wsUrl)}&chrome=0`);
        await expect.poll(() => server.frames.some((frame) => frame.type === 'hello')).toBe(true);
        server.broadcast({ type: 'history', entries: [transcriptEntry({ role: 'caller', text: 'Show me the call path.', id: 'clip-1' })] });
        await page.locator('.transcript-toggle').focus();
        await page.keyboard.press('Enter');
        const drawer = page.getByRole('dialog', { name: 'Conversation history' });
        const field = drawer.getByRole('textbox', { name: 'Conversation input' });
        await expect(field).toBeFocused();
        await page.keyboard.type('run the tests');
        await drawer.locator('.transcript__send').focus();
        await page.keyboard.press('Enter');
        await expect(drawer.locator('.transcript-line').last()).toContainText('run the tests');
        // SEND turned disabled with the draft gone: focus did not go with it to the body.
        await expect(field).toHaveValue('');
        await expect(field).toBeFocused();
        expect(await where(page)).toBe('history');
      } finally {
        await server.stop();
      }
    });
  });
}

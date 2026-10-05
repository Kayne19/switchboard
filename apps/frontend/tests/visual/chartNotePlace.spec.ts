import { expect, test, type Page } from '@playwright/test';

// A note a chart has no clear place for stays readable beside the chart.
// Where the rail stands beside a short chart (a phone on its side) a card
// on the chart is never so short that its text is cut to nothing: a card
// gets room for its header and a few lines, and a note that cannot have
// that clear of the data leads the rail, whole, rather than fall under the
// fold of the metrics. Before, at 844x390 the training note's card had
// room for its header alone.

async function show(page: Page, scene: string, actions: unknown[] = []) {
  await page.goto(`/?scene=${scene}&chrome=0`);
  await expect(page.locator('.stage')).toBeVisible();
  if (actions.length > 0) {
    await page.evaluate((list) => {
      const run = window.SwitchboardController?.run;
      if (!run) throw new Error('controller unavailable');
      run(list);
    }, actions);
  }
  await page.waitForTimeout(900);
}

for (const scene of ['training', 'comparison']) {
  test(`on a phone on its side the ${scene} note is read whole, on the chart or leading the rail`, async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await show(page, scene);
    const geometry = await page.evaluate(() => {
      const whole = (element: HTMLElement | null) => {
        const text = element?.querySelector<HTMLElement>('.annotation-card__text');
        return text ? text.scrollHeight <= text.clientHeight + 1 && text.clientHeight > 0 : null;
      };
      const cards = [...document.querySelectorAll<HTMLElement>('.chart-note:not(.chart-note--away)')].map(whole);
      const details = document.querySelector<HTMLElement>('.content-rail__details')!;
      const note = details.querySelector<HTMLElement>('.rail-note');
      const column = details.getBoundingClientRect();
      const noteBox = note?.getBoundingClientRect();
      return {
        cards,
        rail: note ? { whole: whole(note), first: details.firstElementChild === note, inView: noteBox!.top >= column.top - 1 && noteBox!.bottom <= column.bottom + 1 } : null,
      };
    });
    for (const card of geometry.cards) expect(card).toBe(true);
    if (geometry.rail) {
      expect(geometry.rail).toEqual({ whole: true, first: true, inView: true });
    }
    expect(geometry.cards.length + (geometry.rail ? 1 : 0)).toBe(1);
  });
}

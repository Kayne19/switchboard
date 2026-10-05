import { expect, test, type Page } from '@playwright/test';

// To-do list and inbox layout the unit tests cannot see: jsdom draws no
// boxes. These hold the rules docs/visual-channel.md gives the two lists
// (a task wraps whole, a message on one line where the list has 50em, the
// columns of senders and times, sections side by side where two fit, the
// item a note names opened on and clear of the edge's fade).

const geometries = [
  { width: 390, height: 844 },
  { width: 820, height: 1180 },
  { width: 1440, height: 900 },
  { width: 2560, height: 1080 },
] as const;

async function show(page: Page, actions: unknown[], load = true) {
  if (load) await page.goto('/?scene=idle&chrome=0');
  await expect(page.locator('.stage')).toBeVisible();
  await page.evaluate((list) => {
    const controller = window.SwitchboardController;
    if (!controller) throw new Error('controller unavailable');
    controller.dispatch({ op: 'clear' });
    controller.run(list);
  }, actions);
}

// Two frames: the list measures itself and its viewport counts and leads.
const settle = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

const senders = ['Ana', 'GitHub', "Dr. Okafor's office", 'United Airlines', 'Priya', 'PG&E'];
const fifty = {
  title: 'INBOX / LAST 3 WEEKS',
  today: '2026-10-07',
  messages: Array.from({ length: 50 }, (_, i) => ({
    id: `m${i}`,
    from: senders[i % senders.length],
    subject: `Message ${i}: the subject of a message long enough to be cut on a phone`,
    snippet: 'A snippet of the body, which runs on well past the end of its one line in any slot the page has.',
    time: i < 10 ? `2026-10-07T${String(9 - (i % 10)).padStart(2, '0')}:15` : '2026-10-02',
    channel: i % 3 ? 'email' : 'slack',
    ...(i % 4 === 0 ? { unread: true } : {}),
    ...(i % 7 === 0 ? { flagged: true } : {}),
    ...(i % 9 === 0 ? { semantic: 'red' } : {}),
  })),
};
const noteOn = (target: string, item: string) => ({
  op: 'show', id: `${item}-note`, type: 'note', data: { tag: 'DAMOCLES', anchor: { target, item }, segments: [{ text: 'This one.' }] },
});

for (const viewport of geometries) {
  test(`an inbox opens on the message a note names, in full view / ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/?scene=idle&chrome=0');
    // Chromium's scroll anchoring would hold the row in place through a
    // relayout and hide a lead taken for the wrong layout; Safari has none.
    await page.addStyleTag({ content: '* { overflow-anchor: none !important; }' });
    await show(page, [{ op: 'show', id: 'inbox', type: 'inbox', role: 'primary', data: fifty }, noteOn('inbox', 'm27')], false);
    await expect(page.locator('[data-item="m27"] .note-badge')).toBeVisible();
    await settle(page);
    const box = await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>('[data-testid="inbox"] .list-viewport__scroll')!.getBoundingClientRect();
      const row = document.querySelector<HTMLElement>('[data-item="m27"]')!.getBoundingClientRect();
      return { scrollTop: scroll.top, scrollBottom: scroll.bottom, rowTop: row.top, rowBottom: row.bottom };
    });
    expect(box.rowTop).toBeGreaterThanOrEqual(box.scrollTop - 1);
    expect(box.rowBottom).toBeLessThanOrEqual(box.scrollBottom + 1);
  });
}

for (const viewport of [geometries[0], geometries[2]]) {
  test(`a long task wraps whole, never cut / ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/?scene=tasks&chrome=0');
    const text = page.locator('[data-item="claim"] .task-row__text');
    await expect(text).toBeVisible();
    const shape = await text.evaluate((element) => ({
      lines: element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight),
      overflow: element.scrollWidth - element.clientWidth,
    }));
    expect(shape.lines).toBeGreaterThan(1.5);
    expect(shape.overflow).toBeLessThanOrEqual(0);
  });
}

test('an inbox puts a message on one line where it has 50em, and stacks it where it has not', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?scene=inbox&chrome=0');
  await expect(page.locator('.inbox-primitive__rows--line')).toBeVisible();
  const line = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-item="united"]')!;
    const top = (selector: string) => row.querySelector<HTMLElement>(selector)!.getBoundingClientRect().top;
    return { sender: top('.inbox-row__sender'), subject: top('.inbox-row__subject'), height: row.getBoundingClientRect().height };
  });
  expect(Math.abs(line.sender - line.subject)).toBeLessThanOrEqual(3);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.inbox-primitive__rows--stack')).toBeVisible();
  const stack = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-item="united"]')!;
    const box = (selector: string) => row.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const snippet = row.querySelector<HTMLElement>('.inbox-row__snippet')!;
    return {
      sender: box('.inbox-row__sender').bottom,
      subject: box('.inbox-row__subject').top,
      snippetLines: snippet.getBoundingClientRect().height / parseFloat(getComputedStyle(snippet).lineHeight),
    };
  });
  expect(stack.subject).toBeGreaterThanOrEqual(stack.sender - 1);
  // A snippet holds one line and is cut at its end.
  expect(stack.snippetLines).toBeLessThan(1.5);
});

for (const viewport of geometries) {
  test(`an inbox's senders and times stand in columns, tinted rows too / ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/?scene=inbox&chrome=0');
    await expect(page.locator('[data-testid="inbox"] [data-item]').first()).toBeVisible();
    const columns = await page.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="inbox"] [data-item]')];
      const edge = (row: HTMLElement, selector: string, side: 'left' | 'right') => Math.round(row.querySelector<HTMLElement>(selector)!.getBoundingClientRect()[side]);
      return { senders: new Set(rows.map((row) => edge(row, '.inbox-row__from', 'left'))).size, times: new Set(rows.map((row) => edge(row, '.inbox-row__time', 'right'))).size };
    });
    expect(columns).toEqual({ senders: 1, times: 1 });
  });
}

test('sections stand side by side where the column holds two, and stack where it does not', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?scene=tasks&chrome=0');
  await expect(page.locator('.task-section').first()).toBeVisible();
  const boxes = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.task-section')].slice(0, 2).map((section) => {
    const box = section.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, left: box.left };
  }));
  const [work, errands] = await boxes();
  expect(Math.abs(work.top - errands.top)).toBeLessThanOrEqual(1);
  expect(errands.left).toBeGreaterThan(work.left);
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  const [first, second] = await boxes();
  expect(second.top).toBeGreaterThanOrEqual(first.bottom - 1);
});

for (const viewport of [geometries[0], geometries[2]]) {
  test(`the task a note names opens clear of the edge's fade in a short cell / ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/?scene=tasks&chrome=0');
    await expect(page.locator('[data-testid="tasks"]')).toBeVisible();
    const tasks = await page.evaluate(() => window.SwitchboardController!.state().agentObjects.todo.data);
    await show(page, [
      { op: 'show', id: 'map', type: 'diagram', role: 'primary', data: { mode: 'graph', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] } },
      { op: 'show', id: 'todo', type: 'tasks', role: 'secondary', data: tasks },
      noteOn('todo', 'pack'),
    ]);
    await expect(page.locator('.composed-aux [data-item="pack"] .note-badge')).toBeVisible();
    await settle(page);
    const box = await page.evaluate(() => {
      const cell = document.querySelector<HTMLElement>('.composed-aux [data-testid="tasks"]')!;
      const scroll = cell.querySelector<HTMLElement>('.list-viewport__scroll')!.getBoundingClientRect();
      const row = cell.querySelector<HTMLElement>('[data-item="pack"]')!.getBoundingClientRect();
      const fade = cell.querySelector<HTMLElement>('.drawing-viewport__more--bottom')?.getBoundingClientRect();
      return { rowTop: row.top, rowBottom: row.bottom, top: scroll.top, bottom: fade ? fade.top : scroll.bottom };
    });
    expect(box.rowTop).toBeGreaterThanOrEqual(box.top - 1);
    expect(box.rowBottom).toBeLessThanOrEqual(box.bottom + 1);
  });
}

test('a tinted message a note names carries the marked edge as well as its tint', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?scene=inbox&chrome=0');
  await expect(page.locator('[data-testid="inbox"]')).toBeVisible();
  const inbox = await page.evaluate(() => window.SwitchboardController!.state().agentObjects.inbox.data);
  await show(page, [{ op: 'show', id: 'inbox', type: 'inbox', role: 'primary', data: inbox }, noteOn('inbox', 'ci')]);
  const row = page.locator('[data-item="ci"]');
  await expect(row.locator('.note-badge')).toBeVisible();
  const shadow = await row.evaluate((element) => getComputedStyle(element).boxShadow);
  // The orange of the marked edge (241, 90, 36) and the red tint (198, 21, 34).
  expect(shadow).toContain('241, 90, 36');
  expect(shadow).toContain('198, 21, 34');
});

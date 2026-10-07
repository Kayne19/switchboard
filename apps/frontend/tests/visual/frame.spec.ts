import { expect, test, type Page } from '@playwright/test';
import { FRAME_GEOMETRIES, frameCrossings, openScene, runActions } from './helpers';

// Every primitive in the frame it is drawn in, at every geometry the visual
// suites use: as the primary, in focus, and beside another primary in the
// aux row. Nothing it draws crosses the frame (helpers.ts `frameCrossings`;
// calendar.spec.ts asks the same of the calendar). A list's rows, a table's
// last row, a figure's caption and a document's meta line each ran over a
// step of their frame on visual-palette, and a long first line of source ran
// under the code frame's top-right step in focus on a phone.

const table80 = {
  title: 'RUNS / 80',
  columns: [{ label: 'RUN' }, { label: 'SUITE' }, { label: 'TIME' }, { label: 'STATUS' }],
  rows: Array.from({ length: 80 }, (_, row) => [`#${1000 + row}`, ['unit', 'browser', 'rust', 'skill'][row % 4], `${(1 + ((row * 7) % 90)) / 10}s`, row % 9 ? 'pass' : { text: 'FAIL', semantic: 'red' }]),
};
const source200 = {
  title: 'SOURCE / LONG',
  file: 'long.ts',
  source: { language: 'typescript', text: Array.from({ length: 200 }, (_, line) => `const line${line} = compute(${line}, 'value');`).join('\n') },
};

interface Case {
  name: string;
  /** The fixture scene that shows it, or the object sent as the primary. */
  scene?: string;
  show?: { type: string; data: unknown };
  /** The object's type, and what its primitive is marked with. */
  type: string;
  testId: string;
}

const cases: Case[] = [
  { name: 'table', scene: 'results', type: 'table', testId: 'table' },
  { name: 'table of 80 rows', show: { type: 'table', data: table80 }, type: 'table', testId: 'table' },
  { name: 'source', scene: 'code', type: 'code', testId: 'code' },
  { name: 'source of 200 lines', show: { type: 'code', data: source200 }, type: 'code', testId: 'code' },
  { name: 'document', scene: 'email', type: 'document', testId: 'document' },
  { name: 'to-do list', scene: 'tasks', type: 'tasks', testId: 'tasks' },
  { name: 'inbox', scene: 'inbox', type: 'inbox', testId: 'inbox' },
  { name: 'forecast', scene: 'weather', type: 'weather', testId: 'weather' },
  { name: 'timers', scene: 'timer', type: 'timer', testId: 'timer' },
  { name: 'graph', scene: 'architecture', type: 'diagram', testId: 'diagram' },
  { name: 'topology', scene: 'topology', type: 'diagram', testId: 'diagram' },
  { name: 'sequence', scene: 'trace', type: 'diagram', testId: 'sequence' },
  { name: 'line chart', scene: 'training', type: 'chart', testId: 'chart' },
  { name: 'bar chart', scene: 'comparison', type: 'chart', testId: 'chart' },
  { name: 'figure', scene: 'figure', type: 'image', testId: 'image' },
];

// A primary beside which another stands in the aux row (a source beside a table).
const aside = {
  code: { op: 'show', id: 'aside', type: 'table', role: 'primary', data: { title: 'GRID', columns: [{ label: 'A' }], rows: [['x']] } },
  other: { op: 'show', id: 'aside', type: 'code', role: 'primary', data: { title: 'SOURCE / ROUTER', file: 'router.rs', source: { language: 'rust', text: 'fn route(call: &Call) -> Leg {\n    Leg::operator()\n}' } } },
};

async function open(page: Page, item: Case): Promise<string> {
  await openScene(page, item.scene ?? 'idle');
  if (item.show) await runActions(page, [{ op: 'clear' }, { op: 'show', id: 'shown', type: item.show.type, role: 'primary', data: item.show.data }]);
  await expect(page.locator(`.scene [data-testid="${item.testId}"]`).first()).toBeVisible();
  // Let it be measured and laid out on it.
  await page.waitForTimeout(500);
  return page.evaluate((type) => Object.values(window.SwitchboardController!.state().agentObjects).find((object) => object.type === type)!.id, item.type);
}

for (const geometry of FRAME_GEOMETRIES) {
  test.describe(`${geometry.name} frames`, () => {
    test.use({ viewport: { width: geometry.width, height: geometry.height } });

    for (const item of cases) {
      test(`${item.name}: nothing it draws crosses its frame, as the primary, in focus, or beside another primary`, async ({ page }) => {
        const selector = `[data-testid="${item.testId}"]`;
        const id = await open(page, item);
        const hits = await page.evaluate(frameCrossings, `.scene ${selector}`);
        await runActions(page, [{ op: 'focus', id }]);
        await expect(page.locator(`.focus-layer ${selector}`)).toBeVisible();
        // Past the focus layer's layout transition (0.46 s), and the measure after it.
        await page.waitForTimeout(700);
        hits.push(...(await page.evaluate(frameCrossings, `.focus-layer ${selector}`)));
        await open(page, item);
        // The same object, sent again beside another primary (a graph says its mode, as the wire asks).
        const data = await page.evaluate((key) => {
          const sent = window.SwitchboardController!.state().agentObjects[key].data as Record<string, unknown>;
          return sent.nodes && !sent.mode ? { ...sent, mode: 'graph' } : sent;
        }, id);
        await runActions(page, [{ op: 'clear' }, { op: 'show', id, type: item.type, role: 'secondary', data }, item.type === 'code' ? aside.code : aside.other]);
        await expect(page.locator(`.composed-aux-object ${selector}`)).toBeVisible();
        await page.waitForTimeout(500);
        hits.push(...(await page.evaluate(frameCrossings, `.composed-aux-object ${selector}`)));
        expect(hits).toEqual([]);
      });
    }

    // A table and a source stand their scroll between the code frame's steps
    // by one rule: the step (the clip's 5.7% at the top right, 4.6% at the
    // bottom left) and the same gap from each. The table cleared the top
    // step with its padding and meta line instead: its header ran 2 px under
    // the step in focus at 820x1180, and short of the gap in several slots.
    test('table and source: the scroll stands a step and a gap from each of the frame\'s steps, as the primary, in focus, and beside another primary', async ({ page }) => {
      const clearance = (selector: string) => page.evaluate((root) => {
        const pane = document.querySelector(root)!;
        const mask = pane.querySelector('.code-viewport__mask, .table-viewport__mask')!.getBoundingClientRect();
        const port = pane.querySelector('.list-viewport__port')!.getBoundingClientRect();
        // The mask's gap: clamp(6px, 0.9cqh, 12px) of the stage.
        const gap = Math.min(12, Math.max(6, 0.009 * document.querySelector('.stage')!.clientHeight));
        return {
          top: Math.round(port.top - mask.top - (0.057 * mask.height + gap)) >= 0,
          bottom: Math.round(mask.bottom - port.bottom - (0.046 * mask.height + gap)) >= 0,
        };
      }, selector);
      for (const name of ['table of 80 rows', 'source of 200 lines']) {
        const item = cases.find((each) => each.name === name)!;
        const selector = `[data-testid="${item.testId}"]`;
        const id = await open(page, item);
        expect(await clearance(`.scene ${selector}`), `${name} as the primary`).toEqual({ top: true, bottom: true });
        await runActions(page, [{ op: 'focus', id }]);
        await expect(page.locator(`.focus-layer ${selector}`)).toBeVisible();
        await page.waitForTimeout(700);
        expect(await clearance(`.focus-layer ${selector}`), `${name} in focus`).toEqual({ top: true, bottom: true });
        const data = await page.evaluate((key) => window.SwitchboardController!.state().agentObjects[key].data, id);
        await runActions(page, [{ op: 'clear' }, { op: 'show', id, type: item.type, role: 'secondary', data }, item.type === 'code' ? aside.code : aside.other]);
        await expect(page.locator(`.composed-aux-object ${selector}`)).toBeVisible();
        await page.waitForTimeout(500);
        expect(await clearance(`.composed-aux-object ${selector}`), `${name} beside another primary`).toEqual({ top: true, bottom: true });
      }
    });

    // Scrolled to the middle, a line passes under neither of the source
    // frame's steps: the scroll stands between them (it passed under the
    // top-right one at every geometry).
    test('source of 200 lines, scrolled: no line passes under its frame, as the primary or in focus', async ({ page }) => {
      const item = cases.find((each) => each.name === 'source of 200 lines')!;
      const id = await open(page, item);
      const scrolledHits = async (where: string) => {
        await page.evaluate((selector) => {
          const scroll = document.querySelector<HTMLElement>(selector)!;
          scroll.scrollTop = Math.round((scroll.scrollHeight - scroll.clientHeight) / 2);
        }, `${where} .code-viewport__scroll`);
        await page.waitForTimeout(300);
        return page.evaluate(frameCrossings, `${where} [data-testid="code"]`);
      };
      const hits = await scrolledHits('.scene');
      await runActions(page, [{ op: 'focus', id }]);
      await expect(page.locator('.focus-layer [data-testid="code"]')).toBeVisible();
      await page.waitForTimeout(700);
      hits.push(...(await scrolledHits('.focus-layer')));
      expect(hits).toEqual([]);
    });
  });
}

// The scene's heading names the primary by its title, up to 128 characters:
// a long one is cut with an ellipsis at the stage's edge. An unbroken one
// ran off the screen.
for (const geometry of FRAME_GEOMETRIES) {
  test(`a long title stays inside the stage / ${geometry.name}`, async ({ page }) => {
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    await openScene(page, 'idle');
    for (const title of ['P'.repeat(128), 'WORD '.repeat(25).trim()]) {
      await runActions(page, [{ op: 'clear' }, { op: 'show', id: 'grid', type: 'table', role: 'primary', data: { title, subtitle: title, columns: [{ label: 'A' }], rows: [['x']] } }]);
      await page.waitForTimeout(300);
      const boxes = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const title = document.querySelector<HTMLElement>('.scene-heading__title')!;
        return { title: box('.scene-heading__title'), sub: box('.scene-heading__sub'), stage: box('.stage'), grid: box('.content-grid'), clipped: title.scrollWidth > title.clientWidth };
      });
      expect(boxes.title.right, title).toBeLessThanOrEqual(boxes.stage.right);
      expect(boxes.sub.right, title).toBeLessThanOrEqual(boxes.stage.right);
      expect(boxes.sub.bottom, title).toBeLessThanOrEqual(boxes.grid.top);
    }
  });
}

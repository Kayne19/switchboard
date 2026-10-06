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

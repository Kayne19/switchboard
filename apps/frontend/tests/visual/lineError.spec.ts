import { expect, test, type Page } from '@playwright/test';
import { DisplayFixtureServer } from '../integration/display-fixture-server.mjs';
import { statusMessage, transcriptEntry } from '../fixtures/serverMessages';
import { fixtures } from '../../src/fixtures/scenes';
import { FRAME_GEOMETRIES } from './helpers';

// A line error (a refused microphone, a dropped line, a server error) is
// drawn on every page the caller can tap Damocles on, where jsdom cannot
// see it (tests/unit/lineError.test.tsx covers what is drawn): it stands
// on the stage, clear of everything else the page draws, a long one
// scrolling in its own box, and MODE keeps its tap. The system view shows
// it as its STATUS row instead. An error about a leg leaves with that leg,
// on the real page in both engines.

// A status line the runtime says (PlaybackStatus.overLimit), long enough to
// wrap on a phone's stage; and a server error past the error's height cap,
// as an ElevenLabs failure forwards up to 500 characters of its body.
const ERRORS = [
  { name: 'a status line', text: "Too much reply audio is waiting to play. This reply's audio stops partway, and its full text is in the transcript." },
  { name: 'a long server error', text: `ElevenLabs TTS failed (429): ${'{"detail":{"status":"quota_exceeded","message":"This request exceeds your quota. You have 0 credits remaining."}} '.repeat(5).trim()}` },
];

// The frame geometries, and the iPad's: portrait and landscape at 820 and
// at the 13-inch iPad Pro's 1032 (docs/ipad.md).
const SIZES = [
  ...FRAME_GEOMETRIES,
  { name: 'ipad-landscape', width: 1180, height: 820 },
  { name: 'ipad-pro-portrait', width: 1032, height: 1376 },
  { name: 'ipad-pro-landscape', width: 1376, height: 1032 },
];

const table = {
  op: 'show', id: 'news', type: 'table', role: 'primary',
  data: { title: 'WHAT IS NEW', columns: [{ label: 'CHANGE' }, { label: 'WHO' }], rows: [['one', 'a'], ['two', 'b']] },
};
const note = {
  op: 'show', id: 'why', type: 'note',
  data: { tag: 'NOTE', segments: [{ text: 'One change, made by a, and a second made by b.' }], anchor: { target: 'news' } },
};

type Box = { left: number; top: number; right: number; bottom: number };

/** The error the scene draws, and every other part of the scene it must stand clear of. */
function seen() {
  const scene = [...document.querySelectorAll('[data-scene]')].at(-1)!;
  const box = (element: Element): Box => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  };
  const parts = [
    '[data-testid="damocles-presence"]',
    '.channel-stack__channel',
    '.channel-stack__mode',
    '.transcript-toggle',
    '.scene-heading',
    '.scene-footer > span',
    '.content-main',
    '.content-rail',
    '.conversation-answer',
    '.tool-activity',
    '.theater__header',
    '.theater__box',
  ];
  const mode = scene.querySelector('.channel-stack__mode')!.getBoundingClientRect();
  const hit = document.elementFromPoint(mode.left + mode.width / 2, mode.top + mode.height / 2);
  // What the error draws: its lines, not the gap it keeps under them.
  const lines = [...scene.querySelector('.channel-stack__error')!.children].map(box);
  return {
    stage: box(document.querySelector('.stage')!),
    error: {
      left: Math.min(...lines.map((line) => line.left)),
      top: Math.min(...lines.map((line) => line.top)),
      right: Math.max(...lines.map((line) => line.right)),
      bottom: Math.max(...lines.map((line) => line.bottom)),
    },
    others: parts.flatMap((selector) => [...scene.querySelectorAll(selector)].map((element) => ({ selector, box: box(element) }))),
    modeTakesItsTap: Boolean(hit?.closest('.channel-stack__mode')),
  };
}

const meets = (a: Box, b: Box) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const inside = (a: Box, b: Box) => a.left >= b.left - 0.5 && a.top >= b.top - 0.5 && a.right <= b.right + 0.5 && a.bottom <= b.bottom + 0.5;

async function drawnClear(page: Page, kind: string, error: string) {
  await expect(page.locator('[data-scene]'), `${kind}: one scene on the stage`).toHaveCount(1);
  const scene = page.locator(`[data-scene="${kind}"]`);
  await expect(scene.getByText(error), `${kind}: the error the caller must read`).toBeVisible();
  await expect(scene.locator('.channel-stack__error'), `${kind}: drawn as the line's error`).toContainText('LINE / ERROR');
  await expect(scene.getByText(error), `${kind}: drawn once, never in the rail's note slot`).toHaveCount(1);
  const drawn = await page.evaluate(seen);
  expect(inside(drawn.error, drawn.stage), `${kind}: the error on the stage`).toBe(true);
  expect(drawn.others.filter((other) => meets(drawn.error, other.box)).map((other) => other.selector), `${kind}: what the error meets`).toEqual([]);
  expect(drawn.modeTakesItsTap, `${kind}: MODE takes its tap`).toBe(true);
}

for (const size of SIZES) for (const error of ERRORS) {
  test(`${error.name} reads on every page, clear of the rest / ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const server = new DisplayFixtureServer({ initialGeneration: 2 });
    try {
      const { wsUrl } = await server.start();
      await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
      await expect.poll(() => server.frames.some((frame) => frame.type === 'hello')).toBe(true);
      server.broadcast({ type: 'error', message: error.text });
      await drawnClear(page, 'idle', error.text);

      server.broadcast({
        type: 'history',
        entries: [
          transcriptEntry({ role: 'caller', text: 'What is new?', id: 'clip-1' }),
          transcriptEntry({ role: 'agent', text: 'Two changes landed today.', id: 'reply-1', voiced: true }),
        ],
      });
      server.broadcast({ type: 'activity', state: 'start', tool: 'read', detail: 'apps/backend/src/api.rs', label: 'switchboard' });
      await expect(page.locator('.tool-activity')).toBeVisible();
      await drawnClear(page, 'conversation', error.text);

      server.broadcast({ type: 'display', action: table });
      await drawnClear(page, 'table', error.text);
      server.broadcast({ type: 'display', action: note });
      await drawnClear(page, 'table', error.text);

      server.broadcast({ type: 'display', action: { op: 'clear' } });
      for (const action of fixtures.training) server.broadcast({ type: 'display', action });
      await drawnClear(page, 'training', error.text);

      server.broadcast({ type: 'view', target: 'theater', reason: '' });
      await drawnClear(page, 'theater', error.text);

      server.broadcast({ type: 'view', target: 'system', reason: '' });
      const system = page.locator('[data-scene="system"]');
      await expect(system.locator('.system__status'), 'system: said in its STATUS row').toContainText(error.text);
      await expect(system.locator('.channel-stack__error'), 'system: not over the corner stack').toHaveCount(0);
      await expect(system.getByText(error.text), 'system: said only there').toHaveCount(1);
    } finally {
      await server.stop();
    }
  });
}

const TURN_FAILED = 'The call worker failed on that turn: the operator stopped answering.';

function hangUpFromAProjectLeg(server: DisplayFixtureServer) {
  server.setGeneration(server.generation + 1);
  server.broadcast({ type: 'epoch', generation: server.generation });
  server.broadcast(statusMessage({ route: 'operator', label: 'Operator' }));
  server.broadcast({
    type: 'spoken',
    entry: transcriptEntry({ role: 'agent', text: 'Call ended. You are back with the operator.', id: 'hangup-1', voiced: true }),
  });
}

function backWithTheOperator(server: DisplayFixtureServer) {
  server.broadcast({ type: 'epoch', generation: server.generation });
  server.broadcast(statusMessage({ route: 'operator', label: 'Operator' }));
  server.broadcast({
    type: 'spoken',
    entry: transcriptEntry({ role: 'agent', text: 'You are back with the operator.', id: 'return-1', voiced: true }),
  });
}

test('a turn error leaves with the call it failed on', async ({ page }) => {
  const server = new DisplayFixtureServer({ initialGeneration: 2 });
  try {
    const { wsUrl } = await server.start();
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => server.frames.some((frame) => frame.type === 'hello')).toBe(true);
    server.broadcast(statusMessage({ route: 'switchboard', label: 'switchboard' }));
    server.broadcast({ type: 'display', action: table });
    await expect(page.locator('[data-scene="table"]')).toHaveCount(1);
    server.broadcast({ type: 'error', message: TURN_FAILED });
    await expect(page.getByText(TURN_FAILED), 'up while the call lasts').toBeVisible();

    hangUpFromAProjectLeg(server);
    await expect(page.locator('[data-scene="conversation"]'), 'the hangup line opens the conversation').toHaveCount(1);
    await expect(page.locator('.channel-stack__error'), 'gone with the call').toHaveCount(0);

    server.broadcast({ type: 'display', action: { ...table, id: 'next' } });
    await expect(page.locator('[data-scene="table"]')).toHaveCount(1);
    await expect(page.locator('.channel-stack__error'), "not on the next call's first visual").toHaveCount(0);
  } finally {
    await server.stop();
  }
});

test("a project leg's turn error leaves when the caller is back with the operator", async ({ page }) => {
  const server = new DisplayFixtureServer({ initialGeneration: 2 });
  try {
    const { wsUrl } = await server.start();
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => server.frames.some((frame) => frame.type === 'hello')).toBe(true);
    server.broadcast(statusMessage({ route: 'switchboard', label: 'switchboard' }));
    server.broadcast({ type: 'display', action: table });
    await expect(page.locator('[data-scene="table"]')).toHaveCount(1);
    server.broadcast({ type: 'error', message: TURN_FAILED });
    await expect(page.getByText(TURN_FAILED), 'up while the leg lasts').toBeVisible();

    backWithTheOperator(server);
    await expect(page.locator('[data-scene="conversation"]'), "the operator's conversation").toHaveCount(1);
    await expect(page.locator('.channel-stack__error'), 'gone with the leg').toHaveCount(0);
  } finally {
    await server.stop();
  }
});

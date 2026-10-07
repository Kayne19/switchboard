import { expect, test, type Page } from '@playwright/test';
import { DisplayFixtureServer } from '../integration/display-fixture-server.mjs';
import { statusMessage, transcriptEntry } from '../fixtures/serverMessages';

async function openController(page: Page) {
  await page.goto('/?scene=architecture&chrome=0');
  await expect(page.locator('.stage')).toBeVisible();
}

async function showSecondaryMetricAndNote(page: Page, order: 'metric-first' | 'note-first') {
  await page.evaluate((requestedOrder) => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'quality-map', type: 'diagram', role: 'primary',
      data: {
        mode: 'graph', title: 'QUALITY PATH',
        nodes: [{ id: 'sample', label: 'SAMPLE' }, { id: 'score', label: 'SCORE' }],
        edges: [{ from: 'sample', to: 'score' }],
      },
    });
    const metric = {
      op: 'show', id: 'quality', type: 'metric', role: 'secondary',
      data: { label: 'QUALITY', value: '98.4%', semantic: 'green', caption: 'MODEL / HOLDOUT' },
    };
    const note = {
      op: 'show', id: 'quality-note', type: 'note', role: 'secondary',
      data: {
        tag: 'OBSERVATION',
        segments: [{ text: 'Quality remains above the release threshold.' }],
        anchor: { target: 'quality' },
      },
    };
    for (const action of requestedOrder === 'metric-first' ? [metric, note] : [note, metric]) {
      dispatch(action);
    }
  }, order);
  await expect(page.locator('[data-scene="architecture"]')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByText('98.4%', { exact: true })).toBeVisible();
  await expect(page.getByText('Quality remains above the release threshold.', { exact: true })).toHaveCount(1);
}

test('secondary metric and note compose in either action order without oversized metric allocation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);

  for (const order of ['metric-first', 'note-first'] as const) {
    await showSecondaryMetricAndNote(page, order);
    const geometry = await page.evaluate(() => {
      const metric = document.querySelector<HTMLElement>('.metric-row')!;
      const note = document.querySelector<HTMLElement>('.annotation-card')!;
      const main = document.querySelector<HTMLElement>('.content-main')!;
      const rail = document.querySelector<HTMLElement>('.content-rail')!;
      const metricBox = metric.getBoundingClientRect();
      const noteBox = note.getBoundingClientRect();
      return {
        metricHeight: metricBox.height,
        mainHeight: main.getBoundingClientRect().height,
        railHeight: rail.getBoundingClientRect().height,
        overlap: !(
          metricBox.right <= noteBox.left
          || noteBox.right <= metricBox.left
          || metricBox.bottom <= noteBox.top
          || noteBox.bottom <= metricBox.top
        ),
      };
    });
    expect(geometry.overlap, order).toBe(false);
    expect(geometry.metricHeight, order).toBeLessThan(geometry.railHeight * 0.55);
    expect(geometry.metricHeight, order).toBeLessThan(geometry.mainHeight * 0.55);
  }
});

test('primary metric is a compact angular card and uses its configured caption', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'latency', type: 'metric', role: 'primary',
      data: { label: 'P95 LATENCY', value: '182 ms', semantic: 'cyan', caption: 'EDGE / LAST 5 MIN' },
    });
  });

  const metric = page.locator('.metrics--primary .metric-row');
  await expect(metric).toBeVisible();
  await expect(page.locator('.scene-footer span').last()).toHaveText('EDGE / LAST 5 MIN');
  const style = await metric.evaluate((element) => {
    const metricBox = element.getBoundingClientRect();
    const mainBox = document.querySelector<HTMLElement>('.content-main')!.getBoundingClientRect();
    return {
      clipPath: getComputedStyle(element).clipPath,
      metricHeight: metricBox.height,
      mainHeight: mainBox.height,
    };
  });
  expect(style.clipPath).toContain('polygon');
  expect(style.metricHeight).toBeLessThan(style.mainHeight * 0.55);
});

// A value is a percentage, so `1` is one percent, never a full bar (#33).
test('progress value of 1 fills one percent, not the whole bar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'deploy-progress', type: 'progress', role: 'primary',
      data: { label: 'DEPLOY', value: 1 },
    });
  });

  await expect.poll(() => page.locator('.progress-primitive').evaluate((element) => {
    const track = element.querySelector<HTMLElement>('.progress-primitive__track')!;
    const fill = element.querySelector<HTMLElement>('.progress-primitive__fill')!;
    return fill.getBoundingClientRect().width / track.getBoundingClientRect().width;
  })).toBeCloseTo(0.01, 2);
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  await expect(page.locator('.progress-primitive__text')).toHaveText('1% COMPLETE');
});

test('explicit anchored note survives later chat messages', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 5 });
  const { wsUrl } = await fixtureServer.start();

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
    fixtureServer.broadcast({
      type: 'display',
      action: {
        op: 'show', id: 'loss', type: 'chart', role: 'primary',
        data: {
          title: 'Validation loss', xMax: 40, yMin: 0, yMax: 1,
          series: [{ name: 'VAL LOSS', values: [0.8, 0.5, 0.3, 0.45] }],
        },
      },
    });
    fixtureServer.broadcast({
      type: 'display',
      action: {
        op: 'show', id: 'spike-note', type: 'note', role: 'secondary',
        data: {
          tag: 'LOOK HERE',
          segments: [{ text: 'This annotation stays attached to the validation spike.' }],
          anchor: { target: 'loss', x: 32, series: 'VAL LOSS' },
        },
      },
    });

    const note = page.locator('.chart-note .annotation-card');
    await expect(note).toHaveAttribute('data-anchor-target', 'loss');
    await expect(note).toContainText('This annotation stays attached to the validation spike.');
    await expect(page.locator('.chart-note')).toHaveClass(/chart-note--anchored/);
    const noteOverflow = await note.locator('.annotation-card__text').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(noteOverflow.scrollWidth).toBeLessThanOrEqual(noteOverflow.clientWidth + 1);

    fixtureServer.broadcast({ type: 'spoken', entry: transcriptEntry({ role: 'agent', text: 'A newer chat response.', id: 'reply-2' }) });
    await expect(note).toContainText('This annotation stays attached to the validation spike.');
    await expect(note).not.toContainText('A newer chat response.');
    await expect(note.locator('.annotation-card__history')).toHaveCount(0);
  } finally {
    await fixtureServer.stop();
  }
});

// #49 and #26: every note on a chart is shown over the plot, clear of the
// others, and the chart keeps its size for them; a note that names a point
// runs its leader out of its card's border to the point on the line. A
// stepped plan under the chart leaves it short, and the rule holds there
// too: a card that could sit level with its point, its leader leaving by a
// side, sits above or below. Where the chart has no place for every card,
// one note is in the rail: which one is the placement's rule
// (notePlacement.test.ts).
const stepsUnderTheChart = [
  { label: 'WARMUP', state: 'done', detail: 'EPOCHS 1-5 / LR RAMP' },
  { label: 'STAGE 1 / FULL RES', state: 'done', detail: 'EPOCHS 6-30' },
  { label: 'LR TRANSITION', state: 'done', detail: 'EPOCH 31 / COSINE DECAY' },
  { label: 'STAGE 2 / FINE', state: 'active', detail: 'EPOCHS 32-70 / VAL DIVERGING' },
  { label: 'EVAL / HELD-OUT SEEDS', detail: 'EPOCHS 71-80' },
  { label: 'EXPORT CHECKPOINT' },
];
const chartNoteCases = ['', ' on a short chart'].flatMap((chart) =>
  [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 2560, height: 1080 }].map((viewport) => ({ chart, viewport })),
);
for (const { chart, viewport } of chartNoteCases) {
  test(`every note on a chart shows over it without covering another${chart} at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/?scene=training&chrome=0');
    await expect(page.locator('.chart-note')).toHaveCount(1);
    const chartBox = async () => page.locator('.chart-object[data-chart-id="loss"] .chart-primitive > svg').evaluate((svg) => {
      const box = svg.getBoundingClientRect();
      return { width: box.width, height: box.height };
    });
    if (chart) {
      const tall = await chartBox();
      await page.evaluate((steps) => {
        const run = window.SwitchboardController?.run;
        if (!run) throw new Error('controller unavailable');
        run([{
          op: 'show', id: 'progress', type: 'progress',
          data: { label: 'EPOCH 41 / 80', detail: 'ACTIVE / OPTIMIZER STEP 18442', value: 51.25, text: '51.25% COMPLETE', steps },
        }]);
      }, stepsUnderTheChart);
      await expect(page.locator('.progress-step[data-state]')).toHaveCount(stepsUnderTheChart.length);
      // The chart shrinks over a few frames: wait until it holds one size,
      // and test a short chart only while the plan really shortens it.
      await expect.poll(async () => {
        const first = await chartBox();
        await page.waitForTimeout(250);
        const then = await chartBox();
        return first.width === then.width && first.height === then.height && then.height < tall.height - 60;
      }).toBe(true);
    }
    const before = await chartBox();

    await page.evaluate(() => {
      const dispatch = window.SwitchboardController?.dispatch;
      if (!dispatch) throw new Error('controller unavailable');
      dispatch({
        op: 'show', id: 'general-note', type: 'note',
        data: { tag: 'NOTE / GENERAL', segments: [{ text: 'A second note that names no point. It must still be on screen.' }] },
      });
      dispatch({
        op: 'show', id: 'early-note', type: 'note',
        data: {
          tag: 'EARLY / EPOCH 6', anchor: { target: 'loss', x: 6, series: 'TRAIN LOSS' },
          segments: [{ text: 'Both losses fall together through the warmup.' }],
        },
      });
    });
    // A card the chart keeps over it, or the one it leaves out: in the rail,
    // or where the rail stands under the chart (a portrait stage), in a band
    // under the chart that takes its height from it (chartNotePlace.spec.ts).
    await expect.poll(async () => (await page.locator('.chart-note').count()) + (await page.locator('.chart-note-band').count())).toBe(3);
    await page.waitForTimeout(400);
    const band = await page.locator('.chart-note-band').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
    if (band.length === 0) {
      expect(await chartBox()).toEqual(before);
    } else {
      // The chart keeps its width and gives the band no more than its own
      // height and the gap over it.
      const after = await chartBox();
      expect(viewport.height).toBeGreaterThan(viewport.width);
      expect(after.width).toBe(before.width);
      expect(before.height - after.height).toBeLessThanOrEqual(band[0] + 24);
    }

    const geometry = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.chart-object[data-chart-id="loss"]')!.getBoundingClientRect();
      const layer = document.querySelector<HTMLElement>('.chart-notes')!.getBoundingClientRect();
      // A note with no place on the chart clear of its data is shown in
      // the rail; its card stays in the layer out of view, to be measured.
      const cards = [...document.querySelectorAll<HTMLElement>('.chart-note:not(.chart-note--away)')].map((element) => {
        const box = element.getBoundingClientRect();
        return { id: element.dataset.note!, left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      });
      const away = [...document.querySelectorAll<HTMLElement>('.chart-note--away')].map((element) => ({
        id: element.dataset.note!,
        hidden: getComputedStyle(element).visibility === 'hidden',
        text: element.querySelector('.annotation-card__text')?.textContent ?? '',
      }));
      const rail = document.querySelector<HTMLElement>('.content-rail .rail-note')?.textContent ?? '';
      const band = document.querySelector<HTMLElement>('.chart-note-band')?.textContent ?? null;
      // Each series' line as drawn, on the page.
      const svg = document.querySelector<SVGSVGElement>('.chart-object[data-chart-id="loss"] .chart-primitive > svg')!;
      const matrix = svg.getScreenCTM()!;
      const lines = Object.fromEntries([...svg.querySelectorAll('.chart-series-group')].map((group) => [
        group.getAttribute('data-series')!,
        [...group.querySelector('.chart-series')!.getAttribute('d')!.matchAll(/[ML] ([-\d.]+) ([-\d.]+)/g)].map((match) => {
          const [x, y] = [Number(match[1]), Number(match[2])];
          return { x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f };
        }),
      ]));
      const values = document.querySelectorAll('.chart-marker__value').length;
      const leaders = [...document.querySelectorAll<SVGGElement>('.chart-note-leader')].map((group) => ({
        id: group.dataset.note!,
        points: group.querySelector('polyline')!.getAttribute('points')!.split(' ').map((pair) => {
          const [x, y] = pair.split(',').map(Number);
          return { x: layer.left + x, y: layer.top + y };
        }),
      }));
      return { panel: { left: panel.left, top: panel.top, right: panel.right, bottom: panel.bottom }, cards, leaders, away, rail, band, lines, values };
    });

    // Every note is on screen: on the chart, or -- one at most, where the
    // chart has no place for it clear of its data -- in the rail, and on a
    // portrait stage one in the band under the chart.
    expect(geometry.cards.length + geometry.away.length + (geometry.band === null ? 0 : 1)).toBe(3);
    expect(geometry.away.length).toBeLessThanOrEqual(1);
    if (geometry.band !== null) {
      expect(['Both losses fall together through the warmup.', 'A second note that names no point. It must still be on screen.', 'Validation loss'].some((text) => geometry.band!.includes(text))).toBe(true);
    }
    for (const note of geometry.away) {
      expect(note.hidden, `${note.id} is out of view on the chart`).toBe(true);
      expect(geometry.rail, `${note.id} is in the rail`).toContain(note.text);
    }

    for (const [index, card] of geometry.cards.entries()) {
      expect(card.left).toBeGreaterThanOrEqual(geometry.panel.left - 1);
      expect(card.right).toBeLessThanOrEqual(geometry.panel.right + 1);
      expect(card.top).toBeGreaterThanOrEqual(geometry.panel.top - 1);
      expect(card.bottom).toBeLessThanOrEqual(geometry.panel.bottom + 1);
      for (const other of geometry.cards.slice(index + 1)) {
        const apart = card.right <= other.left + 0.5 || other.right <= card.left + 0.5 || card.bottom <= other.top + 0.5 || other.bottom <= card.top + 0.5;
        expect(apart, `${card.id} and ${other.id} must not overlap`).toBe(true);
      }
    }
    // Every note on the chart that names a point runs a leader to it; one in
    // the band under the chart names its point in its target line instead.
    expect(geometry.leaders.map((leader) => leader.id).sort()).toEqual(
      ['early-note', 'training-note'].filter((id) => geometry.cards.some((card) => card.id === id)),
    );
    // No value is printed by a point on a line: the leader marks it.
    expect(geometry.values).toBe(0);
    for (const leader of geometry.leaders) {
      const card = geometry.cards.find((candidate) => candidate.id === leader.id)!;
      const start = leader.points[0];
      // It begins on the card's bottom or top border.
      const onEdge = Math.abs(start.y - (card.bottom - 0.5)) <= 1 || Math.abs(start.y - (card.top + 0.5)) <= 1;
      expect(onEdge, `${leader.id} leader starts on its card's border`).toBe(true);
      expect(start.x).toBeGreaterThanOrEqual(card.left);
      expect(start.x).toBeLessThanOrEqual(card.right);
      // It ends on the line of the series its note names.
      const line = geometry.lines[{ 'training-note': 'VAL LOSS', 'early-note': 'TRAIN LOSS' }[leader.id as 'training-note' | 'early-note']];
      const end = leader.points.at(-1)!;
      const off = Math.min(...line.slice(1).map((b, index) => {
        const a = line[index];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((end.x - a.x) * dx + (end.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(end.x - (a.x + dx * t), end.y - (a.y + dy * t));
      }));
      expect(off, `${leader.id} leader ends on its point's line`).toBeLessThanOrEqual(1.5);
    }
  });
}

// A bar is an area, not a line: a note on a bar chart keeps clear of every
// bar it does not name, a few pixels away, so it never reads as resting on
// them (Kayne saw the comparison note sit over the tallest bars).
for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test(`a note on a bar chart covers no bar at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/?scene=comparison&chrome=0');
    await expect(page.locator('.chart-note')).toHaveCount(1);
    await page.waitForTimeout(400);
    const geometry = await page.evaluate(() => {
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      };
      const card = document.querySelector('.chart-note')!;
      return {
        away: card.classList.contains('chart-note--away'),
        card: box(card),
        bars: [...document.querySelectorAll('.chart-bar')].map(box).filter((bar) => bar.bottom - bar.top > 0.5),
        leader: document.querySelector('.chart-note-leader polyline')?.getAttribute('points') ?? null,
      };
    });
    expect(geometry.away).toBe(false);
    // Twelve bars; the two smallest pairs are under a pixel tall on a phone.
    expect(geometry.bars.length).toBeGreaterThanOrEqual(8);
    for (const bar of geometry.bars) {
      const apart = geometry.card.right + 4 <= bar.left || bar.right + 4 <= geometry.card.left
        || geometry.card.bottom + 4 <= bar.top || bar.bottom + 4 <= geometry.card.top;
      expect(apart, `the card keeps clear of the bar at ${Math.round(bar.left)},${Math.round(bar.top)}`).toBe(true);
    }
    expect(geometry.leader).not.toBeNull();
  });
}

// The note on a bar chart read oddly when its card sat
// across the plot's border (half in the plot, half above it) or jammed in
// the band under the frame's rail, its leader ended by the grey bar beside
// the one it named, and that bar was marked only by a ring on its edge. A
// card on a bar chart lies wholly inside the plot or wholly outside it, its
// leader runs clear of every other bar to the value the named bar prints,
// and the bar itself is marked.
const barNoteCases = [
  { width: 1440, height: 900 }, { width: 2560, height: 1080 }, { width: 1280, height: 720 },
  { width: 820, height: 1180 }, { width: 390, height: 844 },
].flatMap((viewport) => [{ viewport, two: false }, { viewport, two: true }]);
for (const { viewport, two } of barNoteCases) {
  test(`a note on a bar chart lies wholly in or out of the plot, its leader joining it to its bar${two ? ', two notes' : ''} at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/?scene=comparison&chrome=0');
    if (two) {
      await page.evaluate(() => {
        window.SwitchboardController!.dispatch({
          op: 'show', id: 'backend-note', type: 'note',
          data: { tag: 'OBSERVATION / BACKEND', anchor: { target: 'durations', x: 0, series: 'PREVIOUS RUN' }, segments: [{ text: 'The backend suite is the other long pole, and it grew by two seconds.' }] },
        });
      });
    }
    // Every note is shown once, on the chart or past it (the band under a
    // portrait chart, or the rail); which one is the layout's choice, made
    // from the text's measured size. Counting `.chart-note` instead caught
    // a card the chart had drawn hidden while it measured it: on a fast
    // machine the count passed for that frame, on CI's runner it did not,
    // and the settled page had the second note in the band all along.
    const tags = two ? ['OBSERVATION / BACKEND', 'OBSERVATION / VISUAL SUITE'] : ['OBSERVATION / VISUAL SUITE'];
    await expect.poll(() => page.evaluate(() => {
      const shown = [...document.querySelectorAll<HTMLElement>('.chart-note:not(.chart-note--away), .chart-note-band, .rail-note')]
        .filter((card) => getComputedStyle(card).visibility === 'visible' && Number(getComputedStyle(card).opacity) > 0);
      return shown.map((card) => card.querySelector('.annotation-card__tag')?.textContent ?? '').sort();
    })).toEqual(tags);
    await page.waitForTimeout(500);
    const geometry = await page.evaluate(() => {
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      };
      // The plot is the box the grid closes.
      const grid = [...document.querySelectorAll('.chart-grid line')].map(box);
      const plot = {
        left: Math.min(...grid.map((line) => line.left)), right: Math.max(...grid.map((line) => line.right)),
        top: Math.min(...grid.map((line) => line.top)), bottom: Math.max(...grid.map((line) => line.bottom)),
      };
      const layer = document.querySelector('.chart-notes')!.getBoundingClientRect();
      const callouts = [...document.querySelectorAll('.chart-callout')].map((callout) => ({
        series: callout.getAttribute('data-series'), index: callout.getAttribute('data-index'),
        value: box(callout.querySelector('.chart-callout__value')!),
      }));
      const bars = [...document.querySelectorAll('.chart-series-group')].flatMap((group) =>
        [...group.querySelectorAll('.chart-bar')].map((bar, index) => ({ series: group.getAttribute('data-series'), index: String(index), ...box(bar) })));
      const notes = [...document.querySelectorAll<HTMLElement>('.chart-note, .chart-note-band')].map((card) => {
        const polyline = document.querySelector(`.chart-note-leader[data-note="${card.dataset.note}"] polyline`);
        return {
          id: card.dataset.note!,
          away: card.classList.contains('chart-note--away') || card.classList.contains('chart-note-band'),
          card: box(card),
          anchor: card.querySelector('.annotation-card__anchor')?.textContent ?? '',
          leader: polyline ? polyline.getAttribute('points')!.split(' ').map((pair) => {
            const [x, y] = pair.split(',').map(Number);
            return { x: layer.left + x, y: layer.top + y };
          }) : null,
        };
      });
      return { plot, callouts, bars, notes };
    });
    const named: Record<string, { series: string; index: string; tag: string }> = {
      'durations-note': { series: 'THIS RUN', index: '2', tag: 'TARGET / frontend visual / THIS RUN' },
      'backend-note': { series: 'PREVIOUS RUN', index: '0', tag: 'TARGET / backend / PREVIOUS RUN' },
    };
    const { plot } = geometry;
    for (const note of geometry.notes) {
      const target = named[note.id];
      // The card names the category, and the chart marks the bar.
      expect(note.anchor).toBe(target.tag);
      const callout = geometry.callouts.find((each) => each.series === target.series && each.index === target.index);
      expect(callout, `${note.id}'s bar is marked`).toBeDefined();
      if (note.away) continue;
      const { card } = note;
      const inside = card.left >= plot.left + 4 && card.right <= plot.right - 4 && card.top >= plot.top + 4 && card.bottom <= plot.bottom - 4;
      const outside = card.right <= plot.left - 6 || card.left >= plot.right + 6 || card.bottom <= plot.top - 6 || card.top >= plot.bottom + 6;
      expect(inside || outside, `${note.id} lies across the plot's border`).toBe(true);
      // The leader leaves the card's border and ends by the bar's printed value.
      expect(note.leader, `${note.id} has a leader`).not.toBeNull();
      const leader = note.leader!;
      const start = leader[0];
      const onBorder = (Math.abs(start.x - card.left) <= 1.5 || Math.abs(start.x - card.right) <= 1.5) && start.y >= card.top && start.y <= card.bottom
        || (Math.abs(start.y - card.top) <= 1.5 || Math.abs(start.y - card.bottom) <= 1.5) && start.x >= card.left && start.x <= card.right;
      expect(onBorder, `${note.id}'s leader starts on its card's border`).toBe(true);
      const end = leader[leader.length - 1];
      const value = callout!.value;
      const gap = Math.max(value.left - end.x, end.x - value.right, value.top - end.y, end.y - value.bottom, 0);
      expect(gap, `${note.id}'s leader ends by its bar's value`).toBeLessThanOrEqual(6);
      // It crosses no bar on its way.
      for (const bar of geometry.bars) {
        if (bar.bottom - bar.top < 0.5 || bar.right - bar.left < 0.5) continue;
        for (let index = 1; index < leader.length; index += 1) {
          const a = leader[index - 1];
          const b = leader[index];
          const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
          for (let step = 0; step <= steps; step += 1) {
            const x = a.x + ((b.x - a.x) * step) / Math.max(1, steps);
            const y = a.y + ((b.y - a.y) * step) / Math.max(1, steps);
            const through = x > bar.left + 1 && x < bar.right - 1 && y > bar.top + 1 && y < bar.bottom - 1;
            expect(through, `${note.id}'s leader runs through the ${bar.series} bar ${bar.index}`).toBe(false);
          }
        }
      }
    }
  });
}

// A note on a line, area or scatter chart takes the rules the training
// goldens were approved with (the bar chart's stricter rules were tried
// for line charts and taken back: they read worse there). Its card
// may lie across the plot's border; its leader leaves the card's border,
// fades on its way and ends on the point it names -- on the drawn line, or
// a scatter's point -- where no value is printed; its tag names the x and
// the series as the caller reads them. On the training chart at 1440x900
// and 2560x1080 the card stands in the top row across the plot's top
// border, as approved.
const pointNoteCharts = {
  training: { actions: [], notes: { 'training-note': { x: 32, series: 'VAL LOSS', tag: 'TARGET / EPOCH 32 / VAL LOSS', text: 'Validation loss turns upward here' } } },
  area: {
    actions: [
      { op: 'clear' },
      {
        op: 'show', id: 'traffic', type: 'chart', role: 'primary',
        data: {
          kind: 'area', title: 'WEB / MONTHLY TRAFFIC', labels: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], yLabel: 'VISITS (K)', xLabel: 'MONTH',
          series: [
            { name: 'ORGANIC', semantic: 'green', values: [12, 14, 15, 19, 24, 31, 38, 36, 33, 29, 26, 22] },
            { name: 'REFERRAL', semantic: 'orange', values: [8, 9, 11, 12, 15, 18, 22, 25, 24, 20, 17, 14] },
          ],
        },
      },
      { op: 'show', id: 'traffic-note', type: 'note', data: { tag: 'OBSERVATION / JULY', anchor: { target: 'traffic', x: 6, series: 'ORGANIC' }, segments: [{ text: 'Organic traffic peaked in July, the month the docs moved to the new site.' }] } },
    ],
    notes: { 'traffic-note': { x: 6, series: 'ORGANIC', tag: 'TARGET / JUL / ORGANIC', text: 'Organic traffic peaked in July' } },
  },
  scatter: {
    actions: [
      { op: 'clear' },
      {
        op: 'show', id: 'slow', type: 'chart', role: 'primary',
        data: {
          kind: 'scatter', title: 'API / SLOW REQUESTS', xMax: 23, yLabel: 'MS', xLabel: 'HOUR',
          series: [{ name: 'P99', semantic: 'cyan', values: [43, 41, 46, 40, 45, 43, 40, 44, 40, 44, 40, 41, 44, 48, 41, 42, 46, 92.5, 45, 44, 49, 40, 48, 42] }],
        },
      },
      { op: 'show', id: 'slow-note', type: 'note', data: { tag: 'OBSERVATION / 17:00', anchor: { target: 'slow', x: 17, series: 'P99' }, segments: [{ text: 'The 17:00 spike lines up with the nightly export job starting early.' }] } },
    ],
    notes: { 'slow-note': { x: 17, series: 'P99', tag: 'TARGET / HOUR 17 / P99', text: 'The 17:00 spike lines up' } },
  },
} as const;
const pointNoteCases = (['training', 'area', 'scatter'] as const).flatMap((chart) =>
  [{ width: 1440, height: 900 }, { width: 2560, height: 1080 }, { width: 1280, height: 720 }, { width: 820, height: 1180 }, { width: 390, height: 844 }].map((viewport) => ({ chart, viewport })),
);
for (const { chart, viewport } of pointNoteCases) {
  test(`a note on a ${chart} chart runs a fading leader onto the point it names, at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const spec = pointNoteCharts[chart];
    await page.setViewportSize(viewport);
    await page.goto(`/?scene=${chart === 'training' ? 'training' : 'comparison'}&chrome=0`);
    if (spec.actions.length > 0) await page.evaluate((actions) => window.SwitchboardController!.run(actions as never), spec.actions);
    // A note the chart hands over is in the rail, or where the rail stands
    // under the chart in the band under it (chartNotePlace.spec.ts).
    await expect.poll(async () => (await page.locator('.chart-note').count()) + (await page.locator('.chart-note-band').count())).toBe(Object.keys(spec.notes).length);
    await page.waitForTimeout(600);
    const geometry = await page.evaluate(() => {
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      };
      const svg = document.querySelector<SVGSVGElement>('.chart-object .chart-primitive > svg')!;
      const matrix = svg.getScreenCTM()!;
      const toClient = (x: number, y: number) => ({ x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f });
      // The plot is the box the grid closes.
      const grid = [...svg.querySelectorAll('.chart-grid line')].map(box);
      const plot = {
        left: Math.min(...grid.map((line) => line.left)), right: Math.max(...grid.map((line) => line.right)),
        top: Math.min(...grid.map((line) => line.top)), bottom: Math.max(...grid.map((line) => line.bottom)),
      };
      // Each series as drawn: its line, and a scatter's points in order.
      const series = Object.fromEntries([...svg.querySelectorAll('.chart-series-group')].map((group) => [group.getAttribute('data-series')!, {
        line: [...(group.querySelector('.chart-series')?.getAttribute('d') ?? '').matchAll(/[ML] ([-\d.]+) ([-\d.]+)/g)].map((match) => toClient(Number(match[1]), Number(match[2]))),
        points: [...group.querySelectorAll('.chart-point')].map((point) => toClient(Number(point.getAttribute('cx')), Number(point.getAttribute('cy')))),
      }]));
      const layer = document.querySelector('.chart-notes')?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const notes = [...document.querySelectorAll<HTMLElement>('.chart-note')].map((card) => {
        const group = document.querySelector(`.chart-note-leader[data-note="${card.dataset.note}"]`);
        const polyline = group?.querySelector('polyline');
        return {
          id: card.dataset.note!,
          away: card.classList.contains('chart-note--away'),
          card: box(card),
          anchor: card.querySelector('.annotation-card__anchor')?.textContent ?? '',
          bar: group?.classList.contains('chart-note-leader--bar') ?? false,
          stops: group?.querySelectorAll('stop').length ?? 0,
          leader: polyline ? polyline.getAttribute('points')!.split(' ').map((pair) => {
            const [x, y] = pair.split(',').map(Number);
            return { x: layer.left + x, y: layer.top + y };
          }) : null,
        };
      });
      // A point whose note is not laid over the chart keeps a hollow ring.
      const rings = [...svg.querySelectorAll('.chart-note-ring')].map((ring) => toClient(Number(ring.getAttribute('cx')), Number(ring.getAttribute('cy'))));
      const rail = [...document.querySelectorAll('.content-rail .rail-note, .chart-note-band')].map((element) => element.textContent).join(' ');
      return { plot, series, notes, rings, rail, values: document.querySelectorAll('.chart-marker__value').length };
    });
    const near = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = dx * dx + dy * dy > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
      return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    };
    const { plot } = geometry;
    expect(geometry.values, 'no value is printed by a point').toBe(0);
    for (const note of geometry.notes) {
      const target = spec.notes[note.id as keyof typeof spec.notes] as { x: number; series: string; tag: string; text: string };
      expect(note.anchor).toBe(target.tag);
      const drawn = geometry.series[target.series];
      // The point it names, on the line or a scatter's point.
      const off = (p: { x: number; y: number }) => chart === 'scatter'
        ? Math.hypot(p.x - drawn.points[target.x].x, p.y - drawn.points[target.x].y)
        : Math.min(...drawn.line.slice(1).map((b, index) => near(p, drawn.line[index], b)));
      if (chart === 'training' && viewport.width >= 1440) {
        // As approved: on the chart, in the top row, across the plot's top border.
        expect(note.away, `${note.id} keeps its place on the chart`).toBe(false);
        expect(note.card.top < plot.top && note.card.bottom > plot.top, `${note.id} stands across the plot's top border`).toBe(true);
      }
      if (note.away) {
        // In the rail, or the band under the chart; its point ringed where no leader reaches it.
        expect(geometry.rail, `${note.id} is in the rail`).toContain(target.text);
        expect(geometry.rings.some((ring) => off(ring) <= 1.5), `${note.id}'s point is ringed`).toBe(true);
        continue;
      }
      const { card } = note;
      // The leader leaves the card's border, fades on its way, and ends on the point it names.
      expect(note.leader, `${note.id} has a leader`).not.toBeNull();
      expect(note.bar).toBe(false);
      expect(note.stops).toBe(3);
      const leader = note.leader!;
      const start = leader[0];
      const onBorder = (Math.abs(start.x - card.left) <= 1.5 || Math.abs(start.x - card.right) <= 1.5) && start.y >= card.top && start.y <= card.bottom
        || (Math.abs(start.y - card.top) <= 1.5 || Math.abs(start.y - card.bottom) <= 1.5) && start.x >= card.left && start.x <= card.right;
      expect(onBorder, `${note.id}'s leader starts on its card's border`).toBe(true);
      const end = leader[leader.length - 1];
      expect(off(end), `${note.id}'s leader ends on its point`).toBeLessThanOrEqual(1.5);
      // A point a leader reaches is not ringed again.
      expect(geometry.rings.some((ring) => off(ring) <= 1.5), `${note.id}'s point is ringed though its leader reaches it`).toBe(false);
    }
  });
}

// On a phone the chart was the desktop canvas drawn at a third of its size:
// 4px axis text, tiny bars and bands of black above and below it. The frame
// follows the slot, and no chart text falls under the page's floors.
const portraitCharts = ['training', 'comparison'].flatMap((scene) => [{ width: 390, height: 844 }, { width: 820, height: 1180 }].map((viewport) => ({ scene, viewport })));
for (const { scene, viewport } of portraitCharts) {
  test(`a ${scene} chart in a portrait slot fills it, its text readable, at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/?scene=${scene}&chrome=0`);
    await expect(page.locator('[data-testid="chart"]')).toBeVisible();
    await page.waitForTimeout(500);
    const chart = await page.locator('[data-testid="chart"]').first().evaluate((element) => {
      const svg = element.querySelector('svg')!;
      const [, , width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number);
      const box = svg.getBoundingClientRect();
      const sizes = [...svg.querySelectorAll('text')].map((text) => {
        const matrix = text.getScreenCTM()!;
        return Number.parseFloat(getComputedStyle(text).fontSize) * Math.hypot(matrix.a, matrix.b);
      });
      return { aspect: width / height, boxAspect: box.width / box.height, smallest: Math.min(...sizes) };
    });
    expect(chart.smallest).toBeGreaterThanOrEqual(7 - 0.01);
    expect(Math.abs(chart.aspect - chart.boxAspect) / chart.boxAspect).toBeLessThan(0.02);
  });
}

// Focus on a phone drew the chart in a 2:1 strip across the screen; its
// frame follows its box now, so the box is a square to read in.
test('a focused chart on a portrait phone gets a square to read in, its text readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?scene=comparison&chrome=0');
  await page.evaluate(() => window.SwitchboardController!.dispatch({ op: 'focus', id: 'durations' }));
  const chart = page.locator('.focus-layer [data-testid="chart"]');
  await expect(chart).toBeVisible();
  await page.waitForTimeout(500);
  const geometry = await chart.evaluate((element) => {
    const svg = element.querySelector('svg')!;
    const box = svg.getBoundingClientRect();
    const sizes = [...svg.querySelectorAll('text')].map((text) => {
      const matrix = text.getScreenCTM()!;
      return Number.parseFloat(getComputedStyle(text).fontSize) * Math.hypot(matrix.a, matrix.b);
    });
    return { aspect: box.width / box.height, smallest: Math.min(...sizes) };
  });
  expect(geometry.aspect).toBeLessThan(1.2);
  expect(geometry.smallest).toBeGreaterThanOrEqual(7 - 0.01);
});

// Where every bar stands to the top of the domain the chart gives and the
// band above the plot is shorter than the card, no place on the chart is
// clear of the data: the note goes to the rail, still naming its target,
// and the bar it names stays marked.
test('a note with no clear place on its bar chart is shown in the rail, its bar marked', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?scene=comparison&chrome=0');
  await page.evaluate(() => {
    const run = window.SwitchboardController?.run;
    if (!run) throw new Error('controller unavailable');
    run([
      { op: 'clear' },
      {
        op: 'show', id: 'uptime', type: 'chart', role: 'primary',
        data: {
          kind: 'bar', title: 'FLEET / NODE UPTIME', labels: ['us-east', 'us-west', 'eu-west', 'eu-north', 'ap-south', 'ap-east'],
          // The domain is given: one the page chooses leaves headroom.
          yMax: 100,
          series: [
            { name: 'THIS MONTH', semantic: 'green', values: [99.9, 99.7, 100, 99.8, 99.95, 99.6] },
            { name: 'LAST MONTH', semantic: 'muted', values: [99.8, 99.9, 99.9, 99.95, 100, 99.7] },
          ],
        },
      },
      {
        op: 'show', id: 'uptime-note', type: 'note',
        data: { tag: 'OBSERVATION / EU-WEST', anchor: { target: 'uptime', x: 2, series: 'THIS MONTH' }, segments: [{ text: 'eu-west held a full month without an outage, the first since the move to the new provider. Every other region lost a node for a few minutes.' }] },
      },
    ]);
  });
  const rail = page.locator('.content-rail .rail-note');
  await expect(rail).toContainText('eu-west held a full month without an outage, the first since the move to the new provider.');
  await expect(rail.locator('.annotation-card')).toHaveAttribute('data-anchor-target', 'uptime');
  await expect(page.locator('.chart-note[data-note="uptime-note"]')).toHaveClass(/chart-note--away/);
  await expect(page.locator('.chart-note[data-note="uptime-note"]')).toBeHidden();
  await expect(page.locator('.chart-note-leader')).toHaveCount(0);
  // The bar it names stays marked, as a bar: outlined, its value printed.
  await expect(page.locator('.chart-note-ring')).toHaveCount(0);
  const callout = page.locator('.chart-callout[data-index="2"][data-series="THIS MONTH"]');
  await expect(callout).toHaveCount(1);
  await expect(callout.locator('.chart-callout__value')).toHaveText('100');
  const geometry = await page.evaluate(() => {
    const outline = document.querySelector('.chart-callout__outline')!.getBoundingClientRect();
    const bar = document.querySelectorAll('.chart-series-group')[0].querySelectorAll('.chart-bar')[2].getBoundingClientRect();
    return { outline: { left: outline.left, right: outline.right, top: outline.top }, bar: { left: bar.left, right: bar.right, top: bar.top } };
  });
  expect(Math.abs(geometry.outline.left - geometry.bar.left)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(geometry.outline.right - geometry.bar.right)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(geometry.outline.top - geometry.bar.top)).toBeLessThanOrEqual(1.5);
});

test('long current response scrolls above the lower-right caption', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 6 });
  const { wsUrl } = await fixtureServer.start();
  const reply = Array.from({ length: 18 }, (_, index) => `Response paragraph ${index + 1} remains readable.`).join('\n\n');

  try {
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
    fixtureServer.broadcast({
      type: 'spoken',
      entry: transcriptEntry({ role: 'agent', text: reply, id: 'reply-long' }),
    });

    const response = page.locator('.conversation-answer__text');
    const caption = page.locator('.conversation-answer__index');
    await expect(response).toBeVisible();
    await expect(caption).toHaveText('VOICE / 01');
    const geometry = await response.evaluate((element) => {
      const responseBox = element.getBoundingClientRect();
      const captionBox = document.querySelector<HTMLElement>('.conversation-answer__index')!.getBoundingClientRect();
      return {
        overflowY: getComputedStyle(element).overflowY,
        scrollable: element.scrollHeight > element.clientHeight,
        separated: responseBox.bottom <= captionBox.top,
      };
    });
    expect(geometry).toEqual({ overflowY: 'auto', scrollable: true, separated: true });
  } finally {
    await fixtureServer.stop();
  }
});



test('progress value sent as a percentage fills the matching width', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'deploy-progress-pct', type: 'progress', role: 'primary',
      data: { label: 'DEPLOY', value: 65, text: '65% COMPLETE' },
    });
  });

  await expect.poll(() => page.locator('.progress-primitive').evaluate((element) => {
    const track = element.querySelector<HTMLElement>('.progress-primitive__track')!;
    const fill = element.querySelector<HTMLElement>('.progress-primitive__fill')!;
    return fill.getBoundingClientRect().width / track.getBoundingClientRect().width;
  })).toBeCloseTo(0.65, 2);
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '65');
});


test('the caption stays one line clear of a long response at minimum box height', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 9 });
  const { wsUrl } = await fixtureServer.start();
  const reply = Array.from({ length: 18 }, (_, index) => `Response paragraph ${index + 1} remains readable.`).join('\n\n');

  try {
    await page.setViewportSize({ width: 1440, height: 420 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
    fixtureServer.broadcast({
      type: 'spoken',
      entry: transcriptEntry({ role: 'agent', text: reply, id: 'reply-long' }),
    });

    const response = page.locator('.conversation-answer__text');
    await expect(response).toBeVisible();
    const geometry = await response.evaluate((element) => {
      const responseBox = element.getBoundingClientRect();
      const captionBox = document.querySelector<HTMLElement>('.conversation-answer__index')!.getBoundingClientRect();
      return {
        overflowY: getComputedStyle(element).overflowY,
        scrollable: element.scrollHeight > element.clientHeight,
        separated: responseBox.bottom <= captionBox.top + 1,
        captionLines: Math.round(captionBox.height / Math.max(1, parseFloat(getComputedStyle(document.querySelector<HTMLElement>('.conversation-answer__index')!).lineHeight))),
      };
    });
    expect(geometry).toEqual({ overflowY: 'auto', scrollable: true, separated: true, captionLines: 1 });
  } finally {
    await fixtureServer.stop();
  }
});

test('long metric labels and values stay on one line and clear of each other', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'map', type: 'diagram', role: 'primary',
      data: {
        mode: 'graph', title: 'SYSTEM MAP',
        nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        edges: [{ from: 'a', to: 'b' }],
      },
    });
    dispatch({
      op: 'show', id: 'model', type: 'metric', role: 'secondary',
      data: { label: 'ACTIVE MODEL', value: 'GPT openAI-codex-gpt5-mini-2026-07-09' },
    });
    dispatch({
      op: 'show', id: 'provenance', type: 'metric', role: 'secondary',
      data: { label: 'MODEL / FAMILY / BASELINE / CHECKPOINT / EPOCH / BATCH / SEED / SHARD', value: 'OK' },
    });
  });

  const rows = page.locator('.metric-row');
  await expect(rows.first()).toBeVisible();
  await expect(rows).toHaveCount(2);
  for (let i = 0; i < 2; i += 1) {
    const row = rows.nth(i);
    const geometry = await row.evaluate((el) => {
      const label = el.querySelector<HTMLElement>('.metric-row__label')!;
      const value = el.querySelector<HTMLElement>('.metric-row__value')!;
      const rowBox = el.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      const valueBox = value.getBoundingClientRect();
      const overlap = !(
        valueBox.left >= labelBox.right - 1 || labelBox.left >= valueBox.right - 1 ||
        valueBox.top >= labelBox.bottom - 1 || labelBox.top >= valueBox.bottom - 1
      );
      return {
        overlap,
        contained:
          labelBox.left >= rowBox.left - 1 && labelBox.right <= rowBox.right + 1 &&
          valueBox.left >= rowBox.left - 1 && valueBox.right <= rowBox.right + 1 &&
          valueBox.top >= rowBox.top - 1 && valueBox.bottom <= rowBox.bottom + 1,
        singleLine:
          labelBox.height <= parseFloat(getComputedStyle(label).fontSize) * 1.7 &&
          valueBox.height <= parseFloat(getComputedStyle(value).fontSize) * 1.7,
      };
    });
    expect(geometry.overlap).toBe(false);
    expect(geometry.contained).toBe(true);
    expect(geometry.singleLine).toBe(true);
  }
});


test('secondary progress is visible beside the primary diagram', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'quality-map', type: 'diagram', role: 'primary',
      data: {
        mode: 'graph', title: 'QUALITY PATH',
        nodes: [{ id: 'sample', label: 'SAMPLE' }, { id: 'score', label: 'SCORE' }],
        edges: [{ from: 'sample', to: 'score' }],
      },
    });
    dispatch({
      op: 'show', id: 'deploy-progress', type: 'progress', role: 'secondary',
      data: { label: 'Progress demo', value: 67, text: '67%' },
    });
  });

  const progress = page.locator('.rail-progress .progress-primitive');
  await expect(progress).toBeVisible();
  const geometry = await progress.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const stage = document.querySelector<HTMLElement>('.stage')!.getBoundingClientRect();
    return {
      insideStage:
        box.left >= stage.left - 1 && box.top >= stage.top - 1 &&
        box.right <= stage.right + 1 && box.bottom <= stage.bottom + 1,
      size: box.width > 40 && box.height > 20,
    };
  });
  expect(geometry.insideStage).toBe(true);
  expect(geometry.size).toBe(true);
  // The fill animates from an empty track, so poll until it settles.
  await expect.poll(() => progress.evaluate((element) => {
    const track = element.querySelector<HTMLElement>('.progress-primitive__track')!;
    const fill = element.querySelector<HTMLElement>('.progress-primitive__fill')!;
    return fill.getBoundingClientRect().width / track.getBoundingClientRect().width;
  })).toBeCloseTo(0.67, 2);
});


test('secondary progress occupies the visible aux row in a composed workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'throughput', type: 'metric', role: 'primary',
      data: { label: 'THROUGHPUT', value: '98.4%', semantic: 'green' },
    });
    dispatch({
      op: 'show', id: 'coverage', type: 'progress', role: 'secondary',
      data: { label: 'COVERAGE', value: 67, text: '67%' },
    });
  });

  const aux = page.locator('.composed-aux');
  await expect(aux).toBeVisible();
  const progress = aux.locator('.progress-primitive');
  await expect(progress).toBeVisible();
  const geometry = await progress.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const stage = document.querySelector<HTMLElement>('.stage')!.getBoundingClientRect();
    return {
      insideStage:
        box.left >= stage.left - 1 && box.top >= stage.top - 1 &&
        box.right <= stage.right + 1 && box.bottom <= stage.bottom + 1,
      size: box.width > 40 && box.height > 20,
    };
  });
  expect(geometry.insideStage).toBe(true);
  expect(geometry.size).toBe(true);
});


// A progress in the primary slot fills the cell so its step list can scroll
// inside it. That stretch belongs to the step list alone: on a portrait
// stage the text sits on its own row under the bar, and a stretched row
// there floated it to the middle of the cell, away from the bar it reads.
test('a primary progress keeps its text under the bar on a portrait phone, with or without steps', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openController(page);
  const steps = Array.from({ length: 30 }, (_, i) => ({ label: `STEP ${i + 1}`, state: i < 11 ? 'done' : 'todo' }));
  for (const data of [
    { label: 'DEPLOY', value: 42, text: '42% COMPLETE' },
    { label: 'DEPLOY', text: '37% COMPLETE', steps },
  ]) {
    await page.evaluate((progressData) => {
      const dispatch = window.SwitchboardController?.dispatch;
      if (!dispatch) throw new Error('controller unavailable');
      dispatch({ op: 'clear' });
      dispatch({ op: 'show', id: 'deploy', type: 'progress', role: 'primary', data: progressData });
    }, data);
    await expect(page.locator('.composed-primary-object--progress .progress-primitive__text')).toHaveText(data.text);
    const geometry = await page.locator('.composed-primary-object--progress').evaluate((cell) => {
      const box = (selector: string) => cell.querySelector<HTMLElement>(selector)?.getBoundingClientRect() ?? null;
      const list = cell.querySelector<HTMLElement>('.progress-primitive__steps');
      return {
        cell: cell.getBoundingClientRect().toJSON(),
        track: box('.progress-primitive__track')!.toJSON(),
        text: box('.progress-primitive__text')!.toJSON(),
        list: list ? { ...list.getBoundingClientRect().toJSON(), scrolls: list.scrollHeight > list.clientHeight } : null,
      };
    });
    // Directly under the bar, as before steps existed; not mid-cell.
    expect(geometry.text.top).toBeGreaterThanOrEqual(geometry.track.bottom - 1);
    expect(geometry.text.top - geometry.track.bottom).toBeLessThan(40);
    if (geometry.list) {
      // The list follows the text and scrolls inside the cell.
      expect(geometry.list.top).toBeGreaterThanOrEqual(geometry.text.bottom - 1);
      expect(geometry.list.bottom).toBeLessThanOrEqual(geometry.cell.bottom + 1);
      expect(geometry.list.scrolls).toBe(true);
    }
  }
});

// The step list stretches to the primary cell so a long plan scrolls inside
// it. A short plan must not spread over that height: its rows keep their own
// height at the top of the list, each glyph on its label's line.
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`a primary progress with a short plan lists its steps at their own height at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openController(page);
    await page.evaluate(() => {
      const dispatch = window.SwitchboardController?.dispatch;
      if (!dispatch) throw new Error('controller unavailable');
      dispatch({ op: 'clear' });
      dispatch({
        op: 'show', id: 'release', type: 'progress', role: 'primary',
        data: {
          label: 'RELEASE', value: 40,
          steps: [
            { label: 'BUILD', state: 'done' },
            { label: 'TEST', state: 'done', detail: 'ALL SUITES' },
            { label: 'REVIEW', state: 'active' },
            { label: 'MERGE', state: 'blocked', detail: 'WAITS ON REVIEW' },
            { label: 'DEPLOY' },
          ],
        },
      });
    });
    const rows = page.locator('.composed-primary-object--progress .progress-step');
    await expect(rows).toHaveCount(5);
    const geometry = await rows.evaluateAll((items) => items.map((item) => {
      const label = item.querySelector<HTMLElement>('.progress-step__label')!.getBoundingClientRect();
      const glyph = item.querySelector<SVGElement>('.progress-step__glyph')!.getBoundingClientRect();
      const row = item.getBoundingClientRect();
      return { row: { top: row.top, bottom: row.bottom }, label: { top: label.top, bottom: label.bottom }, glyphMiddle: (glyph.top + glyph.bottom) / 2 };
    }));
    for (const [index, step] of geometry.entries()) {
      expect(step.glyphMiddle, `step ${index} glyph on its label's line`).toBeGreaterThanOrEqual(step.label.top);
      expect(step.glyphMiddle, `step ${index} glyph on its label's line`).toBeLessThanOrEqual(step.label.bottom);
      expect(step.row.bottom - step.row.top, `step ${index} keeps its own height`).toBeLessThan((step.label.bottom - step.label.top) * 2);
      if (index > 0) expect(step.row.top - geometry[index - 1].row.bottom, `step ${index} follows the one before`).toBeLessThan(12);
    }
  });
}

test('compare progress renders once in the composed aux row', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'throughput', type: 'metric', role: 'primary',
      data: { label: 'THROUGHPUT', value: '98.4%', semantic: 'green' },
    });
    dispatch({
      op: 'show', id: 'coverage', type: 'progress', role: 'compare',
      data: { label: 'COVERAGE', value: 67, text: '67%' },
    });
  });

  // A compare-role progress object is both a compare object and a progress
  // object; the aux row still gives it exactly one slot.
  const progress = page.locator('.composed-aux .progress-primitive');
  await expect(progress).toHaveCount(1);
  await expect(progress).toBeVisible();
});


test('every progress object is visible in the training scene', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'loss', type: 'chart', role: 'primary',
      data: {
        title: 'Validation loss', xMax: 40, yMin: 0, yMax: 1,
        series: [{ name: 'VAL LOSS', values: [0.8, 0.5, 0.3, 0.45] }],
      },
    });
    dispatch({
      op: 'show', id: 'epoch', type: 'progress', role: 'secondary',
      data: { label: 'EPOCH', value: 40, text: '40%' },
    });
    dispatch({
      op: 'show', id: 'eval', type: 'progress', role: 'secondary',
      data: { label: 'EVAL', value: 80, text: '80%' },
    });
  });

  const scene = page.locator('[data-scene="training"]');
  await expect(scene).toBeVisible();
  await expect(scene.locator('.progress-primitive')).toHaveCount(2);
  for (const label of ['EPOCH', 'EVAL']) {
    await expect(scene.locator('.progress-primitive', { hasText: label })).toBeVisible();
  }
});


test('note and live chat output coexist; neither mutates the other', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 7 });
  const { wsUrl } = await fixtureServer.start();

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
    await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
    fixtureServer.broadcast({
      type: 'display',
      action: {
        op: 'show', id: 'loss', type: 'chart', role: 'primary',
        data: {
          title: 'Validation loss', xMax: 40, yMin: 0, yMax: 1,
          series: [{ name: 'VAL LOSS', values: [0.8, 0.5, 0.3, 0.45] }],
        },
      },
    });
    fixtureServer.broadcast({
      type: 'display',
      action: {
        op: 'show', id: 'spike-note', type: 'note', role: 'secondary',
        data: {
          tag: 'LOOK HERE',
          segments: [{ text: 'This annotation stays attached to the validation spike.' }],
          anchor: { target: 'loss', x: 32, series: 'VAL LOSS' },
        },
      },
    });

    const note = page.locator('.chart-note .annotation-card');
    await expect(note).toContainText('This annotation stays attached to the validation spike.');

    fixtureServer.broadcast({ type: 'spoken', entry: transcriptEntry({ role: 'agent', text: 'The spike is contained.', id: 'reply-1' }) });
    const live = page.locator('.live-chat-card');
    await expect(live).toBeVisible();
    await expect(live).toContainText('The spike is contained.');
    await expect(note).toContainText('This annotation stays attached to the validation spike.');

    const overlap = await page.evaluate(() => {
      const noteBox = document.querySelector<HTMLElement>('.chart-note')!.getBoundingClientRect();
      const liveBox = document.querySelector<HTMLElement>('.live-chat-card')!.getBoundingClientRect();
      return !(
        noteBox.right <= liveBox.left || liveBox.right <= noteBox.left ||
        noteBox.bottom <= liveBox.top || liveBox.bottom <= noteBox.top
      );
    });
    expect(overlap, 'note and live card must not overlap').toBe(false);

    fixtureServer.broadcast({ type: 'spoken', entry: transcriptEntry({ role: 'agent', text: 'A newer response replaces the live card only.', id: 'reply-2' }) });
    await expect(live).toContainText('A newer response replaces the live card only.');
    await expect(note).toContainText('This annotation stays attached to the validation spike.');

    fixtureServer.broadcast({ type: 'display', action: { op: 'hide', id: 'spike-note' } });
    await expect(page.locator('.chart-note')).toHaveCount(0);
    await expect(live).toContainText('A newer response replaces the live card only.');
  } finally {
    await fixtureServer.stop();
  }
});


test('long chat output scrolls inside the live card', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 8 });
  const { wsUrl } = await fixtureServer.start();
  const reply = Array.from({ length: 24 }, (_, index) => `Card paragraph ${index + 1} stays readable. Card paragraph ${index + 1} stays readable.`).join('\n\n');

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
    fixtureServer.broadcast({ type: 'spoken', entry: transcriptEntry({ role: 'agent', text: reply, id: 'reply-long' }) });

    const card = page.locator('.live-chat-card');
    await expect(card).toBeVisible();
    const geometry = await card.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const stage = document.querySelector<HTMLElement>('.stage')!.getBoundingClientRect();
      const text = element.querySelector<HTMLElement>('.live-chat-card__text')!;
      return {
        insideStage:
          box.left >= stage.left - 1 && box.top >= stage.top - 1 &&
          box.right <= stage.right + 1 && box.bottom <= stage.bottom + 1,
        overflowY: getComputedStyle(text).overflowY,
        scrollable: text.scrollHeight > text.clientHeight,
      };
    });
    expect(geometry.insideStage).toBe(true);
    expect(geometry.overflowY).toBe('auto');
    expect(geometry.scrollable).toBe(true);
  } finally {
    await fixtureServer.stop();
  }
});

// #48: a table row, a path or a hash with no break in it wraps inside the
// live card; the card never scrolls sideways or grows past the rail.
test('wide chat output wraps inside the live card instead of scrolling sideways', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 9 });
  const { wsUrl } = await fixtureServer.start();
  const reply = [
    '| file | status | owner | notes |',
    '|------|--------|-------|-------|',
    '| apps/backend/src/pbx.rs | modified | switchboard | turn epoch is stamped before dispatch |',
    '',
    `Commit ${'0123456789abcdef'.repeat(8)} touched /home/lab/projects/switchboard/apps/frontend/src/components/Scenes.tsx.`,
    '',
    `\`${'very_long_identifier_'.repeat(10)}\``,
  ].join('\n');

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
    fixtureServer.broadcast({ type: 'spoken', entry: transcriptEntry({ role: 'agent', text: reply, id: 'reply-wide' }) });

    const card = page.locator('.live-chat-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('0123456789abcdef');
    const geometry = await card.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const rail = document.querySelector<HTMLElement>('.content-rail__details')!.getBoundingClientRect();
      const text = element.querySelector<HTMLElement>('.live-chat-card__text')!;
      const textBox = text.getBoundingClientRect();
      return {
        insideRail: box.left >= rail.left - 1 && box.right <= rail.right + 1,
        textInsideCard: textBox.left >= box.left - 1 && textBox.right <= box.right + 1,
        overflowX: getComputedStyle(text).overflowX,
        scrollWidth: text.scrollWidth,
        clientWidth: text.clientWidth,
      };
    });
    expect(geometry.insideRail).toBe(true);
    expect(geometry.textInsideCard).toBe(true);
    expect(geometry.overflowX).toBe('hidden');
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  } finally {
    await fixtureServer.stop();
  }
});


test('tool activity panel appears, flips to done, and clears when idle', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 10 });
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

    await expect(page.locator('[data-testid="tool-activity"]')).toHaveCount(0);

    fixtureServer.broadcast({ type: 'activity', state: 'start', tool: 'shell', label: 'Running tests', detail: 'cargo test --locked' });
    const panel = page.locator('[data-testid="tool-activity"]');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('CURRENT ACTIVITY');
    await expect(panel).toContainText('\u25cf RUNNING');
    await expect(panel).toContainText('shell');

    fixtureServer.broadcast({ type: 'activity', state: 'end', tool: 'shell', label: 'Running tests', detail: '' });
    await expect(panel).toContainText('LAST TOOL USED');
    await expect(panel).toContainText('\u25a0 DONE');

    await page.waitForTimeout(2200);
    await expect(page.locator('[data-testid="tool-activity"]')).toHaveCount(0);
  } finally {
    await fixtureServer.stop();
  }
});


test('every call of one tool registers on the activity panel (#27)', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 91 });
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

    const panel = page.locator('.content-rail__details [data-testid="tool-activity"]');
    const seen: string[] = [];
    for (let n = 0; n < 4; n += 1) {
      fixtureServer.broadcast({ type: 'activity', state: 'start', tool: 'read', label: 'Reading', detail: 'apps/backend/src/api.rs' });
      await expect(panel).toContainText('CURRENT ACTIVITY');
      const call = await panel.getAttribute('data-call');
      expect(call).not.toBeNull();
      seen.push(call!);
      fixtureServer.broadcast({ type: 'activity', state: 'end', tool: 'read', label: 'Reading', detail: '' });
      await expect(panel).toContainText('LAST TOOL USED');
      // Steps apart, as an agent's separate steps are: calls back to back
      // within the burst window are counted as one burst instead (#50).
      await page.waitForTimeout(400);
    }
    // Four calls of the same tool with the same detail are four calls on the
    // panel, each with a line of its own.
    expect(new Set(seen).size).toBe(4);
    await expect(panel.locator('.tool-activity__call')).toHaveCount(1);
    await expect(panel.locator('.tool-activity__tool')).toHaveText('read');
  } finally {
    await fixtureServer.stop();
  }
});


// #50: a burst of parallel calls arrives faster than a frame; the panel
// counts it instead of naming only the last call.
test('a burst of tool calls reads as its count on the activity panel', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 92 });
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

    const panel = page.locator('.content-rail__details [data-testid="tool-activity"]');
    const tool = panel.locator('.tool-activity__call .tool-activity__tool');
    const detail = panel.locator('.tool-activity__call .tool-activity__detail');
    for (let n = 0; n < 20; n += 1) {
      fixtureServer.broadcast({ type: 'activity', state: 'start', tool: 'read', label: 'Reading', detail: `src/file-${n}.ts` });
    }
    await expect(tool).toHaveText('read / 20 files');
    await expect(detail).toHaveText('src/file-19.ts');
    await expect(panel).toContainText('\u25cf RUNNING');
    await expect(page.locator('.damocles-presence__caption')).toContainText('WORKING / read / 20 files');

    // Nineteen done, one still running: the panel stays up.
    for (let n = 0; n < 19; n += 1) fixtureServer.broadcast({ type: 'activity', state: 'end', tool: 'read', label: 'Reading', detail: '' });
    fixtureServer.broadcast({ type: 'activity', state: 'start', tool: 'grep', label: 'Searching', detail: 'TODO' });
    fixtureServer.broadcast({ type: 'activity', state: 'start', tool: 'grep', label: 'Searching', detail: 'FIXME' });
    await expect(tool).toHaveText('22 tool calls');
    await expect(detail).toHaveText('read 20 / grep 2');
    await expect(panel).toContainText('\u25cf RUNNING');

    fixtureServer.broadcast({ type: 'activity', state: 'end', tool: 'read', label: 'Reading', detail: '' });
    fixtureServer.broadcast({ type: 'activity', state: 'end', tool: 'grep', label: 'Searching', detail: '' });
    fixtureServer.broadcast({ type: 'activity', state: 'end', tool: 'grep', label: 'Searching', detail: '' });
    await expect(panel).toContainText('LAST TOOLS USED');
    await expect(panel).toContainText('\u25a0 DONE');
    await expect(tool).toHaveText('22 tool calls');

    // The agent's next step, seconds later, is a call of its own.
    await page.waitForTimeout(400);
    fixtureServer.broadcast({ type: 'activity', state: 'start', tool: 'read', label: 'Reading', detail: 'README.md' });
    await expect(tool).toHaveText('read');
    await expect(detail).toHaveText('README.md');
  } finally {
    await fixtureServer.stop();
  }
});


test('tool activity panel truncates long names and stays clear of the response', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 11 });
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
    const longTool = `exec-repo-worker-${'x'.repeat(64)}`;
    fixtureServer.broadcast({
      type: 'activity', state: 'start', tool: longTool,
      label: 'Long detail', detail: `${'detail '.repeat(24)}trailing`,
    });

    const panel = page.locator('[data-testid="tool-activity"]');
    await expect(panel).toBeVisible();
    const railGeometry = await panel.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const stage = document.querySelector<HTMLElement>('.stage')!.getBoundingClientRect();
      const tool = element.querySelector<HTMLElement>('.tool-activity__tool')!;
      const detail = element.querySelector<HTMLElement>('.tool-activity__detail');
      return {
        insideStage:
          box.left >= stage.left - 1 && box.top >= stage.top - 1 &&
          box.right <= stage.right + 1 && box.bottom <= stage.bottom + 1,
        toolTruncated: tool.scrollWidth > tool.clientWidth,
        detailTruncated: detail ? detail.scrollWidth > detail.clientWidth : true,
      };
    });
    expect(railGeometry.insideStage).toBe(true);
    expect(railGeometry.toolTruncated).toBe(true);
    expect(railGeometry.detailTruncated).toBe(true);

    fixtureServer.broadcast({ type: 'view', target: 'comms', reason: '' });
    const conversationPanel = page.locator('.tool-activity--conversation');
    await expect(page.locator('[data-scene="conversation"]')).toBeVisible();
    await expect(conversationPanel).toBeVisible();
    const overlap = await conversationPanel.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const answer = document.querySelector<HTMLElement>('.conversation-answer')!.getBoundingClientRect();
      return !(
        box.left >= answer.right || answer.left >= box.right ||
        box.top >= answer.bottom || answer.top >= box.bottom
      );
    });
    expect(overlap, 'panel must not cover the current response').toBe(false);
  } finally {
    await fixtureServer.stop();
  }
});


test('tool activity clears when the route changes', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 12 });
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
    fixtureServer.broadcast({ type: 'activity', state: 'start', tool: 'shell', label: 'Working', detail: 'on it' });
    const panel = page.locator('[data-testid="tool-activity"]');
    await expect(panel).toBeVisible();

    // A handoff is always an epoch frame followed by the new route's status;
    // the epoch reset is what ends the previous line's activity.
    fixtureServer.broadcast({ type: 'epoch', generation: 13 });
    fixtureServer.broadcast(statusMessage({ route: 'damocles', label: 'Damocles' }));
    await expect.poll(async () => (await panel.count()) === 0).toBe(true);
  } finally {
    await fixtureServer.stop();
  }
});


async function openLine(page: Page, fixtureServer: DisplayFixtureServer, viewport = { width: 1440, height: 900 }) {
  const { wsUrl } = await fixtureServer.start();
  await page.setViewportSize(viewport);
  await page.goto(`/?ws=${encodeURIComponent(wsUrl)}`);
  await expect.poll(() => fixtureServer.frames.some((frame) => frame.type === 'hello')).toBe(true);
}

const MAP_ACTION = {
  op: 'show', id: 'map', type: 'diagram', role: 'primary',
  data: {
    mode: 'graph', title: 'SYSTEM MAP',
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    edges: [{ from: 'a', to: 'b' }],
  },
};


test('an agent say and a line error still show beside the live chat card', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 7 });
  try {
    await openLine(page, fixtureServer);
    fixtureServer.broadcast({ type: 'display', action: MAP_ACTION });
    fixtureServer.broadcast({ type: 'spoken', entry: transcriptEntry({ role: 'agent', text: 'The map is up.', id: 'reply-1' }) });
    const live = page.locator('.live-chat-card');
    await expect(live).toContainText('The map is up.');
    // The spoken reply reads in the live card only, never twice.
    await expect(page.locator('.rail-note')).toHaveCount(0);

    fixtureServer.broadcast({ type: 'error', message: 'LINE ERROR / TRANSFER FAILED' });
    await expect(page.locator('.rail-note')).toContainText('LINE ERROR / TRANSFER FAILED');

    fixtureServer.broadcast({ type: 'display', action: { op: 'say', text: 'AGENT SAY EXPLANATION' } });
    await expect(page.locator('.rail-note')).toContainText('AGENT SAY EXPLANATION');
    await expect(live).toContainText('The map is up.');
  } finally {
    await fixtureServer.stop();
  }
});


test('an agent object named message is not taken for the live chat turn', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({ op: 'show', id: 'message', type: 'metric', role: 'primary', data: { label: 'QUEUE', value: '12' } });
  });

  await expect(page.locator('[data-scene="composed"]')).toBeVisible();
  await expect(page.locator('.live-chat-card')).toHaveCount(0);
  expect(errors).toEqual([]);
});


test('no live chat card stands in before the first response', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 7 });
  try {
    await openLine(page, fixtureServer);
    fixtureServer.broadcast({ type: 'display', action: MAP_ACTION });
    fixtureServer.broadcast({ type: 'transcript', id: 'clip-1', text: 'Show me the map.' });
    await expect(page.locator('[data-scene="architecture"]')).toBeVisible();
    await expect(page.locator('.live-chat-card')).toHaveCount(0);

    // The conversation scene keeps its own open-line prompt.
    fixtureServer.broadcast({ type: 'view', target: 'comms', reason: '' });
    await expect(page.locator('.conversation-answer__text')).toHaveText('Line open. Speak when ready.');
  } finally {
    await fixtureServer.stop();
  }
});


test('rail progress keeps a visible bar with its share done', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'quality-map', type: 'diagram', role: 'primary',
      data: { mode: 'graph', title: 'QUALITY PATH', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] },
    });
    dispatch({ op: 'show', id: 'demo', type: 'progress', role: 'secondary', data: { label: 'Progress demo', value: 57 } });
  });

  const progress = page.locator('.rail-progress .progress-primitive');
  await expect(progress).toBeVisible();
  const geometry = await progress.evaluate((element) => {
    const rail = element.closest('.content-rail')!.getBoundingClientRect();
    const track = element.querySelector('.progress-primitive__track')!.getBoundingClientRect();
    const share = element.querySelector('.metric-row__value')!;
    return {
      trackWidth: track.width,
      withinRail: track.right <= rail.right + 1 && share.getBoundingClientRect().right <= rail.right + 1,
      share: share.textContent,
      overflows: element.scrollWidth > element.clientWidth + 1,
    };
  });
  expect(geometry.trackWidth).toBeGreaterThan(80);
  expect(geometry.withinRail).toBe(true);
  expect(geometry.share).toBe('57%');
  expect(geometry.overflows).toBe(false);
  await expect(progress.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '57');
});


test('a crowded phone rail scrolls instead of collapsing the response and the note', async ({ page }) => {
  const fixtureServer = new DisplayFixtureServer({ initialGeneration: 7 });
  try {
    await openLine(page, fixtureServer, { width: 390, height: 844 });
    fixtureServer.broadcast({ type: 'display', action: MAP_ACTION });
    fixtureServer.broadcast({ type: 'display', action: { op: 'show', id: 'm1', type: 'metric', role: 'secondary', data: { label: 'THROUGHPUT', value: '98.4%' } } });
    fixtureServer.broadcast({ type: 'display', action: { op: 'show', id: 'm2', type: 'metric', role: 'secondary', data: { label: 'LATENCY', value: '182 ms' } } });
    fixtureServer.broadcast({ type: 'display', action: { op: 'show', id: 'p1', type: 'progress', role: 'secondary', data: { label: 'DEPLOY', value: 40 } } });
    fixtureServer.broadcast({ type: 'display', action: { op: 'show', id: 'n1', type: 'note', role: 'secondary', data: { segments: [{ text: 'The durable note.' }] } } });
    fixtureServer.broadcast({ type: 'spoken', entry: transcriptEntry({ role: 'agent', text: 'The current response.', id: 'reply-1' }) });
    fixtureServer.broadcast({ type: 'activity', state: 'start', tool: 'shell', label: 'Working', detail: 'ls' });
    await expect(page.locator('[data-testid="tool-activity"]')).toBeAttached();

    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return {
        liveHeight: rect('.live-chat-card__text').height,
        noteHeight: rect('.rail-note').height,
        detailsBottom: rect('.content-rail__details').bottom,
        footerTop: rect('.scene-footer').top,
      };
    });
    expect(geometry.liveHeight).toBeGreaterThan(24);
    expect(geometry.noteHeight).toBeGreaterThan(24);
    expect(geometry.detailsBottom).toBeLessThanOrEqual(geometry.footerTop + 1);
  } finally {
    await fixtureServer.stop();
  }
});


for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 900, height: 800 }, { width: 1440, height: 900 }]) {
  test(`the conversation activity panel leaves the transcript toggle clickable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const fixtureServer = new DisplayFixtureServer({ initialGeneration: 7 });
    try {
      await openLine(page, fixtureServer, viewport);
      fixtureServer.broadcast({ type: 'spoken', entry: transcriptEntry({ role: 'agent', text: 'Working on it.', id: 'reply-1' }) });
      fixtureServer.broadcast({ type: 'activity', state: 'start', tool: 'a_rather_long_tool_name_for_the_panel', label: 'Working', detail: 'a detail long enough to fill the panel width' });
      await expect(page.locator('[data-scene="conversation"]')).toBeVisible();
      await expect(page.locator('[data-testid="tool-activity"]')).toBeVisible();

      const covered = await page.evaluate(() => {
        const toggle = document.querySelector<HTMLElement>('.transcript-toggle')!;
        const box = toggle.getBoundingClientRect();
        const y = box.top + box.height / 2;
        return [0.1, 0.5, 0.9].some((fraction) => {
          const hit = document.elementFromPoint(box.left + box.width * fraction, y);
          return !hit || !toggle.contains(hit);
        });
      });
      expect(covered).toBe(false);
      const answer = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="tool-activity"]')!.getBoundingClientRect();
        const box = document.querySelector('.conversation-answer')!.getBoundingClientRect();
        return panel.top >= box.bottom - 1 && panel.right <= window.innerWidth;
      });
      expect(answer).toBe(true);
    } finally {
      await fixtureServer.stop();
    }
  });
}


test('a short metric value stays at the right edge and leaves the label its room', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({
      op: 'show', id: 'map', type: 'diagram', role: 'primary',
      data: { mode: 'graph', title: 'MAP', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] },
    });
    dispatch({ op: 'show', id: 'rps', type: 'metric', role: 'secondary', data: { label: 'THROUGHPUT / RPS', value: 'OK' } });
  });

  const row = page.locator('.metric-row').first();
  await expect(row).toBeVisible();
  const geometry = await row.evaluate((element) => {
    const rowBox = element.getBoundingClientRect();
    const value = element.querySelector('.metric-row__value')!;
    const range = document.createRange();
    range.selectNodeContents(value);
    const label = element.querySelector<HTMLElement>('.metric-row__label')!;
    return {
      valueGap: rowBox.right - range.getBoundingClientRect().right,
      labelTruncated: label.scrollWidth > label.clientWidth + 1,
    };
  });
  expect(geometry.valueGap).toBeLessThan(4);
  expect(geometry.labelTruncated).toBe(false);
});


test('a secondary chart is drawn in the composed aux row', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openController(page);
  await page.evaluate(() => {
    const dispatch = window.SwitchboardController?.dispatch;
    if (!dispatch) throw new Error('controller unavailable');
    dispatch({ op: 'clear' });
    dispatch({ op: 'show', id: 'tp', type: 'metric', role: 'primary', data: { label: 'THROUGHPUT', value: '98.4%' } });
    dispatch({
      op: 'show', id: 'sc', type: 'chart', role: 'secondary',
      data: { title: 'TREND', series: [{ name: 'TP', values: [0.4, 0.6, 0.9] }] },
    });
  });

  await expect(page.locator('[data-scene="composed"]')).toBeVisible();
  await expect(page.locator('.composed-aux [data-testid="chart"]')).toBeVisible();
});

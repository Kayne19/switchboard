// @vitest-environment jsdom
// A note the scene shows off the chart -- in the band under it on a
// portrait stage -- is not laid over the chart, but the chart still marks
// its point: on a line chart a hollow ring, since no leader reaches it
// there. The cards laid over the chart keep off that ring, as off any mark,
// and the points their own leaders reach get no ring.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/primitives/notePlacement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/primitives/notePlacement')>();
  return { ...actual, layoutNotes: vi.fn(actual.layoutNotes) };
});

import { ChartNotes, chartNoteAnchors, type ChartNote } from '../../src/components/ChartNotes';
import type { ChartData, SceneObject } from '../../src/controller/types';
import { ChartPrimitive } from '../../src/primitives/ChartPrimitive';
import { CHART_MARKER_RADIUS, CHART_MARKER_STROKE, chartSeriesPoint } from '../../src/primitives/chartGeometry';
import { layoutNotes } from '../../src/primitives/notePlacement';
import { mount, stubResizeObserver } from './sceneHarness';

const data: ChartData = {
  xLabel: 'EPOCH',
  xMax: 40,
  series: [
    { name: 'TRAIN', values: [0.3, 0.26, 0.22, 0.19, 0.17, 0.15, 0.14, 0.13, 0.12] },
    { name: 'VAL', values: [0.31, 0.28, 0.25, 0.23, 0.22, 0.22, 0.23, 0.25, 0.27] },
  ],
};
const chart = { id: 'loss', type: 'chart', data } as SceneObject<ChartData>;
const laid: ChartNote = { key: 'turn', data: { tag: 'OBSERVATION', anchor: { target: 'loss', x: 30, series: 'VAL' }, segments: [{ text: 'Validation turns upward here.' }] } };
const banded: ChartNote = { key: 'early', data: { tag: 'EARLY', anchor: { target: 'loss', x: 5, series: 'TRAIN' }, segments: [{ text: 'Both fall together.' }] } };

// jsdom lays nothing out: the layer is 1000 x 600, the chart's svg 1000 x
// 500 from 60 px down it (the approved canvas at scale 1), a card 300 x 80.
const SVG_TOP = 60;
const originalRect = Element.prototype.getBoundingClientRect;
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;
stubResizeObserver();

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this instanceof HTMLElement && this.classList.contains('chart-notes__frame')) return rect(0, 0, 1000, 600);
    if (this instanceof HTMLElement && this.classList.contains('chart-note')) return rect(0, 0, 300, 80);
    if (this instanceof SVGSVGElement && this.closest('.chart-primitive')) return rect(0, SVG_TOP, 1000, 500);
    return originalRect.call(this);
  };
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalRect;
});

afterEach(() => {
  vi.mocked(layoutNotes).mockClear();
});

describe('a point whose note is shown off the chart', () => {
  it('is ringed by the chart, and the cards laid over it keep off the ring', () => {
    // The scene names both notes' points to the chart and its layer, lays
    // one over the chart, and holds the other in the band.
    const named = chartNoteAnchors(chart, [laid, banded]);
    const led = chartNoteAnchors(chart, [laid]);
    const host = mount(
      <div className="chart-object">
        <ChartPrimitive data={data} named={named} led={led} />
        <ChartNotes chart={chart} objects={{ loss: chart }} notes={[laid]} named={named} onFocus={() => {}} />
      </div>,
    );
    const point = chartSeriesPoint(data, 5, 'TRAIN')!;
    // Drawn: one hollow ring, on the band's point; none on the point the laid note's leader reaches.
    const rings = [...host.querySelectorAll('.chart-note-ring')];
    expect(rings).toHaveLength(1);
    expect(Number(rings[0].getAttribute('cx'))).toBeCloseTo(point.x, 3);
    expect(Number(rings[0].getAttribute('cy'))).toBeCloseTo(point.y, 3);
    // Placed around: the ring is among the marks the cards keep off.
    const field = vi.mocked(layoutNotes).mock.calls.at(-1)![1];
    const reach = CHART_MARKER_RADIUS + CHART_MARKER_STROKE / 2;
    expect(field.marks).toContainEqual({ left: point.x - reach, top: SVG_TOP + point.y - reach, right: point.x + reach, bottom: SVG_TOP + point.y + reach });
    expect(field.marks).toHaveLength(1);
  });
});

// @vitest-environment jsdom
// The rail showed one note (pr/issues.md, "The rail shows one note; a
// second note is dropped or put on the wrong chart"): on an object or a
// composed page `noteForTarget` picked one and the rest were not shown; on
// a chart page only the first note about a visual off the charts reached
// the rail, and a second one was laid on the primary chart, which it does
// not describe. And a chart past five notes laid them all over itself with
// bounded work, over its data and each other (pr/issues.md, "where notes
// past five go"). Every note is shown now: a chart lays the first five it
// was shown over itself, and the rail carries the rest, in order.
import { describe, expect, it } from 'vitest';
import type { ControllerAction } from '../../src/controller/types';
import { NOTES_PLACED_IN_FULL } from '../../src/primitives/notePlacement';
import { lastScene as scene, renderScene, stubResizeObserver } from './sceneHarness';

stubResizeObserver();

const note = (id: string, anchor?: { target: string; x?: number; item?: string }): ControllerAction => ({
  op: 'show', id, type: 'note', data: { tag: id.toUpperCase(), ...(anchor ? { anchor } : {}), segments: [{ text: `About ${id}.` }] },
});
const table: ControllerAction = { op: 'show', id: 'grid', type: 'table', role: 'primary', data: { title: 'GRID', columns: [{ label: 'A' }], rows: [['1']] } };
const image = { op: 'show', id: 'fig', type: 'table', role: 'secondary', data: { title: 'SIDE', columns: [{ label: 'B' }], rows: [['2']] } } as ControllerAction;
const chart: ControllerAction = { op: 'show', id: 'loss', type: 'chart', role: 'primary', data: { title: 'LOSS', xMax: 9, series: [{ name: 'VAL', values: [9, 8, 7, 6, 5, 4, 3, 2, 3, 4] }] } };
const metric: ControllerAction = { op: 'show', id: 'p95', type: 'metric', data: { label: 'P95', value: '182 ms' } };

const railTags = () => [...scene().querySelectorAll('.content-rail .annotation-card__tag')].map((tag) => tag.textContent);
const chartTags = () => [...scene().querySelectorAll('.chart-notes .annotation-card__tag')].map((tag) => tag.textContent);

describe('the rail', () => {
  it('shows every note on an object page, the one about the primary first', () => {
    renderScene([table, note('general'), note('about-grid', { target: 'grid' }), note('another')]);
    expect(railTags()).toEqual(['ABOUT-GRID', 'GENERAL', 'ANOTHER']);
  });

  it('shows every note on a composed page, the primary note itself aside', () => {
    renderScene([metric, note('first', { target: 'p95' }), note('second'), note('third', { target: 'p95' })]);
    expect(railTags()).toEqual(['FIRST', 'SECOND', 'THIRD']);
  });

  it('carries every note about a visual off the charts, and lays none of them on the chart', () => {
    renderScene([chart, image, note('side-one', { target: 'fig' }), note('side-two', { target: 'fig' }), note('on-chart', { target: 'loss', x: 4 })]);
    expect(railTags()).toEqual(['SIDE-ONE', 'SIDE-TWO']);
    expect(chartTags()).toEqual(['ON-CHART']);
  });

  it(`takes the notes past the ${NOTES_PLACED_IN_FULL} a chart lays over itself, in the order shown`, () => {
    const notes = Array.from({ length: NOTES_PLACED_IN_FULL + 2 }, (_, index) => note(`obs-${index}`, { target: 'loss', x: index }));
    renderScene([chart, ...notes]);
    expect(chartTags()).toEqual(Array.from({ length: NOTES_PLACED_IN_FULL }, (_, index) => `OBS-${index}`));
    expect(railTags()).toEqual([`OBS-${NOTES_PLACED_IN_FULL}`, `OBS-${NOTES_PLACED_IN_FULL + 1}`]);
    // The chart still marks the points the rail's notes name: a ring each.
    expect(scene().querySelectorAll('.chart-note-ring')).toHaveLength(2);
  });

  it('draws each note once', () => {
    renderScene([table, image, note('a', { target: 'grid' }), note('b', { target: 'fig' }), note('c')]);
    const tags = [...scene().querySelectorAll('.annotation-card__tag')].map((tag) => tag.textContent);
    expect(tags.sort()).toEqual(['A', 'B', 'C']);
  });
});

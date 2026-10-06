// The segment maths the notes over a chart place and draw their leaders by (segments.ts).
import { describe, expect, it } from 'vitest';
import { clipSegment, crispLine, hiddenTraceLength, segmentsMeet, type Rect } from '../../src/primitives/segments';

const box = (left: number, top: number, width: number, height: number): Rect => ({ left, top, right: left + width, bottom: top + height });

describe('hidden trace length', () => {
  it('measures the part of each line inside the card', () => {
    const traces = [[{ x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 150 }]];
    expect(hiddenTraceLength(box(50, 0, 100, 100), traces)).toBeCloseTo(50 + 50, 6);
    expect(hiddenTraceLength(box(200, 0, 100, 100), traces)).toBe(0);
  });
});

describe('a segment against a rect', () => {
  it('gives the share of the segment inside the rect, and none for a miss', () => {
    expect(clipSegment({ x: 0, y: 50 }, { x: 200, y: 50 }, box(50, 0, 100, 100))).toEqual([0.25, 0.75]);
    expect(clipSegment({ x: 0, y: 150 }, { x: 200, y: 150 }, box(50, 0, 100, 100))).toBeUndefined();
  });
});

describe('two segments', () => {
  it('meet where they cross or touch, and not where they are apart', () => {
    expect(segmentsMeet({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true);
    expect(segmentsMeet({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 })).toBe(true);
    expect(segmentsMeet({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 4 }, { x: 10, y: 4 })).toBe(false);
  });
});

// A leader is drawn on the half pixel. A run or a step shorter than a pixel
// (a 0.13 px step after a 13 px run, from a placement) put both its ends on
// the same half pixel, so the drawn leader listed one vertex twice
// (notes-tidy review L2).
describe('a crisp line', () => {
  it('sits on the half pixel and repeats no vertex, however short a run it snaps away', () => {
    const line = crispLine([{ x: 10, y: 20 }, { x: 23, y: 20 }, { x: 23.13, y: 20.13 }, { x: 23.13, y: 40 }]);
    expect(line).toEqual([{ x: 10.5, y: 20.5 }, { x: 23.5, y: 20.5 }, { x: 23.5, y: 40.5 }]);
  });
});

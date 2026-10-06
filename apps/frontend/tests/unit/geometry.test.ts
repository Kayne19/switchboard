// The plane maths the drawings share (geometry.ts): rects against each
// other, and the segment maths the notes over a chart place and draw their
// leaders by.
import { describe, expect, it } from 'vitest';
import { clipSegment, crispLine, hiddenTraceLength, intersection, overlapArea, segmentsMeet, type Rect } from '../../src/primitives/geometry';

const rectAt = (left: number, top: number, width: number, height: number): Rect => ({ left, top, right: left + width, bottom: top + height });

describe('two rects', () => {
  it('share the rect and the area they overlap in, and none where they only touch or miss', () => {
    expect(intersection(rectAt(0, 0, 100, 50), rectAt(60, 20, 100, 100))).toEqual(rectAt(60, 20, 40, 30));
    expect(overlapArea(rectAt(0, 0, 100, 50), rectAt(60, 20, 100, 100))).toBe(40 * 30);
    expect(intersection(rectAt(0, 0, 100, 50), rectAt(100, 0, 10, 10))).toBeUndefined();
    expect(overlapArea(rectAt(0, 0, 100, 50), rectAt(0, 60, 10, 10))).toBe(0);
  });
});

describe('hidden trace length', () => {
  it('measures the part of each line inside the card', () => {
    const traces = [[{ x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 150 }]];
    expect(hiddenTraceLength(rectAt(50, 0, 100, 100), traces)).toBeCloseTo(50 + 50, 6);
    expect(hiddenTraceLength(rectAt(200, 0, 100, 100), traces)).toBe(0);
  });
});

describe('a segment against a rect', () => {
  it('gives the share of the segment inside the rect, and none for a miss', () => {
    expect(clipSegment({ x: 0, y: 50 }, { x: 200, y: 50 }, rectAt(50, 0, 100, 100))).toEqual([0.25, 0.75]);
    expect(clipSegment({ x: 0, y: 150 }, { x: 200, y: 150 }, rectAt(50, 0, 100, 100))).toBeUndefined();
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

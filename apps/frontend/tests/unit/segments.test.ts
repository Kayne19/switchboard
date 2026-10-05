// The segment maths the chart and its notes share (segments.ts).
import { describe, expect, it } from 'vitest';
import { clipSegment, hiddenTraceLength, segmentDistance, segmentsMeet, type Rect } from '../../src/primitives/segments';

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
  it('meet where they cross or touch, and are that far apart where they do not', () => {
    expect(segmentsMeet({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true);
    expect(segmentsMeet({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 })).toBe(true);
    expect(segmentDistance({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 4 }, { x: 10, y: 4 })).toBe(4);
    expect(segmentDistance({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(0);
  });
});

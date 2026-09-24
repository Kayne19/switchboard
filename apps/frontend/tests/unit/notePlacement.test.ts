// Where the notes over a chart sit, and how their leaders run (#26, #49).
import { describe, expect, it } from 'vitest';
import { hiddenTraceLength, placeNotes, routeLeader, type NoteToPlace, type Point, type Rect } from '../../src/primitives/notePlacement';

const area: Rect = { left: 0, top: 0, right: 1000, bottom: 600 };
const box = (left: number, top: number, width: number, height: number): Rect => ({ left, top, right: left + width, bottom: top + height });

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function inside(point: Point, rect: Rect): boolean {
  return point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom;
}

// Each segment of a leader, as its direction: across and along.
function segments(leader: Point[]) {
  return leader.slice(1).map((point, index) => ({ dx: point.x - leader[index].x, dy: point.y - leader[index].y }));
}

describe('leader route', () => {
  const card = box(100, 50, 400, 100);

  it('leaves the card at right angles, steps 45 degrees across, and runs straight on to the point', () => {
    const point = { x: 300, y: 400 };
    const leader = routeLeader(card, point);

    expect(leader[0].y).toBe(card.bottom);
    expect(leader[leader.length - 1]).toEqual(point);
    const [out, step, on] = segments(leader);
    expect(out.dx).toBe(0);
    expect(out.dy).toBeGreaterThan(0);
    expect(Math.abs(step.dx)).toBeGreaterThan(0);
    expect(Math.abs(step.dx)).toBeCloseTo(step.dy, 6);
    expect(on.dx).toBeCloseTo(0, 6);
    expect(on.dy).toBeGreaterThan(0);
  });

  it("turns towards the point from the side of the card's middle", () => {
    // The point is right of the card's middle, so the leader leaves left of
    // it and steps right.
    const leader = routeLeader(card, { x: 400, y: 400 });
    expect(leader[0].x).toBeLessThan(400);
    expect(segments(leader)[1].dx).toBeGreaterThan(0);
  });

  it('grows out of the border when asked to overlap it', () => {
    const leader = routeLeader(card, { x: 300, y: 400 }, { overlap: 1 });
    expect(leader[0].y).toBe(card.bottom - 1);
  });

  it('leaves by the top edge for a point above, clear of the cut corner', () => {
    const point = { x: 495, y: 0 };
    const leader = routeLeader(box(100, 200, 400, 100), point, { cutTop: 0.08, inset: 16 });
    expect(leader[0].y).toBe(200);
    // The outline cuts 32 of the 400 from the top-right corner.
    expect(leader[0].x).toBeLessThanOrEqual(500 - 32 - 16);
    expect(leader[leader.length - 1]).toEqual(point);
    for (const { dx, dy } of segments(leader)) {
      // Every run is straight or at 45 degrees.
      expect(dx === 0 || dy === 0 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-6).toBe(true);
    }
  });

  it('runs along before it steps when the point is further across than it has room for', () => {
    const point = { x: 900, y: 200 };
    const leader = routeLeader(card, point);
    expect(leader).toHaveLength(5);
    const [out, run, step, on] = segments(leader);
    expect(out.dx).toBe(0);
    expect(run.dy).toBe(0);
    expect(run.dx).toBeGreaterThan(0);
    expect(step.dx).toBeCloseTo(step.dy, 6);
    expect(on.dx).toBeCloseTo(0, 6);
    expect(leader[leader.length - 1]).toEqual(point);
  });

  it('leaves by a side for a point beside the card', () => {
    const leader = routeLeader(card, { x: 800, y: 100 });
    expect(leader[0].x).toBe(card.right);
    expect(leader[leader.length - 1]).toEqual({ x: 800, y: 100 });
  });

  it('has no route to a point the card covers', () => {
    expect(routeLeader(card, { x: 300, y: 100 })).toEqual([]);
  });
});

describe('note placement', () => {
  it('centres a note over the point it names, in the top row', () => {
    const placed = placeNotes([{ id: 'a', width: 300, height: 80, point: { x: 500, y: 400 } }], { area });
    expect(placed.get('a')).toEqual(box(350, 0, 300, 80));
  });

  it('keeps a card inside the area when its point is near an edge', () => {
    const placed = placeNotes([{ id: 'a', width: 300, height: 80, point: { x: 980, y: 400 } }], { area });
    expect(placed.get('a')!.right).toBe(1000);
  });

  it('puts a note that names no point in the top-left corner of an empty field', () => {
    const placed = placeNotes([{ id: 'a', width: 300, height: 80 }], { area });
    expect(placed.get('a')).toEqual(box(0, 0, 300, 80));
  });

  it('never covers the point its note names, taking the bottom row when the point is at the top', () => {
    const placed = placeNotes([{ id: 'a', width: 300, height: 80, point: { x: 500, y: 40 } }], { area });
    const card = placed.get('a')!;
    expect(inside({ x: 500, y: 40 }, card)).toBe(false);
    expect(card.bottom).toBe(600);
  });

  it('keeps every note on screen and no card over another (#49)', () => {
    const notes: NoteToPlace[] = [
      { id: 'first', width: 400, height: 120, point: { x: 700, y: 420 } },
      { id: 'second', width: 400, height: 100 },
      { id: 'third', width: 400, height: 80, point: { x: 150, y: 300 } },
      { id: 'fourth', width: 400, height: 90, point: { x: 720, y: 500 } },
    ];
    const placed = placeNotes(notes, { area });
    expect([...placed.keys()].sort()).toEqual(['first', 'fourth', 'second', 'third']);
    const cards = [...placed.values()];
    cards.forEach((card, index) => {
      expect(card.left).toBeGreaterThanOrEqual(area.left);
      expect(card.right).toBeLessThanOrEqual(area.right);
      expect(card.top).toBeGreaterThanOrEqual(area.top);
      expect(card.bottom).toBeLessThanOrEqual(area.bottom);
      cards.slice(index + 1).forEach((other) => expect(overlaps(card, other)).toBe(false));
    });
    for (const note of notes) {
      if (!note.point) continue;
      for (const card of cards) expect(inside(note.point, card)).toBe(false);
    }
  });

  it('runs no leader under another card', () => {
    const notes: NoteToPlace[] = [
      { id: 'general', width: 400, height: 100 },
      { id: 'pointed', width: 400, height: 120, point: { x: 780, y: 450 } },
      { id: 'late', width: 400, height: 90 },
    ];
    const placed = placeNotes(notes, { area });
    const pointed = placed.get('pointed')!;
    const leader = routeLeader(pointed, notes[1].point!);
    for (const [id, card] of placed) {
      if (id !== 'pointed') expect(hiddenTraceLength(card, [leader])).toBe(0);
    }
  });

  it('moves off the traces when the other row is clear of them', () => {
    // A trace across the top of the field: the top row would hide it.
    const traces = [[{ x: 0, y: 40 }, { x: 1000, y: 40 }]];
    const placed = placeNotes([{ id: 'a', width: 300, height: 80 }], { area, traces });
    expect(hiddenTraceLength(placed.get('a')!, traces)).toBe(0);
    expect(placed.get('a')!.bottom).toBe(600);
  });

  it('steps clear of an axis label rather than cover it, staying near its point', () => {
    const label = box(0, 60, 70, 400);
    const placed = placeNotes([{ id: 'a', width: 300, height: 80, point: { x: 120, y: 300 } }], { area, labels: [label] });
    const card = placed.get('a')!;
    expect(overlaps(card, label)).toBe(false);
    expect(card.left).toBeLessThan(120);
  });
});

describe('hidden trace length', () => {
  it('measures the part of each line inside the card', () => {
    const traces = [[{ x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 150 }]];
    expect(hiddenTraceLength(box(50, 0, 100, 100), traces)).toBeCloseTo(50 + 50, 6);
    expect(hiddenTraceLength(box(200, 0, 100, 100), traces)).toBe(0);
  });
});

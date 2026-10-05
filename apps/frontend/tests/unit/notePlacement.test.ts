// Where the notes over a chart sit, and how their leaders run (#26, #49).
import { describe, expect, it } from 'vitest';
import {
  DATA_CLEARANCE,
  hiddenFillArea,
  hiddenTraceLength,
  placeNotes,
  routeLeader,
  type NoteToPlace,
  type Point,
  type Rect,
} from '../../src/primitives/notePlacement';

const area: Rect = { left: 0, top: 0, right: 1000, bottom: 600 };
const box = (left: number, top: number, width: number, height: number): Rect => ({ left, top, right: left + width, bottom: top + height });

const inflate = (rect: Rect, by: number): Rect => ({ left: rect.left - by, top: rect.top - by, right: rect.right + by, bottom: rect.bottom + by });

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

  // A short chart, as under a stepped plan: the card is too tall to sit
  // above its point, and the bottom row would hide the trace. A place level
  // with the point hides nothing, but its leader would leave by a side.
  const shortField = { area: box(0, 0, 1000, 300), traces: [[{ x: 0, y: 150 }, { x: 1000, y: 240 }]] };
  const shortNotes: NoteToPlace[] = [
    { id: 'general', width: 250, height: 50 },
    { id: 'pointed', width: 400, height: 70, point: { x: 900, y: 60 } },
  ];

  it('keeps a note above or below the point it names on a short chart, so its leader leaves by the top or bottom border', () => {
    const card = placeNotes(shortNotes, shortField).get('pointed')!;
    const point = shortNotes[1].point!;
    const leader = routeLeader(card, point);
    expect(leader.length).toBeGreaterThan(1);
    expect([card.top, card.bottom]).toContain(leader[0].y);
    const [out] = segments(leader);
    expect(out.dx).toBe(0);
    expect(out.dy).not.toBe(0);
  });

  it('sits beside its point, not over it, only where it cannot clear the point above or below', () => {
    // 60 tall in a field 100 tall, its point at the middle: no place above or below.
    const point = { x: 500, y: 50 };
    const card = placeNotes([{ id: 'a', width: 400, height: 60, point }], { area: box(0, 0, 1000, 100) }).get('a')!;
    expect(inside(point, card)).toBe(false);
    const leader = routeLeader(card, point);
    expect([card.left, card.right]).toContain(leader[0].x);
    expect(leader[leader.length - 1]).toEqual(point);
  });

  it('tries straight above or below its point when no row clears it', () => {
    // Other notes' points hold the top row; the bottom row is level with the point.
    const notes: NoteToPlace[] = [
      { id: 'a', width: 300, height: 80, point: { x: 500, y: 260 } },
      { id: 'b', width: 150, height: 40, point: { x: 400, y: 40 } },
      { id: 'c', width: 150, height: 40, point: { x: 600, y: 40 } },
    ];
    const card = placeNotes(notes, { area: box(0, 0, 1000, 300) }).get('a')!;
    for (const other of notes.slice(1)) expect(inside(other.point!, card)).toBe(false);
    const leader = routeLeader(card, notes[0].point!);
    expect([card.top, card.bottom]).toContain(leader[0].y);
  });

  it('beside its point sits level with it, so its leader leaves by a side and never runs along a border', () => {
    // The point is 3px under where the top row's bottom border would be.
    const point = { x: 500, y: 63 };
    const card = placeNotes([{ id: 'a', width: 400, height: 60, point }], { area: box(0, 0, 1000, 100) }).get('a')!;
    expect(point.y).toBeGreaterThan(card.top + 6);
    expect(point.y).toBeLessThan(card.bottom - 6);
    const leader = routeLeader(card, point);
    expect([card.left, card.right]).toContain(leader[0].x);
  });

  it('centres over its point clear of the trace, rather than in a row that hides some of it, or beside it', () => {
    // The trace falls across the top-right corner, so the top row would
    // hide some of it; straight above the point is clear of it. The places
    // beside the point are only for a card no place above or below can clear.
    const point = { x: 790, y: 220 };
    const traces = [[{ x: 0, y: 180 }, { x: 1000, y: 50 }]];
    const card = placeNotes([{ id: 'a', width: 250, height: 70, point }], { area: box(0, 0, 1000, 260), traces }).get('a')!;
    expect(card.left).toBe(665);
    expect(hiddenTraceLength(inflate(card, DATA_CLEARANCE), traces)).toBe(0);
    const leader = routeLeader(card, point);
    expect(leader[0].y).toBe(card.bottom);
  });

  it('centres over its point in a row that hides a trace, rather than beside it where none is', () => {
    // Every place above the point hides one of the two traces; beside it,
    // level with it, hides neither. Beside the point is still the last place.
    const point = { x: 790, y: 220 };
    const traces = [
      [{ x: 0, y: 60 }, { x: 1000, y: 60 }],
      [{ x: 0, y: 140 }, { x: 1000, y: 140 }],
    ];
    const card = placeNotes([{ id: 'a', width: 250, height: 70, point }], { area: box(0, 0, 1000, 260), traces }).get('a')!;
    expect(card).toEqual(box(665, 0, 250, 70));
  });

  it('steps clear of an axis label rather than cover it, staying near its point', () => {
    const label = box(0, 60, 70, 400);
    const placed = placeNotes([{ id: 'a', width: 300, height: 80, point: { x: 120, y: 300 } }], { area, labels: [label] });
    const card = placed.get('a')!;
    expect(overlaps(card, label)).toBe(false);
    expect(card.left).toBeLessThan(120);
  });
});

// What a chart draws is in the way of its notes, as it is drawn: a bar or a
// scatter point is an area, a line is a line, an area's fill is softer, and
// a card that rests against the data hides it too.
describe('note placement over the data', () => {
  const card = (width = 300, height = 80) => ({ width, height });
  // A few pixels between a card and any mark, whatever the clearance placement keeps.
  const clearOf = (rect: Rect, marks: Rect[]) => marks.every((mark) => !overlaps(inflate(rect, 4), mark));
  const leavesTopOrBottom = (rect: Rect, point: Point) => {
    const leader = routeLeader(rect, point);
    return leader.length > 1 && (leader[0].y === rect.top || leader[0].y === rect.bottom);
  };

  it('keeps a card off the whole of a bar, not just its outline, where a clear place exists', () => {
    // A tall bar under the point; the rows above it are level with the
    // point, and the bottom row lies inside the bar.
    const point = { x: 300, y: 60 };
    const marks = [box(250, 60, 100, 340)];
    const placed = placeNotes([{ id: 'a', ...card(), point }], { area: box(0, 0, 1000, 400), marks }).get('a')!;
    expect(clearOf(placed, marks)).toBe(true);
    expect(leavesTopOrBottom(placed, point)).toBe(true);
  });

  it('keeps a clearance from the bars, so a card never reads as resting on one', () => {
    // The top row centred over the point would end 2px above the taller
    // neighbour's top.
    const point = { x: 440, y: 150 };
    const marks = [box(400, 150, 80, 450), box(485, 82, 80, 518)];
    const placed = placeNotes([{ id: 'a', ...card(), point }], { area: box(0, 0, 1000, 600), marks }).get('a')!;
    expect(clearOf(placed, marks)).toBe(true);
    expect(leavesTopOrBottom(placed, point)).toBe(true);
  });

  it('keeps off the points of a dense scatter, near the one it names', () => {
    const marks: Rect[] = [];
    for (let x = 300; x <= 700; x += 25) for (let y = 10; y <= 160; y += 25) marks.push(box(x - 4, y - 4, 8, 8));
    const point = { x: 500, y: 160 };
    const placed = placeNotes([{ id: 'a', ...card(), point }], { area: box(0, 0, 1000, 500), marks }).get('a')!;
    expect(clearOf(placed, marks.filter((mark) => mark.left !== 496 || mark.top !== 156))).toBe(true);
    expect(placed.top).toBeGreaterThanOrEqual(point.y + 6);
    expect((placed.left + placed.right) / 2).toBeCloseTo(point.x, 0);
  });

  it("keeps off an area chart's fill where a clear place exists", () => {
    // The legend runs along the top row and the bottom row is in the fill;
    // between the legend and the line there is room.
    const point = { x: 500, y: 150 };
    const area = box(0, 0, 1000, 400);
    const field = {
      area,
      plot: area,
      traces: [[{ x: 0, y: 150 }, { x: 1000, y: 150 }]],
      fills: [[{ x: 0, y: 150 }, { x: 1000, y: 150 }, { x: 1000, y: 400 }, { x: 0, y: 400 }]],
      labels: [box(0, 0, 1000, 20)],
    };
    const placed = placeNotes([{ id: 'a', ...card(), point }], field).get('a')!;
    expect(hiddenFillArea(placed, field.fills)).toBe(0);
    expect(overlaps(placed, field.labels[0])).toBe(false);
    expect(hiddenTraceLength(inflate(placed, DATA_CLEARANCE), field.traces)).toBe(0);
    expect(leavesTopOrBottom(placed, point)).toBe(true);
  });

  it('takes the fill, near its point, rather than the line, where nothing else is free', () => {
    const point = { x: 500, y: 60 };
    const area = box(0, 0, 1000, 400);
    const traces = [[{ x: 0, y: 60 }, { x: 1000, y: 60 }]];
    const fills = [[{ x: 0, y: 60 }, { x: 1000, y: 60 }, { x: 1000, y: 400 }, { x: 0, y: 400 }]];
    const placed = placeNotes([{ id: 'a', ...card(), point }], { area, plot: area, traces, fills }).get('a')!;
    expect(hiddenTraceLength(inflate(placed, DATA_CLEARANCE), traces)).toBe(0);
    expect(hiddenFillArea(placed, fills)).toBeGreaterThan(0);
    expect(placed.top - point.y).toBeLessThanOrEqual(20);
    expect(leavesTopOrBottom(placed, point)).toBe(true);
  });

  it('leaves a note out when it may, where no place is clear of the data, and places it when it may not', () => {
    // Bars stand to within 60px of the top, the card is 80 tall.
    const point = { x: 500, y: 60 };
    const field = { area: box(0, 0, 1000, 300), marks: [box(0, 60, 1000, 240)] };
    const notes = [{ id: 'a', ...card(), point }];
    expect(placeNotes(notes, field, { spill: true }).has('a')).toBe(false);
    expect(placeNotes(notes, field).has('a')).toBe(true);
  });

  it('keeps every note on the chart that has a clear place, when one may leave', () => {
    const point = { x: 500, y: 200 };
    const placed = placeNotes([{ id: 'a', ...card(), point }], { area: box(0, 0, 1000, 300), marks: [box(480, 200, 40, 100)] }, { spill: true });
    expect(placed.has('a')).toBe(true);
  });

  it('leaves out the note that names no point sooner than the one that does, when either clears the other', () => {
    // A band above the bars with room for one card.
    const field = { area: box(0, 0, 500, 300), marks: [box(0, 110, 500, 190)] };
    const placed = placeNotes(
      [
        { id: 'general', ...card() },
        { id: 'pointed', ...card(), point: { x: 250, y: 110 } },
      ],
      field,
      { spill: true },
    );
    expect(placed.has('general')).toBe(false);
    expect(clearOf(placed.get('pointed')!, field.marks)).toBe(true);
  });
});

describe('hidden trace length', () => {
  it('measures the part of each line inside the card', () => {
    const traces = [[{ x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 150 }]];
    expect(hiddenTraceLength(box(50, 0, 100, 100), traces)).toBeCloseTo(50 + 50, 6);
    expect(hiddenTraceLength(box(200, 0, 100, 100), traces)).toBe(0);
  });
});

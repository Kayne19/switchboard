// Where the notes over a chart sit, and how their leaders run (#26, #49).
import { describe, expect, it } from 'vitest';
import type { ChartData } from '../../src/controller/types';
import { chartBarCallout, chartNoteTarget, chartObstacles, chartPointCallouts, chartScales } from '../../src/primitives/chartGeometry';
import {
  DATA_CLEARANCE,
  calloutLeader,
  hiddenFillArea,
  layoutNotes,
  routeLeader,
  type NoteField,
  type NoteToPlace,
  type PlaceOptions,
} from '../../src/primitives/notePlacement';
import { hiddenTraceLength, type Point, type Rect } from '../../src/primitives/segments';
import { leastCpuMs } from './cpuTime';

// Each card's box, as most of these cases read it.
function placeNotes(notes: NoteToPlace[], field: NoteField, options?: PlaceOptions): Map<string, Rect> {
  return new Map([...layoutNotes(notes, field, options)].map(([id, place]) => [id, place.rect]));
}

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

  // A step exactly as long as its room came out a rounding error longer, so
  // the leader ran along by 1e-14 and drew the same vertex twice (line-notes
  // review L9).
  it('never repeats a vertex where its step takes all the room it has', () => {
    const leader = routeLeader(box(106.5, 29, 352, 84), { x: 349.5, y: 128.6 }, { overlap: 1 });
    leader.slice(1).forEach((point, index) => expect(Math.hypot(point.x - leader[index].x, point.y - leader[index].y)).toBeGreaterThan(1e-6));
    expect(leader).toHaveLength(4);
    expect(leader.at(-1)).toEqual({ x: 349.5, y: 128.6 });
  });

  it("leaves a card below its point by the top edge, clear of the corner the card's outline cuts", () => {
    const point = { x: 495, y: 0 };
    const { path } = calloutLeader(box(100, 200, 400, 100), point, 'below', () => {});
    expect(path[0].y).toBe(200);
    // The outline cuts 32 of the 400 from the top-right corner.
    expect(path[0].x).toBeLessThanOrEqual(500 - 32 - 16);
    expect(path.at(-1)).toEqual(point);
    for (const { dx, dy } of segments(path)) {
      // Every run is straight or at 45 degrees.
      expect(dx === 0 || dy === 0 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-6).toBe(true);
    }
  });
});

// How long a leader runs, and whether its last run comes onto its point
// from the side the point's value is printed on: down onto a point whose
// value stands above it, up onto one whose value stands below.
const length = (line: Point[]) => line.slice(1).reduce((sum, p, index) => sum + Math.hypot(p.x - line[index].x, p.y - line[index].y), 0);
function comesFrom(leader: Point[], side: 'above' | 'below'): boolean {
  const [a, b] = leader.slice(-2);
  return Math.abs(b.x - a.x) < 1e-6 && (side === 'above' ? b.y > a.y : b.y < a.y);
}
// The leader leaves the card by one of its sides, from a card level with its point.
const leavesBySide = (rect: Rect, leader: Point[]) => leader.length > 1 && (leader[0].x === rect.left || leader[0].x === rect.right);

// Every note that names a point on a chart names one the chart marks with a
// callout, so it says the side its leader comes from: these cases give one,
// as the page does.
describe('note placement', () => {
  it('sits just past the point it names, its leader short and coming down onto it', () => {
    const point = { x: 500, y: 400 };
    const place = layoutNotes([{ id: 'a', width: 300, height: 80, point, from: 'above' }], { area }).get('a')!;
    expect(place.rect.bottom).toBeLessThanOrEqual(point.y - 14);
    expect(place.rect.left).toBeLessThanOrEqual(point.x);
    expect(place.rect.right).toBeGreaterThanOrEqual(point.x);
    expect(place.leader.at(-1)).toEqual(point);
    expect(comesFrom(place.leader, 'above')).toBe(true);
    expect(length(place.leader)).toBeLessThan(40);
  });

  it('keeps a card inside the area when its point is near an edge', () => {
    const point = { x: 980, y: 400 };
    const place = layoutNotes([{ id: 'a', width: 300, height: 80, point, from: 'above' }], { area }).get('a')!;
    expect(place.rect.right).toBeLessThanOrEqual(1000);
    expect(place.leader.at(-1)).toEqual(point);
  });

  it('puts a note that names no point in the top-left corner of an empty field', () => {
    const placed = placeNotes([{ id: 'a', width: 300, height: 80 }], { area });
    expect(placed.get('a')).toEqual(box(0, 0, 300, 80));
  });

  it('never covers the point its note names, and comes onto it from the side its value is printed on', () => {
    const point = { x: 500, y: 40 };
    const place = layoutNotes([{ id: 'a', width: 300, height: 80, point, from: 'below' }], { area }).get('a')!;
    expect(inside(point, place.rect)).toBe(false);
    expect(place.rect.top).toBeGreaterThan(point.y);
    expect(comesFrom(place.leader, 'below')).toBe(true);
  });

  it('keeps every note on screen and no card over another (#49)', () => {
    const notes: NoteToPlace[] = [
      { id: 'first', width: 400, height: 120, point: { x: 700, y: 420 }, from: 'above' },
      { id: 'second', width: 400, height: 100 },
      { id: 'third', width: 400, height: 80, point: { x: 150, y: 300 }, from: 'above' },
      { id: 'fourth', width: 400, height: 90, point: { x: 720, y: 500 }, from: 'above' },
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
      { id: 'pointed', width: 400, height: 120, point: { x: 780, y: 450 }, from: 'above' },
      { id: 'late', width: 400, height: 90 },
    ];
    const placed = layoutNotes(notes, { area });
    const leader = placed.get('pointed')!.leader;
    expect(leader.at(-1)).toEqual(notes[1].point);
    for (const [id, place] of placed) {
      if (id !== 'pointed') expect(hiddenTraceLength(place.rect, [leader])).toBe(0);
    }
  });

  it('moves off the traces when the other row is clear of them', () => {
    // A trace across the top of the field: the top row would hide it.
    const traces = [[{ x: 0, y: 40 }, { x: 1000, y: 40 }]];
    const placed = placeNotes([{ id: 'a', width: 300, height: 80 }], { area, traces });
    expect(hiddenTraceLength(placed.get('a')!, traces)).toBe(0);
    expect(placed.get('a')!.bottom).toBe(600);
  });

  it('sits beside its point on a short chart, clear of the trace, its leader out of its side and down onto the point', () => {
    // A short chart, as under a stepped plan: the card is taller than the
    // room above its point, and the bottom row would hide the trace.
    const field = { area: box(0, 0, 1000, 300), traces: [[{ x: 0, y: 150 }, { x: 1000, y: 240 }]] };
    const point = { x: 900, y: 60 };
    const placed = layoutNotes([{ id: 'general', width: 250, height: 50 }, { id: 'pointed', width: 400, height: 70, point, from: 'above' }], field);
    const { rect, leader } = placed.get('pointed')!;
    expect(hiddenTraceLength(inflate(rect, DATA_CLEARANCE), field.traces)).toBe(0);
    expect(overlaps(rect, placed.get('general')!.rect)).toBe(false);
    expect(leavesBySide(rect, leader)).toBe(true);
    expect(leader.at(-1)).toEqual(point);
    expect(comesFrom(leader, 'above')).toBe(true);
  });

  it('sits beside its point, not over it, where it cannot clear the point above or below', () => {
    // 60 tall in a field 100 tall, its point at the middle: no place above or below.
    const point = { x: 500, y: 50 };
    const { rect, leader } = layoutNotes([{ id: 'a', width: 400, height: 60, point, from: 'above' }], { area: box(0, 0, 1000, 100) }).get('a')!;
    expect(inside(point, rect)).toBe(false);
    expect(leavesBySide(rect, leader)).toBe(true);
    expect(leader.at(-1)).toEqual(point);
  });

  it("keeps off the other notes' points where their cards hold the rows", () => {
    // Two notes' points at the top row; the bottom row is level with the third's point.
    const notes: NoteToPlace[] = [
      { id: 'a', width: 300, height: 80, point: { x: 500, y: 260 }, from: 'above' },
      { id: 'b', width: 150, height: 40, point: { x: 400, y: 40 }, from: 'above' },
      { id: 'c', width: 150, height: 40, point: { x: 600, y: 40 }, from: 'above' },
    ];
    const placed = layoutNotes(notes, { area: box(0, 0, 1000, 300) });
    for (const note of notes) {
      const { rect, leader } = placed.get(note.id)!;
      for (const other of notes) expect(inside(other.point!, rect)).toBe(false);
      expect(leader.at(-1)).toEqual(note.point);
    }
  });

  it('sits above its point clear of the trace, rather than in a row that hides some of it', () => {
    // The trace falls across the top-right corner, so the top row would
    // hide some of it; above the point, under the trace, is clear of it.
    const point = { x: 790, y: 220 };
    const traces = [[{ x: 0, y: 180 }, { x: 1000, y: 50 }]];
    const { rect, leader } = layoutNotes([{ id: 'a', width: 250, height: 70, point, from: 'above' }], { area: box(0, 0, 1000, 260), traces }).get('a')!;
    expect(hiddenTraceLength(inflate(rect, DATA_CLEARANCE), traces)).toBe(0);
    expect(rect.bottom).toBeLessThan(point.y);
    expect(leader[0].y).toBe(rect.bottom);
    expect(comesFrom(leader, 'above')).toBe(true);
  });

  it('sits beside its point, clear of the traces, rather than over one in a row above it', () => {
    // Every place above the point hides one of the two traces; beside it,
    // level with it, hides neither, and its leader leaves by its side.
    const point = { x: 790, y: 220 };
    const traces = [
      [{ x: 0, y: 60 }, { x: 1000, y: 60 }],
      [{ x: 0, y: 140 }, { x: 1000, y: 140 }],
    ];
    const { rect, leader } = layoutNotes([{ id: 'a', width: 250, height: 70, point, from: 'above' }], { area: box(0, 0, 1000, 260), traces }).get('a')!;
    expect(hiddenTraceLength(inflate(rect, DATA_CLEARANCE), traces)).toBe(0);
    expect(leavesBySide(rect, leader)).toBe(true);
    expect(leader.at(-1)).toEqual(point);
  });

  it('steps clear of an axis label rather than cover it, staying near its point', () => {
    const label = box(0, 60, 70, 400);
    const placed = placeNotes([{ id: 'a', width: 300, height: 80, point: { x: 120, y: 300 }, from: 'above' }], { area, labels: [label] });
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
  // A bar's callout, as the chart draws it: its value printed 6 past its
  // top, 13 tall, and the leader landing 3 past that.
  const callout = (bar: Rect) => {
    const middle = (bar.left + bar.right) / 2;
    const value = { left: middle - 15, right: middle + 15, top: bar.top - 19, bottom: bar.top - 6 };
    return { point: { x: middle, y: value.top - 3 }, from: 'above' as const, mark: bar, value };
  };

  it('keeps a card off the whole of a bar, not just its outline, where a clear place exists', () => {
    // A tall bar under the point; the rows above it are level with the
    // point, and the bottom row lies inside the bar.
    const bar = box(250, 60, 100, 340);
    const target = callout(bar);
    const marks = [bar, target.value];
    const { rect, leader } = layoutNotes([{ id: 'a', ...card(), ...target }], { area: box(0, 0, 1000, 400), marks }).get('a')!;
    expect(clearOf(rect, marks)).toBe(true);
    expect(leader.at(-1)).toEqual(target.point);
  });

  it('keeps a clearance from the bars, so a card never reads as resting on one', () => {
    // The top row centred over the point would end 2px above the taller
    // neighbour's top.
    const bar = box(400, 150, 80, 450);
    const target = callout(bar);
    const marks = [bar, box(485, 82, 80, 518), target.value];
    const { rect, leader } = layoutNotes([{ id: 'a', ...card(), ...target }], { area: box(0, 0, 1000, 600), marks }).get('a')!;
    expect(clearOf(rect, marks)).toBe(true);
    expect(leader.at(-1)).toEqual(target.point);
  });

  it('keeps off the points of a dense scatter, near the one it names', () => {
    const marks: Rect[] = [];
    for (let x = 300; x <= 700; x += 25) for (let y = 10; y <= 160; y += 25) marks.push(box(x - 4, y - 4, 8, 8));
    const point = { x: 500, y: 160 };
    const { rect, leader } = layoutNotes([{ id: 'a', ...card(), point, from: 'below' }], { area: box(0, 0, 1000, 500), marks }).get('a')!;
    expect(clearOf(rect, marks.filter((mark) => mark.left !== 496 || mark.top !== 156))).toBe(true);
    expect(rect.top).toBeGreaterThanOrEqual(point.y + 6);
    expect(comesFrom(leader, 'below')).toBe(true);
    expect(length(leader)).toBeLessThan(40);
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
    const { rect, leader } = layoutNotes([{ id: 'a', ...card(), point, from: 'above' }], field).get('a')!;
    expect(hiddenFillArea(rect, field.fills)).toBe(0);
    expect(overlaps(rect, field.labels[0])).toBe(false);
    expect(hiddenTraceLength(inflate(rect, DATA_CLEARANCE), field.traces)).toBe(0);
    expect(comesFrom(leader, 'above')).toBe(true);
  });

  it('takes the fill, near its point, rather than the line, where nothing else is free', () => {
    // The line runs 60 down a field 400 tall: no card fits above it, so the
    // value is printed under the point, into the fill, and the card comes from there.
    const point = { x: 500, y: 60 };
    const area = box(0, 0, 1000, 400);
    const traces = [[{ x: 0, y: 60 }, { x: 1000, y: 60 }]];
    const fills = [[{ x: 0, y: 60 }, { x: 1000, y: 60 }, { x: 1000, y: 400 }, { x: 0, y: 400 }]];
    const { rect, leader } = layoutNotes([{ id: 'a', ...card(), point, from: 'below' }], { area, plot: area, traces, fills }).get('a')!;
    expect(hiddenTraceLength(inflate(rect, DATA_CLEARANCE), traces)).toBe(0);
    expect(hiddenFillArea(rect, fills)).toBeGreaterThan(0);
    expect(rect.top - point.y).toBeLessThanOrEqual(20);
    expect(comesFrom(leader, 'below')).toBe(true);
  });

  it('leaves a note out when it may, where no place is clear of the data, and places it when it may not', () => {
    // Bars stand to within 60px of the top, the card is 80 tall.
    const bars = box(0, 60, 1000, 240);
    const field = { area: box(0, 0, 1000, 300), marks: [bars] };
    const notes: NoteToPlace[] = [{ id: 'a', ...card(), point: { x: 500, y: 57 }, from: 'above', mark: bars }];
    expect(placeNotes(notes, field, { spill: true }).has('a')).toBe(false);
    expect(placeNotes(notes, field).has('a')).toBe(true);
  });

  it('keeps every note on the chart that has a clear place, when one may leave', () => {
    const point = { x: 500, y: 197 };
    const placed = placeNotes([{ id: 'a', ...card(), point, from: 'above' }], { area: box(0, 0, 1000, 300), marks: [box(480, 200, 40, 100)] }, { spill: true });
    expect(placed.has('a')).toBe(true);
  });

  it('leaves out the note that names no point sooner than the one that does, when either clears the other', () => {
    // A band above the bars with room for one card.
    const field = { area: box(0, 0, 500, 300), marks: [box(0, 110, 500, 190)] };
    const placed = placeNotes(
      [
        { id: 'general', ...card() },
        { id: 'pointed', ...card(), point: { x: 250, y: 107 }, from: 'above' },
      ],
      field,
      { spill: true },
    );
    expect(placed.has('general')).toBe(false);
    expect(clearOf(placed.get('pointed')!, field.marks)).toBe(true);
  });

  it('keeps off a dense scatter read as the area it covers, and off a long line read as its envelope', () => {
    // 1500 points: past the count where the scatter is read as the cells it
    // covers. A clear band is left under the cloud.
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const marks: Rect[] = [];
    for (let index = 0; index < 1500; index += 1) {
      const x = 80 + random() * 840;
      const y = 60 + random() * 300;
      marks.push(box(x - 4, y - 4, 8, 8));
    }
    const area = box(0, 0, 1000, 500);
    const point = { x: 500, y: 368 };
    const scattered = layoutNotes([{ id: 'a', ...card(), point, from: 'below' }], { area, marks }).get('a')!;
    expect(marks.every((mark) => !overlaps(scattered.rect, mark))).toBe(true);
    expect(scattered.leader.at(-1)).toEqual(point);

    // Two lines of 1000 samples each across the top half: past the count
    // where a line is read as its envelope.
    const traces = [0, 1].map((series) =>
      Array.from({ length: 1000 }, (_, index) => ({ x: (index / 999) * 1000, y: 120 + series * 60 + Math.sin(index / 7) * 40 + random() * 20 })),
    );
    const named = traces[1][500];
    const below = { x: named.x, y: named.y + 30 };
    const lined = layoutNotes([{ id: 'b', ...card(), point: below, from: 'below' }], { area, plot: area, traces }).get('b')!;
    expect(hiddenTraceLength(lined.rect, traces)).toBe(0);
    expect(lined.leader.at(-1)).toEqual(below);
  });

  it("keeps the comparison chart's note off its bars (the bars stood under the card)", () => {
    // The `comparison` fixture's chart as the landscape page draws it: the
    // viewBox at 0.937 in a 937 x 596 layer, 69 down it.
    const data: ChartData = {
      kind: 'bar',
      labels: ['backend', 'frontend unit', 'frontend visual', 'host agent', 'skill', 'hygiene'],
      series: [
        { name: 'THIS RUN', values: [41.8, 3.3, 96.4, 6.1, 0.3, 0.4] },
        { name: 'PREVIOUS RUN', values: [44.0, 3.1, 102.9, 6.4, 0.3, 0.4] },
      ],
      marker: { x: 2, series: 'THIS RUN' },
    };
    const scale = 0.937;
    const top = 69.3;
    const at = (p: Point): Point => ({ x: p.x * scale, y: top + p.y * scale });
    const rect = (r: Rect): Rect => ({ left: r.left * scale, top: top + r.top * scale, right: r.right * scale, bottom: top + r.bottom * scale });
    const scales = chartScales(data);
    const obstacles = chartObstacles(data, scales);
    const marks = obstacles.marks.map(rect);
    const target = chartNoteTarget(data, { x: 2, series: 'THIS RUN' }, scales)!;
    const point = at(target.point);
    const place = layoutNotes([{ id: 'note', width: 394, height: 118, point, from: target.from, mark: rect(target.mark), value: rect(target.value) }], {
      area: box(0, 0, 937, 596),
      plot: rect(scales.plot),
      marks,
      labels: obstacles.labels.map(rect),
    }).get('note')!;
    // Clear of every bar, the one it names and its printed value included.
    expect(clearOf(place.rect, marks)).toBe(true);
    expect(place.leader.at(-1)).toEqual(point);
    expect(comesFrom(place.leader, 'above')).toBe(true);
  });
});

// Kayne, round 3: the note on a bar chart still read oddly -- its card
// across the plot's border or jammed under the frame's rail, its leader
// ending by the grey bar beside the one it named. On a bar chart a card lies
// wholly inside the plot or wholly outside it, and its leader comes onto
// the bar from past its end, clear of every other bar.
describe('a note on a bar chart', () => {
  const suite: ChartData = {
    kind: 'bar',
    labels: ['backend', 'frontend unit', 'frontend visual', 'host agent', 'skill', 'hygiene'],
    series: [
      { name: 'THIS RUN', values: [41.8, 3.3, 96.4, 6.1, 0.3, 0.4] },
      { name: 'PREVIOUS RUN', values: [44.0, 3.1, 102.9, 6.4, 0.3, 0.4] },
    ],
    marker: { x: 2, series: 'THIS RUN' },
  };
  // The chart as a page draws it: its frame at `scale`, `top` down a layer.
  function drawn(data: ChartData, frame: { width: number; height: number }, scale: number, top: number, layer: { width: number; height: number }) {
    const at = (p: Point): Point => ({ x: p.x * scale, y: top + p.y * scale });
    const rect = (r: Rect): Rect => ({ left: r.left * scale, top: top + r.top * scale, right: r.right * scale, bottom: top + r.bottom * scale });
    const scales = chartScales(data, frame);
    const anchor = { x: 2, series: 'THIS RUN' };
    const obstacles = chartObstacles(data, scales, [anchor]);
    const target = chartNoteTarget(data, anchor, scales)!;
    const field: NoteField = {
      area: box(0, 0, layer.width, layer.height),
      plot: rect(scales.plot),
      marks: obstacles.marks.map(rect),
      labels: obstacles.labels.map(rect),
      wholly: true,
    };
    const callout = chartBarCallout(data, anchor, scales)!;
    return { field, point: at(target.point), from: target.from!, value: rect(callout.label), mark: rect(callout.bar.rect) };
  }
  const straddles = (card: Rect, plot: Rect) => {
    const inside = card.left >= plot.left && card.right <= plot.right && card.top >= plot.top && card.bottom <= plot.bottom;
    const outside = card.right <= plot.left || card.left >= plot.right || card.bottom <= plot.top || card.top >= plot.bottom;
    return !inside && !outside;
  };
  // Whether a leader runs through any mark but its own bar's printed value, a few pixels clear.
  const same = (a: Rect, b: Rect) => Math.abs(a.left - b.left) < 1e-6 && Math.abs(a.top - b.top) < 1e-6 && Math.abs(a.right - b.right) < 1e-6;
  const runsThrough = (leader: Point[], marks: Rect[], own: Rect) =>
    marks.some((mark) => !same(mark, own) && leader.slice(1).some((b, index) => {
      const a = leader[index];
      const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
      for (let step = 0; step <= steps; step += 1) {
        const x = a.x + ((b.x - a.x) * step) / Math.max(1, steps);
        const y = a.y + ((b.y - a.y) * step) / Math.max(1, steps);
        if (x > mark.left - 2 && x < mark.right + 2 && y > mark.top - 2 && y < mark.bottom + 2) return true;
      }
      return false;
    }));

  for (const view of [
    // The landscape slots: 1440x900 (the band above the plot is shorter than the card), 2560x1080.
    { name: 'at 1440x900', frame: { width: 1000, height: 500 }, scale: 0.937, top: 47, layer: { width: 937, height: 562 }, card: { width: 394, height: 118 } },
    { name: 'at 2560x1080', frame: { width: 1000, height: 500 }, scale: 1.294, top: 9, layer: { width: 2008, height: 665 }, card: { width: 680, height: 86, sizes: [{ width: 544, height: 112 }, { width: 435, height: 112 }, { width: 340, height: 131 }] } },
    // A phone's recomposed frame, its bars on their side.
    { name: "in a phone's frame", frame: { width: 538, height: 618 }, scale: 0.636, top: 2, layer: { width: 331, height: 435 }, card: { width: 200, height: 95 } },
  ]) {
    it(`lies wholly in or out of the plot, its leader onto the bar from past its end, ${view.name}`, () => {
      const { field, point, from, value } = drawn(suite, view.frame, view.scale, view.top, view.layer);
      const note = { id: 'note', ...view.card, point, from };
      const place = layoutNotes([note], field).get('note')!;
      expect(straddles(place.rect, field.plot!)).toBe(false);
      expect(field.marks!.every((mark) => !overlaps(inflate(place.rect, 4), mark))).toBe(true);
      const leader = place.leader;
      expect(leader.at(-1)).toEqual(point);
      expect(runsThrough(leader, field.marks!, value)).toBe(false);
      // Short: the card is near the bar it names.
      const length = leader.slice(1).reduce((sum: number, p: Point, index: number) => sum + Math.hypot(p.x - leader[index].x, p.y - leader[index].y), 0);
      expect(length).toBeLessThan(160);
    });
  }

  // The page drew a leader routed again on the card rounded to whole
  // pixels; a tie in that route flipped its jog, or its whole route, from
  // the one the placement had scored clear (review finding).
  it('scores a bar note on whole pixels, with the leader grown out of the border as drawn', () => {
    const { field, point, from } = drawn(suite, { width: 1000, height: 500 }, 0.937, 47.3, { width: 937.4, height: 562 });
    const place = layoutNotes([{ id: 'note', width: 394.6, height: 118.2, point, from }], field, { leaderOverlap: 1 }).get('note')!;
    expect(Number.isInteger(place.rect.left)).toBe(true);
    expect(Number.isInteger(place.rect.top)).toBe(true);
    const start = place.leader[0];
    const inside = start.x > place.rect.left && start.x < place.rect.right && start.y > place.rect.top && start.y < place.rect.bottom;
    const fromBorder = Math.min(start.x - place.rect.left, place.rect.right - start.x, start.y - place.rect.top, place.rect.bottom - start.y);
    expect(inside).toBe(true);
    expect(fromBorder).toBeCloseTo(1, 6);
  });

  it('comes down onto an upright bar, over the taller bar beside it', () => {
    const { field, point, from } = drawn(suite, { width: 1000, height: 500 }, 0.937, 47, { width: 937, height: 562 });
    expect(from).toBe('above');
    const place = layoutNotes([{ id: 'note', width: 394, height: 118, point, from }], field).get('note')!;
    const [a, b] = place.leader.slice(-2);
    // Its last run is straight down onto the point.
    expect(b.x - a.x).toBeCloseTo(0, 6);
    expect(b.y - a.y).toBeGreaterThan(0);
  });

  it('routes beside the card, along over the bars and down, where the card sits level with the bar', () => {
    // A card right of a tall bar, its top above the bar's printed value.
    const bars = [box(100, 200, 40, 300), box(142, 150, 40, 350)];
    const value = box(105, 180, 30, 13);
    const point = { x: 120, y: 175 };
    const marks = [...bars, value];
    const near = (_near: Rect, visit: (mark: Rect) => void) => marks.forEach(visit);
    const route = calloutLeader(box(200, 100, 300, 120), point, 'above', near);
    expect(route.clear).toBe(true);
    expect(route.path[0].x).toBe(200);
    // Along at a height over the taller bar, and down onto the point.
    expect(route.path[0].y).toBeLessThan(150);
    expect(route.path.at(-1)).toEqual(point);
    const [a, b] = route.path.slice(-2);
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeGreaterThan(a.y);
  });

  // A card over the bars with a clean leader ranked above a card clear of
  // the bars whose every route crossed one: the leader's trouble sent the
  // card onto the data it must never hide (review finding).
  it('keeps clear of the bars even where its leader must cross one', () => {
    // Full-height bars left of the named one and a full-height bar right of
    // it: the only places clear of the data are right of that bar, and every
    // route from there crosses it.
    const named = box(300, 300, 40, 300);
    const marks = [box(0, 0, 290, 600), named, box(305, 284, 30, 13), box(350, 0, 40, 600)];
    const field: NoteField = { area: box(0, 0, 1000, 600), plot: box(0, 0, 1000, 600), marks, wholly: true };
    const placed = layoutNotes([{ id: 'a', width: 300, height: 80, point: { x: 320, y: 281 }, from: 'above', mark: named }], field).get('a')!;
    expect(marks.every((mark) => !overlaps(placed.rect, mark))).toBe(true);
  });

  // Any mark within a few pixels of the point was taken for the bar's own
  // printed value, so a leader along a neighbour that close passed as clear
  // (review finding).
  it("takes only the bar's own printed value as what its leader lands by", () => {
    const value = box(100, 184, 20, 13);
    const neighbour = box(115, 150, 20, 350);
    const marks = [box(100, 200, 14, 300), value, neighbour];
    const near = (_near: Rect, visit: (mark: Rect) => void) => marks.forEach(visit);
    // A card right of the neighbour, its run at the point's height.
    const card = box(170, 120, 200, 120);
    const route = calloutLeader(card, { x: 110, y: 181 }, 'left', near, { value });
    expect(route.path.at(-1)).toEqual({ x: 110, y: 181 });
    expect(route.clear).toBe(false);
  });

  it('has no clear route from a card under the bar it names, nor one along its side', () => {
    // The bar, its printed value over it, and the point over that.
    const bar = box(100, 200, 40, 300);
    const marks = [bar, box(108, 184, 24, 13)];
    const near = (_near: Rect, visit: (mark: Rect) => void) => marks.forEach(visit);
    const route = calloutLeader(box(80, 520, 200, 60), { x: 120, y: 181 }, 'above', near, { mark: bar });
    expect(route.clear).toBe(false);
  });

  it('keeps a card that names no point on a bar chart off the plot border too', () => {
    const { field } = drawn(suite, { width: 1000, height: 500 }, 0.937, 47, { width: 937, height: 562 });
    const place = layoutNotes([{ id: 'general', width: 394, height: 118 }], field).get('general')!;
    expect(straddles(place.rect, field.plot!)).toBe(false);
  });

});

// Kayne, round 4: the line, area and scatter notes kept the old rules --
// a card across the plot's top border (the training goldens), a leader
// faded to nothing on its way and free to cross the other line, the noted
// point marked only by the marker. They follow the bar chart's now: a card
// wholly in or out of the plot, a leader onto the value the chart prints
// by the ringed point, from past it, through no other mark or line.
describe('a note on a line, area or scatter chart', () => {
  const training: ChartData = {
    xLabel: 'EPOCH', yLabel: 'LOSS', xMax: 40, yMin: 0.08, yMax: 0.3, marker: { x: 32, series: 'VAL LOSS' },
    series: [
      { name: 'TRAIN LOSS', values: [0.277, 0.262, 0.249, 0.236, 0.225, 0.214, 0.204, 0.195, 0.186, 0.178, 0.17, 0.162, 0.155, 0.148, 0.142, 0.136, 0.131, 0.126, 0.121, 0.117, 0.113, 0.11, 0.108, 0.106, 0.105, 0.1041] },
      { name: 'VAL LOSS', values: [0.284, 0.269, 0.254, 0.24, 0.227, 0.216, 0.206, 0.197, 0.189, 0.181, 0.175, 0.169, 0.164, 0.159, 0.155, 0.152, 0.15, 0.151, 0.154, 0.158, 0.164, 0.171, 0.179, 0.188, 0.197, 0.1832] },
    ],
  };
  // The chart as a page draws it, every note's point named: its frame at
  // `scale`, `top` down a layer and centred across it.
  function drawn(data: ChartData, anchors: Array<{ x: number; series?: string }>, scale: number, top: number, layer: { width: number; height: number }) {
    const left = (layer.width - 1000 * scale) / 2;
    const at = (p: Point): Point => ({ x: left + p.x * scale, y: top + p.y * scale });
    const rect = (r: Rect): Rect => ({ left: left + r.left * scale, top: top + r.top * scale, right: left + r.right * scale, bottom: top + r.bottom * scale });
    const scales = chartScales(data);
    const obstacles = chartObstacles(data, scales, anchors);
    const field: NoteField = {
      area: box(0, 0, layer.width, layer.height),
      plot: rect(scales.plot),
      traces: obstacles.lines.map((line) => line.map(at)),
      marks: obstacles.marks.map(rect),
      fills: obstacles.fills.map((piece) => piece.map(at)),
      labels: obstacles.labels.map(rect),
      wholly: true,
    };
    const callouts = chartPointCallouts(data, anchors, scales);
    const targets = anchors.map((anchor) => {
      const target = chartNoteTarget(data, anchor, scales, callouts)!;
      return { point: at(target.point), from: target.from, mark: rect(target.mark), value: rect(target.value) };
    });
    return { field, targets };
  }
  const wholly = (card: Rect, plot: Rect) =>
    (card.left >= plot.left && card.right <= plot.right && card.top >= plot.top && card.bottom <= plot.bottom) ||
    card.right <= plot.left || card.left >= plot.right || card.bottom <= plot.top || card.top >= plot.bottom;
  // How near a leader, short of its last few pixels, comes to a line.
  const nearest = (leader: Point[], traces: Point[][]) => {
    let least = Infinity;
    const steps = leader.slice(1).flatMap((b, index) => {
      const a = leader[index];
      const count = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
      return Array.from({ length: count + 1 }, (_, step) => ({ x: a.x + ((b.x - a.x) * step) / Math.max(1, count), y: a.y + ((b.y - a.y) * step) / Math.max(1, count) }));
    });
    for (const p of steps.slice(0, -6)) {
      for (const trace of traces) {
        for (let index = 1; index < trace.length; index += 1) {
          if (hiddenTraceLength(box(p.x - 0.5, p.y - 0.5, 1, 1), [[trace[index - 1], trace[index]]]) > 0) least = 0;
          else least = Math.min(least, Math.min(Math.hypot(p.x - trace[index].x, p.y - trace[index].y)));
        }
      }
    }
    return least;
  };

  for (const view of [
    // The training goldens' slots: 1440x900 and 2560x1080.
    { name: 'at 1440x900', scale: 0.937, top: 47, layer: { width: 937, height: 562 }, card: { width: 394, height: 118 } },
    { name: 'at 2560x1080', scale: 1.294, top: 9, layer: { width: 2008, height: 665 }, card: { width: 680, height: 86 } },
  ]) {
    it(`lies wholly in or out of the plot, its leader onto the point's value from above, ${view.name}`, () => {
      const anchor = { x: 32, series: 'VAL LOSS' };
      const { field, targets } = drawn(training, [anchor], view.scale, view.top, view.layer);
      const [target] = targets;
      expect(target.from).toBe('above');
      const place = layoutNotes([{ id: 'note', ...view.card, ...target }], field).get('note')!;
      expect(wholly(place.rect, field.plot!)).toBe(true);
      // Clear of the lines, the ring and its value.
      expect(hiddenTraceLength(inflate(place.rect, DATA_CLEARANCE), field.traces!)).toBe(0);
      expect(field.marks!.every((mark) => !overlaps(place.rect, mark))).toBe(true);
      expect(place.leader.at(-1)).toEqual(target.point);
      expect(place.leader.at(-1)!.y).toBeLessThan(target.value.top);
      expect(nearest(place.leader, field.traces!)).toBeGreaterThan(3);
      // Short: the card is near the point it names.
      const length = place.leader.slice(1).reduce((sum: number, p: Point, index: number) => sum + Math.hypot(p.x - place.leader[index].x, p.y - place.leader[index].y), 0);
      expect(length).toBeLessThan(200);
    });
  }

  // A line chart's axis gets no headroom, so a peak on a round axis end sits
  // on the plot's top border: its value went below the apex, into the wedge
  // between the line's two sides, where no leader reached it clear of the
  // line, and the note went to the rail (review finding). The value stands
  // beside an apex the line falls away from, and the card comes from there.
  for (const view of [
    { name: 'at 1440x900', scale: 0.937, top: 47, layer: { width: 937, height: 562 } },
    { name: 'at 2560x1080', scale: 1.294, top: 9, layer: { width: 2008, height: 665 } },
  ]) {
    for (const [name, data, anchor] of [
      ['a peak on the axis end', { xLabel: 'DAY', xMax: 10, series: [{ name: 'REQ', values: [10, 12, 15, 20, 28, 40, 30, 22, 18, 15, 13] }] }, { x: 5 }],
      ['a trough by the axis end', { xLabel: 'DAY', xMax: 10, series: [{ name: 'REQ', values: [40, 35, 30, 25, 20, 12, 20, 25, 30, 35, 40] }] }, { x: 5 }],
      ['the first point of a falling line', { ...training, marker: undefined, series: [training.series[0]] }, { x: 0, series: 'TRAIN LOSS' }],
    ] as Array<[string, ChartData, { x: number; series?: string }]>) {
      it(`keeps a note on ${name} on the chart, its leader clear of the line, ${view.name}`, () => {
        const { field, targets } = drawn(data, [anchor], view.scale, view.top, view.layer);
        const sizes = [{ width: 315, height: 136 }, { width: 252, height: 160 }, { width: 180, height: 210 }];
        const place = layoutNotes([{ id: 'note', width: 394, height: 118, sizes, ...targets[0] }], field, { spill: true, leaderOverlap: 1 }).get('note');
        expect(place, 'the note keeps its place on the chart').toBeDefined();
        expect(wholly(place!.rect, field.plot!)).toBe(true);
        expect(place!.leader.at(-1)).toEqual(targets[0].point);
        expect(nearest(place!.leader, field.traces!)).toBeGreaterThan(3);
      });
    }
  }

  it('reaches a point under another line from below it, never across that line', () => {
    // TRAIN LOSS at epoch 6 lies just under VAL LOSS: its value is printed
    // below it, and the leader comes up from a card below.
    const anchors = [{ x: 32, series: 'VAL LOSS' }, { x: 6, series: 'TRAIN LOSS' }];
    const { field, targets } = drawn(training, anchors, 0.937, 47, { width: 937, height: 562 });
    expect(targets[1].from).toBe('below');
    const placed = layoutNotes(
      [{ id: 'late', width: 394, height: 118, ...targets[0] }, { id: 'early', width: 394, height: 60, ...targets[1] }],
      field,
    );
    for (const [index, id] of ['late', 'early'].entries()) {
      const place = placed.get(id)!;
      expect(wholly(place.rect, field.plot!)).toBe(true);
      expect(place.leader.at(-1)).toEqual(targets[index].point);
      expect(nearest(place.leader, field.traces!)).toBeGreaterThan(3);
    }
    expect(overlaps(placed.get('late')!.rect, placed.get('early')!.rect)).toBe(false);
  });

  it('keeps a card that names no point on a line chart off the plot border too', () => {
    const { field } = drawn(training, [], 0.937, 47, { width: 937, height: 562 });
    const place = layoutNotes([{ id: 'general', width: 394, height: 118 }], field).get('general')!;
    expect(wholly(place.rect, field.plot!)).toBe(true);
  });

  // Only the four run heights nearest the point were tried, so a line drawn
  // in more pieces lost the one height that clears it: over its topmost
  // point (review finding).
  it('runs along over the topmost of the line in its way, however many pieces it is drawn in', () => {
    const card = box(100, 100, 200, 100);
    const point = { x: 500, y: 260 };
    const coarse: Point[] = [{ x: 310, y: 150 }, { x: 460, y: 178 }, { x: 490, y: 300 }, { x: 510, y: 300 }];
    // The first segment again, in six collinear pieces: the same drawn line.
    const fine: Point[] = [coarse[0], ...Array.from({ length: 6 }, (_, k) => ({ x: 310 + (150 * (k + 1)) / 6, y: 150 + (28 * (k + 1)) / 6 })), ...coarse.slice(2)];
    for (const line of [coarse, fine]) {
      const segments = line.slice(1).map((b, index) => [line[index], b] as [Point, Point]);
      const route = calloutLeader(card, point, 'above', () => {}, { linesNear: (_near, visit) => segments.forEach(visit) });
      expect(route.clear).toBe(true);
    }
  });

  it('has no clear route across a line it does not name', () => {
    // A card above a line, the point below it.
    const line: [Point, Point] = [{ x: 0, y: 300 }, { x: 1000, y: 300 }];
    const linesNear = (_near: Rect, visit: (segment: [Point, Point]) => void) => visit(line);
    const card = box(100, 100, 300, 100);
    const point = { x: 250, y: 400 };
    const noMarks = () => {};
    expect(calloutLeader(card, point, 'above', noMarks).clear).toBe(true);
    expect(calloutLeader(card, point, 'above', noMarks, { linesNear }).clear).toBe(false);
    // Beside a card below the line, a run along under it is clear.
    const beside = calloutLeader(box(400, 420, 300, 100), { x: 250, y: 400 }, 'below', noMarks, { linesNear });
    expect(beside.clear).toBe(true);
    expect(beside.path.at(-1)).toEqual({ x: 250, y: 400 });
  });
});

// A card whose own width has no clear place on the chart takes a narrower
// one where that has (each measured, with the height its text needs there).
describe('a card narrower than its own width', () => {
  it('takes the widest narrower size that is clear, only where its own is not', () => {
    // A clear column 300 wide beside what the chart draws.
    const marks = [box(0, 0, 600, 600)];
    const area = box(0, 0, 900, 600);
    const note: NoteToPlace = { id: 'a', width: 400, height: 80, point: { x: 750, y: 590 }, from: 'above', sizes: [{ width: 320, height: 100 }, { width: 250, height: 120 }, { width: 200, height: 150 }] };
    const placed = layoutNotes([note], { area, marks }).get('a')!;
    expect(placed.rect.right - placed.rect.left).toBe(250);
    expect(placed.settled).toBe(true);
    expect(overlaps(inflate(placed.rect, 4), marks[0])).toBe(false);
    // With room at its own width it keeps it.
    const roomy = layoutNotes([note], { area, marks: [box(0, 0, 300, 600)] }).get('a')!;
    expect(roomy.rect.right - roomy.rect.left).toBe(400);
  });

  it('takes a narrower size for a bar whose leader would otherwise run a long way', () => {
    // Short bars left of the named one, a tall block right of it: only a
    // card narrower than its own width sits beside the bar; at its own it
    // must go over the block, a long way up.
    const marks = [box(0, 500, 290, 100), box(300, 400, 40, 200), box(350, 100, 650, 500)];
    const point = { x: 320, y: 395 };
    const field: NoteField = { area: box(0, 0, 1000, 600), marks, plot: box(0, 0, 1000, 600), wholly: true };
    const own = { id: 'a', width: 420, height: 80, point, from: 'above' as const };
    const length = (line: Point[]) => line.slice(1).reduce((sum, p, index) => sum + Math.hypot(p.x - line[index].x, p.y - line[index].y), 0);
    const wide = layoutNotes([own], field).get('a')!;
    expect(length(wide.leader)).toBeGreaterThan(100);
    const narrow = layoutNotes([{ ...own, sizes: [{ width: 280, height: 100 }] }], field).get('a')!;
    expect(narrow.rect.right - narrow.rect.left).toBe(280);
    expect(length(narrow.leader)).toBeLessThan(length(wide.leader) * 0.6);
  });
});

// The rail holds one note, and is for a card the chart has no place for.
// Round 3 sent a note that names no point there first wherever its absence
// left no more cards astray, even where that cleared none: the observation
// then stayed over the data so that a general note could go (review
// finding). A note leaves only where its absence leaves fewer cards astray:
// the one whose absence leaves the fewest; of those a note naming no point
// first, which loses no leader in the rail.
describe('the note left out for the rail', () => {
  it('is the card the chart has no place for, not a note naming no point whose absence clears nothing', () => {
    // Lines across all but a narrow column on the left: the general note
    // fits the column; the observation, wider, lies over a line wherever it
    // goes, with or without the general note on the chart.
    const area = box(0, 0, 400, 300);
    const traces = [20, 80, 140, 200, 260].map((y) => [{ x: 110, y }, { x: 400, y }]);
    const notes: NoteToPlace[] = [
      { id: 'general', width: 90, height: 90 },
      { id: 'observation', width: 280, height: 90, point: { x: 250, y: 140 }, from: 'above' },
    ];
    const field = { area, plot: area, traces };
    expect([...layoutNotes(notes, field)].map(([id, place]) => [id, place.settled])).toEqual([['general', true], ['observation', false]]);
    const placed = placeNotes(notes, field, { spill: true });
    expect(placed.has('observation')).toBe(false);
    expect(placed.get('general')).toEqual(placeNotes(notes, field).get('general'));
  });

  it('is a note that names no point, where its absence clears as many cards as any other', () => {
    // A clear column on the left, lines across the rest: one card fits it.
    // The general note settles in its corner first, and the observation has
    // no clear place left; either one's absence leaves the other clear.
    const area = box(0, 0, 400, 300);
    const traces = [20, 80, 140, 200, 260].map((y) => [{ x: 300, y }, { x: 400, y }]);
    const notes: NoteToPlace[] = [
      { id: 'observation', width: 280, height: 160, point: { x: 150, y: 290 }, from: 'above' },
      { id: 'general', width: 280, height: 160 },
    ];
    const field = { area, plot: area, traces };
    expect(layoutNotes(notes, field).get('observation')!.settled).toBe(false);
    const placed = layoutNotes(notes, field, { spill: true });
    expect(placed.has('general')).toBe(false);
    expect(placed.get('observation')!.settled).toBe(true);
  });

  it('is none while every card has a place that keeps the rules', () => {
    const area = box(0, 0, 1000, 600);
    const notes: NoteToPlace[] = [
      { id: 'observation', width: 280, height: 100, point: { x: 500, y: 400 }, from: 'above' },
      { id: 'general', width: 280, height: 100 },
    ];
    expect([...layoutNotes(notes, { area }, { spill: true }).keys()].sort()).toEqual(['general', 'observation']);
  });

  it('counts a card over another card astray, and gives the rail the one that has no place', () => {
    // Two cards as tall as the field side by side would cover each other: one goes.
    const area = box(0, 0, 500, 300);
    const notes: NoteToPlace[] = [
      { id: 'a', width: 300, height: 300 },
      { id: 'b', width: 300, height: 300 },
    ];
    const all = placeNotes(notes, { area });
    expect(overlaps(all.get('a')!, all.get('b')!)).toBe(true);
    const placed = placeNotes(notes, { area }, { spill: true });
    expect(placed.size).toBe(1);
  });
});

// Placement ran calloutLeader for every place it tried, before it knew the
// place could not win, and tried every other size again in each run for
// the rail: a 40-category chart of four series with five notes took over a
// second (1208 ms), at mount and on every resize frame (review finding).
// It takes some 200-250 ms of CPU time now, up to 400 ms at load 50; the
// budget is CPU time, the least of three runs (cpuTime.ts says why).
describe('placing notes on a dense bar chart', () => {
  it('stays within a frame budget or two', () => {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const data: ChartData = {
      kind: 'bar',
      labels: Array.from({ length: 40 }, (_, index) => `c${index}`),
      series: Array.from({ length: 4 }, (_, index) => ({ name: `S${index}`, values: Array.from({ length: 40 }, () => Math.round(random() * 2000 - 1000) / 10) })),
    };
    const scales = chartScales(data);
    const anchors = [{ x: 1, series: 'S0' }, { x: 10, series: 'S1' }, { x: 20, series: 'S2' }, { x: 30, series: 'S3' }, { x: 39, series: 'S0' }];
    const obstacles = chartObstacles(data, scales, anchors);
    const field: NoteField = { area: box(0, 0, 1000, 540), plot: scales.plot, marks: obstacles.marks, labels: obstacles.labels, wholly: true };
    const notes: NoteToPlace[] = anchors.map((anchor, index) => {
      const target = chartNoteTarget(data, anchor, scales)!;
      return { id: `n${index}`, width: 420, height: 110, point: target.point, from: target.from, mark: target.mark, sizes: [{ width: 336, height: 130 }, { width: 269, height: 150 }, { width: 180, height: 210 }] };
    });
    expect(leastCpuMs(() => layoutNotes(notes, field, { spill: true }))).toBeLessThan(900);
  });
});

// Every place a card tried was routed against every line segment: a line
// chart of two 40-sample series with two notes took 70-120 ms a measure,
// against about 1 ms before its notes had callouts (review finding). It
// runs on every resize frame. This chart of four series with three notes
// and the rail takes some 40-70 ms of CPU time, up to 70 ms at load 50.
// The budget is CPU time, the least of three runs (cpuTime.ts says why).
describe('placing notes on a line chart', () => {
  it('stays within a frame budget', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const data: ChartData = {
      xMax: 39,
      series: Array.from({ length: 4 }, (_, s) => ({ name: `S${s}`, values: Array.from({ length: 40 }, (_, i) => 50 + 30 * Math.sin(i / 17 + s) + random() * 10) })),
    };
    const scales = chartScales(data);
    const anchors = [{ x: 10, series: 'S0' }, { x: 20, series: 'S1' }, { x: 30, series: 'S2' }];
    const callouts = chartPointCallouts(data, anchors, scales);
    const obstacles = chartObstacles(data, scales, anchors, callouts);
    const field: NoteField = { area: box(0, 0, 1000, 540), plot: scales.plot, traces: obstacles.lines, marks: obstacles.marks, labels: obstacles.labels, wholly: true };
    const notes: NoteToPlace[] = anchors.map((anchor, index) => {
      const target = chartNoteTarget(data, anchor, scales, callouts)!;
      return { id: `n${index}`, width: 300, height: 80, ...target };
    });
    expect(leastCpuMs(() => layoutNotes(notes, field, { spill: true }))).toBeLessThan(200);
  });
});

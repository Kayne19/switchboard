// Where the notes over a chart sit, and how their leaders run (#26, #49).
import { describe, expect, it } from 'vitest';
import type { ChartData } from '../../src/controller/types';
import { chartBarCallout, chartNoteTarget, chartObstacles, chartScales, chartSeriesPoint } from '../../src/primitives/chartGeometry';
import {
  DATA_CLEARANCE,
  NOTE_CARD_CUT,
  NOTES_PLACED_IN_FULL,
  barLeader,
  hiddenFillArea,
  layoutNotes,
  routeLeader,
  type NoteField,
  type NoteToPlace,
  type PlaceOptions,
} from '../../src/primitives/notePlacement';
import { hiddenTraceLength, type Point, type Rect } from '../../src/primitives/geometry';
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

  // A step exactly as long as its room came out a rounding error longer, so
  // the leader ran along by 1e-14 and drew the same vertex twice (line-notes
  // review L9).
  it('never repeats a vertex where its step takes all the room it has', () => {
    const leader = routeLeader(box(106.5, 29, 352, 84), { x: 349.5, y: 128.6 }, { overlap: 1 });
    leader.slice(1).forEach((point, index) => expect(Math.hypot(point.x - leader[index].x, point.y - leader[index].y)).toBeGreaterThan(1e-6));
    expect(leader).toHaveLength(4);
    expect(leader.at(-1)).toEqual({ x: 349.5, y: 128.6 });
  });

  it("leaves a card below a bar's point by the top edge, clear of the corner the card's outline cuts", () => {
    const point = { x: 495, y: 0 };
    const { path } = barLeader(box(100, 200, 400, 100), point, 'below', () => {});
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
    const point = { x: 500, y: 360 };
    const scattered = placeNotes([{ id: 'a', ...card(), point }], { area, marks }).get('a')!;
    expect(marks.every((mark) => !overlaps(scattered, mark))).toBe(true);
    expect(leavesTopOrBottom(scattered, point)).toBe(true);

    // Two lines of 1000 samples each across the top half: past the count
    // where a line is read as its envelope.
    const traces = [0, 1].map((series) =>
      Array.from({ length: 1000 }, (_, index) => ({ x: (index / 999) * 1000, y: 120 + series * 60 + Math.sin(index / 7) * 40 + random() * 20 })),
    );
    const lined = placeNotes([{ id: 'b', ...card(), point: traces[1][500] }], { area, plot: area, traces }).get('b')!;
    expect(hiddenTraceLength(lined, traces)).toBe(0);
    expect(leavesTopOrBottom(lined, traces[1][500])).toBe(true);
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
    const point = at(chartSeriesPoint(data, 2, 'THIS RUN', scales)!);
    const placed = placeNotes([{ id: 'note', width: 394, height: 118, point }], {
      area: box(0, 0, 937, 596),
      plot: rect(scales.plot),
      marks,
      labels: obstacles.labels.map(rect),
    }).get('note')!;
    // Clear of every bar, the one it names and its ring included.
    expect(clearOf(placed, marks)).toBe(true);
    expect(leavesTopOrBottom(placed, point)).toBe(true);
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
    const obstacles = chartObstacles(data, scales, { named: [anchor], led: [anchor] });
    const target = chartNoteTarget(data, anchor, scales)!;
    const field: NoteField = {
      area: box(0, 0, layer.width, layer.height),
      plot: rect(scales.plot),
      marks: obstacles.marks.map(rect),
      labels: obstacles.labels.map(rect),
      wholly: true,
    };
    const callout = chartBarCallout(data, anchor, scales)!;
    return { field, point: at(target.point), from: target.from!, value: rect(callout.label), bar: rect(callout.bar.rect) };
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
    const route = barLeader(box(200, 100, 300, 120), point, 'above', near);
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
    const placed = layoutNotes([{ id: 'a', width: 300, height: 80, point: { x: 320, y: 281 }, from: 'above', bar: named }], field).get('a')!;
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
    const route = barLeader(card, { x: 110, y: 181 }, 'left', near, { value });
    expect(route.path.at(-1)).toEqual({ x: 110, y: 181 });
    expect(route.clear).toBe(false);
  });

  it('has no clear route from a card under the bar it names, nor one along its side', () => {
    // The bar, its printed value over it, and the point over that.
    const bar = box(100, 200, 40, 300);
    const marks = [bar, box(108, 184, 24, 13)];
    const near = (_near: Rect, visit: (mark: Rect) => void) => marks.forEach(visit);
    const route = barLeader(box(80, 520, 200, 60), { x: 120, y: 181 }, 'above', near, { bar });
    expect(route.clear).toBe(false);
  });

  it('keeps a card that names no point on a bar chart off the plot border too', () => {
    const { field } = drawn(suite, { width: 1000, height: 500 }, 0.937, 47, { width: 937, height: 562 });
    const place = layoutNotes([{ id: 'general', width: 394, height: 118 }], field).get('general')!;
    expect(straddles(place.rect, field.plot!)).toBe(false);
  });

});


// Kayne, round 6: "I'm not sure that the line chart needed new note rules
// ... I think I liked the way it looked before." A note on a line, area or
// scatter chart is placed as the approved training goldens show it, by the
// rules above: its card in the top row, centred over its point as far as
// the layer lets it, across the plot's top border where that is clear of
// the lines; its leader out of the card's facing edge and straight onto the
// point on the drawn series, with no value printed there to land by.
describe('a note on a line, area or scatter chart', () => {
  const training: ChartData = {
    xLabel: 'EPOCH', yLabel: 'LOSS', xMax: 40, yMin: 0.08, yMax: 0.3, marker: { x: 32, series: 'VAL LOSS' },
    series: [
      { name: 'TRAIN LOSS', values: [0.277, 0.262, 0.249, 0.236, 0.225, 0.214, 0.204, 0.195, 0.186, 0.178, 0.17, 0.162, 0.155, 0.148, 0.142, 0.136, 0.131, 0.126, 0.121, 0.117, 0.113, 0.11, 0.108, 0.106, 0.105, 0.1041] },
      { name: 'VAL LOSS', values: [0.284, 0.269, 0.254, 0.24, 0.227, 0.216, 0.206, 0.197, 0.189, 0.181, 0.175, 0.169, 0.164, 0.159, 0.155, 0.152, 0.15, 0.151, 0.154, 0.158, 0.164, 0.171, 0.179, 0.188, 0.197, 0.1832] },
    ],
  };
  // The chart as a page draws it: its frame at `scale`, `top` down a layer
  // and centred across it.
  function drawn(data: ChartData, scale: number, top: number, layer: { width: number; height: number }) {
    const left = (layer.width - 1000 * scale) / 2;
    const at = (p: Point): Point => ({ x: left + p.x * scale, y: top + p.y * scale });
    const rect = (r: Rect): Rect => ({ left: left + r.left * scale, top: top + r.top * scale, right: left + r.right * scale, bottom: top + r.bottom * scale });
    const scales = chartScales(data);
    const obstacles = chartObstacles(data, scales);
    const field: NoteField = {
      area: box(0, 0, layer.width, layer.height),
      plot: rect(scales.plot),
      traces: obstacles.lines.map((line) => line.map(at)),
      marks: obstacles.marks.map(rect),
      fills: obstacles.fills.map((piece) => piece.map(at)),
      labels: obstacles.labels.map(rect),
    };
    return { field, scales, at };
  }

  for (const view of [
    // The training goldens' slots: 1440x900 and 2560x1080, and where the approved card stands in each.
    { name: 'at 1440x900', scale: 0.937, top: 47, layer: { width: 937, height: 562 }, card: { width: 394, height: 118 }, left: 543 },
    { name: 'at 2560x1080', scale: 1.294, top: 9, layer: { width: 2008, height: 665 }, card: { width: 680, height: 86 }, left: 1042.3656 },
  ]) {
    it(`takes the top row over its point, across the plot's top border, its leader onto the point on the line, ${view.name}`, () => {
      const { field, scales, at } = drawn(training, view.scale, view.top, view.layer);
      const target = chartNoteTarget(training, { x: 32, series: 'VAL LOSS' }, scales)!;
      // No side to come from and nothing printed to land by: the point on the series itself.
      expect(target.from).toBeUndefined();
      const point = at(target.point);
      expect(point).toEqual(at(chartSeriesPoint(training, 32, 'VAL LOSS', scales)!));
      const place = layoutNotes([{ id: 'note', ...view.card, point }], field, { spill: true, leaderOverlap: 1 }).get('note');
      expect(place, 'the note keeps its place on the chart').toBeDefined();
      const card = place!.rect;
      expect(card.top).toBe(0);
      expect(card.left).toBeCloseTo(view.left, 3);
      // Across the plot's top border, clear of the lines by a mark's clearance.
      expect(card.top < field.plot!.top && card.bottom > field.plot!.top).toBe(true);
      expect(hiddenTraceLength(inflate(card, DATA_CLEARANCE), field.traces!)).toBe(0);
      // Drawn as ChartNotes draws it: out of the card's bottom border, onto the point.
      const rounded = { left: Math.round(card.left), top: Math.round(card.top), right: Math.round(card.left) + view.card.width, bottom: Math.round(card.top) + view.card.height };
      const leader = routeLeader(rounded, point, { cutTop: NOTE_CARD_CUT.top, overlap: 1 });
      expect(leader[0].y).toBe(rounded.bottom - 1);
      expect(leader.at(-1)).toEqual(point);
      for (const { dx, dy } of segments(leader)) expect(dx === 0 || dy === 0 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-6).toBe(true);
    });
  }

  it("keeps a mark's clearance from a line, not a wider one", () => {
    // The top row ends 8 px over the line through the point, the bottom row
    // is clear of everything: a card 6 px clear of a line is clear.
    const point = { x: 500, y: 88 };
    const traces = [[{ x: 0, y: 88 }, { x: 1000, y: 88 }]];
    const card = placeNotes([{ id: 'a', width: 300, height: 80, point }], { area: box(0, 0, 1000, 300), traces }).get('a')!;
    expect(card).toEqual(box(350, 0, 300, 80));
    expect(hiddenTraceLength(inflate(card, DATA_CLEARANCE), traces)).toBe(0);
  });

  it('keeps a card that names no point in a top corner clear of the lines, across the plot border where that corner is', () => {
    // The lines start high on the left: the top-right corner is clear.
    const { field } = drawn(training, 0.937, 47, { width: 937, height: 562 });
    const card = placeNotes([{ id: 'general', width: 394, height: 118 }], field).get('general')!;
    expect(card).toEqual(box(543, 0, 394, 118));
    expect(card.top < field.plot!.top && card.bottom > field.plot!.top).toBe(true);
    expect(hiddenTraceLength(inflate(card, DATA_CLEARANCE), field.traces!)).toBe(0);
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

type ChartAnchorAt = { x: number; series: string };

// A dense bar chart, four series of forty categories, with a note on each
// of `anchors`: its cards at the sizes a note card takes on a wide chart,
// and the narrower ones it may try.
function denseBarNotes(anchors: ChartAnchorAt[]): { notes: NoteToPlace[]; field: NoteField } {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const data: ChartData = {
    kind: 'bar',
    labels: Array.from({ length: 40 }, (_, index) => `c${index}`),
    series: Array.from({ length: 4 }, (_, index) => ({ name: `S${index}`, values: Array.from({ length: 40 }, () => Math.round(random() * 2000 - 1000) / 10) })),
  };
  const scales = chartScales(data);
  const obstacles = chartObstacles(data, scales, { named: anchors, led: anchors });
  const field: NoteField = { area: box(0, 0, 1000, 540), plot: scales.plot, marks: obstacles.marks, labels: obstacles.labels, wholly: true };
  const notes: NoteToPlace[] = anchors.map((anchor, index) => {
    const target = chartNoteTarget(data, anchor, scales)!;
    return { id: `n${index}`, width: 420, height: 110, point: target.point, from: target.from, bar: target.bar, sizes: [{ width: 336, height: 130 }, { width: 269, height: 150 }, { width: 180, height: 210 }] };
  });
  return { notes, field };
}

// A line chart, four series of forty samples, with a note on each of `anchors`.
function lineNotes(anchors: ChartAnchorAt[]): { notes: NoteToPlace[]; field: NoteField } {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const data: ChartData = {
    xMax: 39,
    series: Array.from({ length: 4 }, (_, s) => ({ name: `S${s}`, values: Array.from({ length: 40 }, (_, i) => 50 + 30 * Math.sin(i / 17 + s) + random() * 10) })),
  };
  const scales = chartScales(data);
  const obstacles = chartObstacles(data, scales, { named: anchors, led: anchors });
  const field: NoteField = { area: box(0, 0, 1000, 540), plot: scales.plot, traces: obstacles.lines, marks: obstacles.marks, labels: obstacles.labels };
  const notes: NoteToPlace[] = anchors.map((anchor, index) => ({ id: `n${index}`, width: 300, height: 80, point: chartNoteTarget(data, anchor, scales)!.point }));
  return { notes, field };
}

// Notes on every few categories, across the series in turn.
const spread = (count: number): ChartAnchorAt[] => Array.from({ length: count }, (_, index) => ({ x: Math.round((index * 39) / (count - 1)), series: `S${index % 4}` }));

// Placement ran barLeader for every place it tried, before it knew the
// place could not win, and tried every other size again in each run for
// the rail: a 40-category chart of four series with five notes took over a
// second (1208 ms), at mount and on every resize frame (review finding).
// It takes some 200-250 ms of CPU time now, up to 400 ms at load 50; the
// budget is CPU time, the least of three runs (cpuTime.ts says why).
describe('placing notes on a dense bar chart', () => {
  it('stays within a frame budget or two', () => {
    const { notes, field } = denseBarNotes([{ x: 1, series: 'S0' }, { x: 10, series: 'S1' }, { x: 20, series: 'S2' }, { x: 30, series: 'S3' }, { x: 39, series: 'S0' }]);
    expect(leastCpuMs(() => layoutNotes(notes, field, { spill: true }))).toBeLessThan(900);
  });
});

// A line chart's notes take the free leader path: no route is worked out
// for each place a card tries, so a chart of four series with three notes
// and the rail is placed in a few milliseconds. The budget is CPU time, the
// least of three runs (cpuTime.ts says why), wide enough for a loaded machine.
describe('placing notes on a line chart', () => {
  it('stays within a frame budget', () => {
    const { notes, field } = lineNotes([{ x: 10, series: 'S0' }, { x: 20, series: 'S1' }, { x: 30, series: 'S2' }]);
    expect(leastCpuMs(() => layoutNotes(notes, field, { spill: true }))).toBeLessThan(100);
  });
});

// Nothing bounds how many notes a chart carries: an agent that adds one per
// observation and never hides them reaches a dozen in a call. Placed in
// full, the cost grew about as the square of their count: sixteen took
// 1.6 s of CPU on the dense bar chart and 0.5 s on the line chart, about
// 5 s of main thread in the page (review-drawing M2). Past
// `NOTES_PLACED_IN_FULL` the work is bounded; sixteen cost some 40 ms on
// the bar chart and 20 ms on the line chart. The budget is CPU time, the
// least of three runs (cpuTime.ts says why).
describe('placing many notes on one chart', () => {
  it('stays within a frame budget or two with sixteen notes on a dense bar chart', () => {
    const { notes, field } = denseBarNotes(spread(16));
    expect(leastCpuMs(() => layoutNotes(notes, field, { spill: true }))).toBeLessThan(100);
  });

  it('stays within a frame budget or two with sixteen notes on a line chart', () => {
    const { notes, field } = lineNotes(spread(16));
    expect(leastCpuMs(() => layoutNotes(notes, field, { spill: true }))).toBeLessThan(100);
  });

  it(`leaves no note out for the rail past ${NOTES_PLACED_IN_FULL} notes`, () => {
    // Cards as tall as the field: two side by side cover each other, and
    // the rail would take one of them.
    const cards = (count: number): NoteToPlace[] => Array.from({ length: count }, (_, index) => ({ id: `c${index}`, width: 300, height: 300 }));
    expect(layoutNotes(cards(NOTES_PLACED_IN_FULL), { area: box(0, 0, 500, 300) }, { spill: true }).size).toBe(NOTES_PLACED_IN_FULL - 1);
    expect(layoutNotes(cards(NOTES_PLACED_IN_FULL + 1), { area: box(0, 0, 500, 300) }, { spill: true }).size).toBe(NOTES_PLACED_IN_FULL + 1);
  });

  it(`lets only the first ${NOTES_PLACED_IN_FULL} cards placed search for a clear place`, () => {
    // A tall bar under the point: only the search finds the clear place
    // beside it (as "keeps a card off the whole of a bar" above).
    const field: NoteField = { area: box(0, 0, 1000, 400), marks: [box(250, 60, 100, 340)] };
    const named: NoteToPlace = { id: 'named', width: 300, height: 80, point: { x: 300, y: 60 } };
    const others: NoteToPlace[] = Array.from({ length: NOTES_PLACED_IN_FULL }, (_, index) => ({ id: `o${index}`, width: 40, height: 30, point: { x: 600 + index * 80, y: 300 } }));
    const alone = layoutNotes([named], field).get('named')!;
    expect(alone.settled).toBe(true);
    // Placed first of six, it still searches; placed sixth, it takes the best of the rows.
    expect(layoutNotes([named, ...others], field).get('named')!.rect).toEqual(alone.rect);
    const sixth = layoutNotes([...others, named], field).get('named')!;
    expect(sixth.settled).toBe(false);
    // Fifth of five, it searches and finds a clear place.
    expect(layoutNotes([...others.slice(0, -1), named], field).get('named')!.settled).toBe(true);
  });
});

// No place within reach of its point is clear (lines run across the whole
// plot), and no row the card first tries keeps off its point or the plot's
// border. The search for a clear place finds none, as it keeps to places
// clear of the data, so the card would stay across the border. It takes a
// place over the data instead, wholly inside the plot and clear of its
// point: straight above (or below) the point, or beside it, level with it.
describe('a card with no clear place within reach of its point', () => {
  const plotOf = (field: NoteField) => field.plot!;
  const wholeIn = (rect: Rect, plot: Rect) => rect.left >= plot.left && rect.right <= plot.right && rect.top >= plot.top && rect.bottom <= plot.bottom;
  const clearOfPoint = (rect: Rect, point: Point) => !inside(point, inflate(rect, 6));

  it('stands straight above its point, inside the plot, where lines fill the plot and the rows it tries first cross its border', () => {
    const traces = [40, 80, 120, 160, 200, 240].map((y) => [{ x: 20, y }, { x: 280, y }]);
    const field: NoteField = { area: box(0, 0, 300, 300), plot: box(20, 20, 260, 260), traces, wholly: true };
    const point = { x: 150, y: 200 };
    const { rect, leader } = layoutNotes([{ id: 'a', width: 160, height: 50, point, from: 'above' }], field).get('a')!;
    expect(wholeIn(rect, plotOf(field))).toBe(true);
    expect(clearOfPoint(rect, point)).toBe(true);
    // Above it, a gap away, so its leader drops straight onto it.
    expect(rect.bottom).toBeLessThanOrEqual(point.y - 10);
    expect(rect.left < point.x && rect.right > point.x).toBe(true);
    expect(leader.at(-1)).toEqual(point);
  });

  it('stands beside its point, level with it, where its line runs across a plot too short for a row above or below it', () => {
    const field: NoteField = { area: box(0, 0, 400, 140), plot: box(40, 20, 340, 100), traces: [[{ x: 40, y: 70 }, { x: 380, y: 70 }]], wholly: true };
    const point = { x: 200, y: 70 };
    const { rect, leader } = layoutNotes([{ id: 'a', width: 120, height: 40, point, from: 'above' }], field).get('a')!;
    expect(wholeIn(rect, plotOf(field))).toBe(true);
    expect(clearOfPoint(rect, point)).toBe(true);
    expect(rect.top < point.y && rect.bottom > point.y).toBe(true);
    expect(leader.at(-1)).toEqual(point);
  });
});


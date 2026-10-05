import { describe, expect, it } from 'vitest';
import { pipelineDiagram, topologyDiagram } from '../../src/fixtures/scenes';
import { viewDiagram } from '../../src/primitives/diagramLayout';
import {
  RAIL,
  REST_PAD,
  findExits,
  keyStop,
  leadStop,
  mapCorner,
  mapSize,
  pageStop,
  placeExits,
  placed,
  readRim,
  restEnd,
  restStops,
  settleStop,
  tagLength,
  wantsMap,
  type DrawingMap,
  type Span,
  type View,
} from '../../src/primitives/drawingScroll';

const view = (left: number, top: number, right: number, bottom: number): View => ({ left, top, right, bottom });
const none = { left: false, right: false, top: false, bottom: false };

describe('where a scrolled drawing rests', () => {
  // Three layers 200 px wide with 100 px gaps, in a 450 px view.
  const layers: Span[] = [[20, 220], [320, 520], [620, 820], [920, 1120]];

  it('only where the edge it is read from cuts no part: the next part stands clear of the rail', () => {
    const stops = restStops(layers, 1140, 450);
    expect(stops[0]).toBe(0);
    expect(stops.at(-1)).toBe(1140 - 450);
    for (const stop of stops.slice(1, -1)) {
      const clear = stop + RAIL;
      expect(layers.every(([start, end]) => end <= stop || start >= clear), `${stop}`).toBe(true);
      // The part after the rim stands REST_PAD in.
      expect(layers.some(([start]) => start === stop + REST_PAD)).toBe(true);
    }
    expect(stops).toEqual([0, 292, 592, 690]);
  });

  it('under a pinned band, at the band\'s edge', () => {
    const stops = restStops(layers, 1140, 450, 60);
    for (const stop of stops.slice(1, -1)) expect(layers.some(([start]) => start === stop + 60 + REST_PAD)).toBe(true);
  });

  it('in a gap narrower than the rail and its room, as clear as the gap allows', () => {
    // A 12 px gap: the part before keeps its last pixels under the rail; the part after is clear of it.
    const tight: Span[] = [[0, 200], [212, 400], [412, 600]];
    const stops = restStops(tight, 600, 250);
    for (const stop of stops.slice(1, -1)) {
      const next = tight.find(([start]) => start > stop)!;
      expect(next[0] - stop).toBeGreaterThanOrEqual(RAIL);
    }
  });

  it('keeps a label in the gap whole when there is room before it', () => {
    const label: Span = [560, 610];
    const [, at] = restStops(layers, 1140, 450, 0, [label]);
    // Without the label the rim would be at 292 (clear line 310); with it, the label stands clear of the rail.
    expect(at + RAIL).toBeLessThanOrEqual(label[0]);
  });

  it('along a stretch with no gap, at even stops no more than six tenths of a view apart', () => {
    const stops = restStops([[0, 2000]], 2000, 300);
    expect(stops[0]).toBe(0);
    expect(stops.at(-1)).toBe(1700);
    for (let index = 1; index < stops.length; index += 1) expect(stops[index] - stops[index - 1]).toBeLessThanOrEqual(0.6 * 300 + 1);
  });

  it('across rows that leave no common gap, where the rail cuts the fewest parts', () => {
    // Two rows, offset: no line crosses both rows clear, but one crossing a
    // single part is always near.
    const rows: Span[] = [[0, 300], [320, 620], [640, 940], [150, 450], [470, 770], [790, 1090]];
    const stops = restStops(rows, 1100, 400);
    const cuts = (stop: number) => rows.filter(([start, end]) => start < stop + RAIL && end > stop + RAIL).length;
    expect(stops.length).toBeGreaterThan(2);
    for (const stop of stops.slice(1, -1)) expect(cuts(stop), `${stop}`).toBeLessThanOrEqual(1);
  });

  it('a drawing that overflows by no more than a rail rests at its start only: the rest is its margin', () => {
    expect(restStops([[0, 100]], 105, 100)).toEqual([0]);
    expect(restStops([[0, 100], [110, 200]], 100 + RAIL, 100)).toEqual([0]);
  });

  it('a view too small to hold its rails gets no stretch of stops', () => {
    expect(restStops([[0, 3000]], 3000, 10).length).toBeLessThanOrEqual(3);
  });

  it('reaches a little past the drawing\'s end when its last place to rest would cut a part, and no further', () => {
    // At 690 (1140 - 450) the edge falls inside the layer [620, 820].
    expect(restEnd(layers, 1140, 450)).toBe(1140 + (920 - REST_PAD - 690));
    const end = restEnd(layers, 1140, 450);
    const stops = restStops(layers, end, 450);
    const last = stops.at(-1)!;
    expect(layers.every(([start, finish]) => finish <= last + RAIL || start >= last + RAIL)).toBe(true);
    // The last layer stays whole in view.
    expect(last + 450).toBeGreaterThanOrEqual(1120);
    // An end that cuts nothing is left alone; one that needs more than half a view of black is too.
    expect(restEnd([[20, 220], [320, 520], [620, 820]], 840, 300)).toBe(840);
    expect(restEnd([[0, 500], [900, 1300]], 1300, 450)).toBe(1300);
  });

  it('a drawing that fits rests at its start only', () => {
    expect(restStops(layers, 400, 450)).toEqual([0]);
  });

  it('opens on its lead whole, clear of the rails, at a stop whose edge cuts nothing, nearest centring it', () => {
    const stops = restStops(layers, 1140, 450);
    const lead: Span = [620, 820];
    const at = leadStop(stops, lead, 450, 0, layers);
    expect(lead[0]).toBeGreaterThanOrEqual(at + RAIL);
    expect(lead[1]).toBeLessThanOrEqual(at + 450 - (at < stops.at(-1)! ? RAIL : 0));
    expect(at).toBe(592);
    // The far end shows the last layer whole too, but its edge cuts the layer before; the clean stop wins.
    expect(leadStop([0, 500, 690], [920, 1120], 450, 0, layers)).toBe(690);
    expect(leadStop([0, 500, 700], [920, 1120], 450, 0, [[0, 400], [480, 520], [920, 1120]])).toBe(700);
  });

  it('settles a wheel\'s nudge back where it rested, and a notch on to the next stop', () => {
    const stops = [0, 292, 592, 690];
    expect(settleStop(stops, 292, 300)).toBe(292);
    expect(settleStop(stops, 292, 392)).toBe(592);
    expect(settleStop(stops, 292, 200)).toBe(0);
    expect(settleStop(stops, 292, 560)).toBe(592);
    expect(settleStop(stops, 0, 640)).toBe(592);
  });

  it('turns a page to the furthest stop that keeps the last of the view in sight', () => {
    const stops = [0, 292, 592, 690];
    expect(pageStop(stops, 0, 450, 1)).toBe(292);
    expect(pageStop(stops, 292, 450, 1)).toBe(592);
    // Back from the far end, the only stop within a page.
    expect(pageStop(stops, 690, 450, -1)).toBe(592);
    expect(pageStop(stops, 592, 450, -1)).toBe(292);
    expect(pageStop(stops, 0, 450, -1)).toBe(0);
    // A next stop beyond a page is still the next stop.
    expect(pageStop([0, 900], 0, 450, 1)).toBe(900);
  });

  it('moves a key\'s way from stop to stop, along the axis its arrows point', () => {
    const stops = [0, 292, 592, 690];
    expect(keyStop(' ', false, false, stops, 0, 450)).toBe(292);
    expect(keyStop(' ', true, false, stops, 592, 450)).toBe(292);
    expect(keyStop('PageDown', false, true, stops, 292, 450)).toBe(592);
    expect(keyStop('PageUp', false, true, stops, 292, 450)).toBe(0);
    expect(keyStop('ArrowDown', false, false, stops, 292, 450)).toBe(592);
    expect(keyStop('ArrowUp', false, false, stops, 300, 450)).toBe(292);
    expect(keyStop('ArrowRight', false, true, stops, 690, 450)).toBe(690);
    expect(keyStop('ArrowLeft', false, true, stops, 292, 450)).toBe(0);
    expect(keyStop('Home', false, false, stops, 592, 450)).toBe(0);
    expect(keyStop('End', false, true, stops, 0, 450)).toBe(690);
    // An arrow across a drawing read down, or a key that does not scroll, is not the drawing's.
    expect(keyStop('ArrowRight', false, false, stops, 0, 450)).toBeNull();
    expect(keyStop('ArrowDown', false, true, stops, 0, 450)).toBeNull();
    expect(keyStop('Enter', false, false, stops, 0, 450)).toBeNull();
  });
});

describe('the hard diagrams at rest in the stage geometries', () => {
  // The diagram slot's viewport at the visual suite's four geometries, and
  // the focus layer's at two.
  const viewports = [
    { width: 914, height: 526 },
    { width: 330, height: 374 },
    { width: 726, height: 531 },
    { width: 1980, height: 604 },
    { width: 1325, height: 791 },
    { width: 367, height: 725 },
  ];
  for (const [name, data, anchor] of [['topology', topologyDiagram, 'gate'], ['pipeline', pipelineDiagram, 'visual']] as const) {
    for (const size of viewports) {
      it(`${name} in ${size.width} x ${size.height}: every place it rests along its layers, its far end too, leaves no node cut at its edge`, () => {
        const { layout, fit } = viewDiagram(data, { ...size, scrollbar: 0 }, anchor);
        const place = { scale: fit.scale, offsetX: Math.max(0, (size.width - fit.width) / 2), offsetY: Math.max(0, (size.height - fit.height) / 2) };
        const boxes = layout.nodes.map((node) => placed(node.box, place));
        const axes = [
          ...(fit.scrollX && !fit.scrollY ? [{ spans: boxes.map((box): Span => [box.left, box.right]), length: Math.max(size.width, fit.width), view: size.width }] : []),
          ...(fit.scrollY && !fit.scrollX ? [{ spans: boxes.map((box): Span => [box.top, box.bottom]), length: Math.max(size.height, fit.height), view: size.height }] : []),
        ];
        for (const { spans, length, view: span } of axes) {
          const stops = restStops(spans, restEnd(spans, length, span), span);
          expect(stops.length).toBeGreaterThan(2);
          for (const stop of stops) {
            const clear = stop + (stop > 0 ? RAIL : 0);
            const cut = spans.filter(([start, end]) => start < clear - 0.5 && end > clear + 0.5);
            expect(cut, `rest at ${stop}`).toEqual([]);
          }
          const anchored = boxes[layout.nodes.findIndex((node) => node.node.id === anchor)];
          const lead: Span = fit.scrollX ? [anchored.left, anchored.right] : [anchored.top, anchored.bottom];
          const opened = leadStop(stops, lead, span, 0, spans);
          expect(lead[0], 'the anchored node opens whole').toBeGreaterThanOrEqual(opened);
          expect(lead[1], 'the anchored node opens whole').toBeLessThanOrEqual(opened + span);
        }
      });
    }
  }
});

describe('what each rim says', () => {
  const parts = [view(0, 0, 100, 50), view(150, 0, 250, 50), view(300, 0, 400, 50), view(450, 0, 550, 50), view(200, 300, 260, 340)];

  it('counts the parts past each edge the drawing continues past, a part under the rail with them', () => {
    const rim = readRim(parts, view(130, 0, 420, 200), { ...none, left: true, right: true, bottom: true });
    expect(rim.left?.beyond).toBe(1);
    // [150, 250] reaches under the left rail (140 to 158).
    expect(readRim(parts, view(140, 0, 420, 200), { ...none, left: true }).left?.beyond).toBe(2);
    // [300, 400] reaches under the right rail (402 to 420).
    expect(rim.right?.beyond).toBe(1);
    expect(rim.bottom?.beyond).toBe(1);
    expect(rim.top).toBeNull();
    const deeper = readRim(parts, view(140, 0, 390, 200), { ...none, right: true });
    expect(deeper.right?.beyond).toBe(2);
  });

  it('fades as deep as a cut part reaches in, and as deep as a cut label', () => {
    const rim = readRim(parts, view(120, 0, 330, 200), { ...none, left: true, right: true });
    // [150, 250] is clear of the left rail (120 to 138); [300, 400] is cut 30 px in.
    expect(rim.left?.depth).toBe(0);
    expect(rim.right?.depth).toBe(30);
    const labelled = readRim(parts, view(120, 0, 330, 200), { ...none, left: true }, [view(110, 60, 160, 70)]);
    expect(labelled.left?.depth).toBe(40);
    expect(labelled.left?.beyond).toBe(1);
  });

  it('fades only what is in view across the edge', () => {
    // Scrolled both ways: a part wholly above the view reaches past its left rim.
    const above = [view(0, 0, 300, 50)];
    const rim = readRim(above, view(100, 100, 500, 400), { ...none, left: true, top: true });
    expect(rim.left).toEqual({ beyond: 1, depth: 0 });
    expect(rim.top?.beyond).toBe(1);
  });

  it('says nothing of an edge the drawing ends at', () => {
    expect(readRim(parts, view(0, 0, 600, 400), none)).toEqual({ left: null, right: null, top: null, bottom: null });
  });
});

describe('a line that leaves the view', () => {
  const map: Pick<DrawingMap, 'parts' | 'links'> = {
    parts: [
      { box: { x: 0, y: 0, width: 100, height: 40 }, label: 'Browser page' },
      { box: { x: 300, y: 0, width: 100, height: 40 }, label: 'Call runtime' },
      { box: { x: 300, y: 100, width: 100, height: 40 }, label: 'PBX' },
      { box: { x: 600, y: 0, width: 100, height: 40 }, label: 'Gate' },
    ],
    links: [
      { points: [{ x: 100, y: 20 }, { x: 300, y: 20 }], from: 0, to: 1, tone: 'var(--paper)' },
      { points: [{ x: 100, y: 30 }, { x: 200, y: 30 }, { x: 200, y: 120 }, { x: 300, y: 120 }], from: 0, to: 2, tone: 'var(--cyan)' },
      { points: [{ x: 600, y: 20 }, { x: 400, y: 20 }], from: 3, to: 1, tone: 'var(--orange)' },
      { points: [{ x: 600, y: 30 }, { x: 500, y: 30 }, { x: 500, y: 110 }, { x: 400, y: 110 }], from: 3, to: 2, tone: 'var(--orange)' },
    ],
  };
  const place = { scale: 1, offsetX: 0, offsetY: 0 };
  const parts = map.parts.map((part) => placed(part.box, place));
  const labels = map.parts.map((part) => part.label);

  it('names the part at its far end, where it crosses the rim, walking from the part in view', () => {
    // Seen from x = 260, the browser page's lines leave by the left rim; the gate's by the right.
    const exits = findExits(parts, map.links, labels, place, view(260, 0, 460, 200));
    expect(exits.map((exit) => [exit.side, exit.label, exit.tone])).toEqual([
      ['left', 'Browser page', 'var(--paper)'],
      ['right', 'Gate', 'var(--orange)'],
    ]);
  });

  it('several lines to one part across one rim are one exit, where the middle one crosses', () => {
    // The browser page's two lines cross the left rim at y = 20 and y = 120.
    const [left] = findExits(parts, map.links, labels, place, view(260, 0, 460, 200));
    expect(left.at).toBe(20);
    // Seen from y = 60 down, only the line to the PBX leaves to the left, at its own height.
    const low = findExits(parts, map.links, labels, place, view(260, 60, 460, 200)).filter((exit) => exit.side === 'left');
    expect(low.map((exit) => exit.at)).toEqual([120]);
  });

  it('names none for a line between two parts in view, or two out of it', () => {
    expect(findExits(parts, map.links, labels, place, view(-10, -10, 800, 200))).toEqual([]);
    expect(findExits(parts, map.links, labels, place, view(420, 50, 580, 90))).toEqual([]);
  });

  it('places each name on its rail near where its line crosses, clear of the rail\'s count and the map, never on another', () => {
    const exits = [
      { side: 'right' as const, at: 100, part: 1, label: 'ElevenLabs TTS', tone: 'x' },
      { side: 'right' as const, at: 110, part: 2, label: 'Display gate', tone: 'x' },
      { side: 'right' as const, at: 250, part: 3, label: 'Debug page', tone: 'x' },
      { side: 'right' as const, at: 470, part: 4, label: 'Skill socket', tone: 'x' },
      { side: 'bottom' as const, at: 300, part: 5, label: 'PBX', tone: 'x' },
    ];
    const avoid = { left: [], right: [[230, 290] as Span, [400, 500] as Span], top: [], bottom: [] };
    const placedTags = placeExits(exits, { left: 0, top: 0 }, { width: 800, height: 500 }, avoid);
    const right = placedTags.filter((tag) => tag.side === 'right');
    // In order along the rail; one with no room left before the map is left out.
    expect(right.map((tag) => tag.label)).toEqual(['ElevenLabs TTS', 'Display gate']);
    expect(right[0].y + right[0].height / 2).toBeCloseTo(100);
    for (const tag of right) {
      expect(tag.width).toBe(15);
      expect(tag.height).toBe(tagLength(tag.label.length));
      expect(tag.x + tag.width).toBeLessThanOrEqual(800);
      expect(tag.x).toBeGreaterThanOrEqual(800 - RAIL);
      for (const [low, high] of avoid.right) expect(tag.y + tag.height <= low || tag.y >= high).toBe(true);
    }
    for (let index = 1; index < right.length; index += 1) expect(right[index].y).toBeGreaterThanOrEqual(right[index - 1].y + right[index - 1].height);
    const [bottom] = placedTags.filter((tag) => tag.side === 'bottom');
    expect(bottom.width).toBe(tagLength(3));
    expect(bottom.x + bottom.width / 2).toBeCloseTo(300);
    expect(bottom.y).toBeGreaterThanOrEqual(500 - RAIL);
  });
});

describe('the map', () => {
  it('stands only where the drawing scrolls far, in room enough', () => {
    expect(wantsMap({ width: 2500, height: 526 }, { width: 914, height: 526 })).toBe(true);
    expect(wantsMap({ width: 1200, height: 526 }, { width: 914, height: 526 })).toBe(false);
    // A phone's aux cell: the map would cover too much of what it maps.
    expect(wantsMap({ width: 1000, height: 128 }, { width: 334, height: 128 })).toBe(false);
  });

  it('keeps the drawing\'s shape, a small share of the view, no side past its caps', () => {
    for (const [drawing, viewport] of [
      [{ width: 3116, height: 658 }, { width: 914, height: 526 }],
      [{ width: 405, height: 3850 }, { width: 330, height: 374 }],
      [{ width: 1788, height: 2177 }, { width: 330, height: 374 }],
      [{ width: 3155, height: 761 }, { width: 1980, height: 604 }],
    ] as const) {
      const size = mapSize(drawing, viewport);
      expect(size.width / size.height).toBeCloseTo(drawing.width / drawing.height);
      expect(size.width * size.height).toBeLessThanOrEqual(0.02 * viewport.width * viewport.height + 1e-6);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(300);
      expect(size.width).toBeLessThanOrEqual(viewport.width * 0.6);
      expect(size.height).toBeLessThanOrEqual(viewport.height * 0.6);
    }
  });

  it('takes the corner that covers least of the parts, where the drawing opens and as it scrolls', () => {
    const box = { width: 200, height: 60 };
    const viewport = { width: 900, height: 500 };
    // A drawing scrolling across, its parts along the bottom band.
    const bottomHeavy = [view(0, 440, 2000, 500), view(100, 200, 300, 260)];
    expect(mapCorner(bottomHeavy, viewport, { width: 2000, height: 500 }, { left: 0, top: 0 }, box, false)).toMatch(/^top-/);
    // A part where it opens, at the top right: the top left.
    const topRight = [view(750, 0, 900, 60), view(0, 440, 2000, 500)];
    expect(mapCorner(topRight, viewport, { width: 2000, height: 500 }, { left: 0, top: 0 }, box, false)).toBe('top-left');
    // Nothing anywhere: bottom right.
    expect(mapCorner([], viewport, { width: 2000, height: 500 }, { left: 0, top: 0 }, box, false)).toBe('bottom-right');
    // A pinned band at the top leaves it the bottom.
    expect(mapCorner(bottomHeavy, viewport, { width: 2000, height: 500 }, { left: 0, top: 0 }, box, true)).toMatch(/^bottom-/);
  });
});

import { describe, expect, it } from 'vitest';
import type { DiagramData } from '../../src/controller/types';
import { ARROW_LENGTH, breakCycles, layoutDiagram, measureNode, type Box, type DiagramOrientation, type Point } from '../../src/primitives/diagramLayout';

const graph = (nodes: string[], edges: Array<[string, string, string]>): DiagramData => ({
  mode: 'graph',
  nodes: nodes.map((id) => ({ id, label: id.toUpperCase() })),
  edges: edges.map(([from, to, label]) => ({ from, to, label })),
});

const moduleNames = ['main', 'config', 'pbx', 'prewarm', 'leg_announcer', 'visual_protocol', 'display_gate', 'ws', 'speech', 'clip', 'turn', 'host_link', 'skill_socket', 'auth'];

const graphs: Record<string, DiagramData> = {
  // Five layers, a label on every edge.
  chain: graph(['source', 'build', 'review', 'deploy', 'live'], [
    ['source', 'build', 'compile'],
    ['build', 'review', 'validate'],
    ['review', 'deploy', 'approve'],
    ['deploy', 'live', 'release'],
  ]),
  // An edge that skips a layer must not run through the node it skips.
  skip: graph(['a', 'b', 'c', 'd'], [
    ['a', 'b', 'next'],
    ['b', 'c', 'next'],
    ['a', 'c', 'shortcut'],
    ['c', 'd', 'done'],
  ]),
  fan: graph(['in', 'left', 'mid', 'right', 'out'], [
    ['in', 'left', 'west'],
    ['in', 'mid', 'centre'],
    ['in', 'right', 'east'],
    ['left', 'out', 'merge'],
    ['mid', 'out', 'merge'],
    ['right', 'out', 'merge'],
  ]),
  // A feedback loop: one edge is laid out backwards and drawn toward its true target.
  cycle: graph(['plan', 'act', 'check'], [
    ['plan', 'act', 'do'],
    ['act', 'check', 'verify'],
    ['check', 'plan', 'revise'],
  ]),
  // An eight-node request pipeline with feedback edges and labelled edges.
  pipeline: {
    mode: 'graph',
    nodes: [
      { id: 'browser', label: 'Browser', sub: 'React client' },
      { id: 'ws', label: 'WebSocket gateway', sub: 'tokio / axum', detail: 'apps/backend/src/ws.rs' },
      { id: 'pbx', label: 'PBX', sub: 'routes legs', state: 'active', semantic: 'orange' },
      { id: 'operator', label: 'Operator agent', sub: 'pi + operator-switchboard.ts' },
      { id: 'project', label: 'Project agent', sub: 'pi over ssh in project dir' },
      { id: 'stt', label: 'Speech-to-text sidecar', sub: 'whisper' },
      { id: 'tts', label: 'ElevenLabs', sub: 'text-to-speech' },
      { id: 'display', label: 'Display projection', sub: 'DisplayProjection::apply' },
    ],
    edges: [
      { from: 'browser', to: 'ws', label: 'audio clip' },
      { from: 'ws', to: 'stt', label: 'wav' },
      { from: 'stt', to: 'pbx', label: 'transcript' },
      { from: 'pbx', to: 'operator', label: 'turn' },
      { from: 'pbx', to: 'project', label: 'turn (after transfer)' },
      { from: 'operator', to: 'pbx', label: 'transfer signal' },
      { from: 'project', to: 'display', label: 'POST /display' },
      { from: 'display', to: 'ws', label: 'display frame' },
      { from: 'pbx', to: 'tts', label: 'speech' },
      { from: 'tts', to: 'ws', label: 'mp3' },
    ],
  },
  // A fourteen-module dependency DAG with skip edges.
  deps: {
    mode: 'graph',
    nodes: moduleNames.map((label, index) => ({ id: `m${index}`, label })),
    edges: [[0, 1], [0, 2], [0, 7], [2, 3], [2, 4], [2, 10], [7, 9], [7, 6], [6, 5], [10, 8], [10, 2], [3, 11], [11, 12], [0, 13], [7, 13], [12, 5], [4, 6], [9, 10]].map(
      ([from, to]) => ({ from: `m${from}`, to: `m${to}` }),
    ),
  },
  // A six-state lifecycle with back edges (hand back, reset).
  states: {
    mode: 'graph',
    nodes: [
      { id: 'idle', label: 'Idle', state: 'done' },
      { id: 'ringing', label: 'Ringing', state: 'done' },
      { id: 'operator', label: 'With operator', state: 'done' },
      { id: 'transferring', label: 'Transferring', state: 'active' },
      { id: 'project', label: 'With project agent', state: 'todo' },
      { id: 'ended', label: 'Ended', state: 'todo' },
    ],
    edges: [
      { from: 'idle', to: 'ringing', label: 'hello' },
      { from: 'ringing', to: 'operator', label: 'answered' },
      { from: 'operator', to: 'transferring', label: 'transfer' },
      { from: 'transferring', to: 'project', label: 'settled' },
      { from: 'project', to: 'operator', label: 'hand back' },
      { from: 'transferring', to: 'operator', label: 'failed' },
      { from: 'operator', to: 'ended', label: 'hangup' },
      { from: 'project', to: 'ended', label: 'hangup' },
      { from: 'ended', to: 'idle', label: 'reset' },
    ],
  },
  // A one-to-nine fan-out with long labels.
  wide: {
    mode: 'graph',
    nodes: [
      { id: 'root', label: 'Coordinator' },
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `w${index}`,
        label: `Worker ${index + 1} with a fairly long label`,
        sub: `review round ${index + 1}`,
      })),
    ],
    edges: Array.from({ length: 9 }, (_, index) => ({ from: 'root', to: `w${index}`, label: index % 3 === 0 ? 'high' : undefined })),
  },
};

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const inset = (box: Box, by: number): Box => ({
  x: box.x + by,
  y: box.y + by,
  width: box.width - 2 * by,
  height: box.height - 2 * by,
});

const within = (box: Box, width: number, height: number) =>
  box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height;

// Every route is axis-aligned, so a segment is a zero-thickness box.
const segmentBox = (a: Point, b: Point): Box => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.max(Math.abs(a.x - b.x), 0.001),
  height: Math.max(Math.abs(a.y - b.y), 0.001),
});

// A label names the route it sits on: its centre lies on one of the
// route's segments.
const onRoute = (point: Point, points: Point[]) =>
  points.slice(1).some((end, index) => {
    const box = segmentBox(points[index], end);
    return point.x >= box.x - 1e-6 && point.x <= box.x + box.width + 1e-6 && point.y >= box.y - 1e-6 && point.y <= box.y + box.height + 1e-6;
  });

// The arrowhead at a route's end: the last ARROW_LENGTH of its final
// segment, as wide as it is long.
const arrowhead = (points: Point[]): Box => {
  const end = points[points.length - 1];
  const before = points[points.length - 2];
  if (Math.abs(end.y - before.y) < 1e-6) {
    const back = end.x - Math.sign(end.x - before.x) * ARROW_LENGTH;
    return { x: Math.min(end.x, back), y: end.y - ARROW_LENGTH / 2, width: ARROW_LENGTH, height: ARROW_LENGTH };
  }
  const back = end.y - Math.sign(end.y - before.y) * ARROW_LENGTH;
  return { x: end.x - ARROW_LENGTH / 2, y: Math.min(end.y, back), width: ARROW_LENGTH, height: ARROW_LENGTH };
};

const onOutline = (point: Point, box: Box) => {
  const onVertical = (Math.abs(point.x - box.x) < 1e-6 || Math.abs(point.x - (box.x + box.width)) < 1e-6) && point.y >= box.y && point.y <= box.y + box.height;
  const onHorizontal = (Math.abs(point.y - box.y) < 1e-6 || Math.abs(point.y - (box.y + box.height)) < 1e-6) && point.x >= box.x && point.x <= box.x + box.width;
  return onVertical || onHorizontal;
};

for (const orientation of ['landscape', 'portrait'] as DiagramOrientation[]) {
  describe(`diagram layout / ${orientation}`, () => {
    for (const [name, data] of Object.entries(graphs)) {
      const layout = layoutDiagram(data, orientation);
      const labels = layout.edges.flatMap((edge) => (edge.label ? [edge.label] : []));
      const nodeBox = (id: string) => layout.nodes.find((node) => node.node.id === id)?.box;

      it(`${name}: lays out every node and edge inside the drawing`, () => {
        expect(layout.nodes).toHaveLength(data.nodes.length);
        expect(layout.edges).toHaveLength(data.edges.length);
        for (const node of layout.nodes) expect(within(node.box, layout.width, layout.height), node.node.id).toBe(true);
        for (const edge of layout.edges) {
          for (const point of edge.points) {
            expect(point.x).toBeGreaterThanOrEqual(0);
            expect(point.y).toBeGreaterThanOrEqual(0);
            expect(point.x).toBeLessThanOrEqual(layout.width);
            expect(point.y).toBeLessThanOrEqual(layout.height);
          }
        }
        for (const label of labels) expect(within(label.box, layout.width, layout.height), label.text).toBe(true);
      });

      it(`${name}: no two nodes overlap`, () => {
        layout.nodes.forEach((node, index) => {
          for (const other of layout.nodes.slice(index + 1)) {
            expect(overlaps(node.box, other.box), `${node.node.id} over ${other.node.id}`).toBe(false);
          }
        });
      });

      it(`${name}: every label clears every node and every other label`, () => {
        expect(labels).toHaveLength(data.edges.filter((edge) => edge.label).length);
        for (const label of labels) {
          for (const node of layout.nodes) {
            expect(overlaps(label.box, node.box), `${label.text} over ${node.node.id}`).toBe(false);
          }
        }
        labels.forEach((label, index) => {
          for (const other of labels.slice(index + 1)) {
            expect(overlaps(label.box, other.box), `${label.text} over ${other.text}`).toBe(false);
          }
        });
      });

      it(`${name}: every label sits on its own route and clears every arrowhead`, () => {
        for (const edge of layout.edges) {
          if (edge.label) expect(onRoute(edge.label, edge.points), `${edge.label.text} on ${edge.edge.from}->${edge.edge.to}`).toBe(true);
        }
        for (const edge of layout.edges) {
          const head = arrowhead(edge.points);
          for (const label of labels) expect(overlaps(head, label.box), `${label.text} over the arrowhead of ${edge.edge.from}->${edge.edge.to}`).toBe(false);
        }
      });

      it(`${name}: routes pass through no node but their own ends`, () => {
        for (const edge of layout.edges) {
          expect(edge.points.length).toBeGreaterThanOrEqual(2);
          for (let index = 1; index < edge.points.length; index += 1) {
            const segment = segmentBox(edge.points[index - 1], edge.points[index]);
            // Consecutive points share an axis: the route is axis-aligned.
            expect(Math.min(segment.width, segment.height)).toBeLessThanOrEqual(0.001);
            for (const node of layout.nodes) {
              const own = node.node.id === edge.edge.from || node.node.id === edge.edge.to;
              // A route may touch its own ends' outlines, never cross their bodies.
              const body = own ? inset(node.box, 1) : node.box;
              expect(overlaps(segment, body), `${edge.edge.from}->${edge.edge.to} through ${node.node.id}`).toBe(false);
            }
          }
        }
      });

      it(`${name}: every route runs from its source's outline to its target's, back edges included`, () => {
        for (const edge of layout.edges) {
          const from = nodeBox(edge.edge.from)!;
          const to = nodeBox(edge.edge.to)!;
          expect(onOutline(edge.points[0], from), `${edge.edge.from}->${edge.edge.to} starts at ${edge.edge.from}`).toBe(true);
          expect(onOutline(edge.points[edge.points.length - 1], to), `${edge.edge.from}->${edge.edge.to} ends at ${edge.edge.to}`).toBe(true);
        }
      });
    }

    it('keeps the approved geometry when the drawing already fits', () => {
      const small = layoutDiagram(graph(['a', 'b'], [['a', 'b', 'go']]), orientation);
      expect([small.width, small.height]).toEqual(orientation === 'landscape' ? [1000, 620] : [700, 1000]);
    });

    it('staggers a crowded layer into two rows instead of growing the drawing past reading', () => {
      const layout = layoutDiagram(graphs.wide, orientation);
      const workers = layout.nodes.filter((node) => node.node.id !== 'root');
      const mainOf = (box: Box) => (orientation === 'landscape' ? box.x : box.y);
      const crossOf = (box: Box) => (orientation === 'landscape' ? box.height : box.width);
      expect(new Set(workers.map((node) => mainOf(node.box))).size).toBe(2);
      const stacked = workers.reduce((sum, node) => sum + crossOf(node.box), 0);
      expect(orientation === 'landscape' ? layout.height : layout.width).toBeLessThan(stacked);
      // A back-row box's edge passes between two front-row boxes.
      const [first] = workers.map((node) => mainOf(node.box)).sort((a, b) => a - b);
      const front = workers.filter((node) => mainOf(node.box) === first);
      expect(front.length).toBeGreaterThanOrEqual(4);
    });

    it('sends a fan-out too crowded for its side out as one trunk whose branches never cross', () => {
      const layout = layoutDiagram(graphs.wide, orientation);
      const starts = new Set(layout.edges.map((edge) => `${edge.points[0].x},${edge.points[0].y}`));
      // Nine ports on a landscape box's short side would be a striped band;
      // a portrait box's long side has room to spread them.
      expect(starts.size).toBe(orientation === 'landscape' ? 1 : 9);
      const crossings = layout.edges.flatMap((edge, index) =>
        layout.edges.slice(index + 1).flatMap((other) =>
          edge.points.slice(1).flatMap((end, k) =>
            other.points.slice(1).filter((otherEnd, j) => {
              const [a, b, c, d] = [edge.points[k], end, other.points[j], otherEnd];
              const across = (p: Point, q: Point, r: Point, s: Point) =>
                Math.abs(p.y - q.y) < 1e-6 &&
                Math.abs(r.x - s.x) < 1e-6 &&
                r.x > Math.min(p.x, q.x) + 1e-6 &&
                r.x < Math.max(p.x, q.x) - 1e-6 &&
                p.y > Math.min(r.y, s.y) + 1e-6 &&
                p.y < Math.max(r.y, s.y) - 1e-6;
              return across(a, b, c, d) || across(c, d, a, b);
            }),
          ),
        ),
      );
      expect(crossings).toHaveLength(0);
    });

    it('lays a feedback edge out backwards and draws it toward its true target', () => {
      const layout = layoutDiagram(graphs.cycle, orientation);
      const revise = layout.edges.find((edge) => edge.edge.label === 'revise')!;
      expect(revise.reversed).toBe(true);
      expect(layout.edges.filter((edge) => edge.reversed)).toHaveLength(1);
      const plan = layout.nodes.find((node) => node.node.id === 'plan')!;
      const check = layout.nodes.find((node) => node.node.id === 'check')!;
      // The loop's three nodes sit in three layers, the back edge spanning them.
      expect(plan.layer).toBe(0);
      expect(check.layer).toBe(2);
      expect(onOutline(revise.points[revise.points.length - 1], plan.box)).toBe(true);
    });

    it('routes a long edge through the gaps of the layers it skips', () => {
      const layout = layoutDiagram(graphs.states, orientation);
      const reset = layout.edges.find((edge) => edge.edge.label === 'reset')!;
      const idle = layout.nodes.find((node) => node.node.id === 'idle')!;
      const ended = layout.nodes.find((node) => node.node.id === 'ended')!;
      expect(ended.layer - idle.layer).toBeGreaterThanOrEqual(4);
      expect(reset.reversed).toBe(true);
      // The route runs beside the chain of nodes it skips, a dummy's spacing
      // away at most, rather than looping around the outside of the drawing.
      const crossOf = (point: Point) => (orientation === 'landscape' ? point.y : point.x);
      const nodeCross = layout.nodes.map((node) => (orientation === 'landscape' ? [node.box.y, node.box.y + node.box.height] : [node.box.x, node.box.x + node.box.width]));
      const low = Math.min(...nodeCross.map(([a]) => a));
      const high = Math.max(...nodeCross.map(([, b]) => b));
      for (const point of reset.points) {
        expect(crossOf(point)).toBeGreaterThanOrEqual(low - 40);
        expect(crossOf(point)).toBeLessThanOrEqual(high + 40);
      }
    });
  });
}

describe('edge labels in landscape', () => {
  // A label's backing hides whatever it covers, so a label over another
  // edge's line would read as naming it. Where the graph leaves room, a
  // label never does. (A pair of opposite edges between the same two
  // nodes, carrying a two-line label, can leave none: the pipeline's
  // "transfer signal" still covers its partner.)
  for (const name of ['chain', 'skip', 'fan', 'cycle', 'states', 'wide']) {
    it(`${name}: no label hides another edge's line`, () => {
      const layout = layoutDiagram(graphs[name], 'landscape');
      for (const edge of layout.edges) {
        const label = edge.label;
        if (!label) continue;
        for (const other of layout.edges) {
          if (other === edge) continue;
          other.points.slice(1).forEach((end, index) => {
            expect(overlaps(segmentBox(other.points[index], end), label.box), `${label.text} over ${other.edge.from}->${other.edge.to}`).toBe(false);
          });
        }
      }
    });
  }
});

describe('node measurement', () => {
  it('sizes a box to its wrapped text', () => {
    const short = measureNode({ id: 'a', label: 'PBX' }, false);
    const long = measureNode({ id: 'b', label: 'Worker 1 with a fairly long label', sub: 'review round 1', detail: 'apps/backend/src/ws.rs' }, false);
    expect(short.width).toBe(140);
    expect(short.lines.map((line) => line.kind)).toEqual(['label']);
    expect(long.lines.filter((line) => line.kind === 'label').map((line) => line.text)).toEqual(['Worker 1 with', 'a fairly long label']);
    expect(long.width).toBeGreaterThan(short.width);
    expect(long.height).toBeGreaterThan(short.height);
    expect(long.lines.map((line) => line.kind)).toEqual(['label', 'label', 'sub', 'detail']);
    expect(long.lines.every((line) => line.y < long.height)).toBe(true);
  });

  it('reserves room for a corner tag beside the label', () => {
    const plain = measureNode({ id: 'a', label: 'Operator agent' }, false);
    const tagged = measureNode({ id: 'a', label: 'Operator agent' }, true);
    expect(tagged.width - plain.width).toBe(30);
  });
});

describe('cycle removal', () => {
  const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id }));

  it('reverses only the edges that close a loop', () => {
    const directed = breakCycles(nodes, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
      { from: 'c', to: 'd' },
    ]);
    expect(directed.map((entry) => [entry.from, entry.to, entry.reversed])).toEqual([
      ['a', 'b', false],
      ['b', 'c', false],
      ['a', 'c', true],
      ['c', 'd', false],
    ]);
  });

  it('leaves self-loops and edges to unknown nodes out', () => {
    const directed = breakCycles(nodes, [
      { from: 'a', to: 'a' },
      { from: 'a', to: 'zzz' },
      { from: 'a', to: 'b' },
    ]);
    expect(directed).toHaveLength(1);
    expect(directed[0].edge).toEqual({ from: 'a', to: 'b' });
  });
});

describe('diagram callout placement', () => {
  it('places a callout near the anchored node without covering other nodes in landscape', () => {
    const layout = layoutDiagram(graphs.chain, 'landscape', 'review');
    expect(layout.callout).not.toBeNull();
    expect(layout.callout?.targetNodeId).toBe('review');
    expect(layout.callout?.leader).toHaveLength(2);
    for (const node of layout.nodes) {
      if (node.node.id === 'review') continue;
      expect(overlaps(layout.callout!.box, node.box)).toBe(false);
    }
    for (const edge of layout.edges) {
      if (edge.label) expect(overlaps(layout.callout!.box, edge.label.box)).toBe(false);
    }
  });

  it('returns null callout in portrait to trigger fallback to the rail', () => {
    const layout = layoutDiagram(graphs.chain, 'portrait', 'review');
    expect(layout.callout).toBeNull();
  });

  it('returns null callout when the node id is unknown', () => {
    const layout = layoutDiagram(graphs.chain, 'landscape', 'unknown-node');
    expect(layout.callout).toBeNull();
  });
});

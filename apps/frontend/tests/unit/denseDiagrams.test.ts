import { describe, expect, it } from 'vitest';
import type { DiagramData } from '../../src/controller/types';
import { fixtures, pipelineDiagram, topologyDiagram } from '../../src/fixtures/scenes';
import {
  ARROW_PORT_PITCH,
  GRAPH_MIN_SCALE,
  frameFor,
  layoutDiagram,
  viewDiagram,
  type DiagramLayout,
  type DiagramOrientation,
  type LaidOutEdge,
  type Point,
} from '../../src/primitives/diagramLayout';

// Dense graphs (fixtures `topology` and `pipeline`) as a reader meets them:
// laid out for the diagram slot at each canonical geometry
// (playwright.config.ts, tests/visual) and for the focus layer. Every edge
// can be followed: few crossings, no wide bundle of unrelated lines, an
// arrowhead of its own at every port, and an edge longer than the frame
// drawn as a stub pair naming its far ends.

const viewports = {
  'landscape 1440x900': { width: 914, height: 526 },
  'portrait-phone 390x844': { width: 330, height: 374 },
  'portrait-tablet 820x1180': { width: 726, height: 531 },
  'ultrawide 2560x1080': { width: 1980, height: 604 },
  'focus 1440x900': { width: 1325, height: 792 },
  'focus 390x844': { width: 366, height: 726 },
} as const;
type Geometry = keyof typeof viewports;
const graphs = { topology: topologyDiagram, pipeline: pipelineDiagram } as const;
const anchors = { topology: 'gate', pipeline: 'visual' } as const;

// The lines an edge draws: its route, or its two stubs. A stub shared by
// several edges is one line.
function drawn(layout: DiagramLayout): Array<{ edge: LaidOutEdge; points: Point[]; head: boolean }> {
  const seen = new Set<Point[]>();
  return layout.edges.flatMap((edge) => {
    const lines = edge.stubs
      ? [
          { edge, points: edge.stubs.from.points, head: false },
          { edge, points: edge.stubs.to.points, head: true },
        ]
      : [{ edge, points: edge.points, head: true }];
    return lines.filter((line) => !seen.has(line.points) && seen.add(line.points));
  });
}

interface Run {
  edge: LaidOutEdge;
  horizontal: boolean;
  at: number;
  low: number;
  high: number;
}
function runs(layout: DiagramLayout): Run[] {
  return drawn(layout).flatMap(({ edge, points }) =>
    points.slice(1).flatMap((end, index) => {
      const start = points[index];
      if (Math.abs(start.x - end.x) < 1e-6 && Math.abs(start.y - end.y) < 1e-6) return [];
      const horizontal = Math.abs(start.y - end.y) < 1e-6;
      return [{ edge, horizontal, at: horizontal ? start.y : start.x, low: horizontal ? Math.min(start.x, end.x) : Math.min(start.y, end.y), high: horizontal ? Math.max(start.x, end.x) : Math.max(start.y, end.y) }];
    }),
  );
}

/** Where two lines of different edges cross: a run along one axis passing through the inside of a run along the other. */
function crossings(layout: DiagramLayout): number {
  const all = runs(layout);
  let count = 0;
  for (const a of all) {
    if (!a.horizontal) continue;
    for (const b of all) {
      if (b.horizontal || b.edge === a.edge) continue;
      if (b.at > a.low + 1e-6 && b.at < a.high - 1e-6 && a.at > b.low + 1e-6 && a.at < b.high - 1e-6) count += 1;
    }
  }
  return count;
}

// A bundle: lines along the reading axis, each within REACH of the next,
// running together for at least ALONG. Lines that all leave one node, or
// all reach one, fan out or in at ports of their own and are followed from
// that node; what cannot be told apart is a run of lines that share
// neither end, so a bundle counts its fewest distinct sources or targets.
const REACH = 16;
const ALONG = 160;
function widestBundle(layout: DiagramLayout, orientation: DiagramOrientation): number {
  const along = runs(layout).filter((run) => run.horizontal === (orientation === 'landscape') && run.high - run.low >= ALONG);
  const extent = orientation === 'landscape' ? layout.width : layout.height;
  let widest = 0;
  for (let at = 0; at + ALONG <= extent; at += 8) {
    const covering = along.filter((run) => run.low <= at + 1e-6 && run.high >= at + ALONG - 1e-6).sort((a, b) => a.at - b.at);
    let bundle: Run[] = [];
    for (const run of covering) {
      if (bundle.length && run.at - bundle[bundle.length - 1].at > REACH) bundle = [];
      bundle.push(run);
      const edges = bundle.map((member) => member.edge.edge);
      widest = Math.max(widest, Math.min(new Set(edges.map((edge) => edge.from)).size, new Set(edges.map((edge) => edge.to)).size));
    }
  }
  return widest;
}

/** The tip of every arrowhead drawn. */
const tips = (layout: DiagramLayout) => drawn(layout).filter((line) => line.head).map((line) => line.points[line.points.length - 1]);

// Measured with these functions on viewDiagram at 89caf95 (the engine
// before this change) and after it. A change that brings crossings back
// fails here; one that removes more lowers `after`.
const CROSSINGS: Record<keyof typeof graphs, Record<Geometry, { before: number; after: number }>> = {
  topology: {
    'landscape 1440x900': { before: 7, after: 1 },
    'portrait-phone 390x844': { before: 5, after: 0 },
    'portrait-tablet 820x1180': { before: 7, after: 1 },
    'ultrawide 2560x1080': { before: 7, after: 6 },
    'focus 1440x900': { before: 7, after: 6 },
    'focus 390x844': { before: 7, after: 0 },
  },
  pipeline: {
    'landscape 1440x900': { before: 49, after: 6 },
    'portrait-phone 390x844': { before: 49, after: 0 },
    'portrait-tablet 820x1180': { before: 49, after: 6 },
    'ultrawide 2560x1080': { before: 49, after: 10 },
    'focus 1440x900': { before: 49, after: 32 },
    'focus 390x844': { before: 49, after: 1 },
  },
};
const BUNDLE_CAP = 4;

describe('a dense graph read in its viewport', () => {
  for (const [name, data] of Object.entries(graphs) as Array<[keyof typeof graphs, DiagramData]>) {
    for (const [geometry, size] of Object.entries(viewports) as Array<[Geometry, { width: number; height: number }]>) {
      const view = viewDiagram(data, { ...size, scrollbar: 0 }, anchors[name]);
      const { layout } = view;

      it(`${name} / ${geometry}: crosses fewer edges than before`, () => {
        const { before, after } = CROSSINGS[name][geometry];
        expect(after).toBeLessThan(before);
        expect(crossings(layout)).toBeLessThanOrEqual(after);
      });

      it(`${name} / ${geometry}: no more than ${BUNDLE_CAP} unrelated lines run side by side`, () => {
        expect(widestBundle(layout, view.orientation)).toBeLessThanOrEqual(BUNDLE_CAP);
      });

      it(`${name} / ${geometry}: no two arrowheads closer than an arrowhead's width and a gap`, () => {
        const points = tips(layout);
        points.forEach((tip, index) => {
          for (const other of points.slice(index + 1)) expect(Math.hypot(tip.x - other.x, tip.y - other.y)).toBeGreaterThanOrEqual(ARROW_PORT_PITCH - 1e-6);
        });
      });

      it(`${name} / ${geometry}: scrolls one way at most`, () => {
        expect(view.fit.scrollX && view.fit.scrollY).toBe(false);
      });
    }
  }

  it('lays the forty-step pipeline out for each viewport within a budget', () => {
    // A fresh cache: the approved drawing and both recomposed frames, each
    // ordered from several starts and laid out again while it bundles
    // (some 10-70 ms on a laptop; the budget leaves room for a slow runner).
    for (const [geometry, size] of Object.entries(viewports)) {
      const started = performance.now();
      viewDiagram(pipelineDiagram, { ...size, scrollbar: 0 }, 'visual', new Map());
      expect(performance.now() - started, geometry).toBeLessThan(250);
    }
    // A resize within a frame step lays nothing out again.
    const layouts = new Map();
    viewDiagram(pipelineDiagram, { ...viewports['landscape 1440x900'], scrollbar: 0 }, 'visual', layouts);
    const started = performance.now();
    viewDiagram(pipelineDiagram, { width: 913, height: 526, scrollbar: 0 }, 'visual', layouts);
    expect(performance.now() - started).toBeLessThan(5);
  });

  it('lays a graph out the same way every time', () => {
    for (const [geometry, size] of Object.entries(viewports)) {
      const first = viewDiagram(pipelineDiagram, { ...size, scrollbar: 0 }, 'visual', new Map());
      const again = viewDiagram(pipelineDiagram, { ...size, scrollbar: 0 }, 'visual', new Map());
      expect(JSON.stringify(again.layout), geometry).toBe(JSON.stringify(first.layout));
    }
  });
});

describe('an edge too long to follow', () => {
  const nodeLabel = (data: DiagramData, id: string) => data.nodes.find((node) => node.id === id)!.label;
  const names = (lines: string[], quiet: boolean[]) => lines.filter((_, index) => !quiet[index]).join(' ');
  const mainOf = (orientation: DiagramOrientation, point: Point) => (orientation === 'landscape' ? point.x : point.y);

  for (const [name, data] of Object.entries(graphs) as Array<[keyof typeof graphs, DiagramData]>) {
    for (const orientation of ['landscape', 'portrait'] as DiagramOrientation[]) {
      for (const [geometry, size] of Object.entries(viewports)) {
        const frame = frameFor(orientation, { ...size, scrollbar: 0 });
        const layout = layoutDiagram(data, orientation, undefined, frame);
        const layerOf = (id: string) => layout.nodes.find((node) => node.node.id === id)!.layer;

        it(`${name} / ${orientation} / ${geometry}: a stub pair names each far end`, () => {
          for (const edge of layout.edges) {
            if (!edge.stubs) continue;
            // `-> target` by the source, `source ->` by the target, the
            // edge's own label under the name, quieter.
            expect(names(edge.stubs.from.label.lines, edge.stubs.from.quiet)).toContain(`-> ${nodeLabel(data, edge.edge.to)}`);
            expect(names(edge.stubs.to.label.lines, edge.stubs.to.quiet)).toContain(`${nodeLabel(data, edge.edge.from)} ->`);
            if (edge.edge.label) expect(edge.stubs.from.label.lines.filter((_, index) => edge.stubs!.from.quiet[index]).join(' ')).toContain(edge.edge.label);
          }
        });

        it(`${name} / ${orientation} / ${geometry}: an edge drawn whole across layers is no longer than the frame`, () => {
          const drawingLength = orientation === 'landscape' ? layout.width : layout.height;
          for (const edge of layout.edges) {
            if (edge.stubs || Math.abs(layerOf(edge.edge.to) - layerOf(edge.edge.from)) < 2) continue;
            const along = edge.points.map((point) => mainOf(orientation, point));
            // A drawing at most two frames long keeps every edge whole.
            if (drawingLength <= 2 * frame.main) continue;
            expect(Math.max(...along) - Math.min(...along), `${edge.edge.from}->${edge.edge.to}`).toBeLessThanOrEqual(frame.main);
          }
        });
      }
    }

    it(`${name}: the approved canvas draws every edge whole`, () => {
      for (const orientation of ['landscape', 'portrait'] as DiagramOrientation[]) {
        expect(layoutDiagram(data, orientation).edges.filter((edge) => edge.stubs)).toHaveLength(0);
      }
    });
  }

  it('the stubs leaving one side of a node share one line and one list of names', () => {
    const layout = layoutDiagram(pipelineDiagram, 'landscape', undefined, frameFor('landscape', { ...viewports['landscape 1440x900'], scrollbar: 0 }));
    const toSummary = layout.edges.filter((edge) => edge.edge.to === 'summary' && edge.stubs);
    expect(toSummary.length).toBeGreaterThanOrEqual(2);
    expect(new Set(toSummary.map((edge) => edge.stubs!.to)).size).toBe(1);
    const shared = toSummary[0].stubs!.to;
    for (const edge of toSummary) expect(names(shared.label.lines, shared.quiet)).toContain(`${nodeLabel(pipelineDiagram, edge.edge.from)} ->`);
  });

  it('keeps a small drawing whole: the plan on a phone draws no stubs', () => {
    const plan = { mode: 'graph', ...(fixtures.plan.find((action) => action.op === 'show' && action.type === 'diagram') as { data: Omit<DiagramData, 'mode'> }).data } as DiagramData;
    const { layout } = viewDiagram(plan, { ...viewports['portrait-phone 390x844'], scrollbar: 0 });
    expect(layout.edges.filter((edge) => edge.stubs)).toHaveLength(0);
  });
});

describe('a dense graph on a phone', () => {
  it('reads the pipeline top down, one way, several whole nodes to a screen', () => {
    const size = viewports['portrait-phone 390x844'];
    const view = viewDiagram(pipelineDiagram, { ...size, scrollbar: 0 }, 'visual');
    expect(view.orientation).toBe('portrait');
    expect([view.fit.scrollX, view.fit.scrollY]).toEqual([false, true]);
    expect(view.fit.scale).toBeGreaterThanOrEqual(GRAPH_MIN_SCALE - 1e-9);
    // Laid out to the width: every node is whole across the viewport.
    for (const node of view.layout.nodes) expect(node.box.x + node.box.width).toBeLessThanOrEqual(size.width / view.fit.scale + 1e-6);
    // Screen by screen, down the drawing: on average at least two whole
    // nodes a screen, and no screen without one.
    const screen = size.height / view.fit.scale;
    let shown = 0;
    let screens = 0;
    for (let top = 0; top + screen <= view.layout.height; top += screen / 2) {
      const whole = view.layout.nodes.filter((node) => node.box.y >= top && node.box.y + node.box.height <= top + screen).length;
      expect(whole, `screen at ${Math.round(top)}`).toBeGreaterThanOrEqual(1);
      shown += whole;
      screens += 1;
    }
    expect(shown / screens).toBeGreaterThanOrEqual(2);
  });
});

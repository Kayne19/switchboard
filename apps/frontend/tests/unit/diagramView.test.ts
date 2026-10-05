import { describe, expect, it } from 'vitest';
import type { DiagramData } from '../../src/controller/types';
import { fixtures, pipelineDiagram, topologyDiagram } from '../../src/fixtures/scenes';
import { GRAPH_MIN_SCALE, layoutDiagram, viewDiagram } from '../../src/primitives/diagramLayout';
import { SLIVER } from '../../src/primitives/drawingFit';
import { leastCpuMs } from './cpuTime';

const architecture = { mode: 'graph', ...(fixtures.architecture[0] as { data: Omit<DiagramData, 'mode'> }).data } as DiagramData;

// The diagram slot's drawing viewport at each canonical geometry
// (playwright.config.ts, tests/visual), and the focus layer's, in CSS
// pixels, measured in the browser.
const viewports = {
  'landscape 1440x900': { width: 914, height: 526 },
  'portrait-phone 390x844': { width: 330, height: 374 },
  'portrait-tablet 820x1180': { width: 726, height: 531 },
  'ultrawide 2560x1080': { width: 1980, height: 604 },
  'focus 1440x900': { width: 1325, height: 792 },
  'focus 390x844': { width: 366, height: 726 },
};
const scrollbars = [0, 11];

describe('a graph read in its viewport', () => {
  for (const [name, data] of [['architecture', architecture], ['topology', topologyDiagram], ['pipeline', pipelineDiagram]] as const) {
    for (const [geometry, size] of Object.entries(viewports)) {
      for (const scrollbar of scrollbars) {
        it(`${name} / ${geometry} / ${scrollbar}px bars: never drawn below the readable minimum`, () => {
          const view = viewDiagram(data, { ...size, scrollbar });
          expect(view.fit.scale).toBeGreaterThanOrEqual(GRAPH_MIN_SCALE * (1 - SLIVER) - 1e-9);
          // Scrolling, it is at the minimum or above.
          if (view.fit.scrollX || view.fit.scrollY) expect(view.fit.scale).toBeGreaterThanOrEqual(GRAPH_MIN_SCALE - 1e-9);
          expect(view.fit.width).toBeCloseTo(view.layout.width * view.fit.scale);
          // It scrolls only where it overflows.
          if (!view.fit.scrollX) expect(view.fit.width).toBeLessThanOrEqual(size.width + 0.5);
          if (!view.fit.scrollY) expect(view.fit.height).toBeLessThanOrEqual(size.height + 0.5);
        });
      }
    }
  }

  it('pins the approved canvas: the architecture drawing, box for box', () => {
    // Laying a graph out for a frame must not move the approved drawing; a
    // change here is a change to the canonical scene (and its golden).
    const boxes = (orientation: 'landscape' | 'portrait') => {
      const layout = layoutDiagram(architecture, orientation, 'session');
      return { size: [layout.width, layout.height].map(Math.round), boxes: Object.fromEntries(layout.nodes.map((node) => [node.node.id, [node.box.x, node.box.y, node.box.width, node.box.height].map(Math.round)])) };
    };
    expect(boxes('landscape')).toEqual({
      size: [1000, 620],
      boxes: { damocles: [28, 266, 169, 88], session: [292, 257, 158, 107], planner: [548, 190, 150, 70], implementer: [545, 360, 155, 70], pool: [795, 269, 177, 83] },
    });
    expect(boxes('portrait')).toEqual({
      size: [700, 1000],
      boxes: { damocles: [264, 28, 169, 88], session: [270, 315, 158, 107], planner: [148, 620, 150, 70], implementer: [398, 620, 155, 70], pool: [260, 889, 177, 83] },
    });
    // A one-layer graph starts at the canvas's start, as it always has.
    expect(layoutDiagram({ mode: 'graph', nodes: [{ id: 'a', label: 'A' }], edges: [] }, 'landscape').nodes[0].box.x).toBe(28);
  });

  it('keeps a drawing that reads whole as the approved canvas draws it', () => {
    for (const size of [viewports['landscape 1440x900'], viewports['ultrawide 2560x1080'], viewports['focus 1440x900']]) {
      const view = viewDiagram(architecture, { ...size, scrollbar: 0 }, 'session');
      expect([view.fit.scrollX, view.fit.scrollY]).toEqual([false, false]);
      expect(view.orientation).toBe('landscape');
      expect(view.layout).toEqual(layoutDiagram(architecture, 'landscape', 'session'));
    }
  });

  it('recomposes the system topology for every viewport so that it scrolls one way', () => {
    for (const [geometry, size] of Object.entries(viewports)) {
      for (const scrollbar of scrollbars) {
        const { fit } = viewDiagram(topologyDiagram, { ...size, scrollbar }, 'gate');
        expect(fit.scrollX && fit.scrollY, `${geometry} / ${scrollbar}px`).toBe(false);
      }
    }
  });

  it('reads a phone-width topology top down, its wide layers wrapped to the width', () => {
    const view = viewDiagram(topologyDiagram, { ...viewports['portrait-phone 390x844'], scrollbar: 0 });
    expect(view.orientation).toBe('portrait');
    expect([view.fit.scrollX, view.fit.scrollY]).toEqual([false, true]);
    // On the approved canvas its widest layer holds five boxes side by side.
    const approved = layoutDiagram(topologyDiagram, 'portrait');
    const widest = (layout: typeof approved) => Math.max(...[...new Set(layout.nodes.map((node) => node.layer))].map((layer) => layout.nodes.filter((node) => node.layer === layer).length));
    expect(widest(approved)).toBeGreaterThanOrEqual(5);
    expect(widest(view.layout)).toBeLessThanOrEqual(2);
  });

  it('scrolls the wide pipeline along its length on a landscape stage', () => {
    for (const geometry of ['landscape 1440x900', 'ultrawide 2560x1080', 'focus 1440x900'] as const) {
      const { fit } = viewDiagram(pipelineDiagram, { ...viewports[geometry], scrollbar: 11 });
      expect([fit.scrollX, fit.scrollY], geometry).toEqual([true, false]);
    }
  });

  it('lays a graph out once per step of a resize, not once per pixel', () => {
    const layouts = new Map();
    const first = viewDiagram(topologyDiagram, { width: 914, height: 526, scrollbar: 0 }, 'gate', layouts);
    const made = layouts.size;
    // One pixel narrower, the same step: nothing is laid out again.
    const next = viewDiagram(topologyDiagram, { width: 913, height: 526, scrollbar: 0 }, 'gate', layouts);
    expect(layouts.size).toBe(made);
    expect(next.layout).toBe(first.layout);
    // A step down, a new frame.
    viewDiagram(topologyDiagram, { width: 890, height: 526, scrollbar: 0 }, 'gate', layouts);
    expect(layouts.size).toBeGreaterThan(made);
  });

  it('chooses within a frame budget', () => {
    // Each viewport laid out afresh: some 7-20 ms of CPU time on average, up
    // to 35 ms at load 50. The budget is CPU time, the least of three runs
    // (cpuTime.ts says why).
    for (const [name, data] of [['topology', topologyDiagram], ['pipeline', pipelineDiagram]] as const) {
      const spent = leastCpuMs(() => {
        for (const size of Object.values(viewports)) viewDiagram(data, { ...size, scrollbar: 0 });
      });
      expect(spent / Object.keys(viewports).length, name).toBeLessThan(120);
    }
  });
});

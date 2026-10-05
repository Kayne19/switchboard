import { describe, expect, it } from 'vitest';
import type { DiagramData } from '../../src/controller/types';
import { fixtures, pipelineDiagram, topologyDiagram } from '../../src/fixtures/scenes';
import { GRAPH_MIN_SCALE, layoutDiagram, viewDiagram } from '../../src/primitives/diagramLayout';

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
          expect(view.fit.scale).toBeGreaterThanOrEqual(GRAPH_MIN_SCALE - 1e-9);
          expect(view.fit.width).toBeCloseTo(view.layout.width * view.fit.scale);
          // It scrolls only where it overflows.
          if (!view.fit.scrollX) expect(view.fit.width).toBeLessThanOrEqual(size.width + 0.5);
          if (!view.fit.scrollY) expect(view.fit.height).toBeLessThanOrEqual(size.height + 0.5);
        });
      }
    }
  }

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

  it('chooses within a frame budget', () => {
    for (const data of [topologyDiagram, pipelineDiagram]) {
      for (const size of Object.values(viewports)) viewDiagram(data, { ...size, scrollbar: 0 });
      const started = performance.now();
      for (const size of Object.values(viewports)) viewDiagram(data, { ...size, scrollbar: 0 });
      expect((performance.now() - started) / Object.keys(viewports).length).toBeLessThan(120);
    }
  });
});

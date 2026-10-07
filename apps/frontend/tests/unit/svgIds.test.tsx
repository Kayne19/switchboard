// @vitest-environment jsdom
// One id scheme for every SVG (pr/issues.md, "Diagram and sequence SVG ids
// are global to the document"; review-drawing L6). Arrow markers and glow
// filters had fixed ids (`diagram-arrow-paper`, `active-edge-glow`,
// `sequence-active-glow`), so two drawings on one page -- an aux diagram,
// the focus copy -- repeated them, and `url(#id)` resolved to the first
// copy. A chart's leader gradients were named for their notes with
// `[^\w-]` cut to `_`, so `obs.1` and `obs_1` shared one id and the second
// leader was painted with the first one's coordinates.
import { describe, expect, it } from 'vitest';
import { ChartNotes, type ChartNote } from '../../src/components/ChartNotes';
import type { ChartData, DiagramData, SceneObject, SequenceDiagramData } from '../../src/controller/types';
import { svgIdPart } from '../../src/hooks/useSvgIds';
import { ChartPrimitive } from '../../src/primitives/ChartPrimitive';
import { DamoclesGlyph } from '../../src/primitives/DamoclesGlyph';
import { DiagramPrimitive } from '../../src/primitives/DiagramPrimitive';
import { SequencePrimitive } from '../../src/primitives/SequencePrimitive';
import { TechFrame } from '../../src/primitives/TechFrame';
import { mount, referenced, stubResizeObserver } from './sceneHarness';

stubResizeObserver();

const graph: DiagramData = {
  mode: 'graph',
  nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', state: 'active' }],
  edges: [{ from: 'a', to: 'b', active: true, semantic: 'red' }],
};
const sequence: SequenceDiagramData = {
  mode: 'sequence',
  actors: [{ id: 'caller', label: 'CALLER' }, { id: 'pbx', label: 'PBX' }],
  messages: [{ from: 'caller', to: 'pbx', label: 'route', active: true }],
};
const lineData: ChartData = { xMax: 4, series: [{ name: 'VAL', values: [1, 2, 3, 2, 1] }] };
const chart = { id: 'loss', type: 'chart', data: lineData } as SceneObject<ChartData>;
const note = (key: string, x: number): ChartNote => ({ key, data: { tag: key, anchor: { target: 'loss', x }, segments: [{ text: key }] } });

// Every `url(#...)` reference on the page, with the element that carries it.
function references(root: ParentNode): Array<{ element: Element; value: string }> {
  return [...root.querySelectorAll('*')].flatMap((element) =>
    ['filter', 'marker-end', 'clip-path', 'fill', 'stroke', 'style']
      .map((name) => element.getAttribute(name) ?? '')
      .flatMap((value) => [...value.matchAll(/url\(#[^)]+\)/g)].map((match) => ({ element, value: match[0] }))),
  );
}

describe('SVG ids', () => {
  it('are unique on a page that draws each drawing twice, and each reference resolves inside its own drawing', () => {
    const host = mount(
      <>
        {[0, 1].map((copy) => (
          <div key={copy} className="copy">
            <DiagramPrimitive data={graph} id="g" />
            <SequencePrimitive data={sequence} id="s" />
            <DamoclesGlyph glint />
            <TechFrame variant="answer" />
            <div className="chart-object">
              <ChartPrimitive data={lineData} named={[{ x: 1 }]} led={[{ x: 1 }]} />
              <ChartNotes chart={chart} objects={{ loss: chart }} notes={[note('obs.1', 1)]} onFocus={() => {}} />
            </div>
          </div>
        ))}
      </>,
    );
    const ids = [...host.querySelectorAll('[id]')].map((element) => element.id);
    expect(ids.length).toBeGreaterThan(10);
    expect(new Set(ids).size).toBe(ids.length);
    const refs = references(host);
    expect(refs.length).toBeGreaterThan(5);
    for (const { element, value } of refs) {
      const copy = element.closest('.copy')!;
      expect(referenced(copy, value), `${value} on ${element.tagName}`).not.toBeNull();
    }
  });

  it('keep two notes whose keys differ only outside letters and digits apart', () => {
    // The layer draws a leader only where it has placed the card; in jsdom
    // nothing is laid out, so the ids are checked where they are made.
    expect(svgIdPart('obs.1')).not.toBe(svgIdPart('obs_1'));
    expect(svgIdPart('a-b')).toBe('a-b');
    const parts = ['obs.1', 'obs_1', 'obs 1', 'obs_2e_1', 'ö', '🚀'];
    expect(new Set(parts.map(svgIdPart)).size).toBe(parts.length);
    for (const part of parts) expect(svgIdPart(part)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

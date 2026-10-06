// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DiagramData } from '../../src/controller/types';
import { DiagramPrimitive } from '../../src/primitives/DiagramPrimitive';
import { pipelineDiagram, topologyDiagram } from '../../src/fixtures/scenes';
import { GRAPH_MIN_SCALE } from '../../src/primitives/diagramLayout';
import { mount, rerender, stubResizeObserver } from './sceneHarness';

const data: DiagramData = {
  mode: 'graph',
  nodes: [
    { id: 'input', label: 'INPUT' },
    { id: 'route', label: 'ROUTE' },
    { id: 'output', label: 'OUTPUT' },
  ],
  edges: [
    { from: 'input', to: 'route', label: 'call' },
    { from: 'route', to: 'output', active: true },
  ],
};

let host: HTMLDivElement;

stubResizeObserver();

function render() {
  host = mount(<DiagramPrimitive data={data} id="test-diagram" />);
}

describe('diagram rendering', () => {
  it('positions every node by its SVG transform, with no inline transform overriding it', () => {
    render();
    const nodes = [...host.querySelectorAll<SVGGElement>('.diagram-nodes > g')];
    expect(nodes).toHaveLength(3);
    const positions = nodes.map((node) => node.getAttribute('transform'));
    expect(new Set(positions).size).toBe(3);
    for (const node of nodes) {
      // A CSS transform on an SVG element replaces its transform attribute, which
      // is how every node once collapsed onto the same corner.
      expect(node.style.transform).toBe('');
      expect(node.style.opacity).toBe('');
    }
  });

  it('draws edges with their own dash pattern rather than a normalized path length', () => {
    render();
    const edges = [...host.querySelectorAll<SVGPathElement>('.diagram-edges path')];
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.hasAttribute('pathLength')).toBe(false);
      expect(edge.style.strokeDasharray).toBe('');
      expect(edge.style.opacity).toBe('');
    }
    expect(edges[1].getAttribute('stroke-dasharray')).toBe('10 8');
    expect(edges[0].hasAttribute('stroke-dasharray')).toBe(false);
  });

  it('paints edge labels after nodes, each on its own backing', () => {
    render();
    const groups = [...host.querySelectorAll('svg > g')].map((group) => group.getAttribute('class'));
    expect(groups).toEqual(['diagram-edges', 'diagram-nodes', 'diagram-edge-labels']);
    const labels = [...host.querySelectorAll('.diagram-edge-labels > g')];
    expect(labels).toHaveLength(1);
    expect(labels[0].firstElementChild?.getAttribute('class')).toBe('diagram-edge-label__backing');
    expect(labels[0].lastElementChild?.textContent).toBe('call');
  });

  it('sizes the active-edge glow to the drawing so straight edges keep their stroke', () => {
    render();
    // A bounding-box filter region has zero height on a horizontal edge.
    const glow = host.querySelector('#active-edge-glow');
    expect(glow?.getAttribute('filterUnits')).toBe('userSpaceOnUse');
  });

  it('ends every edge in an arrowhead of its own colour, not a dot', () => {
    render();
    const edges = [...host.querySelectorAll<SVGPathElement>('.diagram-edges path')];
    for (const edge of edges) expect(edge.getAttribute('marker-end')).toBe('url(#diagram-arrow-paper)');
    expect(host.querySelector('.diagram-edges circle')).toBeNull();
    const markers = [...host.querySelectorAll('defs marker')].map((marker) => marker.id);
    expect(markers).toContain('diagram-arrow-paper');
    expect(markers).toContain('diagram-arrow-red');
    // The arrowhead scales with the drawing, as the frames do.
    expect(host.querySelector('#diagram-arrow-paper')?.getAttribute('markerUnits')).toBe('userSpaceOnUse');
  });

  it('sizes each node box to its text and wraps a long label', () => {
    const sized: DiagramData = {
      mode: 'graph',
      nodes: [
        { id: 'short', label: 'PBX' },
        { id: 'long', label: 'Speech-to-text sidecar for the call', sub: 'whisper', detail: 'apps/backend/src/stt.rs' },
      ],
      edges: [{ from: 'short', to: 'long' }],
    };
    host = mount(<DiagramPrimitive data={sized} id="test-diagram" />);
    const [short, long] = [...host.querySelectorAll<SVGGElement>('.diagram-nodes > g')];
    const widthOf = (node: SVGGElement) => Number(node.querySelector('.diagram-node__frame')?.getAttribute('d')?.match(/H ([\d.]+) L/)?.[1]);
    expect(widthOf(long)).toBeGreaterThan(widthOf(short));
    expect(long.querySelectorAll('.diagram-node-label')).toHaveLength(2);
    expect(long.querySelector('.diagram-node-sub')?.textContent).toBe('whisper');
    expect(long.querySelector('.diagram-node-detail')?.textContent).toBe('apps/backend/src/stt.rs');
    expect(short.querySelector('.diagram-node-sub')).toBeNull();
  });
});

describe('diagram node state', () => {
  const stateful: DiagramData = {
    mode: 'graph',
    nodes: [
      { id: 'done', label: 'FETCH', state: 'done' },
      { id: 'active', label: 'BUILD', state: 'active' },
      { id: 'todo', label: 'SHIP', state: 'todo' },
      { id: 'blocked', label: 'AUDIT', state: 'blocked' },
    ],
    edges: [
      { from: 'done', to: 'active' },
      { from: 'active', to: 'todo' },
      { from: 'active', to: 'blocked' },
    ],
  };
  // Nodes render in data order.
  const nodeOf = (id: string) => [...host.querySelectorAll<SVGGElement>('.diagram-nodes > g')][stateful.nodes.findIndex((node) => node.id === id)];

  it('shows each state on its node: done dimmed with a check, active lit, blocked framed red with a cross', () => {
    host = mount(<DiagramPrimitive data={stateful} id="test-diagram" />);
    const done = nodeOf('done');
    expect(done.querySelector('.diagram-node__body--done')).not.toBeNull();
    expect(done.querySelector('.diagram-node__tag--done polyline')).not.toBeNull();

    const active = nodeOf('active');
    expect(active.querySelector('.diagram-node__body--active')).not.toBeNull();
    expect(active.querySelector('.diagram-node__frame')?.getAttribute('filter')).toBe('url(#diagram-node-glow)');
    expect(active.querySelector('.diagram-node__tag')).toBeNull();

    const blocked = nodeOf('blocked');
    expect(blocked.querySelector('.diagram-node__body--blocked')).not.toBeNull();
    expect(blocked.querySelector('.diagram-node__frame')?.getAttribute('stroke')).toBe('var(--red)');
    expect(blocked.querySelector('.diagram-node__tag--blocked path')).not.toBeNull();

    const todo = nodeOf('todo');
    expect(todo.querySelector('.diagram-node__body--todo')).not.toBeNull();
    expect(todo.querySelector('.diagram-node__frame')?.getAttribute('filter')).toBeNull();
    expect(todo.querySelector('.diagram-node__tag')).toBeNull();
  });

  it('keeps a blocked node framed in red when a note anchors it', () => {
    host = mount(
      <DiagramPrimitive
        data={stateful}
        id="test-diagram"
        note={{ segments: [{ text: 'x' }], anchor: { target: 'test-diagram', node: 'blocked' } }}
      />,
    );
    const blocked = nodeOf('blocked');
    expect(blocked.querySelector('.diagram-node__body--anchored')).not.toBeNull();
    // The frame, its rule and its tag agree.
    expect(blocked.querySelector('.diagram-node__frame')?.getAttribute('stroke')).toBe('var(--red)');
    expect(blocked.querySelector('.diagram-node__body > line')?.getAttribute('stroke')).toBe('var(--red)');
    expect(blocked.querySelector('.diagram-node__tag--blocked rect')?.getAttribute('stroke')).toBe('var(--red)');
    expect(blocked.querySelector('.diagram-node-label')?.getAttribute('fill')).toBe('var(--orange)');
  });

  it('leaves room for both corner tags beside the label of an anchored done node', () => {
    const label = 'COMPILE ASSETS';
    const long = 'A note far too long to fit the callout box, so it stays in the rail and the node carries the badge beside its check.';
    host = mount(
      <DiagramPrimitive
        data={{ mode: 'graph', nodes: [{ id: 'build', label, state: 'done' }], edges: [] }}
        id="test-diagram"
        note={{ segments: [{ text: long }], anchor: { target: 'test-diagram', node: 'build' } }}
      />,
    );
    expect(host.querySelector('.diagram-node__marker')).not.toBeNull();
    const tag = host.querySelector('.diagram-node__tag--done');
    const tagX = parseFloat(/translate\(([-\d.]+)/.exec(tag?.getAttribute('transform') ?? '')?.[1] ?? 'NaN');
    // The label starts 18 units in, each character 10.8 units wide
    // (.diagram-node-label: 15px monospace, 0.6em advance plus 0.1em tracking).
    expect(tagX).toBeGreaterThanOrEqual(18 + label.length * 10.8);
  });

  it('leaves a node frame\'s stroke to the renderer: no stylesheet rule outranks it', () => {
    // A CSS stroke beats an SVG stroke attribute, so a rule on the frame
    // would be a second owner of its colour; one such rule once painted an
    // anchored blocked frame red while the renderer drew it orange.
    const css = readFileSync(`${import.meta.dirname}/../../src/styles/index.css`, 'utf8');
    const rules = [...css.matchAll(/([^{}]*\.diagram-node__frame[^{}]*)\{([^}]*)\}/g)];
    for (const [, selector, body] of rules) expect(/(^|[\s;])stroke(-width|-opacity)?\s*:/.test(body), selector.trim()).toBe(false);
  });

  it('gives a lit node its glow on every side of the frame', () => {
    host = mount(
      <DiagramPrimitive
        data={stateful}
        id="test-diagram"
        note={{ segments: [{ text: 'x' }], anchor: { target: 'test-diagram', node: 'todo' } }}
      />,
    );
    // An active node and an anchored one are both lit.
    const lit = [nodeOf('active'), nodeOf('todo')].map((node) => node.querySelector('.diagram-node__frame'));
    for (const frame of lit) {
      const filterId = /^url\(#(.+)\)$/.exec(frame?.getAttribute('filter') ?? '')?.[1];
      const filter = host.querySelector(`filter[id="${filterId}"]`);
      expect(filter).not.toBeNull();
      // The frame is drawn inside its node's translated group. A region in
      // user space from (0, 0) would begin at the frame's own corner and cut
      // the glow, and half the stroke, off its top and left edges; the
      // region has to be the frame's box with room around it.
      expect(filter?.getAttribute('filterUnits') ?? 'objectBoundingBox').toBe('objectBoundingBox');
      expect(parseFloat(filter?.getAttribute('x') ?? '0')).toBeLessThan(0);
      expect(parseFloat(filter?.getAttribute('y') ?? '0')).toBeLessThan(0);
      expect(parseFloat(filter?.getAttribute('width') ?? '100')).toBeGreaterThan(100);
      expect(parseFloat(filter?.getAttribute('height') ?? '100')).toBeGreaterThan(100);
    }
  });
});


describe('anchored diagram note', () => {
  it('highlights the node and renders a callout with leader line', () => {
    host = mount(
      <DiagramPrimitive
        data={data}
        id="test-diagram"
        note={{
          tag: 'OBSERVATION',
          anchor: { target: 'test-diagram', node: 'route' },
          segments: [{ text: 'Route description.' }],
        }}
      />,
    );

    const callout = host.querySelector('.diagram-callout');
    expect(callout).not.toBeNull();
    const leader = host.querySelector('.diagram-callout__leader');
    expect(leader).not.toBeNull();
    const anchoredNode = host.querySelector('.diagram-node__body--anchored');
    expect(anchoredNode).not.toBeNull();
    expect(anchoredNode?.querySelector('.diagram-node-label')?.textContent).toBe('ROUTE');
  });

  it('preserves default rendering when the anchored node is unknown', () => {
    host = mount(
      <DiagramPrimitive
        data={data}
        id="test-diagram"
        note={{
          tag: 'OBSERVATION',
          anchor: { target: 'test-diagram', node: 'nonexistent' },
          segments: [{ text: 'Route description.' }],
        }}
      />,
    );

    expect(host.querySelector('.diagram-callout')).toBeNull();
    expect(host.querySelector('.diagram-node__body--anchored')).toBeNull();
  });
});


describe('anchored note fit and ownership', () => {
  function renderAnchored(note: { tag?: string; anchor?: { target: string; node?: string; x?: number; series?: string }; segments: Array<{ text: string }> }) {
    host = mount(<DiagramPrimitive data={data} id="test-diagram" note={note} />);
  }

  it('falls back to the rail badge without truncating when the note does not fit the callout', () => {
    renderAnchored({
      tag: 'OBSERVATION',
      anchor: { target: 'test-diagram', node: 'route' },
      segments: [
        {
          text: 'The voice does not change. Context moves. Damocles routes the session into the project directory, then the project orchestrator delegates work without exposing those internal handoffs to you.',
        },
      ],
    });

    // Six wrapped lines will not fit the three-line callout box, so the
    // note is not truncated: it stays in the rail and the node carries the
    // matching badge instead.
    expect(host.querySelector('.diagram-callout')).toBeNull();
    expect(host.querySelector('.diagram-node__body--anchored')).not.toBeNull();
    expect(host.querySelector('.diagram-node__marker')).not.toBeNull();
  });

  it('renders the full text in the callout when it fits', () => {
    renderAnchored({
      tag: 'OBSERVATION',
      anchor: { target: 'test-diagram', node: 'route' },
      segments: [{ text: 'Context moves. Damocles routes the session into the project directory.' }],
    });

    const callout = host.querySelector('.diagram-callout');
    expect(callout).not.toBeNull();
    // A wrapped line is one tspan; assert on a phrase that stays within a
    // single wrapped line so line boundaries cannot break the match.
    expect(callout?.textContent).toContain('Damocles routes');
    expect(callout?.textContent).toContain('directory');
  });

  it('keeps a note in the rail when its tag is too wide for the callout box', () => {
    renderAnchored({
      tag: 'CURRENT EXPLANATION / ROUTING / PROJECT SESSION / HEADLESS PI',
      anchor: { target: 'test-diagram', node: 'route' },
      segments: [{ text: 'Context moves here.' }],
    });

    // The tag is one unwrapped line: drawn in the 240-unit box it would run
    // across the diagram, so the note falls back to the rail instead.
    expect(host.querySelector('.diagram-callout')).toBeNull();
    expect(host.querySelector('.diagram-node__marker')).not.toBeNull();
  });

  it('keeps a note in the rail when one word is wider than a callout line', () => {
    renderAnchored({
      tag: 'OBSERVATION',
      anchor: { target: 'test-diagram', node: 'route' },
      segments: [{ text: 'Config lives at /etc/switchboard/projects/registry.d/override.json now.' }],
    });

    expect(host.querySelector('.diagram-callout')).toBeNull();
    expect(host.querySelector('.diagram-node__marker')).not.toBeNull();
  });

  it('hands a placed callout back to the rail when the diagram unmounts', () => {
    const placed: boolean[] = [];
    host = mount(
      <DiagramPrimitive
        data={data}
        id="test-diagram"
        note={{ tag: 'OBSERVATION', anchor: { target: 'test-diagram', node: 'route' }, segments: [{ text: 'Context moves here.' }] }}
        onCalloutChange={(value) => placed.push(value)}
      />,
    );
    expect(host.querySelector('.diagram-callout')).not.toBeNull();
    expect(placed.at(-1)).toBe(true);

    // A surface boundary replacing a diagram that threw unmounts it the same
    // way; the scene must not keep hiding the note from the rail.
    rerender(host, <div />);
    expect(placed.at(-1)).toBe(false);
  });

  it('does not capture a note whose target is another object', () => {
    renderAnchored({
      tag: 'OBSERVATION',
      anchor: { target: 'other-object', node: 'route' },
      segments: [{ text: 'Route description.' }],
    });

    expect(host.querySelector('.diagram-callout')).toBeNull();
    expect(host.querySelector('.diagram-node__body--anchored')).toBeNull();
    expect(host.querySelector('.diagram-node__marker')).toBeNull();
  });
});


describe('corner tags inside the node frame', () => {
  // The frame's outline is a box with its top-left and top-right corners cut
  // (DiagramPrimitive's frame path). A tag in the top-right corner that
  // reaches past the start of that cut sits on the frame's line, half
  // outside the node: the NOTE marker did, on every node.
  const labels = [
    'PBX',
    'Operator agent',
    'switchboard skill module',
    'Speech-to-text transcription sidecar for the operator leg',
    'supercalifragilisticexpialidocious',
  ];
  const states = [undefined, 'done', 'blocked', 'active'] as const;
  const long = 'A note far too long for the callout box, so it stays in the rail and the node it names carries the NOTE marker in its corner.';
  type Rect = { x: number; y: number; width: number; height: number };
  const translate = (element: Element | null) => {
    const match = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)\s*\)/.exec(element?.getAttribute('transform') ?? '');
    return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
  };
  const rectOf = (group: Element | null): Rect | null => {
    const at = translate(group);
    const rect = group?.querySelector('rect');
    return at && rect ? { ...at, width: Number(rect.getAttribute('width')), height: Number(rect.getAttribute('height')) } : null;
  };
  const apart = (a: Rect, b: Rect, by: number) =>
    a.x + a.width + by <= b.x || b.x + b.width + by <= a.x || a.y + a.height + by <= b.y || b.y + b.height + by <= a.y;

  for (const label of labels) {
    for (const state of states) {
      it(`${label} / ${state ?? 'todo'}: the NOTE marker and the state tag sit inside the frame, clear of the cut and the label`, () => {
        const node = { id: 'n', label, sub: 'prime-agent session in ~/projects/llm-wiki', detail: 'apps/backend/src/pbx.rs', ...(state ? { state } : {}) };
        host = mount(
          <DiagramPrimitive
            data={{ mode: 'graph', nodes: [{ id: 'a', label: 'A' }, node], edges: [{ from: 'a', to: 'n' }] }}
            id="test-diagram"
            note={{ segments: [{ text: long }], anchor: { target: 'test-diagram', node: 'n' } }}
          />,
        );
        const group = [...host.querySelectorAll('.diagram-nodes > g')][1];
        const d = group.querySelector('.diagram-node__frame')?.getAttribute('d') ?? '';
        const [, width, height] = /H [\d.]+ L ([\d.]+) [\d.]+ V ([\d.]+)/.exec(d)?.map(Number) ?? [];
        expect(width).toBeGreaterThan(0);
        const cutStart = width - 22;
        const tags = [rectOf(group.querySelector('.diagram-node__marker')), rectOf(group.querySelector('.diagram-node__tag'))].filter(
          (tag): tag is Rect => tag !== null,
        );
        expect(tags.length).toBe(state === 'done' || state === 'blocked' ? 2 : 1);
        const textBoxes: Rect[] = [...group.querySelectorAll('.diagram-node-label')].map((text) => ({
          x: Number(text.getAttribute('x')),
          y: Number(text.getAttribute('y')) - 12,
          width: (text.textContent ?? '').length * 10.8,
          height: 15,
        }));
        for (const tag of tags) {
          expect(tag.x, 'left edge').toBeGreaterThanOrEqual(4);
          expect(tag.y, 'top edge').toBeGreaterThanOrEqual(4);
          expect(tag.x + tag.width, 'right edge').toBeLessThanOrEqual(width - 4);
          expect(tag.y + tag.height, 'bottom edge').toBeLessThanOrEqual(height - 4);
          // The cut runs from (width - 22, 0) to (width, 22): the tag's
          // top-right corner keeps clear of it.
          const clearOfCut = (tag.y - (tag.x + tag.width - cutStart)) / Math.SQRT2;
          expect(clearOfCut, 'clear of the clipped corner').toBeGreaterThanOrEqual(4);
          for (const text of textBoxes) expect(apart(tag, text, 2), `clear of "${label}"`).toBe(true);
        }
        if (tags.length === 2) expect(apart(tags[0], tags[1], 2), 'marker clear of the state tag').toBe(true);
      });
    }
  }
});


describe('a graph too large to read whole', () => {
  // Scaled to fit a 1024 x 768 screen, the switchboard topology's text was
  // drawn at a third of its size: node subs at 3 px, edge labels at 4 px.
  it('is drawn no smaller than the readable minimum, and scrolls in its viewport instead', () => {
    host = mount(<DiagramPrimitive data={topologyDiagram} id="topology" />);
    const svg = host.querySelector('svg')!;
    const [, , width, height] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
    // Unmeasured, the host stands in for the screen (jsdom: 1024 x 768).
    const drawnWidth = svg.style.width ? parseFloat(svg.style.width) : Math.min(window.innerWidth, (width * window.innerHeight) / height);
    expect(drawnWidth / width).toBeGreaterThanOrEqual(GRAPH_MIN_SCALE - 1e-9);
    const viewport = host.querySelector('.drawing-viewport');
    expect(viewport?.classList.contains('drawing-viewport--scrolling')).toBe(true);
    // One way only: across, it fits.
    expect(['x', 'y']).toContain(viewport?.getAttribute('data-scroll'));
    expect(host.querySelector('.drawing-viewport__scroll')?.getAttribute('tabindex')).toBe('0');
  });

  it('keeps a note that names one of its nodes in the rail, the node carrying the marker', () => {
    const placed: boolean[] = [];
    host = mount(
      <DiagramPrimitive
        data={topologyDiagram}
        id="topology"
        note={{ tag: 'NOTE', anchor: { target: 'topology', node: 'gate' }, segments: [{ text: 'Short enough for a callout.' }] }}
        onCalloutChange={(value) => placed.push(value)}
      />,
    );
    // A callout rides on the drawing and could sit out of view in a scroll.
    expect(host.querySelector('.diagram-callout')).toBeNull();
    expect(placed.at(-1)).toBe(false);
    expect(host.querySelector('.diagram-node__marker')).not.toBeNull();
  });

  it('is contained, as before, when it reads whole', () => {
    render();
    expect(host.querySelector('.drawing-viewport--scrolling')).toBeNull();
    expect(host.querySelector('svg')?.style.width).toBe('');
  });
});

describe('an edge drawn as stubs', () => {
  it('draws its two stubs, an arrowhead only where it arrives, and names its far ends beside them', () => {
    // Too large for the window it is drawn in, the pipeline is recomposed
    // and its longest edges become stub pairs.
    host = mount(<DiagramPrimitive data={pipelineDiagram} id="test-diagram" />);
    const stubs = [...host.querySelectorAll<SVGPathElement>('.diagram-edges path.diagram-edge--stub')];
    expect(stubs.length).toBeGreaterThan(0);
    const arriving = stubs.filter((stub) => stub.hasAttribute('marker-end'));
    const leaving = stubs.filter((stub) => !stub.hasAttribute('marker-end'));
    expect(arriving.length).toBeGreaterThan(0);
    expect(leaving.length).toBeGreaterThan(0);
    const names = [...host.querySelectorAll('.diagram-edge-labels .diagram-edge-label-group--stub')];
    // One list of names per stub line.
    expect(names).toHaveLength(stubs.length);
    const texts = names.map((group) => [...group.querySelectorAll('tspan')].filter((line) => !line.classList.contains('diagram-edge-label__note')).map((line) => line.textContent).join(' '));
    expect(texts.some((text) => text.startsWith('-> '))).toBe(true);
    expect(texts.some((text) => text.endsWith(' ->'))).toBe(true);
    // An edge's own label sits under its far end's name, quieter.
    const notes = [...host.querySelectorAll('.diagram-edge-label-group--stub tspan.diagram-edge-label__note')].map((line) => line.textContent);
    expect(notes.length).toBeGreaterThan(0);
  });
});

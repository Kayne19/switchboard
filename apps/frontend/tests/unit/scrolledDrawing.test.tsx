// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteData } from '../../src/controller/types';
import { pipelineDiagram, topologyDiagram, traceDiagram } from '../../src/fixtures/scenes';
import { DiagramPrimitive } from '../../src/primitives/DiagramPrimitive';
import { FocusableSurface } from '../../src/primitives/FocusableSurface';
import { RAIL } from '../../src/primitives/drawingScroll';
import { SequencePrimitive } from '../../src/primitives/SequencePrimitive';

// A scrolled drawing in the diagram slot, measured as a browser would: jsdom
// has no layout, so the host reports the slot's viewport and the scroller
// its box (the visual suite's 1440 x 900 and 390 x 844 stages).
let host: HTMLDivElement;
let root: Root;
let size = { width: 914, height: 526 };
const descriptors: Record<string, PropertyDescriptor | undefined> = {};
const measured = {
  offsetWidth(this: HTMLElement) {
    return this.classList.contains('diagram-primitive') || this.classList.contains('sequence-primitive') ? size.width + 1 : 0;
  },
  offsetHeight(this: HTMLElement) {
    return this.classList.contains('diagram-primitive') || this.classList.contains('sequence-primitive') ? size.height + 1 : 0;
  },
  clientWidth(this: HTMLElement) {
    return this.classList.contains('drawing-viewport__scroll') ? size.width : 0;
  },
  clientHeight(this: HTMLElement) {
    return this.classList.contains('drawing-viewport__scroll') ? size.height : 0;
  },
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  for (const [name, get] of Object.entries(measured)) {
    descriptors[name] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get });
  }
  // jsdom scrolls nothing itself: a scroll to a place goes straight there.
  HTMLElement.prototype.scrollTo = function scrollTo(this: HTMLElement, options?: ScrollToOptions | number) {
    if (typeof options !== 'object') return;
    if (options.left !== undefined) this.scrollLeft = options.left;
    if (options.top !== undefined) this.scrollTop = options.top;
  } as typeof HTMLElement.prototype.scrollTo;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
  vi.useRealTimers();
});

function render(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(element));
  // The first frame lays the drawing out for the screen; the measured
  // viewport arrives with the next.
  act(() => root.render(element));
}

const gateNote: NoteData = { tag: 'NOTE', anchor: { target: 'topology', node: 'gate' }, segments: [{ text: 'A display counts as shown only when the page confirms it, and this note is long enough to stay in the rail.' }] };

// Each node's box on screen, in the scroll content's pixels.
function nodeBoxes() {
  const svg = host.querySelector<SVGSVGElement>('.drawing-viewport__scroll > svg')!;
  const [, , viewWidth, viewHeight] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
  const scale = parseFloat(svg.style.width) / viewWidth;
  const offsetX = Math.max(0, (size.width - viewWidth * scale) / 2);
  const offsetY = Math.max(0, (size.height - viewHeight * scale) / 2);
  return [...host.querySelectorAll('.diagram-nodes > g')].map((group) => {
    const [x, y] = (/translate\(([-\d.]+) ([-\d.]+)\)/.exec(group.getAttribute('transform') ?? '') ?? []).slice(1).map(Number);
    const d = group.querySelector('.diagram-node__frame')?.getAttribute('d') ?? '';
    const [, width, height] = /H [\d.]+ L ([\d.]+) [\d.]+ V ([\d.]+)/.exec(d)?.map(Number) ?? [];
    return {
      label: [...group.querySelectorAll('.diagram-node-label')].map((text) => text.textContent).join(' '),
      left: offsetX + x * scale,
      right: offsetX + (x + width) * scale,
      top: offsetY + y * scale,
      bottom: offsetY + (y + height) * scale,
    };
  });
}

describe('a scrolled graph at rest', () => {
  for (const stage of [{ width: 914, height: 526 }, { width: 330, height: 374 }]) {
    it(`opens with no node cut where it is read from, its anchored node whole (${stage.width} x ${stage.height})`, () => {
      size = stage;
      render(<DiagramPrimitive data={topologyDiagram} id="topology" note={gateNote} />);
      const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
      const axis = host.querySelector('.drawing-viewport')?.getAttribute('data-scroll');
      expect(['x', 'y']).toContain(axis);
      const across = axis === 'x';
      const rim = across ? scroller.scrollLeft : scroller.scrollTop;
      const boxes = nodeBoxes();
      // Before: opened centred on the gate, the 1440 stage cut "Operator agent"
      // in half at its left edge, and the phone the ElevenLabs node at its top.
      for (const box of boxes) {
        const [start, end] = across ? [box.left, box.right] : [box.top, box.bottom];
        if (rim > 0 && end > rim + 0.5) expect(start, `${box.label} is clear of the rail it is read from`).toBeGreaterThanOrEqual(rim + RAIL - 0.5);
      }
      const gate = boxes.find((box) => box.label.startsWith('Display gate'))!;
      const span = across ? size.width : size.height;
      const [start, end] = across ? [gate.left, gate.right] : [gate.top, gate.bottom];
      expect(start).toBeGreaterThanOrEqual(rim);
      expect(end).toBeLessThanOrEqual(rim + span);
    });
  }

  it('counts on each rail the nodes that lie that way, and names where a line leaving the view goes', () => {
    size = { width: 914, height: 526 };
    render(<DiagramPrimitive data={topologyDiagram} id="topology" note={gateNote} />);
    const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
    const left = scroller.scrollLeft;
    const right = left + size.width;
    const boxes = nodeBoxes();
    const past = { left: boxes.filter((box) => box.left < left + RAIL - 0.5), right: boxes.filter((box) => box.right > right - RAIL + 0.5) };
    expect(past.left.length).toBeGreaterThan(0);
    const count = (side: string) => host.querySelector(`.drawing-viewport__rim--${side}`)?.textContent ?? '';
    expect(count('left')).toBe(`${String(past.left.length).padStart(2, '0')} NODES`);
    if (past.right.length) expect(count('right')).toBe(`${String(past.right.length).padStart(2, '0')} ${past.right.length === 1 ? 'NODE' : 'NODES'}`);
    expect(host.querySelector('.drawing-viewport__rail--left')).not.toBeNull();
    // Every name on the left rail is a node out of view on the left.
    const names = [...host.querySelectorAll('.drawing-viewport__exit--left')].map((exit) => exit.textContent);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(past.left.map((box) => box.label.replace(/\s+/g, ' ')).some((label) => label.startsWith(name!.replace('\u2026', '')))).toBe(true);
  });

  it('turns a page to the next place to rest when its count is tapped, without expanding the object', () => {
    size = { width: 914, height: 526 };
    const activated: string[] = [];
    // The page hears every click at the document: the gesture that unlocks
    // audio (callRuntime). A tap on a count or the map is one too.
    const heard: EventTarget[] = [];
    const listen = (event: Event) => heard.push(event.target!);
    document.addEventListener('click', listen);
    try {
      render(
        <FocusableSurface onActivate={() => activated.push('expand')} ariaLabel="Expand diagram">
          <DiagramPrimitive data={topologyDiagram} id="topology" note={gateNote} />
        </FocusableSurface>,
      );
      const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
      const before = scroller.scrollLeft;
      const count = host.querySelector<HTMLElement>('.drawing-viewport__rim--left')!;
      act(() => count.click());
      expect(scroller.scrollLeft).toBeLessThan(before);
      const stops = [...host.querySelectorAll<HTMLElement>('.drawing-viewport__stop')].map((stop) => parseFloat(stop.style.left));
      expect(stops).toContain(scroller.scrollLeft);
      const map = host.querySelector<HTMLElement>('.drawing-viewport__map')!;
      act(() => map.click());
      expect(activated).toEqual([]);
      // Before: the count and the map stopped their clicks, so the page never
      // heard them.
      expect(heard).toEqual([count, map]);
      // The drawing itself still expands.
      act(() => scroller.click());
      expect(activated).toEqual(['expand']);
      expect(heard).toEqual([count, map, scroller]);
    } finally {
      document.removeEventListener('click', listen);
    }
  });

  it('puts a dense graph\'s stubs on its map, each line once', () => {
    size = { width: 914, height: 526 };
    render(<DiagramPrimitive data={pipelineDiagram} id="pipeline" />);
    const stubs = host.querySelectorAll('.diagram-edges path.diagram-edge--stub');
    expect(stubs.length).toBeGreaterThan(0);
    // Every line the drawing draws, routes and stubs alike; none empty for
    // an edge whose route is its stubs.
    const lines = [...host.querySelectorAll('.drawing-viewport__map-line')].map((line) => line.getAttribute('points') ?? '');
    expect(lines).toHaveLength(host.querySelectorAll('.diagram-edges path').length);
    for (const points of lines) expect(points.split(' ').length).toBeGreaterThanOrEqual(2);
  });

  it('carries a map of the whole, the view boxed where it stands', () => {
    size = { width: 914, height: 526 };
    render(<DiagramPrimitive data={topologyDiagram} id="topology" note={gateNote} />);
    const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
    const svg = host.querySelector<SVGSVGElement>('.drawing-viewport__scroll > svg')!;
    const [, , viewWidth] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
    const scale = parseFloat(svg.style.width) / viewWidth;
    const map = host.querySelector('.drawing-viewport__map')!;
    expect(map.querySelectorAll('.drawing-viewport__map-box')).toHaveLength(topologyDiagram.nodes.length);
    const box = map.querySelector('.drawing-viewport__map-view')!;
    expect(Number(box.getAttribute('x'))).toBeCloseTo(scroller.scrollLeft / scale);
    expect(Number(box.getAttribute('width'))).toBeCloseTo(size.width / scale);
  });

  it('moves across with a wheel turned over it, then settles on the next place to rest', () => {
    vi.useFakeTimers();
    size = { width: 914, height: 526 };
    render(<DiagramPrimitive data={pipelineDiagram} id="pipeline" />);
    const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
    expect(host.querySelector('.drawing-viewport')?.getAttribute('data-scroll')).toBe('x');
    const stops = [...host.querySelectorAll<HTMLElement>('.drawing-viewport__stop')].map((stop) => parseFloat(stop.style.left));
    const before = scroller.scrollLeft;
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true }));
    });
    expect(scroller.scrollLeft).toBe(before + 60);
    expect(scroller.style.scrollSnapType).toBe('none');
    act(() => vi.advanceTimersByTime(200));
    expect(stops).toContain(scroller.scrollLeft);
    expect(scroller.scrollLeft).toBeGreaterThan(before);
    // The stops hold it again once the smooth settling has ended.
    expect(scroller.style.scrollSnapType).toBe('none');
    act(() => vi.advanceTimersByTime(1000));
    expect(scroller.style.scrollSnapType).toBe('');
  });

  it('hears a wheel over its map and its counts, not only over the drawing', () => {
    vi.useFakeTimers();
    size = { width: 914, height: 526 };
    render(<DiagramPrimitive data={topologyDiagram} id="topology" note={gateNote} />);
    const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
    const before = scroller.scrollLeft;
    for (const target of [host.querySelector('.drawing-viewport__map')!, host.querySelector('.drawing-viewport__rim--left')!]) {
      act(() => {
        target.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true }));
      });
    }
    expect(scroller.scrollLeft).toBe(before - 80);
    act(() => vi.advanceTimersByTime(1000));
  });

  it('settles without the smooth scroll when the reader prefers reduced motion', () => {
    vi.useFakeTimers();
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query })) as unknown as typeof window.matchMedia;
    const calls: Array<ScrollToOptions | undefined> = [];
    const scrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = function record(this: HTMLElement, options?: ScrollToOptions | number) {
      if (typeof options === 'object') calls.push(options);
      return (scrollTo as (options?: ScrollToOptions) => void).call(this, options as ScrollToOptions);
    } as typeof HTMLElement.prototype.scrollTo;
    try {
      size = { width: 914, height: 526 };
      render(<DiagramPrimitive data={pipelineDiagram} id="pipeline" />);
      const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
      act(() => {
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true }));
      });
      act(() => vi.advanceTimersByTime(200));
      act(() => host.querySelector<HTMLElement>('.drawing-viewport__rim--right')?.click());
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls.every((call) => call?.behavior === 'auto')).toBe(true);
      expect(scroller.style.scrollSnapType).toBe('');
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it('moves only for the main button on its map', () => {
    size = { width: 914, height: 526 };
    render(<DiagramPrimitive data={topologyDiagram} id="topology" note={gateNote} />);
    const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
    const before = scroller.scrollLeft;
    const map = host.querySelector<HTMLElement>('.drawing-viewport__map')!;
    act(() => {
      map.dispatchEvent(new MouseEvent('pointerdown', { button: 2, clientX: 0, clientY: 0, bubbles: true }));
    });
    expect(scroller.scrollLeft).toBe(before);
    expect(scroller.style.scrollSnapType).toBe('');
  });
});

describe('a long exchange scrolled down', () => {
  it('keeps the reader\'s place when a note comes to name an actor and the headers grow to hold its marker', async () => {
    size = { width: 914, height: 526 };
    // Actors with no sub: their headers grow to hold the NOTE marker.
    const plain = { ...traceDiagram, actors: traceDiagram.actors.map(({ sub: _sub, ...actor }) => actor) };
    render(<SequencePrimitive data={plain} id="trace" />);
    const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
    act(() => {
      scroller.scrollTop = 600;
      scroller.dispatchEvent(new Event('scroll'));
    });
    const grown = <SequencePrimitive data={plain} id="trace" note={{ segments: [{ text: 'x' }], anchor: { target: 'trace', node: 'pbx' } }} />;
    act(() => root.render(grown));
    expect(host.querySelector('.sequence-actor__marker')).not.toBeNull();
    expect(scroller.scrollTop).toBe(600);
  });

  it('counts the messages below on its bottom rail, and above under the pinned headers once scrolled', async () => {
    size = { width: 914, height: 526 };
    render(<SequencePrimitive data={traceDiagram} id="trace" />);
    const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
    expect(scroller.scrollTop).toBe(0);
    expect(host.querySelector('.drawing-viewport__rim--bottom')?.textContent).toMatch(/^\d\d MESSAGES$/);
    expect(host.querySelector('.drawing-viewport__rim--top')).toBeNull();
    const stops = [...host.querySelectorAll<HTMLElement>('.drawing-viewport__stop')].map((stop) => parseFloat(stop.style.top));
    act(() => {
      scroller.scrollTop = stops[3];
      scroller.dispatchEvent(new Event('scroll'));
    });
    // The rails are read once a frame.
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    const pinned = host.querySelector<HTMLElement>('.drawing-viewport__pinned--shown');
    expect(pinned).not.toBeNull();
    const top = host.querySelector<HTMLElement>('.drawing-viewport__rim--top');
    expect(top?.textContent).toMatch(/^\d\d MESSAGES$/);
    expect(parseFloat(top!.style.top)).toBeCloseTo(parseFloat(pinned!.style.height));
  });
});

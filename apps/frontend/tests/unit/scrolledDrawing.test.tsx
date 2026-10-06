// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteData } from '../../src/controller/types';
import { pipelineDiagram, topologyDiagram, traceDiagram } from '../../src/fixtures/scenes';
import { DiagramPrimitive } from '../../src/primitives/DiagramPrimitive';
import { FocusableSurface } from '../../src/primitives/FocusableSurface';
import { RAIL } from '../../src/primitives/drawingScroll';
import { SequencePrimitive } from '../../src/primitives/SequencePrimitive';
import { mount, rerender, stubResizeObserver, unmountAll } from './sceneHarness';

// A scrolled drawing in the diagram slot, measured as a browser would: jsdom
// has no layout, so the host reports the slot's viewport and the scroller
// its box (the visual suite's 1440 x 900 and 390 x 844 stages).
let host: HTMLDivElement;
let size = { width: 914, height: 526 };
const descriptors: Record<string, PropertyDescriptor | undefined> = {};
// The scroller is the view: the viewport less the map's strip, when the
// drawing has one (its depth is the strip's own style).
const strip = (element: HTMLElement) => {
  const box = element.closest('.drawing-viewport')?.querySelector<HTMLElement>(':scope > .drawing-viewport__strip');
  return { right: parseFloat(box?.style.width ?? '') || 0, bottom: parseFloat(box?.style.height ?? '') || 0 };
};
const measured = {
  offsetWidth(this: HTMLElement) {
    return this.classList.contains('diagram-primitive') || this.classList.contains('sequence-primitive') ? size.width + 1 : 0;
  },
  offsetHeight(this: HTMLElement) {
    return this.classList.contains('diagram-primitive') || this.classList.contains('sequence-primitive') ? size.height + 1 : 0;
  },
  clientWidth(this: HTMLElement) {
    return this.classList.contains('drawing-viewport__scroll') ? size.width - strip(this).right : 0;
  },
  clientHeight(this: HTMLElement) {
    return this.classList.contains('drawing-viewport__scroll') ? size.height - strip(this).bottom : 0;
  },
};

stubResizeObserver();

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
  unmountAll();
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
  vi.useRealTimers();
});

function render(element: React.ReactElement) {
  host = mount(element);
  // The first frame lays the drawing out for the screen; the measured
  // viewport arrives with the next.
  rerender(host, element);
}

const gateNote: NoteData = { tag: 'NOTE', anchor: { target: 'topology', node: 'gate' }, segments: [{ text: 'A display counts as shown only when the page confirms it, and this note is long enough to stay in the rail.' }] };

// The view the drawing is read in: the scroller's box.
function view() {
  const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
  return { width: scroller.clientWidth, height: scroller.clientHeight };
}

// Where the drawing stands in the scroll content: its scale, and the margin
// that centres it across an axis it does not fill.
function placement() {
  const svg = host.querySelector<SVGSVGElement>('.drawing-viewport__scroll > svg')!;
  const [, , viewWidth, viewHeight] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
  const scale = parseFloat(svg.style.width) / viewWidth;
  return { scale, offsetX: Math.max(0, (view().width - viewWidth * scale) / 2), offsetY: Math.max(0, (view().height - viewHeight * scale) / 2) };
}

// Each node's box on screen, in the scroll content's pixels.
function nodeBoxes() {
  const { scale, offsetX, offsetY } = placement();
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
      const span = across ? view().width : view().height;
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
    const right = left + view().width;
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
    expect(Number(box.getAttribute('width'))).toBeCloseTo(view().width / scale);
  });

  // The map, in the viewport's pixels: its box (the size it is drawn at
  // and its padding) where it stands, at the far corner of the viewport.
  // (Before, it stood in a corner its class named, over the drawing.)
  function mapBox() {
    const map = host.querySelector<HTMLElement>('.drawing-viewport__map')!;
    const width = parseFloat(map.style.width) + 2 * (parseFloat(map.style.padding) || 4);
    const height = parseFloat(map.style.height) + 2 * (parseFloat(map.style.padding) || 4);
    const corner = /drawing-viewport__map--(\w+-\w+)/.exec(map.className)?.[1] ?? 'bottom-right';
    const margin = parseFloat(map.style.right) || 6;
    const left = corner.endsWith('left') ? margin : size.width - margin - width;
    const top = corner.startsWith('top') ? margin : size.height - margin - height;
    return { left, top, right: left + width, bottom: top + height };
  }

  // What the drawing draws that a reader reads: its nodes, and the backing
  // of every edge label and stub name, in the scroll content's pixels.
  function drawn() {
    const { scale, offsetX, offsetY } = placement();
    const labels = [...host.querySelectorAll('.diagram-edge-label-group, .sequence-message-label-group')].map((group) => {
      const backing = group.querySelector('rect')!;
      const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((name) => Number(backing.getAttribute(name)));
      return { label: group.textContent ?? '', left: offsetX + x * scale, right: offsetX + (x + width) * scale, top: offsetY + y * scale, bottom: offsetY + (y + height) * scale };
    });
    return [...nodeBoxes(), ...labels];
  }

  for (const [name, data, anchor, stage] of [
    ['pipeline', pipelineDiagram, 'visual', { width: 726, height: 531 }],
    ['pipeline', pipelineDiagram, 'visual', { width: 914, height: 526 }],
    ['topology', topologyDiagram, 'gate', { width: 914, height: 526 }],
    ['pipeline', pipelineDiagram, 'visual', { width: 367, height: 725 }],
    ['trace', traceDiagram, 'pbx', { width: 726, height: 531 }],
  ] as const) {
    it(`keeps its map off everything it draws, wherever it rests (${name}, ${stage.width} x ${stage.height})`, () => {
      size = stage;
      const note: NoteData = { segments: [{ text: 'x' }], anchor: { target: name, node: anchor } };
      render(data.mode === 'sequence' ? <SequencePrimitive data={data} id={name} note={note} /> : <DiagramPrimitive data={data} id={name} note={note} />);
      const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
      const axis = host.querySelector('.drawing-viewport')?.getAttribute('data-scroll');
      expect(['x', 'y']).toContain(axis);
      const map = mapBox();
      // The map stands in a strip of its own, beside the view the drawing
      // is scrolled in, and the drawing is laid out for that view: across
      // the way it does not scroll, it is no larger than the view.
      const strip = host.querySelector('.drawing-viewport > .drawing-viewport__strip');
      expect(strip?.previousElementSibling?.classList.contains('drawing-viewport__view')).toBe(true);
      expect(strip?.querySelector('.drawing-viewport__map')).not.toBeNull();
      const svg = scroller.querySelector('svg')!;
      const fitted = axis === 'x' ? parseFloat(svg.style.height) : parseFloat(svg.style.width);
      expect(fitted).toBeLessThanOrEqual((axis === 'x' ? view().height : view().width) + 0.5);
      const stops = [...host.querySelectorAll<HTMLElement>('.drawing-viewport__stop')].map((stop) => parseFloat(axis === 'x' ? stop.style.left : stop.style.top));
      expect(stops.length).toBeGreaterThan(2);
      const { width, height } = view();
      for (const stop of stops) {
        act(() => {
          if (axis === 'x') scroller.scrollLeft = stop;
          else scroller.scrollTop = stop;
          scroller.dispatchEvent(new Event('scroll'));
        });
        for (const item of drawn()) {
          // What of it is in view, in the viewport's pixels.
          const left = Math.max(0, item.left - scroller.scrollLeft);
          const right = Math.min(width, item.right - scroller.scrollLeft);
          const top = Math.max(0, item.top - scroller.scrollTop);
          const bottom = Math.min(height, item.bottom - scroller.scrollTop);
          if (right <= left || bottom <= top) continue;
          // Before: the map stood over the drawing's bottom-left corner and
          // covered a stub's names there ("-> CI summary").
          const covered = right > map.left && left < map.right && bottom > map.top && top < map.bottom;
          expect(covered, `at ${stop}, the map covers "${'label' in item ? item.label : ''}"`).toBe(false);
        }
      }
    });
  }

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

  // A browser with no scrollend (WebKit long had none): the event handler
  // property is taken off the element's prototypes for the test.
  function withoutScrollEnd(run: () => void) {
    const owners: Array<[object, PropertyDescriptor]> = [];
    for (let proto: object | null = HTMLElement.prototype; proto; proto = Object.getPrototypeOf(proto)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'onscrollend');
      if (descriptor) owners.push([proto, descriptor]);
    }
    for (const [proto] of owners) delete (proto as Record<string, unknown>).onscrollend;
    try {
      run();
    } finally {
      for (const [proto, descriptor] of owners) Object.defineProperty(proto, 'onscrollend', descriptor);
    }
  }

  it('holds its stops again only once a long settling scroll has stopped, with no word from the browser that it ended', () => {
    // A smooth scroll that takes longer than the 700 ms the stops used to wait.
    withoutScrollEnd(() => {
      vi.useFakeTimers();
      size = { width: 914, height: 526 };
      render(<DiagramPrimitive data={pipelineDiagram} id="pipeline" />);
      const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
      expect('onscrollend' in scroller).toBe(false);
      act(() => {
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true }));
      });
      act(() => vi.advanceTimersByTime(150));
      for (let elapsed = 0; elapsed < 1200; elapsed += 16) {
        act(() => {
          scroller.dispatchEvent(new Event('scroll'));
          vi.advanceTimersByTime(16);
        });
        // Before: the stops came back at 700 ms, mid-flight, and a browser
        // snaps from wherever the scroll had got to.
        expect(scroller.style.scrollSnapType, `${elapsed} ms into the scroll`).toBe('none');
      }
      act(() => vi.advanceTimersByTime(200));
      expect(scroller.style.scrollSnapType).toBe('');
    });
  });

  it('waits for scrollend where the browser sends it, through a slow frame mid-scroll', () => {
    vi.useFakeTimers();
    size = { width: 914, height: 526 };
    render(<DiagramPrimitive data={pipelineDiagram} id="pipeline" />);
    const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
    expect('onscrollend' in scroller).toBe(true);
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true }));
    });
    act(() => vi.advanceTimersByTime(150));
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
      // A frame that stalls 300 ms is not the end of the scroll.
      vi.advanceTimersByTime(300);
    });
    expect(scroller.style.scrollSnapType).toBe('none');
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
      scroller.dispatchEvent(new Event('scrollend'));
    });
    expect(scroller.style.scrollSnapType).toBe('');
  });

  it('holds its stops again at once when the browser says the scroll ended', () => {
    vi.useFakeTimers();
    size = { width: 914, height: 526 };
    render(<DiagramPrimitive data={pipelineDiagram} id="pipeline" />);
    const scroller = host.querySelector<HTMLDivElement>('.drawing-viewport__scroll')!;
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true }));
    });
    act(() => vi.advanceTimersByTime(150));
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
      scroller.dispatchEvent(new Event('scrollend'));
    });
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
    rerender(host, grown);
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

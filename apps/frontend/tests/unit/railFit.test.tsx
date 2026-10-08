// @vitest-environment jsdom
// Under the main column (a portrait stage) the rail is Damocles beside the
// note, and the note reads whole there: the rail grows to the note's height
// (the grid's --rail-floor), the note leads a column too short for all it
// carries, and the activity panel stands at the column's foot only where it
// fits there whole (Scenes.tsx useRailFit). Before, a note there was cut to
// what the rail's share left it under a reserved activity slot (two lines
// of the architecture fixture's seven at 390x844), or the rail folded to a
// strip with Damocles at a third of its size. tests/visual/rail.spec.ts
// pins the boxes in a browser; jsdom has no layout, so here the boxes are
// given and the rule is pinned.
import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ControllerAction } from '../../src/controller/types';
import { fixtures } from '../../src/fixtures/scenes';
import { lastScene, renderScene, unmountAll } from './sceneHarness';

// A phone's layout: the main column 498 px over a rail whose share is 172
// px, up to half the grid; or, on its side, the rail beside a 600 px column.
const SHARE = 172;
const HALF = 335;
let landscape = false;
let noteHeight = 182;

function room(element: HTMLElement): number {
  if (landscape) return 600;
  const floor = parseFloat(element.closest<HTMLElement>('.content-grid')?.style.getPropertyValue('--rail-floor') ?? '') || 0;
  return Math.min(Math.max(SHARE, floor), HALF);
}

function height(element: HTMLElement): number {
  const classes = element.classList;
  if (classes.contains('composed-main')) return landscape ? 600 : 498;
  if (classes.contains('content-rail') || classes.contains('content-rail__details')) return room(element);
  if (classes.contains('rail-note')) return noteHeight;
  if (classes.contains('metrics')) return 62;
  if (classes.contains('rail-progress')) return 120;
  if (classes.contains('live-chat-card')) return 110;
  if (classes.contains('tool-activity-slot')) return element.children.length > 0 ? 50 : 0;
  return 0;
}

const laidOut: Record<string, (this: HTMLElement) => number> = {
  offsetTop(this: HTMLElement) {
    return this.classList.contains('content-rail') && !landscape ? 516 : 0;
  },
  offsetHeight(this: HTMLElement) {
    return height(this);
  },
  clientHeight(this: HTMLElement) {
    return height(this);
  },
  scrollHeight(this: HTMLElement) {
    if (!this.classList.contains('content-rail__details')) return height(this);
    const parts = Array.from(this.children) as HTMLElement[];
    const flow = parts.filter((part) => !part.classList.contains('tool-activity-slot--away'));
    return Math.max(height(this), flow.reduce((sum, part) => sum + height(part), 0));
  },
};
const originals = new Map<string, PropertyDescriptor | undefined>();
const observers = new Set<{ report: () => void }>();
// What a browser does after a layout: every observer reports its boxes.
const settle = () =>
  act(() => {
    for (const observer of [...observers]) observer.report();
  });

beforeAll(() => {
  globalThis.ResizeObserver = class {
    private live = false;
    constructor(private readonly callback: () => void) {}
    observe() {
      this.live = true;
      observers.add(this);
    }
    unobserve() {}
    disconnect() {
      this.live = false;
      observers.delete(this);
    }
    report() {
      if (this.live) this.callback();
    }
  } as unknown as typeof ResizeObserver;
  for (const [key, get] of Object.entries(laidOut)) {
    originals.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get });
  }
});

afterAll(() => {
  for (const [key, original] of originals) {
    if (original) Object.defineProperty(HTMLElement.prototype, key, original);
  }
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

beforeEach(() => {
  landscape = false;
  noteHeight = 182;
});

afterEach(() => {
  unmountAll();
  observers.clear();
});

function render(actions: ControllerAction[]) {
  renderScene(actions);
  // Twice: the rail is found under the column, then the column is measured
  // in the rail the note's height gave it.
  settle();
  settle();
  const scene = lastScene();
  return {
    floor: scene.querySelector<HTMLElement>('.content-grid')!.style.getPropertyValue('--rail-floor'),
    leads: scene.querySelector('.rail-note--leads') !== null,
    away: scene.querySelector('.tool-activity-slot--away') !== null,
    // Nothing is drawn over an edge the column continues past (#177).
    rims: scene.querySelectorAll('[class*="scroll-rim"]').length,
    order: Array.from(scene.querySelector('.content-rail__details')!.children).map((child) => child.classList[0]),
  };
}

describe('the rail under the main column', () => {
  it('is as tall as its note reads whole in, and sets the activity panel aside where its foot has no room for it', () => {
    // The architecture fixture: a seven-line note, nothing else in the rail.
    const rail = render([...fixtures.architecture]);
    expect(rail.floor).toBe('182px');
    expect(rail.leads).toBe(false);
    expect(rail.away).toBe(true);
    expect(rail.rims).toBe(0);
  });

  it('keeps the activity panel at its foot where a short note leaves it room', () => {
    noteHeight = 100;
    const rail = render([...fixtures.architecture]);
    expect(rail.floor).toBe('100px');
    expect(rail.away).toBe(false);
  });

  it('leads with the note, whole, where the column cannot hold all it carries', () => {
    noteHeight = 84;
    // The plan fixture: two metrics and a progress over the note.
    const rail = render([...fixtures.plan]);
    expect(rail.order).toEqual(['metrics', 'rail-progress', 'rail-note', 'tool-activity-slot']);
    expect(rail.leads).toBe(true);
    expect(rail.away).toBe(true);
    expect(rail.rims).toBe(0);
  });

  it('holds a note longer than half the grid at half', () => {
    noteHeight = 400;
    const rail = render([...fixtures.architecture]);
    // The floor says the note's height; the grid holds the rail at half (the room stub).
    expect(rail.floor).toBe('400px');
    expect(rail.rims).toBe(0);
  });

  it('lets go of all it decided when the rail turns to stand beside the column', () => {
    noteHeight = 84;
    renderScene([...fixtures.plan]);
    settle();
    settle();
    const scene = lastScene();
    expect(scene.querySelector('.rail-note--leads')).not.toBeNull();
    // Turned on its side: the rail stands beside the column.
    landscape = true;
    settle();
    expect(scene.querySelector<HTMLElement>('.content-grid')!.style.getPropertyValue('--rail-floor')).toBe('');
    expect(scene.querySelector('.rail-note--leads')).toBeNull();
    expect(scene.querySelector('.tool-activity-slot--away')).toBeNull();
    // Upright again: decided afresh.
    landscape = false;
    settle();
    settle();
    expect(scene.querySelector<HTMLElement>('.content-grid')!.style.getPropertyValue('--rail-floor')).toBe('84px');
    expect(scene.querySelector('.rail-note--leads')).not.toBeNull();
  });

  it('measures nothing where the rail stands beside the column', () => {
    landscape = true;
    const rail = render([...fixtures.architecture]);
    expect(rail.floor).toBe('');
    expect(rail.leads).toBe(false);
    expect(rail.away).toBe(false);
    expect(rail.rims).toBe(0);
  });
});

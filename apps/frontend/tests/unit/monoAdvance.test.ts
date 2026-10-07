// The advances the layouts measure monospace text by before it is drawn
// (design/tokens.ts `monoAdvance`), held in step with the stylesheet rules
// that set the text: a change of a face's size or tracking in index.css
// fails here until the layout that measures it follows.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { monoAdvance } from '../../src/design/tokens';
import { CHART_LEGEND_CHAR_ADVANCE, CHART_TICK_CHAR_ADVANCE } from '../../src/primitives/chartGeometry';
import { NODE_TEXT } from '../../src/primitives/diagramLayout';
import { LABEL_ADVANCE } from '../../src/primitives/drawingKit';
import { TAG_ADVANCE } from '../../src/primitives/drawingScroll';
import { actorAdvance, actorSubAdvance } from '../../src/primitives/sequenceLayout';
import { DIGIT_ADVANCE } from '../../src/primitives/timerReading';
import { heroEms } from '../../src/primitives/weatherLayout';

const css = readFileSync(`${import.meta.dirname}/../../src/styles/index.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Every innermost rule, and whether it stands inside an at-rule (@media, @container).
const rules: Array<{ selectors: string[]; body: string; nested: boolean }> = [];
let depth = 0;
for (const [token, head, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}|[^{}]*\{|\}/g)) {
  if (body !== undefined) rules.push({ selectors: head.split(',').map((each) => each.trim()), body, nested: depth > 0 });
  else depth += token.endsWith('{') ? 1 : -1;
}

/** The face the top-level rules naming `selector` (alone or in a list) set, the last declaration winning. */
function face(selector: string): { size?: number; tracking?: number; family?: string } {
  const found: { size?: number; tracking?: number; family?: string } = {};
  for (const { selectors, body, nested } of rules) {
    if (nested || !selectors.includes(selector)) continue;
    const size = /font-size:\s*([\d.]+)px/.exec(body)?.[1];
    const tracking = /letter-spacing:\s*(-?[\d.]+)em/.exec(body)?.[1];
    const family = /font-family:\s*([^;]+);/.exec(body)?.[1];
    if (size) found.size = Number(size);
    if (tracking) found.tracking = Number(tracking);
    if (family) found.family = family.trim();
  }
  return found;
}

/** The advance of `selector`'s face as the stylesheet sets it: monospace, a size in px, a tracking in em. */
function advanceOf(selector: string, size?: number): number {
  const set = face(selector);
  expect(set.family, selector).toMatch(/monospace|--font-mono/);
  expect(set.tracking, selector).toBeTypeOf('number');
  return monoAdvance(size ?? set.size!, set.tracking!);
}

const MEASURED = ['.diagram-edge-label', '.sequence-message-label', '.chart-legend text', '.chart-grid text', '.diagram-node-label', '.diagram-node-sub', '.diagram-node-detail', '.drawing-viewport__exit', '.sequence-actor-label', '.sequence-actor-sub', '.timer__digits', '.weather-now__temp'];
// Rules that set a measured face somewhere the layouts do not measure it: a timer's row sizes its own digits.
const MEASURED_ELSEWHERE = ['.timer-row .timer__digits'];

describe('the monospace advance', () => {
  it('is 0.6em plus the tracking, without the floating-point remainder', () => {
    expect(monoAdvance(9, 0.08)).toBe(6.12);
    expect(monoAdvance(11, 0.06)).toBeCloseTo(7.26, 12);
    expect(monoAdvance(11, 0.06, { roundUp: true })).toBe(7.3);
    expect(monoAdvance(10, -0.03)).toBeCloseTo(5.7, 12);
  });
});

describe('the advances the layouts measure text by', () => {
  it('are the faces the stylesheet sets, rounded up where the layout rounds', () => {
    const roundUp = (value: number) => Math.ceil(value * 10) / 10;
    expect(LABEL_ADVANCE).toBe(roundUp(advanceOf('.diagram-edge-label')));
    expect(LABEL_ADVANCE).toBe(roundUp(advanceOf('.sequence-message-label')));
    expect(CHART_LEGEND_CHAR_ADVANCE).toBe(roundUp(advanceOf('.chart-legend text')));
    expect(NODE_TEXT.sub.advance).toBe(roundUp(advanceOf('.diagram-node-sub')));
    expect(NODE_TEXT.detail.advance).toBe(roundUp(advanceOf('.diagram-node-detail')));
    expect(TAG_ADVANCE).toBe(advanceOf('.drawing-viewport__exit'));
    // An actor's sizes are set by the layout, its tracking by the stylesheet.
    for (const size of [9, 12, 15]) {
      expect(actorAdvance(size)).toBe(advanceOf('.sequence-actor-label', size));
      expect(actorSubAdvance(size)).toBe(advanceOf('.sequence-actor-sub', size));
    }
  });

  it('keep the room each layout says it keeps past its face, and no other', () => {
    expect(NODE_TEXT.label.advance).toBeCloseTo(advanceOf('.diagram-node-label') + 0.3, 12);
    expect(DIGIT_ADVANCE).toBeCloseTo(advanceOf('.timer__digits', 1) + 0.05, 12);
    // The forecast's digits leave their tracking out, as room.
    expect(heroEms('00') - heroEms('0')).toBeCloseTo(advanceOf('.weather-now__temp', 1) - face('.weather-now__temp').tracking!, 12);
    // The tick text is the legend's face at its own size: the legend's rounded advance, scaled.
    const legend = face('.chart-legend text');
    const tick = face('.chart-grid text');
    expect(tick.tracking).toBe(legend.tracking);
    expect(CHART_TICK_CHAR_ADVANCE).toBeCloseTo((CHART_LEGEND_CHAR_ADVANCE * tick.size!) / legend.size!, 12);
    expect(CHART_TICK_CHAR_ADVANCE).toBeGreaterThanOrEqual(advanceOf('.chart-grid text'));
  });

  it('are set by one top-level rule each, so the face read here is the face drawn', () => {
    // A rule that sets a measured face's size or tracking elsewhere (in an
    // @media block, or on a more specific selector) would draw text the
    // layout did not measure.
    const compounds = (selector: string) => selector.trim().split(/[\s>+~]+/);
    const hasClass = (compound: string, name: string) => new RegExp(`${name.replace(/\./g, '\\.')}(?![\\w-])`).test(compound);
    const names = (selector: string, measured: string) => {
      const [anchor, ...rest] = compounds(measured);
      const target = rest.at(-1) ?? anchor;
      const last = compounds(selector).at(-1)!;
      return hasClass(selector, anchor) && (target.startsWith('.') ? hasClass(last, target) : last === target);
    };
    for (const { selectors, body, nested } of rules) {
      if (!/font-size|letter-spacing/.test(body)) continue;
      for (const selector of selectors) {
        if (MEASURED_ELSEWHERE.includes(selector)) continue;
        for (const measured of MEASURED.filter((each) => names(selector, each))) expect({ selector, nested }).toEqual({ selector: measured, nested: false });
      }
    }
  });
});

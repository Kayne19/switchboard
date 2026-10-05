import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TYPE_FLOOR_PX } from '../../src/design/tokens';
import { fitDrawing, readableScale, scrollCost } from '../../src/primitives/drawingFit';

describe('the type floors', () => {
  it('are the floors the stylesheet sets its two small faces at', () => {
    // A drawing keeps its text at or above the page's smallest type; the
    // numbers it reads are the clamp() floors of .tech and .micro.
    const css = readFileSync(`${import.meta.dirname}/../../src/styles/index.css`, 'utf8');
    const floorOf = (selector: string) => {
      const rule = new RegExp(`(^|\\n)\\${selector} \\{([^}]*)\\}`).exec(css)?.[2] ?? '';
      return Number(/font-size:\s*clamp\((\d+(?:\.\d+)?)px/.exec(rule)?.[1]);
    };
    expect(floorOf('.tech')).toBe(TYPE_FLOOR_PX.tech);
    expect(floorOf('.micro')).toBe(TYPE_FLOOR_PX.micro);
  });

  it('give the least scale at which every face of a drawing keeps them', () => {
    expect(readableScale([{ size: 9, floor: 'micro' }])).toBeCloseTo(7 / 9);
    expect(readableScale([{ size: 9, floor: 'micro' }, { size: 10, floor: 'tech' }])).toBeCloseTo(0.8);
    expect(readableScale([])).toBe(0);
  });
});

describe('fitting a drawing to its viewport', () => {
  const viewport = { width: 900, height: 500, scrollbar: 10 };

  it('contains a drawing that reads at the size that fits, as large as fits', () => {
    const fit = fitDrawing({ width: 1000, height: 620 }, viewport, 0.75);
    expect(fit.scale).toBeCloseTo(500 / 620);
    expect([fit.scrollX, fit.scrollY]).toEqual([false, false]);
    expect(fitDrawing({ width: 400, height: 200 }, viewport, 0.75).scale).toBeCloseTo(2.25);
  });

  it('fills a long drawing across, never below the readable minimum, and scrolls it along its length only', () => {
    const fit = fitDrawing({ width: 3000, height: 600 }, viewport, 0.75);
    // Across, it fills what the scroll bar leaves.
    expect(fit.scale).toBeCloseTo((500 - 10) / 600);
    expect([fit.scrollX, fit.scrollY]).toEqual([true, false]);
    expect(fit.height).toBeLessThanOrEqual(viewport.height - viewport.scrollbar + 1e-9);
    const deep = fitDrawing({ width: 3000, height: 1000 }, viewport, 0.75);
    expect(deep.scale).toBe(0.75);
  });

  it('fills a tall drawing across, up to its own size, and scrolls it down', () => {
    const narrow = fitDrawing({ width: 1000, height: 5000 }, viewport, 0.75);
    expect(narrow.scale).toBeCloseTo((900 - 10) / 1000);
    expect([narrow.scrollX, narrow.scrollY]).toEqual([false, true]);
    const slim = fitDrawing({ width: 300, height: 5000 }, viewport, 0.75);
    expect(slim.scale).toBe(1);
    expect([slim.scrollX, slim.scrollY]).toEqual([false, true]);
  });

  it('scrolls both ways only when the readable minimum overflows both', () => {
    const fit = fitDrawing({ width: 3000, height: 2000 }, viewport, 0.75);
    expect(fit.scale).toBe(0.75);
    expect([fit.scrollX, fit.scrollY]).toEqual([true, true]);
    expect(scrollCost(fit, viewport)).toBeCloseTo((2250 / 900) * (1500 / 500));
    expect(scrollCost(fitDrawing({ width: 1000, height: 620 }, viewport, 0.75), viewport)).toBe(1);
  });
});

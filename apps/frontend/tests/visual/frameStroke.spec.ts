import { expect, test } from '@playwright/test';
import { FRAME_GEOMETRIES } from './helpers';

// A frame is drawn inside the box it frames. Its strokes once sat centred
// on that box's edge, half of each line outside it, and showed only where
// nothing clipped the box: the answer card's entrance leaves a clip-path at
// its box (ObjectMotion), and where the box stood at a fraction of a pixel,
// one engine kept the inner half of the left and top lines and another
// dropped them (#190; Chromium at 1376x1032 at 2x lost both). Inside the
// box, no clip at its edge can take a line. Each stroke is checked whole,
// at its drawn width, against the box of the element the frame stands in.

/**
 * The suites' geometries, and a large tablet's both ways at its 2x, where
 * the lines were lost. What is checked is where each line lies, which the
 * scale does not move; the 2x is the screen the loss was seen on.
 */
const GEOMETRIES = [
  ...FRAME_GEOMETRIES.map((geometry) => ({ ...geometry, scale: 1 })),
  { name: 'large-tablet-landscape@2x', width: 1376, height: 1032, scale: 2 },
  { name: 'large-tablet-portrait@2x', width: 1032, height: 1376, scale: 2 },
] as const;

/** The scenes whose objects are framed: the answer card, the chart panel, the document, the source and the table, the graph's rails. */
const SCENES = [
  ['conversation', 'conversation'],
  ['training', 'training'],
  ['email', 'document'],
  ['code', 'code'],
  ['results', 'table'],
  ['architecture', 'architecture'],
] as const;

/** Every frame stroke that reaches past the box its frame stands in, as `scene path side +px`. */
function strokesOutside(): string[] {
  const found: string[] = [];
  for (const frame of document.querySelectorAll<SVGSVGElement>('svg.tech-frame')) {
    const owner = frame.parentElement;
    if (!owner || frame.getClientRects().length === 0) continue;
    const box = frame.getBoundingClientRect();
    const held = owner.getBoundingClientRect();
    const view = frame.viewBox.baseVal;
    const [sx, sy] = [box.width / view.width, box.height / view.height];
    frame.querySelectorAll('path').forEach((path, index) => {
      // The strokes are non-scaling: their width is in screen pixels.
      const half = parseFloat(getComputedStyle(path).strokeWidth) / 2;
      let [x, y] = [0, 0];
      const points: Array<[number, number]> = [];
      for (const [, op, args] of (path.getAttribute('d') ?? '').matchAll(/([MLHVZ])([^MLHVZ]*)/g)) {
        const n = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
        if (op === 'H') x = n[0];
        else if (op === 'V') y = n[0];
        else if (op !== 'Z') [x, y] = [n[0], n[1]];
        points.push([box.left + sx * x, box.top + sy * y]);
      }
      const xs = points.map(([px]) => px);
      const ys = points.map(([, py]) => py);
      const past = {
        left: held.left - (Math.min(...xs) - half),
        top: held.top - (Math.min(...ys) - half),
        right: Math.max(...xs) + half - held.right,
        bottom: Math.max(...ys) + half - held.bottom,
      };
      for (const [side, by] of Object.entries(past)) {
        if (by > 0.01) found.push(`${frame.getAttribute('class')} path ${index} ${side} +${by.toFixed(2)}px`);
      }
    });
  }
  return found;
}

for (const geometry of GEOMETRIES) {
  test.describe(`${geometry.name} frame strokes`, () => {
    test.use({ viewport: { width: geometry.width, height: geometry.height }, deviceScaleFactor: geometry.scale });
    for (const [scene, drawnAs] of SCENES) {
      test(`${scene}: every frame stroke lies inside the box it frames`, async ({ page }) => {
        await page.goto(`/?scene=${scene}&chrome=0`);
        await page.waitForSelector(`[data-scene="${drawnAs}"] svg.tech-frame`, { state: 'visible' });
        expect(await page.evaluate(strokesOutside)).toEqual([]);
      });
    }
  });
}

// An entrance that resolves out of a blur ends with no filter on it
// (ObjectMotion `SHARP`). Motion leaves the value it animated to, and
// `blur(0px)` is still a filter: Chrome drew a box under one through a
// surface of its own or not from load to load, so text at a fractional
// position moved a pixel between two loads of the same scene. jsdom runs no
// compositor; tests/visual/rest.spec.ts reads the filters on a real page.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHARP } from '../../src/primitives/ObjectMotion';

const src = new URL('../../src/', import.meta.url).pathname;
const sources = (readdirSync(src, { recursive: true }) as string[])
  .filter((file) => /\.(tsx?|css)$/.test(file))
  .map((file) => ({ file, text: readFileSync(join(src, file), 'utf8') }));

describe('an entrance blur', () => {
  it('ends with no filter left on the box', () => {
    expect(SHARP.filter).toBe('blur(0px)');
    expect(SHARP.transitionEnd.filter).toBe('none');
  });

  it('comes to rest only through SHARP: no other blur(0px) anywhere in the page source', () => {
    // An animate target, a variant, a constant or a keyframe that ends at
    // blur(0px) would leave the filter on: SHARP is its one writer.
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const written = sources.flatMap(({ file, text }) => (code(text).match(/blur\(\s*0(px)?\s*\)/g) ?? []).map(() => file));
    expect(written).toEqual(['primitives/ObjectMotion.tsx']);
  });
});

// The paper colour is said once: --paper, and --paper-rgb for its tints
// (rgba(var(--paper-rgb), a)), as --orange-rgb is for the orange. A tint
// written as a literal drifts from the token and from its siblings.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(`${import.meta.dirname}/../../src/${relative}`, 'utf8');
const css = read('styles/index.css');
const LITERAL = /rgba?\(\s*232\s*,\s*230\s*,\s*223\b/;

describe('the paper token', () => {
  it('names the paper colour as --paper-rgb, the same colour as --paper', () => {
    const hex = /--paper:\s*#([0-9a-f]{6});/i.exec(css)?.[1];
    const rgb = /--paper-rgb:\s*([\d\s,]+);/.exec(css)?.[1];
    expect(hex).toBeDefined();
    expect(rgb?.split(',').map((part) => Number(part.trim()))).toEqual([0, 2, 4].map((at) => parseInt(hex!.slice(at, at + 2), 16)));
  });

  it('tints the paper through the token, never a literal', () => {
    for (const file of ['styles/index.css', 'primitives/TechFrame.tsx', 'primitives/DiagramPrimitive.tsx']) expect(read(file), file).not.toMatch(LITERAL);
  });
});

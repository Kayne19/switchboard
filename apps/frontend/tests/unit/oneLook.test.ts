// One look for two things every list-like object draws (dedup-audit #9a,
// #9c): its meta line (what it is and what it holds, styles .meta-line,
// its title .meta-line__title) and the item a note names (--marked-edge,
// --marked-wash-from, --marked-wash-to). Each primitive keeps its own
// layout; the ink is said once, so the looks cannot drift apart again.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(`${import.meta.dirname}/../../src/${relative}`, 'utf8');
const css = read('styles/index.css').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, head, body]) => ({ selectors: head.split(',').map((each) => each.trim()), body }));
const declares = (selector: RegExp, property: string) =>
  rules.filter((rule) => rule.selectors.some((each) => selector.test(each)) && new RegExp(`(^|;|\\s)${property}\\s*:`).test(rule.body));

describe('one look', () => {
  it('inks every meta line and its title in one rule each', () => {
    expect(declares(/^\.meta-line$/, 'color')).toHaveLength(1);
    expect(declares(/^\.meta-line__title$/, 'color')).toHaveLength(1);
    const own = /^\.(table-viewport__meta|document-viewport__meta|tasks-primitive__meta|inbox-primitive__meta|calendar__meta|tasks-primitive__title|inbox-primitive__title|calendar__meta-title|weather-now__title)$/;
    expect(declares(own, 'color').map((rule) => rule.selectors.join(', '))).toEqual([]);
    for (const file of ['TablePrimitive.tsx', 'DocumentViewport.tsx', 'TasksPrimitive.tsx', 'InboxPrimitive.tsx', 'CalendarPrimitive.tsx']) {
      expect(read(`primitives/${file}`), file).toMatch(/className="[^"]*\bmeta-line\b/);
    }
    expect(read('primitives/MetaTitle.tsx')).toMatch(/meta-line__title/);
  });

  it('marks the item a note names with the same edge and wash everywhere', () => {
    const marked = rules.filter((rule) => rule.selectors.some((each) => /--marked\b/.test(each) && !/::before/.test(each)));
    expect(marked.length).toBeGreaterThan(3);
    for (const rule of marked) {
      // Only the tokens carry the orange: no marked rule writes its own alpha.
      expect(rule.body, rule.selectors.join(', ')).not.toMatch(/rgba\(var\(--orange-rgb\),\s*0?\.\d+\)/);
    }
    for (const token of ['--marked-edge', '--marked-wash-from', '--marked-wash-to']) expect(css).toMatch(new RegExp(`${token}:`));
  });
});

// The aux row's sizing contract. jsdom lays nothing out, so this holds the
// stylesheet to the rules that keep every visual in the row readable; the
// geometry itself is checked in a browser by tests/visual/composition.spec.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/styles/index.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selectors: string[];
  declarations: Map<string, string>;
  /** Inside a container or media query rather than at the top level. */
  conditional: boolean;
}

// Every style rule in source order, with the at-rule it sits in noted. The
// stylesheet nests one level at most (a rule inside `@container`/`@media`).
function rules(): Rule[] {
  const found: Rule[] = [];
  const walk = (text: string, conditional: boolean) => {
    let index = 0;
    while (index < text.length) {
      const open = text.indexOf('{', index);
      if (open < 0) break;
      const prelude = text.slice(index, open).trim();
      let depth = 1;
      let close = open + 1;
      while (depth > 0 && close < text.length) {
        if (text[close] === '{') depth += 1;
        if (text[close] === '}') depth -= 1;
        close += 1;
      }
      const body = text.slice(open + 1, close - 1);
      if (prelude.startsWith('@')) {
        if (/^@(container|media)/.test(prelude)) walk(body, true);
      } else {
        const declarations = new Map<string, string>();
        for (const part of body.split(';')) {
          const colon = part.indexOf(':');
          if (colon > 0) declarations.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
        }
        found.push({ selectors: prelude.split(',').map((s) => s.trim().replace(/\s+/g, ' ')), declarations, conditional });
      }
      index = close;
    }
  };
  walk(css, false);
  return found;
}

const all = rules();

// The value a top-level rule set gives `property` on `selector`, the last
// one in source order winning, as the cascade decides between equal ones.
function topLevel(selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const rule of all) {
    if (!rule.conditional && rule.selectors.includes(selector) && rule.declarations.has(property)) {
      value = rule.declarations.get(property);
    }
  }
  return value;
}

describe('the aux row', () => {
  it('scrolls inside itself when its cells do not fit, rather than squeezing one', () => {
    expect(topLevel('.composed-aux', 'overflow-y')).toBe('auto');
  });

  it('gives every visual a readable floor, never zero', () => {
    expect(topLevel('.composed-aux-object--visual', 'min-height')).toBe('var(--aux-visual-floor)');
    const floor = topLevel('.composed-aux', '--aux-visual-floor') ?? '';
    const least = /^clamp\((\d+)px,/.exec(floor);
    expect(least, floor).not.toBeNull();
    expect(Number(least![1])).toBeGreaterThanOrEqual(100);
  });

  it('keeps a metric, a note or a progress at its own height', () => {
    expect(topLevel('.composed-aux-object', 'min-height')).toBe('auto');
  });

  it('is never reset to collapse a cell by a geometry rule', () => {
    const resets = all.filter((rule) => rule.conditional
      && rule.selectors.some((s) => /(^|[\s>])\.composed-aux-object(--visual)?$/.test(s))
      && rule.declarations.has('min-height'));
    expect(resets.map((rule) => rule.selectors.join(', '))).toEqual([]);
  });

  it('takes no more than half of the main column, so the primary keeps the larger share', () => {
    const cap = /^fit-content\((\d+)%\)$/.exec(topLevel('.composed-main', 'grid-auto-rows') ?? '');
    expect(cap).not.toBeNull();
    expect(Number(cap![1])).toBeLessThanOrEqual(50);
    // Alone, the main slot fills the column: no empty aux row is reserved.
    expect(topLevel('.composed-main', 'grid-template-rows')).toBe('minmax(0, 1fr)');
  });

  it('takes no height from a drawing that scrolls, which is laid out for the height it is given', () => {
    // A box as tall as its scrolling drawing lays the drawing out again for
    // that height; in the aux row the two took turns forever.
    expect(topLevel('.drawing-viewport--scrolling .drawing-viewport__view', 'contain')).toBe('size');
  });

  it('takes from timers the height they ask by their width, not what they drew for the height they were given', () => {
    // A grid laid out for its box draws a little less than its box; asked
    // for that, a row as tall as its cells ask went round every frame.
    // TimerPrimitive sets --timer-ask (timerReading.ts timerGridLeast).
    expect(topLevel('.timer-primitive__field', 'contain')).toBe('size');
    expect(topLevel('.timer-primitive__field', 'contain-intrinsic-height')).toBe('var(--timer-ask, 0px)');
  });

  it('contains an image in its cell instead of cropping it', () => {
    expect(topLevel('.composed-aux-object--image .image-primitive__field', 'height')).toBe('100%');
    expect(topLevel('.image-primitive__img', 'object-fit')).toBe('contain');
  });
});

describe('a table', () => {
  // A narrow cell scrolls the table sideways inside its viewport; it never
  // splits a word to fit (`overflow-wrap: anywhere` sized columns below
  // their longest word).
  it('never breaks a word inside itself to fit a narrow cell', () => {
    const breaking = all.filter((rule) => rule.selectors.some((s) => s.includes('table-'))
      && (rule.declarations.get('overflow-wrap') === 'anywhere' || /break-all|break-word/.test(rule.declarations.get('word-break') ?? '')));
    expect(breaking.map((rule) => rule.selectors.join(', '))).toEqual([]);
    expect(topLevel('.table-viewport__scroll', 'overflow')).toBe('auto');
  });
});

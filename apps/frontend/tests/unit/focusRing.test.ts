// The page's focus ring: a control reached from the keyboard draws one
// orange line a little off it (index.css, the rule that names
// `.focusable-content:focus-visible`). Every button a primitive draws takes
// it. The live response's HISTORY button did not: it shares every other
// rule with a note's HISTORY button, and drew the browser's own ring.
// jsdom matches no :focus-visible and draws no outline, so the stylesheet
// is read; a browser draws it (tests/visual/conversation.spec.ts).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/styles/index.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const primitives = new URL('../../src/primitives/', import.meta.url).pathname;

// Top-level rules only: a ring is never drawn under a container or media query.
function topLevelRules(): Array<{ selectors: string[]; body: string }> {
  const found: Array<{ selectors: string[]; body: string }> = [];
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open < 0) break;
    const prelude = css.slice(index, open).trim();
    let depth = 1;
    let close = open + 1;
    while (depth > 0 && close < css.length) {
      if (css[close] === '{') depth += 1;
      if (css[close] === '}') depth -= 1;
      close += 1;
    }
    if (!prelude.startsWith('@')) found.push({ selectors: prelude.split(',').map((selector) => selector.trim()), body: css.slice(open + 1, close - 1) });
    index = close;
  }
  return found;
}

// The class each <button> in a primitive's source carries first (an arrow
// function's `=>` in its props does not end the tag), and how many buttons
// there are: a button with no literal class is one the ring cannot be
// checked for.
function primitiveButtons(): { classes: string[]; buttons: number } {
  const classes: string[] = [];
  let buttons = 0;
  for (const file of readdirSync(primitives).filter((name) => name.endsWith('.tsx'))) {
    const source = readFileSync(join(primitives, file), 'utf8');
    buttons += source.match(/<button\b/g)?.length ?? 0;
    for (const match of source.matchAll(/<button\b(?:=>|[^>])*?className="([\w-]+)/gs)) classes.push(match[1]);
  }
  return { classes, buttons };
}

describe('the focus ring', () => {
  const ring = topLevelRules().find((rule) => rule.selectors.includes('.focusable-content:focus-visible'))!;

  it('is one orange line, a little off the control', () => {
    expect(ring.body).toMatch(/outline:\s*1px solid var\(--orange\)/);
    expect(ring.body).toMatch(/outline-offset:\s*4px/);
  });

  it('is drawn by every button a primitive draws, the live response\'s HISTORY among them', () => {
    const { classes, buttons } = primitiveButtons();
    expect(classes).toHaveLength(buttons);
    expect(classes).toEqual(expect.arrayContaining(['annotation-card__history', 'live-chat-card__history', 'damocles-presence__button', 'transcript-toggle']));
    expect(classes.filter((name) => !ring.selectors.includes(`.${name}:focus-visible`))).toEqual([]);
  });
});

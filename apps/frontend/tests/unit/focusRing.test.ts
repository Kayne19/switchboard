// The page's focus ring (DESIGN_SYSTEM.md, "Focus ring"): every control the
// keyboard reaches draws one orange line, never the browser's own ring, and
// no box clips it. A control draws it 4px off itself; a region (a scroll, a
// paged view, an object's surface) draws it on its own edge, inside, since
// what holds it clips past that edge. jsdom matches no :focus-visible and
// draws no outline, so the stylesheet and the sources are read; a browser
// draws it (tests/visual/focusRing.spec.ts, every control in every fixture).
//
// The page drew the browser's ring on RETURN / ESC (focus and the history),
// on every scroll Chrome makes a tab stop (a note's text, the answer, a
// scrolled drawing), on a calendar's paged days; an object's own ring was
// cut away whole by its box; the live response's HISTORY had no name.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${import.meta.dirname}/../../src/styles/index.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const src = `${import.meta.dirname}/../../src/`;
// The demo's own controls (the controller panel and the IR drawer) are not
// on the call page (App.tsx draws them only for a fixture scene).
const DEMO = new Set(['components/ControllerPanel.tsx', 'components/IRDrawer.tsx']);
const sources = (readdirSync(src, { recursive: true }) as string[])
  .filter((file) => /^(primitives|components)\/.*\.tsx$/.test(file) && !DEMO.has(file))
  .map((file) => ({ file, text: readFileSync(join(src, file), 'utf8') }));

// Every rule with its selectors, nested ones (a container query's) included.
function rules(): Array<{ selectors: string[]; body: string }> {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1].trim().split(',').map((selector) => selector.trim().replace(/\s+/g, ' ')),
    body: match[2],
  }));
}
const LIST_SCROLLS = ['code-viewport__scroll', 'document-viewport__body', 'table-viewport__scroll'];
const ruleNaming = (selector: string) => rules().find((rule) => rule.selectors.includes(selector))!;

// The class each tag of `pattern` in the page's sources carries first (an
// arrow function's `=>` in its props does not end the tag), and how many
// such tags there are: one with no literal class cannot be checked.
function tagged(pattern: RegExp): { classes: string[]; tags: number; where: string[] } {
  const classes: string[] = [];
  const where: string[] = [];
  let tags = 0;
  for (const { file, text } of sources) {
    for (const match of text.matchAll(pattern)) {
      tags += 1;
      const name = match[0].match(/className=(?:"|\{`)([\w-]+)/)?.[1];
      if (name) classes.push(name);
      else where.push(`${file}: ${match[0].slice(0, 60)}`);
    }
  }
  return { classes, tags, where };
}

describe('the focus ring', () => {
  const control = ruleNaming('.damocles-presence__button:focus-visible');
  const region = ruleNaming('.annotation-card__text:focus-visible');
  const over = ruleNaming('.focusable-content:focus-visible::after');
  // A region drawn over: its own ::after, or the one of the box it scrolls in.
  const drawnOver = (name: string) => over.selectors.some((selector) => selector === `.${name}:focus-visible::after` || selector.endsWith(`:has(> .${name}:focus-visible)::after`));
  const ringed = (name: string) => region.selectors.includes(`.${name}:focus-visible`) || drawnOver(name);

  it('is one orange line: 4px off a control, on a region\'s edge inside it', () => {
    expect(css).toMatch(/--focus-ring:\s*1px solid var\(--orange\);/);
    expect(css).toMatch(/--focus-ring-offset:\s*4px;/);
    expect(control.body).toMatch(/outline:\s*var\(--focus-ring\);\s*outline-offset:\s*var\(--focus-ring-offset\);/);
    expect(region.body).toMatch(/outline:\s*var\(--focus-ring\);\s*outline-offset:\s*-1px;/);
    // An object's surface, a list's and a drawing's scroll draw it over
    // what lies on their edges, on the box that holds them still.
    expect(over.body).toMatch(/position:\s*absolute;[\s\S]*inset:\s*0;[\s\S]*border:\s*var\(--focus-ring\);/);
    expect(over.selectors).toEqual([
      '.focusable-content:focus-visible::after',
      '.list-viewport__port:has(> .list-viewport__scroll:focus-visible)::after',
      '.drawing-viewport__view:has(> .drawing-viewport__scroll:focus-visible)::after',
    ]);
    for (const box of ['.focusable-content', '.list-viewport__port', '.drawing-viewport__view']) expect(ruleNaming(box).body, box).toMatch(/position:\s*relative;/);
  });

  it('is drawn by every button the page draws, RETURN / ESC and both HISTORY buttons among them', () => {
    const { classes, tags, where } = tagged(/<button\b(?:=>|[^>])*>/gs);
    expect(where).toEqual([]);
    expect(classes).toHaveLength(tags);
    expect(classes).toEqual(expect.arrayContaining(['focus-layer__return', 'transcript__return', 'transcript__send', 'annotation-card__history', 'live-chat-card__history', 'rail-handle', 'damocles-presence__button', 'transcript-toggle']));
    expect(classes.filter((name) => !control.selectors.includes(`.${name}:focus-visible`))).toEqual([]);
  });

  it('is drawn by every element the page puts in the tab order', () => {
    const { classes, where } = tagged(/<\w+\b(?:=>|[^>])*?\btabIndex=(?:=>|[^>])*>/gs);
    expect(where).toEqual([]);
    const reached = (name: string) => ringed(name) || control.selectors.some((selector) => selector.includes(`.${name}[`) || selector.includes(`.${name}:`));
    expect(classes.sort()).toEqual(['calendar-grid', 'drawing-viewport__scroll', 'focusable-content', 'list-viewport__scroll', 'metric-row']);
    // The paged days carry the grid's class first; the ring names the pages.
    expect(region.selectors).toContain('.calendar-pages:focus-visible');
    expect(classes.filter((name) => name !== 'calendar-grid' && !reached(name))).toEqual([]);
  });

  it('is drawn by every box that scrolls: Chrome puts a scroll with nothing to focus inside it in the tab order', () => {
    const scrolling = new Set(
      rules()
        .filter((rule) => /overflow(?:-x|-y)?:\s*(?:auto|scroll)/.test(rule.body))
        .flatMap((rule) => rule.selectors.map((selector) => selector.split(' ').pop()!))
        .filter((selector) => !['.controller-panel', '.ir-drawer'].includes(selector))
        // A source, a document's body and a table's rows scroll in a
        // ListViewport, whose scroll also carries `list-viewport__scroll`.
        .filter((selector) => !LIST_SCROLLS.some((name) => selector === `.${name}`)),
    );
    for (const name of LIST_SCROLLS) expect(sources.some(({ text }) => text.includes(`scrollClassName="${name}"`)), name).toBe(true);
    expect(scrolling.size).toBeGreaterThan(8);
    expect([...scrolling].filter((selector) => !ringed(selector.slice(1)))).toEqual([]);
  });

  it('is never taken away: no rule draws no outline on a focused control but for a region drawn over', () => {
    const removed = rules()
      .filter((rule) => /outline:\s*(?:none|0)\b/.test(rule.body))
      .flatMap((rule) => rule.selectors)
      .filter((selector) => /:focus/.test(selector));
    expect(removed).toEqual(['.focusable-content:focus-visible', '.list-viewport__scroll:focus-visible', '.drawing-viewport__scroll:focus-visible']);
    expect(removed.every((selector) => drawnOver(selector.slice(1, -':focus-visible'.length)))).toBe(true);
  });
});

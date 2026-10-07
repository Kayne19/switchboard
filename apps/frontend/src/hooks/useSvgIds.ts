import { useId } from 'react';

// One id scheme for every SVG the page draws. An id is global to the
// document, and a drawing is often on the page twice (an aux copy, the
// focus copy, a pinned header), so a fixed id -- `diagram-arrow-paper`,
// `active-edge-glow` -- repeated, and `url(#id)` resolves to the first copy:
// hide that one with `display: none` and the other loses its arrowheads and
// glows. Each drawing names its parts under an id of its own (`useId`), and
// a part named for data (a note's key) is escaped one-to-one, so `obs.1`
// and `obs_1` stay two ids, as two leaders' gradients must.

/** A part's name as id text: letters, digits and `-` as they are; any other UTF-16 unit as `_<hex>_`. */
export function svgIdPart(part: string | number): string {
  return String(part).replace(/[^A-Za-z0-9-]/g, (unit) => `_${unit.charCodeAt(0).toString(16)}_`);
}

/** Names the parts of one drawing: `ids('arrow', semantic)` is that drawing's own arrow marker for `semantic`. */
export function useSvgIds(): (...parts: Array<string | number>) => string {
  // React's ids are unique on the page and wrapped in delimiters (`«r1»`)
  // that are not id text; what is left is still unique.
  const base = useId().replace(/[^A-Za-z0-9]/g, '');
  return (...parts) => [base, ...parts.map(svgIdPart)].join('-');
}

/** `url(#id)`, for a `filter`, `clip-path`, `fill`, `stroke` or `marker-*` attribute. */
export function svgUrl(id: string): string {
  return `url(#${id})`;
}

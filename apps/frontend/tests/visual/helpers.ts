import { expect, type Page } from '@playwright/test';

// What the browser specs share, written once: the geometries the goldens are
// drawn at, opening a fixture scene, running actions through the page's
// controller, and what crosses a frame. Each spec keeps its own waits.

/** The four geometries the goldens are drawn at (visual.spec.ts). */
export const GEOMETRIES = [
  { name: 'portrait-phone', width: 390, height: 844 },
  { name: 'portrait-tablet', width: 820, height: 1180 },
  { name: 'landscape', width: 1440, height: 900 },
  { name: 'ultrawide', width: 2560, height: 1080 },
] as const;

/** Every geometry the visual suites use: the goldens', and two short landscapes. */
export const FRAME_GEOMETRIES = [
  ...GEOMETRIES,
  { name: 'landscape-short', width: 844, height: 390 },
  { name: 'landscape-hd', width: 1280, height: 720 },
] as const;

/** Opens a canonical fixture scene without the page chrome, and waits for the stage. */
export async function openScene(page: Page, scene: string): Promise<void> {
  await page.goto(`/?scene=${scene}&chrome=0`);
  await expect(page.locator('.stage')).toBeVisible();
}

/** Runs actions through the page's controller, in order, as an agent's display calls arrive. */
export async function runActions(page: Page, actions: unknown[]): Promise<void> {
  await page.evaluate((list) => {
    const controller = window.SwitchboardController;
    if (!controller) throw new Error('controller unavailable');
    controller.run(list);
  }, actions);
}

/**
 * Every drawn part inside an object (each match of `selector`) that crosses
 * the frame it stands in, as `role class side +px` (role: primary, aux or
 * focus). The frame is the TechFrame over the object's slot (or the
 * object's own, for a table, source or document), read from its own paths
 * as drawn; focus has no frame, so it is the focus box. A part crosses an
 * edge where it reaches past that edge of the frame over its own span: the
 * panel's lower edge steps up at its left, so a row across the slot must
 * stand above the step, and a word at its right need not. A part is what
 * shows of it, clipped by every box that clips it on the way up; it counts
 * when it draws something (text, a border, a fill or a shadow, an image, an
 * SVG shape), not when it is only a box around other parts (an SVG's own
 * margin, a padding). A box clipped to the frame's outline (the code
 * frame's mask, a child of the viewport the frame is drawn in) is the
 * frame's own inside, not a part. The frame's runs are checked where they
 * are drawn: a part that lies wholly in a gap of an interrupted rail is not
 * held by that side. A part may reach a
 * pixel past an edge: a text's box holds its font's descent below the
 * letters, and a layout rounds to the pixel (a chart's axis title in focus
 * stands 0.6 to 0.9 px past the focus box, its letters clear of it).
 */
export function frameCrossings(selector: string): string[] {
  type Run = { x1: number; y1: number; x2: number; y2: number };
  type Edge = Run & { side: 'top' | 'bottom' | 'left' | 'right' };
  // The frame's outline as straight runs, in its viewBox units.
  const runs = (d: string): Run[] => {
    const found: Run[] = [];
    let [x, y] = [0, 0];
    for (const [, op, args] of d.matchAll(/([MLHV])([^MLHV]*)/g)) {
      const n = args.trim().split(/\s+/).map(Number);
      const [nx, ny] = op === 'H' ? [n[0], y] : op === 'V' ? [x, n[0]] : [n[0], n[1]];
      if (op !== 'M') found.push({ x1: x, y1: y, x2: nx, y2: ny });
      [x, y] = [nx, ny];
    }
    return found;
  };
  // Where a run lies over [from, to] of the axis it runs along (a1 -> a2): its least and most offset (b) there.
  const over = (a1: number, b1: number, a2: number, b2: number, from: number, to: number): [number, number] | null => {
    const lo = Math.max(Math.min(a1, a2), from);
    const hi = Math.min(Math.max(a1, a2), to);
    if (hi < lo) return null;
    const at = (a: number) => (a1 === a2 ? b1 : b1 + ((b2 - b1) * (a - a1)) / (a2 - a1));
    return [Math.min(at(lo), at(hi)), Math.max(at(lo), at(hi))];
  };
  const alpha = (color: string) => {
    const values = color.match(/rgba?\(([^)]*)\)/)?.[1].split(/[ ,/]+/).filter(Boolean) ?? [];
    return values.length === 0 ? 0 : values.length > 3 ? parseFloat(values[3]) : 1;
  };
  const drawn = (part: Element) => {
    const style = getComputedStyle(part);
    if (part instanceof SVGElement) {
      return ['path', 'line', 'rect', 'circle', 'ellipse', 'polyline', 'polygon', 'text', 'image', 'use'].includes(part.tagName) && !(style.fill === 'none' && style.stroke === 'none');
    }
    if (['IMG', 'CANVAS', 'VIDEO'].includes(part.tagName)) return true;
    if ([...part.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim())) return true;
    if (alpha(style.backgroundColor) > 0 || style.backgroundImage !== 'none' || style.boxShadow !== 'none') return true;
    return (['Top', 'Right', 'Bottom', 'Left'] as const).some(
      (side) => parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== 'none' && alpha(style[`border${side}Color`]) > 0,
    );
  };
  const hits: string[] = [];
  for (const object of document.querySelectorAll<HTMLElement>(selector)) {
    let owner: HTMLElement | null = object;
    let frame: SVGSVGElement | null = null;
    while (owner && !owner.classList.contains('focus-layer__content') && !(frame = owner.querySelector<SVGSVGElement>(':scope > svg.tech-frame'))) owner = owner.parentElement;
    if (!owner) continue;
    let edges: Edge[];
    if (frame) {
      const box = frame.getBoundingClientRect();
      const view = frame.viewBox.baseVal;
      const [sx, sy] = [box.width / view.width, box.height / view.height];
      edges = [...frame.querySelectorAll('path')].flatMap((path) => runs(path.getAttribute('d') ?? '')).map((run) => ({
        x1: box.left + sx * run.x1,
        y1: box.top + sy * run.y1,
        x2: box.left + sx * run.x2,
        y2: box.top + sy * run.y2,
        side: run.x1 === run.x2 ? (run.x1 < view.width / 2 ? 'left' : 'right') : (run.y1 + run.y2) / 2 < view.height / 2 ? 'top' : 'bottom',
      }));
    } else {
      const box = owner.getBoundingClientRect();
      const top = box.top + parseFloat(getComputedStyle(owner).borderTopWidth);
      edges = [
        { side: 'top', x1: box.left, y1: top, x2: box.right, y2: top },
        { side: 'bottom', x1: box.left, y1: box.bottom, x2: box.right, y2: box.bottom },
        { side: 'left', x1: box.left, y1: top, x2: box.left, y2: box.bottom },
        { side: 'right', x1: box.right, y1: top, x2: box.right, y2: box.bottom },
      ];
    }
    const role = object.closest('.focus-layer') ? 'focus' : object.closest('.composed-aux-object') ? 'aux' : 'primary';
    const worst = new Map<string, number>();
    for (const part of [object, ...object.querySelectorAll('*')]) {
      if (part === owner || part.closest('svg.tech-frame') || part.getClientRects().length === 0) continue;
      const style = getComputedStyle(part);
      // The code frame's mask (clipped to the outline) is the frame's own inside; any other clipped part is checked.
      if (style.visibility === 'hidden' || (part.parentElement === owner && style.clipPath !== 'none') || !drawn(part)) continue;
      const rect = part.getBoundingClientRect();
      const shown = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      for (let clip = part.parentElement; clip && clip !== owner.parentElement; clip = clip.parentElement) {
        const clipStyle = getComputedStyle(clip);
        const clipBox = clip.getBoundingClientRect();
        if (clipStyle.overflowX !== 'visible') [shown.left, shown.right] = [Math.max(shown.left, clipBox.left), Math.min(shown.right, clipBox.right)];
        if (clipStyle.overflowY !== 'visible') [shown.top, shown.bottom] = [Math.max(shown.top, clipBox.top), Math.min(shown.bottom, clipBox.bottom)];
      }
      if (shown.right - shown.left < 0.5 || shown.bottom - shown.top < 0.5) continue;
      for (const edge of edges) {
        const across = edge.side === 'top' || edge.side === 'bottom';
        const span = across ? over(edge.x1, edge.y1, edge.x2, edge.y2, shown.left, shown.right) : over(edge.y1, edge.x1, edge.y2, edge.x2, shown.top, shown.bottom);
        if (!span) continue;
        const by = { top: span[1] - shown.top, bottom: shown.bottom - span[0], left: span[1] - shown.left, right: shown.right - span[0] }[edge.side];
        const name = `${role} ${String(part.getAttribute('class') ?? '').split(' ')[0] || part.tagName} ${edge.side}`;
        if (by > 1 && by > (worst.get(name) ?? 0)) worst.set(name, by);
      }
    }
    for (const [name, by] of worst) hits.push(`${name} +${by.toFixed(1)}px`);
  }
  return hits;
}

/**
 * What is wrong with the focus ring the focused control draws, or nothing
 * (DESIGN_SYSTEM.md, "Focus ring"): run in the page with a control focused
 * from the keyboard. Its ring is the page's (one 1px orange line: its
 * outline, or for an object's surface the line its ::after draws over its
 * box), not the browser's; and no box above it that clips (an overflow, a
 * clip path) cuts it. A side counts only where the control itself fits the
 * clipping box that way: a control longer than the scroll it stands in is
 * cut with it, ring and all, and reached by scrolling.
 */
export function focusRingFault(): string | null {
  const control = document.activeElement as HTMLElement | null;
  if (!control || control === document.body) return null;
  const name = `${control.tagName.toLowerCase()}.${String(control.getAttribute('class') ?? '').split(' ').filter(Boolean).slice(0, 2).join('.')}`;
  const style = getComputedStyle(control);
  const orange = 'rgb(241, 90, 36)';
  // A region drawn over carries the ring on its own ::after (a surface) or
  // on the one of the box it scrolls in (a list's port, a drawing's view).
  const over = (host: Element | null) => {
    if (!host) return false;
    const after = getComputedStyle(host, '::after');
    return after.position === 'absolute' && after.borderTopStyle === 'solid' && after.borderTopWidth === '1px' && after.borderTopColor === orange;
  };
  let reach: number | null = null;
  let ringed: Element = control;
  // A text field shows focus by its caret and its field's border.
  if (control.matches('input, textarea')) {
    const field = control.parentElement!;
    const border = getComputedStyle(field).borderTopColor;
    return border.startsWith('rgba(241, 90, 36') || border === orange ? null : `${name}: its field's border is not lit (${border})`;
  }
  if (style.outlineStyle === 'solid' && style.outlineWidth === '1px' && style.outlineColor === orange) reach = parseFloat(style.outlineOffset) + 1;
  else if (style.outlineStyle === 'none' && over(control)) reach = 0;
  else if (style.outlineStyle === 'none' && over(control.parentElement)) [reach, ringed] = [0, control.parentElement!];
  if (reach === null) return `${name}: not the page's ring (outline ${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor})`;
  const box = ringed.getBoundingClientRect();
  const ring = { left: box.left - reach, top: box.top - reach, right: box.right + reach, bottom: box.bottom + reach };
  const cuts: string[] = [];
  for (let clip = ringed.parentElement; clip && clip !== document.documentElement; clip = clip.parentElement) {
    const clipStyle = getComputedStyle(clip);
    const clipBox = clip.getBoundingClientRect();
    let shown: { left: number; top: number; right: number; bottom: number } | null = null;
    if (clipStyle.overflowX !== 'visible' || clipStyle.overflowY !== 'visible') {
      const left = clipBox.left + parseFloat(clipStyle.borderLeftWidth);
      const top = clipBox.top + parseFloat(clipStyle.borderTopWidth);
      shown = { left, top, right: left + clip.clientWidth, bottom: top + clip.clientHeight };
    } else if (clipStyle.clipPath !== 'none') {
      shown = { left: clipBox.left, top: clipBox.top, right: clipBox.right, bottom: clipBox.bottom };
    }
    if (!shown) continue;
    // A scroll stops at a whole pixel, so a control it brings into view
    // may stand a fraction of one past its edge: a pixel is allowed.
    const fitsAcross = box.width <= shown.right - shown.left + 1;
    const fitsDown = box.height <= shown.bottom - shown.top + 1;
    const sides = [
      fitsAcross && ring.left < shown.left - 1 ? 'left' : '',
      fitsDown && ring.top < shown.top - 1 ? 'top' : '',
      fitsAcross && ring.right > shown.right + 1 ? 'right' : '',
      fitsDown && ring.bottom > shown.bottom + 1 ? 'bottom' : '',
    ].filter(Boolean);
    if (sides.length) cuts.push(`${String(clip.getAttribute('class') ?? clip.tagName).split(' ')[0]} cuts its ${sides.join(', ')}`);
  }
  return cuts.length ? `${name}: ${cuts.join('; ')}` : null;
}

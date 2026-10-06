// Measures what layout gives: an element watched as it is resized or
// changed, and how much a box in a shared-layout animation is drawn scaled.

/**
 * Measures an element whenever it is resized, and, as asked, whenever one
 * of its children is or what it holds changes. Returns the disconnect.
 */
export function watchElement(element: Element, measure: () => void, { children = false, changes = false }: { children?: boolean; changes?: boolean } = {}): () => void {
  const resized = new ResizeObserver(() => measure());
  const watch = () => {
    resized.disconnect();
    resized.observe(element);
    if (children) for (const child of Array.from(element.children)) resized.observe(child);
    measure();
  };
  const changed = changes || children ? new MutationObserver(watch) : null;
  changed?.observe(element, { childList: true, subtree: changes, characterData: changes });
  watch();
  return () => {
    resized.disconnect();
    changed?.disconnect();
  };
}

/**
 * How much a box is drawn scaled on screen: a shared-layout animation (focus
 * opening) scales the box it moves, and its rects with it, while its layout
 * sizes (clientHeight, offsetHeight) stay as laid out. Measures from the two
 * are brought to one scale by it.
 */
export function drawnScale(rectHeight: number, offsetHeight: number): number {
  return offsetHeight > 0 && rectHeight > 0 ? rectHeight / offsetHeight : 1;
}

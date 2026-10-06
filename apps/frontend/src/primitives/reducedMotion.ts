/** Whether the reader asks for reduced motion, read when it matters (a
 * scroll about to glide); what renders by it takes motion's `useReducedMotion`. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

import type { Slot } from './slot';

// The one rule for an object's title on its own meta line (the line a
// table, a calendar, a to-do list or an inbox heads itself with): the
// object names itself there only where nothing else on screen does. In the
// main slot (`primary`) the scene frame above it already shows the title,
// so the meta line says only what the object holds; in an aux cell or in
// focus no frame names it, so the meta line leads with the title, marked
// `data-object-title` (sceneComposition.test.tsx counts on it). Every
// title is inked alike (`.meta-line__title`), as every meta line is
// (`.meta-line`).

export function MetaTitle({ title, slot, className }: { title: string; slot: Slot; className?: string }) {
  return slot === 'primary' ? null : (
    <span className={`meta-line__title${className ? ` ${className}` : ''}`} data-object-title>
      {title}
    </span>
  );
}

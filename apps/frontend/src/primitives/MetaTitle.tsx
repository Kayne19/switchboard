// The one rule for an object's title on its own meta line (the line a
// table, a calendar, a to-do list or an inbox heads itself with): the
// object names itself there only where nothing else on screen does. In the
// main slot the scene frame above it already shows the title, so the meta
// line says only what the object holds (`framed`); in an aux cell or in
// focus no frame names it, so the meta line leads with the title, marked
// `data-object-title` (sceneComposition.test.tsx counts on it).

export function MetaTitle({ title, framed = false, className }: { title: string; framed?: boolean; className?: string }) {
  return framed ? null : (
    <span className={className} data-object-title>
      {title}
    </span>
  );
}

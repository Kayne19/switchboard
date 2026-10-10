import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

interface FocusableSurfaceProps {
  children: ReactNode;
  onActivate: () => void;
  /** The name of the surface's own button, which opens the object in focus: "Expand table". */
  ariaLabel: string;
  className?: string;
}

// An object's surface: a tap on anything it holds opens the object in focus,
// and so does its own button, the one tab stop the surface adds. The surface
// is not itself a button (#269): ARIA makes a button's children
// presentational, so a list's, a document's or a drawing's scroll inside it
// was a region of a button, and a screen reader could read the whole object
// as one button. The button is beside what the surface holds, not round it;
// it is drawn as the page's focus ring over the surface, and nothing else.
// It carries tabIndex={0}, as the surface did: Safari, by default, leaves a
// button without one out of the Tab order (only "Press Tab to highlight
// each item" or Option-Tab reach it), so without it a keyboard in Safari
// could no longer reach the object it could reach before.
//
// One rule for a control inside the surface (a rail's count or the map of a
// scrolled drawing, its scroller's keys, a metric in a cluster): the child
// that acts on a click or a key marks it handled with preventDefault() and
// lets it bubble, and the surface leaves a handled event alone. A child
// never stops the event instead: the page hears every click at the document
// as the gesture that unlocks audio (callRuntime), and a stopped click
// would be a tap the page never heard. Enter or Space in a scroll it holds
// opens the object as a tap would, unless the scroll took the key.
export function FocusableSurface({ children, onActivate, ariaLabel, className }: FocusableSurfaceProps) {
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    onActivate();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A key on a button is the button's: Enter and Space click it, the
    // surface's own button among them, and a key held here would cancel
    // that click.
    if (event.target instanceof HTMLButtonElement) return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onActivate();
  };

  return (
    <div className={`focusable-content${className ? ` ${className}` : ''}`} onClick={handleClick} onKeyDown={handleKeyDown}>
      <button className="focusable-content__expand" type="button" tabIndex={0} aria-label={ariaLabel} />
      {children}
    </div>
  );
}

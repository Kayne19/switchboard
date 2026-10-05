import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

interface FocusableSurfaceProps {
  children: ReactNode;
  onActivate: () => void;
  ariaLabel: string;
  className?: string;
}

// One rule for a control inside the surface (a rail's count or the map of a
// scrolled drawing, its scroller's keys, a metric in a cluster): the child
// that acts on a click or a key marks it handled with preventDefault() and
// lets it bubble, and the surface leaves a handled event alone. A child
// never stops the event instead: the page hears every click at the document
// as the gesture that unlocks audio (callRuntime), and a stopped click
// would be a tap the page never heard.
export function FocusableSurface({ children, onActivate, ariaLabel, className }: FocusableSurfaceProps) {
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    onActivate();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onActivate();
  };

  return (
    <div
      className={`focusable-content${className ? ` ${className}` : ''}`}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
}

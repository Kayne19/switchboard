import type { KeyboardEvent, ReactNode } from 'react';

interface FocusableSurfaceProps {
  children: ReactNode;
  onActivate: () => void;
  ariaLabel: string;
  className?: string;
}

export function FocusableSurface({ children, onActivate, ariaLabel, className }: FocusableSurfaceProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
      onClick={onActivate}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
}

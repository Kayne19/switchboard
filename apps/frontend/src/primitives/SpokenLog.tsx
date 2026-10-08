import type { MessageData } from '../controller/types';
import { usePinnedScroll } from '../hooks/usePinnedScroll';
import { RichText } from './RichText';

interface SpokenLogProps {
  message: MessageData;
  /** The scrolling element's class: the card's own text area. */
  className: string;
  /** A wrapper inside the scroller, where the card lays its text out. */
  innerClassName?: string;
}

/**
 * The live response's text: the recent sections the caller heard as a log,
 * the newest resting at the top of the box with blank space below it, and
 * the earlier ones above it to scroll back to (#113, #178). It is the card's
 * own text area, not a second card. A message without lines shows its
 * segments as before, read from the top.
 */
export function SpokenLog({ message, className, innerClassName }: SpokenLogProps) {
  const lines = message.lines ?? [];
  const isLog = lines.length > 0;
  const { ref, onScroll } = usePinnedScroll<HTMLDivElement>(isLog ? lines : message.segments, isLog);
  const body = isLog ? (
    <div className="spoken-log" role="log" aria-label="What was said">
      {lines.map((line, index) => {
        const current = index === lines.length - 1;
        return (
          <div
            key={line.id}
            className={`spoken-log__line${current ? ' spoken-log__line--current' : ''}`}
            aria-current={current ? 'true' : undefined}
          >
            <RichText segments={[{ text: line.text }]} />
          </div>
        );
      })}
    </div>
  ) : (
    <RichText segments={message.segments} />
  );
  return (
    <div
      className={isLog ? `${className} spoken-log-box` : className}
      ref={ref}
      onScroll={onScroll}
      data-testid="spoken-log"
    >
      {innerClassName ? <div className={innerClassName}>{body}</div> : body}
      {/* The blank space under the newest section, a box tall, that lets it
          rest at the top of the box (#178). It is not log content. */}
      {isLog ? <div className="spoken-log__space" aria-hidden="true" /> : null}
    </div>
  );
}

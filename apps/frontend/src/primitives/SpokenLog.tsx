import type { MessageData } from '../controller/types';
import { usePinnedScroll } from '../hooks/usePinnedScroll';
import { RichText } from './RichText';
import { ScrollRim } from './ScrollRim';
import { useScrollEdges } from './useScrollEdges';

interface SpokenLogProps {
  message: MessageData;
  /** The scrolling element's class: the card's own text area. */
  className: string;
  /** A wrapper inside the scroller, where the card lays its text out. */
  innerClassName?: string;
  /**
   * Fade the edges the text continues past (ScrollRim), drawn beside the
   * scroller in its parent, which positions them: a card whose text box
   * clips it, so a line cut there reads as more to come.
   */
  edges?: boolean;
}

/**
 * The live response's text: the recent lines the caller heard as a log,
 * newest at the bottom and pinned there, with earlier lines above it to
 * scroll back to (#113). It is the card's own text area, not a second card.
 * A message without lines shows its segments as before, read from the top.
 */
export function SpokenLog({ message, className, innerClassName, edges = false }: SpokenLogProps) {
  const lines = message.lines ?? [];
  const isLog = lines.length > 0;
  const { ref, onScroll } = usePinnedScroll<HTMLDivElement>(isLog ? lines : message.segments, isLog);
  const cut = useScrollEdges(ref, edges);
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
    <>
      <div className={className} ref={ref} onScroll={onScroll} data-testid="spoken-log">
        {innerClassName ? <div className={innerClassName}>{body}</div> : body}
      </div>
      {cut.above ? <ScrollRim side="top" fade={cut.fade} /> : null}
      {cut.below ? <ScrollRim side="bottom" fade={cut.fade} /> : null}
    </>
  );
}

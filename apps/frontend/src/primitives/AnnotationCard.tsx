import type { NoteData } from '../controller/types';
import { FocusableSurface } from './FocusableSurface';
import { NoteBadge } from './NoteMarker';
import { RichText } from './RichText';

/** What a card says its note is about (`noteTarget`, app/noteItems.ts), and whether it carries the NOTE badge. */
export interface NoteTarget {
  /** The TARGET line's words; none for a note about no object on stage, or about none at all. */
  target?: string;
  /** What it names is marked where its object is drawn (a node, an actor, an item), so the card carries the badge that matches the mark and gives the line one of its own. */
  marked: boolean;
}

interface AnnotationCardProps {
  data: NoteData;
  /** Expands the note object this card shows through the shared focus layer. */
  onFocus?: () => void;
  /** Opens the conversation history drawer. Given only when there is a conversation to open. */
  onOpenHistory?: () => void;
  /**
   * What its TARGET line names, in the words of the object the note is
   * about, and whether that object marks it (`noteTarget`,
   * app/noteItems.ts). Every card is given one, so none shows an id: a
   * card with no target, a note about nothing on stage, has no TARGET
   * line. A marked part (a node, an actor, an item) gives the card the
   * badge that matches the mark, and a line of its own for what it names
   * rather than cut it beside the tag.
   */
  named: NoteTarget;
}

// The card is not itself a control: its text is a scroll region, and a scroll
// region cannot live inside a button. The body activates through
// FocusableSurface instead, and the history control sits beside it in the
// header rather than inside it.
export function AnnotationCard({ data, onFocus, onOpenHistory, named }: AnnotationCardProps) {
  const text = <div className="annotation-card__text"><RichText segments={data.segments} /></div>;
  // A note object on stage expands; a spoken explanation has no object to
  // expand, so its body opens the conversation it came from.
  const activate = onFocus ?? onOpenHistory;
  return (
    <div className={`annotation-card${named.marked ? ' annotation-card--item' : ''}`} data-anchor-target={data.anchor?.target}>
      <div className="annotation-card__header">
        <span className="annotation-card__tag tech micro">{data.tag ?? 'DAMOCLES / EXPLANATION'}</span>
        {named.target !== undefined ? <span className="annotation-card__anchor tech micro">{`TARGET / ${named.target}`}</span> : null}
        {/* The badge that matches the marker on the part it names (a node,
            an actor, or an item marked where its object is drawn) sits
            beside the anchor text, not inside it: the anchor text
            ellipsizes in a narrow rail and would clip the badge with it. */}
        {named.marked ? <NoteBadge /> : null}
        {onOpenHistory ? (
          <button type="button" className="annotation-card__history tech micro" onClick={onOpenHistory} aria-label="Open conversation history">
            HISTORY
          </button>
        ) : null}
      </div>
      {activate ? (
        <FocusableSurface
          className={`annotation-card__body${onFocus ? '' : ' annotation-card__body--history'}`}
          onActivate={activate}
          ariaLabel={onFocus ? 'Expand explanation' : 'Open conversation history'}
        >
          {text}
        </FocusableSurface>
      ) : (
        <div className="annotation-card__body">{text}</div>
      )}
    </div>
  );
}

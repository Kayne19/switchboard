import type { NoteData } from '../controller/types';
import { FocusableSurface } from './FocusableSurface';
import { RichText } from './RichText';

interface AnnotationCardProps {
  data: NoteData;
  /** Expands the note object this card shows through the shared focus layer. */
  onFocus?: () => void;
  /** Opens the conversation history drawer. Given only when there is a conversation to open. */
  onOpenHistory?: () => void;
}

// The card is not itself a control: its text is a scroll region, and a scroll
// region cannot live inside a button. The body activates through
// FocusableSurface instead, and the history control sits beside it in the
// header rather than inside it.
export function AnnotationCard({ data, onFocus, onOpenHistory }: AnnotationCardProps) {
  const text = <div className="annotation-card__text"><RichText segments={data.segments} /></div>;
  // A note object on stage expands; a spoken explanation has no object to
  // expand, so its body opens the conversation it came from.
  const activate = onFocus ?? onOpenHistory;
  return (
    <div className="annotation-card" data-anchor-target={data.anchor?.target}>
      <div className="annotation-card__header">
        <span className="annotation-card__tag tech micro">{data.tag ?? 'DAMOCLES / EXPLANATION'}</span>
        {data.anchor ? (
          <span className="annotation-card__anchor tech micro">
            TARGET / {data.anchor.target}
            {data.anchor.node ? ` / NODE ${data.anchor.node}` : ''}
            {data.anchor.x !== undefined ? ` / X ${data.anchor.x}` : ''}
            {data.anchor.series ? ` / ${data.anchor.series}` : ''}
          </span>
        ) : null}
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

import type { NoteData } from '../controller/types';
import { FocusableSurface } from './FocusableSurface';
import { RichText } from './RichText';

interface AnnotationCardProps {
  data: NoteData;
  /** Expands the note object this card shows through the shared focus layer. */
  onFocus?: () => void;
}

// The card is not itself a control: its text is a scroll region, and a scroll
// region cannot live inside a button. The body activates through
// FocusableSurface instead.
export function AnnotationCard({ data, onFocus }: AnnotationCardProps) {
  const text = <div className="annotation-card__text"><RichText segments={data.segments} /></div>;
  return (
    <div className="annotation-card">
      <div className="annotation-card__header">
        <span className="annotation-card__tag tech micro">{data.tag ?? 'DAMOCLES / EXPLANATION'}</span>
      </div>
      {onFocus ? (
        <FocusableSurface className="annotation-card__body" onActivate={onFocus} ariaLabel="Expand explanation">
          {text}
        </FocusableSurface>
      ) : (
        <div className="annotation-card__body">{text}</div>
      )}
    </div>
  );
}

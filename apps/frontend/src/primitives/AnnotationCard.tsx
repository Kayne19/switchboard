import { motion } from 'motion/react';
import type { NoteData } from '../controller/types';
import { RichText } from './RichText';
export function AnnotationCard({ data, onFocus }: { data: NoteData; onFocus?: () => void }) {
  const body = <><div className="annotation-card__tag tech micro">{data.tag ?? 'DAMOCLES / EXPLANATION'}</div><div className="annotation-card__text"><RichText segments={data.segments}/></div></>;
  return onFocus ? <motion.button type="button" className="annotation-card annotation-card--button" onClick={onFocus} whileHover={{ x: 1 }} aria-label="Expand explanation">{body}</motion.button> : <div className="annotation-card">{body}</div>;
}

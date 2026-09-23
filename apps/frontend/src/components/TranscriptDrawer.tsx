import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import type { MessageData } from '../controller/types';
import { RichText } from '../primitives/RichText';

type TranscriptLine = NonNullable<MessageData['transcript']>[number];

interface TranscriptDrawerProps {
  open: boolean;
  lines: TranscriptLine[];
  onClose: () => void;
}

// The conversation history, opened over whichever scene is showing: from the
// conversation scene's transcript toggle or from an explanation card beside
// content. It belongs to the stage rather than to one scene so that opening it
// never swaps the scene underneath.
export function TranscriptDrawer({ open, lines, onClose }: TranscriptDrawerProps) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="transcript"
          role="dialog"
          aria-label="Conversation history"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.24 }}
        >
          <div className="transcript__header tech micro">
            <span>CONVERSATION / HISTORY</span>
            <button type="button" onClick={onClose}>RETURN / ESC</button>
          </div>
          <TranscriptBody lines={lines} />
          <input className="transcript__input" placeholder="TYPE OR SPEAK" aria-label="Conversation input" />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function TranscriptBody({ lines }: { lines: TranscriptLine[] }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // The newest turn is the one the caller opened the history to see.
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [lines.length]);

  return (
    <div className="transcript__body" ref={bodyRef}>
      {lines.map((line, index) => (
        <div className={`transcript-line${line.speaker === 'DAMOCLES' ? ' transcript-line--ai' : ''}`} key={`${index}-${line.speaker}`}>
          <span className="transcript-line__speaker tech micro">{line.speaker}</span>
          <div className="transcript-line__text"><RichText segments={[{ text: line.text }]} /></div>
        </div>
      ))}
    </div>
  );
}

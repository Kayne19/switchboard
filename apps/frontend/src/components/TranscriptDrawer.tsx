import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { MessageData } from '../controller/types';
import { RichText } from '../primitives/RichText';

type TranscriptLine = NonNullable<MessageData['transcript']>[number];

interface TranscriptDrawerProps {
  open: boolean;
  lines: TranscriptLine[];
  onClose: () => void;
  /**
   * Sends a typed turn to the agent on the line and reports whether it went
   * out. Absent when no call runtime is connected to this page.
   */
  onSend?: (text: string) => boolean;
}

// The conversation history, opened over whichever scene is showing: from the
// conversation scene's transcript toggle or from an explanation card beside
// content. It belongs to the stage rather than to one scene so that opening it
// never swaps the scene underneath.
export function TranscriptDrawer({ open, lines, onClose, onSend }: TranscriptDrawerProps) {
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
          <TranscriptComposer onSend={onSend} />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function TranscriptBody({ lines }: { lines: TranscriptLine[] }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // The newest turn is the one the caller opened the history to see, and a
  // typed turn arrives here as the server's echo of it.
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

// The draft stays in the field until the runtime has put it on the socket, so
// a turn typed while the line is down is not lost; the transcript shows it
// once the server echoes it back.
function TranscriptComposer({ onSend }: { onSend?: (text: string) => boolean }) {
  const [draft, setDraft] = useState('');
  const [notSent, setNotSent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Opening the history is how a caller who will not speak reaches the line,
  // so the field takes focus as the drawer mounts and they can type at once.
  // It runs in the commit of the opening click, still inside that gesture,
  // which is when a touch keyboard is allowed to come up. A field disabled
  // for a line with no runtime cannot take focus and is left alone. It keys
  // on the field turning live, not on `onSend` itself: the runtime registers
  // a fresh `sendText` on every connection or recording change, and each of
  // those must not pull focus back from wherever the caller has moved it.
  const live = Boolean(onSend);
  useLayoutEffect(() => {
    if (live) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [live]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onSend || !draft.trim()) return;
    if (onSend(draft)) {
      setDraft('');
      setNotSent(false);
    } else {
      setNotSent(true);
    }
  };

  return (
    <form className="transcript__composer" onSubmit={submit}>
      <input
        ref={inputRef}
        className="transcript__input"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setNotSent(false);
        }}
        placeholder={onSend ? 'TYPE OR SPEAK' : 'LINE OFFLINE'}
        aria-label="Conversation input"
        autoComplete="off"
        enterKeyHint="send"
        disabled={!onSend}
      />
      <button className="transcript__send tech micro" type="submit" disabled={!onSend || !draft.trim()}>
        SEND
      </button>
      {notSent ? (
        <div className="transcript__status tech micro" role="status">
          NOT SENT / LINE DOWN
        </div>
      ) : null}
    </form>
  );
}

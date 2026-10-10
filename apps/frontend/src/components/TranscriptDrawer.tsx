import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState, type FormEvent, type RefObject } from 'react';
import type { MessageData } from '../controller/types';
import { useModalFocus } from '../hooks/useModalFocus';
import { usePinnedScroll } from '../hooks/usePinnedScroll';
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
  /** The focus layer is open over the history: it is inert behind it (`useModalFocus`). */
  behindFocus?: boolean;
}

// The conversation history, opened over whichever scene is showing: from the
// conversation scene's transcript toggle or from an explanation card beside
// content. It belongs to the stage rather than to one scene so that opening it
// never swaps the scene underneath. It covers the scene, and is a modal
// dialog that acts as one (`useModalFocus`, #268): the scene is inert behind
// it (SceneRenderer), focus moves in as it opens -- to the field, so a
// caller who will not speak can type at once, or to RETURN while the line
// is down and the field cannot take it -- and goes back to what opened it.
export function TranscriptDrawer({ open, lines, onClose, onSend, behindFocus = false }: TranscriptDrawerProps) {
  const live = Boolean(onSend);
  const returnButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Opening the history is how a caller who will not speak reaches the
  // line, so focus goes to the field and they can type at once. A field
  // disabled for a line with no runtime cannot take focus: RETURN takes it
  // then. The target follows the line while the history is open: the field
  // takes focus in the commit that makes it live (`useModalFocus`,
  // `retarget`). It follows the line, not `onSend` itself: the runtime
  // registers a fresh `sendText` on every connection or recording change,
  // and each of those must not pull focus from wherever the caller put it.
  useModalFocus(open, '.transcript', live ? input : returnButton);
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="transcript"
          role="dialog"
          aria-modal="true"
          aria-label="Conversation history"
          inert={behindFocus}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.24 }}
        >
          <div className="transcript__header tech micro">
            <span>CONVERSATION / HISTORY</span>
            <button ref={returnButton} className="transcript__return" type="button" onClick={onClose}>RETURN / ESC</button>
          </div>
          <TranscriptBody lines={lines} />
          <TranscriptComposer onSend={onSend} inputRef={input} />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

// A project agent's line is labelled with that agent, so the caller can tell
// who answered. The operator and older lines keep the switchboard's name.
export function transcriptSpeaker(line: TranscriptLine): string {
  if (line.speaker === 'DAMOCLES' && line.agent && line.agent !== 'operator') {
    return line.agent.toUpperCase();
  }
  return line.speaker;
}

function TranscriptBody({ lines }: { lines: TranscriptLine[] }) {
  // The newest turn is the one the caller opened the history to see, and a
  // typed turn arrives here as the server's echo of it: the body follows the
  // newest line as the live log does, and stays where the caller scrolled up
  // to while they reread (#267). It keys on the lines, not on their count,
  // which stops changing once the page's history holds its 200 lines.
  const { ref, onScroll } = usePinnedScroll<HTMLDivElement>(lines);
  const rowKey = useRowKeys();

  return (
    <div className="transcript__body" ref={ref} onScroll={onScroll}>
      {lines.map((line) => (
        <div className={`transcript-line${line.speaker === 'DAMOCLES' ? ' transcript-line--ai' : ''}`} key={rowKey(line)}>
          <span className="transcript-line__speaker tech micro">{transcriptSpeaker(line)}</span>
          <div className="transcript-line__text"><RichText segments={[{ text: line.text }]} allowLinks /></div>
        </div>
      ))}
    </div>
  );
}

// A row's key is its line's: the page's history hands over the same line
// object in each new window of it, so dropping the oldest line keeps every
// other row instead of renumbering, and remounting, all of them (#267).
function useRowKeys(): (line: TranscriptLine) => number {
  const keys = useRef(new WeakMap<TranscriptLine, number>());
  const next = useRef(0);
  return (line) => {
    let key = keys.current.get(line);
    if (key === undefined) {
      key = next.current++;
      keys.current.set(line, key);
    }
    return key;
  };
}

// The draft stays in the field until the runtime has put it on the socket, so
// a turn typed while the line is down is not lost; the transcript shows it
// once the server echoes it back.
function TranscriptComposer({ onSend, inputRef }: { onSend?: (text: string) => boolean; inputRef: RefObject<HTMLInputElement | null> }) {
  const [draft, setDraft] = useState('');
  const [notSent, setNotSent] = useState(false);

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

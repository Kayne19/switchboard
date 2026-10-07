import type { MessageData } from '../controller/types';
import { SpokenLog } from './SpokenLog';

/**
 * The runtime-owned live chat output surface: the recent spoken lines in a
 * small scrolling log beside the active visual, newest at the bottom. It is a separate
 * citizen from the durable notes -- chat updates never mutate a note, and
 * hiding a note never clears the chat.
 */
export function LiveChatCard({ message, onOpenHistory }: { message: MessageData; onOpenHistory?: () => void }) {
  const index = message.caption || `${message.channel?.name ?? 'VOICE'} / LIVE`;
  return (
    <div className="live-chat-card" data-testid="live-chat">
      <div className="live-chat-card__header">
        <span className="live-chat-card__tag tech micro">LIVE / CURRENT RESPONSE</span>
        <span className="live-chat-card__index tech muted">{index}</span>
        {onOpenHistory ? (
          <button className="live-chat-card__history tech micro" type="button" onClick={onOpenHistory} aria-label="Open conversation history">
            HISTORY
          </button>
        ) : null}
      </div>
      <div className="live-chat-card__body">
        <SpokenLog message={message} className="live-chat-card__text" edges />
      </div>
    </div>
  );
}

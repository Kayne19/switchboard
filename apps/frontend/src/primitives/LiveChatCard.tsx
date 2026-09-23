import type { MessageData } from '../controller/types';
import { RichText } from './RichText';

/**
 * The runtime-owned live chat output surface: the current assistant turn in
 * a small scrollable card beside the active visual. It is a separate
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
          <button className="live-chat-card__history tech micro" type="button" onClick={onOpenHistory}>
            HISTORY
          </button>
        ) : null}
      </div>
      <div className="live-chat-card__body">
        <div className="live-chat-card__text">
          <RichText segments={message.segments} />
        </div>
      </div>
    </div>
  );
}

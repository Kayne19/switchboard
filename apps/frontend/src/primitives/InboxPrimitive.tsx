import { useLayoutEffect, useRef, useState } from 'react';
import type { InboxData, InboxMessage } from '../controller/types';
import { parseTimeValue, type TimeValue } from '../controller/validation';
import { useElementSize } from '../hooks/useElementSize';
import { ListViewport } from './ListViewport';
import { NoteBadge } from './NoteMarker';
import { clockText, dayText, daysFrom, readToday } from './timeLabels';

/**
 * Where an inbox is drawn decides how much of each message shows:
 * - `full`: the main slot and focus: the sender, the subject, the snippet
 *   and the channel;
 * - `compact`: a cell beside the primary: the sender and the subject (or
 *   the snippet of a message with none), between thin rules, as the rail's
 *   modules are read.
 */
export type InboxVariant = 'full' | 'compact';

/** How a message's parts are laid out: on one line, or the sender and time
 * over the rest; full or compact. */
export type InboxLayout = 'line' | 'stack' | 'compact-line' | 'compact-stack';

/**
 * The width, in the list's own ems, a message needs to stand on one line:
 * for a full row, the marks, a sender, some forty characters of subject and
 * snippet, the channel and the time; for a compact row, the sender, twenty
 * of subject and the time. Narrower, the sender and the time stand over
 * the rest.
 */
export const ONE_LINE_EMS = { full: 50, compact: 32 } as const;

/** The layout a list `width` px wide, its text `em` px, takes. */
export function inboxLayout(variant: InboxVariant, width: number, em: number): InboxLayout {
  const line = width > 0 && width >= ONE_LINE_EMS[variant] * em;
  if (variant === 'compact') return line ? 'compact-line' : 'compact-stack';
  return line ? 'line' : 'stack';
}

/**
 * When a message came, as the page writes it: a wall time on the inbox's
 * `today` is its time of day; any other time, a date on `today` included,
 * is its day (docs/display-tool.md, "inbox").
 */
export function messageTime(message: InboxMessage, today: TimeValue | null): { text: string; today: boolean } {
  const time = parseTimeValue(message.time);
  if (!time) return { text: message.time, today: false };
  if (today && time.form === 'wall' && daysFrom(today, time) === 0) return { text: clockText(time), today: true };
  return { text: dayText(time, today), today: false };
}

/** What an inbox holds: its messages, unread and flagged. */
export function inboxCounts(data: InboxData): { messages: number; unread: number; flagged: number } {
  return {
    messages: data.messages.length,
    unread: data.messages.filter((message) => message.unread === true).length,
    flagged: data.messages.filter((message) => message.flagged === true).length,
  };
}

// A flag on a pole, in the frame's sharp geometry.
function FlagMark() {
  return (
    <svg className="inbox-row__flag" viewBox="0 0 12 12" role="img" aria-label="flagged">
      <path d="M2.5 11.5 V0.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.2 1 H10.5 L8.4 3.75 L10.5 6.5 H3.2 Z" fill="currentColor" />
    </svg>
  );
}

function MessageRow({ message, today, marked, layout }: { message: InboxMessage; today: TimeValue | null; marked: boolean; layout: InboxLayout }) {
  const time = messageTime(message, today);
  const className = [
    'inbox-row',
    message.unread ? 'inbox-row--unread' : 'inbox-row--read',
    message.flagged ? 'inbox-row--flagged' : '',
    message.semantic ? `inbox-row--tint inbox-row--${message.semantic}` : '',
    marked ? 'inbox-row--marked' : '',
  ].filter(Boolean).join(' ');
  const compact = layout === 'compact-line' || layout === 'compact-stack';
  // The parts stand in the list's columns (a subgrid), so a column of
  // senders, of channels and of times lines up down the list; a part a
  // message lacks keeps its cell, empty.
  return (
    <li className={className} data-item={message.id} data-unread={message.unread ? 'true' : undefined}>
      <span className="inbox-row__unread" role={message.unread ? 'img' : undefined} aria-label={message.unread ? 'unread' : undefined} />
      <span className="inbox-row__from">
        {marked ? <NoteBadge className="inbox-row__note" /> : null}
        <span className="inbox-row__sender">{message.from}</span>
      </span>
      <span className="inbox-row__text">
        {message.subject ? <span className="inbox-row__subject">{message.subject}</span> : null}
        {message.snippet && (!compact || !message.subject) ? <span className="inbox-row__snippet">{message.snippet}</span> : null}
      </span>
      {compact ? null : <span className="inbox-row__channel">{message.channel ? <span className="inbox-row__tag tech micro">{message.channel}</span> : null}</span>}
      <span className="inbox-row__flagged">{message.flagged ? <FlagMark /> : null}</span>
      <span className={`inbox-row__time tech${time.today ? ' inbox-row__time--today' : ''}`}>{time.text}</span>
    </li>
  );
}

/**
 * An inbox: messages in the order the agent sent them, each a row with its
 * sender, subject and a one-line snippet cut cleanly, its channel as a tag
 * and its time (the time of day on `today`, else the day). An unread
 * message is strong and carries the orange mark; a flagged one the flag; a
 * semantic tint runs down its edge. A list that outgrows its slot scrolls
 * inside its frame with the list viewport's counts, and opens on the
 * message a note names (`marked`), which carries the NOTE badge.
 */
export function InboxPrimitive({ data, variant = 'full', marked }: { data: InboxData; variant?: InboxVariant; marked?: string }) {
  const today = readToday(data.today);
  const counts = inboxCounts(data);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(scrollRef);
  const [em, setEm] = useState(16);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element) setEm(parseFloat(getComputedStyle(element).fontSize) || 16);
  }, [width]);
  const layout = inboxLayout(variant, width, em);
  const head = (
    <div className="inbox-primitive__meta tech micro">
      <span className="inbox-primitive__title" data-object-title>{data.title ?? 'INBOX'}</span>
      <span className="inbox-primitive__counts">
        {counts.messages} {counts.messages === 1 ? 'MESSAGE' : 'MESSAGES'}
        {counts.unread > 0 ? <span className="inbox-primitive__unread"> / {counts.unread} UNREAD</span> : null}
        {counts.flagged > 0 ? ` / ${counts.flagged} FLAGGED` : ''}
      </span>
    </div>
  );
  return (
    <div className={`inbox-primitive inbox-primitive--${variant}`} data-testid="inbox" data-layout={layout}>
      <ListViewport
        noun={['MESSAGE', 'MESSAGES']}
        lead={marked}
        head={head}
        scrollClassName="inbox-primitive__scroll"
        scrollRef={scrollRef}
        label={data.title ?? 'Inbox'}
      >
        <ol className={`inbox-primitive__rows inbox-primitive__rows--${layout}`}>
          {data.messages.map((message) => (
            <MessageRow key={message.id} message={message} today={today} marked={message.id === marked} layout={layout} />
          ))}
        </ol>
      </ListViewport>
    </div>
  );
}

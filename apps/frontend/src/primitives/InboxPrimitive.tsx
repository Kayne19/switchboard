import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { InboxData, InboxMessage } from '../controller/types';
import { parseTimeValue, type TimeValue } from '../controller/validation';
import { countText, type Noun } from './countText';
import { ListViewport } from './ListViewport';
import { NoteBadge } from './NoteMarker';
import { dayText, daysFrom, readToday, timeOfDay } from './timeLabels';
import { MetaTitle } from './MetaTitle';
import type { Slot } from './slot';

/**
 * Where an inbox is drawn (its `slot`) decides how much of each message
 * shows, and names the list's class:
 * - `full`: the main slot and focus: the sender, the subject, the snippet
 *   and the channel;
 * - `compact`: a cell beside the primary: the sender and the subject (or
 *   the snippet of a message with none), between thin rules, as the rail's
 *   modules are read.
 */
const READING = { primary: 'full', focus: 'full', aux: 'compact' } as const satisfies Record<Slot, string>;

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

/** The layout a list in `slot`, `width` px wide, its text `em` px, takes. */
export function inboxLayout(slot: Slot, width: number, em: number): InboxLayout {
  const line = width > 0 && width >= ONE_LINE_EMS[READING[slot]] * em;
  if (READING[slot] === 'compact') return line ? 'compact-line' : 'compact-stack';
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
  if (today && time.form === 'wall' && daysFrom(today, time) === 0) return { text: timeOfDay(time), today: true };
  return { text: dayText(time, today), today: false };
}

// What the inbox's counts call a message.
const MESSAGE: Noun = ['MESSAGE', 'MESSAGES'];

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
    message.semantic ? `inbox-row--tint tone--${message.semantic}` : '',
    marked ? 'inbox-row--marked' : '',
  ].filter(Boolean).join(' ');
  const compact = layout === 'compact-line' || layout === 'compact-stack';
  // The parts stand in the list's columns (a subgrid), so a column of
  // senders, of channels and of times lines up down the list; a part a
  // message lacks keeps its cell, empty.
  return (
    <li className={className} data-item={message.id}>
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
 * The width a list's rows have and the size of their text, measured before
 * the page paints (a layout effect), so the first frame is already laid out
 * for the list's width rather than stacked and then redrawn. The box is
 * watched for its size; the rows' scroll is read each time, as a new layout
 * draws a new one.
 */
function useListMeasure(boxRef: RefObject<HTMLDivElement | null>, scrollRef: RefObject<HTMLDivElement | null>): { width: number; em: number } {
  const [measure, setMeasure] = useState({ width: 0, em: 16 });
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    const read = () => {
      const list = scrollRef.current ?? box;
      const next = { width: list.clientWidth, em: parseFloat(getComputedStyle(list).fontSize) || 16 };
      setMeasure((current) => (current.width === next.width && current.em === next.em ? current : next));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(box);
    return () => observer.disconnect();
  }, [boxRef, scrollRef]);
  return measure;
}

/**
 * An inbox: messages in the order the agent sent them, each a row with its
 * sender, subject and a one-line snippet cut cleanly, its channel as a tag
 * and its time (the time of day on `today`, else the day). An unread
 * message is strong and carries the orange mark; a flagged one the flag; a
 * semantic tint runs down its edge. A list that outgrows its slot scrolls
 * inside its frame with the list viewport's counts, and opens on the
 * message a note names (`marked`), which carries the NOTE badge. In the
 * main slot the scene frame above shows the title (MetaTitle).
 */
export function InboxPrimitive({ data, slot = 'primary', marked }: { data: InboxData; slot?: Slot; marked?: string }) {
  const today = readToday(data.today);
  const counts = inboxCounts(data);
  const boxRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { width, em } = useListMeasure(boxRef, scrollRef);
  const layout = inboxLayout(slot, width, em);
  const head = (
    <div className="inbox-primitive__meta meta-line tech micro">
      <MetaTitle title={data.title ?? 'INBOX'} slot={slot} className="inbox-primitive__title" />
      {/* Each count whole: a narrow list wraps between them. */}
      <span className="inbox-primitive__counts">
        <span className="meta-count">{countText(counts.messages, MESSAGE)}</span>
        {counts.unread > 0 ? <>{' '}<span className="meta-count inbox-primitive__unread">/ {counts.unread} UNREAD</span></> : null}
        {counts.flagged > 0 ? <>{' '}<span className="meta-count">/ {counts.flagged} FLAGGED</span></> : null}
      </span>
    </div>
  );
  return (
    <div ref={boxRef} className={`inbox-primitive inbox-primitive--${READING[slot]}`} data-testid="inbox">
      {/* A new layout is a new list to open: the viewport leads again on the
          message a note names, at its place in the rows now drawn. */}
      <ListViewport
        key={layout}
        noun={MESSAGE}
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

// @vitest-environment jsdom
// The inbox (primitives/InboxPrimitive.tsx), drawn for the first time: the
// stand-in listed the fields as sent. These hold the order sent, the time
// of day on `today` and the day otherwise, the unread, flagged and tinted
// marks, what a compact slot leaves out, the layout the list's width
// decides, and the message a note names.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { InboxData, InboxMessage } from '../../src/controller/types';
import { parseTimeValue } from '../../src/controller/validation';
import { fixtures } from '../../src/fixtures/scenes';
import { InboxPrimitive, ONE_LINE_EMS, inboxCounts, inboxLayout, messageTime, type InboxVariant } from '../../src/primitives/InboxPrimitive';

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  const rendered = root;
  if (rendered) act(() => rendered.unmount());
  host?.remove();
  host = null;
  root = null;
});

function render(data: InboxData, variant: InboxVariant = 'full', marked?: string): HTMLElement {
  const page = document.createElement('div');
  document.body.append(page);
  const pageRoot = createRoot(page);
  host = page;
  root = pageRoot;
  act(() => pageRoot.render(<InboxPrimitive data={data} variant={variant} marked={marked} />));
  return page.querySelector('[data-testid="inbox"]') as HTMLElement;
}

const today = parseTimeValue('2026-10-07');
const message = (fields: Partial<InboxMessage>): InboxMessage => ({ id: 'm', from: 'Ana', time: '2026-10-07T08:12', ...fields });
const inbox = (fixtures.inbox[0] as { data: InboxData }).data;
const row = (list: Element, id: string) => list.querySelector(`[data-item="${id}"]`)!;

describe('messageTime', () => {
  it('shows a wall time on today as its time of day', () => {
    expect(messageTime(message({ time: '2026-10-07T08:12' }), today)).toEqual({ text: '08:12', today: true });
  });

  it('shows any other time as its day: another day, or a date on today', () => {
    expect(messageTime(message({ time: '2026-10-06T21:14' }), today)).toEqual({ text: 'TUE OCT 6', today: false });
    expect(messageTime(message({ time: '2026-10-07' }), today)).toEqual({ text: 'WED OCT 7', today: false });
    expect(messageTime(message({ time: '2025-12-30T23:59' }), today)).toEqual({ text: 'DEC 30 2025', today: false });
  });

  it('with no today, shows every time as its day: no page clock', () => {
    expect(messageTime(message({ time: '2026-10-07T08:12' }), null)).toEqual({ text: 'WED OCT 7', today: false });
  });
});

describe('inboxLayout and inboxCounts', () => {
  it('puts a message on one line only where the list has the width for it, in its own ems', () => {
    expect(inboxLayout('full', ONE_LINE_EMS.full * 15, 15)).toBe('line');
    expect(inboxLayout('full', ONE_LINE_EMS.full * 15 - 1, 15)).toBe('stack');
    expect(inboxLayout('compact', ONE_LINE_EMS.compact * 12, 12)).toBe('compact-line');
    expect(inboxLayout('compact', 200, 12)).toBe('compact-stack');
    // Not yet measured: the narrow layout, which fits any width.
    expect(inboxLayout('full', 0, 15)).toBe('stack');
  });

  it('counts the fixture: messages, unread and flagged', () => {
    expect(inboxCounts(inbox)).toEqual({ messages: 11, unread: 5, flagged: 4 });
  });

  it('keeps the order the fixture title names: unread first, each run newest first', () => {
    // The page draws messages in the order sent, so the fixture's own order
    // is what a reader of "INBOX / UNREAD FIRST" sees.
    expect(inbox.title).toBe('INBOX / UNREAD FIRST');
    const unread = inbox.messages.map((m) => m.unread === true);
    expect(unread).toEqual([...unread].sort((a, b) => Number(b) - Number(a)));
    const minute = (m: InboxMessage) => {
      const time = parseTimeValue(m.time)!;
      return time.dayNumber * 1440 + time.hour * 60 + time.minute;
    };
    for (const run of [inbox.messages.filter((m) => m.unread), inbox.messages.filter((m) => !m.unread)]) {
      expect(run.map((m) => m.id)).toEqual([...run].sort((a, b) => minute(b) - minute(a)).map((m) => m.id));
    }
  });
});

describe('InboxPrimitive', () => {
  it('draws the messages in the order sent, each with its id', () => {
    const list = render(inbox);
    expect([...list.querySelectorAll('[data-item]')].map((item) => item.getAttribute('data-item'))).toEqual(inbox.messages.map((m) => m.id));
    expect(list.querySelector('.inbox-primitive__meta')?.textContent).toBe('INBOX / UNREAD FIRST11 MESSAGES / 5 UNREAD / 4 FLAGGED');
  });

  it('draws the sender, subject, snippet, channel and time of a message', () => {
    const list = render(inbox);
    const dentist = row(list, 'dentist');
    expect(dentist.querySelector('.inbox-row__sender')?.textContent).toBe("Dr. Okafor's office");
    expect(dentist.querySelector('.inbox-row__subject')?.textContent).toBe('Appointment today');
    expect(dentist.querySelector('.inbox-row__snippet')?.textContent).toBe('Reminder: today at 10:30. Reply C to confirm or call to reschedule.');
    expect(dentist.querySelector('.inbox-row__tag')?.textContent).toBe('sms');
    expect(dentist.querySelector('.inbox-row__time')?.textContent).toBe('08:12');
    expect(row(list, 'priya').querySelector('.inbox-row__time')?.textContent).toBe('TUE OCT 6');
  });

  it('marks unread messages strong, flagged ones with the flag, and a tint by its semantic', () => {
    const list = render(inbox);
    const dentist = row(list, 'dentist');
    expect(dentist.classList.contains('inbox-row--unread')).toBe(true);
    expect(dentist.querySelector('.inbox-row__unread')?.getAttribute('aria-label')).toBe('unread');
    expect(dentist.querySelector('.inbox-row__flag')?.getAttribute('aria-label')).toBe('flagged');
    expect(dentist.classList.contains('inbox-row--amber')).toBe(true);
    const ana = row(list, 'ana');
    expect(ana.classList.contains('inbox-row--read')).toBe(true);
    expect(ana.querySelector('.inbox-row__flag')).toBeNull();
    expect(ana.classList.contains('inbox-row--tint')).toBe(false);
    expect(row(list, 'ci').classList.contains('inbox-row--red')).toBe(true);
  });

  it('keeps a cell for a part a message lacks, so the columns stand', () => {
    const list = render({ messages: [message({ id: 'bare' })] });
    const bare = row(list, 'bare');
    expect([...bare.children].map((child) => child.className.split(' ')[0])).toEqual([
      'inbox-row__unread', 'inbox-row__from', 'inbox-row__text', 'inbox-row__channel', 'inbox-row__flagged', 'inbox-row__time',
    ]);
  });

  it('in a compact slot draws the sender and the subject, or the snippet where there is none, and no channel', () => {
    const list = render(inbox, 'compact');
    expect(list.querySelector('.inbox-row__channel')).toBeNull();
    expect(row(list, 'dentist').querySelector('.inbox-row__snippet')).toBeNull();
    expect(row(list, 'priya').querySelector('.inbox-row__snippet')?.textContent).toBe('offsite agenda draft is in the doc, can you look before Thursday?');
  });

  it('marks the message a note names with the NOTE badge', () => {
    const list = render(inbox, 'full', 'ci');
    expect(row(list, 'ci').classList.contains('inbox-row--marked')).toBe(true);
    expect(row(list, 'ci').querySelector('.note-badge')?.textContent).toBe('NOTE');
    expect(list.querySelectorAll('.note-badge')).toHaveLength(1);
  });
});

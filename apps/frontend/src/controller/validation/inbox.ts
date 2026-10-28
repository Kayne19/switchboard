import type {
  InboxData,
  InboxMessage,
} from '../types';
import { SEMANTICS, checkItemId, checkString, checkUnknownKeys, copyFrameText, copyOptionalBoolean, copyOptionalName, copyOptionalString, isRecord } from './shared';
import type { Fields } from './shared';
import { readTime } from './time';

const MAX_INBOX_MESSAGES = 50;
const MAX_INBOX_CHANNEL_UTF16 = 32;

function validateInboxMessage(m: unknown, seen: Set<string>): { ok: true; message: InboxMessage } | { ok: false; error: string } {
  if (!isRecord(m)) return { ok: false, error: 'inbox message must be an object' };
  const unknownKey = checkUnknownKeys(
    m,
    new Set(['id', 'from', 'subject', 'snippet', 'time', 'channel', 'unread', 'flagged', 'semantic']),
    'inbox message',
  );
  if (unknownKey) return { ok: false, error: unknownKey };
  const id = checkItemId(m.id, seen, 'inbox message');
  if (!id.ok) return id;
  const fromErr = checkString(m.from, 128, 'inbox message.from');
  if (fromErr) return { ok: false, error: fromErr };
  const out: Fields = { id: id.id, from: m.from };
  const textErr =
    copyOptionalString(m, out, 'subject', 256, 'inbox message.subject') ??
    copyOptionalString(m, out, 'snippet', 256, 'inbox message.snippet');
  if (textErr) return { ok: false, error: textErr };
  const time = readTime(m.time, ['date', 'wall'], 'inbox message.time');
  if (!time.ok) return time;
  out.time = m.time;
  const err =
    copyOptionalString(m, out, 'channel', MAX_INBOX_CHANNEL_UTF16, 'inbox message.channel') ??
    copyOptionalBoolean(m, out, 'unread', 'inbox message.unread') ??
    copyOptionalBoolean(m, out, 'flagged', 'inbox message.flagged') ??
    copyOptionalName(m, out, 'semantic', SEMANTICS, 'inbox message.semantic');
  if (err) return { ok: false, error: err };
  return { ok: true, message: out as unknown as InboxMessage };
}

export function validateInboxData(data: Fields): { ok: true; data: InboxData } | { ok: false; error: string } {
  const unknownKey = checkUnknownKeys(data, new Set(['title', 'subtitle', 'context', 'caption', 'today', 'messages']), 'inbox data');
  if (unknownKey) return { ok: false, error: unknownKey };
  const out: Fields = {};
  if (data.today !== undefined) {
    const today = readTime(data.today, ['date'], 'inbox.today');
    if (!today.ok) return today;
    out.today = data.today;
  }
  if (!Array.isArray(data.messages) || data.messages.length < 1 || data.messages.length > MAX_INBOX_MESSAGES) {
    return { ok: false, error: `inbox.messages must be an array of 1 to ${MAX_INBOX_MESSAGES} items` };
  }
  const seen = new Set<string>();
  const messages: InboxMessage[] = [];
  for (const m of data.messages) {
    const res = validateInboxMessage(m, seen);
    if (!res.ok) return res;
    messages.push(res.message);
  }
  out.messages = messages;
  const err = copyFrameText(data, out, 'inbox');
  if (err) return { ok: false, error: err };
  return { ok: true, data: out as unknown as InboxData };
}

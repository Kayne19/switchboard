import type {
  NoteData,
  RichSegment,
} from '../types';
import { MAX_ID_UTF16, SEMANTICS, checkIdentifier, checkString, checkUnknownKeys, copyNumber, copyOptionalBoolean, copyOptionalName, copyOptionalString, isBlank, isRecord } from './shared';

export function validateNoteData(data: Record<string, unknown>): { ok: true; data: NoteData } | { ok: false; error: string } {
  const allowed = new Set(['tag', 'segments', 'caption', 'anchor']);
  const unknownKey = checkUnknownKeys(data, allowed, 'note data');
  if (unknownKey) return { ok: false, error: unknownKey };

  if (!Array.isArray(data.segments)) return { ok: false, error: 'note.segments must be an array' };
  const segmentAllowed = new Set(['text', 'accent', 'bold', 'semantic']);
  const segments: RichSegment[] = [];

  for (const seg of data.segments) {
    if (!isRecord(seg)) return { ok: false, error: 'note segment must be an object' };
    const segUnknown = checkUnknownKeys(seg, segmentAllowed, 'note segment');
    if (segUnknown) return { ok: false, error: segUnknown };

    const textErr = checkString(seg.text, 50_000, 'note segment.text');
    if (textErr) return { ok: false, error: textErr };

    const segObj: RichSegment = { text: seg.text as string };
    const err =
      copyOptionalBoolean(seg, segObj, 'accent', 'note segment.accent') ??
      copyOptionalBoolean(seg, segObj, 'bold', 'note segment.bold') ??
      copyOptionalName(seg, segObj, 'semantic', SEMANTICS, 'note segment.semantic');
    if (err) return { ok: false, error: err };
    segments.push(segObj);
  }

  const result: NoteData = { segments };
  const err =
    copyOptionalString(data, result, 'tag', 128, 'note.tag') ??
    copyOptionalString(data, result, 'caption', 128, 'note.caption');
  if (err) return { ok: false, error: err };
  if (data.anchor !== undefined) {
    if (!isRecord(data.anchor)) return { ok: false, error: 'note.anchor must be an object' };
    const anchorUnknown = checkUnknownKeys(data.anchor, new Set(['target', 'x', 'series', 'node', 'item']), 'note anchor');
    if (anchorUnknown) return { ok: false, error: anchorUnknown };
    const target = checkIdentifier(data.anchor.target, 'note.anchor.target');
    if (!target.ok) return target;
    const anchor: NonNullable<NoteData['anchor']> = { target: target.id };
    const anchorErr =
      copyNumber(data.anchor, anchor, 'x', 'note.anchor.x', false) ??
      copyOptionalString(data.anchor, anchor, 'series', 128, 'note.anchor.series') ??
      copyOptionalString(data.anchor, anchor, 'node', 128, 'note.anchor.node');
    if (anchorErr) return { ok: false, error: anchorErr };
    // An item inside the target, named as the item names itself: an id, or
    // a forecast hour's `time` or day's `date`. Like `node` and `series`, it
    // is not looked up here: the note and its target are separate objects,
    // and the page marks the item only when the target has one of that name.
    if (data.anchor.item !== undefined) {
      const item = data.anchor.item;
      if (typeof item !== 'string' || isBlank(item) || item.length > MAX_ID_UTF16) {
        return { ok: false, error: `note.anchor.item must be non-empty and <= ${MAX_ID_UTF16} UTF-16 code units` };
      }
      anchor.item = item;
    }
    result.anchor = anchor;
  }

  return { ok: true, data: result };
}

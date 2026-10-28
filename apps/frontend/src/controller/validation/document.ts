import type {
  DocumentData,
} from '../types';
import { checkString, checkUnknownKeys, copyOptionalName, copyOptionalString } from './shared';

const DOCUMENT_KINDS: readonly NonNullable<DocumentData['kind']>[] = ['email', 'document'];

export function validateDocumentData(data: Record<string, unknown>): { ok: true; data: DocumentData } | { ok: false; error: string } {
  const allowed = new Set(['kind', 'context', 'caption', 'source', 'from', 'timestamp', 'subject', 'paragraphs']);
  const unknownKey = checkUnknownKeys(data, allowed, 'document data');
  if (unknownKey) return { ok: false, error: unknownKey };

  const subjErr = checkString(data.subject, 256, 'document.subject');
  if (subjErr) return { ok: false, error: subjErr };

  if (!Array.isArray(data.paragraphs)) return { ok: false, error: 'document.paragraphs must be an array' };
  for (const p of data.paragraphs) {
    const err = checkString(p, 50_000, 'document paragraph');
    if (err) return { ok: false, error: err };
  }

  const result: DocumentData = {
    subject: data.subject as string,
    paragraphs: data.paragraphs as string[],
  };
  const err =
    copyOptionalName(data, result, 'kind', DOCUMENT_KINDS, 'document.kind') ??
    copyOptionalString(data, result, 'context', 256, 'document.context') ??
    copyOptionalString(data, result, 'source', 256, 'document.source') ??
    copyOptionalString(data, result, 'from', 128, 'document.from') ??
    copyOptionalString(data, result, 'timestamp', 128, 'document.timestamp') ??
    copyOptionalString(data, result, 'caption', 128, 'document.caption');
  if (err) return { ok: false, error: err };
  return { ok: true, data: result };
}

import type {
  CodeData,
} from '../types';
import { checkString, checkUnknownKeys, copyOptionalString, isRecord } from './shared';

export function validateCodeData(data: Record<string, unknown>): { ok: true; data: CodeData } | { ok: false; error: string } {
  const allowed = new Set(['title', 'file', 'context', 'caption', 'source']);
  const unknownKey = checkUnknownKeys(data, allowed, 'code data');
  if (unknownKey) return { ok: false, error: unknownKey };

  if (!isRecord(data.source)) return { ok: false, error: 'code.source must be an object' };
  const sourceAllowed = new Set(['language', 'text', 'highlight']);
  const sUnknown = checkUnknownKeys(data.source, sourceAllowed, 'code.source');
  if (sUnknown) return { ok: false, error: sUnknown };

  const textErr = checkString(data.source.text, 50_000, 'code.source.text');
  if (textErr) return { ok: false, error: textErr };

  const sourceObj: CodeData['source'] = { text: data.source.text as string };
  const languageErr = copyOptionalString(data.source, sourceObj, 'language', 64, 'code.source.language');
  if (languageErr) return { ok: false, error: languageErr };
  if (data.source.highlight !== undefined) {
    if (!Array.isArray(data.source.highlight)) return { ok: false, error: 'code.source.highlight must be an array' };
    for (const h of data.source.highlight) {
      if (typeof h !== 'number' || !Number.isFinite(h)) {
        return { ok: false, error: 'code.source.highlight must contain finite numbers' };
      }
    }
    sourceObj.highlight = data.source.highlight as number[];
  }

  const result: CodeData = { source: sourceObj };
  // Not copyFrameText: code has `file` where the others have `subtitle`,
  // and checks it between title and context (the corpus's code_order_*
  // cases pin the order).
  const err =
    copyOptionalString(data, result, 'title', 256, 'code.title') ??
    copyOptionalString(data, result, 'file', 256, 'code.file') ??
    copyOptionalString(data, result, 'context', 256, 'code.context') ??
    copyOptionalString(data, result, 'caption', 128, 'code.caption');
  if (err) return { ok: false, error: err };
  return { ok: true, data: result };
}

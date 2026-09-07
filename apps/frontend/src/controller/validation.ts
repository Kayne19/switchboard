import type {
  ControllerAction,
  SceneObjectRole,
  SceneObjectType,
  SpeechState,
} from './types';

const objectTypes = new Set<SceneObjectType>([
  'chart',
  'metric',
  'progress',
  'diagram',
  'document',
  'code',
  'note',
]);

const objectRoles = new Set<SceneObjectRole>(['primary', 'compare', 'secondary', 'ambient']);
const operations = new Set(['show', 'hide', 'say', 'focus', 'clear']);

const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 50_000;
const MAX_ACTION_BYTES = 256_000;

export type ActionValidationResult =
  | { ok: true; action: ControllerAction }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ID_LENGTH;
}

function isOptionalIdentifier(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || isIdentifier(value);
}

function serializedSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function validateSpeechAnchor(value: unknown): value is SpeechState['at'] {
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;
  if (value.x !== undefined && (typeof value.x !== 'number' || !Number.isFinite(value.x))) return false;
  if (value.series !== undefined && typeof value.series !== 'string') return false;
  return Object.keys(value).every((key) => key === 'x' || key === 'series');
}

function rejectModelLayoutFields(value: unknown): string | null {
  const forbidden = ['layout', 'style', 'css', 'className', 'width', 'height', 'left', 'right', 'top', 'bottom'];
  if (Array.isArray(value)) {
    for (const item of value) { const found = rejectModelLayoutFields(item); if (found) return found; }
    return null;
  }
  if (!isRecord(value)) return null;
  const found = forbidden.find((key) => key in value);
  if (found) return `model-controlled layout field is forbidden: ${found}`;
  for (const item of Object.values(value)) { const nested = rejectModelLayoutFields(item); if (nested) return nested; }
  return null;
}

function hasNonFiniteNumber(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNonFiniteNumber);
  return isRecord(value) && Object.values(value).some(hasNonFiniteNumber);
}

export function validateControllerAction(value: unknown): ActionValidationResult {
  if (!isRecord(value)) return { ok: false, error: 'action must be an object' };
  if (serializedSize(value) > MAX_ACTION_BYTES) return { ok: false, error: 'action exceeds size limit' };
  if (typeof value.op !== 'string' || !operations.has(value.op)) return { ok: false, error: 'unknown operation' };

  const layoutError = rejectModelLayoutFields(value);
  if (layoutError) return { ok: false, error: layoutError };

  switch (value.op) {
    case 'show': {
      if (!isIdentifier(value.id)) return { ok: false, error: 'show.id must be a non-empty identifier' };
      if (typeof value.type !== 'string' || !objectTypes.has(value.type as SceneObjectType)) {
        return { ok: false, error: 'show.type is unknown' };
      }
      if (value.role !== undefined && (typeof value.role !== 'string' || !objectRoles.has(value.role as SceneObjectRole))) {
        return { ok: false, error: 'show.role is unknown' };
      }
      if (!isRecord(value.data)) return { ok: false, error: 'show.data must be an object' };
      if ((value.type === 'chart' || value.type === 'progress') && hasNonFiniteNumber(value.data)) {
        return { ok: false, error: 'show.data contains a non-finite number' };
      }
      return {
        ok: true,
        action: {
          op: 'show',
          id: value.id,
          type: value.type as SceneObjectType,
          role: value.role as SceneObjectRole | undefined,
          data: value.data,
        },
      };
    }
    case 'hide':
      return isIdentifier(value.id)
        ? { ok: true, action: { op: 'hide', id: value.id } }
        : { ok: false, error: 'hide.id must be a non-empty identifier' };
    case 'say': {
      if (typeof value.text !== 'string' || value.text.length === 0 || value.text.length > MAX_TEXT_LENGTH) {
        return { ok: false, error: 'say.text must be non-empty and within the text limit' };
      }
      if (!isOptionalIdentifier(value.target)) return { ok: false, error: 'say.target is invalid' };
      if (!validateSpeechAnchor(value.at)) return { ok: false, error: 'say.at is invalid' };
      return {
        ok: true,
        action: {
          op: 'say',
          text: value.text,
          target: value.target,
          at: value.at as SpeechState['at'],
        },
      };
    }
    case 'focus':
      return isIdentifier(value.id)
        ? { ok: true, action: { op: 'focus', id: value.id } }
        : { ok: false, error: 'focus.id must be a non-empty identifier' };
    case 'clear':
      return { ok: true, action: { op: 'clear' } };
    default:
      return { ok: false, error: 'unknown operation' };
  }
}

export function assertControllerAction(value: unknown): ControllerAction {
  const result = validateControllerAction(value);
  if (!result.ok) throw new TypeError(`Invalid Switchboard action: ${result.error}`);
  return result.action;
}

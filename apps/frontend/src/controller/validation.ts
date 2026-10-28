import type {
  DisplayAction,
  SceneObjectRole,
  SpeechState,
} from './types';
import { validateCalendarData } from './validation/calendar';
import { validateChartData } from './validation/chart';
import { validateCodeData } from './validation/code';
import { validateDiagramData } from './validation/diagram';
import { validateDocumentData } from './validation/document';
import { validateImageData } from './validation/image';
import { validateInboxData } from './validation/inbox';
import { validateMetricData } from './validation/metric';
import { validateNoteData } from './validation/note';
import { validateProgressData } from './validation/progress';
import { checkIdentifier, checkUnknownKeys, copyNumber, copyOptionalString, invalidName, isName, isRecord, keysInOrder } from './validation/shared';
import { validateTableData } from './validation/table';
import { validateTasksData } from './validation/tasks';
import { validateTimerData } from './validation/timer';
import { validateWeatherData } from './validation/weather';

// The names a field takes from a fixed set, each in the schema's order. A
// refused name is `invalidName`'s text, which lists them. `OPERATIONS` is
// also what `window.SwitchboardController.protocol` publishes (App.tsx).
export const OPERATIONS = ['show', 'hide', 'focus', 'say', 'clear'] as const;
const OBJECT_TYPES = [
  'chart',
  'metric',
  'progress',
  'diagram',
  'document',
  'code',
  'table',
  'note',
  'image',
  'calendar',
  'tasks',
  'timer',
  'weather',
  'inbox',
] as const;
const ROLES: readonly SceneObjectRole[] = ['primary', 'compare', 'secondary', 'ambient'];
const MAX_TEXT_UTF16 = 50_000;
const MAX_ACTION_BYTES = 48_000;
/** An image action's own cap, past the general one: see the note on `MAX_IMAGE_BYTES` in `validation/image.ts`. */
export const MAX_IMAGE_ACTION_BYTES = 12 * 1024 * 1024;

const FORBIDDEN_LAYOUT_KEYS = new Set([
  'layout',
  'style',
  'css',
  'className',
  'width',
  'height',
  'left',
  'right',
  'top',
  'bottom',
]);

const HTML_JS_PATTERNS = [
  /<script/i,
  /<iframe/i,
  /<html/i,
  /<style/i,
  /<svg/i,
  /<object/i,
  /<embed/i,
  /javascript:/i,
  /data:text\/html/i,
];

/**
 * An external resource, in any string: a `scheme://` of any scheme, a
 * leading `//`, or a `//` followed by a host name with a dot and a top-level
 * part of two letters or more (`see //cdn.example.com`). The backend's
 * `names_external_resource` is the same rule, written out by hand.
 */
const EXTERNAL_URL_REGEX = /:\/\/|^\/\/|\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

export type ActionValidationResult =
  | { ok: true; action: DisplayAction }
  | { ok: false; error: string };

function serializedSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** The first forbidden key met walking depth first, keys in code point order. */
function findForbiddenLayoutKey(val: unknown): string | null {
  if (Array.isArray(val)) {
    for (const item of val) {
      const found = findForbiddenLayoutKey(item);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(val)) {
    for (const key of keysInOrder(val)) {
      if (FORBIDDEN_LAYOUT_KEYS.has(key)) return key;
      const found = findForbiddenLayoutKey(val[key]);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The first unsafe string met walking depth first, keys in code point order:
 * what is wrong with it, and where it is, written from the action down
 * (`data.events[3].location`), so an agent with 200 events can find the one
 * to mend. A key on the action itself is written bare and every key below it
 * after a dot, even an empty one. `path` holds where `val` is, one part per
 * step, and comes back as it went in. The backend's `unsafe_string` writes
 * the same path.
 */
function findUnsafeString(val: unknown, path: string[] = []): string | null {
  if (typeof val === 'string') {
    const reason = HTML_JS_PATTERNS.some((pattern) => pattern.test(val))
      ? 'raw markup or script injection is forbidden'
      : EXTERNAL_URL_REGEX.test(val)
        ? 'external resource URL is forbidden'
        : null;
    return reason && `${reason} in ${path.join('')}`;
  }
  if (Array.isArray(val)) {
    for (const [index, item] of val.entries()) {
      path.push(`[${index}]`);
      const found = findUnsafeString(item, path);
      path.pop();
      if (found) return found;
    }
    return null;
  }
  if (isRecord(val)) {
    for (const key of keysInOrder(val)) {
      path.push(path.length === 0 ? key : `.${key}`);
      const found = findUnsafeString(val[key], path);
      path.pop();
      if (found) return found;
    }
  }
  return null;
}

function hasNonFiniteNumber(val: unknown): boolean {
  if (typeof val === 'number') {
    return !Number.isFinite(val);
  }
  if (Array.isArray(val)) {
    return val.some(hasNonFiniteNumber);
  }
  if (isRecord(val)) {
    return Object.values(val).some(hasNonFiniteNumber);
  }
  return false;
}

/**
 * The byte cap an action is held to. An image action is the one kind allowed
 * past the general cap; its own fields are capped in validateImageData, so
 * nothing else can ride in under its limit.
 */
function actionSizeCap(value: Record<string, unknown>): number {
  return value.op === 'show' && value.type === 'image' ? MAX_IMAGE_ACTION_BYTES : MAX_ACTION_BYTES;
}

/**
 * Checks one display action and returns it normalized. The order of the
 * checks is the backend's too (docs/display-tool.md, "How the two
 * validators agree"): an object, within its size cap, with a known `op`;
 * then no layout key, no unsafe string and no non-finite number anywhere in
 * it; then the op's own rules; and last the normalized action, which may
 * have gained a field (a say's `at: null`), is held to the same cap.
 */
export function validateControllerAction(value: unknown): ActionValidationResult {
  const result = validateActionFields(value);
  if (result.ok && isRecord(value)) {
    const size = serializedSize(result.action);
    if (size > actionSizeCap(value)) return { ok: false, error: sizeRefusal(size, actionSizeCap(value), true) };
  }
  return result;
}

/**
 * The refusal of an action of `size` bytes over `cap`, with both numbers so
 * the agent knows how much to cut; `normalized` when it is the normalized
 * action that is over (a say's added `at: null`). The backend's
 * `size_refusal` writes the same words.
 */
function sizeRefusal(size: number, cap: number, normalized: boolean): string {
  return `action exceeds size limit${normalized ? ' once normalized' : ''}: ${size} bytes, the cap is ${cap}`;
}

function validateActionFields(value: unknown): ActionValidationResult {
  if (!isRecord(value)) return { ok: false, error: 'action must be an object' };
  const size = serializedSize(value);
  if (size > actionSizeCap(value)) return { ok: false, error: sizeRefusal(size, actionSizeCap(value), false) };
  if (!isName(value.op, OPERATIONS)) {
    return { ok: false, error: invalidName('op', OPERATIONS) };
  }

  const layoutError = findForbiddenLayoutKey(value);
  if (layoutError) return { ok: false, error: `model-controlled layout field is forbidden: ${layoutError}` };

  const unsafeError = findUnsafeString(value);
  if (unsafeError) return { ok: false, error: unsafeError };

  if (hasNonFiniteNumber(value)) {
    return { ok: false, error: 'action contains a non-finite number' };
  }

  switch (value.op) {
    case 'show': {
      const allowedKeys = new Set(['op', 'id', 'type', 'role', 'data']);
      const unknownKey = checkUnknownKeys(value, allowedKeys, 'show action');
      if (unknownKey) return { ok: false, error: unknownKey };

      const idCheck = checkIdentifier(value.id, 'show.id');
      if (!idCheck.ok) return idCheck;

      if (!isName(value.type, OBJECT_TYPES)) {
        return { ok: false, error: invalidName('show.type', OBJECT_TYPES) };
      }

      if (value.role !== undefined && !isName(value.role, ROLES)) {
        return { ok: false, error: invalidName('show.role', ROLES) };
      }

      if (!isRecord(value.data)) return { ok: false, error: 'show.data must be an object' };

      let validatedData: DisplayAction extends { op: 'show'; data: infer D } ? D : unknown;
      switch (value.type) {
        case 'chart': {
          const res = validateChartData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'metric': {
          const res = validateMetricData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'progress': {
          const res = validateProgressData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'diagram': {
          const res = validateDiagramData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'document': {
          const res = validateDocumentData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'code': {
          const res = validateCodeData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'table': {
          const res = validateTableData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'note': {
          const res = validateNoteData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'image': {
          const res = validateImageData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'calendar': {
          const res = validateCalendarData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'tasks': {
          const res = validateTasksData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'timer': {
          const res = validateTimerData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'weather': {
          const res = validateWeatherData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        case 'inbox': {
          const res = validateInboxData(value.data);
          if (!res.ok) return res;
          validatedData = res.data;
          break;
        }
        default:
          return { ok: false, error: invalidName('show.type', OBJECT_TYPES) };
      }

      // The switch above validated `type` and `data` together; TypeScript
      // cannot correlate the two across it, so the pair is asserted once here.
      const action = {
        op: 'show',
        id: idCheck.id,
        type: value.type,
        ...(value.role !== undefined ? { role: value.role as SceneObjectRole } : {}),
        data: validatedData,
      } as DisplayAction;
      return { ok: true, action };
    }
    case 'hide': {
      const allowedKeys = new Set(['op', 'id']);
      const unknownKey = checkUnknownKeys(value, allowedKeys, 'hide action');
      if (unknownKey) return { ok: false, error: unknownKey };

      const idCheck = checkIdentifier(value.id, 'hide.id');
      if (!idCheck.ok) return idCheck;
      return { ok: true, action: { op: 'hide', id: idCheck.id } };
    }
    case 'focus': {
      const allowedKeys = new Set(['op', 'id']);
      const unknownKey = checkUnknownKeys(value, allowedKeys, 'focus action');
      if (unknownKey) return { ok: false, error: unknownKey };

      const idCheck = checkIdentifier(value.id, 'focus.id');
      if (!idCheck.ok) return idCheck;
      return { ok: true, action: { op: 'focus', id: idCheck.id } };
    }
    case 'say': {
      const allowedKeys = new Set(['op', 'text', 'target', 'at']);
      const unknownKey = checkUnknownKeys(value, allowedKeys, 'say action');
      if (unknownKey) return { ok: false, error: unknownKey };

      if (typeof value.text !== 'string' || value.text.length === 0 || value.text.length > MAX_TEXT_UTF16) {
        return { ok: false, error: 'say.text must be non-empty and within the text limit' };
      }

      let targetVal: string | undefined = undefined;
      if (value.target !== undefined && value.target !== null) {
        const targetCheck = checkIdentifier(value.target, 'say.target');
        if (!targetCheck.ok) return targetCheck;
        targetVal = targetCheck.id;
      }

      let atVal: SpeechState['at'] = null;
      if (value.at !== undefined && value.at !== null) {
        if (!isRecord(value.at)) return { ok: false, error: 'say.at is invalid' };
        const atAllowed = new Set(['x', 'series']);
        const atUnknown = checkUnknownKeys(value.at, atAllowed, 'say.at');
        if (atUnknown) return { ok: false, error: atUnknown };

        const hasX = value.at.x !== undefined;
        const hasSeries = value.at.series !== undefined;
        if (!hasX && !hasSeries) {
          return { ok: false, error: 'say.at must contain at least one of x or series' };
        }
        const atObj: { x?: number; series?: string } = {};
        const err =
          copyNumber(value.at, atObj, 'x', 'say.at.x', false) ??
          copyOptionalString(value.at, atObj, 'series', 128, 'say.at.series');
        if (err) return { ok: false, error: err };
        atVal = atObj;
      }

      return {
        ok: true,
        action: {
          op: 'say',
          text: value.text,
          ...(targetVal !== undefined ? { target: targetVal } : {}),
          at: atVal,
        },
      };
    }
    case 'clear': {
      const allowedKeys = new Set(['op']);
      const unknownKey = checkUnknownKeys(value, allowedKeys, 'clear action');
      if (unknownKey) return { ok: false, error: unknownKey };
      return { ok: true, action: { op: 'clear' } };
    }
    default:
      return { ok: false, error: invalidName('op', OPERATIONS) };
  }
}

export function assertControllerAction(value: unknown): DisplayAction {
  const result = validateControllerAction(value);
  if (!result.ok) throw new TypeError(`Invalid Switchboard action: ${result.error}`);
  return result.action;
}

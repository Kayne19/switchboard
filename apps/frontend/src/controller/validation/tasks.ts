import type {
  TaskItem,
  TasksData,
} from '../types';
import { checkItemId, checkString, checkUnknownKeys, copyFrameText, copyOptionalName, copyOptionalString, isRecord } from './shared';
import type { Fields } from './shared';
import { readTime } from './time';

const MAX_TASKS = 100;
const TASK_STATES = ['todo', 'active', 'done', 'blocked'];
const TASK_PRIORITIES = ['high', 'low'];
const MAX_TASK_TAGS = 4;
const MAX_TASK_TAG_UTF16 = 32;

function validateTask(t: unknown, seen: Set<string>): { ok: true; task: TaskItem } | { ok: false; error: string } {
  if (!isRecord(t)) return { ok: false, error: 'task must be an object' };
  const unknownKey = checkUnknownKeys(t, new Set(['id', 'text', 'state', 'due', 'priority', 'group', 'detail', 'tags']), 'task');
  if (unknownKey) return { ok: false, error: unknownKey };
  const id = checkItemId(t.id, seen, 'task');
  if (!id.ok) return id;
  const textErr = checkString(t.text, 256, 'task.text');
  if (textErr) return { ok: false, error: textErr };
  const out: Fields = { id: id.id, text: t.text };
  const stateErr = copyOptionalName(t, out, 'state', TASK_STATES, 'task.state');
  if (stateErr) return { ok: false, error: stateErr };
  if (t.due !== undefined) {
    const due = readTime(t.due, ['date', 'wall'], 'task.due');
    if (!due.ok) return due;
    out.due = t.due;
  }
  const err =
    copyOptionalName(t, out, 'priority', TASK_PRIORITIES, 'task.priority') ??
    copyOptionalString(t, out, 'group', 128, 'task.group') ??
    copyOptionalString(t, out, 'detail', 256, 'task.detail');
  if (err) return { ok: false, error: err };
  if (t.tags !== undefined) {
    if (!Array.isArray(t.tags) || t.tags.length > MAX_TASK_TAGS) {
      return { ok: false, error: `task.tags must be an array of at most ${MAX_TASK_TAGS} strings` };
    }
    for (const tag of t.tags) {
      const tagErr = checkString(tag, MAX_TASK_TAG_UTF16, 'task tag');
      if (tagErr) return { ok: false, error: tagErr };
    }
    out.tags = t.tags;
  }
  return { ok: true, task: out as unknown as TaskItem };
}

export function validateTasksData(data: Fields): { ok: true; data: TasksData } | { ok: false; error: string } {
  const unknownKey = checkUnknownKeys(data, new Set(['title', 'subtitle', 'context', 'caption', 'today', 'items']), 'tasks data');
  if (unknownKey) return { ok: false, error: unknownKey };
  const out: Fields = {};
  if (data.today !== undefined) {
    const today = readTime(data.today, ['date'], 'tasks.today');
    if (!today.ok) return today;
    out.today = data.today;
  }
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > MAX_TASKS) {
    return { ok: false, error: `tasks.items must be an array of 1 to ${MAX_TASKS} items` };
  }
  const seen = new Set<string>();
  const items: TaskItem[] = [];
  for (const t of data.items) {
    const res = validateTask(t, seen);
    if (!res.ok) return res;
    items.push(res.task);
  }
  out.items = items;
  const err = copyFrameText(data, out, 'tasks');
  if (err) return { ok: false, error: err };
  return { ok: true, data: out as unknown as TasksData };
}

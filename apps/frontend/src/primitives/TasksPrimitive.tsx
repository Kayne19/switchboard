import { Fragment, useMemo } from 'react';
import type { TaskItem, TasksData, TaskState } from '../controller/types';
import { parseTimeValue, type TimeValue } from '../controller/validation';
import { ListViewport } from './ListViewport';
import { NoteBadge } from './NoteMarker';
import { StepGlyph } from './ProgressPrimitive';
import { clockText, dayText, daysFrom, readToday } from './timeLabels';
import { MetaTitle } from './MetaTitle';

/**
 * Where a to-do list is drawn decides how much of each task shows:
 * - `full`: the main slot, every open task with its detail and tags; a long
 *   list counts its done tasks in each section ("3 DONE") rather than
 *   listing them;
 * - `focus`: the focus layer, every task listed, done ones too;
 * - `compact`: a cell beside the primary, read as the rail's plan module is
 *   read: one row per open task between thin rules, its due day at the
 *   end, each section's done tasks counted on one row.
 */
export type TasksVariant = 'full' | 'focus' | 'compact';

/** A list longer than this counts its done tasks in the main slot. */
export const LONG_TASK_LIST = 14;

/** How a task's due day stands against the list's `today`: `past` is a
 * day gone by on a task done (so not overdue); `unjudged` a day the list
 * has no `today` to set against. */
export type DueStanding = 'overdue' | 'past' | 'today' | 'tomorrow' | 'later' | 'unjudged';

export interface TaskDue {
  standing: DueStanding;
  /** The word that leads the label, when the standing has one. */
  word?: string;
  /** The day or time, as the page writes it. */
  when: string;
}

/**
 * A task's due label. Overdue is a due day before `today` on a task not
 * done (the day is compared, not the time: a list has no `now`); due today
 * names the time of day, or just TODAY. With no `today` the day is only
 * written, never judged.
 */
export function taskDue(task: TaskItem, today: TimeValue | null): TaskDue | null {
  const due = task.due === undefined ? null : parseTimeValue(task.due);
  if (!due) return null;
  const clock = due.form === 'wall' ? clockText(due) : '';
  if (!today) return { standing: 'unjudged', when: [dayText(due), clock].filter(Boolean).join(' ') };
  const days = daysFrom(today, due);
  if (days < 0) {
    return task.state === 'done'
      ? { standing: 'past', when: [dayText(due, today), clock].filter(Boolean).join(' ') }
      : { standing: 'overdue', word: 'OVERDUE', when: dayText(due, today) };
  }
  if (days === 0) return { standing: 'today', word: 'TODAY', when: clock };
  if (days === 1) return { standing: 'tomorrow', word: 'TOMORROW', when: clock };
  return { standing: 'later', when: [dayText(due, today), clock].filter(Boolean).join(' ') };
}

export interface TaskSection {
  /** The group's name; undefined for the tasks sent without one. */
  group: string | undefined;
  tasks: TaskItem[];
}

/** The sections of a list, in the order their groups are first met. */
export function taskSections(items: TaskItem[]): TaskSection[] {
  const sections = new Map<string | undefined, TaskSection>();
  for (const task of items) {
    const section = sections.get(task.group) ?? { group: task.group, tasks: [] };
    section.tasks.push(task);
    sections.set(task.group, section);
  }
  return [...sections.values()];
}

const stateOf = (task: TaskItem): TaskState => task.state ?? 'todo';

/** What a list holds: its tasks open, done and overdue. */
export function taskCounts(data: TasksData): { open: number; done: number; overdue: number } {
  const today = readToday(data.today);
  let done = 0;
  let overdue = 0;
  for (const task of data.items) {
    if (stateOf(task) === 'done') done += 1;
    else if (taskDue(task, today)?.standing === 'overdue') overdue += 1;
  }
  return { open: data.items.length - done, done, overdue };
}

/** Whether a slot counts a section's done tasks instead of listing them. */
export function countsDone(variant: TasksVariant, total: number): boolean {
  return variant === 'compact' || (variant === 'full' && total > LONG_TASK_LIST);
}

// An arrow for a priority other than normal, the metric trend's arrow:
// up for high, down for low.
function PriorityMark({ priority }: { priority: 'high' | 'low' }) {
  return (
    <svg className={`task-row__priority task-row__priority--${priority}`} viewBox="0 0 12 12" role="img" aria-label={`${priority} priority`}>
      {priority === 'high' ? <path d="M6 10.5 V2.2 M2.4 5.8 L6 2.2 L9.6 5.8" /> : <path d="M6 1.5 V9.8 M2.4 6.2 L6 9.8 L9.6 6.2" />}
    </svg>
  );
}

// The due label at a row's end: the word that judges the day over the day
// or time. A compact row has one line for it: the word, or the time on
// today, or the day.
function DueLabel({ due, compact }: { due: TaskDue; compact: boolean }) {
  const parts = compact ? [due.standing === 'today' && due.when ? due.when : (due.word ?? due.when)] : [due.word, due.when];
  return (
    <span className={`task-row__due task-row__due--${due.standing} tech`}>
      {/* A space between the parts, which the column's layout drops, so
          the label reads 'OVERDUE FRI OCT 2', not 'OVERDUEFRI OCT 2'. */}
      {parts.filter(Boolean).map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? ' ' : null}
          <span className={index === 0 && due.word && !compact ? 'task-row__due-word' : 'task-row__due-when'}>{part}</span>
        </Fragment>
      ))}
    </span>
  );
}

function TaskRow({ task, today, marked, compact }: { task: TaskItem; today: TimeValue | null; marked: boolean; compact: boolean }) {
  const state = stateOf(task);
  const due = taskDue(task, today);
  const className = [
    'task-row',
    `task-row--${state}`,
    task.priority ? `task-row--${task.priority}` : '',
    due ? `task-row--due-${due.standing}` : '',
    marked ? 'task-row--marked' : '',
  ].filter(Boolean).join(' ');
  return (
    <li className={className} data-item={task.id} data-state={state}>
      <StepGlyph state={state} className="task-row__glyph" />
      <div className="task-row__body">
        <div className="task-row__line">
          {marked ? <NoteBadge className="task-row__note" /> : null}
          {task.priority ? <PriorityMark priority={task.priority} /> : null}
          <span className="task-row__text">{task.text}</span>
        </div>
        {!compact && task.detail ? <div className="task-row__detail">{task.detail}</div> : null}
        {!compact && task.tags && task.tags.length > 0 ? (
          <div className="task-row__tags">
            {task.tags.map((tag, index) => <span key={index} className="task-tag tech micro">{tag}</span>)}
          </div>
        ) : null}
      </div>
      {due ? <DueLabel due={due} compact={compact} /> : <span className="task-row__due" />}
    </li>
  );
}

/**
 * What a section's head says it holds: its open tasks, and its done ones
 * while they are listed under it (a row counts them when they are not). A
 * section all done says only that, and needs no row under it.
 */
function sectionCount(section: TaskSection, doneCounted: boolean): string {
  const done = section.tasks.filter((task) => stateOf(task) === 'done').length;
  const open = section.tasks.length - done;
  if (open === 0) return `${done} DONE`;
  return `${open} OPEN${done > 0 && !doneCounted ? ` / ${done} DONE` : ''}`;
}

function SectionHead({ section, today, doneCounted }: { section: TaskSection; today: TimeValue | null; doneCounted: boolean }) {
  const overdue = section.tasks.filter((task) => taskDue(task, today)?.standing === 'overdue').length;
  return (
    <div className="task-section__head">
      <span className="task-section__name tech" role="heading" aria-level={3}>{section.group ?? 'OTHER'}</span>
      <span className="task-section__count tech micro">
        {sectionCount(section, doneCounted)}
        {overdue > 0 ? <span className="task-section__overdue"> / {overdue} OVERDUE</span> : null}
      </span>
    </div>
  );
}

/**
 * A to-do list: sections in the order their groups are first met, each
 * task a row with its state in the plan's step glyph, its priority as the
 * metric's arrow, its text wrapping, and its due day at the end, overdue
 * in red and due today in orange, both from the list's own `today`. Done
 * tasks are quieter. A list that outgrows its slot scrolls inside its
 * frame with the list viewport's counts, and opens on the task a note
 * names (`marked`), which carries the NOTE badge. `framed`: the scene
 * frame above shows the title (MetaTitle).
 */
export function TasksPrimitive({ data, variant = 'full', marked, framed = false }: { data: TasksData; variant?: TasksVariant; marked?: string; framed?: boolean }) {
  const today = readToday(data.today);
  const sections = useMemo(() => taskSections(data.items), [data.items]);
  const counts = taskCounts(data);
  const grouped = sections.some((section) => section.group !== undefined);
  const countDone = countsDone(variant, data.items.length);
  const compact = variant === 'compact';
  const head = (
    <div className="tasks-primitive__meta tech micro">
      <MetaTitle title={data.title ?? 'TASKS'} framed={framed} className="tasks-primitive__title" />
      {/* Each count whole: a narrow list wraps between them. */}
      <span className="tasks-primitive__counts">
        <span className="meta-count">{counts.open} OPEN</span>
        {counts.done > 0 ? <>{' '}<span className="meta-count">/ {counts.done} DONE</span></> : null}
        {counts.overdue > 0 ? <>{' '}<span className="meta-count tasks-primitive__overdue">/ {counts.overdue} OVERDUE</span></> : null}
      </span>
    </div>
  );
  return (
    <div className={`tasks-primitive tasks-primitive--${variant}`} data-testid="tasks">
      <ListViewport noun={['TASK', 'TASKS']} lead={marked} head={head} scrollClassName="tasks-primitive__scroll" label={data.title ?? 'Tasks'}>
        <div className={`tasks-primitive__sections${grouped ? '' : ' tasks-primitive__sections--plain'}`}>
          {sections.map((section, index) => {
            // A task a note names stays listed when its section counts the rest.
            const listed = countDone ? section.tasks.filter((task) => stateOf(task) !== 'done' || task.id === marked) : section.tasks;
            const hidden = section.tasks.length - listed.length;
            // A section whose head already says it is all done needs no row to count it.
            const countRow = hidden > 0 && !(grouped && listed.length === 0);
            return (
              <section className="task-section" key={section.group ?? `ungrouped-${index}`}>
                {grouped ? <SectionHead section={section} today={today} doneCounted={hidden > 0} /> : null}
                <ol className="task-section__rows">
                  {listed.map((task) => (
                    <TaskRow key={task.id} task={task} today={today} marked={task.id === marked} compact={compact} />
                  ))}
                  {countRow ? (
                    <li className="task-row task-row--done task-row--counted">
                      <StepGlyph state="done" className="task-row__glyph" decorative />
                      <span className="task-row__count tech">{hidden} DONE</span>
                    </li>
                  ) : null}
                </ol>
              </section>
            );
          })}
        </div>
      </ListViewport>
    </div>
  );
}

// @vitest-environment jsdom
// The to-do list (primitives/TasksPrimitive.tsx), drawn for the first time:
// the stand-in listed the fields as sent. These hold what each slot draws:
// sections in first-seen order, the plan's state glyphs, the due label
// judged against the list's own `today`, done tasks counted in a long list
// and in a compact slot, and the item a note names.
import { describe, expect, it } from 'vitest';
import type { TaskItem, TasksData } from '../../src/controller/types';
import { parseTimeValue } from '../../src/controller/validation';
import { fixtures } from '../../src/fixtures/scenes';
import {
  LONG_TASK_LIST,
  TasksPrimitive,
  countsDone,
  taskCounts,
  taskDue,
  taskSections,
  type TasksVariant,
} from '../../src/primitives/TasksPrimitive';
import { mount, stubResizeObserver } from './sceneHarness';

stubResizeObserver();

function render(data: TasksData, variant: TasksVariant = 'full', marked?: string): HTMLElement {
  return mount(<TasksPrimitive data={data} variant={variant} marked={marked} />).querySelector('[data-testid="tasks"]') as HTMLElement;
}

const today = parseTimeValue('2026-10-07');
const task = (fields: Partial<TaskItem>): TaskItem => ({ id: 'a', text: 'A task', ...fields });
const rows = (list: Element) => [...list.querySelectorAll('[data-item]')];
const texts = (list: Element) => rows(list).map((row) => row.querySelector('.task-row__text')?.textContent);
const week = (fixtures.tasks[0] as { data: TasksData }).data;

describe('taskDue', () => {
  it('is overdue when the day is before today and the task is not done, and says the day', () => {
    expect(taskDue(task({ due: '2026-10-02' }), today)).toEqual({ standing: 'overdue', word: 'OVERDUE', when: 'FRI OCT 2' });
    expect(taskDue(task({ due: '2026-10-06T09:00', state: 'blocked' }), today)?.standing).toBe('overdue');
  });

  it('is not overdue once done', () => {
    expect(taskDue(task({ due: '2026-10-02', state: 'done' }), today)).toEqual({ standing: 'past', when: 'FRI OCT 2' });
  });

  it('compares the day, not the time: a task due this morning is due today, not overdue', () => {
    expect(taskDue(task({ due: '2026-10-07T09:00' }), today)).toEqual({ standing: 'today', word: 'TODAY', when: '09:00' });
    expect(taskDue(task({ due: '2026-10-07' }), today)).toEqual({ standing: 'today', word: 'TODAY', when: '' });
  });

  it('names tomorrow, and writes a later day with its weekday, or its year when that is not today\'s', () => {
    expect(taskDue(task({ due: '2026-10-08T18:05' }), today)).toEqual({ standing: 'tomorrow', word: 'TOMORROW', when: '18:05' });
    expect(taskDue(task({ due: '2026-10-12' }), today)).toEqual({ standing: 'later', when: 'MON OCT 12' });
    expect(taskDue(task({ due: '2027-01-15T08:00' }), today)).toEqual({ standing: 'later', when: 'JAN 15 2027 08:00' });
  });

  it('judges nothing without a today: no page clock', () => {
    expect(taskDue(task({ due: '2026-10-02T17:00' }), null)).toEqual({ standing: 'unjudged', when: 'FRI OCT 2 17:00' });
    expect(taskDue(task({}), today)).toBeNull();
  });
});

describe('taskSections and taskCounts', () => {
  it('keeps the sections in the order their groups are first met, the ungrouped as one', () => {
    const sections = taskSections([
      task({ id: '1', group: 'Home' }), task({ id: '2' }), task({ id: '3', group: 'Work' }), task({ id: '4', group: 'Home' }), task({ id: '5' }),
    ]);
    expect(sections.map((section) => [section.group, section.tasks.map((t) => t.id)])).toEqual([
      ['Home', ['1', '4']], [undefined, ['2', '5']], ['Work', ['3']],
    ]);
  });

  it('counts the week fixture: open, done, and overdue against its today', () => {
    expect(taskCounts(week)).toEqual({ open: 10, done: 3, overdue: 2 });
  });

  it('counts done tasks in a compact slot always, in the main slot past a long list, in focus never', () => {
    expect(countsDone('compact', 2)).toBe(true);
    expect(countsDone('full', LONG_TASK_LIST)).toBe(false);
    expect(countsDone('full', LONG_TASK_LIST + 1)).toBe(true);
    expect(countsDone('focus', 100)).toBe(false);
  });
});

describe('TasksPrimitive', () => {
  it('draws each section with its name and what it holds, every task with its state glyph and id', () => {
    const list = render(week);
    expect([...list.querySelectorAll('.task-section__name')].map((name) => name.textContent)).toEqual(['Work', 'Errands', 'Home', 'Trip']);
    expect(list.querySelector('.task-section__count')?.textContent).toBe('2 OPEN / 1 DONE');
    // Rows by section, then as sent.
    expect(rows(list).map((row) => row.getAttribute('data-item'))).toEqual(taskSections(week.items).flatMap((section) => section.tasks.map((t) => t.id)));
    const review = list.querySelector('[data-item="pr"]')!;
    expect(review.getAttribute('data-state')).toBe('active');
    expect(review.querySelector('.task-row__glyph')?.getAttribute('aria-label')).toBe('active');
    expect(review.querySelector('.task-row__priority')?.getAttribute('aria-label')).toBe('high priority');
    expect([...review.querySelectorAll('.task-tag')].map((tag) => tag.textContent)).toEqual(['switchboard', 'review']);
    // Its sections say what each holds at their heads: the meta line adds no total over them.
    expect(list.querySelector('.tasks-primitive__meta')?.textContent).toBe('TO DO / THIS WEEK');
  });

  it('says its total on the meta line only where it has no sections, and under a scene frame has no meta line where that leaves none', () => {
    const plain: TasksData = { ...week, items: week.items.map((item) => ({ ...item, group: undefined })) };
    expect(render(plain).querySelector('.tasks-primitive__meta')?.textContent).toBe('TO DO / THIS WEEK10 OPEN / 3 DONE / 2 OVERDUE');
    const framed = (data: TasksData) => mount(<TasksPrimitive data={data} framed />).querySelector('.tasks-primitive__meta');
    expect(framed(week)).toBeNull();
    expect(framed(plain)?.textContent).toBe('10 OPEN / 3 DONE / 2 OVERDUE');
  });

  it('marks an overdue task red and one due today in the time of day', () => {
    const list = render(week);
    const passport = list.querySelector('[data-item="passport"] .task-row__due')!;
    expect(passport.classList.contains('task-row__due--overdue')).toBe(true);
    expect(passport.textContent).toBe('OVERDUE FRI OCT 2');
    const review = list.querySelector('[data-item="pr"] .task-row__due')!;
    expect(review.classList.contains('task-row__due--today')).toBe(true);
    expect(review.textContent).toBe('TODAY 17:00');
  });

  it('lists the done tasks of a short list, quieter', () => {
    const list = render(week);
    const done = list.querySelector('[data-item="gift"]')!;
    expect(done.classList.contains('task-row--done')).toBe(true);
    expect(list.querySelector('.task-row--counted')).toBeNull();
  });

  it('counts the done tasks of a long list in each section, keeping the one a note names', () => {
    const items = Array.from({ length: LONG_TASK_LIST + 2 }, (_, index) =>
      task({ id: `t${index}`, text: `Task ${index}`, group: index % 2 ? 'Odd' : 'Even', state: index < 8 ? 'done' : 'todo' }));
    const list = render({ items }, 'full', 't2');
    expect([...list.querySelectorAll('.task-row--counted')].map((row) => row.textContent)).toEqual(['3 DONE', '4 DONE']);
    expect(rows(list).map((row) => row.getAttribute('data-item'))).toEqual(['t2', 't8', 't10', 't12', 't14', 't9', 't11', 't13', 't15']);
    // The section heads count done tasks only while they are listed.
    expect(list.querySelector('.task-section__count')?.textContent).toBe('4 OPEN');
    expect(list.querySelector('[data-item="t2"] .note-badge')?.textContent).toBe('NOTE');
  });

  it('names its sections as headings, and hides the glyph of a count row that already says DONE', () => {
    const items = Array.from({ length: LONG_TASK_LIST + 2 }, (_, index) => task({ id: `t${index}`, group: 'Home', state: index < 3 ? 'done' : 'todo' }));
    const list = render({ items });
    expect(list.querySelector('.task-section__name')?.getAttribute('role')).toBe('heading');
    const counted = list.querySelector('.task-row--counted')!;
    expect(counted.querySelector('.task-row__glyph')?.getAttribute('aria-hidden')).toBe('true');
    expect(counted.querySelector('[role="img"]')).toBeNull();
  });

  it('lists every task in focus, done ones too', () => {
    const items = Array.from({ length: LONG_TASK_LIST + 2 }, (_, index) => task({ id: `t${index}`, state: index < 8 ? 'done' : 'todo' }));
    const list = render({ items }, 'focus');
    expect(rows(list)).toHaveLength(LONG_TASK_LIST + 2);
    expect(list.querySelector('.task-row--counted')).toBeNull();
  });

  it('in a compact slot keeps a row a task: no detail, no tags, the due day on one line', () => {
    const list = render(week, 'compact');
    expect(list.classList.contains('tasks-primitive--compact')).toBe(true);
    expect(list.querySelector('.task-row__detail')).toBeNull();
    expect(list.querySelector('.task-tag')).toBeNull();
    expect(list.querySelector('[data-item="pr"] .task-row__due')?.textContent).toBe('17:00');
    expect(list.querySelector('[data-item="passport"] .task-row__due')?.textContent).toBe('OVERDUE');
    expect(texts(list)).not.toContain('Buy a gift for Mom');
    expect([...list.querySelectorAll('.task-row--counted')].map((row) => row.textContent)).toEqual(['1 DONE', '1 DONE', '1 DONE']);
  });

  it('says a section is all done in its head, with no row to count it', () => {
    const items = [task({ id: 'a', group: 'Home', state: 'done' }), task({ id: 'b', group: 'Home', state: 'done' }), task({ id: 'c', group: 'Work' })];
    const list = render({ items }, 'compact');
    expect([...list.querySelectorAll('.task-section__count')].map((count) => count.textContent)).toEqual(['2 DONE', '1 OPEN']);
    expect(list.querySelector('.task-row--counted')).toBeNull();
  });

  it('keeps the row that counts done tasks in a list with no heads', () => {
    const list = render({ items: [task({ id: 'x', state: 'done' })] }, 'compact');
    expect(list.querySelector('.task-row--counted')?.textContent).toBe('1 DONE');
  });

  it('draws a list without groups as one section with no head', () => {
    const list = render({ items: [task({ id: 'bins', text: 'Take the bins out' })] });
    expect(list.querySelector('.task-section__head')).toBeNull();
    expect(texts(list)).toEqual(['Take the bins out']);
    expect(list.querySelector('[data-item="bins"]')?.getAttribute('data-state')).toBe('todo');
  });

  it('wraps a long text whole, never cut', () => {
    const long = 'Send the dental insurance claim for the cleaning and the x-ray, with the receipt from the front desk and the referral letter';
    const list = render({ items: [task({ id: 'claim', text: long })] });
    expect(list.querySelector('[data-item="claim"] .task-row__text')?.textContent).toBe(long);
  });
});

describe('the priority arrow', () => {
  it('is the metric trend arrow: up for high, down for low, none for normal', () => {
    const list = render({ items: [task({ id: 'hi', priority: 'high' }), task({ id: 'lo', priority: 'low' }), task({ id: 'normal' })] });
    const arrow = (id: string) => list.querySelector(`[data-item="${id}"] .task-row__priority`);
    expect(arrow('hi')?.querySelector('path')?.getAttribute('d')).toBe('M6 10.5 V2.2 M2.4 5.8 L6 2.2 L9.6 5.8');
    expect(arrow('lo')?.querySelector('path')?.getAttribute('d')).toBe('M6 1.5 V9.8 M2.4 6.2 L6 9.8 L9.6 6.2');
    expect(arrow('lo')?.getAttribute('class')).toBe('task-row__priority task-row__priority--low');
    expect(arrow('normal')).toBeNull();
  });
});

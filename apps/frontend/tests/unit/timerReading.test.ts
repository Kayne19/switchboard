import { describe, expect, it } from 'vitest';
import type { Timer } from '../../src/controller/types';
import { parseTimeValue } from '../../src/controller/validation';
import {
  CELL_GAP,
  formatCountdown,
  instantClock,
  instantMs,
  MIN_CELL_DIGITS,
  MIN_CELL_WIDTH,
  readTimer,
  timerLayout,
} from '../../src/primitives/timerReading';

// A timer read at a moment of the page clock: the boundaries a countdown
// must get right (exactly zero, past zero, paused, a start still to come),
// pinned without a clock.

const ms = (instant: string) => instantMs(parseTimeValue(instant)!);
const END = '2026-10-07T18:42:00-07:00';
const pasta: Timer = { id: 'pasta', label: 'Pasta', startedAt: '2026-10-07T18:33:00-07:00', endsAt: END };

describe('instantMs', () => {
  it.each([
    '2026-10-07T18:42:00-07:00',
    '2026-10-08T01:42:00Z',
    '2026-10-08T07:12:00+05:30',
    '2026-10-08T01:42:00.250Z',
    '1970-01-01T00:30:00+01:00',
    '2199-12-31T23:59:59-00:00',
  ])('is the moment %s names, its offset applied', (instant) => {
    expect(ms(instant)).toBe(Date.parse(instant));
  });
});

describe('instantClock', () => {
  it('is the time of day as written, and says UTC when it was written in UTC', () => {
    expect(instantClock('2026-10-07T18:42:00-07:00')).toBe('18:42');
    expect(instantClock('2026-10-08T01:42:00Z')).toBe('01:42 UTC');
    expect(instantClock('2026-10-08T01:42:00-00:00')).toBe('01:42 UTC');
    expect(instantClock('2026-10-08')).toBeNull();
  });
});

describe('readTimer', () => {
  it('counts a running timer down, rounding up so it shows 00:01 until the end', () => {
    expect(readTimer(pasta, ms(END) - 450_000)).toMatchObject({ phase: 'running', seconds: 450, over: 0, span: 540 });
    expect(readTimer(pasta, ms(END) - 1)).toMatchObject({ phase: 'running', seconds: 1 });
    expect(readTimer(pasta, ms(END) - 1000)).toMatchObject({ phase: 'running', seconds: 1 });
    expect(readTimer(pasta, ms(END) - 1001)).toMatchObject({ phase: 'running', seconds: 2 });
  });

  it('is done at exactly zero', () => {
    expect(readTimer(pasta, ms(END))).toEqual({ phase: 'done', seconds: 0, over: 0, gone: 1, span: 540 });
  });

  it('past zero it stays done and counts how long ago it ended', () => {
    expect(readTimer(pasta, ms(END) + 999)).toMatchObject({ phase: 'done', seconds: 0, over: 0 });
    expect(readTimer(pasta, ms(END) + 75_000)).toMatchObject({ phase: 'done', seconds: 0, over: 75 });
  });

  it('measures the share gone over startedAt..endsAt', () => {
    expect(readTimer(pasta, ms(END) - 450_000).gone).toBeCloseTo(90 / 540);
  });

  it('a start still to come reads as none gone, and the countdown still runs to endsAt', () => {
    const early = ms('2026-10-07T18:30:00-07:00');
    expect(readTimer(pasta, early)).toMatchObject({ phase: 'running', seconds: 720, gone: 0 });
  });

  it('a timer with no start has no share gone', () => {
    const reminder: Timer = { id: 'leave', label: 'Leave', endsAt: END };
    expect(readTimer(reminder, ms(END) - 60_000)).toMatchObject({ phase: 'running', seconds: 60, gone: null, span: null });
    expect(readTimer(reminder, ms(END) + 5000)).toMatchObject({ phase: 'done', gone: null });
  });

  it('a paused timer is frozen at its remaining, whatever the clock, and never done', () => {
    const bread: Timer = { id: 'bread', label: 'Bread', startedAt: '2026-10-07T18:00:00-07:00', endsAt: '2026-10-07T18:45:00-07:00', state: 'paused', remaining: 1260 };
    const before = readTimer(bread, ms('2026-10-07T18:10:00-07:00'));
    const after = readTimer(bread, ms('2026-10-07T23:00:00-07:00'));
    expect(before).toEqual(after);
    expect(before).toMatchObject({ phase: 'paused', seconds: 1260, over: 0, span: 2700 });
    expect(before.gone).toBeCloseTo(1 - 1260 / 2700);
    expect(readTimer({ ...bread, remaining: 0 }, 0)).toMatchObject({ phase: 'paused', seconds: 0 });
    expect(readTimer({ ...bread, remaining: 12.2 }, 0)).toMatchObject({ seconds: 13 });
  });

  it('applies offsets: one moment written two ways ends at once', () => {
    const utc: Timer = { ...pasta, startedAt: '2026-10-08T01:33:00Z', endsAt: '2026-10-08T01:42:00Z' };
    for (const now of [ms(END) - 5000, ms(END), ms(END) + 5000]) expect(readTimer(utc, now)).toEqual(readTimer(pasta, now));
  });
});

describe('formatCountdown', () => {
  it.each([
    [0, '00:00'],
    [1, '00:01'],
    [59, '00:59'],
    [450, '07:30'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [4500, '1:15:00'],
    [86_399, '23:59:59'],
    [86_400, '1D 00:00:00'],
    [3 * 86_400 + 3723, '3D 01:02:03'],
    [-5, '00:00'],
  ])('%i seconds read %s', (seconds, text) => {
    expect(formatCountdown(seconds)).toBe(text);
  });
});

describe('timerLayout', () => {
  it('draws one timer as large as its box allows, up to the cap', () => {
    expect(timerLayout(1000, 600, 1, 5)).toEqual({ kind: 'grid', columns: 1, rows: 1, digits: 200 });
    expect(timerLayout(320, 300, 1, 5)).toMatchObject({ kind: 'grid', columns: 1, digits: Math.floor(320 / (5 * 0.62)) });
  });

  it('chooses the columns that give the largest digits', () => {
    // A wide stage: three across in two rows beats two across in three.
    expect(timerLayout(1700, 750, 5, 5)).toMatchObject({ kind: 'grid', columns: 3, rows: 2 });
    // Longer countdowns want wider cells: two across in three rows.
    expect(timerLayout(1700, 750, 5, 7)).toMatchObject({ kind: 'grid', columns: 2, rows: 3 });
    // A tall one: one column.
    expect(timerLayout(700, 1400, 4, 5)).toMatchObject({ kind: 'grid', columns: 1, rows: 4 });
  });

  it('never sets a cell beside another narrower than its label needs', () => {
    const layout = timerLayout(2 * MIN_CELL_WIDTH + CELL_GAP - 1, 400, 2, 5);
    expect(layout).toMatchObject({ kind: 'grid', columns: 1, rows: 2 });
  });

  it('lists the timers where no grid gives readable digits', () => {
    expect(timerLayout(240, 200, 3, 5)).toEqual({ kind: 'list' });
    expect(timerLayout(314, 420, 5, 7)).toEqual({ kind: 'list' });
    expect(timerLayout(0, 0, 3, 5)).toEqual({ kind: 'list' });
  });

  it('every grid it chooses has digits of at least the floor', () => {
    for (let width = 100; width <= 2600; width += 70) {
      for (let height = 80; height <= 1200; height += 55) {
        for (let count = 1; count <= 8; count += 1) {
          const layout = timerLayout(width, height, count, 7);
          if (layout.kind === 'grid') {
            expect(layout.digits).toBeGreaterThanOrEqual(MIN_CELL_DIGITS);
            expect(layout.columns * layout.rows).toBeGreaterThanOrEqual(count);
          }
        }
      }
    }
  });
});

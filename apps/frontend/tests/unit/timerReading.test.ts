import { describe, expect, it } from 'vitest';
import type { Timer } from '../../src/controller/types';
import { parseTimeValue } from '../../src/controller/validation';
import {
  CELL_GAP,
  formatCountdown,
  instantClock,
  instantMs,
  MAX_COUNTDOWN,
  MIN_CELL_DIGITS,
  MIN_CELL_WIDTH,
  readTimer,
  timerGridLeast,
  timerLayout,
  timerPhase,
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
    expect(readTimer({ ...bread, remaining: 1e20 }, 0)).toMatchObject({ phase: 'paused', seconds: MAX_COUNTDOWN, gone: 0 });
  });

  it('applies offsets: one moment written two ways ends at once', () => {
    const utc: Timer = { ...pasta, startedAt: '2026-10-08T01:33:00Z', endsAt: '2026-10-08T01:42:00Z' };
    for (const now of [ms(END) - 5000, ms(END), ms(END) + 5000]) expect(readTimer(utc, now)).toEqual(readTimer(pasta, now));
  });
});

describe('timerPhase', () => {
  it('is where in each second the reading turns: the fraction of a second its end falls on', () => {
    expect(timerPhase(pasta)).toBe(0);
    expect(timerPhase({ ...pasta, endsAt: '2026-10-08T01:42:00.250Z' })).toBe(250);
    // To the microsecond, as the skill writes it, and past the millisecond.
    expect(timerPhase({ ...pasta, endsAt: '2026-10-06T17:42:50.368277+00:00' })).toBe(368);
    expect(timerPhase({ ...pasta, endsAt: '2026-10-08T07:12:00.999999999+05:30' })).toBe(999);
  });

  it('matches the reading: the digits change on it, and nowhere else in the second', () => {
    const tea: Timer = { id: 'tea', label: 'Tea', endsAt: '2026-10-08T01:42:00.250Z' };
    const end = ms(tea.endsAt);
    const turns: number[] = [];
    for (let at = end - 5000; at < end + 3000; at += 1) {
      const before = readTimer(tea, at - 1);
      const now = readTimer(tea, at);
      if (before.seconds !== now.seconds || before.over !== now.over || before.phase !== now.phase) turns.push(((at % 1000) + 1000) % 1000);
    }
    expect(turns.length).toBeGreaterThan(0);
    expect(new Set(turns)).toEqual(new Set([timerPhase(tea)]));
  });

  it('is none for a paused timer, which does not turn', () => {
    expect(timerPhase({ ...pasta, state: 'paused', remaining: 60 })).toBeNull();
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

  // review-views L1: the wire bounds `remaining` below only, and a paused
  // timer drew 1e20 as `1157407407407407D 09:46:40` and 1e300 in exponent
  // form. The page holds a countdown to the longest two instants can span
  // (1970-01-01 to 2200-01-01).
  it('holds a countdown to the longest span two instants make', () => {
    expect(MAX_COUNTDOWN).toBe(84_006 * 86_400);
    expect(formatCountdown(MAX_COUNTDOWN)).toBe('84006D 00:00:00');
    expect(formatCountdown(1e20)).toBe('84006D 00:00:00');
    expect(formatCountdown(1e300)).toBe('84006D 00:00:00');
    expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe('84006D 00:00:00');
    expect(formatCountdown(Number.NaN)).toBe('00:00');
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

// The height the timers ask of a box sized by what they ask (an aux cell)
// where a grid of readable cells needs less than their rows: a function of
// the width alone, and one at which timerLayout surely draws that grid.
describe('timerGridLeast', () => {
  // The least whole height timerLayout draws a grid in, by search.
  const threshold = (width: number, count: number, chars: number) => {
    for (let height = 1; height <= 4000; height += 1) if (timerLayout(width, height, count, chars).kind === 'grid') return height;
    return null;
  };

  it('is a height timerLayout draws a grid in, even read a pixel short, and every height above it', () => {
    for (let width = 120; width <= 2600; width += 37) {
      for (let count = 1; count <= 8; count += 1) {
        for (const chars of [5, 7, 11]) {
          const least = timerGridLeast(width, count, chars);
          if (least === null) continue;
          for (let height = least - 1; height <= least + 400; height += 7) {
            expect(timerLayout(width, height, count, chars).kind, `${width} ${count} ${chars} at ${height}`).toBe('grid');
          }
        }
      }
    }
  });

  it('is no more than a few pixels above the least height that draws a grid', () => {
    for (let width = 120; width <= 2600; width += 113) {
      for (let count = 1; count <= 8; count += 1) {
        for (const chars of [5, 7, 11]) {
          const least = timerGridLeast(width, count, chars);
          const found = threshold(width, count, chars);
          if (least === null) continue;
          // Half a pixel of digits a row of cells (0.55 px of height), rounded up, and one to spare.
          expect(least - found!, `${width} ${count} ${chars}`).toBeGreaterThanOrEqual(1);
          expect(least - found!, `${width} ${count} ${chars}`).toBeLessThanOrEqual(Math.ceil(count * 0.55) + 2);
        }
      }
    }
  });

  it('is null only where no height gives the width a grid', () => {
    expect(timerGridLeast(200, 2, 11)).toBeNull();
    expect(timerLayout(200, 4000, 2, 11)).toEqual({ kind: 'list' });
    expect(timerGridLeast(0, 3, 5)).toBeNull();
    expect(timerGridLeast(730, 0, 5)).toBeNull();
    // Five MM:SS timers at 730 px: three across, two rows of the least cells.
    expect(timerGridLeast(730, 5, 5)).toBe(Math.ceil(2 * (78 + 1.1 * (MIN_CELL_DIGITS + 0.5)) + CELL_GAP) + 1);
  });
});

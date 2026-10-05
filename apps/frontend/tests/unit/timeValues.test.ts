import { describe, expect, it } from 'vitest';
import { compareTimeValues, parseTimeValue, type TimeValue } from '../../src/controller/validation';

// The page's one time parser (docs/display-tool.md, "Time values"). The
// shared corpus pins which texts both validators accept; this pins what the
// parser reads out of them, which the renderers draw from.
describe('parseTimeValue', () => {
  it('reads a date, a wall time and an instant into their fields', () => {
    expect(parseTimeValue('2026-10-05')).toEqual({
      form: 'date', year: 2026, month: 10, day: 5, hour: 0, minute: 0, second: 0, nanos: 0, offset: 0, dayNumber: 20731,
    });
    expect(parseTimeValue('2026-10-07T09:40')).toMatchObject({ form: 'wall', day: 7, hour: 9, minute: 40, second: 0, offset: 0 });
    expect(parseTimeValue('2026-10-05T18:42:07.25-07:00')).toMatchObject({
      form: 'instant', hour: 18, minute: 42, second: 7, nanos: 250_000_000, offset: -420,
    });
    expect(parseTimeValue('2026-10-06T07:12:00+05:30')).toMatchObject({ offset: 330 });
  });

  it('counts days from 1970-01-01, so a weekday is (dayNumber + 4) mod 7 from Sunday', () => {
    const days: Array<[string, number, number]> = [
      ['1970-01-01', 0, 4],
      ['2000-02-29', 11016, 2],
      ['2026-10-05', 20731, 1],
      ['2100-03-01', 47541, 1],
      ['2199-12-31', 84005, 2],
    ];
    for (const [text, dayNumber, weekday] of days) {
      const time = parseTimeValue(text) as TimeValue;
      expect(time.dayNumber, text).toBe(dayNumber);
      expect((time.dayNumber + 4) % 7, text).toBe(weekday);
    }
  });

  it('reads `Z` and `-00:00` as UTC, with no negative zero', () => {
    expect(Object.is(parseTimeValue('2026-10-05T18:42:00-00:00')?.offset, 0)).toBe(true);
    expect(parseTimeValue('2026-10-05T18:42:00Z')?.offset).toBe(0);
  });

  it('reads nothing that is not one of the three forms', () => {
    for (const text of ['2026-02-29', '2026-10-05T24:00', '2026-10-05T09:00:00', '2026-10-05t09:00', '2026-10-05T18:42:00z', 20261005, null]) {
      expect(parseTimeValue(text), String(text)).toBeNull();
    }
  });
});

describe('compareTimeValues', () => {
  const at = (text: string) => parseTimeValue(text) as TimeValue;

  it('orders dates by day and wall times by minute', () => {
    expect(compareTimeValues(at('2026-10-05'), at('2026-10-06'))).toBeLessThan(0);
    expect(compareTimeValues(at('2026-10-06T00:00'), at('2026-10-05T23:59'))).toBeGreaterThan(0);
    expect(compareTimeValues(at('2026-10-05T09:30'), at('2026-10-05T09:30'))).toBe(0);
  });

  it('orders instants by the moment they name, offsets applied, then by their fraction', () => {
    expect(compareTimeValues(at('2026-10-05T18:42:00-07:00'), at('2026-10-06T01:42:00Z'))).toBe(0);
    expect(compareTimeValues(at('2026-10-06T02:30:00+01:00'), at('2026-10-05T18:42:00-07:00'))).toBeLessThan(0);
    expect(compareTimeValues(at('2026-10-05T18:42:00.000000001Z'), at('2026-10-05T18:42:00Z'))).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';
import type { WeatherData, WeatherHour } from '../../src/controller/types';
import {
  ALERT_LINE,
  INLINE_HERO_HEIGHT,
  SPOT_LINE,
  STACKED_HERO_HEIGHT,
  COMPACT_HEIGHT,
  COMPACT_LIST_HEIGHT,
  COMPACT_STRIP_HEIGHT,
  COMPACT_WIDTH,
  dayLabel,
  dayLong,
  dayRange,
  dayScale,
  formatTemp,
  heroEms,
  heroTempFit,
  HOUR_LABEL_SPACING,
  hourLabel,
  hourLabelStep,
  hourLong,
  labelledHours,
  OUTLOOK_COLUMN,
  OUTLOOK_GAP,
  OUTLOOK_HEIGHT,
  OUTLOOK_SPACE,
  OUTLOOK_TEMP_LEAST,
  outlookCount,
  outlookDays,
  outlookFigure,
  outlookOffer,
  rangeOnScale,
  placeBesideTitle,
  tempScale,
  weatherItemName,
  weatherLayout,
} from '../../src/primitives/weatherLayout';

// How a forecast is laid out for its box and written: the arrangements,
// the thinning that keeps 48 hours readable on a phone, the one scale the
// days share.

const hoursFrom = (start: number, count: number, day = 7): WeatherHour[] =>
  Array.from({ length: count }, (_, index) => {
    const hour = start + index;
    return { time: `2026-10-${String(day + Math.floor(hour / 24)).padStart(2, '0')}T${String(hour % 24).padStart(2, '0')}:00`, temp: 50 + (index % 9), condition: 'clear' as const };
  });

describe('words', () => {
  it('writes a temperature to a tenth at most, and never -0', () => {
    expect(formatTemp(61)).toBe('61');
    expect(formatTemp(61.44)).toBe('61.4');
    expect(formatTemp(-3.26)).toBe('-3.3');
    expect(formatTemp(-0.04)).toBe('0');
  });

  it('names days and hours as written, on the weekday their date falls on', () => {
    expect(dayLabel('2026-10-07')).toBe('WED 7');
    expect(dayLong('2026-10-08')).toBe('THU OCT 8');
    expect(dayLong('2024-02-29')).toBe('THU FEB 29');
    expect(hourLabel('2026-10-07T09:00')).toBe('09');
    expect(hourLabel('2026-10-08T00:00')).toBe('THU');
    expect(hourLong('2026-10-07T14:00')).toBe('WED 14:00');
  });

  it('names the hour or day a note names, and nothing it does not hold', () => {
    const data: WeatherData = {
      location: 'SF', units: 'F', current: { temp: 61, condition: 'fog' },
      hourly: [{ time: '2026-10-07T14:00', temp: 68, condition: 'clear' }],
      daily: [{ date: '2026-10-08', high: 61, low: 55, condition: 'rain' }],
    };
    expect(weatherItemName(data, '2026-10-07T14:00')).toBe('WED 14:00');
    expect(weatherItemName(data, '2026-10-08')).toBe('THU OCT 8');
    expect(weatherItemName(data, '2026-10-09')).toBeUndefined();
    expect(weatherItemName({ ...data, hourly: undefined, daily: undefined }, '2026-10-08')).toBeUndefined();
  });
});

describe('the place in the head', () => {
  it('beside a title naming its first part as words, whatever their case, is the rest of it', () => {
    expect(placeBesideTitle('WEATHER / SAN FRANCISCO', 'San Francisco, CA')).toBe('CA');
    expect(placeBesideTitle('WEATHER / PORTLAND', 'Portland, ME')).toBe('ME');
    expect(placeBesideTitle('Tromsø / this week', 'Tromsø')).toBe('');
  });

  it('beside any other title, or none, is the whole place', () => {
    expect(placeBesideTitle('WEATHER', 'San Francisco, CA')).toBe('San Francisco, CA');
    expect(placeBesideTitle('FRANCISCAN COAST', 'San Francisco')).toBe('San Francisco');
    expect(placeBesideTitle('WASHINGTON STATE', 'Washington, D.C.')).toBe('D.C.');
    expect(placeBesideTitle(undefined, 'San Francisco, CA')).toBe('San Francisco, CA');
    expect(placeBesideTitle('WEATHER', ', CA')).toBe(', CA');
  });
});

describe('weatherLayout', () => {
  const all = { hourly: true, daily: true };

  it('sets the conditions beside the days on a wide box, down a tall one', () => {
    expect(weatherLayout(1000, 620, all)).toMatchObject({ arrangement: 'wide', hourly: true, daily: true });
    expect(weatherLayout(1700, 760, all).arrangement).toBe('wide');
    expect(weatherLayout(740, 690, all)).toMatchObject({ arrangement: 'tall', hourly: true, daily: true });
    expect(weatherLayout(320, 460, all).arrangement).toBe('tall');
  });

  it('a small slot holds the conditions and one list: the days, or the hours a note names', () => {
    expect(weatherLayout(250, 240, all)).toMatchObject({ arrangement: 'compact', hourly: false, daily: true });
    expect(weatherLayout(250, 280, { hourly: true, daily: false })).toMatchObject({ hourly: true, daily: false });
    expect(weatherLayout(250, 280, { ...all, markedHour: true })).toMatchObject({ hourly: true, daily: false });
    expect(weatherLayout(COMPACT_WIDTH - 1, 900, all).arrangement).toBe('compact');
    expect(weatherLayout(900, COMPACT_HEIGHT - 1, all).arrangement).toBe('compact');
  });

  it('a small slot too short for the strip shows the days, or the conditions alone, never a cut strip', () => {
    // The today scene's aux cell at 1440x900 is about 220px tall: the strip
    // (120px of rows under the conditions) ran past its bottom.
    expect(weatherLayout(250, COMPACT_STRIP_HEIGHT - 1, { ...all, markedHour: true })).toMatchObject({ hourly: false, daily: true });
    expect(weatherLayout(250, COMPACT_STRIP_HEIGHT - 1, { hourly: true, daily: false })).toMatchObject({ hourly: false, daily: false });
    expect(weatherLayout(250, COMPACT_STRIP_HEIGHT, { ...all, markedHour: true })).toMatchObject({ hourly: true, daily: false });
  });

  it('a slot too short for a list row holds the conditions and the days beside them, where a column fits under the head', () => {
    // The today scene's forecast cell on a phone (334x128, with an alert)
    // showed the conditions alone.
    expect(weatherLayout(334, 128, { ...all, alert: true })).toMatchObject({ arrangement: 'compact', hourly: false, daily: false, outlook: true });
    expect(weatherLayout(340, COMPACT_LIST_HEIGHT - 1, all)).toMatchObject({ arrangement: 'compact', hourly: false, daily: false, outlook: true });
    expect(weatherLayout(340, OUTLOOK_HEIGHT, all).outlook).toBe(true);
    // An alert's line takes room above the columns.
    expect(weatherLayout(340, OUTLOOK_HEIGHT + ALERT_LINE - 1, { ...all, alert: true }).outlook).toBe(false);
    // Shorter (844x390's cell, 88px): the conditions alone, never a cut column.
    expect(weatherLayout(252, 88, { ...all, alert: true })).toMatchObject({ hourly: false, daily: false, outlook: false });
    expect(weatherLayout(340, OUTLOOK_HEIGHT - 1, all).outlook).toBe(false);
    // No days, no outlook; and a slot with room for the list lists them.
    expect(weatherLayout(340, 150, { hourly: true, daily: false }).outlook).toBe(false);
    expect(weatherLayout(250, COMPACT_LIST_HEIGHT, all)).toMatchObject({ daily: true, outlook: false });
    expect(weatherLayout(1000, 620, all).outlook).toBe(false);
  });

  it('keeps the room for the spot line of a day a note names where no outlook stands to hold it', () => {
    // 340x120 with an alert: no outlook; stacked, the figure and the day's line ran past the foot.
    expect(weatherLayout(340, 120, { ...all, alert: true, markedDay: true })).toMatchObject({ outlook: false, inline: true, alertLine: true });
    expect(weatherLayout(340, 120, { ...all, alert: true })).toMatchObject({ outlook: false, inline: false, alertLine: true });
    // The outlook holds the day: no line to keep room for.
    expect(weatherLayout(334, 128, { ...all, alert: true, markedDay: true })).toMatchObject({ outlook: true, inline: false });
  });

  it('gives the alert\'s line to the item a note names where the slot is too short for both', () => {
    // The today scene's forecast cell at 844x390 (252x88): the head, the
    // alert's line and the figure on one line filled it, and the hour's
    // line under them was cut.
    const short = INLINE_HERO_HEIGHT + ALERT_LINE + SPOT_LINE;
    expect(weatherLayout(252, 88, { ...all, alert: true, markedHour: true })).toMatchObject({ alertLine: false, inline: true, outlook: false });
    expect(weatherLayout(252, short - 1, { ...all, alert: true, markedDay: true, ahead: false })).toMatchObject({ alertLine: false, inline: false });
    // Tall enough for both, or with no item to show, the alert keeps its line.
    expect(weatherLayout(252, short, { ...all, alert: true, markedHour: true })).toMatchObject({ alertLine: true, inline: true });
    expect(weatherLayout(252, 88, { ...all, alert: true })).toMatchObject({ alertLine: true, inline: true });
    // Given up, its room may let the outlook stand and hold the day there.
    expect(weatherLayout(340, 110, { ...all, alert: true, markedDay: true })).toMatchObject({ alertLine: false, outlook: true });
    // No alert, nothing to give.
    expect(weatherLayout(252, 88, { ...all, markedHour: true }).alertLine).toBe(false);
    expect(weatherLayout(1000, 620, { ...all, alert: true }).alertLine).toBe(true);
  });

  it('stands an outlook only where a whole column fits beside the figure, counted from its temperature row and its condition line', () => {
    // A 219px cell (the today scene with a fourth cell beside it, 820x1180):
    // the figure's condition line, 130px beside a 26px glyph, left no
    // column, and the marked day stood on a spot line the layout had not
    // kept room for.
    const cell = { ...all, alert: true, markedDay: true, temp: '61', condition: 130 };
    expect(weatherLayout(219, 176, cell)).toMatchObject({ outlook: false, figure: 0 });
    // The same cell with a short condition line: a column fits.
    const roomy = weatherLayout(219, 176, { ...cell, condition: 40 });
    expect(roomy.outlook).toBe(true);
    expect(219 - OUTLOOK_SPACE - roomy.figure).toBeGreaterThanOrEqual(OUTLOOK_COLUMN);
    expect(roomy.figure).toBe(outlookFigure(roomy.temp, '61', 40));
    // The temperature row counts by its digits (heroEms, its gap the compact
    // figure's 10px): `-12.5` needs more room than `61`.
    expect(outlookFigure(28, '-12.5', 0)).toBe(Math.ceil(28 * (heroEms('-12.5') - 0.24) + 10));
    expect(outlookFigure(28, '-12.5', 0)).toBeGreaterThan(outlookFigure(28, '61', 0));
    // A slot whose column would leave the figure under a compact figure's least holds none.
    const narrow = OUTLOOK_SPACE + OUTLOOK_COLUMN + Math.floor((OUTLOOK_TEMP_LEAST - 1) * heroEms('-12.5'));
    expect(weatherLayout(narrow, 128, { ...all, temp: '-12.5' }).outlook).toBe(false);
  });

  it('stands no outlook where it has no day to come to show', () => {
    expect(weatherLayout(334, 128, { ...all, ahead: false }).outlook).toBe(false);
  });

  it('keeps the room for the spot line of an hour a note names, which no list there draws', () => {
    expect(weatherLayout(334, 128, { ...all, alert: true, markedHour: true }).outlook).toBe(false);
    expect(weatherLayout(334, OUTLOOK_HEIGHT + ALERT_LINE + SPOT_LINE, { ...all, alert: true, markedHour: true }).outlook).toBe(true);
  });

  it('sets the condition beside the temperature where the slot is too short to stack them', () => {
    // 844x390's forecast cell, 88px with an alert: stacked, the condition
    // and the high and low ran past its foot.
    expect(weatherLayout(252, 88, { ...all, alert: true }).inline).toBe(true);
    expect(weatherLayout(252, STACKED_HERO_HEIGHT - 1, all).inline).toBe(true);
    expect(weatherLayout(252, STACKED_HERO_HEIGHT, all).inline).toBe(false);
    expect(weatherLayout(334, 128, { ...all, alert: true }).inline).toBe(false);
    expect(weatherLayout(250, 240, all).inline).toBe(false);
    expect(weatherLayout(0, 0, all).inline).toBe(false);
  });

  it('sets the conditions larger when they stand alone', () => {
    const alone = weatherLayout(1000, 620, { hourly: false, daily: false });
    expect(alone).toMatchObject({ arrangement: 'wide', hourly: false, daily: false });
    expect(alone.temp).toBeGreaterThan(weatherLayout(1000, 620, all).temp);
    expect(weatherLayout(3000, 1400, { hourly: false, daily: false }).temp).toBe(160);
  });

  it('draws everything before the box is measured', () => {
    expect(weatherLayout(0, 0, all)).toMatchObject({ hourly: false, daily: true });
  });

  it('keeps the hero temperature large and in bounds', () => {
    for (const [width, height] of [[250, 220], [320, 460], [740, 690], [1000, 620], [1700, 760], [3000, 1400]]) {
      const { temp, arrangement } = weatherLayout(width, height, all);
      expect(temp).toBeGreaterThanOrEqual(arrangement === 'compact' ? 26 : 44);
      expect(temp).toBeLessThanOrEqual(132);
    }
  });
});

describe('the outlook', () => {
  it('shows as many days as whole columns fit its width, none cut at the edge', () => {
    const columns = (count: number) => count * OUTLOOK_COLUMN + (count - 1) * OUTLOOK_GAP;
    expect(outlookCount(columns(3), 10)).toBe(3);
    expect(outlookCount(columns(3) - 1, 10)).toBe(2);
    expect(outlookCount(columns(12), 10)).toBe(10);
    expect(outlookCount(OUTLOOK_COLUMN - 1, 10)).toBe(0);
    expect(outlookCount(0, 10)).toBe(0);
  });

  it('offers the days after the forecast\'s today', () => {
    const dates = (offered: Array<{ date: string }>) => offered.map((day) => day.date);
    const week = [
      { date: '2026-10-06', high: 66, low: 52 },
      { date: '2026-10-07', high: 70, low: 55 },
      { date: '2026-10-08', high: 68, low: 54 },
      { date: '2026-10-09', high: 61, low: 55 },
    ];
    // Today and the day before go, whatever their numbers; the days after stay.
    expect(dates(outlookOffer(week, { current: { high: 68, low: 54 }, today: '2026-10-07' }))).toEqual(['2026-10-08', '2026-10-09']);
    // A forecast that opens on tomorrow with today's numbers keeps tomorrow:
    // the numbers are no longer taken for today.
    expect(dates(outlookOffer(week.slice(2), { current: { high: 68, low: 54 }, today: '2026-10-07' }))).toEqual(['2026-10-08', '2026-10-09']);
    // A day a note names stays, in its place, today included.
    expect(dates(outlookOffer(week, { current: {}, today: '2026-10-07' }, '2026-10-07'))).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
    // A today past every day leaves none to come.
    expect(outlookOffer(week, { current: {}, today: '2026-10-20' })).toEqual([]);
  });

  it('without today, takes a first day whose high and low the figure shows for today and leaves it out', () => {
    const days = [{ date: '2026-10-07', high: 68, low: 54 }, { date: '2026-10-08', high: 61, low: 55 }];
    const dates = (offered: Array<{ date: string }>) => offered.map((day) => day.date);
    expect(dates(outlookOffer(days, { current: { high: 68, low: 54 } }))).toEqual(['2026-10-08']);
    // Not said by the figure: a different high, or none.
    expect(dates(outlookOffer(days, { current: { high: 70, low: 54 } }))).toEqual(['2026-10-07', '2026-10-08']);
    expect(dates(outlookOffer(days, { current: {} }))).toEqual(['2026-10-07', '2026-10-08']);
    // A day a note names stays, in its place.
    expect(dates(outlookOffer(days, { current: { high: 68, low: 54 } }, '2026-10-07'))).toEqual(['2026-10-07', '2026-10-08']);
    expect(outlookOffer([], { current: { high: 68, low: 54 } })).toEqual([]);
  });

  it('shows the first days, and a day a note names past them in the last column', () => {
    const days = ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'].map((date) => ({ date }));
    const dates = (shown: Array<{ date: string }>) => shown.map((day) => day.date);
    expect(dates(outlookDays(days, 3))).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
    expect(dates(outlookDays(days, 3, '2026-10-08'))).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
    expect(dates(outlookDays(days, 3, '2026-10-11'))).toEqual(['2026-10-07', '2026-10-08', '2026-10-11']);
    expect(dates(outlookDays(days, 3, '2026-10-20'))).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
    expect(outlookDays(days, 0, '2026-10-11')).toEqual([]);
  });
});

describe('the hero', () => {
  it('sizes its temperature so the glyph, the digits and the unit fit the column', () => {
    // "-12.5" at 160px would need 160 * heroEms > 700px; a 340px column gets less.
    expect(heroTempFit(340, '-12.5', 160) * heroEms('-12.5')).toBeLessThanOrEqual(340);
    expect(heroTempFit(340, '-12.5', 160)).toBeLessThan(160);
    // Room to spare keeps the layout's size.
    expect(heroTempFit(1200, '61', 132)).toBe(132);
    // Not measured yet: the layout's size.
    expect(heroTempFit(0, '-12.5', 64)).toBe(64);
    expect(heroEms('-12.5')).toBeGreaterThan(heroEms('61'));
  });
});

describe('the hourly strip', () => {
  it('labels every hour where there is room, fewer as it narrows', () => {
    expect(hourLabelStep(900, 24)).toBe(1);
    expect(hourLabelStep(300, 24)).toBe(3);
    expect(hourLabelStep(300, 48)).toBe(6);
    expect(hourLabelStep(0, 24)).toBe(1);
  });

  it('labels the clock multiples of its step, the first hour, each midnight and the marked hour, a step apart', () => {
    const hours = hoursFrom(10, 24);
    const labelled = labelledHours(hours, 3);
    expect(hours.filter((_, index) => labelled[index]).map((hour) => hour.time.slice(11, 13))).toEqual(['10', '15', '18', '21', '00', '03', '06', '09']);
    const marked = labelledHours(hours, 3, hours[3].time);
    expect(hours.filter((_, index) => marked[index]).map((hour) => hour.time.slice(11, 13))).toEqual(['10', '13', '18', '21', '00', '03', '06', '09']);
    // A midnight beside the marked hour gives way to it; a first hour
    // beside a midnight gives way to the day's name.
    const late = hoursFrom(23, 6);
    expect(labelledHours(late, 3, late[2].time)).toEqual([false, false, true, false, false, false]);
    expect(labelledHours(late, 3)).toEqual([false, true, false, false, true, false]);
  });

  it('counts entries when the hours do not run one after another', () => {
    const sparse: WeatherHour[] = ['00', '03', '06', '09', '12', '15'].map((h) => ({ time: `2026-10-07T${h}:00`, temp: 50, condition: 'clear' }));
    expect(labelledHours(sparse, 2)).toEqual([true, false, true, false, true, false]);
  });

  it('keeps 48 hours readable on a phone: labels a step apart, the step wide enough', () => {
    for (const width of [280, 320, 360, 740, 1300]) {
      const hours = hoursFrom(10, 48);
      const step = hourLabelStep(width, hours.length);
      const column = width / hours.length;
      const at = labelledHours(hours, step, hours[17].time).flatMap((shown, index) => (shown ? [index] : []));
      expect(at).toContain(17);
      for (let index = 1; index < at.length; index += 1) {
        expect((at[index] - at[index - 1]) * column).toBeGreaterThanOrEqual(HOUR_LABEL_SPACING - 1e-9);
      }
    }
  });

  it('draws the temperatures over their padded range, never narrower than the least span', () => {
    expect(tempScale([50, 60])).toEqual({ min: 48.8, max: 61.2 });
    expect(tempScale([55, 55])).toEqual({ min: 54, max: 56 });
    // A quiet day: a 2-degree wobble on a 10-degree scale, not a mountain.
    expect(tempScale([55, 57], 10)).toEqual({ min: 51, max: 61 });
    expect(tempScale([40, 70], 10)).toEqual({ min: 36.4, max: 73.6 });
  });
});

describe('the daily list', () => {
  const days = [
    { high: 68, low: 54 },
    { high: 61, low: 55 },
    { high: 66, low: 52 },
  ];

  it('draws every range on one scale, the lowest low to the highest high', () => {
    const scale = dayScale(days);
    expect(scale).toEqual({ min: 52, max: 68 });
    expect(rangeOnScale(days[0], scale)).toEqual({ from: 12.5, to: 100 });
    expect(rangeOnScale(days[1], scale)).toEqual({ from: 18.75, to: 56.25 });
    expect(rangeOnScale(days[2], scale)).toEqual({ from: 0, to: 87.5 });
  });

  it('a single flat day still has a scale, and a low above a high is drawn the right way round', () => {
    expect(dayScale([{ high: 5, low: 5 }])).toEqual({ min: 4, max: 6 });
    expect(rangeOnScale({ high: 50, low: 60 }, { min: 40, max: 80 })).toEqual({ from: 25, to: 50 });
  });

  it('a day whose low is its high still draws a bar, inside the track', () => {
    expect(rangeOnScale({ high: 5, low: 5 }, { min: 4, max: 6 })).toEqual({ from: 49.25, to: 50.75 });
    expect(rangeOnScale({ high: 6, low: 6 }, { min: 6, max: 10 })).toEqual({ from: 0, to: 1.5 });
    expect(rangeOnScale({ high: 10, low: 10 }, { min: 6, max: 10 })).toEqual({ from: 98.5, to: 100 });
  });

  it("the list names the days' own range, not the padded scale", () => {
    expect(dayRange([{ high: 20, low: 20 }, { high: 20, low: 20 }])).toEqual({ min: 20, max: 20 });
    expect(dayRange(days)).toEqual({ min: 52, max: 68 });
    expect(dayRange([])).toBeNull();
  });
});

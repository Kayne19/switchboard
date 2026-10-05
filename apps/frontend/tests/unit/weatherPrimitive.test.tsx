// @vitest-environment jsdom
// A forecast drawn by its own primitive: the conditions now as the hero,
// the hours as a strip, the days as rows on one shared scale, an alert in
// the warning colour, and the hour or day a note names marked wherever
// the forecast stands. jsdom lays nothing out, so the box's size is given
// where the arrangement matters.
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WeatherData } from '../../src/controller/types';
import { WeatherPrimitive } from '../../src/primitives/WeatherPrimitive';
import { heroEms } from '../../src/primitives/weatherLayout';

const forecast: WeatherData = {
  location: 'San Francisco, CA', units: 'F',
  current: { temp: 61, condition: 'fog', summary: 'Fog burning off by noon', high: 68, low: 54, feelsLike: 59, humidity: 84, precip: 10, wind: 'W 12 mph' },
  hourly: Array.from({ length: 24 }, (_, index) => ({
    time: `2026-10-${index < 14 ? '07' : '08'}T${String((10 + index) % 24).padStart(2, '0')}:00`,
    temp: 60 + (index % 6), condition: index < 12 ? 'clear' : 'rain', precip: index * 4,
  })),
  daily: [
    { date: '2026-10-07', high: 68, low: 54, condition: 'partly-cloudy', precip: 20 },
    { date: '2026-10-08', high: 61, low: 55, condition: 'rain', precip: 80 },
    { date: '2026-10-09', high: 66, low: 52, condition: 'clear' },
  ],
  alert: 'Small craft advisory on the bay until 21:00',
};

let host: HTMLElement | undefined;
let root: Root | undefined;
const box = { width: 0, height: 0 };

function render(data: WeatherData, marked?: string, size = { width: 0, height: 0 }): HTMLElement {
  Object.assign(box, size);
  const element = document.createElement('div');
  document.body.append(element);
  host = element;
  root = createRoot(element);
  act(() => root!.render(<WeatherPrimitive data={data} marked={marked} />));
  return element;
}

const marks = (scope: HTMLElement) => [...scope.querySelectorAll('.note-badge')].map((badge) => badge.closest('[data-item]')!.getAttribute('data-item'));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // The box the forecast measures: the one this test gives.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => box.width });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => box.height });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe('the conditions now', () => {
  it('draw the temperature, the condition, the summary, the readings and the location', () => {
    const page = render(forecast, undefined, { width: 1000, height: 620 });
    const now = page.querySelector('.weather-now')!;
    expect(now.querySelector('.weather-now__temp')!.textContent).toBe('61°F');
    expect(now.querySelector('.weather-now__glyph')!.getAttribute('aria-label')).toBe('fog');
    expect(now.querySelector('.weather-now__condition')!.textContent).toBe('fogH 68° L 54°');
    expect(now.querySelector('.weather-now__summary')!.textContent).toBe('Fog burning off by noon');
    expect([...now.querySelectorAll('.weather-now__reading')].map((reading) => reading.textContent)).toEqual([
      'FEELS LIKE59°', 'HUMIDITY84%', 'PRECIP10%', 'WINDW 12 mph',
    ]);
    expect(now.querySelector('.weather-now__location')!.textContent).toBe('San Francisco, CA');
  });

  it('carry the alert on the warning rule, in amber', () => {
    const page = render(forecast);
    expect(page.querySelector('.weather-alert')!.textContent).toBe('ALERTSmall craft advisory on the bay until 21:00');
    const css = readFileSync(`${import.meta.dirname}/../../src/styles/index.css`, 'utf8');
    const rule = /\n\.weather-alert \{([^}]*)\}/.exec(css)![1];
    expect(rule).toMatch(/border-left: 2px solid var\(--amber\)/);
    expect(rule).toMatch(/color: var\(--amber\)/);
  });

  it('size the temperature so its row fits the column: a cold reading in tenths takes less', () => {
    const cold = { ...forecast, current: { ...forecast.current, temp: -12.5 } };
    const page = render(cold, undefined, { width: 340, height: 700 });
    const size = parseFloat(page.querySelector<HTMLElement>('.weather-now__main')!.style.getPropertyValue('--weather-temp'));
    expect(size * heroEms('-12.5')).toBeLessThanOrEqual(340);
    expect(size).toBeGreaterThan(30);
  });

  it('stand alone in the middle of the box when there is no forecast to list', () => {
    const page = render({ ...forecast, hourly: [], daily: undefined, alert: undefined }, undefined, { width: 1000, height: 620 });
    expect(page.querySelector('.weather__field')!.getAttribute('data-parts')).toBe('now');
    expect(page.querySelector('.weather-hourly, .weather-daily, .weather-alert')).toBeNull();
  });
});

describe('the days', () => {
  it('stand on one scale: each range is the share of the lowest low to the highest high', () => {
    const page = render(forecast, undefined, { width: 1000, height: 620 });
    const rows = [...page.querySelectorAll<HTMLElement>('.weather-day')];
    expect(rows.map((row) => row.getAttribute('data-item'))).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
    const ranges = rows.map((row) => {
      const range = row.querySelector<HTMLElement>('.weather-day__range')!;
      return [range.style.getPropertyValue('--from'), range.style.getPropertyValue('--to')];
    });
    expect(ranges).toEqual([['12.5%', '100%'], ['18.75%', '56.25%'], ['0%', '87.5%']]);
    expect(rows.map((row) => row.querySelector('.weather-day__name')!.textContent)).toEqual(['WED 7', 'THU 8', 'FRI 9']);
    expect(rows.map((row) => row.querySelector('.weather-day__precip')!.textContent)).toEqual(['20%', '80%', '-']);
  });
});

describe('flat days', () => {
  it('still draw a bar, and the head names the days, not the padded scale', () => {
    const flat = { ...forecast, daily: [{ date: '2026-10-07', high: 20, low: 20, condition: 'fog' as const }, { date: '2026-10-08', high: 20, low: 20, condition: 'fog' as const }] };
    const page = render(flat, undefined, { width: 1000, height: 620 });
    expect(page.querySelector('.weather-daily .weather-section__head')!.textContent).toBe('DAILY20° TO 20°');
    for (const range of page.querySelectorAll<HTMLElement>('.weather-day__range')) {
      expect(parseFloat(range.style.getPropertyValue('--to')) - parseFloat(range.style.getPropertyValue('--from'))).toBeGreaterThan(0);
    }
  });
});

describe('the arrangement follows the box', () => {
  it.each([
    [{ width: 1000, height: 620 }, 'wide', 'now hourly daily'],
    [{ width: 740, height: 690 }, 'tall', 'now hourly daily'],
    [{ width: 250, height: 240 }, 'compact', 'now daily'],
    [{ width: 340, height: 150 }, 'compact', 'now'],
  ])('%o is %s, holding %s', (size, arrangement, parts) => {
    const page = render(forecast, undefined, size);
    expect(page.querySelector('[data-testid="weather"]')!.getAttribute('data-layout')).toBe(arrangement);
    expect(page.querySelector('.weather__field')!.getAttribute('data-parts')).toBe(parts);
  });

  it('down a tall box the conditions, the hours and the days stand in one scroll', () => {
    const page = render(forecast, undefined, { width: 740, height: 690 });
    const scroll = page.querySelector('.weather__scroll')!;
    expect(scroll.querySelectorAll('.weather-now, .weather-hourly, .weather-day').length).toBe(5);
  });
});

describe('a note on one hour or day', () => {
  it.each([
    [{ width: 1000, height: 620 }],
    [{ width: 740, height: 690 }],
    [{ width: 250, height: 240 }],
  ])('marks the day it names at %o', (size) => {
    expect(marks(render(forecast, '2026-10-08', size))).toEqual(['2026-10-08']);
  });

  it('marks the hour it names, and labels it, in the strip', () => {
    const page = render(forecast, '2026-10-07T13:00', { width: 1000, height: 620 });
    expect(marks(page)).toEqual(['2026-10-07T13:00']);
    const hour = page.querySelector('[data-item="2026-10-07T13:00"]')!;
    expect(hour.className).toContain('weather-hour--marked');
    expect(hour.querySelector('.weather-hour__time')!.textContent).toBe('13');
  });

  it('a small slot shows the hours, not the days, when the note names an hour and the strip has room', () => {
    const page = render(forecast, '2026-10-07T13:00', { width: 250, height: 280 });
    expect(page.querySelector('.weather__field')!.getAttribute('data-parts')).toBe('now hourly');
    expect(marks(page)).toEqual(['2026-10-07T13:00']);
  });

  it('marks nothing for a time the forecast does not hold', () => {
    expect(marks(render(forecast, '2026-10-20', { width: 1000, height: 620 }))).toEqual([]);
  });
});

describe('the hours', () => {
  it('label midnight with the new day, and every hour where the strip is wide', () => {
    const page = render(forecast, undefined, { width: 1000, height: 620 });
    const times = [...page.querySelectorAll('.weather-hour__time')].map((time) => time.textContent);
    expect(times[0]).toBe('10');
    expect(times[14]).toBe('THU');
    expect(page.querySelector('[data-item="2026-10-08T00:00"]')!.className).toContain('weather-hour--day');
    // 1000px measured for every box here: room for every label.
    expect(times.every((time) => time !== '')).toBe(true);
    // The trace runs through every hour.
    expect(page.querySelector('.weather-hourly__line')!.getAttribute('points')!.split(' ')).toHaveLength(24);
  });

  it('give a screen reader every hour whole, however the strip is thinned for the eye', () => {
    const page = render(forecast, undefined, { width: 300, height: 700 });
    const readings = [...page.querySelectorAll('.weather-hour__reading')].map((reading) => reading.textContent);
    expect(readings).toHaveLength(24);
    expect(readings[1]).toBe('WED 11:00, 61°, clear, 4% precipitation');
    expect(page.querySelector('.weather-hour__time')!.getAttribute('aria-hidden')).toBe('true');
  });
});

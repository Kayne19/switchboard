import type {
  WeatherCurrent,
  WeatherDay,
  WeatherHour,
  WeatherData,
} from '../types';
import { checkString, checkUnknownKeys, copyFrameText, copyNumber, copyOptionalString, invalidName, isName, isRecord } from './shared';
import type { Fields } from './shared';
import { readTime } from './time';

function copyOptionalPercent<T extends object>(data: Fields, out: T, key: keyof T & string, field: string): string | null {
  const value = data[key];
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    return `${field} must be a number from 0 to 100`;
  }
  (out as Fields)[key] = value;
  return null;
}

const WEATHER_CONDITIONS = [
  'clear', 'partly-cloudy', 'cloudy', 'fog', 'drizzle', 'rain', 'heavy-rain', 'thunder', 'snow', 'sleet', 'hail', 'wind', 'haze',
];
const WEATHER_UNITS = ['C', 'F'];
const MAX_WEATHER_HOURS = 48;
const MAX_WEATHER_DAYS = 14;

function copyCondition(data: Fields, out: Fields, field: string): string | null {
  if (!isName(data.condition, WEATHER_CONDITIONS)) return invalidName(field, WEATHER_CONDITIONS);
  out.condition = data.condition;
  return null;
}

function validateWeatherCurrent(c: unknown): { ok: true; current: WeatherCurrent } | { ok: false; error: string } {
  if (!isRecord(c)) return { ok: false, error: 'weather.current must be an object' };
  const unknownKey = checkUnknownKeys(
    c,
    new Set(['temp', 'condition', 'summary', 'high', 'low', 'feelsLike', 'humidity', 'precip', 'wind']),
    'weather current',
  );
  if (unknownKey) return { ok: false, error: unknownKey };
  const out: Fields = {};
  const err =
    copyNumber(c, out, 'temp', 'weather current.temp', true) ??
    copyCondition(c, out, 'weather current.condition') ??
    copyOptionalString(c, out, 'summary', 256, 'weather current.summary') ??
    copyNumber(c, out, 'high', 'weather current.high', false) ??
    copyNumber(c, out, 'low', 'weather current.low', false) ??
    copyNumber(c, out, 'feelsLike', 'weather current.feelsLike', false) ??
    copyOptionalPercent(c, out, 'humidity', 'weather current.humidity') ??
    copyOptionalPercent(c, out, 'precip', 'weather current.precip') ??
    copyOptionalString(c, out, 'wind', 128, 'weather current.wind');
  if (err) return { ok: false, error: err };
  return { ok: true, current: out as unknown as WeatherCurrent };
}

function validateWeatherHour(h: unknown, seen: Set<string>): { ok: true; hour: WeatherHour } | { ok: false; error: string } {
  if (!isRecord(h)) return { ok: false, error: 'weather hour must be an object' };
  const unknownKey = checkUnknownKeys(h, new Set(['time', 'temp', 'condition', 'precip']), 'weather hour');
  if (unknownKey) return { ok: false, error: unknownKey };
  const time = readTime(h.time, ['wall'], 'weather hour.time');
  if (!time.ok) return time;
  // A note names an hour by its time, so no two hours share one.
  if (seen.has(h.time as string)) return { ok: false, error: `duplicate weather hour: ${h.time as string}` };
  seen.add(h.time as string);
  const out: Fields = { time: h.time };
  const err =
    copyNumber(h, out, 'temp', 'weather hour.temp', true) ??
    copyCondition(h, out, 'weather hour.condition') ??
    copyOptionalPercent(h, out, 'precip', 'weather hour.precip');
  if (err) return { ok: false, error: err };
  return { ok: true, hour: out as unknown as WeatherHour };
}

function validateWeatherDay(d: unknown, seen: Set<string>): { ok: true; day: WeatherDay } | { ok: false; error: string } {
  if (!isRecord(d)) return { ok: false, error: 'weather day must be an object' };
  const unknownKey = checkUnknownKeys(d, new Set(['date', 'high', 'low', 'condition', 'precip']), 'weather day');
  if (unknownKey) return { ok: false, error: unknownKey };
  const date = readTime(d.date, ['date'], 'weather day.date');
  if (!date.ok) return date;
  // A note names a day by its date, so no two days share one.
  if (seen.has(d.date as string)) return { ok: false, error: `duplicate weather day: ${d.date as string}` };
  seen.add(d.date as string);
  const out: Fields = { date: d.date };
  const err =
    copyNumber(d, out, 'high', 'weather day.high', true) ??
    copyNumber(d, out, 'low', 'weather day.low', true) ??
    copyCondition(d, out, 'weather day.condition') ??
    copyOptionalPercent(d, out, 'precip', 'weather day.precip');
  if (err) return { ok: false, error: err };
  return { ok: true, day: out as unknown as WeatherDay };
}

export function validateWeatherData(data: Fields): { ok: true; data: WeatherData } | { ok: false; error: string } {
  const unknownKey = checkUnknownKeys(
    data,
    new Set(['title', 'subtitle', 'context', 'caption', 'location', 'units', 'current', 'today', 'hourly', 'daily', 'alert']),
    'weather data',
  );
  if (unknownKey) return { ok: false, error: unknownKey };
  const locationErr = checkString(data.location, 128, 'weather.location');
  if (locationErr) return { ok: false, error: locationErr };
  if (!isName(data.units, WEATHER_UNITS)) return { ok: false, error: invalidName('weather.units', WEATHER_UNITS) };
  const current = validateWeatherCurrent(data.current);
  if (!current.ok) return current;
  const out: Fields = { location: data.location, units: data.units, current: current.current };
  // The day the forecast is read on, as calendar, tasks and inbox take it:
  // the page has no clock of its own to tell it.
  if (data.today !== undefined) {
    const today = readTime(data.today, ['date'], 'weather.today');
    if (!today.ok) return today;
    out.today = data.today;
  }
  if (data.hourly !== undefined) {
    if (!Array.isArray(data.hourly) || data.hourly.length > MAX_WEATHER_HOURS) {
      return { ok: false, error: `weather.hourly must be an array of at most ${MAX_WEATHER_HOURS} items` };
    }
    const seen = new Set<string>();
    const hourly: WeatherHour[] = [];
    for (const h of data.hourly) {
      const res = validateWeatherHour(h, seen);
      if (!res.ok) return res;
      hourly.push(res.hour);
    }
    out.hourly = hourly;
  }
  if (data.daily !== undefined) {
    if (!Array.isArray(data.daily) || data.daily.length > MAX_WEATHER_DAYS) {
      return { ok: false, error: `weather.daily must be an array of at most ${MAX_WEATHER_DAYS} items` };
    }
    const seen = new Set<string>();
    const daily: WeatherDay[] = [];
    for (const d of data.daily) {
      const res = validateWeatherDay(d, seen);
      if (!res.ok) return res;
      daily.push(res.day);
    }
    out.daily = daily;
  }
  const err = copyOptionalString(data, out, 'alert', 256, 'weather.alert') ?? copyFrameText(data, out, 'weather');
  if (err) return { ok: false, error: err };
  return { ok: true, data: out as unknown as WeatherData };
}

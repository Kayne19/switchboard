// @vitest-environment jsdom
// Every weather condition the contract names has a glyph drawn in the
// page's line language: the schema's enum, the validator and the glyph
// table agree, so a condition added to the contract without a glyph fails
// here rather than drawing nothing on a caller's forecast.
import { describe, expect, it } from 'vitest';
import schema from '../../../../docs/display-action-v1.schema.json';
import type { WeatherCondition } from '../../src/controller/types';
import { validateControllerAction } from '../../src/controller/validation';
import { conditionText, WEATHER_GLYPHS, WeatherGlyph } from '../../src/primitives/WeatherGlyph';
import { mount } from './sceneHarness';

const conditions = (schema as { definitions: { WeatherCondition: { enum: WeatherCondition[] } } }).definitions.WeatherCondition.enum;

describe('weather glyphs', () => {
  it('the contract names thirteen conditions, and the glyph table holds exactly those', () => {
    expect(conditions).toHaveLength(13);
    expect(Object.keys(WEATHER_GLYPHS).sort()).toEqual([...conditions].sort());
  });

  it.each(conditions)('%s is a condition the validator accepts, and it has a glyph of sharp strokes', (condition) => {
    const result = validateControllerAction({
      op: 'show', id: 'w', type: 'weather', data: { location: 'Here', units: 'C', current: { temp: 1, condition } },
    });
    expect(result.ok).toBe(true);
    const parts = WEATHER_GLYPHS[condition];
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      // Straight segments only: no arcs, no curves -- the line language.
      expect(part.d).toMatch(/^[MLHVZ0-9.\s-]+$/);
      // Inside the 24-unit square.
      for (const value of part.d.match(/-?\d+(?:\.\d+)?/g) ?? []) {
        expect(Number(value)).toBeGreaterThanOrEqual(0);
        expect(Number(value)).toBeLessThanOrEqual(24);
      }
    }
  });

  // The names and labels above would pass with one picture drawn for two
  // conditions; the caller reads the shape, so each must be its own.
  it('every condition draws its own shape', () => {
    const shapes = conditions.map((condition) => WEATHER_GLYPHS[condition].map((part) => `${part.kind}${part.solid ? '!' : ''}:${part.d}`).join('|'));
    expect(new Set(shapes).size).toBe(conditions.length);
  });

  // What each glyph is made of: a sun where the sky clears, a cloud where it
  // does not, water where it rains, ice where it freezes, a bolt for
  // thunder and air for fog, wind and haze.
  const MADE_OF: Record<WeatherCondition, string[]> = {
    clear: ['sun'],
    'partly-cloudy': ['cloud', 'sun'],
    cloudy: ['cloud'],
    fog: ['air'],
    drizzle: ['cloud', 'water'],
    rain: ['cloud', 'water'],
    'heavy-rain': ['cloud', 'water'],
    thunder: ['bolt', 'cloud'],
    snow: ['cloud', 'ice'],
    sleet: ['cloud', 'ice', 'water'],
    hail: ['cloud', 'ice'],
    wind: ['air'],
    haze: ['air', 'sun'],
  };
  it.each(conditions)('%s is drawn from the parts its weather names', (condition) => {
    expect([...new Set(WEATHER_GLYPHS[condition].map((part) => part.kind))].sort()).toEqual(MADE_OF[condition]);
  });

  // Rain's three intensities differ by how much falls: more strokes, or longer.
  it('drizzle, rain and heavy rain fall harder in that order', () => {
    const fall = (condition: WeatherCondition) => {
      const water = WEATHER_GLYPHS[condition].find((part) => part.kind === 'water')!.d;
      let total = 0;
      for (const [, x1, y1, x2, y2] of water.matchAll(/M(-?[\d.]+) (-?[\d.]+) L(-?[\d.]+) (-?[\d.]+)/g)) {
        total += Math.hypot(Number(x2) - Number(x1), Number(y2) - Number(y1));
      }
      return total;
    };
    expect(fall('drizzle')).toBeLessThan(fall('rain'));
    expect(fall('rain')).toBeLessThan(fall('heavy-rain'));
  });

  it.each(conditions)('%s draws as an SVG named for its condition, never an emoji or an image', (condition) => {
    const host = mount(<WeatherGlyph condition={condition} />);
    const svg = host.querySelector('svg')!;
    expect(svg.getAttribute('aria-label')).toBe(conditionText(condition));
    expect(svg.querySelectorAll('path').length).toBe(WEATHER_GLYPHS[condition].length);
    expect(host.querySelector('img, image, text')).toBeNull();
    expect(host.textContent).toBe('');
  });
});

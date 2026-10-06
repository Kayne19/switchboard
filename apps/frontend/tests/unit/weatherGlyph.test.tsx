// @vitest-environment jsdom
// Every weather condition the contract names has a glyph drawn in the
// page's line language: the schema's enum, the validator and the glyph
// table agree, so a condition added to the contract without a glyph fails
// here rather than drawing nothing on a caller's forecast.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import schema from '../../../../docs/display-action-v1.schema.json';
import type { WeatherCondition } from '../../src/controller/types';
import { validateControllerAction } from '../../src/controller/validation';
import { conditionText, WEATHER_GLYPHS, WeatherGlyph } from '../../src/primitives/WeatherGlyph';

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

  it.each(conditions)('%s draws as an SVG named for its condition, never an emoji or an image', (condition) => {
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(<WeatherGlyph condition={condition} />));
    const svg = host.querySelector('svg')!;
    expect(svg.getAttribute('aria-label')).toBe(conditionText(condition));
    expect(svg.querySelectorAll('path').length).toBe(WEATHER_GLYPHS[condition].length);
    expect(host.querySelector('img, image, text')).toBeNull();
    expect(host.textContent).toBe('');
    act(() => root.unmount());
  });
});

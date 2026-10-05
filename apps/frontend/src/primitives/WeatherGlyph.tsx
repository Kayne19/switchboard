import type { WeatherCondition } from '../controller/types';

// The thirteen weather conditions, each drawn once in the page's line
// language (docs/display-tool.md, "weather"): sharp vector strokes on a
// 24-unit square, faceted where a picture book would round -- a cloud is a
// chamfered hull, the sun an octagon with its rays, rain slanted strokes,
// snow six-armed stars, hail solid diamonds, a bolt a zigzag. Never an
// emoji, never an image. The strokes do not scale with the glyph, so it
// stays crisp from a forecast row to the hero. Each part takes its colour
// from its kind: the sun orange, cloud and air paper, water cyan, the
// bolt amber.

/** One stroke group of a glyph, and the kind its colour comes from. */
interface GlyphPart {
  kind: 'sun' | 'cloud' | 'water' | 'ice' | 'bolt' | 'air';
  d: string;
  /** Drawn solid rather than stroked (a hailstone, a bolt's head). */
  solid?: boolean;
}

// A cloud low in the square, alone, and one raised over what falls from it.
const CLOUD = 'M2.5 18.5 H21.5 V14.5 L19 11.5 H17 L14.5 7.5 H9.5 L7.5 10.5 H5 L2.5 13.5 Z';
const RAISED_CLOUD = 'M2.5 14 H21.5 V10 L19 7 H17 L14.5 3 H9.5 L7.5 6 H5 L2.5 9 Z';
const SUN = 'M16.07 13.68 L13.68 16.07 H10.32 L7.93 13.68 V10.32 L10.32 7.93 H13.68 L16.07 10.32 Z';
const SUN_RAYS = 'M18.6 12 H21.6 M16.67 16.67 L18.79 18.79 M12 18.6 V21.6 M7.33 16.67 L5.21 18.79 M5.4 12 H2.4 M7.33 7.33 L5.21 5.21 M12 5.4 V2.4 M16.67 7.33 L18.79 5.21';

export const WEATHER_GLYPHS: Record<WeatherCondition, GlyphPart[]> = {
  clear: [
    { kind: 'sun', d: SUN },
    { kind: 'sun', d: SUN_RAYS },
  ],
  'partly-cloudy': [
    // The sun behind the cloud's shoulder: only what shows past it.
    { kind: 'sun', d: 'M9.72 11.46 H7.28 L5.54 9.72 V7.28 L7.28 5.54 H9.72 L11.46 7.28 V9.4' },
    { kind: 'sun', d: 'M3.5 8.5 H1.5 M4.96 4.96 L3.55 3.55 M8.5 3.5 V1.5 M12.04 4.96 L13.45 3.55' },
    { kind: 'cloud', d: 'M6.5 19 H22 V15.5 L20 13 H18.5 L16.5 9.5 H12 L10.5 12 H8.5 L6.5 14.5 Z' },
  ],
  cloudy: [
    // A second hull behind the first.
    { kind: 'cloud', d: 'M15.8 9.5 L17.3 6.5 H20 L22.5 10 V13.3 L21.5 13.3' },
    { kind: 'cloud', d: CLOUD },
  ],
  fog: [{ kind: 'air', d: 'M3 7.5 H15 M18 7.5 H21 M3 11.5 H7 M10 11.5 H21 M3 15.5 H17 M20 15.5 H21 M6 19.5 H18' }],
  drizzle: [
    { kind: 'cloud', d: RAISED_CLOUD },
    { kind: 'water', d: 'M8 16.5 L7.5 18 M12.5 16.5 L12 18 M17 16.5 L16.5 18 M10.25 19.75 L9.75 21.25 M14.75 19.75 L14.25 21.25' },
  ],
  rain: [
    { kind: 'cloud', d: RAISED_CLOUD },
    { kind: 'water', d: 'M8 16.5 L6.5 20.5 M12.5 16.5 L11 20.5 M17 16.5 L15.5 20.5' },
  ],
  'heavy-rain': [
    { kind: 'cloud', d: RAISED_CLOUD },
    { kind: 'water', d: 'M6.5 16.5 L4.5 22 M10.5 16.5 L8.5 22 M14.5 16.5 L12.5 22 M18.5 16.5 L16.5 22' },
  ],
  thunder: [
    { kind: 'cloud', d: RAISED_CLOUD },
    { kind: 'bolt', d: 'M13.5 15.5 L10 19.5 H13.5 L10.5 23.5' },
  ],
  snow: [
    { kind: 'cloud', d: RAISED_CLOUD },
    { kind: 'ice', d: 'M5.6 18 H9.4 M6.55 16.35 L8.45 19.65 M8.45 16.35 L6.55 19.65 M10.1 20.8 H13.9 M11.05 19.15 L12.95 22.45 M12.95 19.15 L11.05 22.45 M14.6 18 H18.4 M15.55 16.35 L17.45 19.65 M17.45 16.35 L15.55 19.65' },
  ],
  sleet: [
    { kind: 'cloud', d: RAISED_CLOUD },
    { kind: 'water', d: 'M8 16.5 L6.5 20.5 M17 16.5 L15.5 20.5' },
    { kind: 'ice', d: 'M10.1 19.3 H13.9 M11.05 17.65 L12.95 20.95 M12.95 17.65 L11.05 20.95' },
  ],
  hail: [
    { kind: 'cloud', d: RAISED_CLOUD },
    { kind: 'ice', solid: true, d: 'M7.5 16.85 L8.65 18 L7.5 19.15 L6.35 18 Z M12 19.35 L13.15 20.5 L12 21.65 L10.85 20.5 Z M16.5 16.85 L17.65 18 L16.5 19.15 L15.35 18 Z' },
  ],
  wind: [{ kind: 'air', d: 'M2.5 8.5 H14 L16.5 6 M2.5 12.5 H19 L21.5 10 M2.5 16.5 H12 L14.5 19' }],
  haze: [
    // The sun low behind the haze: its upper half over the first line.
    { kind: 'sun', d: 'M7.93 13 V11.32 L10.32 8.93 H13.68 L16.07 11.32 V13' },
    { kind: 'sun', d: 'M5.6 13 H3 M7.47 8.47 L5.64 6.64 M12 6.6 V4 M16.53 8.47 L18.36 6.64 M18.4 13 H21' },
    { kind: 'air', d: 'M3 16 H21 M5 19 H11 M14 19 H19 M7 22 H17' },
  ],
};

/** A condition's name as words, for a screen reader and the hero's line. */
export function conditionText(condition: WeatherCondition): string {
  return condition.replace('-', ' ');
}

export function WeatherGlyph({ condition, className }: { condition: WeatherCondition; className?: string }) {
  const parts = WEATHER_GLYPHS[condition] ?? [];
  return (
    <svg className={`weather-glyph${className ? ` ${className}` : ''}`} viewBox="0 0 24 24" role="img" aria-label={conditionText(condition)} data-condition={condition}>
      {parts.map((part, index) => (
        <path key={index} className={`weather-glyph__${part.kind}${part.solid ? ' weather-glyph--solid' : ''}`} d={part.d} />
      ))}
    </svg>
  );
}

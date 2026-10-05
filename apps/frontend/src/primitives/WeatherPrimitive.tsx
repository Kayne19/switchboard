import { useRef, type CSSProperties } from 'react';
import type { WeatherData, WeatherDay, WeatherHour } from '../controller/types';
import { useElementSize } from '../hooks/useElementSize';
import { ListViewport } from './ListViewport';
import { NoteBadge } from './NoteMarker';
import { conditionText, WeatherGlyph } from './WeatherGlyph';
import {
  dayLabel,
  dayScale,
  formatTemp,
  hourLabel,
  hourLabelStep,
  labelledHours,
  LEAST_TEMP_SPAN,
  rangeOnScale,
  tempScale,
  weatherLayout,
  type WeatherArrangement,
} from './weatherLayout';

// A forecast (docs/display-tool.md, "weather"): the conditions now as the
// hero -- the condition's glyph, the temperature large, the summary and the
// readings beside it, an alert in the warning colour -- then the hours as a
// strip (the temperature traced over the chance of rain, labelled as often
// as the strip's width allows) and the days as a list (each day's range a
// bar on one scale shared by all, so a cold day reads as cold beside a
// warm one). How the parts stand is the box's decision (weatherLayout). The
// hour or day a note names carries the NOTE badge, and a list opens on it.

const NOW_KEYS: Array<[keyof WeatherData['current'], string]> = [
  ['feelsLike', 'FEELS LIKE'],
  ['humidity', 'HUMIDITY'],
  ['precip', 'PRECIP'],
  ['wind', 'WIND'],
];

function Reading({ label, value }: { label: string; value: string }) {
  return (
    <div className="weather-now__reading">
      <dt className="tech micro">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function AlertLine({ text }: { text: string }) {
  return (
    <div className="weather-alert">
      <svg className="weather-alert__glyph" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M6 0.8 L11.4 11 H0.6 Z M6 4.2 V7.6 M6 8.8 V10" />
      </svg>
      <span className="weather-alert__tag tech micro">ALERT</span>
      <span className="weather-alert__text">{text}</span>
    </div>
  );
}

function Now({ data, compact }: { data: WeatherData; compact: boolean }) {
  const { current, units } = data;
  const degree = (value: number) => `${formatTemp(value)}°`;
  const highLow = current.high !== undefined || current.low !== undefined
    ? [current.high !== undefined ? `H ${degree(current.high)}` : null, current.low !== undefined ? `L ${degree(current.low)}` : null].filter(Boolean).join(' ')
    : null;
  const readings = NOW_KEYS.filter(([key]) => current[key] !== undefined).map(([key, label]) => {
    const value = current[key] as number | string;
    const text = key === 'feelsLike' ? degree(value as number) : key === 'wind' ? (value as string) : `${formatTemp(value as number)}%`;
    return <Reading key={key} label={label} value={text} />;
  });
  return (
    <section className="weather-now" aria-label={`Weather now in ${data.location}`}>
      <div className="weather-now__head tech micro">
        <span className="weather-now__location">{data.location}</span>
        <span>NOW</span>
      </div>
      {data.alert ? <AlertLine text={data.alert} /> : null}
      {/* The figure and the words beside it where the box is wide enough
          for both, under it where it is not (an intrinsic wrap, no
          breakpoint). */}
      <div className="weather-now__body">
        <div className="weather-now__main">
          <WeatherGlyph condition={current.condition} className="weather-now__glyph" />
          <div className="weather-now__figure">
            <div className="weather-now__temp">
              {formatTemp(current.temp)}
              <span className="weather-now__unit">°{units}</span>
            </div>
            <div className="weather-now__condition tech">
              <span>{conditionText(current.condition)}</span>
              {highLow ? <span className="weather-now__high-low">{highLow}</span> : null}
            </div>
          </div>
        </div>
        {!compact && (current.summary || readings.length > 0) ? (
          <div className="weather-now__detail">
            {current.summary ? <p className="weather-now__summary">{current.summary}</p> : null}
            {readings.length > 0 ? <dl className="weather-now__readings">{readings}</dl> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SectionHead({ name, count }: { name: string; count: string }) {
  return (
    <div className="weather-section__head tech micro">
      <span>{name}</span>
      <span>{count}</span>
    </div>
  );
}

// The hours: a column each, labelled as often as the width allows; the
// temperature's trace runs across them over each hour's chance of rain.
function Hours({ hours, units, marked }: { hours: WeatherHour[]; units: WeatherData['units']; marked?: string }) {
  const stripRef = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(stripRef);
  // The columns share the strip's width inside its padding (--strip-pad, 10px a side).
  const step = hourLabelStep(width - 20, hours.length);
  const labelled = labelledHours(hours, step, marked);
  const scale = tempScale(hours.map((hour) => hour.temp), LEAST_TEMP_SPAN[units]);
  const x = (index: number) => ((index + 0.5) / hours.length) * 100;
  const y = (temp: number) => 100 - ((temp - scale.min) / (scale.max - scale.min)) * 100;
  const points = hours.map((hour, index) => `${x(index).toFixed(3)},${y(hour.temp).toFixed(3)}`);
  const area = `${x(0).toFixed(3)},100 ${points.join(' ')} ${x(hours.length - 1).toFixed(3)},100`;
  const dots = (pick: (hour: WeatherHour, index: number) => boolean) =>
    hours.map((hour, index) => (pick(hour, index) ? `M${x(index).toFixed(3)} ${y(hour.temp).toFixed(3)} h0` : '')).join(' ');
  return (
    <section className="weather-hourly">
      <SectionHead name="HOURLY" count={`${hours.length} H`} />
      <div
        ref={stripRef}
        className={`weather-hourly__strip${hours.some((hour) => hour.time === marked) ? ' weather-hourly__strip--marked' : ''}`}
        style={{ gridTemplateColumns: `repeat(${hours.length}, minmax(0, 1fr))` }}
      >
        <svg className="weather-hourly__trace" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon className="weather-hourly__area" points={area} />
          <polyline className="weather-hourly__line" points={points.join(' ')} />
          <path className="weather-hourly__dots" d={dots((hour, index) => labelled[index] && hour.time !== marked)} />
          {marked ? <path className="weather-hourly__dots weather-hourly__dots--marked" d={dots((hour) => hour.time === marked)} /> : null}
        </svg>
        {hours.map((hour, index) => {
          const shown = labelled[index];
          const label = hourLabel(hour.time);
          const midnight = !/^\d+$/.test(label);
          return (
            <div
              key={hour.time}
              className={`weather-hour${shown ? ' weather-hour--labelled' : ''}${midnight ? ' weather-hour--day' : ''}${hour.time === marked ? ' weather-hour--marked' : ''}`}
              data-item={hour.time}
            >
              {hour.time === marked ? <NoteBadge className="weather-hour__badge" /> : null}
              <span className="weather-hour__glyph">{shown ? <WeatherGlyph condition={hour.condition} /> : null}</span>
              <span className="weather-hour__temp">{shown ? `${formatTemp(Math.round(hour.temp))}°` : ''}</span>
              <span className="weather-hour__plot" />
              <span className="weather-hour__rain">
                {hour.precip ? <span className="weather-hour__rain-bar" style={{ height: `${hour.precip}%` }} /> : null}
              </span>
              <span className="weather-hour__precip">{shown && hour.precip ? `${formatTemp(hour.precip)}%` : ''}</span>
              <span className="weather-hour__time tech micro">{shown ? label : ''}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Day({ day, scale, marked }: { day: WeatherDay; scale: { min: number; max: number }; marked: boolean }) {
  const range = rangeOnScale(day, scale);
  return (
    <li className={`weather-day${marked ? ' weather-day--marked' : ''}`} data-item={day.date}>
      <span className="weather-day__name tech">
        {dayLabel(day.date)}
        {marked ? <NoteBadge /> : null}
      </span>
      <WeatherGlyph condition={day.condition} className="weather-day__glyph" />
      <span className={`weather-day__precip${day.precip ? '' : ' weather-day__precip--none'}`}>{day.precip !== undefined ? `${formatTemp(day.precip)}%` : '-'}</span>
      <span className="weather-day__low">{formatTemp(day.low)}°</span>
      <span className="weather-day__range" style={{ '--from': `${range.from}%`, '--to': `${range.to}%` } as CSSProperties}>
        <span className="weather-day__bar" />
      </span>
      <span className="weather-day__high">{formatTemp(day.high)}°</span>
    </li>
  );
}

// The days: their own scroll where the forecast stands beside them, or rows
// in the forecast's one scroll where it stands down the box.
function Days({ days, marked, scroll }: { days: WeatherDay[]; marked?: string; scroll: boolean }) {
  const scale = dayScale(days);
  const head = <SectionHead name="DAILY" count={`${formatTemp(scale.min)}° TO ${formatTemp(scale.max)}°`} />;
  const list = (
    <ol className="weather-daily__days">
      {days.map((day) => <Day key={day.date} day={day} scale={scale} marked={day.date === marked} />)}
    </ol>
  );
  return (
    <section className="weather-daily">
      {scroll ? (
        <ListViewport
          noun={['DAY', 'DAYS']}
          lead={days.some((day) => day.date === marked) ? marked : undefined}
          head={head}
          scrollClassName="weather-daily__scroll"
          label="Daily forecast"
        >
          {list}
        </ListViewport>
      ) : (
        <>
          {head}
          {list}
        </>
      )}
    </section>
  );
}

export function WeatherPrimitive({ data, marked, focused = false }: { data: WeatherData; marked?: string; focused?: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(boxRef);
  const hours = data.hourly ?? [];
  const days = data.daily ?? [];
  const layout = weatherLayout(size.width, size.height, {
    hourly: hours.length > 0,
    daily: days.length > 0,
    markedHour: hours.some((hour) => hour.time === marked),
  });
  const arrangement: WeatherArrangement = layout.arrangement;
  // Down the box, the forecast is one column read top to bottom, and it
  // scrolls as one when it is longer than the box, counting the days past
  // the edge; beside one another, each part keeps its place and the days
  // scroll in their own.
  const tall = arrangement === 'tall';
  const parts = ['now', layout.hourly ? 'hourly' : null, layout.daily ? 'daily' : null].filter(Boolean).join(' ');
  const field = (
    <div className="weather__field" data-parts={parts} style={{ '--weather-temp': `${layout.temp}px` } as CSSProperties}>
      <Now data={data} compact={arrangement === 'compact'} />
      {layout.hourly ? <Hours hours={hours} units={data.units} marked={marked} /> : null}
      {layout.daily ? <Days days={days} marked={marked} scroll={!tall} /> : null}
    </div>
  );
  const named = [...hours.map((hour) => hour.time), ...days.map((day) => day.date)].includes(marked ?? '') ? marked : undefined;
  return (
    <div className={`weather weather--${arrangement}${focused ? ' weather--focused' : ''}`} data-testid="weather" data-layout={arrangement}>
      {/* The box the forecast is laid out for, inside any padding its slot gives it. */}
      <div ref={boxRef} className="weather__box">
        {tall ? (
          <ListViewport noun={['DAY', 'DAYS']} countSelector=".weather-day" lead={named} scrollClassName="weather__scroll" label="Forecast">
            {field}
          </ListViewport>
        ) : (
          field
        )}
      </div>
    </div>
  );
}

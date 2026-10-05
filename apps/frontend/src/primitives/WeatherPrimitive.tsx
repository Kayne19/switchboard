import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { WeatherData, WeatherDay, WeatherHour } from '../controller/types';
import { useElementSize } from '../hooks/useElementSize';
import { ListViewport } from './ListViewport';
import { MetaTitle } from './MetaTitle';
import { NoteBadge } from './NoteMarker';
import { conditionText, WeatherGlyph } from './WeatherGlyph';
import {
  dayLabel,
  dayLong,
  dayRange,
  dayScale,
  formatTemp,
  heroTempFit,
  hourLabel,
  hourLabelStep,
  hourLong,
  labelledHours,
  LEAST_TEMP_SPAN,
  outlookCount,
  outlookDays,
  rangeOnScale,
  STRIP_PAD,
  tempScale,
  titleNamesPlace,
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

function Now({ data, compact, temp, framed, spot, outlook, inline }: { data: WeatherData; compact: boolean; temp: number; framed: boolean; spot?: string; outlook: boolean; inline: boolean }) {
  const { current, units } = data;
  // The day a note names stands in the outlook where there is one (it
  // takes the last column if it lies past them); the spot line under the
  // conditions is for an item nothing here draws. Until the outlook has
  // measured its columns (null) the day is taken to be among them.
  const [outlookShown, setOutlookShown] = useState<string[] | null>(null);
  const inOutlook = outlook && (data.daily ?? []).some((day) => day.date === spot) && (outlookShown === null || outlookShown.includes(spot!));
  // The temperature is as large as the layout gives it, and no larger than
  // its row (glyph, digits, unit) fits the column the figure stands in:
  // `-12.5°C` needs more room than `61°F`.
  const mainRef = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(mainRef);
  const fitted = heroTempFit(width, `${formatTemp(current.temp)}`, temp);
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
    <section className={`weather-now${inline ? ' weather-now--inline' : ''}`} aria-label={`Weather now in ${data.location}`}>
      {/* Where no frame names the forecast (an aux cell, focus), its title
          leads the head (MetaTitle), and the place it is for takes the
          place of NOW. */}
      <div className="weather-now__head tech micro">
        <MetaTitle title={data.title ?? 'WEATHER'} framed={framed} className="weather-now__title" />
        {/* The place, unless the title leading the head names it already. */}
        {framed || !titleNamesPlace(data.title, data.location) ? <span className="weather-now__location">{data.location}</span> : null}
        {framed ? <span>NOW</span> : null}
      </div>
      {data.alert ? <AlertLine text={data.alert} /> : null}
      {/* The figure and the words beside it where the box is wide enough
          for both, under it where it is not (an intrinsic wrap, no
          breakpoint). */}
      <div className={`weather-now__body${outlook ? ' weather-now__body--outlook' : ''}`}>
        <div ref={mainRef} className="weather-now__main" style={{ '--weather-temp': `${fitted}px` } as CSSProperties}>
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
        {outlook ? <Outlook days={data.daily ?? []} marked={spot} onShown={setOutlookShown} /> : null}
        {!compact && (current.summary || readings.length > 0) ? (
          <div className="weather-now__detail">
            {current.summary ? <p className="weather-now__summary">{current.summary}</p> : null}
            {readings.length > 0 ? <dl className="weather-now__readings">{readings}</dl> : null}
          </div>
        ) : null}
      </div>
      {spot !== undefined && !inOutlook ? <Spot data={data} marked={spot} /> : null}
    </section>
  );
}

// The days beside the conditions in a slot too short for a list under them:
// as many as whole columns fit in the room beside the figure.
function Outlook({ days, marked, onShown }: { days: WeatherDay[]; marked?: string; onShown: (dates: string[]) => void }) {
  const ref = useRef<HTMLOListElement>(null);
  const { width } = useElementSize(ref);
  const shown = outlookDays(days, outlookCount(width, days.length), marked);
  const dates = shown.map((day) => day.date).join(' ');
  // Said once the room is measured: before that no day is known to be out.
  useLayoutEffect(() => {
    if (width > 0) onShown(dates ? dates.split(' ') : []);
  }, [width, dates, onShown]);
  return (
    <ol ref={ref} className="weather-outlook" aria-label="Daily forecast" data-days={shown.length}>
      {shown.map((day) => <OutlookDay key={day.date} day={day} marked={day.date === marked} />)}
    </ol>
  );
}

// A day in the outlook: its name, its glyph, its high over its low, read in
// that order as a daily row is.
function OutlookDay({ day, marked }: { day: WeatherDay; marked: boolean }) {
  return (
    <li className={`weather-outlook__day${marked ? ' weather-outlook__day--marked' : ''}`} data-item={day.date}>
      {marked ? <NoteBadge className="weather-outlook__badge" /> : null}
      <span className="weather-outlook__name tech micro">{dayLabel(day.date)}</span>
      <WeatherGlyph condition={day.condition} className="weather-outlook__glyph" />
      <span className="weather-outlook__high">{formatTemp(day.high)}°</span>
      <span className="weather-outlook__low">{formatTemp(day.low)}°</span>
    </li>
  );
}

// The hour or day a note names, where the slot has no room for the list
// that holds it (a small slot shows the conditions and, at most, one
// list): one line under the conditions, so the item the card names is on
// screen with its badge.
function Spot({ data, marked }: { data: WeatherData; marked: string }) {
  const hour = (data.hourly ?? []).find((candidate) => candidate.time === marked);
  const day = hour ? undefined : (data.daily ?? []).find((candidate) => candidate.date === marked);
  if (!hour && !day) return null;
  const condition = (hour ?? day)!.condition;
  const precip = (hour ?? day)!.precip;
  return (
    <div className="weather-spot" data-item={marked}>
      <NoteBadge />
      <span className="weather-spot__when tech micro">{hour ? hourLong(hour.time) : dayLong(day!.date)}</span>
      <WeatherGlyph condition={condition} className="weather-spot__glyph" />
      <span className="weather-spot__temp">{hour ? `${formatTemp(hour.temp)}°` : `${formatTemp(day!.low)}° / ${formatTemp(day!.high)}°`}</span>
      {precip ? <span className="weather-spot__precip">{formatTemp(precip)}%</span> : null}
    </div>
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
  // The columns share the strip's width inside its padding.
  const step = hourLabelStep(width - 2 * STRIP_PAD, hours.length);
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
        style={{ gridTemplateColumns: `repeat(${hours.length}, minmax(0, 1fr))`, '--strip-pad': `${STRIP_PAD}px` } as CSSProperties}
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
              {/* Every hour is read whole by a screen reader; the strip's
                  thinned labels are for the eye. */}
              <span className="weather-hour__reading">
                {[hourLong(hour.time), `${formatTemp(hour.temp)}°`, conditionText(hour.condition), hour.precip !== undefined ? `${formatTemp(hour.precip)}% precipitation` : null].filter(Boolean).join(', ')}
              </span>
              <span className="weather-hour__glyph" aria-hidden="true">{shown ? <WeatherGlyph condition={hour.condition} /> : null}</span>
              <span className="weather-hour__temp" aria-hidden="true">{shown ? `${formatTemp(Math.round(hour.temp))}°` : ''}</span>
              <span className="weather-hour__plot" />
              <span className="weather-hour__rain" aria-hidden="true">
                {hour.precip ? <span className="weather-hour__rain-bar" style={{ height: `${hour.precip}%` }} /> : null}
              </span>
              <span className="weather-hour__precip" aria-hidden="true">{shown && hour.precip ? `${formatTemp(hour.precip)}%` : ''}</span>
              <span className="weather-hour__time tech micro" aria-hidden="true">{shown ? label : ''}</span>
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
  const range = dayRange(days);
  const head = <SectionHead name="DAILY" count={range ? `${formatTemp(range.min)}° TO ${formatTemp(range.max)}°` : ''} />;
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

/**
 * `framed`: the scene's frame names the forecast (the main slot); elsewhere
 * (an aux cell, focus) the forecast leads with its title (MetaTitle), so it
 * shows once wherever it is drawn.
 */
export function WeatherPrimitive({ data, marked, framed = false }: { data: WeatherData; marked?: string; framed?: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(boxRef);
  const hours = data.hourly ?? [];
  const days = data.daily ?? [];
  const layout = weatherLayout(size.width, size.height, {
    hourly: hours.length > 0,
    daily: days.length > 0,
    markedHour: hours.some((hour) => hour.time === marked),
    alert: Boolean(data.alert),
  });
  const arrangement: WeatherArrangement = layout.arrangement;
  // Down the box, the forecast is one column read top to bottom, and it
  // scrolls as one when it is longer than the box, counting the days past
  // the edge; beside one another, each part keeps its place and the days
  // scroll in their own.
  const tall = arrangement === 'tall';
  const parts = ['now', layout.hourly ? 'hourly' : null, layout.daily ? 'daily' : null].filter(Boolean).join(' ');
  // The item a note names that no list here draws (a small slot).
  const unshown =
    (hours.some((hour) => hour.time === marked) && !layout.hourly) || (days.some((day) => day.date === marked) && !layout.daily) ? marked : undefined;
  const field = (
    <div className="weather__field" data-parts={parts} style={{ '--weather-temp': `${layout.temp}px` } as CSSProperties}>
      <Now data={data} compact={arrangement === 'compact'} temp={layout.temp} framed={framed} spot={unshown} outlook={layout.outlook} inline={layout.inline} />
      {layout.hourly ? <Hours hours={hours} units={data.units} marked={marked} /> : null}
      {layout.daily ? <Days days={days} marked={marked} scroll={!tall} /> : null}
    </div>
  );
  const named = [...hours.map((hour) => hour.time), ...days.map((day) => day.date)].includes(marked ?? '') ? marked : undefined;
  return (
    <div className={`weather weather--${arrangement}`} data-testid="weather" data-layout={arrangement}>
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

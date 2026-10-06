import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { WeatherData, WeatherDay, WeatherHour } from '../controller/types';
import { useElementSize } from '../hooks/useElementSize';
import { MeasuredStageDemand, watchElement } from '../hooks/useStageDemand';
import { ListViewport } from './ListViewport';
import { MetaTitle } from './MetaTitle';
import { NoteBadge } from './NoteMarker';
import type { Slot } from './slot';
import { conditionText, WeatherGlyph } from './WeatherGlyph';
import {
  COMPACT_FIGURE_GAP,
  CONDITION_GAP,
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
  OUTLOOK_COLUMN,
  OUTLOOK_GAP,
  OUTLOOK_SPACE,
  outlookCount,
  outlookDays,
  outlookOffer,
  placeBesideTitle,
  rangeOnScale,
  STRIP_LEAST,
  STRIP_PAD,
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

// The alert, where its line has given way to the item a note names (a slot
// too short for both): its tag in the head, its words for a screen reader;
// focus shows it whole.
function AlertTag({ text }: { text: string }) {
  return (
    <span className="weather-now__alert-tag">
      <svg className="weather-alert__glyph" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M6 0.8 L11.4 11 H0.6 Z M6 4.2 V7.6 M6 8.8 V10" />
      </svg>
      ALERT
      <span className="weather-now__alert-words">: {text}</span>
    </span>
  );
}

function Now({ data, compact, temp, slot, spot, outlook, figure, inline, alertLine }: {
  data: WeatherData;
  compact: boolean;
  temp: number;
  slot: Slot;
  spot?: string;
  outlook: WeatherDay[] | null;
  /** Beside an outlook, the figure's width (weatherLayout). */
  figure: number;
  inline: boolean;
  alertLine: boolean;
}) {
  const { current, units } = data;
  // The temperature is as large as the layout gives it, and no larger than
  // its row (glyph, digits, unit) fits the column the figure stands in:
  // `-12.5°C` needs more room than `61°F`.
  const mainRef = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(mainRef);
  // Beside the outlook the figure stands as wide as the layout counted it
  // (fitted to the body less one day's column), and the days take the room
  // it leaves, as many as whole columns fit there.
  const bodyRef = useRef<HTMLDivElement>(null);
  const body = useElementSize(bodyRef).width;
  const tempText = formatTemp(current.temp);
  const fitted = outlook ? temp : heroTempFit(width, tempText, temp);
  const shown = outlook ? outlookDays(outlook, outlookCount(body - figure - OUTLOOK_SPACE, outlook.length), spot) : [];
  const degree = (value: number) => `${formatTemp(value)}°`;
  const highLow = current.high !== undefined || current.low !== undefined
    ? [current.high !== undefined ? `H ${degree(current.high)}` : null, current.low !== undefined ? `L ${degree(current.low)}` : null].filter(Boolean).join(' ')
    : null;
  const readings = NOW_KEYS.filter(([key]) => current[key] !== undefined).map(([key, label]) => {
    const value = current[key] as number | string;
    const text = key === 'feelsLike' ? degree(value as number) : key === 'wind' ? (value as string) : `${formatTemp(value as number)}%`;
    return <Reading key={key} label={label} value={text} />;
  });
  const framed = slot === 'primary';
  const place = framed ? data.location : placeBesideTitle(data.title, data.location);
  return (
    <section className={`weather-now${inline ? ' weather-now--inline' : ''}`} aria-label={`Weather now in ${data.location}`}>
      {/* Where no frame names the forecast (an aux cell, focus), its title
          leads the head (MetaTitle), and the place it is for takes the
          place of NOW: what of the place the title does not name already. */}
      <div className="weather-now__head tech micro">
        <MetaTitle title={data.title ?? 'WEATHER'} slot={slot} className="weather-now__title" />
        {data.alert && !alertLine ? <AlertTag text={data.alert} /> : null}
        {place ? <span className="weather-now__location">{place}</span> : null}
        {framed ? <span>NOW</span> : null}
      </div>
      {data.alert && alertLine ? <AlertLine text={data.alert} /> : null}
      {/* The figure and the words beside it where the box is wide enough
          for both, under it where it is not (an intrinsic wrap, no
          breakpoint). */}
      <div
        ref={bodyRef}
        className={`weather-now__body${outlook ? ' weather-now__body--outlook' : ''}`}
        style={outlook ? ({ '--outlook-figure': `${figure}px`, '--outlook-column': `${OUTLOOK_COLUMN}px`, '--outlook-gap': `${OUTLOOK_GAP}px`, '--outlook-space': `${OUTLOOK_SPACE}px` } as CSSProperties) : undefined}
      >
        <div ref={mainRef} className="weather-now__main" style={{ '--weather-temp': `${fitted}px` } as CSSProperties}>
          <WeatherGlyph condition={current.condition} className="weather-now__glyph" />
          <div className="weather-now__figure">
            <div className="weather-now__temp">
              {tempText}
              <span className="weather-now__unit">°{units}</span>
            </div>
            <div className="weather-now__condition tech">
              <span>{conditionText(current.condition)}</span>
              {highLow ? <span className="weather-now__high-low">{highLow}</span> : null}
            </div>
          </div>
        </div>
        {shown.length > 0 ? (
          <ol className="weather-outlook" aria-label="Daily forecast">
            {shown.map((day) => <OutlookDay key={day.date} day={day} marked={day.date === spot} />)}
          </ol>
        ) : null}
        {!compact && (current.summary || readings.length > 0) ? (
          <div className="weather-now__detail">
            {current.summary ? <p className="weather-now__summary">{current.summary}</p> : null}
            {readings.length > 0 ? <dl className="weather-now__readings">{readings}</dl> : null}
          </div>
        ) : null}
      </div>
      {/* The day a note names stands in the outlook where it has a column
          (the last, if it lies past the first days); this line is for an
          item nothing here draws. */}
      {spot !== undefined && !shown.some((day) => day.date === spot) ? <Spot data={data} marked={spot} /> : null}
    </section>
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

/**
 * Whether a spot line's parts, at their own widths, need more room across
 * than the line has: its children's widths (a text's whole width, even
 * where it ends in an ellipsis now or is set aside), the gaps between them
 * and the line's padding.
 */
function lineOverflows(line: HTMLElement): boolean {
  const style = getComputedStyle(line);
  const parts = Array.from(line.children) as HTMLElement[];
  const widths = parts.reduce((sum, part) => sum + Math.max(part.scrollWidth, part.getBoundingClientRect().width), 0);
  const need = widths + (parseFloat(style.columnGap) || 0) * Math.max(0, parts.length - 1) + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  return need > line.clientWidth + 0.5;
}

// The hour or day a note names, where the slot has no room for the list
// that holds it (a small slot shows the conditions and, at most, one
// list): one line under the conditions, so the item the card names is on
// screen with its badge. Where the line is narrow its readings give way in
// an order: the chance of rain goes whole first, then the temperatures
// lose their end to an ellipsis; the badge, the item's name and its glyph
// stay. No reading is left cut in two while another could make room.
function Spot({ data, marked }: { data: WeatherData; marked: string }) {
  const lineRef = useRef<HTMLDivElement>(null);
  const [dropped, setDropped] = useState(false);
  const hour = (data.hourly ?? []).find((candidate) => candidate.time === marked);
  const day = hour ? undefined : (data.daily ?? []).find((candidate) => candidate.date === marked);
  const precip = (hour ?? day)?.precip;
  useLayoutEffect(() => {
    const line = lineRef.current;
    if (!line || !precip) return undefined;
    return watchElement(line, () => setDropped(lineOverflows(line)), { children: true, changes: true });
  }, [precip]);
  if (!hour && !day) return null;
  const condition = (hour ?? day)!.condition;
  return (
    <div ref={lineRef} className="weather-spot" data-item={marked}>
      <NoteBadge />
      <span className="weather-spot__when tech micro">{hour ? hourLong(hour.time) : dayLong(day!.date)}</span>
      <WeatherGlyph condition={condition} className="weather-spot__glyph" />
      <span className="weather-spot__temp">{hour ? `${formatTemp(hour.temp)}°` : `${formatTemp(day!.low)}° / ${formatTemp(day!.high)}°`}</span>
      {/* Set aside, not taken out, so the line can tell when it fits again. */}
      {precip ? <span className={`weather-spot__precip${dropped && precip ? ' weather-spot__precip--dropped' : ''}`}>{formatTemp(precip)}%</span> : null}
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
 * The height a forecast laid down the box reads whole in, as its scroll
 * measures it: each part at its own height, the hourly strip at its least
 * (it grows into a tall box's room), the gaps between them, and the field's
 * and the scroll's padding round them.
 */
function fieldLeast(field: HTMLElement): number {
  const pad = (style: CSSStyleDeclaration) => (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const style = getComputedStyle(field);
  const parts = Array.from(field.children) as HTMLElement[];
  const heights = parts.reduce((sum, part) => sum + (part.classList.contains('weather-hourly') ? STRIP_LEAST : part.offsetHeight), 0);
  const gaps = (parseFloat(style.rowGap) || 0) * Math.max(0, parts.length - 1);
  return Math.ceil(heights + gaps + pad(style) + (field.parentElement ? pad(getComputedStyle(field.parentElement)) : 0));
}

/**
 * In the main slot the scene's frame names the forecast; elsewhere (an aux
 * cell, focus) the forecast leads with its title (MetaTitle), so it shows
 * once wherever it is drawn.
 */
export function WeatherPrimitive({ data, marked, slot = 'primary' }: { data: WeatherData; marked?: string; slot?: Slot }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(boxRef);
  const hours = data.hourly ?? [];
  const days = data.daily ?? [];
  // The days an outlook would stand beside the conditions: the days to come.
  const offered = outlookOffer(days, data, marked);
  // The condition line's own width (its face follows the stage, so it is
  // read, not counted): beside an outlook the figure stands as wide as it
  // or its temperature row, whichever is wider (outlookFigure).
  const [condition, setCondition] = useState(0);
  const layout = weatherLayout(size.width, size.height, {
    hourly: hours.length > 0,
    daily: days.length > 0,
    ahead: offered.length > 0,
    markedHour: hours.some((hour) => hour.time === marked),
    markedDay: days.some((day) => day.date === marked),
    alert: Boolean(data.alert),
    temp: formatTemp(data.current.temp),
    condition,
  });
  const arrangement: WeatherArrangement = layout.arrangement;
  useLayoutEffect(() => {
    const line = arrangement === 'compact' ? boxRef.current?.querySelector<HTMLElement>('.weather-now__condition') : null;
    if (!line) return undefined;
    // Its parts at their own widths, with the gap it stands at under the
    // temperature, whether or not it is set beside it now.
    const measure = () => {
      const parts = Array.from(line.children) as HTMLElement[];
      setCondition(Math.ceil(parts.reduce((sum, part) => sum + part.scrollWidth, 0) + CONDITION_GAP * Math.max(0, parts.length - 1)));
    };
    return watchElement(line, measure, { children: true, changes: true });
  }, [arrangement]);
  // Down the box, the forecast is one column read top to bottom, and it
  // scrolls as one when it is longer than the box, counting the days past
  // the edge; beside one another, each part keeps its place and the days
  // scroll in their own.
  const tall = arrangement === 'tall';
  const parts = ['now', layout.hourly ? 'hourly' : null, layout.daily ? 'daily' : null].filter(Boolean).join(' ');
  // The item a note names that no list here draws (a small slot).
  const unshown =
    (hours.some((hour) => hour.time === marked) && !layout.hourly) || (days.some((day) => day.date === marked) && !layout.daily) ? marked : undefined;
  // Down the box the field fills its view, so its scroll content always
  // measures the view: the stage is asked for the height its parts read
  // whole in instead (fieldLeast), or a forecast given the stage would keep
  // it once it is short.
  const fieldRef = useRef<HTMLDivElement>(null);
  const [least, setLeast] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = fieldRef.current;
    // Measured for this arrangement only: a forecast laid down the box
    // again first says nothing, rather than what it said last time.
    if (!tall || !element) {
      setLeast(null);
      return undefined;
    }
    return watchElement(element, () => setLeast(fieldLeast(element)), { children: true });
  }, [tall]);
  const field = (
    <div ref={fieldRef} className="weather__field" data-parts={parts} style={{ '--weather-temp': `${layout.temp}px`, '--weather-strip-least': `${STRIP_LEAST}px` } as CSSProperties}>
      <Now data={data} compact={arrangement === 'compact'} temp={layout.temp} slot={slot} spot={unshown} outlook={layout.outlook ? offered : null} figure={layout.figure} inline={layout.inline} alertLine={layout.alertLine} />
      {layout.hourly ? <Hours hours={hours} units={data.units} marked={marked} /> : null}
      {layout.daily ? <Days days={days} marked={marked} scroll={!tall} /> : null}
    </div>
  );
  const named = [...hours.map((hour) => hour.time), ...days.map((day) => day.date)].includes(marked ?? '') ? marked : undefined;
  return (
    <div className={`weather weather--${arrangement}`} data-testid="weather" data-layout={arrangement} style={{ '--condition-gap': `${CONDITION_GAP}px`, '--figure-gap': `${COMPACT_FIGURE_GAP}px` } as CSSProperties}>
      {/* The box the forecast is laid out for, inside any padding its slot gives it. */}
      <div ref={boxRef} className="weather__box">
        {/* Before the box is measured the forecast is a stand-in: it says nothing to the stage. */}
        <MeasuredStageDemand measured={size.width > 0 && size.height > 0 && (!tall || least !== null)}>
          {tall ? (
            <ListViewport noun={['DAY', 'DAYS']} countSelector=".weather-day" lead={named} scrollClassName="weather__scroll" label="Forecast" least={least}>
              {field}
            </ListViewport>
          ) : (
            field
          )}
        </MeasuredStageDemand>
      </div>
    </div>
  );
}

import { useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import type { CalendarData } from '../controller/types';
import { parseTimeValue } from '../controller/validation';
import { useElementSize, type ElementSize } from '../hooks/useElementSize';
import {
  agendaEntries,
  axisY,
  calendarDay,
  clockText,
  dayBars,
  dayLabel,
  daySegments,
  eventsOutside,
  eventTense,
  eventTimeText,
  laneCount,
  MINUTES_PER_DAY,
  monthRowPlan,
  monthGrid,
  monthName,
  nowMinutes,
  overlapping,
  packColumns,
  placeEvents,
  rangeText,
  shownDays,
  timedOn,
  timeAxis,
  todayNumber,
  weekdayName,
  type AgendaItem,
  type DayBar,
  type GridSegment,
  type PlacedEvent,
  type TimeAxis,
} from './calendarLayout';
import { ListViewport } from './ListViewport';
import { NoteBadge } from './NoteMarker';

// A calendar in the four views the agent picks (docs/display-tool.md,
// "calendar"), drawn as one instrument with the table and the progress
// module: thin rules, no cards, times in the mono face, titles in the
// prose face, colour only where the agent's `semantic` or the agent's now
// puts it. The page decides the layout from the box it is given, never
// from a device: a week too narrow for its seven columns shows the ones
// that fit and pages through the rest, a time grid too short to read
// becomes the agenda of the same days, and a month too small for titles
// marks each day's events and lists them under it.
//
// "Today" and "now" are the agent's: the today column and cell, the now
// line, and which events are over all come from `today` and `now`, never
// from the page clock (calendarLayout.ts).

/** The time gutter of a day or week grid. */
const GUTTER_PX = 42;
/** A paged grid's rail on each side of its days, naming the days it hides. */
const PAGE_RAIL_PX = 20;
/** The least width a day column holds a title in. */
const MIN_COLUMN_PX = 76;
/** The least a time grid is read in: its day row, a lane and four hours. */
const MIN_GRID_PX = 168;
/** The day row over a grid's columns, and one lane of all-day bars. */
const DAY_ROW_PX = 36;
const LANE_PX = 19;
/** A week's all-day strip shows this many lanes; the rest are counted. */
const MAX_WEEK_LANES = 3;
/** The least box an event is drawn in: one line of its title. */
const MIN_EVENT_PX = 18;
/** How far a later event must start below an earlier one it overlaps for
 * the earlier's title to show above it: the cluster is then stepped. */
const STEP_GAP_PX = 13;
/** How far each step of a stepped cluster is set in. */
const STEP_INSET_PX = 14;
/** A line in an event box. */
const LINE_PX = 15;
/** A line in a month cell. */
const MONTH_LINE_PX = 16;
/** A month cell's number row, and a cell too narrow for a title. */
const MONTH_NUMBER_PX = 20;
const MONTH_WEEKDAY_PX = 18;
const MIN_MONTH_CELL_PX = 84;

type Layout = 'grid' | 'agenda' | 'month' | 'month-marks';

interface LayoutChoice {
  layout: Layout;
  /** Day columns the grid draws at once (fewer than its days: it pages). */
  columns: number;
}

/** The layout a view takes in a body of `size`; an unmeasured body draws the view whole. */
export function chooseLayout(data: CalendarData, size: ElementSize, dayCount: number): LayoutChoice {
  const measured = size.width > 0 && size.height > 0;
  if (data.view === 'agenda') return { layout: 'agenda', columns: dayCount };
  if (data.view === 'month') {
    if (!measured) return { layout: 'month', columns: 7 };
    const rows = monthGrid(parseTimeValue(data.start)?.dayNumber ?? 0).weeks.length;
    const cellHeight = (size.height - MONTH_WEEKDAY_PX) / rows;
    const roomy = size.width / 7 >= MIN_MONTH_CELL_PX && cellHeight - MONTH_NUMBER_PX >= 2 * MONTH_LINE_PX;
    return { layout: roomy ? 'month' : 'month-marks', columns: 7 };
  }
  if (!measured) return { layout: 'grid', columns: dayCount };
  if (size.height < MIN_GRID_PX) return { layout: 'agenda', columns: dayCount };
  const fit = Math.floor((size.width - GUTTER_PX) / MIN_COLUMN_PX);
  if (fit >= dayCount) return { layout: 'grid', columns: dayCount };
  const paged = Math.floor((size.width - GUTTER_PX - 2 * PAGE_RAIL_PX) / MIN_COLUMN_PX);
  if (paged >= 2) return { layout: 'grid', columns: paged };
  return { layout: 'agenda', columns: dayCount };
}

interface CalendarModel {
  placed: PlacedEvent[];
  days: number[];
  today?: number;
  now?: number;
  outside: number;
}

function calendarModel(data: CalendarData): CalendarModel {
  const placed = placeEvents(data.events);
  const days = shownDays(data);
  return { placed, days, today: todayNumber(data), now: nowMinutes(data), outside: eventsOutside(placed, days) };
}

const SEMANTICS = new Set(['red', 'orange', 'green', 'cyan', 'amber', 'paper', 'muted']);

/** The classes every drawing of an event shares: its colour, status, tense, and whether it is lit. */
function eventClasses(base: string, placed: PlacedEvent, model: CalendarModel): string {
  const { event } = placed;
  const semantic = event.semantic && SEMANTICS.has(event.semantic) ? event.semantic : 'none';
  return [
    base,
    `calendar-tone--${semantic}`,
    `${base}--${eventTense(placed, model.today, model.now)}`,
    event.status && event.status !== 'confirmed' ? `${base}--${event.status}` : '',
    event.active ? `${base}--active` : '',
  ].filter(Boolean).join(' ');
}

/** An event's time as one run of words: `09:30–09:45`, `UNTIL 02:40`, `17:30`. */
function rangeWords(time: { from: string; to?: string }): string {
  if (!time.to) return time.from;
  return time.from === 'UNTIL' || time.from === 'ALL DAY' ? `${time.from} ${time.to}` : `${time.from}\u2013${time.to}`;
}

/** What a status adds to an event's words, for a reader without the dashes and the strike. */
function statusTag(placed: PlacedEvent): string | null {
  if (placed.event.status === 'tentative') return 'TENTATIVE';
  if (placed.event.status === 'cancelled') return 'CANCELLED';
  return null;
}

// ---- the time grid (day, week) ----------------------------------------------------

interface GridProps {
  data: CalendarData;
  model: CalendarModel;
  marked?: string;
  size: ElementSize;
  columns: number;
}

/** The column the grid opens on: the day of the marked event, else today, else the active event's, else the first. */
function leadDay(model: CalendarModel, marked: string | undefined): number | undefined {
  const named = marked === undefined ? undefined : model.placed.find((item) => item.event.id === marked);
  if (named) return named.firstDay;
  if (model.today !== undefined) return model.today;
  return model.placed.find((item) => item.event.active)?.firstDay;
}

function firstColumnFor(model: CalendarModel, marked: string | undefined, columns: number): number {
  const day = leadDay(model, marked);
  const at = day === undefined ? 0 : model.days.indexOf(day);
  return Math.max(0, Math.min(model.days.length - columns, at < 0 ? 0 : at));
}

function runText(days: number[], placed: PlacedEvent[]): string {
  if (days.length === 0) return '';
  const first = days[0];
  const last = days[days.length - 1];
  const count = placed.filter((item) => item.firstDay <= last && item.lastDay >= first).length;
  const name = days.length === 1 ? weekdayName(first) : `${weekdayName(first)}-${weekdayName(last)}`;
  return `${name} / ${count} ${count === 1 ? 'EVENT' : 'EVENTS'}`;
}

function TimeGrid({ data, model, marked, size, columns }: GridProps) {
  const pages = columns < model.days.length;
  const shapeKey = `${data.start}|${model.days.length}|${columns}|${marked ?? ''}`;
  const [paging, setPaging] = useState({ key: shapeKey, first: firstColumnFor(model, marked, columns) });
  const first = paging.key === shapeKey ? paging.first : firstColumnFor(model, marked, columns);
  const days = model.days.slice(first, first + columns);
  const turn = (to: number) => setPaging({ key: shapeKey, first: Math.max(0, Math.min(model.days.length - columns, to)) });

  const bars = dayBars(model.placed, days);
  const lanes = laneCount(bars);
  const shownLanes = Math.min(lanes, lanes > MAX_WEEK_LANES ? MAX_WEEK_LANES - 1 : MAX_WEEK_LANES);
  const stripRows = lanes > shownLanes ? shownLanes + 1 : shownLanes;
  const headHeight = DAY_ROW_PX + stripRows * LANE_PX + (stripRows > 0 ? 6 : 0);
  const segments = daySegments(model.placed, days);
  const nowDay = model.now === undefined ? undefined : Math.floor(model.now / MINUTES_PER_DAY);
  const nowColumn = nowDay === undefined ? -1 : days.indexOf(nowDay);
  const nowMinute = nowColumn >= 0 && model.now !== undefined ? model.now - (nowDay as number) * MINUTES_PER_DAY : undefined;
  const room = size.height > 0 ? size.height - headHeight : 520;
  const axis = timeAxis(segments, nowMinute, room);
  const minDuration = (MIN_EVENT_PX / axis.hourPx) * 60;
  for (const list of segments) packColumns(list, minDuration, (STEP_GAP_PX / axis.hourPx) * 60);
  const rail = pages ? PAGE_RAIL_PX : 0;
  const columnWidth = size.width > 0 ? (size.width - GUTTER_PX - 2 * rail) / columns : 160;

  // Every box carries its event's id (a viewport counts each box past an
  // edge where it lies); the NOTE badge goes on the event's first box only.
  const named = new Set<string>();
  const firstBox = (id: string) => {
    if (named.has(id)) return false;
    named.add(id);
    return true;
  };
  const markedShown = marked !== undefined && model.placed.some((item) => item.event.id === marked && item.lastDay >= days[0] && item.firstDay <= days[days.length - 1]);

  // A paged grid keeps a rail's width clear on each side of its days, so
  // the rails that name the hidden days never lie over the shown ones.
  const template: CSSProperties = {
    gridTemplateColumns: pages ? `${GUTTER_PX}px ${rail}px repeat(${columns}, minmax(0, 1fr)) ${rail}px` : `${GUTTER_PX}px repeat(${columns}, minmax(0, 1fr))`,
    '--grid-lead': `${GUTTER_PX + rail}px`,
    '--grid-trail': `${rail}px`,
  } as CSSProperties;
  const at = (index: number) => index + (pages ? 3 : 2);
  const head = (
    <div className="calendar-grid__head" style={template}>
      {days.map((day, index) => {
        const info = calendarDay(day);
        return (
          <div key={day} className={`calendar-grid__day${day === model.today ? ' calendar-grid__day--today' : ''}`} style={{ gridColumn: at(index), height: `${DAY_ROW_PX}px` }}>
            <span className="calendar-grid__weekday tech micro">{weekdayName(day)}</span>
            <span className="calendar-grid__date">{info.day}</span>
            {info.day === 1 || index === 0 ? <span className="calendar-grid__month tech micro">{monthName(info.month)}</span> : null}
          </div>
        );
      })}
      {stripRows > 0 ? (
        <div className="calendar-grid__strip" style={{ ...template, gridTemplateRows: `repeat(${stripRows}, ${LANE_PX}px)` }}>
          <span className="calendar-grid__strip-label tech micro">ALL DAY</span>
          {days.map((day, index) => (
            <div key={day} className={`calendar-grid__strip-cell${day === model.today ? ' calendar-grid__strip-cell--today' : ''}`} style={{ gridColumn: at(index) }} />
          ))}
          {bars.filter((bar) => bar.lane < shownLanes).map((bar) => (
            <DayBarBox key={bar.placed.order} bar={bar} model={model} marked={marked} first={firstBox(bar.placed.event.id)} column={at(0)} />
          ))}
          {lanes > shownLanes
            ? days.map((day, index) => {
                const hidden = bars.filter((bar) => bar.lane >= shownLanes && bar.from <= index && bar.to >= index).length;
                return hidden > 0 ? (
                  <span key={day} className="calendar-more tech micro" style={{ gridColumn: at(index), gridRow: stripRows }}>+{hidden} MORE</span>
                ) : null;
              })
            : null}
        </div>
      ) : null}
    </div>
  );

  const grid = (
    <ListViewport
      noun={['EVENT', 'EVENTS']}
      lead={markedShown ? marked : undefined}
      head={head}
      className="calendar-grid__viewport"
      scrollClassName="calendar-grid__scroll"
      label="Calendar hours"
    >
      <div className="calendar-grid__body" style={{ ...template, height: `${Math.ceil(axis.height)}px` }}>
        <AxisRules axis={axis} />
        {days.map((day, index) => (
          <div key={day} className={`calendar-grid__column${day === model.today ? ' calendar-grid__column--today' : ''}`} style={{ gridColumn: at(index) }}>
            {segments[index].map((segment) => (
              <EventBox
                key={`${segment.placed.order}-${day}`}
                segment={segment}
                axis={axis}
                model={model}
                day={day}
                width={segment.stepped ? columnWidth - segment.column * STEP_INSET_PX : (columnWidth * segment.span) / segment.columns}
                marked={marked}
                first={firstBox(segment.placed.event.id)}
              />
            ))}
          </div>
        ))}
        {nowMinute !== undefined ? <NowLine axis={axis} minute={nowMinute} column={nowColumn} columns={columns} /> : null}
        {bars.length === 0 && segments.every((list) => list.length === 0) ? <div className="calendar-grid__nothing tech micro">NOTHING SCHEDULED</div> : null}
      </div>
    </ListViewport>
  );

  if (!pages) return <div className="calendar-grid">{grid}</div>;
  return (
    <PagedDays
      before={first > 0 ? runText(model.days.slice(0, first), model.placed) : null}
      after={first + columns < model.days.length ? runText(model.days.slice(first + columns), model.placed) : null}
      onTurn={(direction) => turn(first + direction * columns)}
    >
      {grid}
    </PagedDays>
  );
}

/** The hour rules, the hour labels in the gutter, and each fold of empty hours. */
function AxisRules({ axis }: { axis: TimeAxis }) {
  const rules: ReactNode[] = [];
  for (const band of axis.bands) {
    if (band.kind === 'fold') {
      rules.push(
        <div key={`fold-${band.from}`} className="calendar-grid__fold" style={{ top: `${band.top}px`, height: `${band.height}px` }}>
          <span className="calendar-grid__fold-text tech micro">{`${clockText(band.from * 60)}\u2013${clockText(band.to * 60)}`}</span>
        </div>,
      );
      continue;
    }
    for (let hour = band.from; hour < band.to; hour += 1) {
      const top = band.top + (hour - band.from) * axis.hourPx;
      rules.push(
        <div key={`hour-${hour}`} className="calendar-grid__hour" style={{ top: `${top}px` }}>
          <span className="calendar-grid__hour-text tech micro">{clockText(hour * 60)}</span>
        </div>,
      );
    }
  }
  return <div className="calendar-grid__rules" aria-hidden="true">{rules}</div>;
}

/** The agent's now: a line across today's column, its time in the gutter. The grid opens on it. */
function NowLine({ axis, minute, column, columns }: { axis: TimeAxis; minute: number; column: number; columns: number }) {
  const top = axisY(axis, minute);
  return (
    <div className="calendar-grid__now" data-lead="" style={{ top: `${top}px`, '--now-column': column, '--columns': columns } as CSSProperties} aria-label={`Now, ${clockText(minute)}`}>
      <span className="calendar-grid__now-text tech micro">{clockText(minute)}</span>
      <span className="calendar-grid__now-line" />
    </div>
  );
}

function EventBox({ segment, axis, model, day, width, marked, first }: {
  segment: GridSegment;
  axis: TimeAxis;
  model: CalendarModel;
  day: number;
  width: number;
  marked?: string;
  first: boolean;
}) {
  const { placed } = segment;
  const top = axisY(axis, segment.start);
  const height = Math.max(MIN_EVENT_PX, axisY(axis, segment.end) - top) - 1;
  // The box's lines, given out in order: the title (a narrow box gives it
  // every line it can use, as the grid already says the time), then the
  // time, where, and the detail.
  const lines = Math.max(1, Math.floor((height - 2) / LINE_PX));
  const narrow = width < 100;
  const wide = width >= 220;
  const titleLines = lines <= 1 ? 1 : narrow ? Math.min(3, lines) : Math.min(2, lines - 1);
  const rest = lines - titleLines;
  const showTime = lines > 1 && rest >= 1;
  const showWhere = rest >= 2 && Boolean(placed.event.location);
  const showDetail = rest >= (showWhere ? 3 : 2) && Boolean(placed.event.detail);
  const timeText = rangeWords(eventTimeText(placed, day));
  const status = statusTag(placed);
  const isMarked = first && marked === placed.event.id;
  const sizeClass = lines <= 1 ? 'calendar-event--line' : 'calendar-event--lines';
  // The box sits in a slot of its place and size; the NOTE badge rides the
  // slot's top edge, outside the box's clip, so it never takes a title's room.
  const place: CSSProperties = segment.stepped
    ? { top: `${top}px`, height: `${height}px`, left: `${1 + segment.column * STEP_INSET_PX}px`, right: '2px', zIndex: (placed.event.active ? 3 : 1) + segment.column }
    : {
        top: `${top}px`,
        height: `${height}px`,
        left: `calc(${(segment.column / segment.columns) * 100}% + 1px)`,
        width: `calc(${(segment.span / segment.columns) * 100}% - 3px)`,
        zIndex: placed.event.active ? 3 : undefined,
      };
  return (
    <div className={`calendar-event-slot${isMarked ? ' calendar-event-slot--marked' : ''}`} data-item={placed.event.id} style={place}>
      <div
        className={[
          eventClasses('calendar-event', placed, model),
          sizeClass,
          segment.fromBefore ? 'calendar-event--from-before' : '',
          segment.toAfter ? 'calendar-event--to-after' : '',
          segment.stepped && segment.column > 0 ? 'calendar-event--stepped' : '',
        ].filter(Boolean).join(' ')}
      >
        {lines <= 1 && wide ? <span className="calendar-event__time calendar-event__time--inline tech micro">{timeText}</span> : null}
        <span className="calendar-event__title" style={{ '--title-lines': titleLines } as CSSProperties}>{placed.event.title}</span>
        {lines <= 1 && width >= 360 && placed.event.location ? <span className="calendar-event__where calendar-event__where--inline">{placed.event.location}</span> : null}
        {showTime ? <span className="calendar-event__time tech micro">{status ? `${timeText} / ${status}` : timeText}</span> : null}
        {showWhere ? <span className="calendar-event__where">{placed.event.location}</span> : null}
        {showDetail ? <span className="calendar-event__detail">{placed.event.detail}</span> : null}
      </div>
      {isMarked ? <NoteBadge className="calendar-event__note" /> : null}
    </div>
  );
}

function DayBarBox({ bar, model, marked, first, column }: { bar: DayBar; model: CalendarModel; marked?: string; first: boolean; column: number }) {
  const { placed } = bar;
  const isMarked = first && marked === placed.event.id;
  const status = statusTag(placed);
  return (
    <div
      className={[
        eventClasses('calendar-bar', placed, model),
        bar.fromBefore ? 'calendar-bar--from-before' : '',
        bar.toAfter ? 'calendar-bar--to-after' : '',
        isMarked ? 'calendar-bar--marked' : '',
      ].filter(Boolean).join(' ')}
      data-item={placed.event.id}
      style={{ gridColumn: `${bar.from + column} / ${bar.to + column + 1}`, gridRow: bar.lane + 1 }}
    >
      <span className="calendar-bar__title">{placed.event.title}</span>
      {status ? <span className="calendar-bar__status tech micro">{status}</span> : null}
      {isMarked ? <NoteBadge className="calendar-bar__note" /> : null}
    </div>
  );
}

/**
 * Days a grid has no room for: the grid draws the columns that fit, and on
 * each side it hides days a rail names them and counts their events, as a
 * scrolled drawing's rail counts its parts (the same cut line and tag). A
 * tap on the tag, or a swipe across the days, turns to the next of them.
 */
function PagedDays({ before, after, onTurn, children }: { before: string | null; after: string | null; onTurn: (direction: -1 | 1) => void; children: ReactNode }) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  const tag = (side: 'left' | 'right', text: string) => (
    <>
      <div className={`drawing-viewport__rail drawing-viewport__rail--${side}`} aria-hidden="true" />
      <div
        className={`drawing-viewport__rim drawing-viewport__rim--${side} calendar-pages__rim`}
        onClick={(event: MouseEvent<HTMLDivElement>) => {
          // Handled, so the surface does not also expand the calendar; it bubbles on (FocusableSurface).
          event.preventDefault();
          onTurn(side === 'left' ? -1 : 1);
        }}
        aria-hidden="true"
      >
        <span className="drawing-viewport__rim-text">{text}</span>
        <svg className="drawing-viewport__chevron" viewBox="0 0 8 6" aria-hidden="true">
          <path d="M 4 0 L 8 6 L 0 6 Z" />
        </svg>
      </div>
    </>
  );
  return (
    <div
      className="calendar-grid calendar-pages"
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        start.current = { x: event.clientX, y: event.clientY };
        swiped.current = false;
      }}
      onPointerUp={(event: PointerEvent<HTMLDivElement>) => {
        const from = start.current;
        start.current = null;
        if (!from) return;
        const dx = event.clientX - from.x;
        const dy = event.clientY - from.y;
        if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        const direction = dx < 0 ? 1 : -1;
        if ((direction < 0 && before) || (direction > 0 && after)) {
          swiped.current = true;
          onTurn(direction);
        }
      }}
      onClickCapture={(event: MouseEvent<HTMLDivElement>) => {
        // A swipe that turned a page is not also a tap that expands the calendar.
        if (swiped.current) {
          swiped.current = false;
          event.preventDefault();
        }
      }}
    >
      {children}
      <div className="calendar-pages__edges" style={{ left: `${GUTTER_PX}px` }} data-rail={PAGE_RAIL_PX}>
        {before ? tag('left', before) : null}
        {after ? tag('right', after) : null}
      </div>
    </div>
  );
}

// ---- the month -------------------------------------------------------------------

/** One week row of a month, planned before it is drawn. */
interface WeekPlan {
  week: number[];
  bars: DayBar[];
  lanes: number;
  cells: Array<{ day: number; timed: PlacedEvent[]; shown: number; more: number; touching: PlacedEvent[] }>;
}

const MAX_MARKS = 4;

/** A day's events as a month too small for titles marks them: all-day first, then by start. */
function markedOrder(cell: WeekPlan['cells'][number]): PlacedEvent[] {
  const continuing = cell.touching.filter((item) => !item.allDay && item.firstDay !== cell.day);
  return [...cell.touching.filter((item) => item.allDay), ...continuing, ...cell.timed];
}

function planMonth(weeks: number[][], model: CalendarModel, capacity: number): WeekPlan[] {
  return weeks.map((week) => {
    const bars = dayBars(model.placed, week);
    const timedByDay = week.map((day) => timedOn(model.placed, day));
    const row = monthRowPlan(bars, timedByDay.map((timed) => timed.length), capacity);
    return {
      week,
      bars,
      lanes: row.lanes,
      cells: week.map((day, index) => ({
        day,
        timed: timedByDay[index],
        shown: row.cells[index].timed,
        more: row.cells[index].more,
        touching: model.placed.filter((item) => item.firstDay <= day && item.lastDay >= day),
      })),
    };
  });
}

/** Where each event is first drawn in a month, by a key of its place: the one its id and a note's badge go on. */
function firstPlaces(plans: WeekPlan[], marks: boolean): Map<string, string> {
  const first = new Map<string, string>();
  const see = (id: string, place: string) => {
    if (!first.has(id)) first.set(id, place);
  };
  plans.forEach((plan, row) => {
    if (marks) {
      for (const cell of plan.cells) {
        const order = markedOrder(cell);
        order.slice(0, order.length > MAX_MARKS ? MAX_MARKS - 1 : MAX_MARKS).forEach((item) => see(item.event.id, `mark-${cell.day}-${item.order}`));
      }
      return;
    }
    for (const bar of plan.bars) if (bar.lane < plan.lanes) see(bar.placed.event.id, `bar-${row}-${bar.placed.order}`);
    for (const cell of plan.cells) for (const item of cell.timed.slice(0, cell.shown)) see(item.event.id, `line-${cell.day}-${item.order}`);
  });
  return first;
}

function MonthView({ data, model, marked, size, marks }: { data: CalendarData; model: CalendarModel; marked?: string; size: ElementSize; marks: boolean }) {
  const grid = monthGrid(parseTimeValue(data.start)?.dayNumber ?? 0);
  const rows = grid.weeks.length;
  // A month too small for titles marks each day's events and lists them
  // under the grid, from today when today is in the month, if there is room.
  const gridHeight = marks ? Math.min(size.height > 0 ? size.height : 260, MONTH_WEEKDAY_PX + rows * 46) : size.height;
  const listRoom = marks && size.height > 0 ? size.height - gridHeight : 0;
  const cellHeight = gridHeight > 0 ? (gridHeight - MONTH_WEEKDAY_PX) / rows : 96;
  const capacity = marks ? 0 : Math.max(1, Math.floor((cellHeight - MONTH_NUMBER_PX) / MONTH_LINE_PX));
  const plans = planMonth(grid.weeks, model, capacity);
  const first = firstPlaces(plans, marks);
  const isFirst = (id: string, place: string) => first.get(id) === place;
  const monthDays = grid.weeks.flat().filter((day) => calendarDay(day).month === grid.month);
  const listFrom = model.today !== undefined && monthDays.includes(model.today) ? model.today : monthDays[0];
  return (
    <div className={`calendar-month${marks ? ' calendar-month--marks' : ''}`}>
      <div className="calendar-month__grid" style={marks ? { height: `${gridHeight}px`, flex: 'none' } : undefined}>
        <div className="calendar-month__weekdays" style={{ height: `${MONTH_WEEKDAY_PX}px` }}>
          {grid.weeks[0].map((day) => <span key={day} className="tech micro">{weekdayName(day)}</span>)}
        </div>
        <div className="calendar-month__weeks" style={{ gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
          {plans.map((plan, row) => (
            <MonthWeek key={plan.week[0]} plan={plan} row={row} month={grid.month} model={model} marked={marked} capacity={capacity} marks={marks} isFirst={isFirst} />
          ))}
        </div>
      </div>
      {marks && listRoom >= 96 ? (
        <div className="calendar-month__list" style={{ height: `${listRoom}px` }}>
          <AgendaList model={model} days={monthDays.filter((day) => day >= listFrom)} marked={marked} compact />
        </div>
      ) : null}
    </div>
  );
}

function MonthWeek({ plan, row, month, model, marked, capacity, marks, isFirst }: {
  plan: WeekPlan;
  row: number;
  month: number;
  model: CalendarModel;
  marked?: string;
  capacity: number;
  marks: boolean;
  isFirst: (id: string, place: string) => boolean;
}) {
  const rows = marks ? 'minmax(0, 1fr)' : `${MONTH_NUMBER_PX}px repeat(${capacity}, ${MONTH_LINE_PX}px) minmax(0, 1fr)`;
  return (
    <div className="calendar-month__week" style={{ gridTemplateRows: rows }}>
      {plan.cells.map((cell, index) => {
        const info = calendarDay(cell.day);
        return (
          <div
            key={cell.day}
            className={[
              'calendar-month__cell',
              info.month !== month ? 'calendar-month__cell--outside' : '',
              cell.day === model.today ? 'calendar-month__cell--today' : '',
              cell.day < (model.today ?? -Infinity) ? 'calendar-month__cell--past' : '',
            ].filter(Boolean).join(' ')}
            style={{ gridColumn: index + 1 }}
          >
            <span className="calendar-month__number">{info.day}</span>
            {marks && cell.touching.length > 0 ? <DayMarks cell={cell} model={model} marked={marked} isFirst={isFirst} /> : null}
          </div>
        );
      })}
      {marks
        ? null
        : plan.bars.filter((bar) => bar.lane < plan.lanes).map((bar) => (
            <DayBarBox
              key={`bar-${bar.placed.order}`}
              bar={{ ...bar, lane: bar.lane + 1 }}
              model={model}
              marked={marked}
              first={isFirst(bar.placed.event.id, `bar-${row}-${bar.placed.order}`)}
              column={1}
            />
          ))}
      {marks
        ? null
        : plan.cells.map((cell, index) => (
            <MonthLines key={`lines-${cell.day}`} cell={cell} column={index + 1} firstRow={2 + plan.lanes} model={model} marked={marked} isFirst={isFirst} />
          ))}
    </div>
  );
}

function MonthLines({ cell, column, firstRow, model, marked, isFirst }: {
  cell: WeekPlan['cells'][number];
  column: number;
  firstRow: number;
  model: CalendarModel;
  marked?: string;
  isFirst: (id: string, place: string) => boolean;
}) {
  return (
    <>
      {cell.timed.slice(0, cell.shown).map((placed, index) => {
        const first = isFirst(placed.event.id, `line-${cell.day}-${placed.order}`);
        const isMarked = first && marked === placed.event.id;
        return (
          <div
            key={placed.order}
            className={`${eventClasses('calendar-line', placed, model)}${isMarked ? ' calendar-line--marked' : ''}`}
            data-item={placed.event.id}
            style={{ gridColumn: column, gridRow: firstRow + index }}
          >
            {/* A marked line wears the badge where its time was: a cell has no room for both, and the note's TARGET line says when. */}
            {isMarked ? <NoteBadge className="calendar-line__note" /> : <span className="calendar-line__time tech micro">{clockText(placed.start - cell.day * MINUTES_PER_DAY)}</span>}
            <span className="calendar-line__title">{placed.event.title}</span>
          </div>
        );
      })}
      {cell.more > 0 ? (
        <span className="calendar-more tech micro" style={{ gridColumn: column, gridRow: firstRow + cell.shown }}>+{cell.more} MORE</span>
      ) : null}
    </>
  );
}

/** A day's events in a month too small for titles: a short bar each, in its colour. */
function DayMarks({ cell, model, marked, isFirst }: { cell: WeekPlan['cells'][number]; model: CalendarModel; marked?: string; isFirst: (id: string, place: string) => boolean }) {
  const ordered = markedOrder(cell);
  const shown = ordered.slice(0, ordered.length > MAX_MARKS ? MAX_MARKS - 1 : MAX_MARKS);
  return (
    <span className="calendar-marks" aria-label={`${ordered.length} ${ordered.length === 1 ? 'event' : 'events'}`}>
      {shown.map((placed) => {
        const first = isFirst(placed.event.id, `mark-${cell.day}-${placed.order}`);
        return (
          <span key={placed.order} className={eventClasses('calendar-mark', placed, model)} data-item={placed.event.id} title={placed.event.title}>
            {first && marked === placed.event.id ? <NoteBadge className="calendar-mark__note" /> : null}
          </span>
        );
      })}
      {ordered.length > shown.length ? <span className="calendar-marks__more tech micro">+{ordered.length - shown.length}</span> : null}
    </span>
  );
}

// ---- the agenda ------------------------------------------------------------------

function AgendaList({ model, days, marked, compact = false }: { model: CalendarModel; days: number[]; marked?: string; compact?: boolean }) {
  const entries = agendaEntries(model.placed, days, model.today, model.now);
  const markedShown = marked !== undefined && entries.some((entry) => entry.kind === 'day' && [...entry.allDay, ...entry.timed].some((item) => item.first && item.placed.event.id === marked));
  return (
    <ListViewport
      noun={['EVENT', 'EVENTS']}
      lead={markedShown ? marked : undefined}
      className={`calendar-agenda__viewport${compact ? ' calendar-agenda__viewport--compact' : ''}`}
      scrollClassName="calendar-agenda__scroll"
      label="Agenda"
    >
      <ol className="calendar-agenda">
        {entries.map((entry) => {
          if (entry.kind === 'empty') {
            return (
              <li key={`empty-${entry.from}`} className="calendar-agenda__empty tech micro">
                <span>{entry.from === entry.to ? dayLabel(entry.from) : `${dayLabel(entry.from)} - ${dayLabel(entry.to)}`}</span>
                <span className="calendar-agenda__empty-text">NOTHING SCHEDULED</span>
              </li>
            );
          }
          const count = entry.allDay.length + entry.timed.length;
          const overlaps = overlapping(entry.timed);
          const rows: ReactNode[] = entry.allDay.map((item) => <AgendaRow key={`a-${item.placed.order}`} item={item} day={entry.day} model={model} marked={marked} />);
          entry.timed.forEach((item, index) => {
            if (entry.nowAt === index) rows.push(<AgendaNow key="now" minute={(model.now as number) - entry.day * MINUTES_PER_DAY} />);
            rows.push(<AgendaRow key={`t-${item.placed.order}`} item={item} day={entry.day} model={model} marked={marked} overlaps={overlaps.has(item.placed)} />);
          });
          if (entry.nowAt === entry.timed.length) rows.push(<AgendaNow key="now" minute={(model.now as number) - entry.day * MINUTES_PER_DAY} />);
          return (
            <li key={entry.day} className={`calendar-agenda__day${entry.day === model.today ? ' calendar-agenda__day--today' : ''}${entry.day < (model.today ?? -Infinity) ? ' calendar-agenda__day--past' : ''}`}>
              <div className="calendar-agenda__day-head tech micro">
                <span className="calendar-agenda__day-name">{dayLabel(entry.day)}</span>
                {entry.day === model.today ? <span className="calendar-agenda__today">TODAY</span> : null}
                {/* One day's count is the meta line's already. */}
                {days.length > 1 || count === 0 ? <span className="calendar-agenda__day-count">{count === 0 ? 'NOTHING SCHEDULED' : `${count} ${count === 1 ? 'EVENT' : 'EVENTS'}`}</span> : null}
              </div>
              {rows.length > 0 ? <ol className="calendar-agenda__items">{rows}</ol> : null}
            </li>
          );
        })}
      </ol>
    </ListViewport>
  );
}

function AgendaNow({ minute }: { minute: number }) {
  return (
    <li className="calendar-agenda__now" data-lead="" aria-label={`Now, ${clockText(minute)}`}>
      <span className="calendar-agenda__now-text tech micro">NOW {clockText(minute)}</span>
      <span className="calendar-agenda__now-line" />
    </li>
  );
}

function AgendaRow({ item, day, model, marked, overlaps = false }: { item: AgendaItem; day: number; model: CalendarModel; marked?: string; overlaps?: boolean }) {
  const { placed } = item;
  const time = eventTimeText(placed, day);
  const status = statusTag(placed);
  const isMarked = item.first && marked === placed.event.id;
  const where = [placed.event.location, placed.event.detail].filter(Boolean);
  return (
    <li
      className={`${eventClasses('calendar-agenda__item', placed, model)}${isMarked ? ' calendar-agenda__item--marked' : ''}${item.first ? '' : ' calendar-agenda__item--again'}`}
      data-item={placed.event.id}
    >
      <span className="calendar-agenda__time">
        <span className="calendar-agenda__from">{time.from}</span>
        {time.to ? <span className="calendar-agenda__to">{time.to}</span> : null}
      </span>
      <span className="calendar-agenda__stripe" aria-hidden="true" />
      <span className="calendar-agenda__text">
        <span className="calendar-agenda__title">{placed.event.title}</span>
        {where.length > 0 ? <span className="calendar-agenda__where">{where.join(' / ')}</span> : null}
      </span>
      <span className="calendar-agenda__tags tech micro">
        {placed.event.active ? <span className="calendar-tag calendar-tag--active">ACTIVE</span> : null}
        {status ? <span className={`calendar-tag calendar-tag--${placed.event.status}`}>{status}</span> : null}
        {overlaps && placed.event.status !== 'cancelled' ? <span className="calendar-tag calendar-tag--overlap">OVERLAP</span> : null}
        {isMarked ? <NoteBadge /> : null}
      </span>
    </li>
  );
}

// ---- the calendar ------------------------------------------------------------------

const VIEW_NAMES = { day: 'DAY', week: 'WEEK', month: 'MONTH', agenda: 'AGENDA' } as const;

/** The scene frame's words for a calendar holding the main slot, where it sent none. */
export function calendarFrame(data: CalendarData): { title: string; subtitle: string; context: string } {
  const count = data.events.length;
  return {
    title: data.title ?? `CALENDAR / ${VIEW_NAMES[data.view]}`,
    subtitle: data.subtitle ?? `${rangeText(data)} / ${count} ${count === 1 ? 'EVENT' : 'EVENTS'}`,
    context: data.context ?? 'CALENDAR',
  };
}

export function CalendarPrimitive({ data, marked, focused = false }: { data: CalendarData; marked?: string; focused?: boolean }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(bodyRef);
  const model = useMemo(() => calendarModel(data), [data]);
  const choice = chooseLayout(data, size, model.days.length);
  const count = data.events.length;
  // The meta line: what is shown and how much; an aux cell and focus have no scene frame to say it.
  const meta = (
    <div className="calendar__meta tech micro">
      <span className="calendar__meta-title">{data.title ?? `${VIEW_NAMES[data.view]} / ${rangeText(data)}`}</span>
      <span className="calendar__meta-range">
        {data.title && model.days.length > 1 ? `${rangeText(data)} / ` : ''}
        {count} {count === 1 ? 'EVENT' : 'EVENTS'}
        {model.outside > 0 ? ` / ${model.outside} OUT OF VIEW` : ''}
      </span>
    </div>
  );
  let body: ReactNode;
  if (choice.layout === 'grid') body = <TimeGrid data={data} model={model} marked={marked} size={size} columns={choice.columns} />;
  else if (choice.layout === 'month' || choice.layout === 'month-marks') body = <MonthView data={data} model={model} marked={marked} size={size} marks={choice.layout === 'month-marks'} />;
  else body = <AgendaList model={model} days={model.days} marked={marked} />;
  return (
    <div
      className={`calendar calendar--${data.view} calendar--layout-${choice.layout}${focused ? ' calendar--focused' : ''}`}
      style={{ '--calendar-gutter': `${GUTTER_PX}px` } as CSSProperties}
      data-testid="calendar"
      data-view={data.view}
      data-layout={choice.layout}
      data-columns={choice.layout === 'grid' ? choice.columns : undefined}
    >
      {meta}
      <div className="calendar__body" ref={bodyRef}>
        {body}
      </div>
    </div>
  );
}


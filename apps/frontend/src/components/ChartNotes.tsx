import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ChartData, NoteData, SceneObject } from '../controller/types';
import { noteTarget } from '../app/noteItems';
import { AnnotationCard } from '../primitives/AnnotationCard';
import {
  chartFrame,
  chartObstacles,
  chartRingBox,
  chartScales,
  chartNoteTarget,
  type ChartAnchor,
  type ChartScales,
  type ChartSide,
} from '../primitives/chartGeometry';
import { layoutNotes, NOTE_CARD_CUT, placedInFull, routeLeader, type NoteField, type NoteToPlace } from '../primitives/notePlacement';
import { crispLine, type Point, type Rect, type Size } from '../primitives/geometry';
import { svgUrl, useSvgIds } from '../hooks/useSvgIds';
import { SurfaceBoundary } from './SurfaceBoundary';

/** One note on a chart: a note object, or the spoken explanation standing in for one. */
export interface ChartNote {
  key: string;
  data: NoteData;
  object?: SceneObject<NoteData>;
}

interface NotesLayout {
  cards: Record<string, Rect>;
  /** The width a card is drawn at where it is placed narrower than the stylesheet has it. */
  widths: Record<string, number>;
  leaders: Record<string, Point[]>;
  /** The note left out so the others have places clear of the data; the rail carries it instead. */
  away: string | null;
}

// The narrower widths a card with no clear place tries, as shares of its
// own, down to the least: a card narrower reads as a column of words.
const NARROWER = [0.8, 0.64];
const MIN_CARD_WIDTH = 180;
// The wider widths a card whose text would scroll tries, and the most of
// the layer it may take.
const WIDER = [1.25, 1.5, 1.75];
const MAX_CARD_SHARE = 0.8;

// The notes are placed again at most once a step of this many pixels of
// the layer's size or the chart's, as a graph is laid out once a step
// (diagramLayout's FRAME_STEP): a placement of a few notes costs tens of
// milliseconds of CPU on a line chart and up to some 70 ms on a dense bar
// chart (four series of 40 with five notes and the rail), more in the page,
// and a resize measures every frame. The scene lays at most
// `NOTES_PLACED_IN_FULL` notes on a chart (the rail takes the rest); past
// that many `layoutNotes` would bound its work (`placedInFull`), a guard
// the page does not reach.
// Within a step the cards follow their points, and once the size has held
// still for `REST_MS` the notes are placed for it, so where they come to
// rest is where they would stand had the page opened at that size.
const PLACE_STEP = 16;
const REST_MS = 150;

const step = (pixels: number) => Math.floor(pixels / PLACE_STEP);

/** What a placement was worked out for, so a measure within the same step can follow it rather than place again. */
interface Placed {
  /** The layer's size and the chart's, by step. */
  key: string;
  /** The same, to the pixel: a measure that finds them unchanged keeps the place, unless a card changed size by itself. */
  exact: string;
  /** The notes placed, by what they say: a note shown with new words is placed again; the same words in a new object (a spoken stand-in, built every render) are not. */
  notes: string;
  /** The size each card is drawn at: a card that changes size by itself (its words reflowed) is placed again. */
  cards: Record<string, Size>;
  layout: NotesLayout;
  /** The layer's room for cards when placed. */
  area: Rect;
  /** The chart's frame when placed, and where each named point's leader landed in it and on the layer. */
  frame: Size;
  points: Record<string, { view: Point; layer: Point }>;
}

// The layout placed for one size, moved to another within its step: a card
// that names a point moves as its point does, its leader with it; one that
// names none keeps its distance from the corner it is nearest. Only for the
// frames a resize passes through: the size it rests at is placed afresh.
function follow(placed: Placed, area: Rect, toLayer: ((point: Point) => Point) | undefined, frame: Size): NotesLayout {
  const next: NotesLayout = { cards: {}, widths: placed.layout.widths, leaders: {}, away: placed.layout.away };
  for (const [key, card] of Object.entries(placed.layout.cards)) {
    const point = placed.points[key];
    let dx = 0;
    let dy = 0;
    if (point && toLayer) {
      // A frame recomposed for the new slot is near enough the old one,
      // stretched, for the few pixels of a step.
      const now = toLayer({ x: (point.view.x * frame.width) / placed.frame.width, y: (point.view.y * frame.height) / placed.frame.height });
      // Whole pixels, so a leader stays on the half pixel it was snapped to.
      dx = Math.round(now.x - point.layer.x);
      dy = Math.round(now.y - point.layer.y);
    } else {
      const middle = { x: (placed.area.left + placed.area.right) / 2, y: (placed.area.top + placed.area.bottom) / 2 };
      dx = Math.round((card.left + card.right) / 2 > middle.x ? area.right - placed.area.right : area.left - placed.area.left);
      dy = Math.round((card.top + card.bottom) / 2 > middle.y ? area.bottom - placed.area.bottom : area.top - placed.area.top);
    }
    next.cards[key] = { left: card.left + dx, top: card.top + dy, right: card.right + dx, bottom: card.bottom + dy };
    const leader = placed.layout.leaders[key];
    if (leader) next.leaders[key] = leader.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  }
  return next;
}

// Where on the chart a note names a point, if it names one there, and the
// side its leader must come from: on a bar chart the bar's callout, past
// its end.
function chartNotePoint(
  note: NoteData,
  chart: SceneObject<ChartData>,
  scales?: ChartScales,
): { point: Point; from?: ChartSide; bar?: Rect; value?: Rect } | undefined {
  if (note.anchor?.target !== chart.id || note.anchor.x === undefined) return undefined;
  return chartNoteTarget(chart.data, { x: note.anchor.x, series: note.anchor.series }, scales);
}

/** The points the notes on a chart name on it, for the chart to mark. */
export function chartNoteAnchors(chart: SceneObject<ChartData>, notes: ChartNote[]): ChartAnchor[] {
  return notes.flatMap((note) => {
    const anchor = note.data.anchor;
    return anchor?.target === chart.id && anchor.x !== undefined ? [{ x: anchor.x, series: anchor.series }] : [];
  });
}

// How much a transform in flight (a panel moving into place) scales an
// element on screen against its laid-out size. The laid-out size rounds to
// whole pixels, so a scale that close to 1 is 1. jsdom lays nothing out and
// reports no size, so there it is 1.
function screenScale(element: HTMLElement, rect: DOMRect): { kx: number; ky: number } {
  const kx = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
  const ky = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
  return { kx: Math.abs(kx - 1) < 0.01 || !(kx > 0) ? 1 : kx, ky: Math.abs(ky - 1) < 0.01 || !(ky > 0) ? 1 : ky };
}

function sameLayout(a: NotesLayout | null, b: NotesLayout): boolean {
  if (!a || a.away !== b.away) return false;
  const aKeys = Object.keys(a.cards);
  const bKeys = Object.keys(b.cards);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of bKeys) {
    if (Math.abs((a.widths[key] ?? 0) - (b.widths[key] ?? 0)) > 0.25) return false;
    const x = a.cards[key];
    const y = b.cards[key];
    if (!x || Math.abs(x.left - y.left) > 0.25 || Math.abs(x.top - y.top) > 0.25) return false;
    const p = a.leaders[key] ?? [];
    const q = b.leaders[key] ?? [];
    if (p.length !== q.length || p.some((point, index) => Math.abs(point.x - q[index].x) > 0.25 || Math.abs(point.y - q[index].y) > 0.25)) {
      return false;
    }
  }
  return true;
}

/**
 * The notes on one chart, laid over its panel rather than in a band that
 * shrinks the plot. Every note the chart carries is shown: one that names a
 * point on this chart centres over it where it can and runs a leader to it;
 * one that names none sits in a corner. The layer measures the cards, the
 * chart's drawn geometry and itself, and `layoutNotes` decides where each
 * card goes, so no card covers another, its own point, or the data the
 * chart draws where a clear place exists -- on a chart with at most
 * `NOTES_PLACED_IN_FULL` notes, as many as the scene lays on one chart
 * (the rail takes the rest); given more, the placement is bounded
 * (`placedInFull`), and a later card may cover them.
 *
 * Where the scene gives it `onRailNote` and some card has no place that
 * keeps those rules -- every bar standing to the top, say -- one note is
 * handed to the rail instead, where that leaves fewer cards astray
 * (`layoutNotes`' `spill`: the one whose absence leaves the fewest, a note
 * naming no point first among those), on a chart placed in full. The
 * layer names it through `onRailNote` and keeps its card out of view (still
 * measured, so it comes back the moment the chart has room). The chart
 * keeps the point it names marked: a bar by its callout, a point on a line
 * by a ring once the scene no longer counts it among the points a leader
 * reaches (`ChartPrimitive led`).
 */
export function ChartNotes({
  chart,
  objects,
  notes,
  onFocus,
  onOpenHistory,
  onRailNote,
  named: namedPoints,
}: {
  chart: SceneObject<ChartData>;
  /** Every object on stage, by id: a card names the one its note is about (`noteTarget`). */
  objects: Readonly<Record<string, SceneObject>>;
  notes: ChartNote[];
  onFocus: (id: string | null) => void;
  onOpenHistory?: () => void;
  onRailNote?: (chartId: string, key: string, away: boolean) => void;
  /**
   * Every point the chart marks for its notes, as given to the chart
   * (`ChartPrimitive named`): the notes laid here and any the scene shows
   * elsewhere (the band under the chart). The layer keeps every card off
   * what the chart draws for them: a bar's printed value, and the ring
   * round a point whose note is not laid here. The notes laid here, when
   * not given.
   */
  named?: ChartAnchor[];
}) {
  const reduced = useReducedMotion();
  const ids = useSvgIds();
  const layerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [layout, setLayout] = useState<NotesLayout | null>(null);
  // The last placement, which a resize within its step follows.
  const placedRef = useRef<Placed | null>(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const chartRef = useRef(chart);
  chartRef.current = chart;
  const marked = useMemo(() => namedPoints ?? chartNoteAnchors(chart, notes), [namedPoints, chart, notes]);
  const markedRef = useRef(marked);
  markedRef.current = marked;
  const spill = onRailNote !== undefined;
  // A chart too long for its slot scrolls its canvas in it
  // (ChartPrimitive). The layer stays where it is, beside the chart's
  // expand control rather than inside it (a card is a control of its own),
  // and follows the canvas: it is clipped to the scroll's port, and its
  // frame -- the box the cards and leaders are placed in -- is the canvas's
  // size, moved by the scroll, so the cards are laid out over the whole
  // chart and keep to the bars they name. Found from the panel the layer
  // stands in; found in the same frame the chart starts or stops scrolling:
  // at mount the layout effect's own update is committed before the frame
  // is painted, and a later change the observer reports is committed at once
  // (flushSync), which React allows outside a lifecycle method only.
  const outerRef = useRef<HTMLDivElement>(null);
  const [canvas, setCanvas] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const panel = outerRef.current?.parentElement;
    if (!panel) return undefined;
    const find = () => panel.querySelector<HTMLElement>('.chart-primitive__canvas');
    setCanvas(find());
    const watcher = new MutationObserver(() => flushSync(() => setCanvas(find())));
    watcher.observe(panel, { childList: true, subtree: true });
    return () => watcher.disconnect();
  }, []);
  useLayoutEffect(() => {
    const outer = outerRef.current;
    const frame = layerRef.current;
    const scroll = canvas?.parentElement;
    const port = scroll?.parentElement;
    if (!outer || !frame || !canvas || !scroll || !port) return undefined;
    const follow = () => {
      frame.style.transform = `translateY(${-scroll.scrollTop}px)`;
    };
    const place = () => {
      const panel = outer.offsetParent as HTMLElement | null;
      if (!panel) return;
      const at = port.getBoundingClientRect();
      const from = panel.getBoundingClientRect();
      Object.assign(outer.style, {
        inset: 'auto',
        left: `${at.left - from.left - panel.clientLeft}px`,
        top: `${at.top - from.top - panel.clientTop}px`,
        width: `${port.clientWidth}px`,
        height: `${port.clientHeight}px`,
        overflow: 'hidden',
      });
      frame.style.height = `${canvas.offsetHeight}px`;
      follow();
    };
    place();
    const resized = new ResizeObserver(place);
    resized.observe(port);
    resized.observe(canvas);
    scroll.addEventListener('scroll', follow, { passive: true });
    return () => {
      resized.disconnect();
      scroll.removeEventListener('scroll', follow);
      for (const key of ['inset', 'left', 'top', 'width', 'height', 'overflow'] as const) outer.style[key] = '';
      frame.style.height = '';
      frame.style.transform = '';
    };
  }, [canvas]);

  // What moves a card without resizing anything: which notes there are and
  // what each one names. A size change reaches the observer instead.
  const signature = [
    ...notes.map((note) => `${note.key}\u0000${note.data.anchor?.target ?? ''}\u0000${note.data.anchor?.x ?? ''}\u0000${note.data.anchor?.series ?? ''}`),
    ...marked.map((anchor) => `${anchor.x}\u0000${anchor.series ?? ''}`),
  ].join('\u0001');

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const svgOf = () => outerRef.current?.parentElement?.querySelector<SVGSVGElement>('.chart-primitive > svg, .chart-primitive__canvas > svg') ?? null;

    // Set while a resize is in flight: the placement for the size it rests at.
    let rest: ReturnType<typeof setTimeout> | undefined;

    // `resized`: a size changed (the observer's call), where the notes may
    // follow the last placement within its step; otherwise they are placed.
    const measure = (resized: boolean) => {
      const current = notesRef.current;
      const data = chartRef.current.data;
      // Everything is measured on screen and brought back to the layer's
      // own pixels, the ones its cards are positioned in.
      const layerRect = layer.getBoundingClientRect();
      const { kx, ky } = screenScale(layer, layerRect);
      const field: NoteField = { area: { left: 0, top: 0, right: layerRect.width / kx, bottom: layerRect.height / ky } };

      let toLayer: ((point: Point) => Point) | undefined;
      const svg = svgOf();
      const svgRect = svg?.getBoundingClientRect();
      // The frame the chart draws in, decided from its slot as the chart
      // decides it (`chartFrame`), so the layer never maps through a frame
      // the chart has yet to redraw in.
      const host = svg?.parentElement;
      const frame = chartFrame({ width: host?.offsetWidth ?? 0, height: host?.offsetHeight ?? 0 });
      if (svgRect && svgRect.width > 0 && svgRect.height > 0) {
        // The chart letterboxes its viewBox into its svg; map through the
        // same fit.
        const width = svgRect.width / kx;
        const height = svgRect.height / ky;
        const scale = Math.min(width / frame.width, height / frame.height);
        const left = (svgRect.left - layerRect.left) / kx + (width - frame.width * scale) / 2;
        const top = (svgRect.top - layerRect.top) / ky + (height - frame.height * scale) / 2;
        toLayer = (point) => ({ x: left + point.x * scale, y: top + point.y * scale });
      }
      // What the notes were placed for, by step and to the pixel.
      const sizes = [field.area.right, field.area.bottom, (svgRect?.width ?? 0) / kx, (svgRect?.height ?? 0) / ky];
      const offset = svgRect ? [(svgRect.left - layerRect.left) / kx, (svgRect.top - layerRect.top) / ky] : [0, 0];
      const key = sizes.map(step).join('x');
      const exact = [...sizes, ...offset].map((value) => value.toFixed(1)).join('x');
      // A resize within the step the notes were placed in: the size they
      // were placed for is theirs again, any other the cards follow to, and
      // where it rests they are placed for it. A card that changed size by
      // itself at the size they were placed for is placed again.
      const last = placedRef.current;
      const said = current.map((note) => `${note.key}\u0000${JSON.stringify(note.data)}`).join('\u0001');
      clearTimeout(rest);
      if (resized && last && last.notes === said && last.key === key) {
        if (last.exact !== exact) {
          const next = follow(last, field.area, toLayer, frame);
          setLayout((previous) => (sameLayout(previous, next) ? previous : next));
          rest = setTimeout(() => measure(false), REST_MS);
          return;
        }
        const resizedCard = Object.entries(last.cards).some(([key, size]) => {
          const rect = cardRefs.current.get(key)?.getBoundingClientRect();
          return rect !== undefined && (Math.abs(rect.width / kx - size.width) > 1 || Math.abs(rect.height / ky - size.height) > 1);
        });
        if (!resizedCard) {
          setLayout((previous) => (sameLayout(previous, last.layout) ? previous : last.layout));
          return;
        }
      }
      const rectToLayer = (rect: Rect): Rect => {
        const a = toLayer!({ x: rect.left, y: rect.top });
        const b = toLayer!({ x: rect.right, y: rect.bottom });
        return { left: a.x, top: a.y, right: b.x, bottom: b.y };
      };
      const scales = chartScales(data, frame);
      if (toLayer) {
        // The chart rings a point named here only where its note is laid
        // elsewhere: the notes laid here run their leaders to theirs.
        const obstacles = chartObstacles(data, scales, { named: markedRef.current, led: chartNoteAnchors(chartRef.current, current) });
        field.plot = rectToLayer(scales.plot);
        field.traces = obstacles.lines.map((line) => line.map(toLayer!));
        field.marks = obstacles.marks.map(rectToLayer);
        field.fills = obstacles.fills.map((piece) => piece.map(toLayer!));
        field.labels = obstacles.labels.map(rectToLayer);
        // Bars rise to the plot's border: a card lies wholly inside the plot or wholly outside it.
        field.wholly = scales.kind === 'bar';
      }

      // A card is measured at the width the stylesheet gives it, whatever
      // width the last layout set on it, and -- only where that has no clear
      // place, or a long way to run to its bar -- at narrower widths its
      // text still fits at. Widths are the layer's own pixels, which a panel
      // in flight scales on screen.
      const sizeAt = (element: HTMLDivElement, width?: number) => {
        const set = element.style.width;
        element.style.width = width === undefined ? '' : `${width}px`;
        const rect = element.getBoundingClientRect();
        const text = element.querySelector<HTMLElement>('.annotation-card__text');
        const fits = !text || text.scrollHeight <= text.clientHeight + 1;
        element.style.width = set;
        return { width: rect.width / kx, height: rect.height / ky, fits };
      };
      const toPlace: NoteToPlace[] = [];
      const cssWidths = new Map<string, number>();
      const points: Placed['points'] = {};
      for (const note of current) {
        const element = cardRefs.current.get(note.key);
        if (!element) continue;
        let size = sizeAt(element);
        cssWidths.set(note.key, size.width);
        // A card whose text would scroll at its width -- a short chart's --
        // takes the least wider width it reads whole at, as the layer allows.
        for (const share of WIDER) {
          if (size.fits || size.width * share > (field.area.right - field.area.left) * MAX_CARD_SHARE) break;
          const wider = sizeAt(element, cssWidths.get(note.key)! * share);
          if (wider.fits) size = wider;
        }
        const target = toLayer ? chartNotePoint(note.data, chartRef.current, scales) : undefined;
        if (target) points[note.key] = { view: target.point, layer: toLayer!(target.point) };
        toPlace.push({
          id: note.key,
          width: size.width,
          height: size.height,
          point: target && points[note.key].layer,
          from: target?.from,
          bar: target?.bar && rectToLayer(target.bar),
          value: target?.value && rectToLayer(target.value),
          // Shown in the rail, a point on a line, area or scatter chart
          // keeps a ring (`chartRings`), which the other cards keep off.
          ring: target && !target.from ? rectToLayer(chartRingBox(target.point)) : undefined,
        });
      }
      const options = { spill, leaderOverlap: 1 };
      let placed = layoutNotes(toPlace, field, options);
      // Past a few notes no card tries a narrower size, so none is measured.
      if (placedInFull(toPlace.length) && toPlace.some((note) => !placed.get(note.id)?.settled)) {
        for (const note of toPlace) {
          if (placed.get(note.id)?.settled) continue;
          const element = cardRefs.current.get(note.id)!;
          const widths = [...NARROWER.map((share) => note.width * share), MIN_CARD_WIDTH];
          note.sizes = [...new Set(widths.filter((width) => width >= MIN_CARD_WIDTH && width < note.width - 0.5).map(Math.round))]
            .sort((a, b) => b - a)
            .map((width) => sizeAt(element, width))
            .filter((size) => size.fits)
            .map(({ width, height }) => ({ width, height }));
        }
        placed = layoutNotes(toPlace, field, options);
      }
      const next: NotesLayout = { cards: {}, widths: {}, leaders: {}, away: null };
      for (const note of toPlace) {
        const place = placed.get(note.id);
        const card = place?.rect;
        if (!card) {
          // Left out so the others have clear places: the rail carries it,
          // and the chart keeps the point it names marked.
          next.away = note.id;
          continue;
        }
        const width = card.right - card.left;
        const rounded = {
          left: Math.round(card.left),
          top: Math.round(card.top),
          right: Math.round(card.left) + width,
          bottom: Math.round(card.top) + (card.bottom - card.top),
        };
        next.cards[note.id] = rounded;
        // A card placed narrower than the stylesheet has it is drawn so.
        if (Math.abs(width - (cssWidths.get(note.id) ?? width)) > 0.5) next.widths[note.id] = width;
        if (note.point) {
          // The leader begins on the card's one-pixel border, so the two
          // read as one line. A bar's is the route the placement scored on
          // the card's whole pixels; any other runs out of the facing edge.
          const leader = note.from ? place!.leader : routeLeader(rounded, note.point, { cutTop: NOTE_CARD_CUT.top, overlap: 1 });
          if (leader.length > 1) next.leaders[note.id] = crispLine(leader);
        }
      }
      // The size each placed card is drawn at (the note the rail carries is not drawn here).
      const cards: Placed['cards'] = {};
      for (const note of toPlace) {
        const rect = placed.get(note.id)?.rect;
        if (rect) cards[note.id] = { width: rect.right - rect.left, height: rect.bottom - rect.top };
      }
      placedRef.current = { key, exact, notes: said, cards, layout: next, area: field.area, frame: { width: frame.width, height: frame.height }, points };
      setLayout((previous) => (sameLayout(previous, next) ? previous : next));
    };

    measure(false);
    const observer = new ResizeObserver(() => measure(true));
    observer.observe(layer);
    const svg = svgOf();
    if (svg) observer.observe(svg);
    if (svg?.parentElement) observer.observe(svg.parentElement);
    for (const element of cardRefs.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      clearTimeout(rest);
    };
  }, [signature, chart.data, spill, canvas]);

  // What each note names on the chart, worked out once a render: whether it
  // has a point there, and whether that point is a bar's.
  const targets = useMemo(() => {
    const scales = chartScales(chart.data);
    return new Map(notes.map((note) => [note.key, chartNotePoint(note.data, chart, scales)]));
  }, [chart, notes]);

  // The rail shows the note this chart leaves out, for as long as it does:
  // the layer says, for its own chart, when the note leaves and when it is
  // back. A chart on its way out of the stage says no more.
  const away = layout?.away ?? null;
  const chartId = chart.id;
  const present = useIsPresent();
  useEffect(() => {
    if (!onRailNote || !away || !present) return undefined;
    onRailNote(chartId, away, true);
    return () => onRailNote(chartId, away, false);
  }, [away, chartId, onRailNote, present]);

  return (
    <div className="chart-notes" ref={outerRef} data-note-count={notes.length}>
      <div className="chart-notes__frame" ref={layerRef}>
        <svg className="chart-notes__leaders" aria-hidden="true">
          <AnimatePresence initial={false}>
            {notes.map((note) => {
              const leader = layout?.leaders[note.key];
              if (!leader) return null;
              // A leader to a bar keeps its full colour to the end: it lands
              // by the bar's printed value, over bars it must not fade into.
              const toBar = targets.get(note.key)?.from !== undefined;
              const start = leader[0];
              const end = leader[leader.length - 1];
              // Named for its note, so a leader fading out keeps its own;
              // escaped one-to-one, so `obs.1` and `obs_1` keep two.
              const gradientId = ids('leader', note.key);
              return (
                <motion.g
                  key={note.key}
                  className={`chart-note-leader${toBar ? ' chart-note-leader--bar' : ''}`}
                  data-note={note.key}
                  initial={reduced ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2, delay: reduced ? 0 : 0.12 }}
                >
                  <defs>
                    <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={start.x} y1={start.y} x2={end.x} y2={end.y}>
                      <stop className="chart-note-leader__stop chart-note-leader__stop--card" offset="0" />
                      <stop className="chart-note-leader__stop chart-note-leader__stop--mid" offset="0.5" />
                      <stop className="chart-note-leader__stop chart-note-leader__stop--point" offset="1" />
                    </linearGradient>
                  </defs>
                  <polyline
                    className="chart-note-leader__line"
                    points={leader.map((point) => `${point.x},${point.y}`).join(' ')}
                    fill="none"
                    stroke={svgUrl(gradientId)}
                  />
                </motion.g>
              );
            })}
          </AnimatePresence>
        </svg>
        <AnimatePresence initial={false}>
          {notes.map((note) => {
            const card = layout?.cards[note.key];
            const anchored = targets.get(note.key) !== undefined;
            // The note the rail carries keeps its card here out of view, so
            // the layer still measures it and can take it back.
            const away = layout?.away === note.key;
            return (
              <motion.div
                key={note.key}
                ref={(element: HTMLDivElement | null) => {
                  if (element) cardRefs.current.set(note.key, element);
                  else cardRefs.current.delete(note.key);
                }}
                className={`chart-note${anchored ? ' chart-note--anchored' : ''}${away ? ' chart-note--away' : ''}`}
                data-note={note.key}
                aria-hidden={away ? true : undefined}
                style={card ? { left: card.left, top: card.top, ...(layout?.widths[note.key] !== undefined ? { width: layout.widths[note.key] } : {}) } : undefined}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <SurfaceBoundary surfaceId={note.object?.id ?? note.key} resetKey={note.object ?? note.data}>
                  <AnnotationCard
                    data={note.data}
                    onFocus={note.object ? () => onFocus(note.object!.id) : undefined}
                    onOpenHistory={note.object ? undefined : onOpenHistory}
                    named={noteTarget(objects, note.data)}
                  />
                </SurfaceBoundary>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

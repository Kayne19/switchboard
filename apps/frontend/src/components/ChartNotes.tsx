import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ChartData, NoteData, SceneObject } from '../controller/types';
import { AnnotationCard } from '../primitives/AnnotationCard';
import {
  CHART_MARKER_RADIUS,
  CHART_MARKER_STROKE,
  chartFrame,
  chartObstacles,
  chartScales,
  chartNoteTarget,
  chartTargetText,
  type ChartAnchor,
  type ChartScales,
  type ChartSide,
  type ViewPoint,
  type ViewRect,
} from '../primitives/chartGeometry';
import { layoutNotes, NOTE_CARD_CUT, routeLeader, type NoteField, type NoteToPlace, type Point, type Rect } from '../primitives/notePlacement';
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
  /** The ring on that note's point, so the point it names stays marked. */
  ring: { x: number; y: number; r: number; stroke: number } | null;
}

// The narrower widths a card with no clear place tries, as shares of its
// own, down to the least: a card narrower reads as a column of words.
const NARROWER = [0.8, 0.64];
const MIN_CARD_WIDTH = 180;
// The wider widths a card whose text would scroll tries, and the most of
// the layer it may take.
const WIDER = [1.25, 1.5, 1.75];
const MAX_CARD_SHARE = 0.8;

/**
 * Where on the chart a note names a point, if it names one there, and the
 * side its leader must come from: on a bar chart the bar's callout, past
 * its end.
 */
export function chartNotePoint(
  note: NoteData,
  chart: SceneObject<ChartData>,
  scales?: ChartScales,
): { point: ViewPoint; from?: ChartSide; bar?: ViewRect; value?: ViewRect } | undefined {
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
  if (a.ring?.x !== b.ring?.x || a.ring?.y !== b.ring?.y || a.ring?.r !== b.ring?.r) return false;
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

// A crisp one-pixel line sits on the half pixel.
const snap = (value: number) => Math.round(value - 0.5) + 0.5;

/**
 * The notes on one chart, laid over its panel rather than in a band that
 * shrinks the plot. Every note the chart carries is shown: one that names a
 * point on this chart centres over it where it can and runs a leader to it;
 * one that names none sits in a corner. The layer measures the cards, the
 * chart's drawn geometry and itself, and `placeNotes` decides where each
 * card goes, so no card covers another, its own point, or the data the
 * chart draws where a clear place exists.
 *
 * Where the scene gives it `onRailNote` and some card has no place clear
 * of the data -- every bar standing to the top, say -- one note is handed
 * to the rail instead (`placeNotes`' `spill`: the one whose absence leaves
 * the others clear, sooner a note naming no point). The layer names it
 * through `onRailNote`, keeps its card out of view (still measured, so it
 * comes back the moment the chart has room), and rings the point it names.
 */
export function ChartNotes({
  chart,
  notes,
  onFocus,
  onOpenHistory,
  onRailNote,
}: {
  chart: SceneObject<ChartData>;
  notes: ChartNote[];
  onFocus: (id: string | null) => void;
  onOpenHistory?: () => void;
  onRailNote?: (chartId: string, key: string, away: boolean) => void;
}) {
  const reduced = useReducedMotion();
  const gradientBase = useId().replace(/:/g, '');
  const layerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [layout, setLayout] = useState<NotesLayout | null>(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const chartRef = useRef(chart);
  chartRef.current = chart;
  const spill = onRailNote !== undefined;

  // What moves a card without resizing anything: which notes there are and
  // what each one names. A size change reaches the observer instead.
  const signature = notes
    .map((note) => `${note.key}\u0000${note.data.anchor?.target ?? ''}\u0000${note.data.anchor?.x ?? ''}\u0000${note.data.anchor?.series ?? ''}`)
    .join('\u0001');

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const svgOf = () => layer.parentElement?.querySelector<SVGSVGElement>('.chart-primitive > svg') ?? null;

    const measure = () => {
      const current = notesRef.current;
      const data = chartRef.current.data;
      // Everything is measured on screen and brought back to the layer's
      // own pixels, the ones its cards are positioned in.
      const layerRect = layer.getBoundingClientRect();
      const { kx, ky } = screenScale(layer, layerRect);
      const field: NoteField = { area: { left: 0, top: 0, right: layerRect.width / kx, bottom: layerRect.height / ky } };

      let toLayer: ((point: ViewPoint) => Point) | undefined;
      let viewScale = 1;
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
        viewScale = scale;
      }
      const rectToLayer = (rect: ViewRect): Rect => {
        const a = toLayer!({ x: rect.left, y: rect.top });
        const b = toLayer!({ x: rect.right, y: rect.bottom });
        return { left: a.x, top: a.y, right: b.x, bottom: b.y };
      };
      const scales = chartScales(data, frame);
      if (toLayer) {
        const obstacles = chartObstacles(data, scales, chartNoteAnchors(chartRef.current, current));
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
      // text still fits at. Widths are the
      // layer's own pixels, which a panel in flight scales on screen.
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
        toPlace.push({
          id: note.key,
          width: size.width,
          height: size.height,
          point: target && toLayer!(target.point),
          from: target?.from,
          bar: target?.bar && rectToLayer(target.bar),
          value: target?.value && rectToLayer(target.value),
        });
      }
      const options = { spill, leaderOverlap: 1 };
      let placed = layoutNotes(toPlace, field, options);
      if (toPlace.some((note) => !placed.get(note.id)?.settled)) {
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
      const next: NotesLayout = { cards: {}, widths: {}, leaders: {}, away: null, ring: null };
      for (const note of toPlace) {
        const place = placed.get(note.id);
        const card = place?.rect;
        if (!card) {
          // Left out so the others have clear places: the rail carries it,
          // and the point it names stays ringed as the chart rings a marker.
          next.away = note.id;
          // A bar is marked by the chart itself, its callout drawn for every note.
          if (note.point && !note.from) {
            next.ring = { x: note.point.x, y: note.point.y, r: CHART_MARKER_RADIUS * viewScale, stroke: CHART_MARKER_STROKE * viewScale };
          }
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
          if (leader.length > 1) next.leaders[note.id] = leader.map((point) => ({ x: snap(point.x), y: snap(point.y) }));
        }
      }
      setLayout((previous) => (sameLayout(previous, next) ? previous : next));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    const svg = svgOf();
    if (svg) observer.observe(svg);
    if (svg?.parentElement) observer.observe(svg.parentElement);
    for (const element of cardRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [signature, chart.data, spill]);

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
    <div className="chart-notes" ref={layerRef} data-note-count={notes.length}>
      <svg className="chart-notes__leaders" aria-hidden="true">
        <AnimatePresence initial={false}>
          {notes.map((note) => {
            const leader = layout?.leaders[note.key];
            if (!leader) return null;
            // A leader to a bar keeps its full colour to the end: it lands
            // by the bar's printed value, over bars it must not fade into.
            const toBar = chartNotePoint(note.data, chart)?.from !== undefined;
            const start = leader[0];
            const end = leader[leader.length - 1];
            // Named for its note, so a leader fading out keeps its own.
            const gradientId = `${gradientBase}-leader-${note.key.replace(/[^\w-]/g, '_')}`;
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
                  stroke={`url(#${gradientId})`}
                />
              </motion.g>
            );
          })}
          {layout?.ring && layout.away ? (
            <motion.circle
              key={`ring-${layout.away}`}
              className="chart-note-ring"
              data-note={layout.away}
              cx={layout.ring.x}
              cy={layout.ring.y}
              r={layout.ring.r}
              strokeWidth={layout.ring.stroke}
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            />
          ) : null}
        </AnimatePresence>
      </svg>
      <AnimatePresence initial={false}>
        {notes.map((note) => {
          const card = layout?.cards[note.key];
          const anchored = chartNotePoint(note.data, chart) !== undefined;
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
                  target={note.data.anchor?.target === chart.id ? chartTargetText(note.data.anchor, chart.data) : undefined}
                />
              </SurfaceBoundary>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

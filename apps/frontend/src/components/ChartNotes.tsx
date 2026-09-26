import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { ChartData, NoteData, SceneObject } from '../controller/types';
import { AnnotationCard } from '../primitives/AnnotationCard';
import {
  CHART_VIEW_HEIGHT,
  CHART_VIEW_WIDTH,
  chartAxisBoxes,
  chartLegendBox,
  chartPlot,
  chartScales,
  chartSeriesPoint,
  chartTraces,
  type ViewPoint,
  type ViewRect,
} from '../primitives/chartGeometry';
import { placeNotes, routeLeader, type NoteField, type NoteToPlace, type Point, type Rect } from '../primitives/notePlacement';
import { SurfaceBoundary } from './SurfaceBoundary';

/** One note on a chart: a note object, or the spoken explanation standing in for one. */
export interface ChartNote {
  key: string;
  data: NoteData;
  object?: SceneObject<NoteData>;
}

interface NotesLayout {
  cards: Record<string, Rect>;
  leaders: Record<string, Point[]>;
}

// The share of a card's width its outline cuts from the top-right corner;
// the clip-path in the stylesheet cuts the same.
const CARD_CUT = 0.08;

/** Where on the chart a note names a point, if it names one there. */
export function chartNotePoint(note: NoteData, chart: SceneObject<ChartData>): ViewPoint | undefined {
  if (note.anchor?.target !== chart.id || note.anchor.x === undefined) return undefined;
  return chartSeriesPoint(chart.data, note.anchor.x, note.anchor.series);
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
  if (!a) return false;
  const aKeys = Object.keys(a.cards);
  const bKeys = Object.keys(b.cards);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of bKeys) {
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
 * card goes, so no card covers another, its own point, or more of the
 * traces than it must.
 */
export function ChartNotes({
  chart,
  notes,
  onFocus,
  onOpenHistory,
}: {
  chart: SceneObject<ChartData>;
  notes: ChartNote[];
  onFocus: (id: string | null) => void;
  onOpenHistory?: () => void;
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
      const svg = svgOf();
      const svgRect = svg?.getBoundingClientRect();
      if (svgRect && svgRect.width > 0 && svgRect.height > 0) {
        // The chart letterboxes its viewBox into its svg; map through the
        // same fit.
        const width = svgRect.width / kx;
        const height = svgRect.height / ky;
        const scale = Math.min(width / CHART_VIEW_WIDTH, height / CHART_VIEW_HEIGHT);
        const left = (svgRect.left - layerRect.left) / kx + (width - CHART_VIEW_WIDTH * scale) / 2;
        const top = (svgRect.top - layerRect.top) / ky + (height - CHART_VIEW_HEIGHT * scale) / 2;
        toLayer = (point) => ({ x: left + point.x * scale, y: top + point.y * scale });
      }
      const rectToLayer = (rect: ViewRect): Rect => {
        const a = toLayer!({ x: rect.left, y: rect.top });
        const b = toLayer!({ x: rect.right, y: rect.bottom });
        return { left: a.x, top: a.y, right: b.x, bottom: b.y };
      };
      if (toLayer) {
        const plot = chartPlot(data);
        field.plot = rectToLayer(plot);
        field.traces = chartTraces(data, chartScales(data)).map((trace) => trace.map(toLayer!));
        field.labels = [chartLegendBox(data), ...chartAxisBoxes(plot)].map(rectToLayer);
      }

      const toPlace: NoteToPlace[] = [];
      for (const note of current) {
        const element = cardRefs.current.get(note.key);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        const size = { width: rect.width / kx, height: rect.height / ky };
        const viewPoint = toLayer ? chartNotePoint(note.data, chartRef.current) : undefined;
        toPlace.push({ id: note.key, width: size.width, height: size.height, point: viewPoint && toLayer!(viewPoint) });
      }
      const placed = placeNotes(toPlace, field);
      const next: NotesLayout = { cards: {}, leaders: {} };
      for (const note of toPlace) {
        const card = placed.get(note.id)!;
        const rounded = {
          left: Math.round(card.left),
          top: Math.round(card.top),
          right: Math.round(card.left) + note.width,
          bottom: Math.round(card.top) + note.height,
        };
        next.cards[note.id] = rounded;
        if (note.point) {
          // The leader begins on the card's one-pixel border, so the two
          // read as one line.
          const leader = routeLeader(rounded, note.point, { cutTop: CARD_CUT, overlap: 1 });
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
    for (const element of cardRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [signature, chart.data]);

  return (
    <div className="chart-notes" ref={layerRef} data-note-count={notes.length}>
      <svg className="chart-notes__leaders" aria-hidden="true">
        <AnimatePresence initial={false}>
          {notes.map((note) => {
            const leader = layout?.leaders[note.key];
            if (!leader) return null;
            const start = leader[0];
            const end = leader[leader.length - 1];
            // Named for its note, so a leader fading out keeps its own.
            const gradientId = `${gradientBase}-leader-${note.key.replace(/[^\w-]/g, '_')}`;
            return (
              <motion.g
                key={note.key}
                className="chart-note-leader"
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
        </AnimatePresence>
      </svg>
      <AnimatePresence initial={false}>
        {notes.map((note) => {
          const card = layout?.cards[note.key];
          const anchored = chartNotePoint(note.data, chart) !== undefined;
          return (
            <motion.div
              key={note.key}
              ref={(element: HTMLDivElement | null) => {
                if (element) cardRefs.current.set(note.key, element);
                else cardRefs.current.delete(note.key);
              }}
              className={`chart-note${anchored ? ' chart-note--anchored' : ''}`}
              data-note={note.key}
              style={card ? { left: card.left, top: card.top } : undefined}
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
                />
              </SurfaceBoundary>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

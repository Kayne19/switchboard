import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChartData, NoteData, SceneObject } from '../controller/types';
import { AnnotationCard } from '../primitives/AnnotationCard';
import {
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
import { layoutNotes, type NoteField, type NoteToPlace, type Point, type Rect } from '../primitives/notePlacement';
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

// Where on the chart a note names a point, if it names one there: the
// point's callout -- where its leader lands, past the value the chart
// prints, the side it comes from, and the mark and value it names.
// `named` is every point the chart's notes name, which the callouts keep
// clear of one another by.
function chartNotePoint(
  note: NoteData,
  chart: SceneObject<ChartData>,
  scales: ChartScales,
  named: ChartAnchor[],
): { point: ViewPoint; from: ChartSide; mark: ViewRect; value: ViewRect } | undefined {
  if (note.anchor?.target !== chart.id || note.anchor.x === undefined) return undefined;
  return chartNoteTarget(chart.data, { x: note.anchor.x, series: note.anchor.series }, scales, named);
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

// A crisp one-pixel line sits on the half pixel.
const snap = (value: number) => Math.round(value - 0.5) + 0.5;

/**
 * The notes on one chart, laid over its panel rather than in a band that
 * shrinks the plot. Every note the chart carries is shown: one that names a
 * point on this chart sits near it, wholly in or out of the plot, and runs a
 * leader to the value the chart prints there; one that names none sits in a
 * corner. The layer measures the cards, the chart's drawn geometry and
 * itself, and `layoutNotes` decides where each card goes, so no card covers
 * another, a point a note names, or the data the chart draws where a clear
 * place exists.
 *
 * Where the scene gives it `onRailNote` and some card has no place that
 * keeps those rules -- every bar standing to the top, say -- one note is
 * handed to the rail instead, where that leaves fewer cards astray
 * (`layoutNotes`' `spill`: the one whose absence leaves the fewest, a note
 * naming no point first among those). The layer names it through
 * `onRailNote` and keeps its card out of view (still measured, so it comes
 * back the moment the chart has room); the chart keeps the point it names
 * marked, as it marks every point a note names.
 */
export function ChartNotes({
  chart,
  notes,
  onFocus,
  onOpenHistory,
  onRailNote,
  named: namedPoints,
}: {
  chart: SceneObject<ChartData>;
  notes: ChartNote[];
  onFocus: (id: string | null) => void;
  onOpenHistory?: () => void;
  onRailNote?: (chartId: string, key: string, away: boolean) => void;
  /**
   * Every point the chart marks for its notes, as given to the chart
   * (`ChartPrimitive named`): the notes laid here and any the scene shows
   * elsewhere. A point's printed value keeps clear of the ones before it,
   * so the layer reads the chart's own list to land each leader where the
   * value is drawn and to keep every card off every ring. The notes laid
   * here, when not given.
   */
  named?: ChartAnchor[];
}) {
  const reduced = useReducedMotion();
  const layerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [layout, setLayout] = useState<NotesLayout | null>(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const chartRef = useRef(chart);
  chartRef.current = chart;
  const marked = useMemo(() => namedPoints ?? chartNoteAnchors(chart, notes), [namedPoints, chart, notes]);
  const markedRef = useRef(marked);
  markedRef.current = marked;
  const spill = onRailNote !== undefined;

  // What moves a card without resizing anything: which notes there are and
  // what each one names. A size change reaches the observer instead.
  const signature = [
    ...notes.map((note) => `${note.key}\u0000${note.data.anchor?.target ?? ''}\u0000${note.data.anchor?.x ?? ''}\u0000${note.data.anchor?.series ?? ''}`),
    ...marked.map((anchor) => `${anchor.x}\u0000${anchor.series ?? ''}`),
  ].join('\u0001');

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
      const rectToLayer = (rect: ViewRect): Rect => {
        const a = toLayer!({ x: rect.left, y: rect.top });
        const b = toLayer!({ x: rect.right, y: rect.bottom });
        return { left: a.x, top: a.y, right: b.x, bottom: b.y };
      };
      const scales = chartScales(data, frame);
      const named = markedRef.current;
      if (toLayer) {
        const obstacles = chartObstacles(data, scales, named);
        field.plot = rectToLayer(scales.plot);
        field.traces = obstacles.lines.map((line) => line.map(toLayer!));
        field.marks = obstacles.marks.map(rectToLayer);
        field.fills = obstacles.fills.map((piece) => piece.map(toLayer!));
        field.labels = obstacles.labels.map(rectToLayer);
        // A card lies wholly inside the plot, in clear space, or wholly outside it, never across its border.
        field.wholly = true;
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
        const target = toLayer ? chartNotePoint(note.data, chartRef.current, scales, named) : undefined;
        toPlace.push({
          id: note.key,
          width: size.width,
          height: size.height,
          ...(target ? { point: toLayer!(target.point), from: target.from, mark: rectToLayer(target.mark), value: rectToLayer(target.value) } : {}),
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
      const next: NotesLayout = { cards: {}, widths: {}, leaders: {}, away: null };
      for (const note of toPlace) {
        const place = placed.get(note.id);
        const card = place?.rect;
        if (!card) {
          // Left out so the others have clear places: the rail carries it.
          // The point it names stays marked, the chart's callout drawn for every note.
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
        // The leader begins on the card's one-pixel border, so the two read
        // as one line: the route the placement scored on the card's whole pixels.
        if (place!.leader.length > 1) next.leaders[note.id] = place!.leader.map((point) => ({ x: snap(point.x), y: snap(point.y) }));
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

  // Which notes name a point on the chart, worked out once a render.
  const anchored = useMemo(() => {
    const scales = chartScales(chart.data);
    return new Set(notes.filter((note) => chartNotePoint(note.data, chart, scales, marked) !== undefined).map((note) => note.key));
  }, [chart, notes, marked]);

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
            // In the card's edge colour, a shade firmer, the whole way: it
            // lands by the value the chart prints, over data it must not
            // fade into.
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
                <polyline className="chart-note-leader__line" points={leader.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" />
              </motion.g>
            );
          })}
        </AnimatePresence>
      </svg>
      <AnimatePresence initial={false}>
        {notes.map((note) => {
          const card = layout?.cards[note.key];
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
              className={`chart-note${anchored.has(note.key) ? ' chart-note--anchored' : ''}${away ? ' chart-note--away' : ''}`}
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

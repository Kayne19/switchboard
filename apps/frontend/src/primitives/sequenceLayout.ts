// Sequence diagram geometry: where each actor's column and lifeline sit,
// where each message runs, and where its label goes. Pure, so the rules
// below can be checked without a browser.
//
// Actors stand across the top, each in a header sized to its own label;
// their lifelines fall from there. Messages run in the order given, one row
// each, from the sender's lifeline to the receiver's, with the label above
// the arrow. A self-message is a short loop out to the right of its
// lifeline, its label beside it. Two rules keep a drawing readable:
// - A message's span is wide enough for its label: when two lifelines are
//   closer than the words between them need, the columns move apart and
//   the SVG scales the wider drawing to fit, so a label never runs under a
//   lifeline.
// - The drawing grows with the message count rather than compressing the
//   rows, so a long exchange scales down as a whole and stays in order.

import type { SequenceActor, SequenceDiagramData, SequenceMessage } from '../controller/types';
import { fitDrawing, readableScale, type DrawingFit, type Viewport } from './drawingFit';

export type SequenceOrientation = 'landscape' | 'portrait';

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutActor {
  actor: SequenceActor;
  /** The lifeline's x. */
  x: number;
  /** The header box. */
  box: Box;
  /** The sub, as the lines it is drawn on: one in landscape, wrapped in portrait. */
  subLines: string[];
  /** The lifeline runs from the header's bottom to here. */
  lifelineEnd: number;
}

export interface MessageLabel {
  text: string;
  /** The text as the lines it is drawn on; a long label wraps rather than pushing the columns apart. */
  lines: string[];
  /** Where the first line is anchored (`anchor` says how); each next line sits LABEL_HEIGHT lower. */
  x: number;
  y: number;
  anchor: 'middle' | 'start';
  /** The label's backing: what it paints over. */
  box: Box;
}

export interface LaidOutMessage {
  message: SequenceMessage;
  index: number;
  kind: 'call' | 'return' | 'async';
  /** The route from the sender's lifeline to the receiver's; the last point is the arrow's tip. */
  points: Point[];
  /** Which way the arrow's tip points. */
  direction: 'right' | 'left';
  self: boolean;
  label: MessageLabel;
}

export interface SequenceLayout {
  width: number;
  height: number;
  /** The actor label's size in user units; portrait sets it smaller for narrower columns. */
  actorLabelSize: number;
  actorSubSize: number;
  actors: LaidOutActor[];
  messages: LaidOutMessage[];
}

// The approved geometry. Portrait keeps the same orientation -- actors across
// the top -- but narrower columns, so more of them fit a tall, narrow stage:
// a header is sized to its label alone, and its sub wraps under it.
const GEOMETRY = {
  landscape: {
    minWidth: 1000,
    padX: 40,
    actorLabelSize: 13,
    actorSubSize: 9,
    headerPad: 16,
    minHeaderWidth: 120,
    columnGap: 28,
    maxPitch: 340,
    wrapSub: false,
    labelChars: 32,
  },
  portrait: {
    minWidth: 420,
    padX: 16,
    actorLabelSize: 10,
    actorSubSize: 8,
    headerPad: 8,
    minHeaderWidth: 60,
    columnGap: 12,
    maxPitch: 200,
    wrapSub: true,
    labelChars: 12,
  },
} as const;

const PAD_TOP = 24;
const PAD_BOTTOM = 28;
// Actor labels are set in the monospace face with 0.1em tracking
// (.sequence-actor-label), subs with 0.09em: 0.6em advance plus the tracking.
const actorAdvance = (size: number) => size * 0.7;
const actorSubAdvance = (size: number) => size * 0.69;
const HEADER_HEIGHT = 40;
// A header with a sub: the label sits higher and each sub line adds a row.
const HEADER_HEIGHT_WITH_SUB = 52;
export const SUB_LINE_HEIGHT = 11;
// Message labels are set in the monospace face at 11 user units with 0.06em
// tracking (.sequence-message-label), so a label's width is known before it
// is drawn: 0.6em advance plus the tracking, rounded up.
const MESSAGE_LABEL_SIZE = 11;
const LABEL_ADVANCE = 7.3;
export const LABEL_HEIGHT = 14;
const LABEL_BACKING = 4;
// Space kept clear between a label's backing and a lifeline.
const CLEARANCE = 8;
// A label sits this far above its arrow.
const LABEL_LIFT = 6;
// The first message's row starts this far under the headers.
const FIRST_ROW_GAP = 10;
// Room above a label before the previous row, and below an arrow before the next.
const ROW_LEAD = 8;
const ROW_TAIL = 14;
// The loop a self-message makes beside its lifeline, and the gap to its label.
const LOOP_WIDTH = 34;
const LOOP_HEIGHT = 28;
const LOOP_LABEL_GAP = 8;
// How far a lifeline runs past the last message, or under the headers when
// there is none.
const LIFELINE_TAIL = 36;
const EMPTY_LIFELINE = 80;

function labelBacking(lines: string[]) {
  return {
    width: Math.max(...lines.map((line) => line.length)) * LABEL_ADVANCE + 2 * LABEL_BACKING,
    height: lines.length * LABEL_HEIGHT + 2 * LABEL_BACKING,
  };
}

// Words onto lines of at most `chars` characters; a word longer than that
// takes a line of its own and the caller widens the box to fit it. A bare
// separator such as the `/` in "DAMOCLES / FRONT DESK" stays on the line
// before it rather than opening one of its own.
function wrapWords(text: string, chars: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const separator = /^[^\p{L}\p{N}]+$/u.test(word);
    if (!current) current = word;
    else if (separator || current.length + 1 + word.length <= chars) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function layoutSequence(data: SequenceDiagramData, orientation: SequenceOrientation): SequenceLayout {
  const geometry = GEOMETRY[orientation];
  const { actors } = data;
  const indexOf = new Map(actors.map((actor, index) => [actor.id, index]));

  // --- Headers sized to their text ------------------------------------------
  const subAdvance = actorSubAdvance(geometry.actorSubSize);
  const headers = actors.map((actor) => {
    const labelWidth = Math.max(
      geometry.minHeaderWidth,
      actor.label.length * actorAdvance(geometry.actorLabelSize) + 2 * geometry.headerPad,
    );
    if (!actor.sub) return { width: labelWidth, subLines: [] as string[] };
    if (!geometry.wrapSub) {
      return {
        width: Math.max(labelWidth, actor.sub.length * subAdvance + 2 * geometry.headerPad),
        subLines: [actor.sub],
      };
    }
    const subLines = wrapWords(actor.sub, Math.floor((labelWidth - 2 * geometry.headerPad) / subAdvance));
    const longest = Math.max(...subLines.map((line) => line.length));
    return { width: Math.max(labelWidth, longest * subAdvance + 2 * geometry.headerPad), subLines };
  });
  const headerWidths = headers.map((header) => header.width);
  const subLineCount = Math.max(0, ...headers.map((header) => header.subLines.length));
  const headerHeight = subLineCount > 0 ? HEADER_HEIGHT_WITH_SUB + (subLineCount - 1) * SUB_LINE_HEIGHT : HEADER_HEIGHT;

  // --- Column pitch ---------------------------------------------------------
  // Adjacent headers keep a gap between them; then every message's span is
  // widened until its label fits between the two lifelines. Short spans go
  // first so a long one is measured against columns already pushed apart.
  const gaps = headerWidths.slice(1).map((width, index) => (headerWidths[index] + width) / 2 + geometry.columnGap);
  const resolved = data.messages.flatMap((message, index) => {
    const from = indexOf.get(message.from);
    const to = indexOf.get(message.to);
    if (from === undefined || to === undefined) return [];
    // A message that crosses several columns has their width for its words.
    const lines = wrapWords(message.label, geometry.labelChars * Math.max(1, Math.abs(to - from)));
    return [{ message, index, from, to, lines: lines.length > 0 ? lines : [message.label] }];
  });
  let rightExtra = 0;
  const spans = resolved
    .filter((entry) => entry.from !== entry.to)
    .sort((a, b) => Math.abs(a.to - a.from) - Math.abs(b.to - b.from));
  for (const entry of spans) {
    const low = Math.min(entry.from, entry.to);
    const high = Math.max(entry.from, entry.to);
    const needed = labelBacking(entry.lines).width + 2 * CLEARANCE;
    const have = gaps.slice(low, high).reduce((sum, gap) => sum + gap, 0);
    if (have < needed) {
      const share = (needed - have) / (high - low);
      for (let gap = low; gap < high; gap += 1) gaps[gap] += share;
    }
  }
  for (const entry of resolved) {
    if (entry.from !== entry.to) continue;
    const needed = LOOP_WIDTH + LOOP_LABEL_GAP + labelBacking(entry.lines).width + CLEARANCE;
    if (entry.from < actors.length - 1) {
      gaps[entry.from] = Math.max(gaps[entry.from], needed);
    } else {
      rightExtra = Math.max(rightExtra, needed);
    }
  }

  // A small drawing is widened to the approved width by spreading its
  // columns, up to a pitch past which they would read as unrelated; past
  // that it is centred instead.
  const firstHalf = headerWidths[0] / 2;
  const lastHalf = Math.max(headerWidths[actors.length - 1] / 2, rightExtra);
  const fixed = 2 * geometry.padX + firstHalf + lastHalf;
  const gapSum = gaps.reduce((sum, gap) => sum + gap, 0);
  if (gaps.length > 0 && fixed + gapSum < geometry.minWidth) {
    const widest = Math.max(...gaps);
    const stretch = Math.min(geometry.maxPitch / widest, (geometry.minWidth - fixed) / gapSum);
    if (stretch > 1) for (let gap = 0; gap < gaps.length; gap += 1) gaps[gap] *= stretch;
  }
  const contentWidth = fixed + gaps.reduce((sum, gap) => sum + gap, 0);
  const width = Math.max(geometry.minWidth, contentWidth);
  const offset = (width - contentWidth) / 2;

  const xs: number[] = [];
  let cursorX = offset + geometry.padX + firstHalf;
  actors.forEach((_, index) => {
    if (index > 0) cursorX += gaps[index - 1];
    xs.push(cursorX);
  });

  // --- Rows -----------------------------------------------------------------
  const headerTop = PAD_TOP;
  const headerBottom = headerTop + headerHeight;
  let cursorY = headerBottom + FIRST_ROW_GAP;
  const messages: LaidOutMessage[] = resolved.map((entry) => {
    const { message, index, from, to, lines } = entry;
    const self = from === to;
    const kind = message.kind ?? 'call';
    const backing = labelBacking(lines);
    // The first line's centre is this far under the backing's top.
    const firstLine = LABEL_BACKING + LABEL_HEIGHT / 2;
    if (self) {
      const x = xs[from];
      const y = cursorY + ROW_LEAD;
      const loopHeight = Math.max(LOOP_HEIGHT, backing.height);
      cursorY = y + loopHeight + ROW_TAIL;
      const labelX = x + LOOP_WIDTH + LOOP_LABEL_GAP;
      const boxY = y + loopHeight / 2 - backing.height / 2;
      return {
        message,
        index,
        kind,
        points: [
          { x, y },
          { x: x + LOOP_WIDTH, y },
          { x: x + LOOP_WIDTH, y: y + loopHeight },
          { x, y: y + loopHeight },
        ],
        direction: 'left',
        self,
        label: {
          text: message.label,
          lines,
          x: labelX + LABEL_BACKING,
          y: boxY + firstLine,
          anchor: 'start',
          box: { x: labelX, y: boxY, ...backing },
        },
      };
    }
    const y = cursorY + ROW_LEAD + backing.height + LABEL_LIFT;
    cursorY = y + ROW_TAIL;
    const centre = (xs[from] + xs[to]) / 2;
    const boxY = y - LABEL_LIFT - backing.height;
    return {
      message,
      index,
      kind,
      points: [
        { x: xs[from], y },
        { x: xs[to], y },
      ],
      direction: to > from ? 'right' : 'left',
      self,
      label: {
        text: message.label,
        lines,
        x: centre,
        y: boxY + firstLine,
        anchor: 'middle',
        box: { x: centre - backing.width / 2, y: boxY, ...backing },
      },
    };
  });

  const lifelineEnd = messages.length > 0 ? cursorY - ROW_TAIL + LIFELINE_TAIL : headerBottom + EMPTY_LIFELINE;
  const height = lifelineEnd + PAD_BOTTOM;

  const laidOutActors: LaidOutActor[] = actors.map((actor, index) => ({
    actor,
    x: xs[index],
    box: { x: xs[index] - headerWidths[index] / 2, y: headerTop, width: headerWidths[index], height: headerHeight },
    subLines: headers[index].subLines,
    lifelineEnd,
  }));

  return {
    width,
    height,
    actorLabelSize: geometry.actorLabelSize,
    actorSubSize: geometry.actorSubSize,
    actors: laidOutActors,
    messages,
  };
}

// --- Reading the drawing in its viewport ------------------------------------

/** The least scale at which a sequence's text keeps the page's type floors: its actor labels and message labels as .tech, its subs as .micro. */
export function sequenceMinScale(layout: SequenceLayout): number {
  return readableScale([
    { size: layout.actorLabelSize, floor: 'tech' },
    { size: layout.actorSubSize, floor: 'micro' },
    { size: MESSAGE_LABEL_SIZE, floor: 'tech' },
  ]);
}

export interface SequenceView {
  layout: SequenceLayout;
  fit: DrawingFit;
}

/** How a sequence is shown in a viewport (CSS pixels): the geometry for its shape, fitted (drawingFit.ts). */
export function viewSequence(data: SequenceDiagramData, viewport: Viewport): SequenceView {
  const orientation: SequenceOrientation = viewport.height > viewport.width * 1.05 ? 'portrait' : 'landscape';
  const layout = layoutSequence(data, orientation);
  return { layout, fit: fitDrawing(layout, viewport, sequenceMinScale(layout)) };
}

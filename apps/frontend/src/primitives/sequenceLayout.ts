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
//   closer than the words between them need, the columns move apart, so a
//   label never runs under a lifeline it does not cross.
// - The drawing grows with the message count rather than compressing the
//   rows, so a long exchange grows down and stays in order.
// Shown in a viewport (`viewSequence`), a drawing too wide to read at the
// readable minimum is recomposed to the viewport's width (`layoutToWidth`)
// and scrolls down (drawingFit.ts).

import type { SequenceActor, SequenceDiagramData, SequenceMessage } from '../controller/types';
import { fitDrawing, readableScale, type DrawingFit, type Viewport } from './drawingFit';
import { NOTE_MARKER } from './NoteMarker';

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
  /** The label, as the lines it is drawn on: one, unless the drawing is recomposed to a width too narrow for it. */
  labelLines: string[];
  /** Where the label's first line and the sub's first line are centred, down from the box's top. */
  labelY: number;
  subY: number;
  /** The sub, as the lines it is drawn on: one in landscape, wrapped in portrait. */
  subLines: string[];
  /** The lifeline runs from the header's bottom to here. */
  lifelineEnd: number;
  /** The NOTE marker, relative to the header box's top-left corner, on the actor a rail note names: under its text, clear of the frame. */
  marker: Box | null;
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
  /**
   * Set on its own line over the arrow, across the drawing as far as it
   * needs, rather than between the arrow's two lifelines: a drawing
   * recomposed to a narrow width has no room there for it. It may cover a
   * lifeline it does not cross, on its backing.
   */
  over: boolean;
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
  /** The pitch between the lines of a wrapped actor label. */
  actorLabelLineHeight: number;
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
// A header recomposed to a narrow column: the pitch of its label's lines,
// its padding, the gap from label to sub, and the gap between two
// staggered rows of headers.
const LABEL_LINE_PITCH = 1.3;
const HEADER_PAD_TOP = 10;
const HEADER_PAD_BOTTOM = 9;
const HEADER_SUB_GAP = 6;
const HEADER_ROW_GAP = 8;
// Recomposed narrow, the drawing keeps this little room at its sides, and
// two staggered headers this much between them.
const NARROW_PAD_X = 4;
const STAGGER_GAP = 8;
// A label between two lifelines needs room for this many characters a
// line; with less it goes over its arrow.
const MIN_SPAN_CHARS = 8;
// The NOTE marker on the header of the actor a rail note names (its size
// is NoteMarker's own, as on a graph's node), centred under the header's
// text, this far below it and this far above the frame's bottom edge; the
// header is at least as wide as the marker with this much either side,
// clear of the frame's stepped corner. The headers grow together to make
// room for it.
const MARKER = NOTE_MARKER;
const MARKER_GAP = 5;
const MARKER_FOOT = 8;
const MARKER_SIDE = 8;
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

/** The width, in user units, a sequence is recomposed to when it is too wide to read whole. */
export interface SequenceFrame {
  width: number;
}

// A line still longer than `chars` (one long word, such as a path or a
// call) breaks after the last separator that keeps it short enough, or
// else at `chars` itself.
function breakLine(line: string, chars: number): string[] {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > chars) {
    const head = rest.slice(0, chars);
    const cut = Math.max(head.lastIndexOf('.'), head.lastIndexOf('/'), head.lastIndexOf('_'), head.lastIndexOf('-'), head.lastIndexOf('('));
    const at = cut > 0 ? cut + 1 : chars;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Lays a sequence out: each column as wide as its header and the labels
 * between its lifelines need, the drawing as wide as they add up to. Given
 * a frame narrower than that, it is recomposed to the frame's width instead
 * (`layoutToWidth`).
 */
export function layoutSequence(data: SequenceDiagramData, orientation: SequenceOrientation, frame?: SequenceFrame, anchor?: string): SequenceLayout {
  const natural = layoutNatural(data, orientation, anchor);
  return frame && natural.width > frame.width ? layoutToWidth(data, orientation, frame.width, anchor) : natural;
}

// The marker under the text of a header `width` wide and `height` deep.
const markerIn = (width: number, height: number): Box => ({
  x: (width - MARKER.width) / 2,
  y: height - MARKER_FOOT - MARKER.height,
  width: MARKER.width,
  height: MARKER.height,
});
// How deep the headers must be for the anchored one's marker to stand under its text.
const markerDepth = (textBottom: number) => textBottom + MARKER_GAP + MARKER.height + MARKER_FOOT;
const MARKER_ROOM = MARKER.width + 2 * MARKER_SIDE;

function layoutNatural(data: SequenceDiagramData, orientation: SequenceOrientation, anchor?: string): SequenceLayout {
  const geometry = GEOMETRY[orientation];
  const { actors } = data;
  const indexOf = new Map(actors.map((actor, index) => [actor.id, index]));
  const anchored = anchor === undefined ? -1 : actors.findIndex((actor) => actor.id === anchor);

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
  const headerWidths = headers.map((header, index) => (index === anchored ? Math.max(header.width, MARKER_ROOM) : header.width));
  const subLineCount = Math.max(0, ...headers.map((header) => header.subLines.length));
  const textHeight = subLineCount > 0 ? HEADER_HEIGHT_WITH_SUB + (subLineCount - 1) * SUB_LINE_HEIGHT : HEADER_HEIGHT;
  const labelYOf = (actor: SequenceActor) => (actor.sub ? 22 : textHeight / 2);
  const anchoredBottom =
    anchored < 0
      ? 0
      : actors[anchored].sub
        ? 39 + (headers[anchored].subLines.length - 1) * SUB_LINE_HEIGHT + SUB_LINE_HEIGHT / 2
        : labelYOf(actors[anchored]) + (geometry.actorLabelSize * LABEL_LINE_PITCH) / 2;
  const headerHeight = anchored < 0 ? textHeight : Math.max(textHeight, markerDepth(anchoredBottom));

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

  const headerTop = PAD_TOP;
  const headerBottom = headerTop + headerHeight;
  const { messages, lifelineEnd } = layRows(
    resolved.map((entry) => ({ ...entry, over: false })),
    xs,
    headerBottom,
    width,
    geometry.padX,
  );
  const laidOutActors: LaidOutActor[] = actors.map((actor, index) => ({
    actor,
    x: xs[index],
    box: { x: xs[index] - headerWidths[index] / 2, y: headerTop, width: headerWidths[index], height: headerHeight },
    labelLines: [actor.label],
    labelY: labelYOf(actor),
    subY: 39,
    subLines: headers[index].subLines,
    lifelineEnd,
    marker: index === anchored ? markerIn(headerWidths[index], headerHeight) : null,
  }));

  return {
    width,
    height: lifelineEnd + PAD_BOTTOM,
    actorLabelSize: geometry.actorLabelSize,
    actorLabelLineHeight: geometry.actorLabelSize * LABEL_LINE_PITCH,
    actorSubSize: geometry.actorSubSize,
    actors: laidOutActors,
    messages,
  };
}

interface RowEntry {
  message: SequenceMessage;
  index: number;
  from: number;
  to: number;
  lines: string[];
  over: boolean;
}

/**
 * Lays the messages out in order, one row each, under the headers. A label
 * between its lifelines is centred over its arrow (beside its loop, for a
 * self-message); one set `over` takes its own line over the arrow (or the
 * loop), centred on it as far as the drawing's edges allow.
 */
function layRows(entries: RowEntry[], xs: number[], headerBottom: number, width: number, padX: number) {
  let cursorY = headerBottom + FIRST_ROW_GAP;
  // The first line's centre is this far under the backing's top.
  const firstLine = LABEL_BACKING + LABEL_HEIGHT / 2;
  const centred = (centre: number, boxWidth: number) => Math.min(Math.max(centre - boxWidth / 2, padX), width - padX - boxWidth);
  const messages: LaidOutMessage[] = entries.map((entry) => {
    const { message, index, from, to, lines, over } = entry;
    const self = from === to;
    const kind = message.kind ?? 'call';
    const backing = labelBacking(lines);
    if (self) {
      const x = xs[from];
      if (over) {
        const boxX = centred(x + LOOP_WIDTH / 2, backing.width);
        const boxY = cursorY + ROW_LEAD;
        const y = boxY + backing.height + LABEL_LIFT;
        cursorY = y + LOOP_HEIGHT + ROW_TAIL;
        return {
          message,
          index,
          kind,
          points: [
            { x, y },
            { x: x + LOOP_WIDTH, y },
            { x: x + LOOP_WIDTH, y: y + LOOP_HEIGHT },
            { x, y: y + LOOP_HEIGHT },
          ],
          direction: 'left',
          self,
          label: { text: message.label, lines, x: boxX + backing.width / 2, y: boxY + firstLine, anchor: 'middle', box: { x: boxX, y: boxY, ...backing }, over },
        };
      }
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
        label: { text: message.label, lines, x: labelX + LABEL_BACKING, y: boxY + firstLine, anchor: 'start', box: { x: labelX, y: boxY, ...backing }, over },
      };
    }
    const y = cursorY + ROW_LEAD + backing.height + LABEL_LIFT;
    cursorY = y + ROW_TAIL;
    const centre = (xs[from] + xs[to]) / 2;
    const boxX = over ? centred(centre, backing.width) : centre - backing.width / 2;
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
      label: { text: message.label, lines, x: boxX + backing.width / 2, y: boxY + firstLine, anchor: 'middle', box: { x: boxX, y: boxY, ...backing }, over },
    };
  });
  const lifelineEnd = messages.length > 0 ? cursorY - ROW_TAIL + LIFELINE_TAIL : headerBottom + EMPTY_LIFELINE;
  return { messages, lifelineEnd };
}

/**
 * A sequence recomposed to a width too narrow for its natural columns. The
 * columns share the width evenly. A header wraps its label to two lines and
 * its sub under it; when even that does not fit a column, the headers
 * stand in two staggered rows, each as wide as two columns, every lifeline
 * falling clear of the headers in the row below. A message label that fits
 * between its lifelines in three lines stays there; one that does not takes
 * its own line over its arrow, so a narrow drawing grows down, not across.
 */
function layoutToWidth(data: SequenceDiagramData, orientation: SequenceOrientation, frameWidth: number, anchor?: string): SequenceLayout {
  const geometry = GEOMETRY[orientation];
  const { actors } = data;
  const anchored = anchor === undefined ? -1 : actors.findIndex((actor) => actor.id === anchor);
  const count = Math.max(1, actors.length);
  const labelAdvance = actorAdvance(geometry.actorLabelSize);
  const subAdvance = actorSubAdvance(geometry.actorSubSize);
  const longestWord = (text: string) => Math.max(0, ...text.split(/\s+/).map((word) => word.length));
  const widestLabelWord = Math.max(0, ...actors.map((actor) => longestWord(actor.label) * labelAdvance));
  // The columns share the width; never so narrow that a word of an actor's
  // label misses two columns of room. (A word of a sub may break.)
  const padX = Math.min(geometry.padX, NARROW_PAD_X);
  const leastPitch = (widestLabelWord + 2 * geometry.headerPad + STAGGER_GAP) / 2;
  // An end column reaches out to the drawing's edge: half a pitch, or more
  // when its actor's longest word needs more than a staggered header beside
  // the edge has (the room from the edge to a pitch past its lifeline).
  const wordRoom = (actor: SequenceActor | undefined) => (actor ? longestWord(actor.label) * labelAdvance + 2 * geometry.headerPad : 0);
  const reachFor = (at: number, actor: SequenceActor | undefined) => Math.max(at / 2, wordRoom(actor) - at + STAGGER_GAP / 2);
  let pitch = Math.max((frameWidth - 2 * padX) / count, leastPitch);
  for (let attempt = 0; attempt < 4 && count > 1; attempt += 1) {
    const ends = reachFor(pitch, actors[0]) + reachFor(pitch, actors[count - 1]);
    pitch = Math.max(leastPitch, (frameWidth - 2 * padX - ends) / (count - 1));
  }
  const reachFirst = reachFor(pitch, actors[0]);
  const content = count > 1 ? reachFirst + pitch * (count - 1) + reachFor(pitch, actors[count - 1]) : pitch;
  // The search settles a hair either side of the frame: within half a unit
  // it is the frame.
  const width = 2 * padX + content <= frameWidth + 0.5 ? frameWidth : 2 * padX + content;
  const xs = actors.map((_, index) => (count > 1 ? (width - content) / 2 + reachFirst + pitch * index : width / 2));

  // A header has the room between the lifelines either side of its own
  // (one column; two when the headers stagger, since the lifelines beside
  // it start below its row), cut to the drawing's edges. It is centred on
  // its lifeline as far as that room allows.
  const roomOf = (index: number, columns: number) => {
    const gap = columns === 1 ? geometry.columnGap : STAGGER_GAP;
    return {
      low: Math.max(padX, xs[index] - (columns * pitch) / 2 + gap / 2),
      high: Math.min(width - padX, xs[index] + (columns * pitch) / 2 - gap / 2),
    };
  };
  const headerFor = (actor: SequenceActor, index: number, columns: number) => {
    const { low, high } = roomOf(index, columns);
    const text = high - low - 2 * geometry.headerPad;
    // A word too long even for this room (only an end header's, cut by the
    // drawing's edge, can be) breaks, as a sub's long word does.
    const labelChars = Math.max(1, Math.floor(text / labelAdvance + 1e-6));
    const wrapped = wrapWords(actor.label, labelChars).flatMap((line) => breakLine(line, labelChars));
    const labelLines = wrapped.length > 0 ? wrapped : [actor.label];
    const subChars = Math.max(1, Math.floor(text / subAdvance + 1e-6));
    const subLines = actor.sub ? wrapWords(actor.sub, subChars).flatMap((line) => breakLine(line, subChars)) : [];
    const widest = Math.max(0, ...labelLines.map((line) => line.length * labelAdvance), ...subLines.map((line) => line.length * subAdvance));
    const boxWidth = Math.min(high - low, Math.max(widest + 2 * geometry.headerPad, index === anchored ? MARKER_ROOM : 0));
    const x = Math.min(Math.max(xs[index] - boxWidth / 2, low), high - boxWidth);
    return { labelLines, subLines, x, width: boxWidth, fits: widest <= text + 0.5 && labelLines.length <= 2 };
  };
  const single = actors.map((actor, index) => headerFor(actor, index, 1));
  const rows = single.every((header) => header.fits) ? 1 : 2;
  const headers = rows === 1 ? single : actors.map((actor, index) => headerFor(actor, index, 2));
  const lineHeight = geometry.actorLabelSize * LABEL_LINE_PITCH;
  const labelRows = Math.max(1, ...headers.map((header) => header.labelLines.length));
  const subRows = Math.max(0, ...headers.map((header) => header.subLines.length));
  const labelY = HEADER_PAD_TOP + lineHeight / 2;
  const subY = HEADER_PAD_TOP + labelRows * lineHeight + HEADER_SUB_GAP + SUB_LINE_HEIGHT / 2;
  const textHeight = subRows > 0 ? subY - SUB_LINE_HEIGHT / 2 + subRows * SUB_LINE_HEIGHT + HEADER_PAD_BOTTOM : labelY + lineHeight / 2 + HEADER_PAD_BOTTOM;
  const anchoredHeader = anchored < 0 ? null : headers[anchored];
  const headerHeight = !anchoredHeader
    ? textHeight
    : Math.max(
        textHeight,
        markerDepth(
          anchoredHeader.subLines.length > 0
            ? subY + (anchoredHeader.subLines.length - 0.5) * SUB_LINE_HEIGHT
            : labelY + (anchoredHeader.labelLines.length - 0.5) * lineHeight,
        ),
      );
  const rowTop = (row: number) => PAD_TOP + row * (headerHeight + HEADER_ROW_GAP);
  const headerBottom = rowTop(rows - 1) + headerHeight;

  // Labels: between the lifelines when they fit there in three lines, else
  // over the arrow, wrapped to the drawing's width.
  const charsIn = (room: number) => Math.floor((room - 2 * LABEL_BACKING) / LABEL_ADVANCE);
  const overChars = Math.max(1, charsIn(width - 2 * padX));
  const indexOf = new Map(actors.map((actor, index) => [actor.id, index]));
  const entries: RowEntry[] = data.messages.flatMap((message, index) => {
    const from = indexOf.get(message.from);
    const to = indexOf.get(message.to);
    if (from === undefined || to === undefined) return [];
    const room =
      from === to
        ? (from < actors.length - 1 ? xs[from + 1] : width - padX) - (xs[from] + LOOP_WIDTH + LOOP_LABEL_GAP) - CLEARANCE
        : Math.abs(to - from) * pitch - 2 * CLEARANCE;
    const chars = charsIn(room);
    const within = chars >= MIN_SPAN_CHARS ? wrapWords(message.label, chars) : [];
    // An empty label fits anywhere.
    const fits = !message.label.trim() || (within.length > 0 && within.length <= (from === to ? 2 : 3) && within.every((line) => line.length <= chars));
    const lines = fits ? within : wrapWords(message.label, overChars).flatMap((line) => breakLine(line, overChars));
    return [{ message, index, from, to, lines: lines.length > 0 ? lines : [message.label], over: !fits }];
  });
  const { messages, lifelineEnd } = layRows(entries, xs, headerBottom, width, padX);

  const laidOutActors: LaidOutActor[] = actors.map((actor, index) => {
    const header = headers[index];
    const top = rowTop(rows === 2 ? index % 2 : 0);
    return {
      actor,
      x: xs[index],
      box: { x: header.x, y: top, width: header.width, height: headerHeight },
      labelLines: header.labelLines,
      labelY,
      subY,
      subLines: header.subLines,
      lifelineEnd,
      marker: index === anchored ? markerIn(header.width, headerHeight) : null,
    };
  });
  return {
    width,
    height: lifelineEnd + PAD_BOTTOM,
    actorLabelSize: geometry.actorLabelSize,
    actorLabelLineHeight: lineHeight,
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

/**
 * How a sequence is shown in a viewport (CSS pixels): the geometry for its
 * shape, fitted (drawingFit.ts). One too wide to read at the readable
 * minimum is recomposed to the viewport's width, so that it scrolls down,
 * in the order its messages run, and never across.
 */
export function viewSequence(data: SequenceDiagramData, viewport: Viewport, anchor?: string): SequenceView {
  const orientation: SequenceOrientation = viewport.height > viewport.width * 1.05 ? 'portrait' : 'landscape';
  const natural = layoutSequence(data, orientation, undefined, anchor);
  const minScale = sequenceMinScale(natural);
  const fit = fitDrawing(natural, viewport, minScale);
  if (!fit.scrollX) return { layout: natural, fit };
  const layout = layoutSequence(data, orientation, { width: (viewport.width - viewport.scrollbar) / minScale }, anchor);
  return { layout, fit: fitDrawing(layout, viewport, minScale) };
}

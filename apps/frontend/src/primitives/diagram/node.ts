// Node boxes for the diagram layout: text measured in the monospace estimate, corner tags, the node frame.
import { monoAdvance } from '../../design/tokens';
import { steppedFrame } from '../drawingKit';
import { NOTE_MARKER } from '../NoteMarker';
import type { Box, Size } from '../geometry';
import { wrapWords } from '../textWrap';
import { textCells } from '../../design/textCells';
import type { DiagramNode } from '../../controller/types';

export interface NodeLine {
  kind: 'label' | 'sub' | 'detail';
  text: string;
  /** Baseline, relative to the box's top-left corner. */
  y: number;
}

// Node text is set in the monospace face (.diagram-node-label, -sub,
// -detail: 15px with 0.1em tracking, 9px with 0.09em, 7px with 0.08em), so
// a box's width is known before it is drawn (monoAdvance). The name is
// given 0.3 units a character past its face's advance (10.8, not 10.5):
// every graph so far is drawn with that room. A line longer than its wrap
// width breaks at a space; a word longer than that widens the box instead.
export const NODE_TEXT = {
  label: { advance: monoAdvance(15, 0.1) + 0.3, lineHeight: 19, wrapAt: 14, maxLines: 2 },
  sub: { advance: monoAdvance(9, 0.09, { roundUp: true }), lineHeight: 13, wrapAt: 26, maxLines: 2 },
  detail: { advance: monoAdvance(7, 0.08, { roundUp: true }), lineHeight: 11, wrapAt: 36, maxLines: 2 },
} as const;
const NODE_PAD_SIDE = 18;
const NODE_MIN_WIDTH = 140;
const NODE_LABEL_BASELINE = 28;
const NODE_RULE_DROP = 11;
const NODE_SUB_DROP = 19;
const NODE_DETAIL_DROP = 18;
const NODE_PAD_BOTTOM = 12;

// A node's frame is its box with the top-left and top-right corners cut and
// the bottom-left stepped; the renderer draws exactly this outline.
const FRAME_CUT = { topLeft: 14, topRight: 22, bottomLeft: 18 } as const;

export function nodeFramePath(width: number, height: number): string {
  return steppedFrame(width, height, FRAME_CUT);
}

// The tags in a node's top-right corner: the state glyph of a done or
// blocked node, and the NOTE marker of the node a rail note names. They
// stand in one row under the frame's top edge that ends TAG_INSET short of
// where the top-right cut begins, the marker outermost, so at any box size
// neither reaches the cut; the label's measured width keeps TAG_GAP clear
// of the row (`measureNode`).
const TAG_SIZE = { glyph: { width: 18, height: 15 }, marker: NOTE_MARKER } as const;
const TAG_TOP = 6;
const TAG_INSET = 6;
const TAG_GAP = 6;

export interface CornerTags {
  glyph: boolean;
  marker: boolean;
}

export interface CornerTagBoxes {
  glyph: Box | null;
  marker: Box | null;
}

/** Where a node's corner tags go, relative to its box's top-left corner. */
export function cornerTagBoxes(width: number, tags: CornerTags): CornerTagBoxes {
  let right = width - FRAME_CUT.topRight - TAG_INSET;
  const place = (size: Size): Box => {
    const box = { x: right - size.width, y: TAG_TOP, width: size.width, height: size.height };
    right = box.x - TAG_GAP;
    return box;
  };
  const marker = tags.marker ? place(TAG_SIZE.marker) : null;
  const glyph = tags.glyph ? place(TAG_SIZE.glyph) : null;
  return { glyph, marker };
}

// Room the label's lines leave beside them for the tag row: the row's reach
// in from the box's right edge, and a gap, less the side padding the box
// already has.
function tagRoom(tags: CornerTags): number {
  if (!tags.glyph && !tags.marker) return 0;
  const boxes = cornerTagBoxes(0, tags);
  const left = Math.min(...[boxes.glyph, boxes.marker].flatMap((box) => (box ? [box.x] : [])));
  return -left + TAG_GAP - NODE_PAD_SIDE;
}
const LABEL_WRAP_AT = 14;
const LABEL_MAX_LINES = 2;

// --- Text ------------------------------------------------------------------

/**
 * Breaks text at spaces into lines of at most `wrapAt` cells (textWrap.ts). Text
 * that would take more than `maxLines` lines is wrapped wider instead, at
 * the narrowest width that fits, so its lines stay balanced rather than
 * piling the rest onto the last one.
 */
export function wrapLine(text: string, wrapAt: number, maxLines: number): string[] {
  if (!text.trim()) return [''];
  let lines = wrapWords(text, wrapAt);
  if (lines.length <= maxLines) return lines;
  // The line count only falls as the width grows; the whole text on one
  // line always fits.
  let low = wrapAt + 1;
  let high = textCells(text);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (wrapWords(text, middle).length <= maxLines) high = middle;
    else low = middle + 1;
  }
  lines = wrapWords(text, low);
  return lines;
}

export interface NodeText {
  width: number;
  height: number;
  lines: NodeLine[];
  ruleY: number;
}

// Where each face of a node's text wraps, and the narrowest box. A drawing
// read top down in a narrow frame runs out of room across first, and its
// boxes are its width there: their text wraps narrower and to more lines.
interface NodeWrap {
  label: { wrapAt: number; maxLines: number };
  sub: { wrapAt: number; maxLines: number };
  detail: { wrapAt: number; maxLines: number };
  minWidth: number;
}
export const APPROVED_WRAP: NodeWrap = { label: NODE_TEXT.label, sub: NODE_TEXT.sub, detail: NODE_TEXT.detail, minWidth: NODE_MIN_WIDTH };
export const NARROW_WRAP: NodeWrap = {
  label: { wrapAt: 12, maxLines: 3 },
  sub: { wrapAt: 18, maxLines: 3 },
  detail: { wrapAt: 26, maxLines: 2 },
  minWidth: 116,
};

export function measureNode(node: DiagramNode, cornerTags: CornerTags, wrap: NodeWrap = APPROVED_WRAP): NodeText {
  const labelLines = wrapLine(node.label, wrap.label.wrapAt, wrap.label.maxLines);
  const subLines = node.sub ? wrapLine(node.sub, wrap.sub.wrapAt, wrap.sub.maxLines) : [];
  const detailLines = node.detail ? wrapLine(node.detail, wrap.detail.wrapAt, wrap.detail.maxLines) : [];

  const lines: NodeLine[] = [];
  let y = NODE_LABEL_BASELINE;
  labelLines.forEach((text, index) => {
    if (index > 0) y += NODE_TEXT.label.lineHeight;
    lines.push({ kind: 'label', text, y });
  });
  const ruleY = y + NODE_RULE_DROP;
  let last = ruleY;
  if (subLines.length) {
    y = ruleY + NODE_SUB_DROP;
    subLines.forEach((text, index) => {
      if (index > 0) y += NODE_TEXT.sub.lineHeight;
      lines.push({ kind: 'sub', text, y });
    });
    last = y;
  }
  if (detailLines.length) {
    y = subLines.length ? y + NODE_DETAIL_DROP : ruleY + NODE_SUB_DROP;
    detailLines.forEach((text, index) => {
      if (index > 0) y += NODE_TEXT.detail.lineHeight;
      lines.push({ kind: 'detail', text, y });
    });
    last = y;
  }

  const textWidth = Math.max(
    ...labelLines.map((line) => textCells(line) * NODE_TEXT.label.advance + tagRoom(cornerTags)),
    ...subLines.map((line) => textCells(line) * NODE_TEXT.sub.advance),
    ...detailLines.map((line) => textCells(line) * NODE_TEXT.detail.advance),
  );
  return {
    width: Math.max(wrap.minWidth, Math.ceil(textWidth + 2 * NODE_PAD_SIDE)),
    height: last + NODE_PAD_BOTTOM,
    lines,
    ruleY,
  };
}

export function wrapEdgeLabel(text: string): string[] {
  return wrapLine(text, LABEL_WRAP_AT, LABEL_MAX_LINES);
}

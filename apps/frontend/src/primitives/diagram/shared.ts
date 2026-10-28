// The constants and types more than one stage of the diagram layout reads.
// Space kept clear between a label's backing and anything else in its gap;
// a line passing a label keeps a little room from its backing too.
export const CLEARANCE = 6;
// An edge's arrowhead, in user units: the renderer draws it this long, and a
// label keeps clear of the gap's ends by this much so its backing never
// covers an arrowhead.
export const ARROW_LENGTH = 11;
export const ARROW_ROOM = ARROW_LENGTH + 2;
// Distance between two bend tracks sharing a gap.
export const TRACK_PITCH = 12;
// Space between boxes along the cross axis, and the most a sparse layer is
// spread beyond it to use the canvas.
export const NODE_SPACING = 28;
// How closely a drawing is packed across: on the approved canvas, and when
// it is laid out for the frame it will be read in at its readable minimum,
// where room across is what keeps it from scrolling both ways. There the
// lines of long edges run as a bundle, a few pixels apart on screen.
export interface Packing {
  dummy: number;
  padCross: number;
  padMain: number;
  minGap: number;
  maxGapStretch: number;
}
// A layer too crowded for the canvas is staggered into two rows along the
// main axis, its boxes interleaved so each back-row box sits behind the
// gap between two front-row boxes and its edges pass through that gap.
export const STAGGER_FROM = 4;
export const STAGGER_CLEARANCE = 12;
export const PORT_INSET = 14;
// An edge longer than the frame is drawn as two stubs only when it skips at
// least this many layers (a shorter one's stubs would take the room its line
// does), and only in a drawing longer than STUB_FROM frames (`chooseStubs`).
// A bundle's excess is stubbed whatever its length (`bundledEdges`).
export const STUB_MIN_SPAN = 2;
export const STUB_FROM = 2;

export const EPSILON = 0.5;

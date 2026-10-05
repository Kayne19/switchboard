// When the rail folds so the primary takes the stage's height
// (docs/visual-channel.md, "A primary that outgrows its slot"). Pure, so the
// rule is checked without a browser; SceneShell measures and asks.
//
// Where the rail stands under the main column (a portrait stage), every
// pixel it takes is one the primary does not get. A primary that reads
// whole in the column it shares with the rail keeps that layout. One whose
// content asks for more -- a drawing past its least readable scale, a table,
// a code pane or a document that scrolls, a figure drawn smaller than its
// width allows, a bar chart too short for a row per category, a long plan --
// gets the stage's height: the rail folds to a strip under it (its note,
// and Damocles), and the caller can open it again. Decided by geometry
// alone: where the rail stands, and what the primary's content says it
// lacks (useStageDemand), never the viewport's size or the object's type.

/** What a primitive in the primary slot says: how much taller than its viewport (`viewport`, CSS pixels) its content asks to be. */
export interface StageNeed {
  excess: number;
  viewport: number;
}

/** What the shell measures to decide. All in CSS pixels. */
export interface StageGeometry {
  /** The rail stands under the main column, not beside it. */
  stacked: boolean;
  /** The main column's height now. */
  column: number;
  /** The main column's height in the layout it shares with the rail. */
  shared: number;
  /** The column the primary would read whole in (`columnNeed`); `null` while nothing has said. */
  need: number | null;
}

/**
 * The main column a primary would be read whole in, from the column it has
 * now and what its primitives say. A viewport is most of its column, and
 * the frame around it grows with the column (the diagram's rails stand a
 * tenth of it in), so the need grows the column by the share it lacks;
 * the largest need of several is the primary's.
 */
export function columnNeed(column: number, said: StageNeed[]): number | null {
  if (said.length === 0 || column <= 0) return null;
  return Math.max(...said.map(({ excess, viewport }) => (viewport > 0 ? (column * (viewport + excess)) / viewport : column + excess)));
}

// A primary asks for the stage once its content is past the shared column
// by more than a line of text: a region that scrolls a few pixels for its
// last line keeps the rail. Folded, it gives the stage back only once it
// would read whole in the shared column with room to spare, so a content
// whose need sits on the line does not fold and unfold as it redraws.
export const STAGE_PAST = 24;
export const UNSTAGE_UNDER = 8;

/** Whether the primary takes the stage's height, given the layout it is in now (`staged`). */
export function wantsStage(geometry: StageGeometry, staged: boolean): boolean {
  const { stacked, shared, need } = geometry;
  if (!stacked || need === null || shared <= 0) return false;
  return staged ? need > shared + UNSTAGE_UNDER : need > shared + STAGE_PAST;
}

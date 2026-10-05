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
  /**
   * For a content laid out again for its viewport's height (a graph or a
   * sequence recomposed to scroll the least): the least height it asks
   * for when laid out for a viewport `height` CSS pixels tall at its width
   * now. What it asks on the stage is the stage's drawing, which says
   * nothing of the shared layout; this says what the shared one would ask.
   */
  relaid?: (height: number) => number;
}

/**
 * A primitive's last word, with the layout it was measured in. Its content
 * is compared with the viewport it had in the layout the primary shares
 * with the rail -- never with a model of how a viewport grows with its
 * column, which the frames round tables, documents and aux rows break.
 */
export interface StageReport extends StageNeed {
  /** Measured in the layout the primary shares with the rail. */
  shared: boolean;
  /** Its viewport the last time it was measured there, and that layout's column then; `null` before it ever was. */
  sharedViewport: number | null;
  sharedColumn: number | null;
}

/** A report from a fresh measure, remembering the shared viewport of the one before it. */
export function stageReport(need: StageNeed, shared: boolean, column: number, before: StageReport | undefined): StageReport {
  return shared
    ? { ...need, shared, sharedViewport: need.viewport, sharedColumn: column }
    : { ...need, shared, sharedViewport: before?.sharedViewport ?? null, sharedColumn: before?.sharedColumn ?? null };
}

/**
 * How far past its viewport in the shared layout a primitive's content
 * reaches, CSS pixels: as measured there, or its content now against the
 * viewport it had there (moved by as much as that column has since, should
 * the stage be resized). A content laid out again for its viewport is
 * weighed as it would be laid out for that one (`relaid`), so the word it
 * gives on the stage is the word the shared layout would give: no fold
 * that the shared layout would undo. Measured only on the stage, it is
 * past the shared one for certain if it overflows even the stage;
 * otherwise `null`, as it cannot tell.
 */
export function sharedExcess(report: StageReport, sharedColumn: number): number | null {
  if (report.shared) return report.excess;
  if (report.sharedViewport !== null && report.sharedColumn !== null) {
    const viewport = report.sharedViewport + sharedColumn - report.sharedColumn;
    return Math.round(report.relaid ? report.relaid(viewport) : report.viewport + report.excess) - viewport;
  }
  return report.excess > 0 ? Number.POSITIVE_INFINITY : null;
}

// A primary asks for the stage once its content is past its shared viewport
// by more than a line of text: a region that scrolls a few pixels for its
// last line keeps the rail. Folded, it gives the stage back only once it
// would be within a few pixels of reading whole there, so a content whose
// need sits on the line does not fold and unfold as it redraws. Both are
// read in the same measure (the content against the shared viewport), so
// the band between them holds whatever frames the viewport.
export const STAGE_PAST = 24;
export const UNSTAGE_UNDER = 8;

/**
 * Whether the primary takes the stage's height, given whether it does now
 * (`folded`) and the shared column's height now. A report that cannot tell
 * keeps the layout as it is.
 */
export function wantsStage(stacked: boolean, reports: StageReport[], folded: boolean, sharedColumn: number): boolean {
  if (!stacked || reports.length === 0) return false;
  const excesses = reports.map((report) => sharedExcess(report, sharedColumn));
  if (excesses.some((excess) => excess === null)) return folded;
  const most = Math.max(...(excesses as number[]));
  return folded ? most > UNSTAGE_UNDER : most > STAGE_PAST;
}

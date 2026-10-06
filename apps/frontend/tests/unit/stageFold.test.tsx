// @vitest-environment jsdom
// A primary that outgrows the column it shares with a rail standing under
// it takes the stage's height, the rail folded to a strip of its note and
// Damocles under it (app/stageFold.ts). Before, the rail always took its
// share: on a phone a forty-step pipeline was read through a slot of 374 px
// of 844, the note and the emblem under it.
import { describe, expect, it } from 'vitest';
import { STAGE_PAST, UNSTAGE_UNDER, sharedExcess, stageReport, wantsStage, type StageReport } from '../../src/app/stageFold';

describe('when the primary takes the stage', () => {
  // In the shared layout the column is 498 px and the viewport 374.
  const column = 498;
  const shared = (excess: number, viewport = 374) => stageReport({ excess, viewport }, true, column, undefined);
  // The same content measured on the stage, its viewport `viewport` there.
  const staged = (content: number, viewport: number, before: StageReport | undefined = shared(0)) =>
    stageReport({ excess: content - viewport, viewport }, false, column, before);

  it('keeps the shared layout for a primary that reads whole in it', () => {
    expect(wantsStage(true, [shared(-40)], false, column)).toBe(false);
    expect(wantsStage(true, [shared(0)], false, column)).toBe(false);
    // A region a few pixels short for its last line keeps the rail.
    expect(wantsStage(true, [shared(STAGE_PAST)], false, column)).toBe(false);
  });

  it('takes the stage for a primary past its shared viewport, the most any of its parts lacks', () => {
    expect(wantsStage(true, [shared(STAGE_PAST + 1)], false, column)).toBe(true);
    expect(wantsStage(true, [shared(-100), shared(5000)], false, column)).toBe(true);
  });

  it('never where the rail stands beside the primary, or while nothing has said what it needs', () => {
    expect(wantsStage(false, [shared(5000)], false, column)).toBe(false);
    expect(wantsStage(true, [], true, column)).toBe(false);
  });

  it('weighs a content measured on the stage against the viewport it had in the shared layout', () => {
    // 400 px of content in a 374 px viewport: past it by 26, on the stage too.
    const first = shared(26);
    expect(sharedExcess(staged(400, 482, first), column)).toBe(26);
    // The stage resized: the shared column grew by 20, so did its viewport.
    expect(sharedExcess(staged(400, 482, first), column + 20)).toBe(6);
    // Never measured in the shared layout: past even the stage is past it for certain; else it cannot tell.
    expect(sharedExcess(stageReport({ excess: 10, viewport: 482 }, false, column, undefined), column)).toBe(Number.POSITIVE_INFINITY);
    expect(sharedExcess(stageReport({ excess: -10, viewport: 482 }, false, column, undefined), column)).toBeNull();
  });

  // A graph laid out again for the stage's taller viewport asks what that
  // drawing needs, which says nothing of the shared layout. It kept the
  // stage, sent again small enough to read whole in its share, until
  // another primary came (phone-tidy open 3). It is weighed as it would be
  // laid out for the viewport it had there: the word the shared layout
  // would give, so nothing it decides the shared layout undoes.
  it('weighs a graph laid out again for the stage by what it would ask laid out for its shared viewport', () => {
    const graph = stageReport({ excess: 600 - 374, viewport: 374 }, true, column, undefined);
    // What it asks laid out for a viewport `height` tall: `shared` for the shared one's.
    const asked: number[] = [];
    const laidOut = (shared: number) => (height: number) => {
      asked.push(height);
      return height === 374 ? shared : height === 394 ? shared - 20 : 9999;
    };
    // On the stage (482 px) it reads whole, whatever it would ask in its share.
    const relaid = (shared: number) => stageReport({ excess: -30, viewport: 482, relaid: laidOut(shared) }, false, column, graph);
    expect(sharedExcess(relaid(300), column)).toBe(300 - 374);
    expect(asked).toEqual([374]);
    expect(sharedExcess(relaid(400), column)).toBe(400 - 374);
    // The stage resized: the shared viewport moved with its column.
    expect(sharedExcess(relaid(400), column + 20)).toBe(380 - 394);
    // Folded, it gives the stage back once it would read whole in its share, with the same room to spare as any content.
    expect(wantsStage(true, [relaid(300)], true, column)).toBe(false);
    expect(wantsStage(true, [relaid(374 + UNSTAGE_UNDER)], true, column)).toBe(false);
    expect(wantsStage(true, [relaid(374 + UNSTAGE_UNDER + 1)], true, column)).toBe(true);
    // Never measured in the shared layout, it cannot tell that viewport: past even the stage is past it for certain.
    expect(sharedExcess(stageReport({ excess: -30, viewport: 482, relaid: laidOut(300) }, false, column, undefined), column)).toBeNull();
    expect(sharedExcess(stageReport({ excess: 40, viewport: 482, relaid: laidOut(300) }, false, column, undefined), column)).toBe(Number.POSITIVE_INFINITY);
  });

  it('keeps the layout it has while a part cannot tell', () => {
    const unknown = stageReport({ excess: -10, viewport: 482 }, false, column, undefined);
    expect(wantsStage(true, [unknown], true, column)).toBe(true);
    expect(wantsStage(true, [unknown], false, column)).toBe(false);
  });

  it('gives the stage back only with room to spare, so a need on the line does not flicker', () => {
    // Folded: still past the shared viewport, it keeps the stage.
    expect(wantsStage(true, [staged(374 + 20, 482)], true, column)).toBe(true);
    // Within the band between the two thresholds it keeps the layout it has.
    expect(wantsStage(true, [staged(374 + UNSTAGE_UNDER + 1, 482)], true, column)).toBe(true);
    expect(wantsStage(true, [shared(UNSTAGE_UNDER + 1)], false, column)).toBe(false);
    // It reads whole in the shared viewport: the rail comes back.
    expect(wantsStage(true, [staged(374 + UNSTAGE_UNDER, 482)], true, column)).toBe(false);
  });

  it('does not fold and unfold a content framed by fixed chrome (a document, a table over an aux row)', () => {
    // A document whose heading and meta take 150 px of a 515 px column: its
    // viewport is 365 there and 473 on the stage. 400 px of text folds the
    // rail; on the stage, the same text against the same 365 keeps it.
    const document = shared(400 - 365, 365);
    expect(wantsStage(true, [document], false, column)).toBe(true);
    expect(wantsStage(true, [staged(400, 473, document)], true, column)).toBe(true);
    // 380 px of text keeps the shared layout, and would never have folded.
    expect(wantsStage(true, [shared(380 - 365, 365)], false, column)).toBe(false);
  });
});

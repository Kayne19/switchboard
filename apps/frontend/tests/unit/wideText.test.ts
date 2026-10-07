// Text the layouts measure and cut is counted in what the monospace face
// draws, not in UTF-16 units: a wide character (CJK, an emoji) takes two
// cells, a combining mark none, and a cut never splits a character in two
// (design/textCells.ts). An ASCII label measures as it always did.
import { describe, expect, it } from 'vitest';
import { chartLegendLayout, wrapLabel } from '../../src/primitives/chartGeometry';
import { measureNode } from '../../src/primitives/diagramLayout';
import { LABEL_ADVANCE, LABEL_BACKING, labelBox } from '../../src/primitives/drawingKit';
import { layoutSequence } from '../../src/primitives/sequenceLayout';
import type { ChartData, SequenceDiagramData } from '../../src/controller/types';

// A high surrogate with no low one after it, or a low one with none before.
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const noTags = { glyph: false, marker: false };

describe('wide text in the drawings', () => {
  it('wraps and cuts a chart label between characters, never inside one', () => {
    const wrapped = wrapLabel('\u{1F680}'.repeat(30), 15, 3);
    expect(wrapped.truncated).toBe(true);
    for (const line of wrapped.lines) expect(line).not.toMatch(LONE);
    expect(wrapped.text).not.toMatch(LONE);
  });

  it('cuts a legend name between characters and counts a wide one as two cells', () => {
    const data: ChartData = { series: [{ name: '\u{1F680}'.repeat(80), values: [1, 2, 3] }] };
    const [item] = chartLegendLayout(data, 300).items;
    expect(item.truncated).toBe(true);
    expect(item.text).not.toMatch(LONE);
    // A CJK name as wide on screen as an ASCII one twice its length is cut where that one is.
    const cjk = chartLegendLayout({ series: [{ name: '\u6570'.repeat(40), values: [1] }] }, 300).items[0];
    const ascii = chartLegendLayout({ series: [{ name: 'A'.repeat(80), values: [1] }] }, 300).items[0];
    expect(cjk.truncated).toBe(true);
    expect([...cjk.text.replace('\u2026', '')].length * 2).toBeLessThanOrEqual(ascii.text.replace('\u2026', '').length + 1);
  });

  it('sizes a node to a CJK label as twice the cells of its characters', () => {
    const ascii = measureNode({ id: 'a', label: 'ABCDEFGHIJKL' }, noTags);
    const cjk = measureNode({ id: 'c', label: '\u6570\u636E\u5E93\u670D\u52A1\u5668' }, noTags);
    expect(cjk.width).toBe(ascii.width);
  });

  it('backs a wide edge label with two cells a character', () => {
    expect(labelBox(['\u6570\u636E\u5E93']).width).toBe(6 * LABEL_ADVANCE + 2 * LABEL_BACKING);
    expect(labelBox(['e\u0301t\u00E9']).width).toBe(3 * LABEL_ADVANCE + 2 * LABEL_BACKING);
  });

  it('breaks a long emoji message label between characters', () => {
    const data: SequenceDiagramData = {
      mode: 'sequence',
      actors: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      messages: [{ from: 'a', to: 'b', label: '\u{1F680}'.repeat(60) }],
    };
    const layout = layoutSequence(data, 'landscape', { width: 320 });
    for (const message of layout.messages) for (const line of message.label.lines) expect(line).not.toMatch(LONE);
  });
});

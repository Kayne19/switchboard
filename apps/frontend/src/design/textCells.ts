// How much room text takes in the page's monospace face, in cells: the
// layouts size boxes and cut lines by it before the text is drawn
// (`monoAdvance`, design/tokens.ts, is the width of one cell). A character
// is what the reader sees as one, a grapheme cluster: a letter and its
// accents, an emoji and its modifiers. It takes one cell, two when it is
// East Asian Wide or Fullwidth (CJK, Hangul, kana, fullwidth forms) or an
// emoji drawn as a picture, and none when it is only a format character.
// A cut is made between characters, never inside one: a half surrogate
// pair draws as U+FFFD.

// The Wide and Fullwidth blocks of Unicode's East Asian Width property
// (UAX #11) that a label may carry; emoji are found by their own property.
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0x303e], // CJK radicals, Kangxi radicals, ideographic description, CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compatibility Jamo, Kanbun, CJK strokes, enclosed and compatibility
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x16fe0, 0x18cff], // ideographic symbols, Tangut
  [0x1b000, 0x1b2ff], // kana supplement and extensions, Nushu
  [0x1f200, 0x1f2ff], // enclosed ideographic supplement
  [0x20000, 0x2fffd], // CJK Unified Ideographs Extension B onward
  [0x30000, 0x3fffd], // CJK Unified Ideographs Extension G onward
];

const EMOJI = /\p{Emoji_Presentation}|\uFE0F/u;
const FORMAT_ONLY = /^\p{Cf}+$/u;
// Text in printable ASCII alone is one cell a code unit: the common case, measured without segmenting.
const ASCII = /^[\x20-\x7e]*$/;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function isWide(codePoint: number): boolean {
  for (const [from, to] of WIDE) {
    if (codePoint < from) return false;
    if (codePoint <= to) return true;
  }
  return false;
}

/** The characters (grapheme clusters) of `text`, in order. */
export function graphemes(text: string): string[] {
  if (ASCII.test(text)) return text.split('');
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** The cells one character takes: 0, 1 or 2. */
function cellsOf(grapheme: string): number {
  if (FORMAT_ONLY.test(grapheme)) return 0;
  if (EMOJI.test(grapheme) || isWide(grapheme.codePointAt(0) ?? 0)) return 2;
  return 1;
}

/** The cells `text` takes in the monospace face. */
export function textCells(text: string): number {
  if (ASCII.test(text)) return text.length;
  let cells = 0;
  for (const grapheme of graphemes(text)) cells += cellsOf(grapheme);
  return cells;
}

/** The longest start of `text` that fits in `cells`, cut between characters. */
export function headCells(text: string, cells: number): string {
  if (ASCII.test(text)) return text.slice(0, Math.max(0, cells));
  let used = 0;
  let end = 0;
  for (const grapheme of graphemes(text)) {
    used += cellsOf(grapheme);
    if (used > cells) break;
    end += grapheme.length;
  }
  return text.slice(0, end);
}

/** The longest end of `text` that fits in `cells`, cut between characters. */
export function tailCells(text: string, cells: number): string {
  if (ASCII.test(text)) return cells <= 0 ? '' : text.slice(-cells);
  let used = 0;
  let start = text.length;
  for (const grapheme of graphemes(text).reverse()) {
    used += cellsOf(grapheme);
    if (used > cells) break;
    start -= grapheme.length;
  }
  return text.slice(start);
}

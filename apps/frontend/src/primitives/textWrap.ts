// Words set on lines, said once for every drawing that wraps its own text
// before it is drawn (a chart's category labels, a node's label, an edge's
// or a message's label, an actor's header): greedy at spaces, measured in
// monospace cells (design/textCells.ts). A word too long for a line is
// broken where a reader would break it -- after a separator (a space, / _ .
// : - or an opening parenthesis) or where a camel-cased name starts its
// next word -- and inside a word only where there is no such place.
import { graphemes, textCells } from '../design/textCells';

// A token that only ends what comes before it (the `/` of "DAMOCLES /
// FRONT DESK"): it stays on that line. One that leads what follows (`+`,
// `&`, `->`) may open the next, where it reads as "and then".
const TRAILING = /^[/|:;,\u00B7]+$/;
const SEPARATOR = /^[\s/_.:(-]$/;
const LOWER = /^\p{Ll}$/u;
const UPPER = /^\p{Lu}$/u;

/**
 * Words onto lines of at most `cells`, each as full as it goes. A word
 * longer than that takes a line of its own (`wrapText` breaks it); a
 * trailing separator stays on the line before it rather than opening one.
 */
export function wrapWords(text: string, cells: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!current) current = word;
    else if (TRAILING.test(word) || textCells(current) + 1 + textCells(word) <= cells) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Whether a line may end between `before` and `after`: after a run of
// separators, or inside a camel-cased name before its next word's capital.
function breaksBetween(before: string | undefined, after: string | undefined): boolean {
  if (before === undefined || after === undefined) return false;
  return (SEPARATOR.test(before) && !SEPARATOR.test(after)) || (LOWER.test(before) && UPPER.test(after));
}

/**
 * A word (or any text) cut into pieces of at most `cells`, each as long as
 * a break allows: at the last place a reader would break it, else at
 * `cells` itself. `fromEnd` fills the pieces from the end instead (the
 * last piece fullest), for text whose end is what tells it apart (a path).
 * Pieces are trimmed of the spaces they were cut at.
 */
export function breakWord(word: string, cells: number, { fromEnd = false }: { fromEnd?: boolean } = {}): string[] {
  const chars = graphemes(word);
  const widths = chars.map((char) => textCells(char));
  const pieces: string[] = [];
  let low = 0;
  let high = chars.length;
  const width = (from: number, to: number) => widths.slice(from, to).reduce((sum, each) => sum + each, 0);
  while (low < high && width(low, high) > cells) {
    if (!fromEnd) {
      // The most characters from `low` that fit, at least one.
      let end = low + 1;
      while (end < high && width(low, end + 1) <= cells) end += 1;
      let at = end;
      while (at > low && !breaksBetween(chars[at - 1], chars[at])) at -= 1;
      const cut = at > low ? at : end;
      pieces.push(chars.slice(low, cut).join('').trim());
      low = cut;
    } else {
      let start = high - 1;
      while (start > low && width(start - 1, high) <= cells) start -= 1;
      let at = start;
      while (at < high && !breaksBetween(chars[at - 1], chars[at])) at += 1;
      const cut = at < high ? at : start;
      pieces.unshift(chars.slice(cut, high).join('').trim());
      high = cut;
    }
  }
  const rest = chars.slice(low, high).join('').trim();
  if (rest) (fromEnd ? pieces.unshift(rest) : pieces.push(rest));
  return pieces.filter(Boolean);
}

/** Text onto lines of at most `cells`: wrapped at spaces (`wrapWords`), a word too long broken (`breakWord`). */
export function wrapText(text: string, cells: number): string[] {
  return wrapWords(text, cells).flatMap((line) => (textCells(line) > cells ? breakWord(line, cells) : [line]));
}

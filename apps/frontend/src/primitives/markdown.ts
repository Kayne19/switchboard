// A deliberately small Markdown reader for spoken and explanatory text.
//
// Agents write their replies in Markdown, and the page used to show the raw
// markers. This reads the subset that shows up in conversation -- strong,
// emphasis, code spans, paragraphs, lists, and headings -- into a tree that
// RichText renders as React elements. It never produces HTML, so model text
// cannot inject markup, and a link shows as its label only: this screen is
// not a browser, and nothing on it should navigate away.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'break' };

export type Block =
  | { kind: 'paragraph'; inlines: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] };

const LINK = /^\[([^\]\n]+)\]\(([^)\s]*)\)/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+•]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;

const isWhitespace = (char: string | undefined) => char === undefined || /\s/.test(char);
const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

// A delimiter opens emphasis only when text follows it directly, and an
// underscore never opens or closes inside a word. That is what keeps
// "2 * 3 * 4" and snake_case identifiers literal.
function canOpen(text: string, index: number, delimiter: string): boolean {
  const after = text[index + delimiter.length];
  if (isWhitespace(after)) return false;
  return delimiter[0] !== '_' || !isWordChar(text[index - 1]);
}

function findClose(text: string, from: number, delimiter: string): number {
  for (let index = text.indexOf(delimiter, from); index !== -1; index = text.indexOf(delimiter, index + 1)) {
    if (index === from || isWhitespace(text[index - 1])) continue;
    if (delimiter[0] === '_' && isWordChar(text[index + delimiter.length])) continue;
    // A single delimiter must not close on half of a doubled one.
    if (delimiter.length === 1 && text[index + 1] === delimiter) {
      index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

export function parseInline(text: string): Inline[] {
  const result: Inline[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) result.push({ kind: 'text', text: buffer });
    buffer = '';
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index];

    if (char === '`') {
      const close = text.indexOf('`', index + 1);
      if (close > index + 1) {
        flush();
        result.push({ kind: 'code', text: text.slice(index + 1, close) });
        index = close + 1;
        continue;
      }
    }

    if (char === '[') {
      const link = LINK.exec(text.slice(index));
      if (link) {
        flush();
        result.push({ kind: 'text', text: link[1] });
        index += link[0].length;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      const delimiter = text[index + 1] === char ? char + char : char;
      if (canOpen(text, index, delimiter)) {
        const start = index + delimiter.length;
        const close = findClose(text, start, delimiter);
        if (close !== -1) {
          flush();
          const children = parseInline(text.slice(start, close));
          result.push(delimiter.length === 2 ? { kind: 'strong', children } : { kind: 'em', children });
          index = close + delimiter.length;
          continue;
        }
      }
      buffer += delimiter;
      index += delimiter.length;
      continue;
    }

    buffer += char;
    index += 1;
  }
  flush();
  return result;
}

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  const close = () => {
    if (current) blocks.push(current);
    current = null;
  };

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) {
      close();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      close();
      blocks.push({ kind: 'paragraph', inlines: [{ kind: 'strong', children: parseInline(heading[1]) }] });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const ordered = numbered !== null;
      if (current?.kind !== 'list' || current.ordered !== ordered) {
        close();
        current = { kind: 'list', ordered, items: [] };
      }
      current.items.push(parseInline(item[1]));
      continue;
    }

    // An indented line under a list item continues that item.
    if (current?.kind === 'list' && /^\s/.test(line)) {
      current.items[current.items.length - 1].push({ kind: 'break' }, ...parseInline(line.trim()));
      continue;
    }

    if (current?.kind !== 'paragraph') {
      close();
      current = { kind: 'paragraph', inlines: [] };
    } else {
      current.inlines.push({ kind: 'break' });
    }
    current.inlines.push(...parseInline(line.trim()));
  }
  close();
  return blocks;
}

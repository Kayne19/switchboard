// A deliberately small, safe Markdown reader for conversation text.
//
// This is not an HTML renderer. It turns the Markdown subset used in agent
// replies into data for RichText to render as React elements. Model-provided
// HTML therefore remains ordinary text, and only explicitly allowed URL
// schemes become links.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'break' };

export type Block =
  | { kind: 'paragraph'; inlines: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; text: string };

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+•]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const FENCE = /^\s{0,3}```(?:[^`]*)\s*$/;

const isWhitespace = (char: string | undefined) => char === undefined || /\s/.test(char);
const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

// Only these schemes are navigable. Relative URLs and javascript:, data:, and
// similar values are deliberately represented as their label only.
function isSafeHref(href: string): boolean {
  return /^(?:https?:|mailto:)/i.test(href) && !/[\u0000-\u001f\u007f\s]/.test(href);
}

interface ParsedLink {
  end: number;
  label: string;
  href: string;
}

function linkAt(text: string, start: number): ParsedLink | null {
  if (text[start] !== '[') return null;
  const labelEnd = text.indexOf(']', start + 1);
  if (labelEnd <= start + 1 || text[labelEnd + 1] !== '(') return null;

  // Markdown destinations may contain balanced parentheses. Keep malformed
  // input literal instead of guessing where the destination ends.
  let depth = 1;
  let index = labelEnd + 2;
  for (; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  const href = text.slice(labelEnd + 2, index).trim();
  if (!href || /[\u0000-\u001f\u007f\s]/.test(href)) return null;
  return { end: index + 1, label: text.slice(start + 1, labelEnd), href };
}

// A delimiter opens emphasis only when text follows it directly, and an
// underscore never opens or closes inside a word. That keeps snake_case and
// ordinary arithmetic literal.
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

    if (char === '\\' && /[\\`*_[\]()]/.test(text[index + 1] ?? '')) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }

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
      const link = linkAt(text, index);
      if (link) {
        flush();
        if (isSafeHref(link.href)) {
          result.push({ kind: 'link', href: link.href, children: parseInline(link.label) });
        } else {
          result.push(...parseInline(link.label));
        }
        index = link.end;
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
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      close();
      continue;
    }

    if (FENCE.test(line)) {
      const codeLines: string[] = [];
      let closingIndex = -1;
      for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
        if (/^\s{0,3}```\s*$/.test(lines[candidate])) {
          closingIndex = candidate;
          break;
        }
        codeLines.push(lines[candidate]);
      }
      // An unclosed fence is not a reason to lose the message. Treat it as
      // ordinary paragraph text so the markers remain readable.
      if (closingIndex !== -1) {
        close();
        blocks.push({ kind: 'code', text: codeLines.join('\n') });
        index = closingIndex;
        continue;
      }
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

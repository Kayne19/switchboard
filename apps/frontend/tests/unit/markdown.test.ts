import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline } from '../../src/primitives/markdown';

describe('inline markdown', () => {
  it('reads strong, emphasis, and code spans', () => {
    expect(parseInline('a **bold** and *soft* and `code` end')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'bold' }] },
      { kind: 'text', text: ' and ' },
      { kind: 'em', children: [{ kind: 'text', text: 'soft' }] },
      { kind: 'text', text: ' and ' },
      { kind: 'code', text: 'code' },
      { kind: 'text', text: ' end' },
    ]);
  });

  it('accepts underscore delimiters and nests emphasis inside strong', () => {
    expect(parseInline('__all *of* it__ and _this_')).toEqual([
      {
        kind: 'strong',
        children: [
          { kind: 'text', text: 'all ' },
          { kind: 'em', children: [{ kind: 'text', text: 'of' }] },
          { kind: 'text', text: ' it' },
        ],
      },
      { kind: 'text', text: ' and ' },
      { kind: 'em', children: [{ kind: 'text', text: 'this' }] },
    ]);
  });

  it('leaves arithmetic, snake_case, and unclosed markers as text', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([{ kind: 'text', text: '2 * 3 * 4' }]);
    expect(parseInline('call route_final_transcript now')).toEqual([
      { kind: 'text', text: 'call route_final_transcript now' },
    ]);
    expect(parseInline('an **unclosed marker')).toEqual([{ kind: 'text', text: 'an **unclosed marker' }]);
  });

  it('keeps markdown inside a code span literal', () => {
    expect(parseInline('run `a **b** c`')).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: 'a **b** c' },
    ]);
  });

  it('shows a link as its label and never as a navigable target', () => {
    expect(parseInline('see [the docs](https://example.com) here')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'text', text: 'the docs' },
      { kind: 'text', text: ' here' },
    ]);
  });
});

describe('block markdown', () => {
  it('splits paragraphs on blank lines and keeps single newlines as breaks', () => {
    expect(parseBlocks('first line\nsecond line\n\nnext paragraph')).toEqual([
      {
        kind: 'paragraph',
        inlines: [
          { kind: 'text', text: 'first line' },
          { kind: 'break' },
          { kind: 'text', text: 'second line' },
        ],
      },
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'next paragraph' }] },
    ]);
  });

  it('reads bulleted and numbered lists', () => {
    expect(parseBlocks('Steps:\n- one\n- **two**\n\n1. first\n2. second')).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'Steps:' }] },
      {
        kind: 'list',
        ordered: false,
        items: [
          [{ kind: 'text', text: 'one' }],
          [{ kind: 'strong', children: [{ kind: 'text', text: 'two' }] }],
        ],
      },
      {
        kind: 'list',
        ordered: true,
        items: [[{ kind: 'text', text: 'first' }], [{ kind: 'text', text: 'second' }]],
      },
    ]);
  });

  it('renders a heading as a strong paragraph rather than display type', () => {
    expect(parseBlocks('## Result\nIt passed.')).toEqual([
      { kind: 'paragraph', inlines: [{ kind: 'strong', children: [{ kind: 'text', text: 'Result' }] }] },
      { kind: 'paragraph', inlines: [{ kind: 'text', text: 'It passed.' }] },
    ]);
  });

  it('returns no blocks for blank text', () => {
    expect(parseBlocks('  \n \n')).toEqual([]);
  });
});

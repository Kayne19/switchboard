import { describe, expect, it } from 'vitest';
import { graphemes, headCells, textCells } from '../../src/design/textCells';

describe('textCells', () => {
  it('counts one cell a character, two for a wide one, none for a format character', () => {
    expect(textCells('abc')).toBe(3);
    expect(textCells('')).toBe(0);
    expect(textCells('\u6570\u636E')).toBe(4);
    expect(textCells('\uD55C\uAE00')).toBe(4);
    expect(textCells('\uFF21\uFF22')).toBe(4);
    expect(textCells('\u{1F680}')).toBe(2);
    expect(textCells('\u{1F469}\u200D\u{1F4BB}')).toBe(2);
    expect(textCells('\u2764\uFE0F')).toBe(2);
    expect(textCells('e\u0301')).toBe(1);
    expect(textCells('a\u200Bb')).toBe(2);
    expect(textCells('caf\u00E9 \u2192 ok')).toBe(9);
  });

  it('splits text into the characters a reader sees', () => {
    expect(graphemes('ab')).toEqual(['a', 'b']);
    expect(graphemes('e\u0301\u{1F680}')).toEqual(['e\u0301', '\u{1F680}']);
  });

  it('cuts the head between characters', () => {
    expect(headCells('abcdef', 3)).toBe('abc');
    expect(headCells('abc', 0)).toBe('');
    expect(headCells('\u6570\u636E\u5E93', 3)).toBe('\u6570');
    expect(headCells('\u{1F680}\u{1F680}', 3)).toBe('\u{1F680}');
    expect(headCells('e\u0301e\u0301', 1)).toBe('e\u0301');
  });
});

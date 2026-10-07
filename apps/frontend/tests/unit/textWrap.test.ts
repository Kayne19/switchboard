import { describe, expect, it } from 'vitest';
import { breakWord, wrapText, wrapWords } from '../../src/primitives/textWrap';

describe('textWrap', () => {
  it('wraps words greedily, a bare separator kept on the line before', () => {
    expect(wrapWords('frontend visual', 10)).toEqual(['frontend', 'visual']);
    expect(wrapWords('frontend visual', 20)).toEqual(['frontend visual']);
    expect(wrapWords('DAMOCLES / FRONT DESK', 8)).toEqual(['DAMOCLES /', 'FRONT', 'DESK']);
    expect(wrapWords('display frame + seq', 14)).toEqual(['display frame', '+ seq']);
    expect(wrapWords('a verylongword b', 4)).toEqual(['a', 'verylongword', 'b']);
    expect(wrapWords('   ', 4)).toEqual([]);
  });

  it('breaks a long word after a separator or before a camel-cased word, else at the width', () => {
    expect(breakWord('apps/frontend/tests/unit/notePlacement.test.ts', 26)).toEqual(['apps/frontend/tests/unit/', 'notePlacement.test.ts']);
    expect(breakWord('notePlacement.test.ts', 13)).toEqual(['note', 'Placement.', 'test.ts']);
    expect(breakWord('abcdefghijklmnop', 6)).toEqual(['abcdef', 'ghijkl', 'mnop']);
    expect(breakWord('call(session_id)', 8)).toEqual(['call(', 'session_', 'id)']);
    expect(breakWord('short', 8)).toEqual(['short']);
  });

  it('fills from the end where the end tells the text apart', () => {
    expect(breakWord('apps/backend/tests/test_visual_protocol.rs', 15, { fromEnd: true }).slice(-2)).toEqual(['test_visual_', 'protocol.rs']);
  });

  it('counts wide characters as two cells and never splits one', () => {
    expect(breakWord('\u6570\u636E\u5E93\u670D', 4)).toEqual(['\u6570\u636E', '\u5E93\u670D']);
    expect(breakWord('\u{1F680}\u{1F680}\u{1F680}', 3)).toEqual(['\u{1F680}', '\u{1F680}', '\u{1F680}']);
    expect(breakWord('\u{1F680}', 1)).toEqual(['\u{1F680}']);
  });

  it('wraps text and breaks the words too long for a line', () => {
    expect(wrapText('see apps/frontend/src/primitives/textWrap.ts now', 20)).toEqual(['see', 'apps/frontend/src/', 'primitives/textWrap.', 'ts', 'now']);
  });
});

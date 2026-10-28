// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { CodeViewport } from '../../src/primitives/CodeViewport';
import { mount, stubResizeObserver } from './sceneHarness';

// The source scrolls in a list viewport, which watches its box.
stubResizeObserver();

function line(text: string, language?: string) {
  const root = mount(<CodeViewport data={{ source: language === undefined ? { text } : { text, language } }} />);
  return root.querySelector('.code-line__source') as HTMLElement;
}

function tokens(source: HTMLElement, className: string) {
  return [...source.querySelectorAll(`.${className}`)].map((node) => node.textContent);
}

describe('CodeViewport tokens', () => {
  it('reads // as a comment only outside a string', () => {
    const source = line('const url = "a//b"; // the path');
    expect(tokens(source, 'tok-string')).toEqual(['"a//b"']);
    expect(tokens(source, 'tok-comment')).toEqual(['// the path']);
    expect(source.textContent).toBe('const url = "a//b"; // the path');
  });

  it('takes the comment marker from the language', () => {
    const python = line('half = total // 2  # floor division', 'python');
    expect(tokens(python, 'tok-comment')).toEqual(['# floor division']);
    expect(python.textContent).toBe('half = total // 2  # floor division');

    const rust = line('let x = 1; // one', 'rust');
    expect(tokens(rust, 'tok-comment')).toEqual(['// one']);

    const sql = line("SELECT '--' AS dash -- the dash", 'sql');
    expect(tokens(sql, 'tok-string')).toEqual(["'--'"]);
    expect(tokens(sql, 'tok-comment')).toEqual(['-- the dash']);
  });

  it('keeps a # inside a string', () => {
    const source = line('tag = "#1"  # first', 'python');
    expect(tokens(source, 'tok-string')).toEqual(['"#1"']);
    expect(tokens(source, 'tok-comment')).toEqual(['# first']);
  });

  it('reads a shell # as a comment only where a word begins', () => {
    const source = line('echo "${#files[@]}" $# # the count', 'bash');
    expect(tokens(source, 'tok-comment')).toEqual(['# the count']);
    expect(source.textContent).toBe('echo "${#files[@]}" $# # the count');
    expect(tokens(line('ls; # list', 'sh'), 'tok-comment')).toEqual(['# list']);
    expect(tokens(line('# first line', 'zsh'), 'tok-comment')).toEqual(['# first line']);
    expect(tokens(line('x=$#', 'shell'), 'tok-comment')).toEqual([]);
  });

  it.each([
    ['a | b # c', '# c'],
    ['a & # c', '# c'],
    ['(# c', '# c'],
    ['a\t# c', '# c'],
    ['a < # c', '# c'],
    ['a > # c', '# c'],
    ['a;# c', '# c'],
  ])('starts a shell comment after %j', (code, comment) => {
    const source = line(code, 'bash');
    expect(tokens(source, 'tok-comment')).toEqual([comment]);
    expect(source.textContent).toBe(code);
  });

  it('keeps a # that follows a string or a word in the same shell word', () => {
    expect(tokens(line('echo "a"#b', 'bash'), 'tok-comment')).toEqual([]);
    expect(tokens(line('echo a#b', 'bash'), 'tok-comment')).toEqual([]);
  });

  it("reads Perl's $#array as code, as a shell's", () => {
    expect(tokens(line('print $#a; # last index', 'perl'), 'tok-comment')).toEqual(['# last index']);
  });

  it('reads a # that follows code as a comment in other # languages', () => {
    expect(tokens(line('x = 1# one', 'python'), 'tok-comment')).toEqual(['# one']);
  });

  it('draws a language it does not know as plain text', () => {
    const source = line('const x = "a" // y # z -- w 42', 'brainfunk');
    expect(source.querySelectorAll('[class^="tok-"]')).toHaveLength(0);
    expect(source.textContent).toBe('const x = "a" // y # z -- w 42');
  });

  it('reads source with no language as C-family, as before', () => {
    expect(tokens(line('a(); // call'), 'tok-comment')).toEqual(['// call']);
  });

  it('marks the keywords of a named language and of source with no language', () => {
    expect(tokens(line('const x = await y;', 'typescript'), 'tok-keyword')).toEqual(['const', 'await']);
    expect(tokens(line('const x = await y;'), 'tok-keyword')).toEqual(['const', 'await']);
  });

  it('counts highlight lines from 1', () => {
    const root = mount(<CodeViewport data={{ source: { text: 'one\ntwo\nthree', highlight: [2] } }} />);
    const hot = [...root.querySelectorAll('.code-line--hot .code-line__source')].map((node) => node.textContent);
    expect(hot).toEqual(['two']);
  });
});

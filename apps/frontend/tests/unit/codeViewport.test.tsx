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

  it('marks no comment in a language it does not know', () => {
    const source = line('x // y # z -- w', 'brainfunk');
    expect(tokens(source, 'tok-comment')).toEqual([]);
    expect(source.textContent).toBe('x // y # z -- w');
  });

  it('reads source with no language as C-family, as before', () => {
    expect(tokens(line('a(); // call'), 'tok-comment')).toEqual(['// call']);
  });

  it('counts highlight lines from 1', () => {
    const root = mount(<CodeViewport data={{ source: { text: 'one\ntwo\nthree', highlight: [2] } }} />);
    const hot = [...root.querySelectorAll('.code-line--hot .code-line__source')].map((node) => node.textContent);
    expect(hot).toEqual(['two']);
  });
});

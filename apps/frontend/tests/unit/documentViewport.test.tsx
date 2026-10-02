// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DocumentViewport } from '../../src/primitives/DocumentViewport';

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(paragraphs: string[]) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<DocumentViewport data={{ subject: 'Report', paragraphs }} />));
  return host.querySelector('.document-viewport__body') as HTMLElement;
}

describe('DocumentViewport paragraphs', () => {
  it('keeps plain paragraphs as one paragraph each, with line breaks', () => {
    const body = render(['First line\nsecond line', 'Another paragraph.']);
    const paragraphs = [...body.querySelectorAll('p')];
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].querySelectorAll('br')).toHaveLength(1);
    expect(paragraphs[0].textContent).toBe('First linesecond line');
    expect(paragraphs[1].textContent).toBe('Another paragraph.');
  });

  it('renders Markdown instead of showing its markers', () => {
    const body = render([
      '## Findings',
      'The **turn epoch** is stamped in `dispatch.rs`, *before* the lock.',
      '- one\n- two',
      '1. first\n2. second',
      '```\nlet x = 1;\n```',
    ]);
    expect(body.textContent).not.toMatch(/##|\*\*|`/);
    expect(body.querySelector('p strong')?.textContent).toBe('Findings');
    expect([...body.querySelectorAll('strong')].map((node) => node.textContent)).toContain('turn epoch');
    expect(body.querySelector('em')?.textContent).toBe('before');
    expect(body.querySelector('code.rich-text__code')?.textContent).toBe('dispatch.rs');
    expect([...body.querySelectorAll('ul li')].map((node) => node.textContent)).toEqual(['one', 'two']);
    expect([...body.querySelectorAll('ol li')].map((node) => node.textContent)).toEqual(['first', 'second']);
    expect(body.querySelector('pre.rich-text__code-block code')?.textContent).toBe('let x = 1;');
  });

  it('never creates links or elements from model HTML', () => {
    const body = render(['[docs](https://example.com) <img src=x onerror=alert(1)>']);
    expect(body.querySelector('a')).toBeNull();
    expect(body.querySelector('img')).toBeNull();
    expect(body.textContent).toBe('docs <img src=x onerror=alert(1)>');
  });
});

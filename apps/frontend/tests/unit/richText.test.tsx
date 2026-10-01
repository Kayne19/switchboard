// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RichText } from '../../src/primitives/RichText';

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(text: string) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<RichText allowLinks segments={[{ text }]} />));
}

describe('RichText links and HTML safety', () => {
  it('renders safe links with a new-tab safety policy', () => {
    render('[docs](https://example.com) and [mail](mailto:team@example.com)');
    const links = [...host.querySelectorAll('a')];
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('https://example.com');
    expect(links[0].target).toBe('_blank');
    expect(links[0].rel).toBe('noopener noreferrer');
    expect(links[1].getAttribute('href')).toBe('mailto:team@example.com');
  });

  it('does not create elements for unsafe URLs or model HTML', () => {
    render('[run](javascript:alert(1)) <img src=x onerror=alert(1)>');
    expect(host.querySelector('a')).toBeNull();
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('run <img src=x onerror=alert(1)>');
  });
});

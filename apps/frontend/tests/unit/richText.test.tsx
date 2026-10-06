// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { RichText } from '../../src/primitives/RichText';
import { mount } from './sceneHarness';

let host: HTMLDivElement;

function render(text: string, allowLinks = true) {
  host = mount(<RichText allowLinks={allowLinks} segments={[{ text }]} />);
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


  it('keeps links non-navigable by default for live and spoken surfaces', () => {
    render('[docs](https://example.com)', false);
    expect(host.querySelector('a')).toBeNull();
    expect(host.textContent).toBe('docs');
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ImageData } from '../../src/controller/types';
import { ImagePrimitive, imageDataUrl } from '../../src/primitives/ImagePrimitive';

/** A real 1x1 PNG, the one display-actions.json carries. */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mN48ew+AAVnAq5EDgAUAAAAAElFTkSuQmCC';

let host: HTMLDivElement | undefined;
let root: Root | undefined;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

function render(data: ImageData) {
  const element = document.createElement('div');
  document.body.append(element);
  const created = createRoot(element);
  host = element;
  root = created;
  act(() => created.render(<ImagePrimitive data={data} />));
  return element.querySelector('[data-testid="image"]') as HTMLElement;
}

describe('imageDataUrl', () => {
  it('builds the data URL from the format and bytes alone', () => {
    expect(imageDataUrl({ format: 'png', bytes: PNG_1X1 })).toBe(`data:image/png;base64,${PNG_1X1}`);
    expect(imageDataUrl({ format: 'jpeg', bytes: 'AAAA' })).toBe('data:image/jpeg;base64,AAAA');
    expect(imageDataUrl({ format: 'webp', bytes: 'AAAA' })).toBe('data:image/webp;base64,AAAA');
  });

  it('gives no source for anything but a raster format and strict base64', () => {
    for (const format of ['svg', 'svg+xml', 'png;base64,x', 'toString', '__proto__']) {
      expect(imageDataUrl({ format: format as ImageData['format'], bytes: PNG_1X1 }), format).toBeNull();
    }
    for (const bytes of ['', 'https://example.com/x.png', `data:image/png;base64,${PNG_1X1}`, 'AA A', 'AAAA"onerror="x']) {
      expect(imageDataUrl({ format: 'png', bytes }), bytes).toBeNull();
    }
  });
});

describe('ImagePrimitive', () => {
  it('draws one img from the validated fields, with the alt text and caption', () => {
    const figure = render({ format: 'png', bytes: PNG_1X1, alt: 'One paper pixel', title: 'FIGURE' });
    const images = figure.querySelectorAll('img');
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('src')).toBe(`data:image/png;base64,${PNG_1X1}`);
    expect(images[0].getAttribute('alt')).toBe('One paper pixel');
    expect(figure.querySelector('figcaption')?.textContent).toBe('One paper pixelPNG / DECODING');
    expect(figure.dataset.state).toBe('loading');
  });

  it('reads the intrinsic size when the bytes decode', () => {
    const figure = render({ format: 'png', bytes: PNG_1X1, alt: 'a' });
    const img = figure.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 320 });
    Object.defineProperty(img, 'naturalHeight', { value: 200 });
    act(() => { img.dispatchEvent(new Event('load')); });
    expect(figure.dataset.state).toBe('ready');
    expect(figure.querySelector('.image-primitive__size')?.textContent).toBe('PNG / 320 × 200');
    expect(figure.style.getPropertyValue('--image-aspect')).toBe('320 / 200');
  });

  it('says the image is unreadable when the bytes do not decode, and keeps the alt text', () => {
    const figure = render({ format: 'png', bytes: PNG_1X1, alt: 'Broken figure' });
    act(() => { figure.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(figure.querySelector('img')).toBeNull();
    expect(figure.dataset.state).toBe('failed');
    expect(figure.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Broken figure');
    expect(figure.querySelector('.image-primitive__size')?.textContent).toBe('PNG / UNREADABLE');
  });

  it('never draws an img for bytes that are not strict base64', () => {
    const figure = render({ format: 'png', bytes: 'javascript:alert(1)', alt: 'a' });
    expect(figure.querySelector('img')).toBeNull();
    expect(figure.dataset.state).toBe('failed');
  });
});

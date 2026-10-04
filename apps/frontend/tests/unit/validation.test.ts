import { describe, expect, it } from 'vitest';
import fixtures from '../fixtures/display-actions.json';
import {
  MAX_IMAGE_ACTION_BYTES,
  MAX_IMAGE_BYTES,
  assertControllerAction,
  base64DecodedLength,
  decodeBase64Head,
  imageSignatureMatches,
  normalizeProgressValue,
  validateControllerAction,
} from '../../src/controller/validation';

describe('progress value normalization', () => {
  it('normalizes progress values as percentages clamped to 0-100', () => {
    expect(normalizeProgressValue(0)).toBe(0);
    expect(normalizeProgressValue(1)).toBe(1);
    expect(normalizeProgressValue(1.02)).toBe(1.02);
    expect(normalizeProgressValue(65)).toBe(65);
    expect(normalizeProgressValue(100)).toBe(100);
    expect(normalizeProgressValue(-5)).toBe(0);
    expect(normalizeProgressValue(150)).toBe(100);
  });

  // The backend's normalize_progress_value rounds the same way; its test
  // pins the same cases.
  it('rounds to two decimal places', () => {
    expect(normalizeProgressValue(33.333)).toBe(33.33);
    expect(normalizeProgressValue(66.666)).toBe(66.67);
  });

  it('rejects non-finite progress values in show actions', () => {
    for (const val of [NaN, Infinity, -Infinity]) {
      const result = validateControllerAction({
        op: 'show',
        id: 'deploy',
        type: 'progress',
        data: { label: 'DEPLOY', value: val },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/non-finite number/);
      }
    }
    const nonNumber = validateControllerAction({
      op: 'show',
      id: 'deploy',
      type: 'progress',
      data: { label: 'DEPLOY', value: 'not-a-number' as unknown as number },
    });
    expect(nonNumber.ok).toBe(false);
    if (!nonNumber.ok) {
      expect(nonNumber.error).toBe('progress.value must be a finite number');
    }
  });

  it('normalizes the value on validated show actions', () => {
    const result = validateControllerAction({
      op: 'show', id: 'deploy', type: 'progress',
      data: { label: 'DEPLOY', value: 65, text: '65% COMPLETE' },
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok && result.action.op === 'show') {
      expect((result.action.data as { value: number }).value).toBe(65);
    }
  });
});

describe('display protocol validation', () => {
  it('accepts and normalizes all canonical valid fixtures', () => {
    for (const testCase of fixtures.valid) {
      const result = validateControllerAction(testCase.action);
      expect(result.ok, `Expected valid fixture "${testCase.name}" to pass`).toBe(true);
      if (result.ok) {
        expect(result.action, `Normalized action for "${testCase.name}" should match`).toEqual(testCase.normalized);
      }
    }
  });

  it('rejects all canonical invalid fixtures', () => {
    for (const testCase of fixtures.invalid) {
      const result = validateControllerAction(testCase.action);
      expect(result.ok, `Expected invalid fixture "${testCase.name}" to be rejected`).toBe(false);
    }
  });

  it('rejects non-finite mutations (NaN, Infinity, -Infinity)', () => {
    for (const mutation of fixtures.nonFiniteMutations) {
      const cloned = JSON.parse(JSON.stringify(mutation.baseAction));
      let target: any = cloned;
      for (let i = 0; i < mutation.path.length - 1; i++) {
        target = target[mutation.path[i]];
      }
      const lastKey = mutation.path[mutation.path.length - 1];
      if (mutation.value === 'Infinity') {
        target[lastKey] = Number.POSITIVE_INFINITY;
      } else if (mutation.value === '-Infinity') {
        target[lastKey] = Number.NEGATIVE_INFINITY;
      } else if (mutation.value === 'NaN') {
        target[lastKey] = Number.NaN;
      }

      const result = validateControllerAction(cloned);
      expect(result.ok, `Expected non-finite mutation "${mutation.name}" to be rejected`).toBe(false);
    }
  });

  it('assertControllerAction returns action on valid input and throws on invalid input', () => {
    const valid = fixtures.valid[0].action;
    expect(() => assertControllerAction(valid)).not.toThrow();
    const action = assertControllerAction(valid);
    expect(action.op).toBe('show');

    expect(() => assertControllerAction({ op: 'listen', on: true })).toThrow(/unknown operation/);
    expect(() => assertControllerAction({ op: 'show', id: '__runtime/x', type: 'metric', data: { label: 'L', value: '1' } })).toThrow(/reserved identifier namespace/);
  });

  it('validates persistent note anchors and configurable captions', () => {
    const valid = validateControllerAction({
      op: 'show',
      id: 'spike-note',
      type: 'note',
      role: 'secondary',
      data: {
        tag: 'LOOK HERE',
        caption: 'ANNOTATION / VALIDATION SPIKE',
        segments: [{ text: 'Validation turns upward here.' }],
        anchor: { target: 'loss-chart', x: 32, series: 'VAL LOSS' },
      },
    });
    expect(valid).toEqual({
      ok: true,
      action: {
        op: 'show',
        id: 'spike-note',
        type: 'note',
        role: 'secondary',
        data: {
          tag: 'LOOK HERE',
          caption: 'ANNOTATION / VALIDATION SPIKE',
          segments: [{ text: 'Validation turns upward here.' }],
          anchor: { target: 'loss-chart', x: 32, series: 'VAL LOSS' },
        },
      },
    });

    expect(validateControllerAction({
      op: 'show', id: 'bad-note', type: 'note',
      data: { segments: [{ text: 'No target.' }], anchor: { x: 3 } },
    })).toMatchObject({ ok: false });
    expect(validateControllerAction({
      op: 'show', id: 'bad-note', type: 'note',
      data: { segments: [{ text: 'Reserved.' }], anchor: { target: '__runtime/conversation' } },
    })).toMatchObject({ ok: false });
  });
});

// ---- image -----------------------------------------------------------------

/** A real 1x1 PNG (69 bytes), the same one display-actions.json carries. */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mN48ew+AAVnAq5EDgAUAAAAAElFTkSuQmCC';

const SIGNATURES: Record<'png' | 'jpeg' | 'webp', number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff, 0xe0],
  webp: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
};

/** `size` bytes that start with `format`'s signature and are otherwise zero. */
function imageBytes(format: keyof typeof SIGNATURES, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(SIGNATURES[format]);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function imageShow(format: keyof typeof SIGNATURES, size: number) {
  return { op: 'show', id: 'fig', type: 'image', data: { format, bytes: toBase64(imageBytes(format, size)), alt: 'a test image' } };
}

describe('image validation', () => {
  it('measures and decodes strict standard base64 only', () => {
    expect(base64DecodedLength('aGVsbG8=')).toBe(5);
    expect(base64DecodedLength('aGk=')).toBe(2);
    expect(base64DecodedLength('aGV5')).toBe(3);
    expect(base64DecodedLength(PNG_1X1)).toBe(69);
    for (let size = 1; size < 40; size += 1) {
      const bytes = Uint8Array.from({ length: size }, (_, n) => (n * 37) % 256);
      expect(base64DecodedLength(toBase64(bytes)), `${size}`).toBe(size);
      expect([...decodeBase64Head(toBase64(bytes), size)], `${size}`).toEqual([...bytes]);
    }
    for (const bad of ['', 'aGk', 'aGk==', 'aG k=', 'aGVsbG8=\n', '_-8=', `data:image/png;base64,${PNG_1X1}`, 'aG==k=', '====']) {
      expect(base64DecodedLength(bad), JSON.stringify(bad)).toBeNull();
    }
    expect([...decodeBase64Head(PNG_1X1, 8)]).toEqual(SIGNATURES.png);
    expect([...decodeBase64Head('aGk=', 12)]).toEqual([0x68, 0x69]);
  });

  it('sniffs each format by its signature and nothing else', () => {
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const bytes = imageBytes(format, 16);
      expect(imageSignatureMatches(format, bytes), format).toBe(true);
      for (const other of ['png', 'jpeg', 'webp'] as const) {
        if (other !== format) expect(imageSignatureMatches(other, bytes), `${format} as ${other}`).toBe(false);
      }
    }
    expect(imageSignatureMatches('webp', new TextEncoder().encode('RIFF\0\0\0\0WAVE'))).toBe(false);
    expect(imageSignatureMatches('png', Uint8Array.from([0x89, 0x50]))).toBe(false);
  });

  it('accepts a real PNG and keeps only its own fields', () => {
    const action = {
      op: 'show', id: 'fig', type: 'image', role: 'primary',
      data: { format: 'png', bytes: PNG_1X1, alt: 'One paper pixel', title: 'FIGURE / PIXEL', subtitle: 'TEST', context: 'FIGURE', caption: 'IMAGE / PNG' },
    };
    expect(validateControllerAction(action)).toEqual({ ok: true, action });
    expect(validateControllerAction(imageShow('jpeg', 64)).ok).toBe(true);
    expect(validateControllerAction(imageShow('webp', 64)).ok).toBe(true);
  });

  it('refuses what is not raster bytes of the named format', () => {
    const show = (data: Record<string, unknown>) => validateControllerAction({ op: 'show', id: 'fig', type: 'image', data });
    expect(show({ format: 'svg', bytes: toBase64(new TextEncoder().encode("<svg xmlns='x'></svg>")), alt: 'a' }))
      .toEqual({ ok: false, error: 'image.format svg is refused: an image is raster bytes, not markup' });
    expect(show({ format: 'gif', bytes: PNG_1X1, alt: 'a' })).toEqual({ ok: false, error: 'image.format must be one of png, jpeg, webp' });
    expect(show({ format: 'jpeg', bytes: PNG_1X1, alt: 'a' })).toEqual({ ok: false, error: 'image.bytes do not start with the jpeg signature' });
    expect(show({ format: 'png', bytes: `data:image/png;base64,${PNG_1X1}`, alt: 'a' }))
      .toEqual({ ok: false, error: 'image.bytes must be standard base64: the A-Za-z0-9+/ alphabet, padded with =, no data: prefix' });
    expect(show({ format: 'png', bytes: 'iVBORw0K', alt: 'a' })).toEqual({ ok: false, error: 'image.bytes are too short to be a png' });
    expect(show({ format: 'png', bytes: 7, alt: 'a' })).toEqual({ ok: false, error: 'image.bytes must be a base64 string' });
    expect(show({ format: 'png', bytes: PNG_1X1 })).toEqual({ ok: false, error: 'image.alt must be a string' });
    expect(show({ format: 'png', bytes: PNG_1X1, alt: '  ' })).toEqual({ ok: false, error: 'image.alt must not be empty' });
    expect(show({ format: 'png', bytes: PNG_1X1, alt: 'a', width: 64 })).toEqual({ ok: false, error: 'model-controlled layout field is forbidden: width' });
    expect(show({ format: 'png', bytes: PNG_1X1, alt: 'a', zoom: 2 })).toEqual({ ok: false, error: 'unknown field in image data: zoom' });
  });

  it('caps the image at 8 MiB and the action at 12 MiB, for images only', () => {
    expect(validateControllerAction(imageShow('png', MAX_IMAGE_BYTES)).ok).toBe(true);
    expect(validateControllerAction(imageShow('png', MAX_IMAGE_BYTES + 1)))
      .toEqual({ ok: false, error: `image.bytes decode to more than ${MAX_IMAGE_BYTES} bytes` });
    expect(validateControllerAction(imageShow('png', MAX_IMAGE_ACTION_BYTES))).toEqual({ ok: false, error: 'action exceeds size limit' });
    // Only an image show gets the larger cap: the same bytes under another
    // type, or in a note, are held to the general one.
    expect(validateControllerAction({ ...imageShow('png', 100_000), type: 'document' })).toEqual({ ok: false, error: 'action exceeds size limit' });
    expect(validateControllerAction({ op: 'show', id: 'n', type: 'note', data: { segments: [{ text: 'x'.repeat(49_000) }] } }))
      .toEqual({ ok: false, error: 'action exceeds size limit' });
  });
});

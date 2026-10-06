import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { nonFiniteActions } from '../fixtures/nonFiniteActions';
import { fixtures } from '../../src/fixtures/scenes';
import {
  MAX_IMAGE_ACTION_BYTES,
  MAX_IMAGE_BYTES,
  assertControllerAction,
  base64DecodedLength,
  decodeBase64Head,
  imageSignatureMatches,
  isBlank,
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

  // The backend's normalize_progress_value rounds the same way; the corpus
  // pins both (progress_value_rounds, progress_value_rounds_up).
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
  });
});

describe('progress steps', () => {
  const progress = (data: Record<string, unknown>) =>
    validateControllerAction({ op: 'show', id: 'build', type: 'progress', data });

  // The backend's progress_value_of_steps fills the bar the same way. A
  // third done (progress_steps_thirds) and a step without a state kept as
  // sent (progress_steps_fill_the_value) are corpus cases; all done is a full
  // bar.
  it('fills in the value from the steps when the agent gives none', () => {
    const allDone = progress({ label: 'BUILD', steps: [{ label: 'A', state: 'done' }, { label: 'B', state: 'done' }] });
    expect(allDone.ok && allDone.action.op === 'show' && (allDone.action.data as { value: number }).value).toBe(100);
  });
});

// The one whitespace set (docs/display-tool.md, "How the two validators
// agree"): the backend's WHITE_SPACE is held to char::is_whitespace the same
// way, so both lists are Unicode White_Space and nothing else.
describe('blank text', () => {
  it('counts Unicode White_Space, and nothing else, as blank', () => {
    const differ: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (isBlank(ch) !== /^\p{White_Space}$/u.test(ch)) differ.push(`U+${cp.toString(16).toUpperCase()}`);
    }
    expect(differ).toEqual([]);
    expect(isBlank('') && isBlank(' \u0085\u3000')).toBe(true);
    expect(isBlank('\ufeff') || isBlank('\u200b') || isBlank('\u001c')).toBe(false);
  });
});

// What both validators make of an action, the page's validateControllerAction
// among them, is the shared corpus's to pin (validatorCorpus.test.ts). These
// are the actions it cannot hold, and the throwing form of the validator.
describe('display protocol validation', () => {
  // JSON cannot hold a NaN or an infinity (display-actions.json says why),
  // but in-page code can hand the controller one.
  it('refuses non-finite mutations (NaN, Infinity, -Infinity)', () => {
    for (const { name, action } of nonFiniteActions) {
      expect(validateControllerAction(action), name).toEqual({ ok: false, error: 'action contains a non-finite number' });
    }
  });

  it('assertControllerAction returns action on valid input and throws on invalid input', () => {
    const valid = { op: 'show', id: 'chart-1', type: 'chart', data: { series: [{ name: 'CPU', values: [10, 20, 30] }] } };
    expect(() => assertControllerAction(valid)).not.toThrow();
    const action = assertControllerAction(valid);
    expect(action.op).toBe('show');

    expect(() => assertControllerAction({ op: 'listen', on: true })).toThrow('invalid op: expected one of show, hide, focus, say, clear');
    expect(() => assertControllerAction({ op: 'show', id: '__runtime/x', type: 'metric', data: { label: 'L', value: '1' } })).toThrow(/reserved identifier namespace/);
  });

});

// The canonical fixtures (src/fixtures/scenes.ts) load around the validator
// (`loadFixture`), so nothing on the page would notice one an agent could
// not send. Each must be a wire action as written: accepted, and left as it
// is, so a fixture draws the scene its action would. The one exception is
// the conversation's `message`: that object is the page's own (the call's
// spoken lines build it), and no agent sends one.
describe('the canonical fixtures', () => {
  it('are display actions an agent could send, each as the validator leaves it', () => {
    const refused: string[] = [];
    const changed: string[] = [];
    for (const [scene, actions] of Object.entries(fixtures)) {
      actions.forEach((action, index) => {
        if (action.op === 'show' && action.type === 'message') return;
        const result = validateControllerAction(action);
        if (!result.ok) refused.push(`${scene}[${index}]: ${result.error}`);
        else if (!isDeepStrictEqual(result.action, action)) changed.push(`${scene}[${index}]`);
      });
    }
    expect(refused).toEqual([]);
    expect(changed).toEqual([]);
  });
});

// ---- image -----------------------------------------------------------------

/** A real 1x1 PNG (69 bytes), the same one the validator corpus carries. */
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

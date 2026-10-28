import type {
  ImageData,
  ImageFormat,
} from '../types';
import { checkString, checkUnknownKeys, copyFrameText, invalidName, isBlank, isName } from './shared';

/**
 * An image action carries raster bytes, so it gets its own cap: the raw
 * image is at most 8 MiB, and the action around its base64 at most 12 MiB.
 * Every other type keeps the 48,000-byte cap. Both socket links allow
 * 16 MiB frames, so one image action always fits one frame; the reconnect
 * snapshot replays each action as its own frame for the same reason. The
 * corpus pins both numbers on both sides, and scripts/check_hygiene.mjs
 * keeps every other copy (the skill module, the schema, the socket caps) in
 * step with them.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_FORMATS: readonly ImageFormat[] = ['png', 'jpeg', 'webp'];
/** The fewest bytes a signature check needs: WebP's `WEBP` ends at byte 12. */
const IMAGE_SIGNATURE_BYTES = 12;

/** The index of `code` in the standard base64 alphabet, or -1. */
function base64Index(code: number): number {
  if (code >= 65 && code <= 90) return code - 65; // A-Z
  if (code >= 97 && code <= 122) return code - 71; // a-z
  if (code >= 48 && code <= 57) return code + 4; // 0-9
  if (code === 43) return 62; // +
  if (code === 47) return 63; // /
  return -1;
}

/**
 * The decoded length of `text` when it is strict standard base64 -- the
 * `A-Za-z0-9+/` alphabet, a multiple of four characters long, at most two
 * `=` at the end and nothing else (no whitespace, no URL-safe variant) --
 * or null when it is not. Linear in the length; the text itself is never
 * copied, since an image's base64 runs to megabytes.
 */
export function base64DecodedLength(text: string): number | null {
  if (text.length === 0 || text.length % 4 !== 0) return null;
  let padding = 0;
  while (padding < 2 && text.charCodeAt(text.length - 1 - padding) === 61 /* = */) padding += 1;
  const body = text.length - padding;
  for (let i = 0; i < body; i += 1) {
    if (base64Index(text.charCodeAt(i)) < 0) return null;
  }
  return (text.length / 4) * 3 - padding;
}

/** Decodes a prefix of strict base64 to bytes: the first `count` bytes at most. */
export function decodeBase64Head(text: string, count: number): Uint8Array {
  const chars = Math.ceil(count / 3) * 4;
  const head = text.slice(0, chars);
  const out: number[] = [];
  for (let i = 0; i + 3 < head.length; i += 4) {
    const a = base64Index(head.charCodeAt(i));
    const b = base64Index(head.charCodeAt(i + 1));
    const c = head.charCodeAt(i + 2) === 61 ? -1 : base64Index(head.charCodeAt(i + 2));
    const d = head.charCodeAt(i + 3) === 61 ? -1 : base64Index(head.charCodeAt(i + 3));
    out.push(((a << 2) | (b >> 4)) & 0xff);
    if (c >= 0) out.push(((b << 4) | (c >> 2)) & 0xff);
    if (c >= 0 && d >= 0) out.push(((c << 6) | d) & 0xff);
  }
  return Uint8Array.from(out.slice(0, count));
}

/**
 * Whether `bytes` start with `format`'s file signature: PNG
 * `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, WebP `RIFF....WEBP`. The
 * backend's `image_signature_matches` sniffs the same bytes.
 */
export function imageSignatureMatches(format: ImageFormat, bytes: Uint8Array): boolean {
  const at = (index: number, expected: number[]) => expected.every((value, offset) => bytes[index + offset] === value);
  switch (format) {
    case 'png':
      return at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpeg':
      return at(0, [0xff, 0xd8, 0xff]);
    case 'webp':
      return at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50]);
    default:
      return false;
  }
}

// Raster only: the format names the bytes' encoding, and the bytes must
// carry that encoding's signature, so `format` can never label markup (an
// SVG) or anything else as an image. The page builds the only `img` source
// there is from these two fields once they have passed here.
export function validateImageData(data: Record<string, unknown>): { ok: true; data: ImageData } | { ok: false; error: string } {
  const allowed = new Set(['format', 'bytes', 'alt', 'title', 'subtitle', 'context', 'caption']);
  const unknownKey = checkUnknownKeys(data, allowed, 'image data');
  if (unknownKey) return { ok: false, error: unknownKey };

  if (data.format === 'svg' || data.format === 'svg+xml') {
    return { ok: false, error: `${invalidName('image.format', IMAGE_FORMATS)} (svg is refused: an image is raster bytes, not markup)` };
  }
  if (!isName(data.format, IMAGE_FORMATS)) {
    return { ok: false, error: invalidName('image.format', IMAGE_FORMATS) };
  }
  const format = data.format;

  if (typeof data.bytes !== 'string') return { ok: false, error: 'image.bytes must be a base64 string' };
  const decodedLength = base64DecodedLength(data.bytes);
  if (decodedLength === null) {
    return { ok: false, error: 'image.bytes must be standard base64: the A-Za-z0-9+/ alphabet, padded with =, no data: prefix' };
  }
  if (decodedLength > MAX_IMAGE_BYTES) {
    return { ok: false, error: `image.bytes decode to more than ${MAX_IMAGE_BYTES} bytes` };
  }
  if (decodedLength < IMAGE_SIGNATURE_BYTES) {
    return { ok: false, error: `image.bytes are too short to be a ${format}` };
  }
  if (!imageSignatureMatches(format, decodeBase64Head(data.bytes, IMAGE_SIGNATURE_BYTES))) {
    return { ok: false, error: `image.bytes do not start with the ${format} signature` };
  }

  const altErr = checkString(data.alt, 256, 'image.alt');
  if (altErr) return { ok: false, error: altErr };
  if (isBlank(data.alt as string)) return { ok: false, error: 'image.alt must not be empty' };

  const result: ImageData = { format, bytes: data.bytes, alt: data.alt as string };
  const err = copyFrameText(data, result, 'image');
  if (err) return { ok: false, error: err };
  return { ok: true, data: result };
}

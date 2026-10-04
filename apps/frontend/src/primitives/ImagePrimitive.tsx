import { useMemo, useState, type CSSProperties } from 'react';
import type { ImageData, ImageFormat } from '../controller/types';
import { base64DecodedLength } from '../controller/validation';

// The only image types the page draws, by the format the validators
// accepted. SVG is not one: it is markup, and markup is never an img source.
const MIME_TYPES: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * The `img` source for a validated image: a data URL the page builds from
 * the format and the base64 bytes, and nothing else. A format outside the
 * raster set, or bytes that are not strict base64, give no source at all.
 */
export function imageDataUrl(data: Pick<ImageData, 'format' | 'bytes'>): string | null {
  const mime = Object.prototype.hasOwnProperty.call(MIME_TYPES, data.format) ? MIME_TYPES[data.format] : undefined;
  if (!mime || typeof data.bytes !== 'string' || base64DecodedLength(data.bytes) === null) return null;
  return `data:${mime};base64,${data.bytes}`;
}

type Decode = { state: 'loading' } | { state: 'ready'; width: number; height: number } | { state: 'failed' };

/**
 * A raster figure on the black field: contained, never cropped or zoomed,
 * with its alt text and intrinsic size on the caption line at the bottom
 * edge. The page reads the size when the bytes decode; nothing sends it.
 */
export function ImagePrimitive({ data, focused = false }: { data: ImageData; focused?: boolean }) {
  const src = useMemo(() => imageDataUrl(data), [data]);
  const [decode, setDecode] = useState<{ src: string | null; result: Decode }>({ src, result: { state: 'loading' } });
  // A new image starts loading again; the result of the old one is dropped.
  const result: Decode = decode.src === src ? decode.result : { state: 'loading' };
  const failed = src === null || result.state === 'failed';
  const size = result.state === 'ready' ? `${result.width} × ${result.height}` : failed ? 'UNREADABLE' : 'DECODING';
  return (
    <figure
      className={`image-primitive${focused ? ' image-primitive--focused' : ''}`}
      data-testid="image"
      data-state={failed ? 'failed' : result.state}
      // The decoded proportions, for a slot that sizes the figure to its
      // content (the aux row); a slot that fills its space ignores them.
      style={result.state === 'ready' ? ({ '--image-aspect': `${result.width} / ${result.height}` } as CSSProperties) : undefined}
    >
      <div className="image-primitive__field">
        {src !== null && result.state !== 'failed' ? (
          <img
            className="image-primitive__img"
            src={src}
            alt={data.alt}
            decoding="async"
            draggable={false}
            onLoad={(event) => setDecode({ src, result: { state: 'ready', width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight } })}
            onError={() => setDecode({ src, result: { state: 'failed' } })}
          />
        ) : (
          <div className="image-primitive__empty tech micro" role="img" aria-label={data.alt}>IMAGE / UNREADABLE</div>
        )}
      </div>
      <figcaption className="image-primitive__caption tech micro">
        <span className="image-primitive__alt">{data.alt}</span>
        <span className="image-primitive__size">{`${data.format.toUpperCase()} / ${size}`}</span>
      </figcaption>
    </figure>
  );
}

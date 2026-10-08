// The call runtime reports failures to the caller as plain status text. These
// keep that text consistent across the socket, recorder, and playback paths.

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a media element's `error` holds, as `MediaError` names it. */
const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: "MEDIA_ERR_ABORTED",
  2: "MEDIA_ERR_NETWORK",
  3: "MEDIA_ERR_DECODE",
  4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
};

/**
 * Names what a media element refused. A `MediaError` is not an `Error`: it
 * carries a numeric `code`, and `errorName` would call every one of them an
 * unknown error.
 */
export function mediaErrorName(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "number" && MEDIA_ERROR_NAMES[code])
    return MEDIA_ERROR_NAMES[code];
  return errorName(error);
}

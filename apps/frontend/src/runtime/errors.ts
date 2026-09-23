// The call runtime reports failures to the caller as plain status text. These
// keep that text consistent across the socket, recorder, and playback paths.

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

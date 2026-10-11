// The call's status line: what was said last, and the errors still standing.
//
// Five sources report status, and each says whether it reports an error: the
// call socket's link (`connection`), the line controls and transfers
// (`line`), the caller's turn from clip to reply (`turn`), playback, and the
// microphone (push-to-talk and hands-free). An error stands until its own
// source says something that is not one, or withdraws it: playback's idle
// line takes down a pause playback reported, not a server error or a lost
// connection (#354). The page draws the newest error still standing; with
// none it draws nothing, and the newest status is only text.

export type StatusSource =
  | "connection"
  | "line"
  | "turn"
  | "playback"
  | "microphone";

/** What the page is given: the newest standing error, or the newest status. */
export interface StatusView {
  status: string;
  statusError: boolean;
}

export class StatusLine {
  /** Each source's standing error; a Map keeps them oldest first. */
  private readonly errors = new Map<StatusSource, string>();

  /** `said` is the status shown before anything has reported one. */
  constructor(private said: string) {}

  /** The newest status said, from any source, error or not. */
  get latest(): string {
    return this.said;
  }

  /**
   * `source` says `text`. An error becomes the source's standing error, the
   * newest one; a status that is not one takes the source's error down.
   */
  say(source: StatusSource, text: string, error: boolean): StatusView {
    this.said = text;
    this.errors.delete(source);
    if (error) this.errors.set(source, text);
    return this.view();
  }

  /** `source`'s error is over, and it has nothing to say. */
  withdraw(source: StatusSource): StatusView {
    this.errors.delete(source);
    return this.view();
  }

  private view(): StatusView {
    let newest: string | null = null;
    for (const text of this.errors.values()) newest = text;
    return newest === null
      ? { status: this.said, statusError: false }
      : { status: newest, statusError: true };
  }
}

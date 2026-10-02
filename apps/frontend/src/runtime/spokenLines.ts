// When each spoken line is heard (#112).
//
// A line the agent speaks reaches the page twice: as text (a `spoken` frame,
// or a voiced `reply`) and as audio, and the two travel apart. The text of a
// `speak()` line comes once its audio has been sent, while earlier lines may
// still be playing; a reply's text comes before its audio. Each line names the
// utterance that voices it (`sequence`, as on `audio_start`), and this holds
// the line until playback reaches that utterance. The caption then shows the
// line being heard, and lines queued behind it wait their turn.
//
// Playback reaches an utterance when its turn to play comes, or when it is
// dropped and will never play (`AudioPlayback`'s `onUtterance`). A line with
// no utterance is heard as soon as the lines before it are.

/** A line the caller has started to hear. */
export interface HeardLine {
  text: string;
  /** The route that spoke: `operator` or a project id. */
  route?: string;
  /**
   * Where the line falls among the lines heard: its utterance's sequence, or
   * for a line without audio, the order of the line heard before it. A line
   * whose text came after a later line was already heard has a lower order
   * than that line, and belongs before it.
   */
  order: number;
}

interface WaitingLine {
  text: string;
  route?: string;
  sequence?: number;
}

export class SpokenLines {
  /** The latest utterance playback has reached. */
  private reached = Number.NEGATIVE_INFINITY;
  /** The order of the latest line heard. */
  private heard = Number.NEGATIVE_INFINITY;
  /** Lines whose utterance has not been reached, in utterance order. */
  private waiting: WaitingLine[] = [];
  private readonly onHeard: (line: HeardLine) => void;

  constructor(onHeard: (line: HeardLine) => void) {
    this.onHeard = onHeard;
  }

  /** A spoken line arrived; `sequence` names the utterance that voices it. */
  add(line: { text: string; route?: string }, sequence?: number): void {
    const waiting: WaitingLine = { text: line.text, route: line.route, sequence };
    // Two lines' texts can arrive out of their audio's order; their
    // utterances settle it. A line without audio keeps its arrival place.
    const before =
      sequence === undefined
        ? -1
        : this.waiting.findIndex(
            (other) => other.sequence !== undefined && other.sequence > sequence,
          );
    if (before < 0) this.waiting.push(waiting);
    else this.waiting.splice(before, 0, waiting);
    this.release();
  }

  /** Playback reached utterance `sequence`. */
  reach(sequence: number): void {
    this.reached = Math.max(this.reached, sequence);
    this.release();
  }

  /**
   * Playback retired everything it held (a new leg, a rescue, a reconnect),
   * so no waiting line's audio will play. They are heard now, in order, and
   * the utterance count starts over with the next audio.
   */
  retire(): void {
    this.reached = Number.POSITIVE_INFINITY;
    this.release();
    this.reached = Number.NEGATIVE_INFINITY;
  }

  /** The transcript was replaced (`history`): nothing is waiting any more. */
  clear(): void {
    this.waiting = [];
    this.reached = Number.NEGATIVE_INFINITY;
    this.heard = Number.NEGATIVE_INFINITY;
  }

  private release(): void {
    while (this.waiting.length > 0) {
      const next = this.waiting[0];
      if (next.sequence !== undefined && next.sequence > this.reached) return;
      this.waiting.shift();
      const order = next.sequence ?? this.heard;
      this.heard = Math.max(this.heard, order);
      this.onHeard({ text: next.text, route: next.route, order });
    }
  }
}

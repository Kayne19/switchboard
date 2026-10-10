// What playback says on the status line.
//
// Every status playback reports goes through here, and each says whether it
// is an error (`CallRuntime.setStatus`). A pause or a blocked `play()` is an
// error the caller has to act on; the clip sounding again takes it down.

import { errorName, mediaErrorName } from "./errors";

export class PlaybackStatus {
  private readonly idleText: string;
  private readonly onStatus: (text: string, error: boolean) => void;
  /**
   * Set while a pause or a blocked `play()` is on screen as an error the
   * caller has to act on. The clip sounding again takes it down (`resumed`):
   * nothing else would until the next turn's status, and a stream that
   * recovered left the red card over the conversation (#260). It belongs to
   * the status line, not to a clip: a blocked replay goes back to the queue,
   * and the clip a tap then starts is a new one.
   */
  private awaitingTap = false;

  constructor(
    idleText: string,
    onStatus: (text: string, error: boolean) => void,
  ) {
    this.idleText = idleText;
    this.onStatus = onStatus;
  }

  /** Nothing is left to play. */
  idle(): void {
    this.say(this.idleText, false);
  }

  /**
   * Something outside the page stopped the element: an iPad's audio session
   * handed to another app or to the microphone, a lock-screen control. It is
   * an error the caller has to act on, so it is reported as one.
   */
  paused(finishing: boolean): void {
    this.say(
      finishing
        ? "Audio finishing — tap or click anywhere on this page to continue."
        : "Audio paused — tap or click anywhere on this page to resume.",
      true,
    );
    this.awaitingTap = true;
  }

  /** Playback was blocked: the next gesture plays it (`handleGesture`). */
  blocked(error: unknown): void {
    this.say(
      "Audio blocked by the browser — tap or click anywhere on this page once, then it will play (" +
        errorName(error) +
        ").",
      true,
    );
    this.awaitingTap = true;
  }

  /**
   * A clip sounds again after a pause or a block was reported: the one
   * place either path withdraws that error.
   */
  resumed(): void {
    if (!this.awaitingTap) return;
    this.say("Audio resumed.", false);
  }

  /**
   * The element refused the clip. Saying so is the point: a browser that
   * cannot decode what was sent used to drop every utterance in silence,
   * with nothing on screen for the caller to report (#189).
   */
  refused(error: MediaError): void {
    this.say("Audio failed to play (" + mediaErrorName(error) + ").", true);
  }

  /** A clip stopped advancing for `ms`: before any sound, or partway. */
  silent(heard: boolean, ms: number): void {
    this.say(
      heard
        ? "Audio stopped partway and did not resume (nothing played for " +
            ms +
            "ms)."
        : "Audio started but produced no sound (nothing played in " +
            ms +
            "ms).",
      true,
    );
  }

  streamFailed(error: unknown): void {
    this.say(
      "Streaming audio failed; using the complete replay (" +
        mediaErrorName(error) +
        ").",
      true,
    );
  }

  /** A new leg: no pause or block on screen is waiting for a tap any more. */
  newLeg(): void {
    this.awaitingTap = false;
  }

  private say(text: string, error: boolean): void {
    // Whatever is said now replaces the pause or block on screen.
    this.awaitingTap = false;
    this.onStatus(text, error);
  }
}

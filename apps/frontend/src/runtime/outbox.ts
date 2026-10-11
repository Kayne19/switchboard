// Completed voice clips the backend has not yet finished with.
//
// A clip stays here, oldest first, until its transcript, an error naming it,
// or a history entry carrying its id arrives. `sent` means only "attempted on
// this socket"; reconnect clears it and the clip is retransmitted under the
// same id. The backend answers a clip it already settled with the verdict it
// sent, which a tab that was disconnected at the time never heard. That is
// what keeps a backend restart from destroying the only copy of something
// the caller said, and a dropped socket from leaving a clip unanswered.

import type { Adoption } from "./callIdentity";

export const MAX_OUTBOX_CLIPS = 16;
export const MAX_OUTBOX_BYTES = 128 * 1024 * 1024;

export interface Clip {
  id: string;
  audio: Blob;
  mime: string;
  created: number;
  epoch: number;
  // The candidate route the browser was watching when recording started.
  // On the epoch of that candidate's adoption, such a clip is re-stamped to
  // it and resubmitted instead of being discarded.
  transferEra?: string;
  sent: boolean;
  // Set once the whole clip has gone out on some socket. Unlike `sent`, a
  // reconnect does not clear it: the server keeps the first stamp it saw for
  // a clip id, so from then on the clip belongs to that stamp for good.
  transmitted?: boolean;
  accepted?: boolean;
  streaming?: boolean;
  chunks?: Blob[];
}

export class ClipOutbox {
  private clips: Clip[] = [];
  private bytes = 0;

  get size(): number {
    return this.clips.length;
  }

  /** Adds a clip, or returns false when the outbox is already full. */
  add(clip: Clip): boolean {
    if (
      this.clips.length >= MAX_OUTBOX_CLIPS ||
      this.bytes + clip.audio.size > MAX_OUTBOX_BYTES
    ) {
      return false;
    }
    this.clips.push(clip);
    this.bytes += clip.audio.size;
    return true;
  }

  find(id: unknown): Clip | undefined {
    return this.clips.find((clip) => clip.id === id);
  }

  firstUnsent(): Clip | undefined {
    return this.clips.find((clip) => !clip.sent);
  }

  retain(keep: (clip: Clip) => boolean): void {
    this.clips = this.clips.filter(keep);
    this.bytes = this.clips.reduce((total, clip) => total + clip.audio.size, 0);
  }

  remove(id: unknown): void {
    this.retain((clip) => clip.id !== id);
  }

  markAllUnsent(): void {
    for (const clip of this.clips) clip.sent = false;
  }

  /**
   * The line moved to `epoch`. The clips stamped with another epoch that
   * never went out are dropped, and their count returned: the server never
   * saw them, so the page tells the caller. A clip that did go out stays
   * until the server answers for it: after a reconnect it is sent again
   * under the stamp it went out with, and the server replies with the
   * verdict the tab missed.
   */
  retireOtherEpochs(epoch: number): number {
    const before = this.clips.length;
    this.retain((clip) => clip.epoch === epoch || clip.transmitted === true);
    return before - this.clips.length;
  }

  /**
   * The epoch of `adoption` arrived. A clip recorded while the browser knew
   * a transfer was in flight is addressed to the leg being started, not to
   * the leg that was live, so the ones for this leg are re-stamped to its
   * epoch and the flush that follows delivers them. Returns how many. Any
   * other stale clip is left to be discarded: that is the server's safety
   * invariant for speech begun before the transfer was known.
   *
   * Only the adoption of the very candidate the clip was recorded for
   * counts: the same route, one epoch on from the stamp the clip was
   * recorded under. A hangup while connecting moves the epoch the same way
   * an adoption does, and words addressed to the incoming leg must not run
   * on the operator (#70).
   *
   * A clip that already went out is not re-stamped. The server holds it
   * under the stamp it went out with and drops it with a `stale_epoch` error
   * that names it, which is how the caller hears about it; sent again under
   * a new stamp it would be taken as the clip the server already has.
   */
  carry(adoption: Adoption): number {
    let carried = 0;
    for (const clip of this.clips) {
      if (
        clip.transferEra === adoption.route &&
        clip.epoch + 1 === adoption.generation &&
        !clip.transmitted
      ) {
        clip.epoch = adoption.generation;
        carried += 1;
      }
    }
    return carried;
  }

  /**
   * The candidate on `route` ended without being adopted: the clips recorded
   * for it were never addressed to a leg the caller reached, and stay on the
   * stamp they were recorded under.
   */
  unmark(route: string): void {
    for (const clip of this.clips) {
      if (clip.transferEra === route) clip.transferEra = undefined;
    }
  }
}

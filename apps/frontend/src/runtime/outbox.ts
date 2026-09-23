// Completed voice clips the backend has not yet finished with.
//
// A clip stays here, oldest first, until its transcript (or a history entry
// carrying its id) arrives. `sent` means only "attempted on this socket";
// reconnect clears it and the clip is retransmitted under the same id, which
// the backend deduplicates. That is what keeps a backend restart from
// destroying the only copy of something the caller said.

export const MAX_OUTBOX_CLIPS = 16;
export const MAX_OUTBOX_BYTES = 128 * 1024 * 1024;

export interface Clip {
  id: string;
  audio: Blob;
  mime: string;
  created: number;
  epoch: number;
  // The candidate route the browser was watching when recording started.
  // On the epoch that ends a transfer, such a clip is re-stamped to the new
  // generation and resubmitted instead of being discarded.
  transferEra?: string;
  sent: boolean;
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

  get all(): readonly Clip[] {
    return this.clips;
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
}

// A clip recorded while the browser knew a transfer was in flight is
// addressed to the leg being started, not to the leg that was live. Re-stamp
// those to the new generation so the flush that follows delivers them. Any
// other stale clip is left to be discarded: that is the server's safety
// invariant for speech begun before the transfer was known.
export function restampStaleClips(
  clips: readonly Clip[],
  generation: number,
): number {
  let resubmitted = 0;
  for (const clip of clips) {
    if (clip.epoch !== generation && clip.transferEra) {
      clip.epoch = generation;
      resubmitted += 1;
    }
  }
  return resubmitted;
}

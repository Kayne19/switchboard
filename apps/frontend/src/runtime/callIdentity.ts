// The call's identity as the page holds it: the epoch the server last
// announced, the candidate leg it was told is starting, and the adoption whose
// epoch has not come yet. It is a value. `follow` gives the next one for a
// server message and says what that message means for the clips the page
// holds and for the audio playing; `CallRuntime` holds the current one, writes
// it only through `follow`, and stamps every take, clip, typed turn and line
// control with it (rule 7 in docs/architecture.md).
//
// The rule it keeps is #70's (docs/concurrency-and-test-hazards.md): a take
// recorded while a candidate starts is marked for that candidate's route, and
// is carried to the new leg only on the epoch that candidate's `adopted`
// notice names. A rollback or a rescue strips the mark. The phase x event
// table in tests/unit/callIdentity.test.ts pins each row through CallRuntime.

import type {
  CandidateClearedMessage,
  CandidateMessage,
  EpochMessage,
  ReplyMessage,
  StatusMessage,
} from "../protocol";

/** A candidate leg that became the leg on the line: its route, and the epoch it was adopted at. */
export interface Adoption {
  route: string;
  generation: number;
}

export interface CallIdentity {
  /**
   * The server's turn epoch, as last announced. A take is stamped with it
   * when its recording starts, so speech begun before a transfer is
   * discarded rather than delivered to the leg that replaced it.
   */
  readonly epoch: number;
  /**
   * The route of the candidate leg the page was told is starting, or null.
   * A take begun while it is set is marked for that leg.
   */
  readonly candidate: string | null;
  /**
   * The candidate the server said was adopted, until the next epoch. Only the
   * epoch it names carries the marked clips along.
   */
  readonly adoption: Adoption | null;
}

/** Before the server's first `epoch`. */
export const NO_EPOCH_YET: CallIdentity = { epoch: 0, candidate: null, adoption: null };

/** The server messages that move the identity. */
export type IdentityMessage =
  | EpochMessage
  | CandidateMessage
  | CandidateClearedMessage
  | ReplyMessage
  | StatusMessage;

export interface IdentityStep {
  readonly identity: CallIdentity;
  /**
   * An `epoch` that completes this adoption: the unsent clips marked for its
   * route, one epoch behind it, are re-stamped to it. Null otherwise.
   */
  readonly carry: Adoption | null;
  /**
   * A candidate that ended without adoption: the clips marked for this route
   * lose the mark. Null otherwise.
   */
  readonly unmark: string | null;
  /**
   * An `epoch` the page expected: the one it holds again (a return to the
   * operator) or the awaited adoption's. On a live line the goodbye already
   * playing may finish. False for anything else: a hangup, a rescue, or any
   * other message.
   */
  readonly expected: boolean;
}

/** What the page holds after `message`, and what the change means. */
export function follow(identity: CallIdentity, message: IdentityMessage): IdentityStep {
  switch (message.type) {
    case "epoch": {
      // A hangup while connecting moves the epoch too; only the epoch the
      // candidate was adopted at carries its clips along.
      const carry =
        identity.adoption?.generation === message.generation ? identity.adoption : null;
      return {
        identity: { epoch: message.generation, candidate: null, adoption: null },
        carry,
        unmark: null,
        expected: carry !== null || message.generation === identity.epoch,
      };
    }
    case "candidate":
      // Speech recorded from here until the epoch moves is addressed to the
      // starting leg, not to the one on screen.
      return moved({
        ...identity,
        candidate: message.route && message.route !== "operator" ? message.route : null,
      });
    case "candidate_cleared":
      // The epoch that follows an adoption is the new leg's, and speech
      // recorded for it is carried along. A rollback leaves the epoch where it
      // was, and a rescue moves it exactly as an adoption would, so neither
      // may carry anything.
      if (message.reason === "adopted")
        return moved({
          ...identity,
          candidate: null,
          adoption: { route: message.route, generation: message.generation },
        });
      return {
        identity: { ...identity, candidate: null, adoption: null },
        carry: null,
        unmark: message.route,
        expected: false,
      };
    case "reply":
    case "status":
      // A settled status or a reply ends the mark for later takes, though no
      // notice ended the candidate. The adoption still waits for its epoch.
      return moved({ ...identity, candidate: null });
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}

/** A move that touches no clip and is no epoch. */
function moved(identity: CallIdentity): IdentityStep {
  return { identity, carry: null, unmark: null, expected: false };
}

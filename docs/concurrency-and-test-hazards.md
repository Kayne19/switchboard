# Concurrency and test hazards

Three problems in this tree share one shape: something true at the moment work
starts is no longer true at the moment it lands. They are written down together
because each was found only after the one before it was fixed, and because the
last of them is still open.

## The turn epoch

A caller's speech travels through four stages: the browser uploads a clip, the
server hands it to the STT sidecar, text comes back, and the server acts on that
text — either steering the live agent or queuing a new turn.

Independently, a page transfer can land at any time. It performs a *rescue*: it
aborts in-flight work and swaps the live leg. If speech captured before the
rescue is acted on after it, the caller's words run against a project they were
never addressed to. That is the failure this design exists to prevent.

The coordinator's leg generation is the guard. Every rescue bumps it, and work
carrying a stale value is discarded rather than acted on. The bump happens in
`Coordinator::begin_rescue`, while resource cancellation and delivery commit
re-check it at their short linearization points: turn dispatch,
`deliver_turn_if_current`, `deliver_page_reply_if_current`, and
`synthesize_reply_if_current`. `operation_transition` still protects the
async resource handoff; it is not a second lifecycle authority.

Two properties are load-bearing and easy to break by accident:

- **The epoch is stamped when a clip is accepted, not when its transcript comes
  back.** The sidecar is a separate process, and a transfer can land inside that
  round trip. An epoch read after transcription reads the post-rescue value and
  therefore always looks current — the check cannot fail. `Clip` carries the
  value from `handle_audio_frame` for this reason.
- **Both things the server can do with a transcript are gated.** Steering the
  live agent counts as acting on it just as much as queuing a turn does. The
  check sits under the `active_session` guard because a rescue bumps the epoch
  *before* it takes that lock to close the session, so a steer that wins the
  lock still observes the new value. If the rescue wins instead, the session is
  already closed and the clip falls through to the queue path, where the epoch
  check discards it.

The turn worker re-checks the epoch again before dispatching. That is deliberate
redundancy, not duplication.

**The stamp now comes from the browser.** Arrival is still later than capture:
a clip recorded before a transfer but uploaded after it would be stamped on
arrival and look current. So the server announces the epoch — as an
`{"type":"epoch"}` event whenever `cancel_active_operations` bumps it, and in the
WebSocket snapshot so a reconnecting tab is not left holding a retired value —
and the browser stamps each clip with whatever it held when *recording started*.
`clipHeader` in `apps/frontend/src/protocol.ts` puts it on the wire; the server prefers it and
falls back to arrival time for a client that sends none, so an older tab keeps
working exactly as before.

A client cannot use this to reach a leg it should not: the epoch is only ever
learned from the server, and any value that does not match the current one gets
the clip dropped. A wrong number can discard speech, never misroute it.

What this trades away: speech that started before the browser learned of a
change is discarded, and the caller has to repeat it. Browser-initiated bumps
(`/hangup`, `/connect`, `/thinking` off the operator leg) are one message
delivery away, so the tab is already awake and waiting on that exchange.

An agent-initiated `transfer_to_project` bumps the epoch at *adoption*, not at
startup: the generation stays put while the new leg is starting, and the new
epoch is announced (with the status) the moment the leg is live.
That leaves a window — ssh, process start, intro turn — in which the browser
still holds the old epoch. The server closes it by emitting a
`{"type":"candidate"}` event when a candidate leg begins and
`{"type":"candidate_cleared"}` when adoption, rollback, or rescue ends it. The
browser marks clips recorded while a candidate is in flight as addressed to the
incoming leg and re-stamps them to the new epoch when the `epoch` event
arrives, so the caller's words reach the new leg as a fresh turn. Any clip
without that mark keeps the discard: a wrong number can only lose speech,
never misroute it.

### One scene reset per leg

"The moment the leg is live" has two answers, and both used to announce it.
Candidate promotion adopts the leg as soon as the incoming agent streams its
first text or acts, which in practice is every transfer. The route callback
fires later, once the PBX has finished the intro turn. Each cleared the display
projection and sent an `epoch`, so the second one landed on a leg that was
already talking: it wiped the first drawing, reset the confirmation watermark
under it, and made the browser drop the audio of the new agent's first words
(`resetForGeneration`). The browser also treated every `epoch` as a reason to
unmount the conversation, so the caller watched conversation, idle page,
conversation (issue #22).

`LegAnnouncer` in `apps/backend/src/api.rs` owns both paths now. The scene is
reset once per leg, keyed by route and generation, by whichever announcement
gets there first; the later one only restates the status. Route is part of the
key because a return to the operator keeps the generation and must still clear
the project's scene. Promotion holds the display gate from adoption until the
`epoch` is published, so a display from the new leg cannot be applied, and then
wiped, ahead of its own reset.

On the browser side an `epoch` drops what the old leg put on screen (its
objects, speech, focus, activity, and any view it asked for) and keeps the
conversation, which belongs to the call. The route label on it changes when the
status arrives. A reconnect is followed by the history snapshot, which replaces
the transcript and hides the conversation if the server has none.

## Delivery and picker ordering

WebSocket registration happens before the snapshot is read. A single writer owns
the sink and sends `epoch`, `status`, `history`, and the optional diagram before
releasing live events queued during that read. Reader replies such as pong,
accepted/error frames, and audio metadata use that same writer, so a reconnect
cannot interleave a live frame into its snapshot. A bounded connection queue
retires a lagging socket rather than blocking the call.

Audio reservations are generation-stamped and sequenced across mid-turn speech
and settled replies. Cancellation releases a slot so a stale TTS result cannot
wedge later speech. The browser drops queued/playing audio and outbox clips on a
new epoch. A stale clip receives an ID-bearing `stale_epoch` error and is removed
from the outbox rather than retried forever.

The route/model/thinking pickers serialize their HTTP operations. A failed picker
request restores the value that was selected before that request, unless a newer
status snapshot has already invalidated it; this prevents late failures from
rewriting a newer leg selection.

## `ETXTBSY` when tests write their own executables

Several tests need a fake `ssh` or a fake `pi`. They write a small shell script,
mark it executable, and hand the path to the code under test.

Linux refuses to execute a file that any process holds open for writing. Tests
run on many threads inside one process, and spawning a child forks — which
duplicates every open descriptor. A child forked while one of these scripts is
still being written inherits a writable descriptor to it and keeps that copy
until it execs. During that window the script cannot be run, and the code under
test fails with `Text file busy` (`ETXTBSY`, errno 26).

Close-on-exec does not help: it closes the descriptor when the child execs, and
the gap between the fork and that moment is exactly the window.

Measured before the fix: three failing runs in ten, and one in ten with the
newest test skipped, so it long predated that test. More concurrent process
spawning makes it fire more often.

`write_executable_script` in `apps/backend/src/pi_client.rs` is the fix. It writes the script,
chmods it, then execs it once with a `--switchboard-exec-probe` argument that the
script answers by exiting immediately, and returns only when that probe succeeds.
A successful probe proves no process holds a write descriptor; the file is never
written again afterwards, so no new holder can appear and every later exec is
safe.

Retrying the operation under test would have been the wrong fix. It re-runs side
effects and can swallow a real failure as one more flake. This version keeps
failures legible:

- only `ETXTBSY` is retried, and every other spawn error fails immediately with
  the path and the underlying error;
- a malformed script is caught by the probe's exit status during setup, not later
  as a confusing failure inside the code under test;
- the wait is deadline-bounded, so a genuinely stuck file fails loudly instead of
  hanging;
- no production code is involved, so a real `ETXTBSY` in production still
  surfaces.

All fake executables must go through this helper. It owns the `#!/bin/sh`
preamble so that no caller can forget the probe guard.

## A broken pipe reported instead of the error that caused it

With the `ETXTBSY` noise gone, a second failure appeared at roughly two runs in
thirty. It was not a flake.

`SttAdapter::transcribe` wrote the clip to the sidecar's stdin and propagated any
write error. A sidecar that fails fast — bad flags, a missing model — exits
without reading, so the write fails with `BrokenPipe`, and *that* was returned
while the sidecar's stderr was drained and discarded. The caller was told
`could not send audio to STT sidecar: Broken pipe` instead of why the sidecar
actually failed.

The test caught it only occasionally because a four-byte payload usually fits the
pipe buffer. Real clips are megabytes, so in production this was the ordinary
path for a sidecar that rejects its input, not a rare one.

A broken pipe on stdin is now treated as non-fatal: the child's exit status and
stderr are the authoritative diagnosis, and any other write error still
propagates. The regression test sends a megabyte to a sidecar that never reads,
which guarantees the broken pipe rather than leaving it to chance.

The general rule: when a downstream write fails because an upstream process
already failed, report the upstream failure. The write error is a symptom.

Extension staging follows the same rule. It lives in prewarm now
(`run_artifact_job` in `apps/backend/src/prewarm.rs`): the write of the
extension to the remote's stdin is not what decides, the exit status and stderr
are. That matters beyond log quality. A remote that stops reading early but
*succeeds* used to be reported as a staging failure and fell back to the
sentinel. `staging_survives_a_remote_that_stops_reading_before_the_extension_ends`
in `apps/backend/tests/test_prewarm.rs` covers exactly that, by sending a
megabyte to a remote that reads sixteen bytes and exits zero.

### Why the toolchain is pinned

CI used to install whatever `stable` currently was, which could be several
releases ahead of the toolchain on a development box. Clippy gains lints in
that gap, and `-D warnings` turns each new one into a build failure on code
nobody touched. The first CI run here failed exactly that way:
`unnecessary_sort_by`, flagged by clippy 1.97 and unknown to the 1.92 that had
just passed locally.

`rust-toolchain.toml` now pins the version for both, so a local run and CI reach
the same verdict, and an upgrade is a deliberate, reviewable change to that file
rather than a surprise on an unrelated pull request.

## Prewarm SSH transport, flock, and deterministic control paths

Prewarm relies on cross-process `flock` locking and OpenSSH control sockets under `SWITCHBOARD_STATE_DIR`:

- Lock files (`<state_dir>/ssh/locks/<host hash>.lock`) and socket files (`<state_dir>/ssh/control/<host hash>.sock`) are deterministic per canonical host (`canonical_host()`). The host hash is the first 16 hex digits of the host's SHA-256: a full digest overflowed the 108-byte `sun_path` once ssh appended its suffix (see `host_hash`).
- Stale control socket removal occurs ONLY AFTER acquiring the kernel `flock` on the lock file.
- Only the process that created the master connection initiates master exit (`-O exit`) or child termination on shutdown; an adopting process releases its `flock` lock without signaling or deleting a sibling's live control socket.
- Prepare exit status (zero, nonzero, or timeout) is a terminal report snapshot; nonzero or timed-out prepare outputs remain launchable and are never retried.
- Injected SSH program options (`SshClientOptions`) carry `ControlMaster=no` and explicit `ControlPath` parameters to prevent client processes from becoming masters.

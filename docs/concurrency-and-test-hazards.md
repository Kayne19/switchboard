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

`turn_generation` in `src/api.rs` is the guard. Every rescue bumps it, and work
carrying a stale value is discarded rather than acted on. The bump happens in
`cancel_active_operations` under `operation_transition`, and every consumer
re-checks under that same guard: turn dispatch, `deliver_turn_if_current`,
`deliver_page_reply_if_current`, and `synthesize_reply_if_current`.

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
`clipHeader` in `web/protocol.ts` puts it on the wire; the server prefers it and
falls back to arrival time for a client that sends none, so an older tab keeps
working exactly as before.

A client cannot use this to reach a leg it should not: the epoch is only ever
learned from the server, and any value that does not match the current one gets
the clip dropped. A wrong number can discard speech, never misroute it.

What this trades away: an utterance begun after a transfer but before the browser
learns the new epoch is discarded, and the caller has to repeat it. That window
is one message delivery, and every bump is browser-initiated — `/hangup`,
`/connect`, and `/thinking` off the operator leg — so the tab is already awake
and waiting on that exchange when it happens. An agent-initiated
`transfer_to_project` does not bump the epoch at all. Losing a word to a race the
caller just started is much cheaper than running it against the wrong project.

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

`write_executable_script` in `src/pi_client.rs` is the fix. It writes the script,
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

### Clippy passing locally does not mean it passes in CI

CI installs whatever `stable` currently is, so it can be several releases ahead
of the toolchain on a development box. Clippy gains lints in that gap, and
`-D warnings` turns each new one into a build failure on code nobody touched.
The first CI run here failed exactly that way — `unnecessary_sort_by` in
`remote_argv`, flagged by clippy 1.97 and unknown to the 1.92 that had just
passed locally.

Check `cargo clippy --version` against the CI log before concluding a local run
proves anything. Pinning the toolchain in `rust-toolchain.toml` would make the
two agree and turn upgrades into a deliberate change; that has not been done.

`upload_extension` in `src/pbx.rs` had the same pattern and now behaves the same
way. It used to propagate the stdin write error while the remote command's stderr
was discarded, so the warning logged a broken pipe instead of the actual remote
error — a permission denial, a missing directory. The exit status and stderr are
now what decide.

That one has a second consequence worth knowing, because it is not only about
log quality: a remote that stops reading early but *succeeds* was being reported
as a staging failure and fell back to the sentinel. The regression test covers
exactly that, by sending a megabyte to a remote that reads sixteen bytes and
exits zero.

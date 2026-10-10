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

A turn's reply carries the generation of the leg it ran on, never the one
current when the reply is built: a rescue bumps the generation before it
aborts the work, so a turn that returns in between would otherwise pass the
check. A continuing turn's reply is delivered at the generation its operation
was admitted at; the first turn of a transfer, promotion, takeover or redial,
at the generation its candidate was staged under (`begin_candidate` returns
it). A rescue that abandons a candidate retires the candidate's generation as
well as the line's, so nothing stamped with the abandoned leg's generation
passes after it.

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
  Only the check and the send happen under the guard. A project leg's steer is
  queued on the host link there, and its answer is awaited after the guard
  (and `operation_transition`) is dropped. The link sends one host's commands
  in the order they are queued, so a close or abort a rescue queues later
  still goes out behind the steer. The answer can take the host's 30 s command
  wait, and a rescue, a project turn's end, transcript logging and reply
  admission all take that guard: they must not wait for it (#250).

- **Routing never takes the PBX lock.** The turn worker holds that lock for a
  whole prompt, so anything on the steer path that waits for it runs only after
  the turn has ended, when there is nothing left to steer: the utterance is
  queued every time (#108). Jev's call summary, the router and the host links
  come from `RoutingView`, which shares its state with the switchboard instead
  of borrowing it. `an_utterance_steers_a_turn_that_holds_the_pbx_lock` holds
  the lock and expects a steer.

The turn worker re-checks the epoch again before dispatching. That is deliberate
redundancy, not duplication. It first waits for the PBX lock, for the reason
given under "A clip on the wire when the leg is adopted" below.

**The stamp now comes from the browser.** Arrival is still later than capture:
a clip recorded before a transfer but uploaded after it would be stamped on
arrival and look current. So the server announces the epoch — as an
`{"type":"epoch"}` event whenever `cancel_active_operations` bumps it, and in the
WebSocket snapshot so a reconnecting tab is not left holding a retired value —
and the browser stamps each clip with whatever it held when *recording started*.
`clipHeader` in `apps/frontend/src/protocol.ts` puts it on the wire. A clip
header without it is refused by its id (`Clip has no generation.`), never
stamped on arrival, and the audio frame after it arrives without a header.

A client cannot use this to reach a leg it should not: the epoch is only ever
learned from the server, and any value that does not match the current one gets
the clip dropped. A wrong number can discard speech, never misroute it.

What this trades away: speech that started before the browser learned of a
change is discarded, and the caller has to repeat it. Browser-initiated bumps
(`/hangup`, `/connect`, and a `/model` or `/thinking` swap that goes ahead) are
one message delivery away, so the tab is already awake and waiting on that
exchange. A picker request that is refused bumps nothing.

A new leg bumps the epoch at *adoption*, not at startup, whether a routing
decision started it (the operator's `route`, or Jev's verdict) or a page
control did (`/connect`, or a redial
for `/model` or `/thinking`, which also bump it once at the start with their
rescue): the generation stays put while the new leg is starting, and the new
epoch is announced (with the status) the moment the leg is live.
That leaves a window — session start, intro turn — in which the browser
still holds the old epoch. The server closes it by emitting a
`{"type":"candidate"}` event when a candidate leg begins and
`{"type":"candidate_cleared"}` when adoption, rollback, or rescue ends it. The
browser marks clips recorded while a candidate is in flight as addressed to the
incoming leg and re-stamps the ones it has not sent yet to the new epoch when
the `epoch` event arrives, so the caller's words reach the new leg as a fresh
turn. Any clip without that mark keeps the discard: a wrong number can only
lose speech, never misroute it.

Only an adoption carries the marked clips along. A hangup while the leg is
connecting rescues the call, and a rescue sends the browser the same two
signals an adoption does: a clear notice and a higher epoch. Taken for
an adoption, it re-stamped the caller's words to alpha and they ran as a turn
on the operator (#70). So `candidate_cleared` names the candidate's `route`
and says how it ended (`reason`: `adopted`, `rolled_back`, or `rescued`), and
the browser re-stamps a clip only on the epoch that notice names, for an
`adopted` candidate on the route the clip was marked with, one epoch after
the stamp it was recorded under. Any other ending strips the mark. A tab that
was disconnected through the whole change sees no notice, only the snapshot's
epoch, so the snapshot sends an `adopted` notice ahead of its epoch while the
adopted leg is still the one on the line (`Coordinator::generation_and_adoption`).
A rescue and a return to the operator each give the line a new identity, and
end that.

### A clip on the wire when the leg is adopted

A marked clip that already went out carries the old epoch, and the server keeps
the first stamp it sees for a clip id: a retransmission under the same id is
taken as the clip it already holds. So such a clip is dropped, never delivered
to the new leg, and never steered into the starting one: a steer needs a turn
to attach to, and the coordinator gives none out while a leg is `Starting`.
Wherever the adoption lands, the caller hears about it through the
ID-bearing `stale_epoch` error, which the browser shows:

| the clip, when the leg is adopted | where it is dropped |
| --- | --- |
| transcribed and queued behind the transfer | turn dispatch |
| transcribed, not yet steered or queued | the check under the session guard |
| inside the speech-to-text sidecar | the check before it is logged |
| not yet arrived | the check before it is logged |

In the first two rows the words were already logged and echoed as the caller's,
so they stay in the conversation; only acting on them is refused.
The tests in `apps/backend/tests/test_caller_input.rs` that follow
`clip_accepted_before_a_page_rescue_is_dropped_after_transcription` drive each
row, with a gated sidecar or a held session guard deciding the order; the
two `speech_queued_while_a_page_control_starts_a_leg_*` tests in
`apps/backend/tests/test_page_controls.rs` do the same for a leg a page
control starts. A startup that is rolled back does not move the generation,
so a clip queued during it goes to the leg the caller never left.

Delivering the clip to the new leg was the alternative, and it was rejected.
The epoch does not move when a candidate starts, so a clip recorded just before
the candidate event and one recorded just after carry the same stamp. The
server could deliver only on the browser's word that a clip belongs to the
incoming leg, and a wrong word would put speech on a leg it was not addressed
to. Dropping can only lose speech.

The browser therefore leaves a clip that went out whole on the stamp it went
out with (`transmitted` in `apps/frontend/src/runtime/outbox.ts`, which a
reconnect does not clear) and leaves the telling to the server. Re-stamping it
used to announce that it was being carried along; and after a reconnect it
went out again under the new epoch and the server, seeing an id it already
held, accepted it and never answered. A clip the browser drops that never went
out gets a notice from the browser, because the server never saw it.

### A verdict that lands while the tab is away

The server sends a clip's outcome, its `transcript` or an ID-bearing `error`
such as `stale_epoch`, to whichever connection is registered when the outcome
is known. If the tab is disconnected then, the message goes nowhere. The
browser keeps every clip that went out until it hears back, the stale ones
included, and sends them again after a reconnect under the stamp each went out
with. The server used to take such a resend as the duplicate it was and say
nothing, so the clip sat at "Transcribing" (#71).

It now remembers the message that settled each recent clip (`ClipVerdicts` in
`apps/backend/src/caller_input.rs`, bounded like the accepted-clip window) and answers
a resend of a settled clip with it, on the connection that sent it. A verdict
is recorded before it is sent, so a resend that races it either finds it or is
registered in time to receive it live. A clip still in the pipeline is
acknowledged again and answered live, and a clip the server has forgotten,
after a restart, is processed as it arrives: under its old stamp it is dropped
with a `stale_epoch`, as it would have been the first time.

A leg started from the page differs in one way: no turn is running, so the
turn worker is free while the leg starts. It used to take a queued clip at
once, pass the stamp check, and begin the turn's prompt, which moved the call
out of `Starting` with the candidate still staged. The leg was then never
adopted, the generation never moved, and the caller's words ran on the new leg
when the page control released the PBX lock. The turn worker now waits for that
lock before the check, so it sees the outcome, and the coordinator refuses to
begin a prompt while a leg is `Starting`. A turn dropped because a rescue landed
between its check and its registration now gets a `stale_epoch` too; it used to
be dropped without one.

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

`LegAnnouncer` in `apps/backend/src/leg_announcer.rs` owns both paths now. The scene is
reset once per leg, keyed by route and generation, by whichever announcement
gets there first; the later one only restates the status. Route is part of the
key because a return to the operator keeps the generation and must still clear
the project's scene. It does not keep the project leg's token: the line takes
the operator's own identity at that generation, so a module call still carrying
the project's token (one already in flight) is refused rather than taken as the
operator's (#77). Promotion holds the display gate from adoption until the
`epoch` is published, so a display from the new leg cannot be applied, and then
wiped, ahead of its own reset.

An `epoch` does not always cut off the audio that is playing. On a handoff the
handoff line (the operator's "transferring you", a project's goodbye) is already
fully sent when the line moves, because `speak` answers only once its speech is
synthesized, so cutting it off clipped every transfer and every return. The
browser tells a handoff from a rescue: an `epoch` at the generation it already
holds (a return to the operator), or at the generation of an adoption it saw
announced, lets what is playing finish and queues the new leg behind it
(`handOffToGeneration`). Any other `epoch` (a hangup, a rescue, the first one on
a new connection) still retires everything at once (`resetForGeneration`). A
clip from the old leg that is still arriving could never finish, so it retires
everything too.

Promotion only ever adopts the leg that asked for it. Module calls name their
leg by its call token. Activity names it too: the operator's pi process is
started with the token `operator`, a project session is put on the call with
its leg's token, and each `Activity` carries it. `Coordinator::classify_activity` promotes only on
the candidate's own token, publishes only the current leg's activity, and
drops the rest (a rescued leg, the operator after a transfer, a process that
is neither). Adoption checks the token again under the coordinator's lock, so
a candidate replaced in between is never adopted on another's behalf. This
used to hold only because the PBX lock serializes turns.

Neither announcement carries its own idea of the leg. Both read it from the
coordinator, the one owner of the route: adoption moves the route, so from
promotion on, everything that reads it (the transcript, the PBX's replies, a
hangup) names the incoming leg, even while the PBX is still waiting for the
intro turn to end. The route callback is only told that the PBX has settled,
and restates the coordinator's status. A hangup that lands mid-intro, after
adoption, therefore drops the incoming leg by name and returns the caller to
the operator; before adoption the route is still the old one, and the rescue
has already abandoned the candidate.

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
(`DELIVERY_QUEUE` frames) retires a lagging socket rather than blocking the
call. A connection whose queue is full when an event is published has lost
that event, so `delivery.rs` drops it with a warning naming its connection,
and the drop closes its socket at once: the writer does not first drain what
was queued before the hole, which for audio would leave the page playing a
stream that never ends. The page reconnects, which resets playback for the
generation and delivers a whole snapshot.

Audio reservations are generation-stamped and sequenced across mid-turn speech
and settled replies. Cancellation releases a slot so a stale TTS result cannot
wedge later speech. The browser drops queued/playing audio and the outbox clips
that never went out on a new epoch, and tells the caller about those. A stale
clip that did go out stays until it receives its ID-bearing `stale_epoch`
error, then is removed from the outbox rather than retried forever.

The route/model/thinking pickers serialize their HTTP operations. A failed picker
request restores the value that was selected before that request, unless a newer
status snapshot has already invalidated it; this prevents late failures from
rewriting a newer leg selection.

Each control, the hangup included, carries the epoch the page held when the
caller acted, and the service acts on that generation or not at all (#263).
`control_generation` in `page_controls.rs` refuses one with no generation (400)
or one the call has moved on from (409). The rescue a control starts is
`Coordinator::begin_rescue_at`, which checks the generation and rescues under
the one state lock, so a transfer that lands between the check and the rescue
still refuses the control rather than letting it end the new leg; a `/model` or
`/thinking` decision is registered at that generation and is refused the same
way. Stamping a control when it goes out instead would not do: a request queued
behind a slow one would pick up the epoch of a leg the caller never chose.

After its rescue a control acts at the generation that rescue left, never at
the current one read again: a newer control can rescue while this one is
still closing the old leg (a `/connect` pressed right after a hangup, a second
tab). `/connect` registers its dial at the rescue's generation, so
`spawn_registered_operation` refuses it, and `/hangup` checks that generation
under the PBX lock before `force_hangup`, so it does not drop the leg the newer
control dials. Either answers 409 "superseded".

### A swap is decided before its rescue

A rescue ends the live leg. `/model` and `/thinking` used to rescue first
and let the PBX decide afterwards, so a swap the PBX then refused (a bare or
unknown-provider model the catalog does not resolve, the model already
running) left the caller on a closed leg, and their next turn dropped them to
the operator (#63). A swap
that keeps the conversation now only aborts the turn in flight, and the
session stays up.

They now decide first. `RedialPlanner` in `apps/backend/src/redial.rs` makes every
refusal from the leg the coordinator names (`project_leg`, read once) and the
launch plan prewarm holds, so it needs no PBX lock and a wedged turn cannot hold
it up. `run_redial_control` in `apps/backend/src/page_controls.rs` runs that decision as a
registered operation that leaves running work alone. A refusal is delivered at
the generation the decision started on; nothing is cancelled and no epoch is
sent. Only a plan that will go ahead is followed by a rescue and then
`Switchboard::redial`. The pickers are the planner's only callers; a project
agent's own `set_model` is refused (`project_session.rs`).

Deciding early opens two windows in which the caller can leave the leg the plan
was made for, and each is closed where its side effect happens:

- **Before the rescue.** `Coordinator::begin_rescue_of` rescues only while the
  leg the plan read is still on the line, checked and rescued under the
  coordinator's lock. A caller who moved while the decision ran keeps what they
  moved to, untouched, and the picker is answered 409.
- **After the rescue, before the PBX lock.** A turn queued for the lock can
  return the caller to the operator first. `Switchboard::redial` compares the
  leg again under the PBX lock, against the leg as this control's rescue left
  it, and refuses (`StaleLeg`) without launching anything. The comparison is
  the whole leg (project, identity, model, session), not the generation alone,
  because a return to the operator keeps the generation.
- **While the leg is coming up.** A candidate is adopted on its first sign of
  life, but the PBX holds its session (`Switchboard::agent`) only once its
  intro ends and `commit_leg` runs. In between, the coordinator names the new
  project while the PBX still holds the leg before it. A redial then would
  rescue the transfer's turn, which cancels it before it commits, and switch
  the old session under the new project's name (#236). So the planner refuses
  while `Coordinator::startup_in_flight`, and `begin_rescue_of` refuses too, in
  the same lock as its check. A rescue that does cancel a startup (a hangup, a
  connect) ends that startup with it: it clears the startup's rollback, so a
  late rollback has nothing to restore. And the PBX only acts on its project
  session for the leg on the line (a caller turn, a redial) while that
  session belongs to the coordinator's project (`agent_on_the_line`); a turn
  that finds another project's session returns the caller to the operator.

## A run that starts as the caller's turn settles

The host agent opens a turn only after the one before it has settled, and it
can open the next one at once. Two cases do this: the caller aborts a turn in
the Prime Agent TUI and resumes it there, and a child agent exits while the
caller's turn runs, so its wake starts right after that turn ends. The
host's `turn_end` for the caller's turn and the `turn_start` (`cause:
autonomous`) of the next run then reach the session back to back.

At that moment the service has not finished the caller's turn. The prompt
that collects it returns only when its own task runs, and the turn worker
closes the caller's operation only after that. The self-woken start used to
land in that window. The pump saw a collector, so it handed the start to it,
and the coordinator still held the caller's operation, so the run could not
be admitted. The run then had no operation: its speech and displays were
refused as a self-woken call without authority (#109). A caller message
during it was queued behind it, not steered into it, because steering needs
an operation and `busy`, and the collector's end had cleared `busy` (#107).

Two rules close the window:

- **The host's settle report closes the caller's operation.** The pump
  reports every `turn_end` it gives the collector. When its `turn_id` is the
  one the caller's operation is bound to, `Coordinator::settle_turn` closes
  that operation there and then. It is the same close as `finish_operation`;
  the turn worker's later call finds nothing to close.
- **A self-woken start goes to the application first.** While a prompt is
  collected, the pump offers the start to `handle_project_turn`. The
  application admits it only when no caller operation is open, which after
  that settle report is the case. Otherwise the collector keeps it, as
  before: that is a prompt the host turned into part of a run the session
  had just started itself. The collector's end leaves `busy` set while an
  autonomous turn runs.

A host that sends no turn ids gets the old behavior. Without an id the
caller's operation is never bound to a host turn, so no settle report can
close it.

`a_turn_resumed_after_an_external_abort_can_speak` and
`a_caller_message_steers_a_turn_woken_as_the_caller_turn_settles` in
`apps/backend/tests/test_turns.rs` send the two frames back to back.
`a_self_woken_start_before_the_caller_turn_settles_stays_the_callers` checks
that a start with no settle report before it stays with the caller's turn.

## `ETXTBSY` when tests write their own executables

Several tests need a fake `pi` or a fake sidecar. They write a small shell script,
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

## A test hook that every test shares

Tests run on many threads inside one process, so anything process-global is
shared by every test that runs at the same time. `pi_client` used to have a
test-only prompt hook: one global slot that a test filled with a closure, and
that every `PiSession::prompt` in the process called. Only
`floor_rewrite_does_not_hold_the_pbx_lock_across_utility_wait` filled it. It
waited for the first `[FLOOR REWRITE]` prompt and checked that it said
`Display held: yes`.

Other tests run floor rewrites too, on their own utility processes. When one of
them prompted while the hook was installed, the hook took that prompt in place
of this test's own, and the check failed on `Display held: no` from a project
the test never registered (#126). That prompt came from
`floor_good_moment_gate_does_not_query_desk_hosts`. Measured on master with six
full runs in parallel: 7 of 300 runs failed, every one that way. No other test
installed or cleared the hook; the race was that the hook watched every test's
processes at once. After the change: 0 of 200 under the same load.

The test now reads its prompt from the `AgentInput` event on its own
`AppState`'s debug bus. The utility publishes that event in production too,
after the prompt is written, so the test watches the real path and sees only
its own utility. The global hook and its call in `prompt_for` are gone.

The rule: a test observes the code under test through something the test owns
(its `AppState`, its debug bus, its fake executable, its temporary directory),
never through a process-global slot. A global that a test writes is shared with
every test that runs alongside it, and filtering on message content does not
make it private: another test can send the same kind of message. If no
per-test seam exists, add one that production also uses, as the debug bus is,
rather than a `#[cfg(test)]` global.

## A time budget measured on the wall clock

Some unit tests hold work to a time budget: a layout that went quadratic, a
note placement that routed every place it tried. They used to measure with the
wall clock (`performance.now`). The wall clock also counts every moment the
scheduler gives the core to another process, so on a busy runner it measures
the machine, not the work. The budgets passed alone and failed with two or
three copies of the suite running at once (load average 10 to 50): 17 failures
in 7 loaded runs. The dense bar chart's note placement took 1394 ms of wall
time against its 600 ms budget, for some 200 ms of work.

A budget now measures the test thread's own CPU time with `leastCpuMs`
(`apps/frontend/tests/unit/cpuTime.ts`), the least of a few tries, so the
waiting is left out and so is a one-off pause in one try (the first compile,
a major collection). The thread's figure, not the process's: V8 collects and
compiles on threads of its own. A busy core still runs the work slower, up to
about 2x at load 50, so each budget is at least twice what its work costs at
that load, and, where the regression it was written to catch was measured,
still under its cost. `cpuTime.ts` says how each number was set.

The rule: a unit-test time budget measures with `leastCpuMs`, never the wall
clock. `scripts/check_hygiene.mjs` refuses `performance.now`, `Date.now` and
`process.hrtime` anywhere in `apps/frontend/tests/unit` but `cpuTime.ts`, and
in `apps/host-agent/tests`. There, "answered at once" means settled before
the event loop turns (raced against `setImmediate`), and `until` gives up
after a count of polls, not a span of the clock. A
test about the page clock uses vitest's fake timers
(`vi.setSystemTime`, `vi.advanceTimersByTime`), never the real one, and reads
the fake time with `vi.getMockedSystemTime()` or `new Date()`, since the gate
refuses `Date.now` whatever clock it reads.

## A test await with no deadline

Many backend tests wait on a channel the code under test feeds: a floor
result, a command a fake host saw, a debug event. The worker holding the
sender lives as long as the test, so the channel never closes. If the code
never sends, a bare `rx.recv().await` never returns, and libtest has no
per-test timeout. That is exactly how the bugs this file is about show up: the
floor wakes its worker with `Notify::notify_waiters`, which stores no permit,
and a change that loses that wake-up did not make
`queue_order_and_one_speaker_at_a_time` fail. It made `cargo test` stop in
that test, printing nothing, until it was killed (#338).

So a test waits through `within(what, future)` (`apps/backend/src/main.rs`):
it awaits the future for up to 10 seconds, then fails the test with the
caller's line and `what`. Ten seconds is a hang detector, not a timing
assertion; a test that checks how soon something happens uses its own
`tokio::time::timeout` with the number it means.

The same goes for a task the test spawned and a oneshot it was handed: a
rescue that fails to abort a wedged turn leaves `turn.await` waiting as long
as a lost wake-up leaves `rx.recv().await`.

The rule: in `apps/backend/tests`, `.recv()`, `.next()`, `.notified()` and
`.changed()`, and a bare name (a oneshot receiver, a `JoinHandle`), are not
awaited bare. `scripts/check_hygiene.mjs` refuses one unless `within(` or
`timeout(` opens on that line or within the three before it, or the line
before aborts that same handle (`worker.abort();` then `worker.await`
returns at once). A fake that is meant to wait as long as its test (a
responder holding a gate the test opens) says so on the line before,
`// unbounded: <why>`.

## A test that takes the first screen-state report

The page reports its screen state whenever that state changes, and the first
change is not the one a test about a drawing cares about. On connect the
socket delivers `hello_ack`, the epoch and the status, and the status is what
makes the transport ready: the page sends a report right there, describing an
empty screen. A replayed `display` action arrives after it, and only the
report that follows that render names the object.

So a test that polls for *a* report and then reads the newest one is reading a
race. The two orders both happen on an idle box; under load the empty report
is what the poll sees. `callRuntime.spec`'s replay test asserted
`has_visual` on it and failed 2 times in 20 repeats at load 32, and once on
CI (#192), on a branch that touched nothing near the visual channel.

The rule: wait for the render, then for the report that describes it — never
for merely the first report. The replay test waits for the metric row to be
visible and then polls until the newest report carries the generation,
`has_visual` and the object id it expects. That is the shape the same spec
already uses for every later drawing in it.

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

The operator's pi process follows it too, with a second half: the stderr worth
reporting is read by a separate drain task, so reading the tail at the moment
of failure races that task. An agent launched into a missing `cwd` (when
project legs were still pi processes) showed both halves. The
shell prints why and exits while the switchboard writes the intro prompt, and
the caller was told the broken pipe, "the agent never answered", or "agent
process is not running ()", depending on timing, about one run in eight under
load. `PiSession::settle_exit` in `apps/backend/src/pi_client.rs` now waits, at
most five seconds, for the process to exit and its stderr to be read to the end
whenever its output ends mid-turn or a prompt cannot be written, and a failed
write is reported as the exit it led to.

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

## A local prompt cancelled mid-turn

A local `PiSession` (the operator and the routing utility) reads its prompt's
answer from one stdout stream, up to the first `agent_settled`. Nothing in an
event names the prompt that caused it. Two paths drop a prompt's future while
the process is still running it: the floor rewrite's `REWRITE_TIMEOUT`, and a
rescue that aborts the turn task while it waits on the utility or the operator.
The rest of that turn stays in the pipe, and the next prompt read it as its own
answer: the caller heard the rewrite of an older update, or a line was routed
by a decision made for other words (#243). The session also stayed `busy`, so
an idle operator looked like a running turn to steer into.

`prompt_for` holds a `PromptInFlight` guard from the write until the turn ends.
Dropped before that, it is the `Cancelled` event: the process's state
(`ProcessState` in `apps/backend/src/pi_client.rs`) moves to `Abandoned`,
which is not busy and not alive, and its close runs in the background, since
a drop cannot await. `alive()` is false at once, so `ensure_operator` and
`ensure_utility` start a fresh process for the next prompt. Both get the call
state with every prompt, so a restart loses only the process's own memory of
its earlier prompts. Draining the old turn before the next prompt would also
work, but it keeps a process of unknown state alive.

A turn that breaks off any other way before `agent_settled` (its output ends
or cannot be read, it is silent past its deadline, it sends a line too big to
read or too much text) is the `Failed` end, and the process is closed before
the failure returns, for the same reason: what is left of that turn is not
the next prompt's to read. An agent that closed its output and kept running
was once left idle, and every later prompt went to it and failed.

The state has one writer, `PiSession::transition`, and one table, `step`.
Every prompt event carries the prompt's number, so a late one (the guard of a
prompt whose process its owner closed mid-turn) leaves the state alone. A new
flag on this process (a second "busy", a "closing") is a new row or phase in
`step`, not a field beside it. A `close()` that finds the process already
`Closed` runs the same idempotent release, which waits on one that is under
way: the path that entered `Closed` may not have taken its first lock yet, and
an owner that closes and restarts must not find the old process running.


## Prepare reports are final

A project's prepare runs once, through its host agent, as soon as the host
links. Its exit status (zero, nonzero, or timeout) is a terminal report
snapshot; nonzero or timed-out prepare outputs remain launchable and are never
retried. Only a prepare cut off by a lost link runs again, on the next link
(`run_prepare_job` in `apps/backend/src/prewarm.rs`).


## Speech worker startup and provider drains

Speech admissions go through the one `process_speech` worker. Production starts it
from `spawn_workers` before the HTTP listener accepts requests. Tests that call
reply delivery or module calls directly must start that same worker through the
shared test setup helper; otherwise a bounded speech-channel `reserve()` has no
receiver and waits forever. Of the shared test helpers, `state()`
(`app_state.rs`) does not start the worker; `state_on` (`app_state.rs`),
`agent_call_json` (`module_calls.rs`), `request_json` (`api.rs`) and
`module_call_json` (`tests/test_module_calls.rs`) do. Provider response bodies drain in tracked tasks, so
the next ordered request may use pending `previous_text`, while a request id is
committed only after the body reaches EOF. Lifecycle resets reject late drain
commits.

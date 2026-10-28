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
  admission all take that guard: they must not wait for it (#250). The
  caller's next line must not wait for it either, so the answer is awaited
  on a task of its own, off the clip worker (#295). A steer the host refuses
  is queued as a turn, as it always was, and `LineOrder` in
  `apps/backend/src/turns.rs` keeps the turn queue in the order the lines
  were spoken: a failed steer is queued only after the lines ahead of it
  have been steered or queued, and a line headed straight for the queue
  while a steer ahead is unanswered waits behind it, off the caller's line.
  Such a line keeps its own stamp, so if the line changed meanwhile the turn
  worker drops it as stale. `LineOrder`'s lock (a `std` mutex beside the
  turn state's) is a leaf: it is held only to take and set `tail` and to
  spawn the next task, never across an `await`, and no other lock is taken
  under it, so it adds nothing to the lock order.
  `the_next_line_does_not_wait_for_the_host_to_answer_a_steer`
  in `apps/backend/tests/test_turns.rs` steers two lines into a link that
  never answers, then drops the link.

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
Only those two signals end a candidacy on the page: a `reply` or a `status`
that arrives while the candidate starts does not, because the service sends
a `candidate_cleared` for every way a candidacy ends (pinned by
`a_candidacy_ends_only_with_a_notice_that_says_so` in
`apps/backend/tests/test_lifecycle.rs`), and a reconnect's snapshot `epoch`
covers a tab that missed it (#480).
On the page, the rule is `follow` in `apps/frontend/src/runtime/callIdentity.ts`
and `ClipOutbox.carry`/`unmark` in `outbox.ts`.
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

A rescue resets the scene too, without a leg: `release_rescued_work`
(`apps/backend/src/page_controls.rs`) clears the stage and sends its `epoch`
under the same gate (`DisplayGateState::rescue`), because the page drops the
old leg's objects on that `epoch`. The stage then belongs to no leg, so the
next announcement resets it as usual. Before this, the stage kept the rescued
leg's objects until the next announcement: `view` reported them, and a page
that reconnected in that window was sent them again.

An `epoch` does not always cut off the audio that is playing. On a handoff the
handoff line (the operator's "transferring you", a project's goodbye) is already
fully sent when the line moves, because `speak` answers only once its speech is
synthesized, so cutting it off clipped every transfer and every return. The
browser tells a handoff from a rescue: an `epoch` at the generation it already
holds (a return to the operator), or at the generation of an adoption it saw
announced, lets what is playing finish and queues the new leg behind it
(`handOffToGeneration`). Any other `epoch` (a hangup, a rescue, the first one on
a new connection) still retires everything at once (`resetForGeneration`).

A clip of the old leg that is still arriving at a handoff finishes too
(Kayne's decision on #437): what the old leg is already saying finishes, and
the new leg's speech plays after it. Both halves hold it. The speech worker's
drain stops at a moved generation only when none of its audio has reached
the page yet (`drain_speech_stream`), so the utterance being said goes on and
nothing new from the old leg starts; a rescue or a shutdown aborts the drain
as before. The audio order holds the new leg's audio until the old clip's
`audio_done`. The page takes the arriving clip's bytes and `audio_done` after
the handoff and plays it whole. The wait is bounded: the speech deadline ends
the old clip's stream (`TtsChunkStream`), and its slot then closes, and once
it plays the silence watch (`NO_PROGRESS_MS`) ends a clip that stops
sounding.

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
objects, speech, focus, activity and any view it asked for), the line's and
the turn's errors, except on a reconnect's snapshot of the same generation,
and playback's, except on a handoff. It keeps the conversation, which belongs to the call, and a
microphone's error, which belongs to the device. The route label on it
changes when the status arrives. A reconnect is followed by the history
snapshot, which replaces the transcript and hides the conversation if the
server has none.

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
error, then is removed from the outbox rather than retried forever. Both
notices last only until the next epoch on the live line, and after a rescue
by a page control (a hangup from a project leg, a `/connect`, a redial) that
epoch follows at once: the new leg's, which takes them down
(`apps/frontend/ARCHITECTURE.md`, "Transport boundary").

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
tab). The rescue returns a token (`lifecycle::Rescued`), and every later step
of the control takes its generation from it (`PageControl` in
`page_controls.rs`; `docs/architecture.md`, "A page control"). `/connect`
registers its dial at the token's generation, so `spawn_registered_operation`
refuses it (409 "cancelled"), and `/hangup` checks the token under the PBX
lock before `force_hangup` (`Rescued::lock_pbx`), so it does not drop the leg
the newer control dials (409 "superseded").

The quiet a rescue begins ends only where that rescue is named. A control
settles with its token (`Coordinator::settle`), and a reply delivery at the
generation it delivered at (`settle_at`). A redial's decision rescued
nothing, so neither its answer nor its failure settles (`speech::Quiet::Keep`):
a `/model` pressed while a `/connect` dials holds the connect's generation,
and settling there would admit turns mid-dial (#461). The settle is one call-line event
(`Event::Settle { generation }`) that brings a `Quiescing` call to rest only
at that generation. A newer rescue that lands after a control's PBX step, or
between a delivery's generation check and its settle (a rescue does not take
`operation_transition`), keeps its quiet: an older control's settle, or a
status publication, no longer ends it (#369). A return to the operator
(`drop_agent`) keeps the phase, as a thinking event does: the line takes the
operator's identity in whatever phase it is in, and a quiet stays its
rescue's to settle (#462). That settle has to be reached without the
control's request: hyper drops a handler's future when the client goes
away while the response is pending (a reload, a suspended tab), so each
page control's body runs on its own task (`page_controls::detached`) and
the handler only waits for it.

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
  intro ends and its `Startup` commits. In between, the coordinator names the new
  project while the PBX still holds the leg before it. A redial then would
  rescue the transfer's turn, which cancels it before it commits, and switch
  the old session under the new project's name (#236). So the planner refuses
  while `Coordinator::startup_in_flight`, and `begin_rescue_of` refuses too, in
  the same lock as its check. A rescue that does cancel a startup (a hangup, a
  connect) ends that startup with it: the call is `Quiescing`, which holds
  no candidate and no leg to restore, so a late rollback has nothing to
  restore. And the PBX only acts on its project
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
  autonomous turn runs (`docs/host-link.md`, "A project session's turn").

Both rules rest on turn ids. Every turn the host opens carries one, and the
reply to a `prompt` names the turn the prompt went into, so the prompt ends
only on that turn's `turn_end`, never on another's (host-link protocol 2).
A host agent that predates this is refused at hello.

The turn the reply names can be one the host already had open. When the
caller's operation wins the race above, the run is refused an operation of
its own, and the caller's prompt reaches a session that is running it: the
host sends the prompt into the run as a `follow_up`, and its reply names the
run. The run is then the caller's answer (#512), but it opens no turn of its
own, so no `turn_start` with cause `input` ever crossed to bind the caller's
operation to it. Its `speak` and `display`, which the host stamps with the
run's turn and cause, were refused as a self-woken call without authority
while the caller waited for exactly that answer. So the session's turn
reports the reply's turn as the caller turn's start
(`TurnEvent::PromptReplied`, stepped by `prompt_as` on the prompt's task),
and the one bind in `open_host_turn` binds the operation to it; a turn the
host opened for the prompt reports its own start too, and the second bind
of one id changes nothing. With the reply read before the run's end, the
host's end of that turn then settles the operation as an `input` turn's end
does, whatever the run's cause, and the rule above holds for a `follow_up`
too. With the end read first (the reply is read on the prompt's task, the
end on the pump's, and nothing orders them), the operation is not bound
yet, so the end settles nothing: the operation closes when the prompt
returns, as it did before this bind existed, and a run the host starts in
that sliver is refused as before (#109). A bring-up has the same shape with
no operation yet: a takeover of a busy desk session, or a transfer that
resumes a saved session the host reattached busy after its restart, sends
its first prompt into the open turn (#239). There the bind lands on the
starting line (`Line::Starting`'s `intro_turn`), and adoption opens the
intro operation bound to it; if the candidate's first sign of life adopts
it before the reply is read, the bind lands on the intro operation
directly, and both orders end the same way. It follows that a bring-up's
intro operation is bound to its host turn now, where it was unbound before,
whenever that turn is still open when the reply is read: a module call
inside such an intro that names no turn, or another turn, is refused, as it
is inside a bound caller turn. Protocol 2 hosts stamp every call made inside
a turn with its id.

The report runs on the prompt's task, not the pump's, so it is the one
turn report not ordered before the turn's module calls: a call the host
makes right after its reply can still be refused, as every such call was
before. It also gives the locks one more edge: `prompt_as` holds the PBX
lock and the session's `turn_lock` while the report takes
`operation_transition`. The edge is safe because nothing that holds
`operation_transition` waits on a prompt, on a `turn_lock`, or on the PBX
lock; keep it so. The reply can also be read after the pump has taken the
end of the turn it names: a turn the host opened for the prompt whose
`turn_start` and `turn_end` both came first, or a `follow_up` run that
ended first. The session's turn keeps, with the prompt being collected, the
turns whose end it took since that prompt went out (`session_turn.rs`,
`Prompt::ended`), and a reply naming one of them reports nothing. Without
that, the `follow_up` case bound the still-open,
unbound operation to a turn that was over, and the ended run spoke with the
caller's authority until the prompt returned. The check runs when the
reply is stepped, not when its bind takes `operation_transition`, so one
order is still open (#542): the reply is stepped before the run's end, the
pump steps and reports that end before the reply's report takes the lock,
and the bind then lands on the ended turn, which keeps the caller's
operation until the prompt returns. A reply naming a turn that
ended before the prompt went out is not caught: the reply names the turn
the prompt went into, so no protocol-2 host sends one. The report cannot
stamp a stale turn on a newer caller operation either, because the turn
worker is the one production caller of `begin_prompt` and runs turns one
at a time; a second caller of `begin_prompt` would have to keep that true.
`a_caller_prompt_sent_into_a_self_woken_run_can_answer` in
`apps/backend/tests/test_turns.rs` drives the caller's case, and checks
that the run's end settled the operation.
`a_reply_read_after_its_run_ended_binds_nothing` there has the service
step the run's end before the reply, and checks that the ended run has no
authority. Like the clip tests in "A clip on the wire when the leg is
adopted", which order their steps with a gated sidecar or a held session
guard, it decides that order with something it owns, not with the
scheduler: it sends the end, then a module call, and replies only once the
pump has answered that call. The pump reads the session's frames in order,
so by then it has taken the end. A host sends a `follow_up`'s reply ahead
of the run's end; here the end goes first. The prompt skips the frames sent
before its reply, so an idle snapshot ends it instead, and its return shows
that its task has stepped the reply.
The session-turn table's `PromptIntoEndedRun` row
(`apps/backend/tests/test_project_session.rs`) pins the unreported start the
same way: the rig sends the run's end before the host's reply, waits for
the pump to read it, replies, and ends the prompt with an idle snapshot.
`a_busy_desk_takeover_prompt_can_answer` and
`a_busy_resumed_session_prompt_can_answer` drive the two bring-ups and
accept whichever order the reply and the adoption land in; the fake replies
at once and the sign of life follows, so in practice they run the reply
first. The adopted-first bind is pinned at the coordinator by the call-line
table row `adopted | bind_turn => bound`, and
`a_candidates_intro_turn_binds_the_intro_operation` in
`apps/backend/tests/test_lifecycle.rs` pins the candidate's bind alone.

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

A fake executable is also needed after its spawn returns. The kernel starts
`/bin/sh` with the script's path, and the shell opens that path itself, later.
A test that removes or rewrites the script to make the next start fail
(`EnsureWithoutBinary` in the local-process slot table) must first wait until
the running process has answered once. Otherwise, on a loaded machine, the
shell finds no file, exits, and the process it was meant to keep reads dead.
A shell loop that starts a script and removes it at once fails 246 times in 300.

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

## A log capture scoped to one thread

A few backend tests assert on a log line, because the journal is the only
place that says it: the mime a caller's browser recorded, or why a host frame
was dropped. They used to capture the line with a subscriber scoped to the
test's thread (`tracing::subscriber::set_default` or `with_default`, with an
`EnvFilter` and a `DebugLogLayer` on the test's own bus).
`an_arriving_clip_is_logged_with_the_mime_the_browser_recorded` failed now and
then under load with `left: []`: the `clip arrived` line never reached the
capture (#368, #427, #211).

The scope is one thread, but tracing keeps what it learns about a callsite for
the whole process. Each `info!` is a callsite. The first time any thread
reaches it, tracing asks whether a subscriber wants its events and stores the
answer, the callsite's interest, in the callsite. While one subscriber is live
in the process, tracing-core asks only the default of the thread that reached
the callsite. A test that captures nothing, on another thread, has no default.
So when it reaches `clip arrived` first, while the capturing test's subscriber
is the only one live, the callsite is cached as never until the next
subscriber is created, and the capturing test's own line is skipped. The test
passes alone and fails beside a test that uploads a clip at the wrong moment:
the interest cache is a process-global that every test shares, the hazard
above in another form.

Measured on master: a test that lets another thread reach the callsite first
fails 10 runs in 10 when run alone. Under load, each round ran four full test
binaries at once, two built from master and two built with the fix, so both
saw the same load. The 1-minute load average at the start of a round was 30
to 82, except for two rounds at 13 and 26. Master's binary failed 10 of 260
full runs, each one in this test. None of the 260 fix runs failed this test.
That is a count of this test failing, not of failed runs: the fix runs
failed two other tests, once each, and neither test is touched by this
change. Only 60 of the 260 fix runs ran the code that landed, at 51107365.
The other 200 ran two earlier builds of the same capture, one from before
review and a pilot build that also held two more repro tests.

`debug::capture_logs(&bus)` (`apps/backend/src/debug.rs`) is the fix. Its
first call installs the test binary's only subscriber, as the global default:
an `EnvFilter` of `switchboard=info` and a layer that hands each line to the
capture of the thread that logged it. Each call puts a `DebugLogLayer` on the
test's bus in its thread's slot, and the guard it returns empties the slot
when dropped. With a global subscriber, every thread's default is that
subscriber, so no callsite is cached as never for want of one.

The subscriber is a `#[cfg(test)]` global, which the rule above says to avoid.
It is one here because tracing's dispatch is process-global already:
production installs one global subscriber too. The test still observes
through what it owns. It reads
its own bus, the line reaches it through production's `DebugLogLayer`, and the
slot is keyed by thread, so no test reads another's lines.

The install has one window of its own. It enables `info` before it publishes
the subscriber, and a callsite another thread registers in between finds no
subscriber and is cached as never. `capture_logs` has tracing work out every
interest again right after the install. That repairs such a callsite, unless
the other thread looked for the subscriber before the install published it
and stores its answer after the repair. That window is a few instructions
wide, and it has not been seen.

The capture is per thread, as the scoped subscriber was. A `#[tokio::test]`
runs its tasks on the test's thread, so their lines are captured. A line
logged on another thread is not: a `#[tokio::test(flavor = "multi_thread")]`
worker, a `spawn_blocking` closure, a thread the test starts. A test of code
that logs there runs it on the default current-thread runtime, or reads the
fact from something it owns, such as an event on its bus.

The rule: a backend test captures logs with `capture_logs`, never with a
subscriber of its own. `scripts/check_hygiene.mjs` refuses `set_default`,
`with_default` and `.with_subscriber(` in `apps/backend`.

## A test that runs the machine's pi

The operator and the routing utility are local processes started from
`SWITCHBOARD_PI_BINARY`, whose default is `pi`, looked up on the PATH.
`Config::for_tests` used to take that default too, so a test that reached
the operator without naming a fake ran whatever `pi` the PATH held: the real
one on a development box, none on CI. Such a test passed on the box and
failed on CI, or, if it never looked at the operator's answer, passed on
both while it prompted the real pi on the box.
`a_caller_turn_never_goes_to_another_projects_session` was the second kind:
the turn it drives returns the caller to the operator.

`Config::for_tests` now sets the operator's runtime to a path that does not
exist (`NO_PI` in `apps/backend/src/main.rs`) unless the test names one. The
start fails where it fails on CI, at the spawn, on a missing file, and the
path names `fake_operator`. A turn that reaches the operator sees it
unavailable on both machines alike. The service's own default is still `pi`.

The rule: a test that reaches the operator or the routing utility names its
runtime, such as `fake_operator`, `fake_routing_process`, or a script of its
own written through `write_executable_script`.
`a_test_that_reaches_the_operator_without_its_fake_runs_no_pi_on_the_path` in
`apps/backend/tests/test_operator.rs` puts a `pi` on the PATH the operator is
given, names no runtime, and checks that the operator does not start.

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

## A timer a test leaves armed

A playback whose clip is meant to be sounding arms a stall watch
(`ProgressWatch`, 3 s by default) on the real clock. `audioPlayback.test.ts`
runs in node, and each of its tests stubs what a browser has
(`requestAnimationFrame`, `MediaSource`, object URLs) for itself; `afterEach`
removes the stubs. Eighteen of its tests ran on the real clock, ended with a
clip sounding or opening, and never disposed the playback, so the watch
outlived the test.

Vitest runs each file in a worker of its own and ends the worker with the
file, so a watch still armed when the file ends never fires. Unloaded, the
file's tests take a second or two. On a loaded machine they can run past 3 s,
and then a watch an early test left fires during a later test in the same
file, after the early test's stubs are gone. In one `npm test` run such a
watch reached the level meter's `cancelAnimationFrame` and threw. Every test
passed, and the uncaught error failed the run.

Every test in the file now runs on vitest's fake clock, and `afterEach` drops
whatever timers are left with `vi.useRealTimers()`, so none can fire in a
later test. Before that, `afterEach` disposes every playback the test made
through `playbackForTest` (`AudioPlayback.dispose` cancels every timer a
playback holds) and fails the test if a timer is still armed.

`callRuntime.test.ts` had the same shape on its failure path: each test
disposes its runtime after its expects, so a failing expect skipped the
dispose and left the playback's watch armed, and the same `ReferenceError`
followed. Its `beforeEach` now puts every test on the fake clock too.

The rule: a unit test whose code under test arms timers runs on the fake
clock, and ends what it started (a playback, a runtime) before its stubs go.
`audioPlayback.test.ts` and `callRuntime.test.ts` follow it. In the other
node unit files no passing test leaves a real timer armed after its teardown.
`pushToTalk.test.ts` runs on the real clock and stays there: `PushToTalk`
arms no timer (its level meter runs on `requestAnimationFrame`, which the
tests stub with one that schedules nothing), and the file's only timer is its
own `settle`, a `setTimeout(0)` every caller awaits, so a failing expect
cannot leave one armed.

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

## A test that reads the scene that is leaving

A scene change does not take the old scene away at once. The stage keeps
the scene that is leaving in the document through its exit, about 400 ms
and longer on a loaded runner, and marks it inert from the frame it starts
to leave (`apps/frontend/src/components/Scenes.tsx`). Until the exit ends
the stage holds two scenes, or three, and the leaving one usually comes
first. So `document.querySelector('.content-grid > .content-main')`
returns the leaving scene's column. `openScene` is a scene change too: the
fixture loads after the page's first render, so the idle scene is leaving
for the first 400 ms or so.

At 390x844, from the architecture fixture to a short plan, the leaving
column is 488 px and the plan's is 498 px from its first frame; the rails
under them differ by those 10 px. A spec that read once, 600 ms in,
measured the leaving column whenever the exit outlasted the wait:
progress.spec found the panel 4.9 px off its column's centre (#341), and
composition.spec found the aux row 9.8 px past the column (CI, WebKit at
390x844). #391 took the switch from one column to the other for a page
relayout. There is none: the plan's column never moves.

The hazard is a one-shot `document.querySelector` read, in the page, of a
part the leaving scene can also hold: a column, an aux row, a rail, a
heading. A strict Playwright locator (`toBeVisible`, `locator.evaluate`)
fails at once on two matches instead of reading the wrong one, and a count
assertion retries until the exit ends. A read of an object only the new
scene shows finds that one.

The rule: a spec reads a scene's parts from `CURRENT_SCENE`
(`apps/frontend/tests/visual/helpers.ts`), the scene that is not inert, and
scopes the wait in front of that read the same way. It does not wait the
exit out. A read anchored on an element takes the scene that holds it,
`element.closest('.scene')`. Behind a modal (focus, the history) every
scene is inert and `CURRENT_SCENE` matches nothing; a spec that reads
the scene there selects it by its kind (`[data-scene="..."]`).

## A test that reads what the page is sent

A backend test reads what the browser is sent from the delivery queue, the
path the page reads: `browser::PageFeed` is a connection of its own on it,
and `register_connection` is a whole page. There is no second channel for
tests (#408: a `tokio` broadcast on `AppInner` was sent every event and read
only by tests, and it was deleted).

A connection makes a page connected (`DeliveryState::connected`), and the
service acts on that: a display waits for the page to confirm its render, and
speech is synthesized for a page to play. So a test that opens a feed is a
test with a page on the call. A display test confirms each render the way the
browser does (`a_page_that_draws` in `test_module_calls.rs`), or each display
call waits out `DISPLAY_CONFIRM_DEADLINE_MS`; a test of the no-page path opens
no feed.

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
a drop cannot await. `alive()` is false at once, so `LocalProcess::ensure`
(`operator.rs`) starts a fresh operator or utility for the next prompt. Both get the call
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

### How a speech request ends

The worker builds one `PendingSpeech` for each request it takes off the
queue, and every exit ends in `PendingSpeech::complete` with one
`SpeechOutcome` (`apps/backend/src/speech.rs`). Nothing else answers the
requester, writes the spoken line, or shows the page a speech error.

| phase | what happens | outcome | requester is told | page error | spoken line |
| --- | --- | --- | --- | --- | --- |
| queued | a rescue retired the generation | `Stopped(Superseded)` | not spoken | no | no |
| admitting | a rescue aborts it | `Stopped(Cancelled)` | not spoken | no | no |
| admitting | the provider refuses | `Failed` | the provider's error | at the current generation | no |
| draining | a rescue aborts it | `Stopped(Cancelled)` | not spoken | no | no |
| draining | the generation moves on | `Stopped(Superseded)` | not spoken | no | no |
| draining | the body fails, or the task panics | `Failed` | the error | at the current generation | no |
| draining | the body ends, a browser took it | `Spoken` | spoken | no | if it carries a `transcript` line (a `speak` or a floor line) |
| draining | the body ends, no browser took it | `NotDelivered` | not delivered | no | no |

Only a rescue stops a request, and it retires the generation first, so a
`Stopped` request never reaches the page (#247). Every end but `Spoken` and
`NotDelivered` gives back what the request holds, its pending continuity text
and its audio slot (`Utterance::abandon`). The drain does this the moment its
own body ends, because the slots queued behind it emit only once it is
closed: a later drain that finished first would find its audio held back and
report it undelivered. The completion does it again for the ends the drain
never sees (admission, an abort, a panic); both steps are no-ops once done.
`every_end_of_a_speech_request_completes_it_once` in
`apps/backend/tests/test_speech.rs` drives each row it can reach through the
real worker.

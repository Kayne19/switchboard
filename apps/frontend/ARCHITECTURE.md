# Architecture

## Data flow

```text
Damocles or development sandbox
             |
             | six-operation protocol
             v
      Controller reducer
             |
             | normalized semantic state
             v
       Scene classifier
             |
             | primitive composition
             v
       React scene renderer
             |
             | layout identities and transitions
             v
      Motion + SVG + CSS
```

## Controller state

The reducer stores semantic objects by stable ID, insertion order, speech state, listening state, and focused object ID. `ControllerState` (`src/controller/types.ts`) holds them twice over:

- the agent's objects, order and speech (`agentObjects`, `agentOrder`, `agentSpeech`), from the `display` channel;
- the runtime's (`runtimeObjects`, `runtimeOrder`, `runtimeSpeech`): the conversation and other page-owned objects, whose IDs start with `RUNTIME_ID_PREFIX` (`__runtime/`), so an agent ID never lands there;
- `objects`, `order` and `speech`, the two merged, which the renderer reads;
- `workspace` (the requested and effective view), `activity`, `toolRun`, `listening`, `focusId` and `revision`.

Stable IDs are critical. Reusing an ID for `show` updates the object in place and allows React and Motion to preserve continuity.

## Scene classification

The renderer does not load bespoke route pages. It derives a broad composition from the primary semantic object:

| Primary object | Composition |
|---|---|
| none | idle |
| message | conversation |
| chart | training and analysis |
| diagram | architecture and flow |
| document | email and document reader |
| code | source analysis (`src/primitives/CodeViewport.tsx`) |
| table | ruled rows of named columns |
| image | figure: a raster image contained on the black field |
| calendar | a day, a week, a month or an agenda of events (`src/primitives/CalendarPrimitive.tsx`), laid out from the box it is given |
| tasks, inbox | the to-do list and the inbox, drawn by `TasksPrimitive` and `InboxPrimitive` in the list viewport |
| timer, weather | the timer by `TimerPrimitive` on the page's one clock (`src/hooks/usePageClock.ts`), the forecast by `WeatherPrimitive`, each laid out from the box it is given |

Additional metrics, progress, notes, comparisons, and speech modify that composition incrementally. Any other visual on stage that the composition does not draw itself (`besideVisuals` in `src/app/sceneModel.ts`) goes in the aux row under the primary; see "Scene shell".

A visual primary's composition is named for its type (`sceneKind`, from `VISUAL_TYPES`), but a chart's, `training`, and a diagram's, `architecture`.

`renderObject(object, slot, ...)` (`src/components/renderObject.tsx`) draws an object in the main slot of its own scene, as the composed workspace's primary, in a cell of the aux row, and in focus. The shell draws a few things itself: the rail's metrics and progress, the composed workspace's metric primary or cluster, and a chart's own page (its charts, with the notes laid over them, and its progress). Every primitive that draws differently by place takes one `slot` prop for where it is (`primary`, `aux` or `focus`, `src/primitives/slot.ts`; metrics and progress also `rail`) and draws what that place has room for.

## Scene shell

Every composition is drawn by one `SceneShell` (`src/components/Scenes.tsx`).
The shell owns what every page has: the frame and heading, the Damocles
presence, the rail (metrics, live response, note, progress, tool activity),
the footer caption, the CHANNEL / MODE stack in the bottom-left corner, and
the transcript entry point. A composition only fills the main slot and names
what its rail carries. A feature that crosses compositions is added to the
shell once; it is never wired into a composition by hand. The presence reads
the voice level from the registered voice runtime, so no page can leave it
out.

The corner stack (`ChannelStack`, #180) is the page's one input-mode
control. CHANNEL names how the caller is on the line -- voice today; a text
channel is a later issue, so the line is shown and does nothing. MODE reads
the hands-free state the registered voice runtime reports and switches it
through that runtime (`toggleHandsFree` in `src/runtime/callRuntime.ts`,
which owns the wake-word detector and the microphone): the page keeps no
listening state of its own, so it cannot disagree with the transport about
what the microphone is doing. With no runtime -- the demo page -- there is
nothing to switch and the control is disabled. No composition labels that
corner: a per-page `DISPLAY / ...` label stood there before, and the
conversation page carried a static stack that always read PUSH-TO-TALK.

The shell also owns the main column (`MainWithAux`): a composition's main
slot over the aux row. A composition names the objects its slot does not
draw (`SceneContent.aux`), and the shell gives each a framed cell in the row
(`AuxRow`), so an accepted visual is never lost to the layout. The slot sits
in the column whether or not the row is shown, so a visual arriving beside
the primary resizes it in place. Alone, a scene's slot fills the column: a
chart, diagram, document, code, table or image page is drawn exactly as it
was before the column existed, and the composed workspace no longer keeps
an empty row's gap under a lone primary.

The shell also measures whether the rail stands under the column
(`useRailUnder`, from where the two boxes lie). The layout itself comes
from the stage's portrait container query; the shell reads its result, so
the two agree. Where the rail stands under the column, it is Damocles
beside the note, and the note reads whole (`useRailFit` in `RailDetails`):
it keeps its own height, and the grid gives the rail at least that height
(`--rail-floor`), the main column keeping the larger share. Where what the
rail carries does not all fit, the note leads and the rest scrolls under
it, with nothing drawn on an edge the column continues past (#177); the
activity panel stands at the column's foot only where it fits there whole.
What the observers measure is committed before the frame is painted. A primary that outgrows its share scrolls in it or is
drawn smaller; it never takes the rail's room. On a chart page the shell
also moves the note the primary chart hands over into a band under the
charts where the rail stands under them.

Two exceptions are deliberate (decided 2026-10-02; see #121 and #124). Review them
in a later refactor or audit instead of folding them in by habit:

- `UnavailableStage` (`src/components/SceneRenderer.tsx`), the fallback page
  shown when the display cannot render, is drawn outside the shell. It draws its
  own presence. The fallback must still work when the shell is what failed, so it
  depends on as little as possible.
- The idle page shows no tool activity panel. Idle stays idle.

## Layout

The stage is a CSS size container. Layout rules use container-relative units and aspect-ratio container queries. The implementation intentionally avoids phone, tablet, iPad, laptop, and ultrawide branches.

```text
horizontal field
| edge | primary content | semantic gutter | presence rail | edge |

vertical field
| primary content |
| explanation + presence |   (the note whole beside Damocles; a primary that outgrows its share scrolls in it)
| shared footer |            (the CHANNEL / MODE stack at its left, the page's caption at its right)
```

The renderer can later evolve into a more general constraint solver without changing the model protocol.

## Motion

Motion owns semantic continuity:

- `layout` animates recomposition when objects are added or removed.
- `layoutId` preserves object identity through focus transitions.
- Both reach motion through `useLayoutMotion`, which hands it neither under `prefers-reduced-motion`: there nothing moves, so no layout projection runs that could leave a box at an old size.
- `AnimatePresence` resolves new and removed objects.
- SVG paths trace charts, diagram routes, and technical frames.
- CSS and motion values drive the continuous Damocles float.

Motion is an implementation detail. It must not appear in the model-facing protocol.

## Transport boundary

The production boundary is a bidirectional WebSocket:

```text
Damocles backend <-> src/runtime/callRuntime.ts <-> src/integration/runtime.tsx <-> controller.dispatch(action)
```

`callRuntime.ts` owns the socket and the call's audio and reports runtime
state and each backend message, decoded into the `ServerMessage` union of
`src/protocol.ts` (a frame that is not one of its messages is dropped); it
owns no DOM. `runtime.tsx` validates
incoming display actions, dispatches them, and reports the rendered scene back
to the backend. Neither contains layout logic.

The reports themselves belong to `ScreenReporter` (`src/app/screenReporter.ts`);
`runtime.tsx` only forwards it events. It sends with stop-and-wait: one
`screen_state` is on the wire until its `screen_state_ack`, and the newest
scene waits behind it. Its state is one value written only by `transition`:
the phase (`line`), the queued report, the generation of the last `epoch`,
the highest applied display `seq`, and the one rejection not yet sent.

| phase | holds | event | next | effect |
|---|---|---|---|---|
| `unready` | — | scene | `unready` | the report is queued |
| `unready` | — | ack | `unready` | none: an ack answers a report sent after the epoch |
| any | — | `epoch` | `idle` | the generation is the new one; the report on the wire and the queued one are given up |
| any but `unready` | — | line down | `unready` | the report on the wire is given up |
| `idle` | — | scene | `awaiting` | the report goes; a socket that refuses it leaves it queued, in `idle` |
| `idle` | — | ack | `idle`, or `awaiting` | the queued report, if any, goes |
| `awaiting` | the report, its deadline | scene equal to the report on the wire | `awaiting` | the queued report is dropped |
| `awaiting` | the report, its deadline | another scene | `awaiting` | it replaces the queued report |
| `awaiting` | the report, its deadline | ack, or `ACK_DEADLINE_MS` (2 s) without one | `idle`, or `awaiting` | the queued report, if any, goes |
| any | — | display applied / declined | same | the applied `seq` rises / the rejection is recorded, and the next report carries it |

The service does not acknowledge a report it ignores (a tab that is not the
active one, another generation, a view it does not know), so the deadline is
what lets an older tab report again once it becomes the active one. The
deadline names its report and is cleared on leaving `awaiting`, so one that
fires late is dropped. A report that goes clears the queue: nothing older
than the report on the wire is sent after it. A rejection is cleared only by
the report that carries that same object out, and a newer one replaces it:
two declined before a report goes keep only the newer (#378). The phase-by-event
table in `tests/unit/screenReporter.test.tsx` pins each row through the
adapter.

Every failure the runtime cannot recover from is reported as status text with
`statusError` set -- no microphone, a browser that cannot record, a recorder
that stopped, a line that will not connect. `runtime.tsx` puts that text on
screen through `runtime_say` to `RUNTIME_LINE_ERROR_ID`, as a server `error`
is, once per text; the rail draws it as `LINE / ERROR`, in red, never as
Damocles's explanation. Every status says whether it is an error
(`setStatus`'s flag is not optional), and the first that is not one withdraws
the error (`runtime_unsay`). Ordinary status -- the idle line, a turn under
way -- is never drawn: the presence itself shows what the line is doing. A
status that kept the flag of an error before it was drawn as that error, so
the turn after a failure put "Connected. Tap Talk and speak." beside the
visual (#213). An error with nowhere to go is a browser that fails silently,
which is what a caller tapping Damocles on an iPad saw.

Playback is in `src/runtime/audioPlayback.ts`, and every way it can fail is
reported the same way. A clip the element refuses, a stream it will not take,
a clip that starts and plays nothing, and a clip autoplay refused all go on
screen as status text with `statusError` set; a stream that fails falls back
to the whole replay. Blocked audio is retried on the next page gesture, and
`click` is not the only one: iOS Safari does not deliver a click through event
delegation for a tap on an ordinary element, so `pointerdown`, `touchend` and
`keydown` are gestures too (`GESTURE_EVENTS` in `callRuntime.ts`).

One element plays every clip, and who holds it is one value, `holder`, with
one writer, `enter`:

| holder | phases | what it holds |
|---|---|---|
| `idle` | | nothing |
| `gap` | | the timer of the pause between two messages (`INTER_UTTERANCE_GAP_MS`, 0 today) |
| `replay` | `attaching`, `starting`, `playing`, `paused` | a whole replay's blob URL, its element handlers and its level meter; the silence watch while starting or playing; the `play()` attempt until it settles |
| `stream` | `attaching`, `opening`, `playing`, `paused`, `blocked` | its `MseSource` (`mseStream.ts`), handlers and meter; the open watch while opening, the silence watch while playing |
| `cutOff` | | a stream taken off the element while its bytes were still arriving: nothing plays before its whole replay, queued on its `audio_done` |

Moving to another holder releases what the old one put on the element:
handlers off, meter stopped, element unloaded, URL revoked. A stream that
played to its end leaves its finished source on the element for the next
clip's `src` to replace. Every handler, timer and `play()` callback names the
clip it belongs to and does nothing once that clip no longer holds the
element. The page is told playback is sounding (`isPlaying`) exactly while a
replay is starting or playing or a stream is playing, and the level meter
runs then too. The phase-by-event table in `tests/unit/audioPlayback.test.ts`
pins what each event does in each phase.

What plays next is decided in one place, `startNext`: a clip starts only when
nothing holds the element, the oldest whole replay first, then the next
stream. Every replay waiting is older than every stream waiting, so that is
arrival order. A clip's end (`afterClip`) waits the gap and starts what waits,
or says the idle line when nothing does. Streaming is `off`, `on` or
`refused`, written only by `setMode`. The silence watch is `ProgressWatch`
(`progressWatch.ts`), the level `PlaybackLevel` (`playbackLevel.ts`), and
every status line playback says is `PlaybackStatus` (`playbackStatus.ts`).

Every utterance keeps its bytes for the whole replay until it has played,
and `MAX_AUDIO_REPLAY` (64 MiB) bounds what is held at once: the utterances
arriving, streaming or waiting, the replays queued, and the replay on the
element. It is read from those (`heldBytes`), not kept as a count, so a clip
that leaves takes its bytes with it. A count that only a new leg reset
reached the cap after about 70 minutes of speech, and every reply after it
was silent (#431). `MAX_AUDIO_UTTERANCE` (32 MiB) bounds one utterance.

A clip that produced no sound is noticed whatever `play()` does with its
promise. `NO_PROGRESS_MS` is armed when the attempt is made, not when
`play()` resolves: WebKit takes a `MediaSource` of MP3, buffers every append,
never reaches `canplay`, and leaves `play()` pending for the rest of the call
(#203). A rejection that arrives after that watch gave up belongs to a clip
that is already gone and is not reported -- falling back reloads the element,
which aborts the pending `play()` itself.

The watch stays on for the whole clip, not just its start: a clip that
stopped advancing partway is reported the same way, and a stream falls back
to its whole replay (#213). `isPlaying`, and with it the presence's voice
indicator, clears at once, so the page never says it is speaking over
silence. A stream whose bytes are still landing holds the watch, since the
element may be waiting for them; a clip standing at its end whose `ended`
never came is finished, not stalled. A `pause` the page did not ask for (an
iPad's audio session taken for the microphone or another app, a lock-screen
control) stops a stream as it stops a replay: not playing, reported as an
error, resumed by the next page gesture.

A pause or a blocked `play()` is taken down once the clip sounds again: the
`play()` that the gesture made resolves, and either path reports "Audio
resumed." without the flag (`PlaybackStatus.resumed`, the one place for both). A
stream's end reports the idle line when nothing is queued, as a replay's end
does. Before this, a stream that recovered left the red card up over the
conversation until the next turn's status (#260).

A browser that takes a stream and cannot sound it is asked once. The first
named failure turns streaming off for the whole call -- later utterances go
straight to the whole replay with no silence watch and no second status line
-- and a reconnect's `hello_ack`, which offers MSE again, cannot turn it back
on: the engine does not change mid-call.

Streaming stops in one place (`stopStreaming`), whether a stream failed or a
`hello_ack` turned it off, and nothing it held is lost (#259). Every
utterance it held goes on as a whole replay, in order: one that is complete
is queued at once, and one still arriving falls back on its `audio_done`. A
complete stream that did not fail plays out, and the replays follow it; if
it fails while playing out, its own replay goes first. A replay that holds the
element is left alone. Before this, the utterances
queued behind a failed stream were never played or reported, and the queue
never drained, so hands-free never got its follow-up lease back.

A streamed utterance's `MediaSource` (`MseSource`, `mseStream.ts`) is
attached to the element as soon as it is made: a `MediaSource` is `closed` until an element takes its URL, and
`sourceopen` -- where the `SourceBuffer` is added and the chunks go in --
fires from that attach. Waiting for the event before attaching waits for an
event that cannot come, which is what made every page offering `mse_mp3`
(Chrome, an iPad) hear nothing at all. A source the engine leaves `closed`
with no error is caught too: the silence watch is armed on the attach, holds
once the source is open and waiting for bytes, and otherwise falls back with
"MediaSource did not open" (#259). A page offers it when it has a
`MediaSource` that supports `audio/mpeg`; Firefox does not and has always
taken the whole replay.

The chunks go into the `SourceBuffer` as whole MP3 frames. They come off the
socket cut anywhere, and an engine that parses each append on its own (WebKit
on an iPad) can mangle the frame an append splits: clicks, clipped syllables,
or a gap it will not play across (#213). `Mp3FrameAligner` (beside
`mp3FrameBoundary` in `speechEnvelope.ts`, the one MP3 frame table) hands on
every whole frame received and holds the part-frame after them for the next
chunk; `audio_done` flushes what is held, so every byte goes in. A stream it
cannot find frames in is passed through as it arrives, never held. The buffer
is put in `sequence` mode, which the MSE spec already gives an MPEG audio
buffer: each append is placed straight after the last.

A caption waits for the audio that voices it (#112) but never for audio that
is not coming. `SpokenLines` is told whether playback is sounding; while it is
not, every waiting line is heard `CAPTION_WAIT_MS` later, in order.

The agent's level has one reader in every engine (`playbackLevel.ts`, over
`speechEnvelope.ts`): the
utterance's own bytes. They are decoded off to the side in an
`OfflineAudioContext`, which needs no user gesture and no element, and
`EnvelopeMeter` reports the step the element's own `currentTime` has reached.
A complete replay is decoded in one go; a stream's chunks arrive on no frame
boundary, so `StreamingEnvelope` decodes every whole MP3 frame received so far
(`mp3FrameBoundary`) into one growing timeline that ends equal to the whole
clip's. The media element is never routed through Web Audio, in any engine:
that was a second implementation of one level, and routing an element through
`createMediaElementSource` while a `MediaSource` is attached is what silences
WebKit playback. A browser with no `OfflineAudioContext` draws flat bars; the
canned loop belongs to the demo scenes, which have no voice runtime at all.

Capture itself is in `src/runtime/pushToTalk.ts`, and its order is
load-bearing. The press creates the level meter's `AudioContext` -- that is
where a browser still grants it an audio session -- and asks for the
microphone, and nothing else: the meter's graph is built after
`recorder.start()` has returned, and `resume()` is never waited for. A meter
is a picture of the caller's voice, and a browser that cannot draw one still
has to record.

Push-to-talk is one machine (`PushToTalk`). Its `Phase` names where a press
is and holds what exists only there; `transition()` is the only writer, the
phase x event table in `tests/unit/pushToTalk.test.ts` pins it, and `leave()`
releases what the old phase holds and the new one does not:

| phase | holds | left by |
|---|---|---|
| `idle` | nothing | a press (`acquiring`) |
| `acquiring` | the press's meter context; `cancelled` once Send or Discard came during the prompt | the grant (`recording`, or `idle` when cancelled or no recorder can be made), the refusal (`idle`) |
| `recording` | the take: recorder, stream, meter, clip id, epoch and transfer stamp, chunks | Send or Discard (`stopping`), the recorder stopping by itself (`idle`, the clip sent, #262), a recorder error or a failed `start()` (`idle`) |
| `stopping` | the take, and whether to send it | the recorder's `stop` event (`idle`, sent or discarded), a recorder error (`idle`) |

Every way into `idle` runs `end()` in one order: push-to-talk has let go of
the microphone, `onActive(false)` lets hands-free take it back (#257), the
page is told it is not recording, then the clip goes to the outbox and one
status line says how the press ended. A recorder or permission callback
names its take or press, so one that arrives after its phase is dropped (a
recorder fires `stop` after its `error`). A second press while the
permission prompt is open is ignored.

## Extension strategy

Add a new content type in this order:

1. Define its semantic data type.
2. Implement one reusable primitive that takes the `slot` prop.
3. Draw it in `renderObject`, once for every slot.
4. Add it to scene composition rules: a visual type to `VISUAL_TYPES`, which names its scene, and its frame words to `sceneFrame` (`src/components/Scenes.tsx`).
5. Create a canonical fixture. Every fixture action must be one the validator accepts as written (`validation.test.ts`).
6. Add reducer or rendering tests.
7. Add visual references at approved geometries.

Do not add a dedicated page unless the content genuinely requires a new composition family.

# Personal AI Screen: Product and Frontend Contract

Switchboard is the screen of a personal AI, not a dashboard beside one.

The caller should be able to speak naturally, watch the interface organize itself
around the conversation, touch any visible control when that is faster, and trust
that the agent understands what is currently on screen. The intended feeling is
Tony Stark talking with JARVIS, expressed through a restrained NERV/Evangelion
visual language rather than a generic chat application.

This document records durable product behavior. Current implementation details
may change; the behavior below should not drift accidentally.

## Product principles

### The AI inhabits the screen

The interface is one continuous conversation surface. Speech, transcript,
activity, routes, controls, and visual artifacts are different expressions of
the same session, not separate applications arranged in permanent dashboard
panels.

The page should answer three questions at a glance:

1. Who am I speaking with?
2. What is happening now?
3. What does the AI want me to look at?

### Conversation is the resting state

When no visual artifact exists, the visual stage does not reserve an empty
rectangle. It collapses completely and the conversation uses the available
space.

A diagram, plan, timeline, or diff earns screen space only when it exists. The
stage materializes when that content arrives and remains available in visual
history afterward.

A handoff between legs is not a new conversation. When the operator patches the
caller through, or a project agent hands them back, the conversation stays on
screen and its route label changes; the screen never passes through the idle
page. What the old leg drew leaves with it, and the new leg's first response or
visual appears in place.

### Voice first, not voice only

Anything a caller can reasonably request aloud should also be reachable by
clicking or tapping. Both paths control the same workspace state.

Examples:

- "Pull up the diff" and tapping **Visual** select the same view.
- "Show the conversation" and tapping **Comms** select the same view.
- "Show system controls" and tapping **System** select the same view.
- "Give this the whole screen" and tapping **Theater** select the same view.
- "Reset the screen" and tapping the active control again return to **Auto**.

There must not be a separate voice-only layout model hidden behind the visible
controls.

### Every instrument tells the truth

NERV styling is identity, not permission to invent telemetry. A label, meter,
waveform, clock, alert, or node must be driven by real application state.
Decorative emergency switches, fake MAGI consensus, meaningless coordinates,
and ornamental counters do not belong in the interface.

The waveform represents actual interaction modes: idle, caller transmission,
AI playback, and error. Presence text reflects connection and work state. Route,
model, thinking level, activity, transcript, and visual provenance all come from
the live session.

### Dramatic, not noisy

The visual language uses black space, hard geometry, condensed headings,
monospace data, amber for active controls, cyan for information flow, and red for
recording or faults. Motion is mechanical and state-driven.

Drama comes from hierarchy and timing, not from filling every surface. Color is
never the only status indicator. Controls retain readable labels, keyboard
focus, touch targets, and reduced-motion behavior.

## Adaptive composition

The workspace has five canonical views:

| View | Purpose |
| --- | --- |
| `auto` | Compose around current content; conversation-only when no visual exists |
| `visual` | Give the current artifact priority while retaining communication context |
| `comms` | Prioritize transcript, activity, and voice controls |
| `system` | Prioritize route, model, thinking, and session controls |
| `theater` | Present the current visual with minimal surrounding chrome |

Legacy agent aliases such as `stage`, `bay2`, `transcript`, `routing`, `magi`,
and `overview` normalize to these canonical views.

### Focus precedence

Screen control follows a simple precedence rule:

1. **Explicit caller choice** is sticky.
2. **Agent direction** applies when the caller has not pinned a view.
3. **Automatic composition** handles everything else.

If the caller taps **Comms**, an agent cannot pull the screen away with a later
`view` request. Returning to **Auto** releases that pin. This preserves agency
without making voice navigation unreliable.

### Responsive behavior

- **Wide desktop:** visual and conversation can coexist when both are useful.
- **Tablet:** the selected focus becomes dominant and secondary content remains
  reachable without precise pointer work.
- **Narrow/mobile:** content becomes a single readable flow; system controls move
  below the conversation, and the visual fills the available width.
- **No visual:** all sizes remove the stage rather than display an empty frame.

Layouts should respond to content and intent, not merely shrink a fixed
three-column dashboard.

### Transcript text

The full transcript renders the conversation Markdown subset used by agents:
strong and emphasis, inline and fenced code, paragraphs, headings, lists, and
safe links. Links are limited to `http`, `https`, and `mailto`; they open in a
new tab with `noopener noreferrer`. Unsafe or malformed links show their label,
and model-provided HTML remains text. The live and spoken response surfaces
keep their existing non-navigable link behavior.

### The live response

The live response (the conversation answer, and the live card beside a
visual) shows what the caller is hearing, as a log of the recent spoken
sections in the card's own text area (#113): the section being heard in full
at the top of the box, with blank space below it, and the sections before it
above, out of view (#178). It holds the last 50 lines. The log keeps a box of
blank space under its newest section, which is what lets that section rest at
the top. It stays pinned to the newest section while sections arrive; the
caller can scroll back to read earlier ones, which unpins it, and scrolling
back down pins it again. A section taller than the window rests at its first
words, as every section does. Every section reads at one size -- the stage's
reading size, the size of the body text on the content beside it -- and the
sections differ only in colour (#188). Only spoken lines go
in it: written replies and tool output stay in the transcript drawer. A
reconnect starts it again from the lines the history marks as voiced.

A spoken line reaches the page twice, as text and as audio, and the two
travel apart: the text of a `speak()` line
comes once its audio has been sent, often while earlier lines are still
playing, and a voiced reply's text comes before its audio. So each `spoken`
frame and voiced `reply` names the audio utterance that voices it (`sequence`,
as on `audio_start`), and the page holds the line until playback reaches that
utterance: its turn to play comes, or it is dropped and will never play
(`runtime/spokenLines.ts`). Queued lines wait their turn, stitched speech
included. A line with no audio, such as the hangup notice, shows at once. A
new leg that cuts the audio off shows the lines that were waiting. The
transcript drawer takes every line as soon as its text arrives. It holds the
last 200 lines and follows the newest one the same way the log does
(`hooks/usePinnedScroll.ts`): scrolling up to reread unpins it, and scrolling
back to the bottom pins it again (#267).

## Shared screen-state contract

The browser reports the state it actually rendered over the existing WebSocket:

```json
{
  "type": "screen_state",
  "view": "visual",
  "has_visual": true,
  "visual_kind": "diff",
  "title": "Authentication changes",
  "stale": false
}
```

The backend stores the latest report. The agent's `view` tool has two forms:

- `view({ target, reason })` requests a composition change.
- `view({})` inspects the current composition, visual type/title, stale status,
  and whether a browser is connected.

This closes the loop: the agent can present content, move focus, and verify what
the caller can see. A view request is still a request; the browser enforces the
caller-pin precedence above.

## Visual artifacts

The visual channel supports fourteen content types: chart, metric, progress,
diagram, document, code, table, note, image (raster bytes inline), and the
personal-assistant calendar, tasks, timer, weather and inbox (see
`docs/visual-channel.md`).

Artifacts arrive during an agent turn as `display` calls from the
`switchboard` skill module, which the host agent relays over the host link,
and reach the page over the existing WebSocket, so they can appear while
work is still in progress. Lifecycle
generation changes mark the previous artifact stale rather than silently
presenting it as current.

Structured payloads are rendered with client-side components; arbitrary agent
HTML or scripts are not accepted. Structured diagrams and text are validated
server-side.

The agent composes and the page lays out. One object is the primary and owns
the main slot. Every other visual the agent shows is drawn: beside the primary
where its scene has a place for it (a compare chart beside a chart), and
otherwise in a row of framed cells under the primary. The row never takes the
larger share from a visual primary and never squeezes a visual below a
readable size; when it cannot show every cell, it scrolls inside its own
bounds. So no
visual that the agent's `view` lists is missing from the caller's screen.
`docs/visual-channel.md` ("Composition & focus") has the rules.

Notes are persistent visual annotations, not a second copy of conversation
output. Spoken/chat responses may occupy the transient explanation surface only
when no explicit note owns it. Notes can identify a semantic target in another
artifact, and only an explicit note update, hide, or clear changes them. Small
scene captions are content metadata rather than hard-coded instrumentation.

See `docs/display-tool.md` for payload limits and `docs/visual-channel.md` for
implemented visual forms.

## Current implementation map

The running client architecture:

- `static/index.html`: the built V17 shell and the wake-word import map
- `apps/frontend/src/App.tsx`: V17 presentation and semantic scene rendering
- `apps/frontend/src/components/Scenes.tsx`: the one scene shell every page is drawn in, and the main slot each composition fills
- `apps/frontend/src/controller/`: semantic state machine, reducer, and validation boundary
- `apps/frontend/src/integration/runtime.tsx`: connects the call runtime to the controller and reports screen state
- `apps/frontend/src/runtime/`: backend WebSocket, push-to-talk, playback, and hands-free wiring; audio levels feed the presence indicator through requestAnimationFrame without React state updates
- `apps/frontend/src/protocol.ts`: the WebSocket protocol in both directions; `apps/backend/src/protocol.rs` is the service's half, both directions
- `skills/switchboard/`: agent-facing `display` and `view` tools (the `switchboard` skill module)
- `apps/backend/src/browser.rs`, `page_controls.rs`, `module_calls.rs`: the WebSocket, the page controls, and the handlers for the agent's module calls

The compiled browser output in `static/` is committed. Do not introduce a UI
framework, state library, shader stack, or fake instrumentation unless a real
product need first exceeds the native DOM, CSS, Canvas, and WebSocket code.

## Review checklist

A frontend change should survive these questions:

- Does empty space collapse when it carries no information?
- Can the same result be reached by voice and by touch?
- Does caller choice still outrank agent direction?
- Can the agent inspect the resulting screen state?
- Is every displayed signal backed by real state?
- Is the primary action obvious from across a room and usable on a tablet?
- Does the interface remain useful when animation, audio, or diagram rendering
  is unavailable?

If not, the screen is becoming a dashboard again.

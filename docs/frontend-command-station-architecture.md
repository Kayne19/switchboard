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

The visual channel supports seven content types: chart, metric, progress,
diagram, document, code, and note.

Artifacts arrive during an agent turn over `POST /display` and the existing
WebSocket, so they can appear while work is still in progress. Lifecycle
generation changes mark the previous artifact stale rather than silently
presenting it as current.

Structured payloads are rendered with client-side components; arbitrary agent
HTML or scripts are not accepted. Structured diagrams and text are validated
server-side.

Notes are persistent visual annotations, not a second copy of conversation
output. Spoken/chat responses may occupy the transient explanation surface only
when no explicit note owns it. Notes can identify a semantic target in another
artifact, and only an explicit note update, hide, or clear changes them. Small
scene captions are content metadata rather than hard-coded instrumentation.

See `diagram-tool.md` for payload limits and `docs/visual-channel.md` for
implemented visual forms.

## Current implementation map

The running client architecture:

- `static/index.html`: the built V17 shell and the wake-word import map
- `apps/frontend/src/App.tsx`: V17 presentation and semantic scene rendering
- `apps/frontend/src/controller/`: semantic state machine, reducer, and validation boundary
- `apps/frontend/src/integration/runtime.tsx`: connects the call runtime to the controller and reports screen state
- `apps/frontend/src/runtime/`: backend WebSocket, push-to-talk, playback, and hands-free wiring
- `apps/frontend/src/protocol.ts`: browser/server message contract
- `extensions/agent-switchboard.ts`: agent-facing `display` and `view` tools
- `apps/backend/src/api.rs`: WebSocket state and HTTP tool endpoints

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
- Does the interface remain useful when animation, audio, or Mermaid rendering
  is unavailable?

If not, the screen is becoming a dashboard again.

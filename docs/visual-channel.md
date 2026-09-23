# Visual Channel Capabilities & Deferred Proposals

`diagram-tool.md` is the wire contract for the **general `display` channel**; this document records the implemented capabilities, the composition model, deferred proposals, and refused patterns.

## Core Principle

The visual stage exists to answer questions that are expensive to ask or answer out loud over audio. Visual payloads must compose with speech rather than compete with it (e.g. "I am on step three of five" is effective spoken prose because the screen presents the full plan).

The stage exists only while there is something real to show. With no artifact,
it collapses and conversation becomes the workspace. The same canonical views
(`auto`, `visual`, `comms`, `system`, `theater`) are controlled by visible
buttons and the agent's `view` tool. Explicit caller focus remains pinned until
the caller returns to Auto. The browser reports the resulting `screen_state`,
so an agent can inspect what is visible rather than assuming its request won.

`docs/frontend-command-station-architecture.md` is the product contract for
this composition behavior.

## Implemented: the general display channel

The agent has **one** `display` tool (not a per-kind menu). A call is a protocol
action — `op` + `id` + `type` + `role` + `data` — and the agent decides freely
what to show and how to compose it. The page owns pixels, theme, and layout; the
agent sends semantics. See `diagram-tool.md` for the full action protocol.

### Content types (the agent's palette)

| type | use |
| --- | --- |
| `diagram` | relationships and structure — structured graph data (`mode: "graph"`, nodes and edges with semantic states) |
| `chart` | quantitative trends (`bar`, `line`, `pie`, `spark`) |
| `metric` | a single tracked value with trend |
| `progress` | checklists, steps, states, and optional durations |
| `document` | headings, paragraphs, bullets, code blocks |
| `code` | code and diff views (`add`/`del`/`ctx` lines) |
| `note` | the agent's own words, without pretending to be the transcript |

Diagram node styling stays restricted to semantic classes and states, enforced server-side.

### Composition & focus

Objects carry a **role** (`primary`, `compare`, `secondary`, `ambient`) and a
stable agent-owned **id**. The page lays roles out in a responsive grid; the
agent can `focus` a region, `hide` an object, `say` an aside on it, or `clear`
the whole stage — one action per call. The old bespoke `plan`/`timeline`/`diff`
renderers are gone; `progress`, `document`, and `code` are the general primitives
that subsume them.

### Replay & state

A reconnecting browser is replayed the full current projection — every
visible object, the current focus, and any pending `say` — via
`DisplayProjection::snapshot_actions()`, not just the single most recent
action. `screen_state.has_visual` / `visual_kind` reflect what the browser
has actually confirmed, so an agent can verify its own display via `view`.

### Confirmed rendering: `seq`, the watermark, and honest results

Delivering an action to the browser is necessary but not sufficient — the
page still has to validate and paint it. Rather than take "sent" for "shown,"
the channel closes that gap with an explicit confirm/reject round trip.

**On the wire.** Every `display` frame the backend sends — live or replayed
on reconnect — is `{"type":"display","seq":<n>,"action":<normalized>}`.
`seq` is drawn from the same monotonic counter that sequences every
delivered event, stamped on just before the frame leaves
(`stamp_display_seq`). A reconnect snapshot stamps every replayed action
with the gate's watermark as of connect time, since the snapshot as a whole
represents the projection at that point in the stream.

**The browser's report.** The existing `screen_state` message (sent whenever
the page applies or declines a frame) carries two more fields:
- `applied_seq`: the highest `seq` the page has actually rendered so far
  (monotonic; it never regresses).
- `rejected` (optional): `{ seq, reason }` for a frame the page could not
  apply. It stays queued — not dropped — until the report that carries it is
  the one actually transmitted, so an intervening, rejection-less report
  can't silently swallow it.

**The backend's watermark.** `AppInner.display_confirm` is a
`tokio::sync::watch<ConfirmState>`:

```rust
pub struct ConfirmState {
    pub generation: u64,
    pub watermark: Option<u64>,   // None: nothing confirmed yet this generation
    pub rejection: Option<(u64, String)>,
}
```

Every `screen_state` report folds its `applied_seq` / `rejected` into this
watch as a running per-generation maximum. A route callback (a leg transfer)
resets it — `generation` moves to the new value, `watermark` goes back to
`None`, `rejection` clears — the same reset the projection itself gets
(`objects` / `order` / `focus_id` / `speech` cleared) — so a confirmation
left over from the leg that just transferred away can never satisfy a wait
started by the leg that replaced it.

**`POST /display`'s result.** After publishing the action and stamping its
`seq`, the handler waits up to ~2.5s (`DISPLAY_CONFIRM_DEADLINE_MS`) for that
`seq` to clear the watermark, then returns one of:
- `{"delivered": true, "rendered": true}` — the browser confirmed this `seq`.
- `{"delivered": true, "rendered": false, "rejected": true, "reason": "..."}`
  — the browser nacked this exact `seq`.
- `{"delivered": true, "rendered": false, "reason": "no confirmation from
  the browser"}` — the deadline passed with nothing seen.
- `{"delivered": true, "rendered": false, "reason": "the caller's screen
  moved to a new leg before this was confirmed"}` — the call transferred
  while the wait was in flight, so any confirmation still coming is for a
  generation the agent is no longer on.
- `{"delivered": false, "reason": "no browser connected"}` — nothing to wait
  on; the action is still recorded in the projection and greets the next
  connection.

**`POST /view` with no `target`.** Rather than ask the browser what is on
screen right now, `/view` reports the backend's *own* record of what it
believes it told the browser to show — the same projection that seeds a
reconnect — plus whether that intent is confirmed:

```
{ view, has_visual, visual_kind, title, object_ids, confirmed, connected, stale }
```

`confirmed` is `true` when nothing is on stage (trivially, there is nothing
outstanding to confirm) or when the confirm watermark for the *current*
generation has reached the projection's own watermark. `stale` is exactly
`!confirmed` — see the note below on why that is not the same as
`!connected`.

**Primary-visual precedence.** `DisplayProjection::summary()` (backend) and
the browser's `buildCompositionModel` in `sceneModel.ts` use one unified
rule to pick the object a `visual_kind` / `title` answer is about:

1. the focused object, if `focus` names one and it is still on stage;
2. otherwise the composition **primary**, computed over the objects
   currently on stage in the order they were `show`n:
   1. the first object with `role: "primary"`;
   2. else the first object that is not `role: "ambient"` (an unset role
      counts as non-ambient);
   3. else the first object shown, if any is on stage at all.

Focus always overrides the composition primary, for both `visual_kind` and
`title` — an agent that calls `focus` on an ambient or secondary object
still gets that object reported back. Absent a focus, `role: "primary"`
wins regardless of show order, and a later `show` never displaces an
earlier non-ambient object just by being more recent. The backend's `/view`
intent and the browser's own `screen_state` report are computed by the same
rule, so they agree on every composed scene, not just the common single-object
or single-`role:"primary"` case.

**`stale` is decoupled from `connected` — deliberately.** A visual can be
fully confirmed by a browser that has since disconnected: `confirmed: true`
(a past `screen_state` reached the current watermark) but `connected: false`
(no socket right now). Reporting `stale: true` in that case would be false —
the last thing that browser saw really is what the projection still holds —
so `stale` tracks confirmation only, and `connected` is reported alongside
it so the agent still learns the browser is gone and can judge what that
means for a caller who might reconnect.

## Deferred Payload Types

### Direct Binary Image Payload
- **Purpose**: transfer PNG/JPEG bytes directly over the socket for the stage.
- **Status**: deferred. Structured types cover the current needs; a binary image
  channel would expand the wire surface and is not required.

## Explicitly Refused Patterns

- **General Raw HTML / Arbitrary Markup**: refused. Arbitrary HTML exposes the
  page (which holds active WebRTC / WebSocket call state) to XSS via prompt
  injection from external repositories. All display renders from structured data
  controlled by client code, written via `textContent`.
- **Layout / style fields from the agent**: refused. Any `layout`, `style`, `css`,
  `className`, or geometry field in an action is rejected — the page owns pixels.
- **Ad-hoc or unversioned transport sprawl**: refused. The display channel is
  exposed cleanly via dedicated `POST /display` and `SWITCHBOARD_DISPLAY_URL`,
  validating every action at the boundary and reusing the existing browser
  WebSocket for live delivery.

## Resolved: the display extension hardships log

`DISPLAY_EXTENSION_ISSUES.md` recorded three problems found while dogfooding
the `display` tool before this phase. All three are resolved by the pieces
documented above:

1. **Schema validation confusion.** A `diagram` (or `document` / `note`)
   payload was rejected with an error that read like it wanted chart fields
   (`series`, `label`/`value`), regardless of the `type` actually sent. The
   validator now discriminates on `type` before checking shape, so a bad
   `diagram` payload is scored against the diagram schema and names which
   diagram field is wrong — not a chart's. See `diagram-tool.md`'s per-type
   `data` table and the `display` tool's per-type "Shapes" hint in
   `extensions/agent-switchboard.ts`.
2. **Silent failure: "On screen" when nothing rendered.** `/display` used to
   report success the moment the action was handed to the delivery layer,
   with no signal that the browser ever actually painted it. That is exactly
   the gap the confirm/reject round trip above closes: `/display` now waits
   for the browser's own `applied_seq` to reach the action's `seq` before
   calling it rendered, and the `display` tool's result text distinguishes
   "On screen." from "Sent, but the caller's screen has not confirmed it" and
   from an outright rejection carrying its reason.
3. **`view` contradicting what the caller actually saw.** The `view` tool
   used to report whatever the agent had last requested, independent of
   whether the browser ever confirmed it — so "Screen is in auto view with
   chart" could be true of the agent's intent and false of the caller's
   screen at the same moment. `/view` with no target now reports that intent
   *and* a `confirmed` flag computed from the same watermark `/display`
   waits on, and the tool text says "has not confirmed it yet" instead of
   asserting success.

The log itself stays in place with a note pointing here, rather than being
deleted, since it is the dogfooding evidence this phase was built to answer.

# Visual Channel Capabilities & Deferred Proposals

`docs/diagram-tool.md` is the wire contract for the **general `display` channel**; this document records the implemented capabilities, the composition model, deferred proposals, and refused patterns.

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
agent sends semantics. See `docs/diagram-tool.md` for the full action protocol.

### Content types (the agent's palette)

| type | use |
| --- | --- |
| `diagram` | relationships and structure — **Mermaid is one diagram `kind`** (`flowchart`, `sequenceDiagram`, `stateDiagram-v2`, `timeline`/`gantt`, `gitGraph`, `erDiagram`, `mindmap`) |
| `chart` | quantitative trends (`bar`, `line`, `pie`, `spark`) |
| `metric` | a single tracked value with trend |
| `progress` | the old `plan`/`timeline` checklists (steps, states, optional durations) |
| `document` | headings, paragraphs, bullets, code blocks |
| `code` | the old `diff` view (`add`/`del`/`ctx` lines) |
| `note` | the agent's own words, without pretending to be the transcript |

Mermaid node styling stays restricted to the four semantic classes
(`:::active`, `:::done`, `:::blocked`, `:::muted`), enforced server-side.

### Composition & focus

Objects carry a **role** (`primary`, `compare`, `secondary`, `ambient`) and a
stable agent-owned **id**. The page lays roles out in a responsive grid; the
agent can `focus` a region, `hide` an object, `say` an aside on it, or `clear`
the whole stage — one action per call. The old bespoke `plan`/`timeline`/`diff`
renderers are gone; `progress`, `document`, and `code` are the general primitives
that subsume them.

### Replay & state

The last successful action is replayed to a reconnecting browser (`last_display`)
and `screen_state.has_visual` / `visual_kind` reflect what is actually shown, so
an agent can verify its own display via `view`.

## Deferred Payload Types

### Direct Binary Image Payload
- **Purpose**: transfer PNG/JPEG bytes directly over the socket for the stage.
- **Status**: deferred. Structured types cover the current needs; a binary image
  channel would expand the wire surface and is not required.

## Explicitly Refused Patterns

- **General Raw HTML / Arbitrary Markup**: refused. Arbitrary HTML exposes the
  page (which holds active WebRTC / WebSocket call state) to XSS via prompt
  injection from external repositories. All display renders from structured data
  controlled by client code, written via `textContent`; Mermaid runs
  `antiscript`.
- **Layout / style fields from the agent**: refused. Any `layout`, `style`, `css`,
  `className`, or geometry field in an action is rejected — the page owns pixels.
- **Adding Environment Variables or Endpoint Overheads**: refused. The whole
  channel multiplexes over `POST /diagram` and the existing socket so the
  environment-file contract between Switchboard and `homelab` is unchanged.

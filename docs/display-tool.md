# The `display` channel & Visual Stage

A project agent pushes anything it wants the caller to *see* — a diagram, a chart, a metric, a progress list, a document, code, or a plain note — to the caller's page mid-turn, the same way it pushes speech. The caller sees it render while the agent is still working. **The agent chooses what to show and how it is composed; the page owns the pixels.** `docs/visual-channel.md` is the product/capability companion to this wire contract.

## Wire shape and transport

A project agent calls `switchboard.display(action)` from the `switchboard` Python skill module (`skills/switchboard/`). The module sends the canonical `DisplayAction` to the host agent on the host's skill socket, and the host agent relays it to the service with the current call token (`docs/host-link.md`, "Skill socket" and "Module calls"):

| piece | contract |
| --- | --- |
| agent call | `switchboard.display(action)` or `switchboard.display(**action)` |
| skill socket request | `{ op: "call", call: "display", token, args: { action } }` |
| view | `switchboard.view(target=None)`, sent as `call: "view"` |
| service intake endpoint | `POST /display` (outer envelope: `{ token, action }`) |
| broadcast | `{"type":"display","action":<normalized>}` |

`display` replaces separate per-kind tools with a single semantic function. One call carries exactly one `DisplayAction`.

The module checks only the outline of an action before it sends it: the `op`, the `type` and `role` names, and the required `data` keys of each type. A wrong one raises (`ValueError` or `TypeError`) with the shape of each type as a hint, because it is a programming error. The service validation below is authoritative; the module returns its rejection as a `refused` result with the reason, and never raises for it.

## The DisplayAction v1 protocol

Every action is a discriminated union member:

```ts
type DisplayAction =
  | { op: 'show'; id: string; type: AgentObjectType; role?: SceneObjectRole; data: unknown }
  | { op: 'hide'; id: string }
  | { op: 'focus'; id: string }
  | { op: 'say'; text: string; target?: string; at?: { x?: number; series?: string } | null }
  | { op: 'clear' };
```

- **ops** (one per call): `show | focus | hide | clear | say`. There is **no** `listen` on this public channel (`listen` is internal-only).
- **content types** (for `show`): `chart | metric | progress | diagram | document | code | note`. `message` is a runtime-owned transcript, **not** an agent display type.
- **roles** (composition slot): `primary | compare | secondary | ambient`.
- **`id`**: agent-owned and stable across updates (re-sending the same `id` replaces the object in place). Agent IDs must not begin with the reserved `__runtime/` namespace.
- **`target`**: the object id to anchor a `say` action (must not begin with `__runtime/`).
- **`at`**: speech anchor object containing at least one of `x` (finite number) and `series` (string <= 128 UTF-16 code units), or explicit `null`; omitted `at` normalizes to `null`.
- **`caption`**: optional content-owned supporting text (<= 128 UTF-16 code units) rendered in the scene's small corner label. It is available on every `show` data shape.
- **`note.anchor`**: optional persistent annotation target `{ target, x?, series?, node? }`. `target` is another display object id; the remaining fields identify a semantic location inside a chart or diagram without prescribing pixels.

### show (create or update)
```json
{
  "op": "show",
  "id": "arch",
  "type": "diagram",
  "role": "primary",
  "data": {
    "mode": "graph",
    "nodes": [
      { "id": "a", "label": "Client" },
      { "id": "b", "label": "Server" }
    ],
    "edges": [
      { "from": "a", "to": "b", "label": "HTTP" }
    ]
  }
}
```

### focus / hide / clear / say
```json
{ "op": "focus", "id": "arch" }
{ "op": "hide",  "id": "arch" }
{ "op": "clear" }
{ "op": "say",   "text": "watch the connection edge", "target": "arch", "at": { "series": "HTTP" } }
```

## Content types

| type | `data` shape (`additionalProperties: false`) | what the page renders |
| --- | --- | --- |
| `chart` | `{ series: [{ name, values[], semantic? }], title?, subtitle?, context?, caption?, xLabel?, yLabel?, xMax?, yMin?, yMax?, marker?, compareLabel? }` | SVG chart |
| `metric` | `{ label, value, semantic?, caption?, trend?: "up"\|"down"\|"flat", delta? }` | numeric gauge; `trend` draws an arrow and `delta` (<= 32) the change beside the value, both in the value's colour |
| `progress` | `{ label, value?, detail?, text?, caption?, steps?: [{ label, state?: "done"\|"active"\|"todo"\|"blocked", detail? }] }`; `value` is a percent, 0–100; at least one of `value`/`steps` | progress bar, with the step list under it (see below) |
| `diagram` | `{ mode: "graph", nodes: [{ id, label, sub?, detail?, semantic?, state? }], edges: [{ from, to, label?, semantic?, active? }], title?, subtitle?, context?, caption? }` | SVG semantic graph |
| `document` | `{ subject, paragraphs: string[], kind?: "email"\|"document", context?, caption?, source?, from?, timestamp? }` | document reader; each paragraph is read as Markdown (see below) |
| `code` | `{ source: { text, language?, highlight? }, title?, file?, context?, caption? }` | syntax/diff view |
| `note` | `{ segments: [{ text, accent?, bold?, semantic? }], tag?, caption?, anchor?: { target, x?, series?, node? } }` | persistent annotation |

Each document paragraph is read as the same small Markdown subset the conversation surfaces use (`apps/frontend/src/primitives/markdown.ts`): `#` headings (shown as a bold line), `**bold**`, `*italic*`, `` `inline code` ``, `-` and `1.` lists, and fenced code blocks. A newline inside a paragraph is a line break; a blank line starts a new paragraph. It is never HTML: markup stays literal text, and a link shows only its label.

A composed scene is built from multiple `show` actions with distinct `id`s and roles (e.g. `diagram` as `primary`, `note` as `secondary`, `metric` as `ambient`). The page owns layout, geometry, and styling.

Notes have their own display lifecycle. A chat or spoken response does not update an existing note; only another `show` using the note's stable id, `hide`, or `clear` changes it. An anchored note is selected for the visual object it targets and, when the target exposes the requested semantic coordinate, is placed near that location by the page.

### Progress steps
- `steps`: 1 to 30 items, each `{ label (<= 128), state?, detail? (<= 256) }`. A step without a `state` reads as `todo`.
- When `steps` is present, `value` may be left out: both validators fill it in as the share of steps whose state is `done` (`done / total * 100`, rounded to two decimals), so the normalized action and the page always carry a value. A `value` sent beside `steps` is kept as sent. A progress with neither is rejected (`progress requires value or steps`).
- The page draws the bar as before and lists the steps under it with a glyph per state. A compact slot (the rail, a cell in the aux row) shows a window of a few steps around the first step still open and counts the rest; the main slot and focus list the whole plan, scrolling inside the frame when it is long.

### Diagram v1 rules
- Diagram data requires `mode: "graph"`. Mermaid source (`source`) is rejected/deferred in v1.
- `nodes`: 1 to 100 items. Node IDs must be unique strings (1-128 UTF-16 code units).
- `edges`: 0 to 200 items. Both `from` and `to` endpoints must exist in `nodes`. Self-loops (`from === to`) and duplicate `(from, to)` pairs are rejected.

## Canonical schema & validation rules

The canonical contract is defined in `docs/display-action-v1.schema.json` and exercised by `apps/frontend/tests/fixtures/display-actions.json`. Both the TypeScript frontend validator (`apps/frontend/src/controller/validation.ts`) and the Rust backend validator (`apps/backend/src/visual_protocol.rs`) enforce identical rules:

- **Action size**: Serialized action JSON must not exceed **48,000 UTF-8 bytes** (HTTP request body <= 64 KiB).
- **String caps (UTF-16 code units)**: `id` <= 128; `text` <= 50,000; short labels/tags <= 128; titles/details <= 256. Astral Unicode characters (such as emojis) count as 2 UTF-16 code units.
- **Numbers**: All numbers must be finite; `NaN`, `Infinity`, and `-Infinity` are rejected.
- **Layout rejection**: Recursive rejection of `layout`, `style`, `css`, `className`, `width`, `height`, `left`, `right`, `top`, `bottom`.
- **Reserved namespace**: Agent IDs must not begin with `__runtime/`.
- **Safety**: Raw HTML/JS markup (`<script`, `<iframe`, `javascript:`, etc.) and external resource URLs (`http://`, `https://`, `//`) are rejected.
- **Unknown fields**: All schema branches specify `additionalProperties: false`; unexpected fields are rejected.

`docs/display-action-v1.schema.json` encodes as much of this as declarative JSON Schema can express (the progress rule "one of `value`/`steps`" is its `anyOf`), and `apps/frontend/tests/unit/schema.test.ts` holds it to `display-actions.json` fixture-by-fixture so it cannot drift from the two validators unnoticed. Three things it cannot express, so it does not attempt to: diagram invariants that span sibling array items (duplicate node IDs, an edge endpoint naming no node, a self-loop, a duplicate edge pair — each a relationship between items, not one item's shape); the 48,000-byte action-size cap, which bounds the serialized envelope on the wire rather than the parsed instance; and the UTF-16-code-unit string caps above for content containing astral characters, since JSON Schema's `maxLength` counts Unicode code points. Those stay enforced only by `validation.ts` and `visual_protocol.rs`; the test names each as a documented, asserted exception (`KNOWN_SCHEMA_GAPS`) rather than silently passing.

Rejections return `{"delivered":false,"detail":"<reason>"}` and are neither stored in display state nor broadcast.

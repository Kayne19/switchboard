# The `display` channel & Visual Stage

A project agent pushes anything it wants the caller to *see* — a diagram, a chart, a metric, a progress list, a document, code, or a plain note — to the caller's page mid-turn, the same way it pushes speech. The caller sees it render while the agent is still working. **The agent chooses what to show and how it is composed; the page owns the pixels.** `docs/visual-channel.md` is the product/capability companion to this wire contract.

## Wire shape and transport

The agent tool `display` posts an envelope containing the current leg token and the canonical `DisplayAction`:

| piece | contract |
| --- | --- |
| env var handed to the agent | `SWITCHBOARD_DISPLAY_URL` |
| intake endpoint | `POST /display` (outer envelope: `{ token, action }`) |
| view endpoint | Derived via `new URL("/view", DISPLAY_URL)` |
| broadcast | `{"type":"display","action":<normalized>}` |

`display` replaces separate per-kind tools with a single semantic tool. The parameters passed to `display` represent exactly one `DisplayAction`.

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
| `metric` | `{ label, value, semantic?, caption? }` | numeric gauge |
| `progress` | `{ label, value, detail?, text?, caption? }`; `value` is a percent, 0–100 | progress indicator |
| `diagram` | `{ mode: "graph", nodes: [{ id, label, sub?, detail?, semantic?, state? }], edges: [{ from, to, label?, semantic?, active? }], title?, subtitle?, context?, caption? }` | SVG semantic graph |
| `document` | `{ subject, paragraphs: string[], kind?: "email"\|"document", context?, caption?, source?, from?, timestamp? }` | document reader |
| `code` | `{ source: { text, language?, highlight? }, title?, file?, context?, caption? }` | syntax/diff view |
| `note` | `{ segments: [{ text, accent?, bold?, semantic? }], tag?, caption?, anchor?: { target, x?, series?, node? } }` | persistent annotation |

A composed scene is built from multiple `show` actions with distinct `id`s and roles (e.g. `diagram` as `primary`, `note` as `secondary`, `metric` as `ambient`). The page owns layout, geometry, and styling.

Notes have their own display lifecycle. A chat or spoken response does not update an existing note; only another `show` using the note's stable id, `hide`, or `clear` changes it. An anchored note is selected for the visual object it targets and, when the target exposes the requested semantic coordinate, is placed near that location by the page.

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

Rejections return `{"delivered":false,"detail":"<reason>"}` and are neither stored in display state nor broadcast.

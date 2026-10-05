# The `display` channel & Visual Stage

A project agent pushes anything it wants the caller to *see* — a diagram, a chart, a metric, a progress list, a document, code, a table, an image, or a plain note — to the caller's page mid-turn, the same way it pushes speech. The caller sees it render while the agent is still working. **The agent chooses what to show and how it is composed; the page owns the pixels.** `docs/visual-channel.md` is the product/capability companion to this wire contract.

## Wire shape and transport

A project agent calls `switchboard.display(action)` from the `switchboard` Python skill module (`skills/switchboard/`). The module sends the canonical `DisplayAction` to the host agent on the host's skill socket, and the host agent relays it to the service with the current call token (`docs/host-link.md`, "Skill socket" and "Module calls"):

| piece | contract |
| --- | --- |
| agent call | `switchboard.display(action)` or `switchboard.display(**action)` |
| skill socket request | `{ op: "call", call: "display", token, args: { action } }` |
| view | `switchboard.view(target=None)`, sent as `call: "view"` |
| service intake | the host agent's `module_call` with `call: "display"` on the host link (`docs/host-link.md`, "Module calls"), carrying the call token and `{ action }` |
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
- **content types** (for `show`): `chart | metric | progress | diagram | document | code | table | note | image`. `message` is a runtime-owned transcript, **not** an agent display type.
- **roles** (composition slot): `primary | compare | secondary | ambient`.
- **`id`**: agent-owned and stable across updates (re-sending the same `id` replaces the object in place). Agent IDs must not begin with the reserved `__runtime/` namespace.
- **`target`**: the object id to anchor a `say` action (must not begin with `__runtime/`); `null` is the same as no target and is dropped.
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
| `chart` | `{ series: [{ name, values[], semantic? }], kind?: "line"\|"bar"\|"area"\|"scatter", labels?: string[], title?, subtitle?, context?, caption?, xLabel?, yLabel?, xMax?, yMin?, yMax?, marker?, compareLabel? }` | SVG chart; see "Chart v1 rules" |
| `metric` | `{ label, value, semantic?, caption?, trend?: "up"\|"down"\|"flat", delta? }` | numeric gauge; `trend` draws an arrow and `delta` (<= 32) the change beside the value, both in the value's colour |
| `progress` | `{ label, value?, detail?, text?, caption?, steps?: [{ label, state?: "done"\|"active"\|"todo"\|"blocked", detail? }] }`; `value` is a percent, 0–100; at least one of `value`/`steps` | progress bar, with the step list under it (see below) |
| `diagram` | `{ mode: "graph", nodes: [{ id, label, sub?, detail?, semantic?, state? }], edges: [{ from, to, label?, semantic?, active? }], title?, subtitle?, context?, caption? }` or `{ mode: "sequence", actors: [{ id, label, sub?, semantic? }], messages: [{ from, to, label, kind?, active? }], title?, subtitle?, context?, caption? }` | SVG semantic graph, or SVG sequence diagram |
| `document` | `{ subject, paragraphs: string[], kind?: "email"\|"document", context?, caption?, source?, from?, timestamp? }` | document reader; each paragraph is read as Markdown (see below) |
| `code` | `{ source: { text, language?, highlight? }, title?, file?, context?, caption? }` | syntax/diff view |
| `table` | `{ columns: [{ label, semantic? }], rows: Cell[][], highlight?: number[], title?, subtitle?, context?, caption? }`; `Cell = string \| number \| { text, semantic?, bold? }` | ruled data table in a scroll viewport (see below) |
| `note` | `{ segments: [{ text, accent?, bold?, semantic? }], tag?, caption?, anchor?: { target, x?, series?, node? } }` | persistent annotation |
| `image` | `{ format: "png"\|"jpeg"\|"webp", bytes: <standard base64>, alt, title?, subtitle?, context?, caption? }` | raster figure, contained, with its alt text and decoded size |

Each document paragraph is read as the same small Markdown subset the conversation surfaces use (`apps/frontend/src/primitives/markdown.ts`): `#` headings (shown as a bold line), `**bold**`, `*italic*`, `` `inline code` ``, `-` and `1.` lists, and fenced code blocks. A newline inside a paragraph is a line break; a blank line starts a new paragraph. It is never HTML: markup stays literal text, and a link shows only its label.

A composed scene is built from multiple `show` actions with distinct `id`s and roles (e.g. `diagram` as `primary`, `note` as `secondary`, `metric` as `ambient`). The page owns layout, geometry, and styling. Every visual beside the primary is drawn, whatever the primary's type: a chart beside a chart primary shares its row, and any other one takes a cell in the aux row under the primary (`docs/visual-channel.md`, "Composition & focus").

Notes have their own display lifecycle. A chat or spoken response does not update an existing note; only another `show` using the note's stable id, `hide`, or `clear` changes it. An anchored note is selected for the visual object it targets and, when the target exposes the requested semantic coordinate, is placed near that location by the page. On a chart the page keeps the note clear of the chart's data; where the primary chart leaves a note no clear place near its point, one note is shown in the rail and its point stays ringed (`docs/visual-channel.md` lists the limits).

### Chart v1 rules
- `kind` is how the series are drawn: `line` (the default), `bar`, `area` or `scatter`. Anything else is rejected.
- `labels`: 1 to 100 categorical x labels, each a string of at most 64 UTF-16 code units. When present the x domain is the label indices (`0` to `labels.length - 1`), the x ticks are the labels, and `xMax` is ignored. Every `series.values` must be no longer than `labels`; a shorter series ends early.
- `marker.x`, a note's `anchor.x` and `say at.x` name a label index on a labelled chart, and the numeric x otherwise.
- Bars are grouped per category across the series. A bar chart without `labels` takes the value indices as its categories, so `xMax` is ignored there too. Whether bars run up or across is the page's decision (`docs/visual-channel.md`).

### Progress steps
- `steps`: 1 to 30 items, each `{ label (<= 128), state?, detail? (<= 256) }`. A step without a `state` reads as `todo`.
- When `steps` is present, `value` may be left out: both validators fill it in as the share of steps whose state is `done` (`done / total * 100`, rounded to two decimals), so the normalized action and the page always carry a value. A `value` sent beside `steps` is kept as sent. A progress with neither is rejected (`progress requires value or steps`).
- The page draws the bar as before and lists the steps under it with a glyph per state. A cell in the aux row shows a window of a few steps around the first step still open and counts the rest. In the rail a progress reads as the metrics above it: a row with its label and the share done, the bar, one row counting the steps done, and a row per step still to do, a few at most. As the primary it is framed to its own height and centred in the column. The main slot and focus list the whole plan, scrolling inside the frame when it is longer than the slot.

### Diagram v1 rules
- Diagram data requires `mode: "graph"` or `mode: "sequence"`; both validators read `mode` first and judge the rest by that mode's rules. Mermaid source (`source`) is rejected/deferred in v1 in either mode.
- `mode: "graph"`:
  - `nodes`: 1 to 100 items. Node IDs must be unique strings (1-128 UTF-16 code units).
  - `edges`: 0 to 200 items. Both `from` and `to` endpoints must exist in `nodes`. Self-loops (`from === to`) and duplicate `(from, to)` pairs are rejected.
  - `actors` and `messages` are rejected by name.
- `mode: "sequence"`:
  - `actors`: 1 to 12 items, `{ id, label, sub?, semantic? }`. Actor IDs must be unique strings (1-128 UTF-16 code units); `label` and `sub` are <= 256.
  - `messages`: 0 to 100 items, `{ from, to, label, kind?, active? }`, drawn in the order given. `from` and `to` name actors; `label` is required (<= 256); `kind` is `call` (default), `return` or `async`; `active` is a boolean. A self-message (`from === to`) and a repeated `(from, to)` pair are both allowed.
  - `nodes` and `edges` are rejected by name.
- `note.anchor.node` may name a node id or an actor id. The graph places a fitting note as a callout beside its node when the drawing fits its viewport; otherwise, and always for a sequence, the note stays in the rail and the node or actor carries a NOTE marker, the twin of the rail note's badge.
- Size is the page's decision. A diagram is never drawn with its text below the page's smallest type; one too large for that is recomposed for its viewport and scrolls inside it, and focus gives it the whole stage (`docs/visual-channel.md`, "Diagrams that outgrow the frame"). A diagram that scrolls opens on the node or actor its note names, rests only where no node is cut at the edge it is read from, counts on each edge what lies past it, names where an edge leaving the view goes, and carries a map of the whole. An agent may send the diagram the explanation needs; it does not have to trim it to fit a screen, and a node it names in a note is the one the caller sees first.

### Table v1 rules
- `columns`: 1 to 12 items, each `{ label, semantic? }` with `label` <= 64 UTF-16 code units. A column's `semantic` colours its header; a cell's `semantic` colours that cell.
- `rows`: 0 to 200 items. Every row is an array of exactly `columns.length` cells; a ragged row is rejected with its index.
- A cell is a string (<= 256 UTF-16 code units), a finite number, or `{ text, semantic?, bold? }` with `text` <= 256. A number is shown as its text.
- `highlight`: row indices (integers in `0..rows.length`) the page draws with the accent. An index naming no row is rejected.
- There is no `align`: the page right-aligns a column whose cells are all numeric (a number, or text that reads as one with a unit or a currency sign, such as `12.4s`, `91%` or `$1,200`), and left-aligns the rest.

### Image v1 rules
- `format` is `png`, `jpeg` or `webp`. `svg` is refused: SVG is markup and can carry script, and an image here is raster bytes only.
- `bytes` is strict standard base64 (`A-Za-z0-9+/`, `=` padding, length a multiple of 4, no whitespace, no `data:` prefix) and decodes to at most **8 MiB**. Both validators decode its first 12 bytes and check that they carry `format`'s file signature (PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, WebP `RIFF....WEBP`).
- `alt` is required (non-blank, <= 256). It is the image's alt text and its title when `title` is absent (in the scene heading and in `view`'s report).
- No `width`, `height`, zoom or crop: the page reads the intrinsic size when the bytes decode and fits the figure to its slot.
- The page builds `data:image/<format>;base64,<bytes>` itself from the validated fields; no other `img` source exists, and nothing is fetched.
- The skill module takes a file or raw bytes: `display(op="show", id="fig", type="image", data={"path": "/tmp/fig.png", "alt": "..."})` (or `data={"bytes": <bytes>, "alt": ...}`) sniffs the format, base64-encodes the bytes and sends `format`/`bytes`; the path is never sent.

The page lays a graph out in layers along the reading axis (left to right in landscape, top to bottom in portrait) and owns every pixel of it: cycles are fine (a feedback edge is drawn back toward its target), a long edge threads between the nodes of the layers it skips, each node's box grows to its text, a crowded layer is staggered into two rows, and every edge ends in an arrowhead at a port of its own. A graph too large to read whole scrolls; there an edge longer than the viewport is drawn as a stub pair naming its far ends (`-> target` by its source, `source ->` by its target, with the edge's label under the name), and so are the longest of more than four long edges running side by side (`docs/visual-channel.md`). A node's `state` is visible: `done` recedes with a check in its corner tag, `active` is lit, `blocked` is framed in red with a cross, and `todo` is the plain frame.

## Canonical schema & validation rules

The canonical contract is defined in `docs/display-action-v1.schema.json` and exercised by `apps/frontend/tests/fixtures/display-actions.json`. Both the TypeScript frontend validator (`apps/frontend/src/controller/validation.ts`) and the Rust backend validator (`apps/backend/src/visual_protocol.rs`) enforce identical rules, down to the text of each error; `apps/frontend/tests/fixtures/validator-corpus.json` pins that (see "How the two validators agree" below):

- **Action size**: Serialized action JSON must not exceed **48,000 UTF-8 bytes**, except a `show` of type `image`, whose cap is **12 MiB** (`MAX_IMAGE_ACTION_BYTES`; its raw bytes are capped at 8 MiB). The bytes are counted as `JSON.stringify` writes the action, so a number counts as JavaScript spells it (`1.0` counts as `1`, `1e16` as `10000000000000000`), and the cap holds for the normalized action too: a `say` sent within a few bytes of the cap can be refused because normalizing adds `"at":null`. A display action reaches the service as a module call over the host link, whose frames are at most 16 MiB; the host agent's skill socket accepts request lines up to 13 MiB, so the relayed frame always fits.
- **String caps (UTF-16 code units)**: `id` <= 128; `text` <= 50,000; short labels/tags <= 128; titles/details <= 256. Astral Unicode characters (such as emojis) count as 2 UTF-16 code units.
- **Numbers**: All numbers must be finite; `NaN`, `Infinity`, and `-Infinity` are rejected.
- **Layout rejection**: Recursive rejection of `layout`, `style`, `css`, `className`, `width`, `height`, `left`, `right`, `top`, `bottom`.
- **Reserved namespace**: Agent IDs must not begin with `__runtime/`.
- **Safety**: Raw HTML/JS markup (`<script`, `<iframe`, `javascript:`, etc.) and external resource URLs are rejected in any string. A URL is any `scheme://` (`https://`, `ftp://`, `s3://`, `file:///`), a string that starts with `//`, or a `//` followed by a host name with a dot and a top-level part of two letters or more (`see //cdn.example.com`). A `//` with no host after it (`a // comment`) is text.
- **Unknown fields**: All schema branches specify `additionalProperties: false`; unexpected fields are rejected.

`docs/display-action-v1.schema.json` encodes as much of this as declarative JSON Schema can express (the progress rule "one of `value`/`steps`" is its `anyOf`), and `apps/frontend/tests/unit/schema.test.ts` holds it to `display-actions.json` fixture-by-fixture so it cannot drift from the two validators unnoticed. Five things it cannot express, so it does not attempt to: invariants that span sibling array items (duplicate node or actor IDs, an edge or message endpoint naming no node or actor, a self-loop, a duplicate edge pair, a table row with other than `columns.length` cells, a table highlight naming no row — each a relationship between items, not one item's shape); a chart series' value count against its `labels` count, a relationship between two sibling fields; the action-size caps (48,000 bytes, 12 MiB for an image), which bound the serialized envelope on the wire rather than the parsed instance; the UTF-16-code-unit string caps above for content containing astral characters, since JSON Schema's `maxLength` counts Unicode code points; and an image's format/signature match, a cross-field check over decoded bytes (the schema pins the base64 alphabet, padding and length only). Those stay enforced only by `validation.ts` and `visual_protocol.rs`; the test names each as a documented, asserted exception (`KNOWN_SCHEMA_GAPS`) rather than silently passing.

The schema cannot state the blank rule, the key order or the text of an error either; the corpus pins those, and `schema.test.ts` also holds the schema to accept every action the corpus accepts, so the schema is never the stricter of the three.

A refused action comes back to the agent as a `refused` result whose reason is the validator's error, word for word (the service answers `{"delivered":false,"detail":"<reason>"}`). It is neither stored in display state nor broadcast.

### How the two validators agree

Every action is checked twice: by the service (`visual_protocol.rs`) when it arrives, and by the page (`validation.ts`) when the normalized action reaches it. If the two disagreed, the agent would be told "accepted" for an action the page then refuses, or the reverse. So both give the same answer, and the same error text, for every action.

`apps/frontend/tests/fixtures/validator-corpus.json` is the record. Each case is an action and its exact error, or its acceptance and its normalized form. Both suites run every case (`apps/frontend/tests/unit/validatorCorpus.test.ts`, and `agrees_with_the_shared_validator_corpus` in `apps/backend/tests/test_visual_protocol.rs`), and an accepted action must pass a second time unchanged. The skill module's outline check runs the same cases (`skills/switchboard/tests/test_switchboard.py`): it never refuses an action the validators accept. A rule change lands with the corpus cases that show it, so both sides change together.

These rules decide which error an action gets:

1. **Order of the checks.** The action is an object; it is within its size cap; its `op` is known. Then, anywhere in the action: no layout key, no unsafe string, no non-finite number. Then the op's own fields: for a `show`, its unknown keys, `id`, `type`, `role` and `data`, and inside `data` the unknown keys first and then each field in a fixed order (the corpus's `*_order_*` cases pin it). Last, the normalized action is held to the same size cap.
2. **Order of the keys.** Where two keys could each give the error (two unknown fields, two layout keys, two unsafe strings), both sides walk an object's keys in code point order, depth first, and name the first one met: `{"zeta": 1, "alpha": 2}` is `unknown field in ...: alpha`, wherever the agent put it. Arrays go in index order. The service sorts the keys itself rather than rely on its JSON map's order, and the page compares code points, not UTF-16 units.
3. **Blank.** An `id`, a `target`, a node or actor id, an anchor target and an image `alt` must not be blank: empty, or made only of Unicode White_Space. That is these 25 code points and no others: U+0009 to U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F and U+3000. U+FEFF, U+200B, U+180E and U+001C to U+001F are not whitespace here. (JavaScript's `trim` strips U+FEFF and keeps U+0085, so neither side uses it.) A `say` text need only be non-empty.
4. **A wrong type is refused, never dropped.** An optional field of the wrong type, such as a number for a node's `sub` or `null` for a `semantic`, is refused on both sides. Neither side drops the field and accepts the rest. The one place `null` is allowed is a `say`'s `target` and `at`, where it means "none" (see the protocol section above).
5. **Numbers, size and URLs.** Both read a number as the same double: the page with `JSON.parse`, the service with serde_json's correctly rounded parse (its `float_roundtrip` feature; the default parse reads `6e23` one step off). Both count the size as `JSON.stringify` writes the action ("Action size" above), and both apply one URL rule ("Safety" above).

This agreement covers every action that reaches both validators, which is every action the service can parse. Three things never reach `visual_protocol.rs`: a string with a lone surrogate (`"\ud800"`), a number outside the double range (`1e400`), and nesting deeper than 128 levels. The service cannot parse the host-link frame that carries them, so it drops the frame, and the call ends as `failed` when the host agent stops waiting for a reply. Only in-page code can hand them to the page's validator.

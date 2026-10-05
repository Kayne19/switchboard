# The `display` channel & Visual Stage

A project agent pushes anything it wants the caller to *see* — a diagram, a chart, a metric, a progress list, a document, code, a table, an image, a calendar, a to-do list, timers, the weather, an inbox, or a plain note — to the caller's page mid-turn, the same way it pushes speech. The caller sees it render while the agent is still working. **The agent chooses what to show and how it is composed; the page owns the pixels.** `docs/visual-channel.md` is the product/capability companion to this wire contract.

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
- **content types** (for `show`): `chart | metric | progress | diagram | document | code | table | note | image | calendar | tasks | timer | weather | inbox`. `message` is a runtime-owned transcript, **not** an agent display type.
- **roles** (composition slot): `primary | compare | secondary | ambient`.
- **`id`**: agent-owned and stable across updates (re-sending the same `id` replaces the object in place). Agent IDs must not begin with the reserved `__runtime/` namespace.
- **`target`**: the object id to anchor a `say` action (must not begin with `__runtime/`); `null` is the same as no target and is dropped.
- **`at`**: speech anchor object containing at least one of `x` (finite number) and `series` (string <= 128 UTF-16 code units), or explicit `null`; omitted `at` normalizes to `null`.
- **`caption`**: optional content-owned supporting text (<= 128 UTF-16 code units) rendered in the scene's small corner label. It is available on every `show` data shape.
- **`note.anchor`**: optional persistent annotation target `{ target, x?, series?, node?, item? }`. `target` is another display object id; the remaining fields identify a semantic location inside a chart, a diagram or a personal-assistant object without prescribing pixels (`item`: see "Personal-assistant types").

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
| `note` | `{ segments: [{ text, accent?, bold?, semantic? }], tag?, caption?, anchor?: { target, x?, series?, node?, item? } }` | persistent annotation |
| `image` | `{ format: "png"\|"jpeg"\|"webp", bytes: <standard base64>, alt, title?, subtitle?, context?, caption? }` | raster figure, contained, with its alt text and decoded size |
| `calendar` | `{ view: "day"\|"week"\|"month"\|"agenda", start: Date, days?, today?: Date, now?: WallTime, events: [{ id, title, start, end?, location?, detail?, semantic?, status?, active? }], title?, subtitle?, context?, caption? }` | a day, a week, a month or an agenda of events (see "Personal-assistant types") |
| `tasks` | `{ items: [{ id, text, state?, due?, priority?, group?, detail?, tags? }], today?: Date, title?, subtitle?, context?, caption? }` | a to-do list, in groups, overdue marked against `today` |
| `timer` | `{ timers: [{ id, label, endsAt: Instant, startedAt?, state?, remaining? }], title?, subtitle?, context?, caption? }` | countdowns and reminders, counted on the page clock, done at zero (see "timer") |
| `weather` | `{ location, units: "C"\|"F", current: { temp, condition, ... }, hourly?, daily?, alert?, title?, subtitle?, context?, caption? }` | conditions now, by the hour and by the day |
| `inbox` | `{ messages: [{ id, from, subject?, snippet?, time, channel?, unread?, flagged?, semantic? }], today?: Date, title?, subtitle?, context?, caption? }` | a list of messages in the order sent |

Each document paragraph is read as the same small Markdown subset the conversation surfaces use (`apps/frontend/src/primitives/markdown.ts`): `#` headings (shown as a bold line), `**bold**`, `*italic*`, `` `inline code` ``, `-` and `1.` lists, and fenced code blocks. A newline inside a paragraph is a line break; a blank line starts a new paragraph. It is never HTML: markup stays literal text, and a link shows only its label.

A composed scene is built from multiple `show` actions with distinct `id`s and roles (e.g. `diagram` as `primary`, `note` as `secondary`, `metric` as `ambient`). The page owns layout, geometry, and styling. Every visual beside the primary is drawn, whatever the primary's type: a chart beside a chart primary shares its row, and any other one takes a cell in the aux row under the primary (`docs/visual-channel.md`, "Composition & focus").

On a portrait screen (a phone, a tablet held upright) the rail of metrics, progress, the note and Damocles stands under the primary. A primary that outgrows its share there -- a large diagram, a long table, code or document, a long plan, a tall figure, a bar chart with more categories than the slot has rows for -- takes the screen's height, and the rail folds to a strip under it that keeps the note (its first lines, its target, and the NOTE marker on the item it names) and Damocles; the caller can open the rest. A primary that fits keeps the rail. Send what the explanation needs: the page decides, from the screen it has (`docs/visual-channel.md`, "A primary that outgrows its slot").

Notes have their own display lifecycle. A chat or spoken response does not update an existing note; only another `show` using the note's stable id, `hide`, or `clear` changes it. An anchored note is selected for the visual object it targets and, when the target exposes the requested semantic coordinate, is placed near that location by the page. On a chart the page keeps the note clear of the chart's data and runs its leader to the value it prints at the point; where the primary chart has a card with no place that keeps those rules, one note is shown beside the chart -- in the rail, or on a portrait screen in a band under the chart -- and its point stays marked (`docs/visual-channel.md` says which note goes, and the limits).

### Chart v1 rules
- `kind` is how the series are drawn: `line` (the default), `bar`, `area` or `scatter`. Anything else is rejected.
- `labels`: 1 to 100 categorical x labels, each a string of at most 64 UTF-16 code units. When present the x domain is the label indices (`0` to `labels.length - 1`), the x ticks are the labels, and `xMax` is ignored. Every `series.values` must be no longer than `labels`; a shorter series ends early.
- `marker.x`, a note's `anchor.x` and `say at.x` name a label index on a labelled chart, and the numeric x otherwise.
- Bars are grouped per category across the series. A bar chart without `labels` takes the value indices as its categories, so `xMax` is ignored there too. Whether bars run up or across is the page's decision (`docs/visual-channel.md`).
- `yMin` and `yMax` are kept as given. An end left out is the page's: rounded out to a round value, a bar or area chart's with headroom past its tallest value. Give `yMax: 100` for a percentage that must stop there.
- A bar that `marker` or a note's `anchor` names is outlined and its value printed; a point on a line, area or scatter chart is ringed and its value printed by the ring. A note's tag names what it points at as the caller reads it: the category on a chart with `labels`, else the x axis's name and the value (`EPOCH 32`), then the series where the anchor names one or the chart draws more than one.

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
- Size is the page's decision. A diagram is never drawn with its text below the page's smallest type; one too large for that is recomposed for its viewport and scrolls inside it, and focus gives it the whole stage (`docs/visual-channel.md`, "Diagrams that outgrow the frame"). A diagram that scrolls opens on the node or actor its note names, rests only where no node is cut at the edge it is read from, counts on each edge what lies past it, names where an edge leaving the view goes, and carries a map of the whole beside it where there is room. A sequence whose pinned headers would take too much of a short view (a phone's slot) shows its actors' names alone; focus shows their `sub` lines as well, unless even focus is too short for them. Focus keeps the note about the diagram: the node or actor it names stays marked and the note stands beside or under the drawing. An agent may send the diagram the explanation needs; it does not have to trim it to fit a screen, and a node it names in a note is the one the caller sees first.

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

### Time values

Every time in a display action is a string in one of three forms. Each validator has one parser for them (`parseTimeValue` in `validation.ts`, `parse_time_value` in `visual_protocol.rs`), and every type that carries a time uses it.

| form | written | example | where |
| --- | --- | --- | --- |
| Date | `YYYY-MM-DD` | `2026-10-05` | a calendar's `start` and `today`, an all-day event, a task's `due`, a forecast day, an inbox message's `time`, every `today` |
| WallTime | `YYYY-MM-DDTHH:MM` | `2026-10-05T14:30` | a calendar's `now`, a timed event, a task's `due`, a forecast hour, an inbox message's `time` |
| Instant | `YYYY-MM-DDTHH:MM:SS` with `Z` or an offset | `2026-10-05T14:30:00-07:00`, `2026-10-05T21:30:00Z` | a timer's `endsAt` and `startedAt`, and nothing else |

- A date is a real Gregorian day in the years 1970 to 2199, with two-digit months and days: `2024-02-29` is a date; `2026-02-29`, `2100-02-29`, `2026-04-31`, `1969-12-31` and `2026-1-5` are not.
- Hours are `00` to `23` (`24:00` is refused); minutes and seconds are `00` to `59` (a leap second, `:60`, is refused).
- A wall time has no seconds and no offset. It is the caller's own clock, and the page draws it as written.
- An instant has seconds and an offset: `Z`, or `+HH:MM`/`-HH:MM` with hours `00` to `23` (`-00:00` is UTC). A fraction of 1 to 9 digits may follow the seconds (`18:42:00.250Z`), as JavaScript's `toISOString()` and Python's `isoformat()` write one. An instant without an offset is refused. Its year is read as written: `1970-01-01T00:30:00+01:00` is accepted.
- Upper-case `T` and `Z`, ASCII digits, and nothing before or after: no spaces, no `+0700`, no zone names. RFC 3339 also allows `t` and `z`; here they are refused, so every time has one spelling. A note names a forecast hour by the same text the hour carries, and the page compares the text.
- A refusal names the forms the field takes: `calendar event.start must be a date (YYYY-MM-DD) or a wall time (YYYY-MM-DDTHH:MM), on a real day in 1970-2199`.

**Why there is no page clock, except for a timer.** A calendar, a to-do list, a forecast and an inbox are drawn only from what the agent sends. The page converts no time zone, and it does not read its own clock to draw them: "today" and "now" are fields (`today`, `now`), so the now line, an overdue task and a message from today all come from data. A frame is then the same on every screen and in every test; a caller whose browser is in another zone still sees the times the agent meant; and the agent, which knows the caller's day, decides what today is. A timer is the exception: it counts down, so it is measured against the page clock, and it is the one type that takes instants, whose offsets make that measurement exact.

### Personal-assistant types

Five types show a person's day: `calendar`, `tasks`, `timer`, `weather` and `inbox`. They keep the conventions of the other types: an optional `title`, `subtitle`, `context` (each <= 256) and `caption` (<= 128); camelCase keys; an unknown key is refused. An item id (an event, a task, a timer, a message) is non-blank and <= 128 UTF-16 code units, like a diagram node id, and is unique in its list.

Status: both validators, the schema and the skill module hold the whole contract below. The page draws all five with primitives of their own (`CalendarPrimitive`, "How the page draws a calendar" below; `TasksPrimitive`, `InboxPrimitive`, `TimerPrimitive`, `WeatherPrimitive`, how in `docs/visual-channel.md` and in each type's section), and marks the item a note names in any of the five.

#### calendar

- `view` (required): `day`, `week`, `month` or `agenda`. `start` (required, a date): for `day` the day shown; for `week` the first column; for `month` any day in the month; for `agenda` the first day listed.
- `days`: an integer, 1 to 7 on the week view (7 when absent) and 1 to 31 on the agenda view (7 when absent). It is refused on the day and month views.
- `today` (a date) and `now` (a wall time) mark the day and the time. When both are given, `now` falls on `today`.
- `events`: 0 to 200, each `{ id, title (<= 256), start, end?, location? (<= 128), detail? (<= 256), semantic?, status?, active? }`. `status` is `confirmed`, `tentative` or `cancelled`; `active` (a boolean) marks the event on now or the one being talked about.
- A date `start` is an all-day event. A wall time `start` is a timed event; with no `end` the page draws it as a 30-minute block. `end` is written like `start` (both dates or both wall times) and is not before it. A date `end` is inclusive: `start: "2026-10-10", end: "2026-10-11"` is two days. Events may overlap and may run past midnight.

```json
{ "op": "show", "id": "week", "type": "calendar", "role": "primary", "data": {
  "view": "week", "start": "2026-10-05", "today": "2026-10-07", "now": "2026-10-07T09:40",
  "events": [
    { "id": "standup", "title": "Standup", "start": "2026-10-07T09:30", "end": "2026-10-07T09:45", "active": true },
    { "id": "dentist", "title": "Dentist", "start": "2026-10-07T10:30", "end": "2026-10-07T11:30", "location": "Dr. Okafor, 14 Pine St" },
    { "id": "birthday", "title": "Mom's birthday", "start": "2026-10-08" },
    { "id": "flight", "title": "UA 1532 SFO to JFK", "start": "2026-10-09T18:05", "end": "2026-10-10T02:40", "detail": "Lands 05:40 New York time" }
  ] } }
```

How the page draws a calendar (`CalendarPrimitive`, laid out by `calendarLayout.ts`). The agent sends the view and the events; the page decides the rest from the box it has, in the main slot, an aux cell or focus:

- **What is a bar.** An all-day event, and a timed event a day long or more (a conference, a stay), is drawn as a bar over its days: in the strip of a day or week grid, in a month's rows. A timed bar shows its start time on its first day. Every other timed event is drawn in the hours (day, week) or as a line (month). A wall time with no `end` is a 30-minute block held to its own day (one at `23:45` ends at midnight).
- **day and week** are a time grid: a row of days (today in orange), the strip of bars under it (three lanes; past that the last lane counts the rest, `+2 MORE`), and the hours under that. The grid runs from the first hour anything is in to the last, an event's box (at least a line tall) included; a run of three or more empty hours between them is folded to a hatched band that names its hours, unless every hour fits at a roomy size, or folding would leave room to spare and every hour fits at the least. An hour is never drawn shorter than 26 px: a long day in a short box scrolls inside the frame, with the shared list viewport's counts of the events past each edge, and opens on the marked event, else the now line. A week too narrow for its columns at 76 px each shows the ones that fit, from the marked event's day (else today, else the active event's), and names the hidden days on a rail at each side with their event count; a tap on the rail, a swipe, or the left and right arrow keys turn to them. A grid with room for fewer than eight hours, or for fewer than two columns, is drawn as the agenda of its days.
- Overlapping timed events stand side by side. Where each starts at least a title line after the ones it overlaps, a column further in, they are stepped instead: each later one lies over the earlier ones, set in 14 px, so every title shows at the day's full width (as deep as the column has room for). A part narrower than 34 px is not drawn: a cluster wider than its column draws what fits and counts the rest in a dashed `+N` in the last place. A part shorter than a line is drawn a line tall, and two such parts that would touch are set apart too. An event past midnight is cut into a part on each day, its cut edges clipped and dashed, the later part saying `UNTIL 02:40`.
- **month** is Monday-first rows (weeks start on Monday, ISO 8601), the days of the months either side dimmed. A bar is pointed where it runs on past a row; a timed event is a line with its start, on the day it starts. A day with more than its cell holds lists what fits and ends with `+N MORE`, counting the bars it has no lane for too. A month too small for titles marks each day's events with a short bar each (four, then a count), and lists them from today (or the month's first day) under the grid when there is room.
- **agenda** lists each day's events: bars first, then by start, an event over several days on each (`DAY 2 / 3`), one past midnight written `18:05` to `02:40 +1`. The now line stands before the first event that starts after `now`. Events that share time are tagged `OVERLAP` (a cancelled event shares none). A run of days with nothing on them is one line. In a wide box several days stand in columns. It opens on the marked event, or on the now line when the marked event lies within three rows after it, so both show.
- Everywhere: a `semantic` colours the event's stripe and tint; `tentative` is dashed and `cancelled` struck through and receded; an event over by `now` (or a day before `today`) recedes; the `active` one is lit, in orange when it has no `semantic`. The note's `anchor.item` puts the NOTE badge on the first place the event is drawn, or on the count that holds it where it is not drawn (`+3 MORE`); in a month too small for titles, on its row in the list under the grid when the list holds it. The rail note's TARGET line names the event with its start (`Dentist / WED OCT 7 10:30`). The meta line counts the events the view does not reach (`2 OUT OF VIEW`); under a scene frame that names the calendar it does not repeat the title.

#### tasks

- `items`: 1 to 100, each `{ id, text (<= 256), state?, due?, priority?, group? (<= 128), detail? (<= 256), tags? }`.
- `state` is `todo`, `active`, `done` or `blocked`, the words of a progress step; absent reads as `todo`. `priority` is `high` or `low`; absent is normal (`normal` is refused). `due` is a date or a wall time. `tags` is 0 to 4 short strings (each <= 32).
- `group` is a section heading; the sections stand in the order their groups are first met.
- `today` (a date) is what overdue is measured against: a task is overdue when the day of its `due` is before `today` and it is not `done`. The day is compared, not the time: a task due at `09:00` on `today` is not overdue, because a list has no `now`. With no `today`, nothing is overdue.

```json
{ "op": "show", "id": "todo", "type": "tasks", "data": {
  "today": "2026-10-07",
  "items": [
    { "id": "pr", "text": "Review the switchboard PR", "state": "active", "due": "2026-10-07T17:00", "group": "Work" },
    { "id": "passport", "text": "Renew passport", "due": "2026-10-02", "priority": "high", "group": "Errands", "tags": ["travel"] },
    { "id": "gift", "text": "Buy a gift for Mom", "state": "done", "group": "Errands" }
  ] } }
```

#### timer

- `timers`: 1 to 8, each `{ id, label (<= 128), endsAt, startedAt?, state?, remaining? }`. `endsAt` and `startedAt` are instants, and `startedAt` is before `endsAt` (offsets applied).
- `state` is `running` or `paused`; absent reads as `running`. `remaining` is the seconds left (a number, 0 or more): it is required when the timer is `paused` and refused otherwise, because a running timer is counted down from `endsAt`.
- A paused timer is drawn from `remaining` and is not counted; its `endsAt` is kept as the end it had when it last ran, and nothing is measured against it. `startedAt` and `endsAt` together give the whole span, so the page can show the share gone: `now` against them for a running timer, `remaining` against them for a paused one. When the agent resumes a timer, it sends `state: "running"` (or no state) with the new `endsAt`.
- The page counts a running timer down against its own clock and shows it done at zero. It plays no sound: the agent says it is done. With reduced motion there is no animated sweep; the numbers still change.
- What the page draws: each timer's label, its countdown (`MM:SS`, `H:MM:SS` from an hour, `ND HH:MM:SS` from a day; rounded up, so `00:00` shows only at the end), its phase (running, paused, or done in the warning colour), and, with a `startedAt`, a bar of the share gone. Under the bar: when it ends (`ENDS 18:42`, its time of day as written, `UTC` added when it was written in UTC), the share gone of the whole span, or for a done timer how long ago it ended (`ENDED 18:42 / +01:15`). Several timers are laid out by the slot's geometry: a grid of large countdowns, or rows of a list where the slot is too small for readable digits. The timer a note names (`anchor.item`, its `id`) carries the NOTE badge.

```json
{ "op": "show", "id": "kitchen", "type": "timer", "data": {
  "timers": [
    { "id": "pasta", "label": "Pasta", "startedAt": "2026-10-05T18:33:00-07:00", "endsAt": "2026-10-05T18:42:00-07:00" },
    { "id": "bread", "label": "Bread in the oven", "endsAt": "2026-10-05T19:05:00-07:00", "state": "paused", "remaining": 1260 },
    { "id": "leave", "label": "Leave for the airport", "endsAt": "2026-10-06T00:30:00Z" }
  ] } }
```

#### weather

- `location` (required, <= 128) and `units` (required, `C` or `F`). Every temperature is in `units`; the page converts none. A forecast with no `title` is named by its `location` in `view`'s report.
- `current` (required): `{ temp, condition, summary? (<= 256), high?, low?, feelsLike?, humidity?, precip?, wind? (<= 128) }`. Temperatures are finite numbers; `humidity` and `precip` (the chance of precipitation) are percents, 0 to 100.
- `hourly`: 0 to 48 `{ time, temp, condition, precip? }`, `time` a wall time, no two hours with one `time`. `daily`: 0 to 14 `{ date, high, low, condition, precip? }`, no two days with one `date`. `alert`: <= 256.
- `condition` is one of `clear`, `partly-cloudy`, `cloudy`, `fog`, `drizzle`, `rain`, `heavy-rain`, `thunder`, `snow`, `sleet`, `hail`, `wind`, `haze`. The page draws each as a glyph in the design system's sharp vector geometry, never as an emoji or an image.
- What the page draws: the conditions now as the hero (the glyph, the temperature large with its unit, the condition, high and low, the summary, and the readings it was given: feels like, humidity, chance of precipitation, wind), with `alert` on an amber rule; the hours as a strip, the temperature traced over each hour's chance of rain, labelled as often as the slot's width allows (a 48-hour strip stays on one screen); the days as rows, each day's low-to-high a bar on one scale shared by all the days. A temperature is shown to a tenth at most. Where the parts stand is the slot's decision; a small slot shows the conditions and one list, and one too short for a list shows the days to come as a row beside the conditions (a first day whose `high` and `low` are the conditions' `high` and `low` is taken to be today, which the conditions say already, and is left out of that row). The hour or day a note names (`anchor.item`, the hour's `time` or the day's `date`) carries the NOTE badge, and the rail card names it in the forecast's words (`THU OCT 8`, `WED 14:00`).

```json
{ "op": "show", "id": "weather", "type": "weather", "data": {
  "location": "San Francisco, CA", "units": "F",
  "current": { "temp": 61, "condition": "fog", "summary": "Fog burning off by noon", "high": 68, "low": 54, "humidity": 84 },
  "hourly": [ { "time": "2026-10-07T12:00", "temp": 64, "condition": "partly-cloudy" }, { "time": "2026-10-07T13:00", "temp": 67, "condition": "clear" } ],
  "daily": [ { "date": "2026-10-08", "high": 61, "low": 55, "condition": "rain", "precip": 80 } ] } }
```

#### inbox

- `messages`: 1 to 50, each `{ id, from (<= 128), subject? (<= 256), snippet? (<= 256), time, channel? (<= 32), unread?, flagged?, semantic? }`. `time` is a date or a wall time; `channel` is a short label (`email`, `slack`, `sms`); `unread` and `flagged` are booleans.
- Messages are drawn in the order sent. A wall time on `today` (a date) shows as its time of day; any other `time`, a date on `today` included, shows as its date.
- One message in full is a `document` of kind `email`, not an inbox.

```json
{ "op": "show", "id": "inbox", "type": "inbox", "data": {
  "today": "2026-10-07",
  "messages": [
    { "id": "dentist", "from": "Dr. Okafor's office", "subject": "Appointment today", "snippet": "Reply C to confirm.", "time": "2026-10-07T08:12", "channel": "sms", "unread": true, "flagged": true },
    { "id": "ci", "from": "GitHub", "subject": "CI failed on visual-palette", "time": "2026-10-07T07:41", "channel": "email", "unread": true, "semantic": "red" },
    { "id": "shuttle", "from": "Sam and Lee", "subject": "Wedding weekend: shuttle times", "time": "2026-10-04", "channel": "email" }
  ] } }
```

#### A note on one item: `note.anchor.item`

A note's `anchor.item` names an item inside its target: a calendar event, a task, a timer or an inbox message by its `id`, or a forecast hour or day by its `time` or `date`. It is checked as an item id is (non-blank, <= 128 UTF-16 code units). As for `node` and `series`, the validators check only its shape: the note and its target are separate objects, and the target may change after the note. The page marks the named item the way a diagram marks the node a note names: while the note is the one the page draws for its target (the rail's note, or the note focus keeps beside it), wherever the target is drawn (the main slot, a cell beside the primary, focus) the item carries the NOTE badge, the twin of the one on the card, and a list that scrolls opens on it; the card's `TARGET` line names the item in the target's own words (a task's text, a message's sender and subject), on a line of its own. A note the page does not draw (the rail shows one note) marks nothing, so a badge always has its card on screen. It marks nothing either, and the card shows the anchor as sent, when the target has no item of that name.

```json
{ "op": "show", "id": "dentist-note", "type": "note", "data": {
  "tag": "LEAVE BY 10:05", "anchor": { "target": "week", "item": "dentist" },
  "segments": [ { "text": "Traffic on 101 is slow; leave right after standup." } ] } }
```

## Canonical schema & validation rules

The canonical contract is defined in `docs/display-action-v1.schema.json` and exercised by `apps/frontend/tests/fixtures/display-actions.json`. Both the TypeScript frontend validator (`apps/frontend/src/controller/validation.ts`) and the Rust backend validator (`apps/backend/src/visual_protocol.rs`) enforce identical rules, down to the text of each error; `apps/frontend/tests/fixtures/validator-corpus.json` pins that (see "How the two validators agree" below):

- **Action size**: Serialized action JSON must not exceed **48,000 UTF-8 bytes**, except a `show` of type `image`, whose cap is **12 MiB** (`MAX_IMAGE_ACTION_BYTES`; its raw bytes are capped at 8 MiB). The bytes are counted as `JSON.stringify` writes the action, so a number counts as JavaScript spells it (`1.0` counts as `1`, `1e16` as `10000000000000000`), and the cap holds for the normalized action too: a `say` sent within a few bytes of the cap can be refused because normalizing adds `"at":null`. A display action reaches the service as a module call over the host link, whose frames are at most 16 MiB; the host agent's skill socket accepts request lines up to 13 MiB, so the relayed frame always fits.
- **String caps (UTF-16 code units)**: `id` <= 128; `text` <= 50,000; short labels/tags <= 128; titles/details <= 256. Astral Unicode characters (such as emojis) count as 2 UTF-16 code units.
- **Numbers**: All numbers must be finite; `NaN`, `Infinity`, and `-Infinity` are rejected.
- **Layout rejection**: Recursive rejection of `layout`, `style`, `css`, `className`, `width`, `height`, `left`, `right`, `top`, `bottom`.
- **Reserved namespace**: Agent IDs must not begin with `__runtime/`.
- **Safety**: Raw HTML/JS markup (`<script`, `<iframe`, `javascript:`, etc.) and external resource URLs are rejected in any string. A URL is any `scheme://` (`https://`, `ftp://`, `s3://`, `file:///`), a string that starts with `//`, or a `//` followed by a host name with a dot and a top-level part of two letters or more (`see //cdn.example.com`). A `//` with no host after it (`a // comment`) is text.
- **Unknown fields**: All schema branches specify `additionalProperties: false`; unexpected fields are rejected.

`docs/display-action-v1.schema.json` encodes as much of this as declarative JSON Schema can express (the progress rule "one of `value`/`steps`" is its `anyOf`; each time form is a pattern, a date's holding each month's days and the leap years; a calendar's `days` per view, an event's `end` written like its `start` and a paused timer's `remaining` are `if`/`then` rules), and `apps/frontend/tests/unit/schema.test.ts` holds it to `display-actions.json` fixture-by-fixture so it cannot drift from the two validators unnoticed. Six things it cannot express, so it does not attempt to: invariants that span sibling array items (duplicate node, actor or item IDs, two forecast hours with one `time` or days with one `date`, an edge or message endpoint naming no node or actor, a self-loop, a duplicate edge pair, a table row with other than `columns.length` cells, a table highlight naming no row — each a relationship between items, not one item's shape); a chart series' value count against its `labels` count, a relationship between two sibling fields; two times compared as times (an event's `end` before its `start`, a calendar's `now` off its `today`, a timer's `startedAt` not before its `endsAt`, offsets applied); the action-size caps (48,000 bytes, 12 MiB for an image), which bound the serialized envelope on the wire rather than the parsed instance; the UTF-16-code-unit string caps above for content containing astral characters, since JSON Schema's `maxLength` counts Unicode code points; and an image's format/signature match, a cross-field check over decoded bytes (the schema pins the base64 alphabet, padding and length only). Those stay enforced only by `validation.ts` and `visual_protocol.rs`; the test names each as a documented, asserted exception (`KNOWN_SCHEMA_GAPS`) rather than silently passing.

The schema cannot state the blank rule, the key order or the text of an error either; the corpus pins those, and `schema.test.ts` also holds the schema to accept every action the corpus accepts, so the schema is never the stricter of the three.

A refused action comes back to the agent as a `refused` result whose reason is the validator's error, word for word (the service answers `{"delivered":false,"detail":"<reason>"}`). It is neither stored in display state nor broadcast.

### How the two validators agree

Every action is checked twice: by the service (`visual_protocol.rs`) when it arrives, and by the page (`validation.ts`) when the normalized action reaches it. If the two disagreed, the agent would be told "accepted" for an action the page then refuses, or the reverse. So both give the same answer, and the same error text, for every action.

`apps/frontend/tests/fixtures/validator-corpus.json` is the record. Each case is an action and its exact error, or its acceptance and its normalized form. Both suites run every case (`apps/frontend/tests/unit/validatorCorpus.test.ts`, and `agrees_with_the_shared_validator_corpus` in `apps/backend/tests/test_visual_protocol.rs`), and an accepted action must pass a second time unchanged. The skill module's outline check runs the same cases (`skills/switchboard/tests/test_switchboard.py`): it never refuses an action the validators accept. A rule change lands with the corpus cases that show it, so both sides change together.

These rules decide which error an action gets:

1. **Order of the checks.** The action is an object; it is within its size cap; its `op` is known. Then, anywhere in the action: no layout key, no unsafe string, no non-finite number. Then the op's own fields: for a `show`, its unknown keys, `id`, `type`, `role` and `data`, and inside `data` the unknown keys first and then each field in a fixed order (the corpus's `*_order_*` cases pin it). Last, the normalized action is held to the same size cap.
2. **Order of the keys.** Where two keys could each give the error (two unknown fields, two layout keys, two unsafe strings), both sides walk an object's keys in code point order, depth first, and name the first one met: `{"zeta": 1, "alpha": 2}` is `unknown field in ...: alpha`, wherever the agent put it. Arrays go in index order. The service sorts the keys itself rather than rely on its JSON map's order, and the page compares code points, not UTF-16 units.
3. **Blank.** An `id`, a `target`, a node, actor or item id, an anchor target or item, and an image `alt` must not be blank: empty, or made only of Unicode White_Space. That is these 25 code points and no others: U+0009 to U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F and U+3000. U+FEFF, U+200B, U+180E and U+001C to U+001F are not whitespace here. (JavaScript's `trim` strips U+FEFF and keeps U+0085, so neither side uses it.) A `say` text need only be non-empty.
4. **A wrong type is refused, never dropped.** An optional field of the wrong type, such as a number for a node's `sub` or `null` for a `semantic`, is refused on both sides. Neither side drops the field and accepts the rest. The one place `null` is allowed is a `say`'s `target` and `at`, where it means "none" (see the protocol section above).
5. **Numbers, size and URLs.** Both read a number as the same double: the page with `JSON.parse`, the service with serde_json's correctly rounded parse (its `float_roundtrip` feature; the default parse reads `6e23` one step off). Both count the size as `JSON.stringify` writes the action ("Action size" above), and both apply one URL rule ("Safety" above).

This agreement covers every action that reaches both validators, which is every action the service can parse. Three things never reach `visual_protocol.rs`: a string with a lone surrogate (`"\ud800"`), a number outside the double range (`1e400`), and nesting deeper than 128 levels. None of them reaches the service from an agent as it was written: the skill module raises before sending a lone surrogate (or a NaN or infinity), the host agent writes any lone surrogate it relays as U+FFFD, a Python integer beyond a double's range becomes `null` when the host agent reads and relays it, and is judged as a `null`, and a call nested too deep is refused at once, naming the fault (`this call cannot be read: ...`; `docs/host-link.md`, "Frames the service cannot read"). Only in-page code can hand them to the page's validator.

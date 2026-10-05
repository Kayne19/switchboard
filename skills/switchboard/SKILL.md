---
name: switchboard
description: Talk to the caller and use their screen during a switchboard voice call. Speak, show things on their screen, see what they see, and queue words for them while they are on other work. Only works while this session is on a call.
---

# Switchboard

A person may be on a voice call with this session. The `switchboard` module is
already imported in the Python REPL. Call its functions directly:

```python
switchboard.speak("Parser's fixed. Tests pass.")
switchboard.display(op="show", id="build", type="progress", role="primary",
                    data={"label": "Build", "value": 40})
```

The voice brief at the start of the call says how to sound. This file is the
reference.

## Who talks

Only the session on the call can reach the caller. In subagents, and outside a
call, every function prints that nothing was sent, and does nothing else. Give
hands-on work to subagents so that you stay free to talk. Their results come
back to you, and you tell the caller.

## Results

Every function prints one line saying what happened and returns a result with
`status` (`delivered`, `accepted`, `refused` or `failed`), `reason`,
`delivered`, `accepted` and `ok`. A refusal or a failure never raises. Only a
wrong argument raises: a bad type, an unknown display type, op, role or view
target, or a value JSON cannot carry (NaN, an infinity, or a string holding
half of a surrogate pair). Values with `tolist()`, such as numpy arrays, are
sent as lists.

## Functions

- `speak(text)`: say `text` out loud. Your written output goes to a screen
  they may not be watching, so anything they must hear goes through `speak`.
  Use plain spoken words. Code, paths, lists and tables go on the screen.
- `request_to_speak(message, reason)`: while the caller is on other work,
  queue what they should hear. `reason` is `finished`, `needs_decision` or
  `problem`. `message` is the real content, said the way you would say it: the
  result, the question with its options, or what went wrong and what you need.
  Not a teaser. The service fits it into the conversation and plays it at a
  good moment.
- `display(action)` or `display(**action)`: one display action per call. See
  "Display".
- `view(target=None)`: with no target, report what is on the caller's screen.
  With a target, ask the screen to focus `visual` (what `display` put there),
  `comms` (the conversation and tool activity), `system` (project, model and
  route controls), `theater` (the current visual fills the screen) or `auto`
  (the default). The caller's own choice wins until they dismiss it. From the
  background, only the report is answered: a target is refused with
  `caller_away`, and the screen follows your display when the caller brings
  you forward.
- Moving the caller, model changes and hanging up belong to the switchboard.
  This module has no functions for them.

## Display

Show semantic content; the page owns layout, pixels and styling. Never send
markup, CSS, pixel geometry or styling.

- `show` (`id`, `type`, optional `role`, `data`) creates an object, or
  updates it in place when the `id` is reused.
- `hide` and `focus` take an `id`; `clear` takes nothing.
- `say` (`text`, optional `target`, optional `at: {x?, series?}`) anchors
  speech to an object.

Types and their `data` shapes (each type takes only its own shape):

- chart: `{series: [{name, values: [n]}]}`; optional `kind` (`line`, the
  default, `bar`, `area` or `scatter`) and `labels: [str]`, categorical x
  labels (at most 100, each at most 64 characters; no series may be longer
  than them). Bars group per category; the page decides whether they run up
  or across.
- metric: `{label, value}`, plus `trend` (`up`, `down` or `flat`) and
  `delta` (a short string such as `-12 ms`) to show how it moved
- progress: `{label, value}` (value is a percent, 0-100) and/or
  `steps: [{label, state?, detail?}]` (1 to 30; state is `done`, `active`,
  `todo` or `blocked`). With steps, value may be left out: the bar then
  shows the share of steps done.
- diagram: `{mode: "graph", nodes: [{id, label}], edges: [{from, to}]}` for
  structure, or `{mode: "sequence", actors: [{id, label}], messages: [{from,
  to, label}]}` for an exchange over time (a message's `kind` is `call`,
  `return` or `async`; `active: true` lights the one happening now)
- document: `{subject, paragraphs: [str]}` (each paragraph reads Markdown:
  headings, bold, italic, inline code, lists, fenced code; no HTML)
- code: `{source: {text}}`
- table: `{columns: [{label}], rows: [[cell]]}` (1 to 12 columns, up to 200
  rows, each row one cell per column; a cell is a string, a number or
  `{text, semantic?, bold?}`; `highlight: [row index]` marks rows; the page
  aligns columns itself)
- note: `{segments: [{text}]}`
- image: `{path: "/tmp/fig.png", alt}` or `{bytes: <raw bytes>, alt}`, for a
  picture you already have (a saved plot, a screenshot). The module reads the
  file, checks it is a PNG, JPEG or WebP (not SVG) of at most 8 MiB, and
  sends it inline; the path is never sent and no URL is ever fetched. `alt`
  says what the picture shows; add `title` for the heading. Prefer a
  structured type when it can say the same thing.
- calendar: `{view, start, events: [{id, title, start}]}`. `view` is `day`,
  `week`, `month` or `agenda`; `start` is the day (week: the first column).
  An event may add `end`, `location`, `detail`, `semantic`, `status`
  (`confirmed`, `tentative`, `cancelled`) and `active: true`. A date `start`
  is all day; a time with no `end` is a half-hour block. `days` (week 1-7,
  agenda 1-31) and `today`/`now` are optional; up to 200 events.
- tasks: `{items: [{id, text}]}` (1 to 100). A task may add `state` (`todo`,
  `active`, `done`, `blocked`), `due`, `priority` (`high` or `low`),
  `group` (a section heading), `detail` and up to 4 `tags`. Give `today`
  so overdue tasks are marked.
- timer: `{timers: [{id, label, endsAt}]}` (1 to 8). `endsAt` is an
  instant; the screen counts down to it and shows it done at zero, with no
  sound, so tell the caller yourself. Add `startedAt`, or
  `state: "paused"` with `remaining` (seconds left).
- weather: `{location, units: "C" or "F", current: {temp, condition}}`,
  plus `hourly: [{time, temp, condition}]` (up to 48), `daily: [{date, high,
  low, condition}]` (up to 14) and an `alert`. `condition` is one of
  `clear`, `partly-cloudy`, `cloudy`, `fog`, `drizzle`, `rain`,
  `heavy-rain`, `thunder`, `snow`, `sleet`, `hail`, `wind`, `haze`.
- inbox: `{messages: [{id, from, time}]}` (1 to 50, shown in your order),
  each with optional `subject`, `snippet`, `channel` (a short label such
  as `email`, `slack` or `sms`), `unread`, `flagged`. Give `today` so today's messages show their
  time. One message in full is a `document` with `kind: "email"`.

Times are text in three forms: a date `"2026-10-07"`, a wall time on the
caller's clock `"2026-10-07T14:30"` (no seconds, no offset), and an
instant `"2026-10-07T14:30:00-07:00"` (or `...Z`), which only a timer
takes. Write the caller's local times; the screen draws them as written and
never converts zones or reads its own clock, so give `today` and `now`
yourself. A Python `date` or `datetime` is converted for you: a date to a
date, and a datetime to a wall time on its own clock, so give it in the
caller's zone (`dt.astimezone(zone)`). A timer's `endsAt` and `startedAt`
take an aware datetime (`datetime.now(timezone.utc) + timedelta(minutes=9)`)
and become instants; a naive one raises.

```python
switchboard.display(op="show", id="week", type="calendar", role="primary", data={
    "view": "week", "start": "2026-10-05", "today": "2026-10-07", "now": "2026-10-07T09:40",
    "events": [
        {"id": "standup", "title": "Standup", "start": "2026-10-07T09:30", "end": "2026-10-07T09:45"},
        {"id": "dentist", "title": "Dentist", "start": "2026-10-07T10:30", "end": "2026-10-07T11:30",
         "location": "14 Pine St"},
        {"id": "birthday", "title": "Mom's birthday", "start": "2026-10-08"},
    ]})
switchboard.display(op="show", id="todo", type="tasks", data={"today": "2026-10-07", "items": [
    {"id": "passport", "text": "Renew passport", "due": "2026-10-02", "priority": "high", "group": "Errands"},
    {"id": "pr", "text": "Review the PR", "state": "active", "due": "2026-10-07T17:00", "group": "Work"},
]})
switchboard.display(op="show", id="kitchen", type="timer", data={"timers": [
    {"id": "pasta", "label": "Pasta", "endsAt": "2026-10-07T18:42:00-07:00"},
]})
switchboard.display(op="show", id="weather", type="weather", data={
    "location": "San Francisco", "units": "F",
    "current": {"temp": 61, "condition": "fog", "summary": "Fog burning off by noon"},
    "daily": [{"date": "2026-10-08", "high": 61, "low": 55, "condition": "rain", "precip": 80}]})
switchboard.display(op="show", id="inbox", type="inbox", data={"today": "2026-10-07", "messages": [
    {"id": "dentist", "from": "Dr. Okafor's office", "subject": "Appointment today",
     "time": "2026-10-07T08:12", "channel": "sms", "unread": True, "flagged": True},
]})
```

Every `data` shape also takes an optional `caption`, a short supporting label.
Compose a scene with roles: `primary`, `compare`, `secondary`, `ambient`.
Metrics shown with role primary share the main stage as one cluster, up to
nine in the order they claimed it (a tenth moves the earliest to the side
rail); any other primary takes the main stage. Every other visual you show
is drawn too: a chart beside a chart primary sits next to it, and any other
visual goes in a row under the primary (compare first, then secondary, then
ambient), such as a diagram with the table it summarises, or a chart with
the image it came from. Metrics, notes and progress keep their own places,
mostly the side rail. A note can carry `anchor: {target, x?, series?, node?, item?}` to attach it to
another object; `item` names one thing inside it, such as a calendar event or
a task by its `id`, or a forecast hour by its `time`. The
live transcript belongs to the system; use a note for lasting on-screen
annotations and `speak` for words. On a phone held upright, a primary too
large for its share (a big diagram, a long table or plan, a tall figure)
takes the screen and the rail folds to a strip that keeps your note and
marks what it names, so send what the explanation needs rather than
trimming it to fit.

The full contract is `docs/display-tool.md` in the switchboard repository;
the switchboard validates every action and returns its reason when it
rejects one.

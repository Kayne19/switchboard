---
name: switchboard
description: Talk to the caller and use their screen during a switchboard voice call. Speak, show things on the caller's screen, check what they see, and hand them back to the operator or to another project. Only works while this session is on a call.
---

# Switchboard

A person may be on a voice call with this session through the switchboard.
The `switchboard` module is already imported in the Python REPL. Call its
functions directly:

```python
switchboard.speak("Found it. The build fails in the parser, fixing it now.")
switchboard.display(op="show", id="build", type="progress", role="primary",
                    data={"label": "Build", "value": 40})
```

The module only works during a call. Outside a call, and in subagents, every
function prints that nothing was sent and does nothing else.

Every function prints one line saying what happened, and returns a result
with `status` (`delivered`, `accepted`, `refused` or `failed`), `reason`,
`delivered`, `accepted` and `ok`. A refusal or a failure never raises. Only a
wrong argument raises (a bad type, an unknown display type, op, role, view
target or thinking level, or a value JSON cannot carry). Values with
`tolist()`, such as numpy arrays, are sent as lists.

## Functions

- `speak(text)`: say `text` out loud to the caller. Your written output goes
  to a screen they are probably not looking at, so anything they must hear
  goes through `speak`. Use it to answer, to say what you are about to do
  before a long stretch of work, and to check in while it runs. Keep each
  line to a sentence or two of plain spoken English: no markdown, no file
  paths, no code, no lists.
- `display(action)` or `display(**action)`: one display action per call, with
  `op` `show`, `hide`, `focus`, `say` or `clear`. See "Display" below.
- `view(target=None)`: with no target, report what is on the caller's screen.
  With a target, ask the screen to focus it: `visual` (what `display` put
  there), `comms` (the conversation and tool activity), `system` (project,
  model and route controls), `theater` (the current visual takes the whole
  screen) or `auto` (the screen's default). The caller's own choice wins
  until they dismiss it.
- `return_to_operator(summary=None)`: hand the caller back to the operator
  when they are done here or ask for another project. Not just because you
  finished a task. Put anything unfinished in `summary`; the operator hears
  it. Say a short goodbye and nothing else after it.
- `transfer_to_project(project, intent=None, model=None, thinking=None)`: put
  the caller straight through to another project you were told exists. The
  transfer is silent: say nothing alongside it. Pass what they want done as
  `intent`. If you are not sure the project exists, use
  `return_to_operator` instead.
- `set_model(model=None, thinking=None, keep_context=True, intent=None)`:
  switch this session to another model (provider first when known, e.g.
  `"anthropic/claude-opus-5"`) or thinking level (`off`, `minimal`, `low`,
  `medium`, `high`, `xhigh`, `max`), because the caller asked. The session
  and its context stay. Say nothing alongside it. Pass `keep_context=False`
  only when the caller wants a clean slate: that ends this session and starts
  a new one.

## Display

Show semantic content; the page owns layout, pixels and styling. Never send
markup, CSS, pixel geometry or styling.

- `show` (`id`, `type`, optional `role`, `data`) creates an object, or
  updates it in place when the `id` is reused.
- `hide` and `focus` take an `id`; `clear` takes nothing.
- `say` (`text`, optional `target`, optional `at: {x?, series?}`) anchors
  speech to an object.

Types and their `data` shapes (each type takes only its own shape):

- chart: `{series: [{name, values: [n]}]}`
- metric: `{label, value}`
- progress: `{label, value}` (value is a percent, 0-100)
- diagram: `{mode: "graph", nodes: [{id, label}], edges: [{from, to}]}`
- document: `{subject, paragraphs: [str]}`
- code: `{source: {text}}`
- note: `{segments: [{text}]}`

Every `data` shape also takes an optional `caption`, a short supporting label.
Compose a scene with roles: `primary`, `compare`, `secondary`, `ambient`.
Metrics shown with role primary share the main stage as one cluster, up to
nine in the order they claimed it (a tenth moves the earliest to the side
rail); any other primary takes the main stage alone. A note can carry
`anchor: {target, x?, series?, node?}` to attach it to another object. The
live transcript belongs to the system; use a note for lasting on-screen
annotations and `speak` for words.

The full contract is `docs/display-tool.md` in the switchboard repository;
the switchboard validates every action and returns its reason when it
rejects one.

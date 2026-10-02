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
target, or a value JSON cannot carry. Values with `tolist()`, such as numpy
arrays, are sent as lists.

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
  (the default). The caller's own choice wins until they dismiss it.
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

# The `diagram` tool

A project agent can push a diagram to the caller's page mid-turn, the same way
it pushes speech. The caller sees it render while the agent is still working.

## Why it is shaped like `speak`

`speak` already solved this problem. A tool that has to reach the browser
*during* a turn cannot wait for the RPC stream to settle, so it does not use the
RPC stream: it POSTs to this service and the service broadcasts on the socket
the browser is already holding. `diagram` is that pattern with a different
payload, which is why it adds no new module and no new transport.

| piece | `speak` | `diagram` |
|---|---|---|
| env var handed to the agent | `SWITCHBOARD_SPEAK_URL` | `SWITCHBOARD_DIAGRAM_URL` |
| endpoint | `POST /speak` | `POST /diagram` |
| broadcast | `{"type":"spoken"}` + mp3 bytes | `{"type":"diagram"}` |

The tool is deliberately **not** a `SIGNAL_TOOL` in `piclient.py`. Signals exist
so `pbx.py` can swing the route or suppress a re-synthesis; a diagram changes
neither. Nothing in the routing layer needs to know it happened.

## The payload

```json
{ "source": "flowchart TD\n  A --> B", "title": "call path", "notes": "optional" }
```

`source` is Mermaid. Nothing validates it server-side — the browser calls
`mermaid.parse()` before swapping the DOM, so a malformed diagram fails on the
page that can actually show the error, and never blanks a good diagram that is
already up.

## Rendering

Mermaid 11 as an ESM module from jsDelivr, no build step, because
`static/index.html` is one hand-written file with no toolchain and adding one to
render a graph is a bad trade.

- `theme: "base"` plus a `themeVariables` block for the dark neon look. Unset
  variables are derived from `primaryColor`, so the ones that matter are set
  explicitly.
- `securityLevel: "loose"` and `htmlLabels: true`. This is what makes
  `A["<img src='...'/>Sensor"]` work regardless of whether the pinned Mermaid
  version has the newer `A@{ img: ... }` shape. The diagram source comes from
  our own agent over our own socket, so the sanitizer is not a trust boundary
  here.
- anime.js v4 for the reveal: nodes stagger in, edges draw themselves. Guarded —
  if the animation import fails the diagram still renders, it just appears at
  once.
- Render id is unique per diagram (Mermaid leaves orphan nodes on `document.body`
  when a render throws; they get swept).

## Layout

The page is a single 660px column. When a diagram arrives the shell widens and
splits: diagram left (the larger half), the existing column right, unchanged.
When there is no diagram the page is exactly what it was. Below 1000px they
stack, diagram on top.

Newest diagram replaces the previous one. No history strip — if flipping back
through diagrams turns out to matter, the payloads are small and keeping the
last N is a list and two buttons.

The last diagram is held in memory and re-sent to a browser that connects or
reconnects, alongside `status` and `history`. Otherwise a refresh mid-call
loses the picture with no way to ask for it back.

## Not done

- No persistence across a service restart. `history.py` is the place for that
  if it is ever wanted.
- No pan/zoom. The SVG is scaled to fit. If diagrams get big enough that this
  hurts, Cytoscape.js is the fallback the research named — it does images on
  nodes natively and pans, at the cost of the agent emitting a JSON graph
  instead of a line of Mermaid.
- The extension copy in `extensions/` is a reference copy. The deployed
  authority is still the homelab Ansible template (see `AGENTS.md`), so this
  ships to damocles only through a homelab PR.

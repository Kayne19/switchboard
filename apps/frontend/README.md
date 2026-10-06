# Switchboard Frontend V17.2

This package is the approved React and TypeScript replacement frontend for Switchboard. It contains the working six-operation controller, reusable visual primitives, Motion-based transitions, fluid geometry-driven layouts, canonical fixtures, and design-lock tests.

## Repository integration

V17.2 is the frontend at `/`, and it runs the call itself. `src/runtime/`
owns the browser's side of a call: `callRuntime.ts` holds the backend
WebSocket (hello, heartbeat, reconnect, epochs and transfers, the clip
outbox), `pushToTalk.ts` records the caller, `audioPlayback.ts` plays replies,
and hands-free listening reuses `src/hands_free.ts` and the local wake-word
detector. The runtime owns no DOM; it reports state and backend messages to
`src/integration/runtime.tsx`, which turns them into the six-operation display
protocol and sends the rendered scene back as screen-state reports. The
Damocles presence is the only call control the design exposes.

The wake-word engine and ONNX Runtime are not bundled: they load from the
committed `/openwakeword/` files through the import map in `index.html`, and
Vite treats the package as external.

Production integration coverage lives in `tests/integration/callRuntime.spec.ts`
(a fixture WebSocket plus Chromium's fake microphone). The semantic event
mapping is covered by `tests/visual/runtime.spec.ts`.

## Start

```bash
npm install
npm run dev
```

The first connected install should create `package-lock.json`. Commit that lockfile before integration so later agents and CI resolve the same dependency graph.

Open the URL printed by Vite. The configured development and preview port is `4173`.

## Commands

```bash
npm run dev              # development server on the local network
npm run build            # typecheck and fully bundled production build
npm run preview          # serve the production build
npm run typecheck        # TypeScript only: the app and its unit tests, the Playwright specs, the configs, the host agent
npm test                 # every CI gate but Rust and the static diff: build, skill, node, syntax, unit, design lock, host agent, no-ssh, hygiene
npm run test:visual      # browser specs (Playwright): the pixel goldens and the geometry checks; CI does not run them
npm run build:cdn        # dependency-light browser preview using pinned CDN modules
```

## Controls

| Input | Action |
|---|---|
| `1` through `9` | Load idle, conversation, training, architecture, email, code, results (table), handoff (sequence diagram), or comparison (bar chart) fixture |
| `L` | Toggle listening |
| `C` | Open or close the controller sandbox |
| `J` | Open or close the current Scene IR |
| `Esc` | Leave focus, transcript, controller, or IR mode |
| Swipe left or right | Change fixture on touch displays |
| Tap Damocles | Toggle listening without replacing the current scene |
| Tap primary content | Focus that object |

The tenth to twelfth fixtures have no number key: `figure` (an inline PNG
test card: the image type), `plan` (a merge-path diagram, with the stepped
plan as a module in the rail between the metric trends and the note) and
`composed` (a diagram primary with a table and a figure in the aux row under
it, a note and two metrics in the rail: the visuals an agent can compose
beside a visual primary). Reach them with `/?scene=figure`, `/?scene=plan`
and `/?scene=composed`, or by swiping past `comparison`. The personal-assistant
fixtures follow the hard diagrams: `calendar` (Kayne's week, with a note on the
dentist appointment), `calendar-day`, `calendar-month` and `calendar-agenda`
(the same calendar in the other three views: an overnight shift and a freeze
past midnight, a busy day and bars over weekends, empty days), `tasks`, `timer` (its instants set when the page loads,
so it counts down), `weather`, `inbox`, and `today` (the day's agenda with the
forecast, the to-do list and the inbox beside it).

Direct fixture URLs are also supported:

```text
/?scene=training
/?scene=architecture
/?scene=code
/?scene=results
/?scene=handoff
/?scene=comparison
/?scene=figure
/?scene=plan
/?scene=composed
/?scene=topology
/?scene=pipeline
/?scene=trace
```

`topology`, `pipeline` and `trace` are the hard diagrams: the switchboard's
own twenty-two parts as a graph, a forty-step CI pipeline in layers up to
twelve wide, and a transfer traced as a sequence of eight actors and
thirty-two messages. They are what agents really send, and where a drawing
scaled to fit stops being read (`docs/visual-channel.md`). They have no number
key either: reach them by URL or by swiping.

## Runtime API

The browser exposes a deliberately small controller:

```ts
window.SwitchboardController.dispatch(action)
window.SwitchboardController.run(actions)
window.SwitchboardController.load("training")
window.SwitchboardController.state()
```

Damocles only needs six protocol operations:

```text
show  hide  say  focus  listen  clear
```

See [PROTOCOL.md](./PROTOCOL.md).

## Integration cutoff

This package is intended to enter the real Switchboard repository as a parallel frontend route first, for example `/new`. Connect the current backend transport to the controller, validate parity, then replace the old root route. Do not redesign the primitives during transport integration.

Read these files before modifying the implementation:

1. [AGENTS.md](./AGENTS.md)
2. [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)
3. [ARCHITECTURE.md](./ARCHITECTURE.md)
4. [INTEGRATION.md](./INTEGRATION.md)

## Prebuilt preview

`dist/` contains a prebuilt browser preview of the same TypeScript source. It uses pinned ESM CDN modules so it can be generated without a local package install. Serve it rather than opening it through `file://`:

```bash
python3 -m http.server 8000 --directory dist
```

Then open `http://localhost:8000`.

The normal `npm run build` creates the preferred fully local Vite bundle.

# Switchboard Frontend V17.2

This package is the approved React and TypeScript replacement frontend for Switchboard. It contains the working six-operation controller, reusable visual primitives, Motion-based transitions, fluid geometry-driven layouts, canonical fixtures, and design-lock tests.

## Repository integration

V17.2 is the primary frontend at `/`. The previous client is preserved at
`/legacy/` and runs in an inaccessible, same-origin runtime frame behind V17.2
so its proven WebSocket, recording, wake-word, audio playback, reconnect,
outbox, and project/model controls remain authoritative during the cutover.
`src/integration/runtime.tsx` converts runtime events into the six-operation
display protocol and relays V17.2 controls back to that runtime. The frame is
hidden from the accessibility tree; the React controls are the only exposed
interaction surface.

Production integration coverage lives in `tests/integration/bridge.spec.ts`.
The semantic event mapping and live Mermaid path are covered by
`tests/visual/runtime.spec.ts`.

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
npm run typecheck        # TypeScript only
npm test                 # reducer tests and design-lock checks
npm run test:visual      # canonical scene screenshots
npm run build:cdn        # dependency-light browser preview using pinned CDN modules
```

## Controls

| Input | Action |
|---|---|
| `1` through `6` | Load idle, conversation, training, architecture, email, or code fixture |
| `L` | Toggle listening |
| `C` | Open or close the controller sandbox |
| `J` | Open or close the current Scene IR |
| `Esc` | Leave focus, transcript, controller, or IR mode |
| Swipe left or right | Change fixture on touch displays |
| Tap Damocles | Toggle listening without replacing the current scene |
| Tap primary content | Focus that object |

Direct fixture URLs are also supported:

```text
/?scene=training
/?scene=architecture
/?scene=code
```

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

# Integration Plan

## Current repository status

The cutover described below is implemented in this repository. V17.2 is built
to `static/` and served at `/`; the previous client remains available at
`/legacy/` and supplies the isolated voice/runtime bridge. The production
bridge and semantic adapter are covered by `tests/integration/bridge.spec.ts`
and `tests/visual/runtime.spec.ts` respectively.

## Goal

Replace the current Switchboard presentation layer without disturbing the existing backend behavior or weakening the approved visual system.

## Recommended rollout

### 1. Add in parallel

Mount this application under a temporary route such as `/new` while the existing frontend remains at `/current` or `/`.

### 2. Adapt transport

Create a thin adapter that converts existing backend events into protocol actions and dispatches them through:

```ts
window.SwitchboardController.dispatch(action)
```

In the React source, prefer importing the controller context directly once the adapter lives inside the application.

### 3. Preserve existing capabilities

Map current functionality before deleting the old frontend:

- text and voice messages
- project-session routing
- code display
- diagrams
- training telemetry
- email and document display
- focus and dismissal
- connection and error states

### 4. Validate

Run:

```bash
npm run typecheck
npm test
npm run test:visual
npm run build
```

Then verify the canonical fixtures in portrait, standard landscape, and very wide landscape.

### 5. Cut over

Make the new application the root frontend only after real backend traffic works through the controller. Keep one tagged rollback commit. Remove the old presentation layer after cutover rather than maintaining two permanent systems.

## Do not do during integration

- Do not convert primitives into a generic component library.
- Do not replace the scene protocol with backend-specific UI payloads.
- Do not let the backend send coordinates or CSS.
- Do not add device-specific layout branches.
- Do not replace irregular frames with standard cards.
- Do not rewrite the Damocles logo.
- Do not update golden screenshots merely to make a test pass.

## Suggested repository placement

```text
apps/frontend/
  src/
    app/
    components/
    controller/
    design/
    fixtures/
    hooks/
    primitives/
    styles/
  tests/
  reference/
  AGENTS.md
  DESIGN_SYSTEM.md
  ARCHITECTURE.md
  PROTOCOL.md
```

If the existing repository already uses `apps/frontend/src`, merge these directories there rather than nesting another application root.

# Migration Checklist

Use this checklist when moving V17.2 into the real Switchboard repository.

## Before integration

- [ ] Create a rollback branch or tag for the existing frontend.
- [ ] Read `AGENTS.md`, `DESIGN_SYSTEM.md`, `ARCHITECTURE.md`, `PROTOCOL.md`, and `INTEGRATION.md`.
- [ ] Run `npm install` and commit the generated `package-lock.json`.
- [ ] Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:visual` in this package.
- [ ] Review `reference/contact_sheet.png` and the lineage files.

## Parallel route

- [ ] Mount the new React app at a temporary route such as `/new`.
- [ ] Keep the old frontend available until real backend traffic works through the new route.
- [ ] Add a thin transport adapter that validates incoming actions before dispatch.
- [ ] Map existing text, voice, code, diagrams, training telemetry, email, focus, and connection states.
- [ ] Do not send layout coordinates or CSS from the backend.

## Acceptance

- [ ] Test portrait, landscape, and very wide display geometries.
- [ ] Test touch, keyboard, resize, rotation, scrolling, focus, transcript, and listening.
- [ ] Verify stable IDs update objects in place instead of remounting them.
- [ ] Verify long code and documents remain inside irregular frame bounds.
- [ ] Review every visual snapshot difference as a design change.
- [ ] Confirm `prefers-reduced-motion` behavior.

## Cutover

- [ ] Make the new frontend the root route in a rollback-safe commit.
- [ ] Remove the old presentation layer only after cutover verification.
- [ ] Preserve fixtures, goldens, lineage, and design-lock tests in the real repository.

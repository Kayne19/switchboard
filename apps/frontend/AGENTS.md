# Agent Instructions: Switchboard Frontend

Read `DESIGN_SYSTEM.md`, `ARCHITECTURE.md`, `PROTOCOL.md`, and `MIGRATION_CHECKLIST.md` before changing this frontend.

## Default behavior

1. Reproduce the requested change using a canonical fixture.
2. Find the primitive that owns the behavior.
3. Modify that primitive once.
4. Avoid page-specific patches unless the content semantics are genuinely unique.
5. Run `npm run typecheck`, `npm test`, and relevant visual tests.
6. Report any approved screenshot changes explicitly.

## Forbidden casual changes

- Redrawing or approximating the Damocles glyph
- Device-name or device-width breakpoints
- Model-controlled coordinates, dimensions, or CSS
- Rounded dashboard cards or generic enterprise UI
- Fake telemetry
- Separate implementations of focus, listening, scrolling, or presence per page
- Replacing portrait recomposition with desktop scaling
- Updating goldens to hide a regression
- Adding operations to the six-operation protocol without demonstrating that composition cannot represent the behavior

## Visual regression policy

A visual snapshot failure is a design change until proven otherwise. Do not run the snapshot update command as an automatic repair. Explain the intended difference and obtain approval first.

## Refactoring policy

Refactoring must preserve:

- stable object IDs
- six-operation semantics
- exact glyph geometry
- geometry-driven layouts
- semantic color meaning
- shared focus identity
- scroll clipping against irregular frames
- reduced-motion behavior

A cleaner abstraction that weakens one of these properties is not an improvement.

# Slice 1 implementation

Implemented the Rust lifecycle/coordinator seam and wired API generation/status reads through it without changing wire shapes.

- Added `src/lifecycle.rs` with `CallLifecycle`, `Coordinator`, `LegIdentity`, generation-aware `OperationIdentity`, phases, candidate startup state, immutable `StatusProjection`, and generation-matched `CatalogPublication`.
- Added short synchronous linearization methods for prompt begin/finish, steer attachment to the active prompt operation, callback acceptance, rescue generation advancement, candidate startup thinking/adoption, status publication, and shutdown.
- Replaced `AppInner`'s cached status/generation ownership with `Coordinator`; existing API stale-work checks and epoch snapshots now use coordinator generation.
- Added focused lifecycle tests for operation identity sharing, stale generations, candidate thinking privacy/adoption, catalog publication matching, rescue reopening, and status lock liveness.
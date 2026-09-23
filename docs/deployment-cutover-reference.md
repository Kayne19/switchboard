# Deployment Cutover Reference: CLOSED

Status: CLOSED — homelab PR #168 merged and deployed to Damocles

## Summary
Display reliability phase 1 and pbx fixes are on `master` in the Switchboard repository. Homelab PR #168 was merged and automatically deployed via the `production-infrastructure` pipeline.

## Deployed Release
- Homelab PR: https://github.com/Kayne19/homelab/pull/168 (merged)
- Switchboard source commit: `89b5d44194637f024e404c2f735a6f7c6f86706b`
- Homelab merge commit: `5ff6c9b`
- Target: `damocles` (192.168.1.217:8765)

## History
- Homelab PR #147 / #148 (2026-09-07): initial Rust deploy, pinned `29fd7b1`.
- Homelab PR #167 (merged): semantic display channel cutover, pinned `2e9c45e`; added `SWITCHBOARD_DISPLAY_URL`.
- Homelab PR #168 (merged 2026-09-23): display reliability phase 1 + pbx fixes, pinned `89b5d44`. Verified live.

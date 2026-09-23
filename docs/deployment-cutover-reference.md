# Deployment Cutover Reference: OPEN

Status: OPEN — awaiting review and merge of homelab PR #168

## Summary
Display reliability phase 1 and pbx fixes are on `master` in the Switchboard repository. Homelab PR #168 pins Damocles to the new commit.

## Open PR
Homelab PR: https://github.com/Kayne19/homelab/pull/168
Switchboard source commit: `89b5d44194637f024e404c2f735a6f7c6f86706b`
Homelab change commit: `79a6449`

## History
- Homelab PR #147 / #148 (2026-09-07): initial Rust deploy, pinned `29fd7b1`.
- Homelab PR #167 (merged): semantic display channel cutover, pinned `2e9c45e`; added `SWITCHBOARD_DISPLAY_URL`.
- Homelab PR #168 (open): display reliability phase 1 + pbx fixes, pinned `89b5d44`.

## Checklist for PR #168
1. Review and merge https://github.com/Kayne19/homelab/pull/168.
2. Confirm `switchboard_version` is `89b5d44194637f024e404c2f735a6f7c6f86706b`.
3. `SWITCHBOARD_DISPLAY_URL` is already present from PR #167 — no change needed.
4. No new `SWITCHBOARD_*` variables in this build.

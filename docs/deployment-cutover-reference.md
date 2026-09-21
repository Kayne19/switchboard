# Deployment Cutover Reference: BLOCKED

Status: BLOCKED

## Summary
The display channel clean cutover has been implemented in the Switchboard repository (`POST /display`, `SWITCHBOARD_DISPLAY_URL`), completely removing the deprecated diagram endpoint and legacy variables without compatibility shims or aliases. External deployment handoff to Damocles is currently **BLOCKED**.

## Blocker
No external Homelab pull request or pinned release reference exists yet for the clean display cutover.
In accordance with repository guidelines (`AGENTS.md` and slice constraints), external Homelab PR or release references must be auditable lab facts and cannot be invented or assumed.

## Current External Deployment Baseline
- Pinned commit in `homelab`: `29fd7b1bd6873774f64cfc996d76a7e5b000517c` (merged via Homelab PR #147 and PR #148 on 2026-09-07).
- That baseline predates the clean display cutover and does not support the canonical `SWITCHBOARD_DISPLAY_URL` protocol.

## Unblocking Requirements
To complete the deployment cutover and unblock the gate:
1. Open a pull request in `Kayne19/homelab`.
2. Update `switchboard_version` in `ansible/roles/damocles/defaults/main.yml` to the clean-cutover commit SHA or pinned tag.
3. Configure `SWITCHBOARD_DISPLAY_URL={{ switchboard_self_url }}/display` in `ansible/roles/damocles/templates/switchboard.env.j2`.
4. Confirm that the obsolete diagram environment variable is omitted.
5. Verify that extension staging on Damocles installs `extensions/agent-switchboard.ts` and `extensions/operator-switchboard.ts` from the exact same clean-cutover commit.
6. Record the resulting auditable Homelab pull request or release reference in this document to satisfy `test.deployment-gate`.

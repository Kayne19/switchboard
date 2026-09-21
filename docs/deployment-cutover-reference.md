# Deployment Cutover Reference: OPEN

Status: OPEN — awaiting review and merge of the homelab deployment PR

## Summary
The display channel clean cutover has been implemented in the Switchboard repository (`POST /display`, `SWITCHBOARD_DISPLAY_URL`), completely removing the deprecated diagram endpoint and legacy variables without compatibility shims or aliases. External deployment handoff to Damocles is currently **BLOCKED**.

## Blocker
Homelab PR: https://github.com/Kayne19/homelab/pull/167
Switchboard source commit: `2e9c45e8e3629f8cf5611ef36ddf8d9d390f17a8`
Homelab change commit: `48897ba`

The PR is open and auditable. Production handoff remains pending until both PRs are reviewed and merged.

## Current External Deployment Baseline
- Pinned commit in `homelab`: `29fd7b1bd6873774f64cfc996d76a7e5b000517c` (merged via Homelab PR #147 and PR #148 on 2026-09-07).
- That baseline predates the clean display cutover and does not support the canonical `SWITCHBOARD_DISPLAY_URL` protocol.

## Remaining Merge Requirements
To complete the deployment cutover and unblock the gate:
1. Review and merge the open pull request in `Kayne19/homelab`.
2. Confirm `switchboard_version` in `ansible/roles/damocles/defaults/main.yml` points to the clean-cutover commit SHA or pinned tag.
3. Configure `SWITCHBOARD_DISPLAY_URL={{ switchboard_self_url }}/display` in `ansible/roles/damocles/templates/switchboard.env.j2`.
4. Confirm that the obsolete diagram environment variable is omitted.
5. Verify that extension staging on Damocles installs `extensions/agent-switchboard.ts` and `extensions/operator-switchboard.ts` from the exact same clean-cutover commit.
6. Record the resulting auditable Homelab pull request or release reference in this document to satisfy `test.deployment-gate`.

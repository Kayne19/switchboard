Verification artifact for `/home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1785993137994978505_3627287_0/verify.md`:

```markdown
# Verification

Status: code gates passed. Deployment attestation remains incomplete.

Manifest inspection covered `Cargo.toml`/`Cargo.lock`, `package.json`/`package-lock.json`,
`tsconfig.json`, `rust-toolchain.toml`, `requirements.txt`, and CI workflow.

- `cargo fmt --all -- --check`: exit 0.
- `cargo test --locked`: exit 0; 50 passed.
- `cargo clippy --locked --all-targets -- -D warnings`: exit 0.
- `python3 -m unittest discover -s legacy/tests`: exit 0; 143 passed. Expected injected-error logs appeared.
- `npm test`: exit 0; TypeScript build and all browser tests passed.
- `git diff --check`: exit 0.
- `npm ci --ignore-scripts --dry-run`: exit 0; lockfile current.
- `cargo metadata --locked --no-deps --format-version 1`: exit 0; one package/workspace.
- `npm run build`: exit 0; repository status unchanged.

`git diff --exit-code -- static`: exit 1. The only reported difference is the expected,
currently-uncommitted generated `static/app.js` change. This is not a generated-source
mismatch; rebuilding reproduces the existing artifact. No files were intentionally edited
during verification.

## Model catalog evidence

- `src/models.rs:386-403` Rust fixture resolves:
  - `GPT 5.6` -> `openai/gpt-5.6`
  - `moonshot/luna` -> `moonshot/luna`
  - `openai/sol` -> `openai/sol`
- `tests/test_app.mjs:369-386` browser fixture exposes all three entries.
- Local `pi --list-models` succeeded (exit 0) and showed:
  - `cursor/gpt-5.6@1m` and `cursor/gpt-5.6@272k` variants
  - `openai-codex/gpt-5.6-luna`
  - `openai-codex/gpt-5.6-sol`
- Bare names may be ambiguous in the live catalog; use provider-qualified canonical IDs.

## Residual risks

The local catalog is not deployment evidence. Catalogs are queried per target host via
`pi --list-models` (`src/pi_client.rs:753-766`); this workspace lacks the homelab
deployment registry, target-host credentials, and remote-host verification. The deployed
copy remains homelab-controlled until cutover. No real browser/media-device, WebSocket
E2E, SSH project-host, or production STT/model validation was performed.
```

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "All requested gates were executed with exit statuses; model catalog evidence and deployment limitations are documented with source paths."
    }
  ],
  "changedFiles": [
    "package.json",
    "src/models.rs",
    "src/pbx.rs",
    "web/app.ts",
    "static/app.js",
    "tests/test_app.mjs"
  ],
  "testsAddedOrUpdated": [
    "src/models.rs",
    "tests/test_app.mjs"
  ],
  "commandsRun": [
    {"command": "cargo fmt --all -- --check", "result": "passed", "summary": "exit 0"},
    {"command": "cargo test --locked", "result": "passed", "summary": "50 passed"},
    {"command": "cargo clippy --locked --all-targets -- -D warnings", "result": "passed", "summary": "exit 0"},
    {"command": "python3 -m unittest discover -s legacy/tests", "result": "passed", "summary": "143 passed"},
    {"command": "npm test", "result": "passed", "summary": "build and browser tests passed"},
    {"command": "git diff --exit-code -- static", "result": "failed", "summary": "exit 1 due expected uncommitted static/app.js change"},
    {"command": "git diff --check", "result": "passed", "summary": "exit 0"},
    {"command": "pi --list-models", "result": "passed", "summary": "local catalog showed GPT 5.6, Luna, and Sol variants"}
  ],
  "validationOutput": [
    "Manifest and lockfile checks passed.",
    "Generated static output rebuilt reproducibly."
  ],
  "residualRisks": [
    "Deployment-host catalogs and credentials were not verifiable.",
    "No real browser, media-device, WebSocket, SSH, or production STT/model validation."
  ],
  "noStagedFiles": true,
  "diffSummary": "Verification only; approved source and generated static changes remain unstaged.",
  "reviewFindings": [
    "medium: deployment-side model availability cannot be attested from this repository.",
    "info: git diff --exit-code -- static is nonzero only because static/app.js is an expected uncommitted generated artifact."
  ],
  "manualNotes": "Local canonical IDs include openai-codex/gpt-5.6-luna and openai-codex/gpt-5.6-sol; bare names can be ambiguous."
}
```

[38;2;136;136;136m✻ Turn took 3m 15s (Total time 3m 14s · 2 turns)[0m
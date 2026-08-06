# Verification findings

No playback blockers found in the implemented scope. `web/app.ts` has one `player.play()` call and one owner-scoped `ended` registration; the old global playback variables/handler path are absent. The focused harness passed assertions for source cleanup, FIFO advancement, duplicate events, stale handlers/settlements, autoplay requeue, and terminal seek without click-resume.

The generated bundle is deterministic: two consecutive builds produced SHA-256 `4fc00a7d0d5beb70792e131f9f6e91bad46a44cb6e014340ee0b0ef21b451e26`. The literal CI command `git diff --exit-code -- static/app.js` returned exit 1 because `static/app.js` is intentionally one of the changed generated files; this is not a stale-output indication. The repeated-build check passed.

Commands and results:

- `npm run check` -> exit 0, TypeScript strict check passed.
- `npm test` -> exit 0, build plus protocol, diagram, extension, and app tests passed.
- `node tests/test_app.mjs` -> exit 0, focused playback/app regressions passed.
- `git diff --check` -> exit 0, no whitespace errors.
- `npm run build` twice with SHA-256 comparison -> exit 0, output stable.
- `python3 -m unittest discover -s legacy/tests` -> exit 0, 143 tests passed (expected simulated-error tracebacks were emitted).
- `cargo fmt --all -- --check` -> exit 127, unavailable: `cargo: command not found`.
- `cargo test --locked` -> exit 127, unavailable: `cargo: command not found`.
- `cargo clippy --locked --all-targets -- -D warnings` -> exit 127, unavailable: `cargo: command not found`.
- `git diff --exit-code -- static/app.js` -> exit 1, intentional generated diff as described above.

Residual risk: native browser media scheduling, autoplay policy, and terminal-seek event ordering remain outside the Node harness. Rust gates could not be verified in this environment. The worktree has no staged files; the only tracked changes are `web/app.ts`, `tests/test_app.mjs`, and regenerated `static/app.js`. Runtime `.pi-subagents/` and `.pi-workflow/` directories are untracked and unrelated.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "The scoped playback implementation, focused tests, and regenerated static/app.js are the only tracked changes; diagnostics and all available web gates passed."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Commands, exit statuses, focused playback assertions, deterministic generated-output verification, staged-file status, and unavailable Rust gates are recorded above."
    }
  ],
  "changedFiles": [
    "web/app.ts",
    "tests/test_app.mjs",
    "static/app.js"
  ],
  "testsAddedOrUpdated": [
    "tests/test_app.mjs"
  ],
  "commandsRun": [
    {
      "command": "npm run check",
      "result": "passed",
      "summary": "TypeScript strict check passed."
    },
    {
      "command": "npm test",
      "result": "passed",
      "summary": "Build and all browser/extension tests passed."
    },
    {
      "command": "node tests/test_app.mjs",
      "result": "passed",
      "summary": "Focused playback regressions passed."
    },
    {
      "command": "git diff --check",
      "result": "passed",
      "summary": "No whitespace errors."
    },
    {
      "command": "npm run build (twice; SHA-256 comparison)",
      "result": "passed",
      "summary": "Generated static output was stable across rebuilds."
    },
    {
      "command": "python3 -m unittest discover -s legacy/tests",
      "result": "passed",
      "summary": "143 compatibility tests passed."
    },
    {
      "command": "git diff --exit-code -- static/app.js",
      "result": "failed",
      "summary": "Exit 1 is the intentional tracked generated-file diff, not post-build drift."
    },
    {
      "command": "cargo fmt --all -- --check",
      "result": "failed",
      "summary": "Unavailable in environment: cargo not found (exit 127)."
    },
    {
      "command": "cargo test --locked",
      "result": "failed",
      "summary": "Unavailable in environment: cargo not found (exit 127)."
    },
    {
      "command": "cargo clippy --locked --all-targets -- -D warnings",
      "result": "failed",
      "summary": "Unavailable in environment: cargo not found (exit 127)."
    }
  ],
  "validationOutput": [
    "Exactly one player.play() call and one owner-scoped ended registration exist in both source and generated bundle.",
    "Focused tests prove no restart on terminal seek and no simultaneous old/new active source.",
    "Two consecutive builds produced identical static/app.js SHA-256 output."
  ],
  "residualRisks": [
    "Real-browser media event scheduling and autoplay behavior remain uninstrumented.",
    "Rust format, test, and clippy gates remain unverified because cargo is unavailable."
  ],
  "noStagedFiles": true,
  "diffSummary": "Playback ownership lifecycle and focused regression coverage changed in web/app.ts and tests/test_app.mjs; static/app.js was regenerated.",
  "reviewFindings": [
    "No blockers found in the implemented playback scope."
  ],
  "manualNotes": "The static diff command is expected to fail against HEAD because the regenerated bundle is intentionally part of this worktree diff; the deterministic rebuild check passed."
}
```

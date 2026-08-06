# Task for code-reviewer

Audit the current diff and verification results against # Handoff Output: define
Status: success
Verdict: (none)
Timestamp: 1785999498

## Content
# Playback bug contract

**Outcome:** For all reply audio caused by one caller utterance, the browser has at most one audible playback owner. Pausing stops every owner. Seeking a clip to its end consumes it once and advances FIFO to the next clip once.

**Definitions:** A clip is one queued audio blob. “Consumed” means removed from current playback exactly once. A pause caused by seeking to the end is terminal only when paired with end confirmation, not an ordinary user pause.

## Invariants

1. **Single owner:** At most one audio element/source is actively audible. Replacing or advancing a clip pauses and cleans up the previous owner; no hidden stream remains.
2. **Pause:** Ordinary pause leaves the current clip retained, does not requeue or consume it, and leaves later clips queued. Resume continues that same clip.
3. **Queue:** Clips advance FIFO. A clip is dequeued/consumed once, never both retained and queued.
4. **End/seek:** End-of-clip processing is idempotent. `pause`/`ended` may arrive in either order after seeking to duration, but produce one consumption and one advancement.
5. **Stale events:** Events, play-promise settlements, and errors from an older clip cannot mutate the current clip, queue, or playback state.
6. **Duplicate events:** Repeated `ended`, `pause`, or `error` events cannot replay a consumed clip, skip the next clip, or start a second owner.

## Acceptance scenarios

- With clips A then B, starting A creates one active owner. Pausing the visible player leaves no audible owner; A remains current and B remains queued.
- Resuming after that pause plays A, not a requeued duplicate. B does not start early.
- Seeking A to its end with `pause → ended` advances exactly once to B. The same holds for `ended → pause`.
- Repeating either event after advancement leaves B current and starts B no more than once.
- A stale A event or `play()` rejection after B starts does not requeue A or alter B.
- Legitimate multiple audio clips from one utterance play sequentially, never simultaneously.

## Evidence and boundaries

- `web/app.ts:368-454` and mirrored `static/app.js:314-397` use global player state; media handlers have no explicit per-clip event identity or consumed latch. **High risk:** late events can affect a newer clip.
- `static/index.html:711` exposes one native player, so the reported “second stream” is not proven by source alone; runtime instrumentation must identify whether it is a second media owner or duplicate/restarted playback.
- `tests/test_app.mjs:90-116` does not cover both event orders without an intervening click, duplicate events, or hidden-owner detection. **Medium coverage gap.**
- `docs/concurrency-and-test-hazards.md:8-63` documents turn-epoch races, not browser playback ownership; those concerns must not be conflated.
- Non-goals: microphone recording lifecycle, server TTS generation/order, and model routing.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "The artifact gives concrete playback findings with severity, paths, invariants, and measurable acceptance scenarios."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Read docs/concurrency-and-test-hazards.md, web/app.ts, static/app.js, static/index.html, and tests/test_app.mjs."
  ],
  "residualRisks": [
    "The second audible owner is not identifiable from static source inspection alone.",
    "Existing tests do not prove duplicate-event idempotence or hidden-owner cleanup."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed; bug contract only.",
  "reviewFindings": [
    "high: web/app.ts:368-454 - playback handlers lack explicit per-clip event identity/consumed protection",
    "medium: tests/test_app.mjs:90-116 - incomplete event-order and duplicate-event coverage"
  ],
  "manualNotes": "Runtime reproduction should instrument every audio owner while testing pause and seek-to-end event permutations."
}
```

[38;2;136;136;136m✻ Turn took 1m 52s (Total time 1m 51s · 1 turn)[0m, # Handoff Output: explore
Status: success
Verdict: (none)
Timestamp: 1785999651

## Content
# Playback review

## Map and data flow

- Recent HEAD: `e1e8f532` (“Format picker operation chain”), parent `62ff8828` (“Harden audio lifecycle and model catalog”).
- One native player exists: `static/index.html:711`, initialized by `web/app.ts:63`; no `new Audio`, `AudioContext`, `MediaSource`, or second player was found.
- Server audio is FIFO before browser delivery: `src/api.rs:75-131` reserves/finishes ordered slots, then sends metadata followed by binary audio at `src/api.rs:1264-1274`.
- Browser binary frames enqueue at `web/app.ts:878`; `playNext()` consumes FIFO using `currentBlob || audioQueue.shift()` at `web/app.ts:368-386`.
- Generated output mirrors this in `static/app.js:314-400`; `static/index.html` loads only `/app.js`.

## Findings

- **High: stale media events are not clip-scoped.**  
  `web/app.ts:409-433` and `static/app.js:353-380` use global `player` state and `currentBlob` without event identity or a consumed latch. A late `pause` can set `isPlaying = false` for the next clip; a late `error` can clear the next clip and advance again; a late/duplicate `ended` can consume the wrong clip when `player.ended` is true. This violates stale-event and idempotence invariants.

- **Medium: replacement relies on implicit browser behavior.**  
  `web/app.ts:370-386` revokes the old URL and assigns `player.src`, but does not explicitly pause/clean the old owner before replacement. The source contains only one native element, so a second audible owner is not proven, but runtime browser behavior around source replacement remains the leading hidden-owner hypothesis.

- **Medium: document click can race seek completion.**  
  `web/app.ts:437-454` resumes any retained clip on any document click. If a seek interaction produces `pause` before `ended` and its click bubbles, `play()` may restart the terminal clip before end confirmation.

- **Medium coverage gap:** `tests/test_app.mjs:90-116` covers only `pause → click/resume → ended`. It does not cover `ended → pause`, duplicate events, stale errors, stale play rejections, or owner cleanup. Its fake player does not model `paused`, `pause()`, `load()`, or `error`.

## Cleanup and listener audit

Epoch rescue at `web/app.ts:769-780` clears the queue, increments playback generation, pauses, revokes the URL, removes `src`, and calls `load()`. Promise callbacks are generation/blob guarded at `web/app.ts:389-406` and `444-452`. No duplicate media listeners or additional audio owners were found.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Mapped all browser audio creation, queue, play, pause, ended, error, replacement, epoch cleanup, server delivery, generated output, and browser-test paths with severity-rated findings."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Inspected .git/logs/HEAD, web/app.ts, static/app.js, static/index.html, src/api.rs, tests/test_app.mjs, and related audio/server paths.",
    "Found one native audio element and no alternate Audio/API-based playback owner."
  ],
  "residualRisks": [
    "Static inspection cannot identify whether the reported second stream is a browser source-replacement artifact, another tab, or runtime duplication.",
    "Stale media-event behavior is not covered by existing tests."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed; review-only playback investigation.",
  "reviewFindings": [
    "high: web/app.ts:409-433 and static/app.js:353-380 - media handlers lack clip identity and consumed protection",
    "medium: web/app.ts:370-386 and static/app.js:314-332 - replacement does not explicitly pause the prior owner",
    "medium: web/app.ts:437-454 and static/app.js:384-400 - document click resume may race seek-to-end events",
    "medium: tests/test_app.mjs:90-116 - incomplete event-order, duplicate-event, stale-event, and owner-cleanup coverage"
  ],
  "manualNotes": "Instrument player events, src changes, play/pause calls, and every browser tab during runtime reproduction."
}
```

[38;2;136;136;136m✻ Turn took 2m 27s (Total time 2m 27s · 1 turn)[0m, and # Handoff Output: verify
Status: success
Verdict: (none)
Timestamp: 1786000882

## Content
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
. Look for regressions in normal auto-advance, pause/resume, rapid seek, stale event callbacks, accessibility, unrelated scope, and missing committed static output. Finish with APPROVE or REQUEST_CHANGES and list actionable findings only.

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1785999378987544477_3719023_0/review_code.md
Do not call contact_supervisor merely because no write-capable tool is available.
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```
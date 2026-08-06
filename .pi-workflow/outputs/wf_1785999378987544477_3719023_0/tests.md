# Playback regression coverage

Added focused browser-harness assertions in `tests/test_app.mjs`:

- Tracks source URLs currently audible and verifies replacement pauses/cleans the old source before the next clip starts.
- Covers natural `ended` advancement with duplicate `ended`/late `pause` events, asserting one play of the next clip.
- Covers terminal seeking without click-resume, with both `pause -> ended` and `ended -> pause` orderings, plus duplicate events and FIFO advancement.

Commands:

- `node tests/test_app.mjs` passed.
- `npm test` passed, including TypeScript rebuild and all browser tests.
- `git diff --check` passed.

Remaining untested: a real browser's native media event scheduling and independently created hidden `HTMLAudioElement` instances. The harness models source ownership on the exposed player and catches an old source remaining audible during replacement.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "tests/test_app.mjs now tracks active source URLs and covers natural completion plus terminal seek event permutations without scope expansion."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Focused app tests and the full npm test workflow passed; source ownership, FIFO advancement, duplicate-event idempotence, and no terminal-click restart are asserted."
    }
  ],
  "changedFiles": [
    "tests/test_app.mjs"
  ],
  "testsAddedOrUpdated": [
    "tests/test_app.mjs"
  ],
  "commandsRun": [
    {
      "command": "node tests/test_app.mjs",
      "result": "passed",
      "summary": "App audio lifecycle, playback ordering, and model picker regressions passed."
    },
    {
      "command": "npm test",
      "result": "passed",
      "summary": "TypeScript rebuild and all protocol, diagram, extension, and app tests passed."
    },
    {
      "command": "git diff --check",
      "result": "passed",
      "summary": "No whitespace errors."
    }
  ],
  "validationOutput": [
    "Active source tracking remained at one during replacement and zero after final consumption.",
    "Natural completion and both terminal-seek event orders advanced exactly once without replaying the current clip."
  ],
  "residualRisks": [
    "No real-browser media scheduler or independently-created hidden audio element is exercised by this dependency-free harness."
  ],
  "noStagedFiles": true,
  "diffSummary": "Expanded the existing app playback regression harness with source ownership tracking and focused natural/terminal end assertions.",
  "reviewFindings": [
    "No blockers found in the focused test changes."
  ],
  "manualNotes": "The worktree also contains the implemented playback changes in web/app.ts and static/app.js; npm test rebuilt static output successfully."
}
```

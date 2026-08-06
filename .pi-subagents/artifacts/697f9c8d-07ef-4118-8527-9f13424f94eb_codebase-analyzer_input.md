# Task for codebase-analyzer

Repo: /home/kayne19/projects/switchboard (Rust axum backend + TypeScript browser client compiled to static/).

GOAL CONTEXT: we are adding an ON-PAGE MODEL SWITCHER to the web UI. A thinking-level switcher ALREADY EXISTS and works end to end. Your job is to map that existing path exactly so it can be mirrored.

Trace and report precisely, with file:line:
1. web/app.ts: `thinkingSelect` (~line 59), the populate call (~line 476), the disabled rule (~line 483), and the change listener (~line 895). Report the exact helper function used to populate a select (name + signature) and the exact `post()` helper signature.
2. static/index.html: the markup for thinkingSelect and its surrounding container/labels.
3. src/api.rs: the `/thinking` route registration (~line 157) and the full `async fn thinking` handler (~line 615), including spawn_active_operation vs spawn_replacing_operation branching, deliver_page_reply_if_current, and the error/status codes returned.
4. src/pbx.rs: `set_thinking` — full body. AND report whether a `set_model` / model-change equivalent already exists on the same struct.
5. src/models.rs: `ModelCatalog` — how it is built, how `resolve(model, thinking)` works, and whether the catalog (list of provider/model entries) is currently exposed to the browser at all.
6. The status/WebSocket payload: which fields carry model info to the page (e.g. msg.model, msg.thinking, msg.thinking_default, msg.model_swaps, msg.thinking_confirmed). Report the exact serialization site in Rust and the exact consumption site in web/app.ts.
7. Build/test commands. NOTE: cargo is NOT on PATH by default; prefix commands with `export PATH="$HOME/.cargo/bin:$PATH"`. Confirm cargo test, npm run check, npm run build, npm test all exist and note that web/app.ts compiles to static/app.js via tsc.

Do NOT write code. Output a precise map with file:line references.

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1785952055827064028_3602195_0/explore.md
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
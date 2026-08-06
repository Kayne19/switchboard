# Task for plan-reviewer

Review this plan for the on-page model switcher.

PLAN:
# Handoff Output: plan
Status: success
Verdict: (none)
Timestamp: 1785952421

## Content
# Minimal implementation plan

1. **Expose the cached catalog and add the PBX mutator**
   - `src/pbx.rs:Switchboard::status`: add `models` containing current-project cached `ModelCatalog.entries`, serialized as `{provider, model, thinks}`. Use `[]` for operator/cache misses; no `src/models.rs` changes.
   - `src/pbx.rs:Switchboard::set_model`: reject operator changes, otherwise call `redial(model, "", "", true)`. This preserves context, current thinking, `model_swaps`, `resolve()`, and `ModelError` behavior.

2. **Mirror `/thinking` at the API layer**
   - `src/api.rs:AppState::router`: register `POST /model`.
   - Add `Model { model: String }` and `model()` beside `thinking()`.
   - Use the same active-vs-replacing operation branch, cancellation responses, `clear_active_operation`, `deliver_page_reply_if_current`, and generation guard.
   - Request: `{ "model": "provider/model" }`.
   - Success: HTTP 200, `{ "model": "provider/model", "error": null }`; PBX validation failures remain HTTP 200 with the error string, matching `/thinking`.
   - Cancellation/supersession remain HTTP 409; task failures remain HTTP 500.

3. **Add the browser control and types**
   - `static/index.html`: add `#modelSelect` in `#legControls`, before `#thinkingSelect`, with a model-specific `title`.
   - `web/browser.d.ts`: type `models` as catalog entries.
   - `web/app.ts`: bind `modelSelect`; populate it in `setRoute()` through existing `fillSelect()`, using `provider/model` values and `msg.model_name` as current selection.
   - Add a current-model fallback option when the catalog is empty, without inventing alternatives.
   - Disable with `!onProject || msg.model_swaps === false`; the operator remains non-swappable.

4. **Reuse existing POST/error behavior**
   - `web/app.ts`: add the model change listener and call `post("/model", { model }, modelSelect)`.
   - `web/protocol.ts`: have existing `postJson()` return the successful JSON payload; have existing `post()` treat a non-null response `error` as an exception. This surfaces `ModelError` while retaining the endpoint’s existing 200-plus-error contract and also improves `/thinking`.
   - Update `tests/test_protocol.mjs`’s fetch stub for JSON responses and verify successful error payloads reject.

5. **Tests and generated output**
   - Extend Rust tests in `src/pbx.rs` and `src/api.rs` for catalog serialization, invalid-model refusal without replacing the live spec, request/response shape, and operation behavior.
   - Run the TypeScript build; commit generated `static/app.js`. Do not hand-edit it.

### Verification

```text
export PATH="$HOME/.cargo/bin:$PATH"
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
python3 -m unittest discover -s legacy/tests
npm run check
npm test
git diff --exit-code -- static
```

### Rejected alternatives and risks

- Rejected a `/models` polling endpoint: status/WebSocket already carries the required payload.
- Rejected a second resolver or dependency: `ModelCatalog::resolve()` and `redial()` are the authoritative path.
- Rejected HTTP 400 for PBX model errors because it would diverge from `/thinking`.
- Catalog fetch failure leaves only the current-model fallback; alternatives cannot be safely fabricated.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "The plan confines implementation to the existing PBX/API/status/browser paths, with only narrow protocol typing and generated-output updates required for error surfacing and the committed build."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Exact symbols, endpoint shapes, concurrency semantics, validation path, verification commands, rejected alternatives, and residual risks are specified."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Repository map and relevant Rust, TypeScript, HTML, test, and README paths inspected.",
    "No code was written because this deliverable is plan-only."
  ],
  "residualRisks": [
    "Catalog listing failures provide no alternative model choices beyond the current-model fallback."
  ],
  "noStagedFiles": true,
  "diffSummary": "No implementation changes; produced the minimal implementation plan.",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "Implementation should regenerate static/app.js and verify the full command list."
}
```

[38;2;136;136;136m✻ Turn took 3m 18s (Total time 3m 17s · 1 turn)[0m

CODEBASE MAP:
# Handoff Output: explore
Status: success
Verdict: (none)
Timestamp: 1785952219

## Content
# Existing thinking-level switcher map

## 1. Browser implementation

- `web/app.ts:59`: `const thinkingSelect = getElement<HTMLSelectElement>("thinkingSelect");`
- Helper: `web/app.ts:434-451`
  ```ts
  function fillSelect(
      select: HTMLSelectElement,
      values: Array<{ value: string; label: string }>,
      current?: string,
  ): void
  ```
  It rebuilds options only when values change, then selects `current`.
- Population: `web/app.ts:476-482`
  ```ts
  fillSelect(
      thinkingSelect,
      (msg.levels || []).map((l) => ({
          value: l,
          label: "thinking: " + l,
      })),
      msg.thinking || msg.thinking_default || "",
  );
  ```
- Disabled rule: `web/app.ts:483`: `thinkingSelect.disabled = onProject && msg.model_swaps === false;`
- POST helper: `web/app.ts:493-510`
  ```ts
  async function post(
      url: string,
      body: Record<string, string>,
      control: HTMLSelectElement,
  ): Promise<void>
  ```
  It disables the control, calls imported `postJson(url, body)`, displays errors, then re-enables the control.
- Change listener: `web/app.ts:895-898`; posts `POST /thinking` with `{ level: thinkingSelect.value }`.

## 2. HTML markup

`static/index.html:650-672`:

```html
<div id="line">
  <span class="who" id="who">—</span>
  <span class="model" id="model"></span>
  <div id="legControls">
    <select
      id="routeSelect"
      title="Connect straight to a project, without asking the operator"
    >
      <option value="operator">Operator</option>
    </select>
    <select
      id="thinkingSelect"
      title="Thinking level for this leg and the ones after it"
    ></select>
    <button id="hangupBtn" class="hidden" ...>Hang up</button>
  </div>
</div>
```

There is no visible `<label>`; the select's semantic label is its `title`.

## 3. `/thinking` backend path

- Registration: `src/api.rs:153-161`, specifically `src/api.rs:157`:
  `.route("/thinking", post(thinking))`
- Handler: `src/api.rs:611-658`.
  - Deserializes `{ "level": String }`.
  - Locks `Switchboard`, calls `board.set_thinking(&req.level).await`, captures `board.status()`.
  - If the live route is operator, uses `spawn_active_operation` (`src/api.rs:243-256`), preserving the current turn generation.
  - Otherwise uses `spawn_replacing_operation` (`src/api.rs:529-546`), which cancels active operations, increments the generation/epoch, then starts the replacement operation.
  - Cancelled task: HTTP `409 Conflict`, `{"detail":"thinking change was cancelled"}` (`src/api.rs:631-637`).
  - Other task failure: HTTP `500 Internal Server Error`, detail includes the error (`src/api.rs:639-645`).
  - Clears the active operation, then calls `deliver_page_reply_if_current` (`src/api.rs:649`).
  - Superseded generation: HTTP `409 Conflict`, `{"detail":"thinking change was superseded"}` (`src/api.rs:649-655`).
  - Success: HTTP `200`, `{"thinking": current_status["thinking"], "error": reply.error}` (`src/api.rs:656-657`). A PBX validation/model error is therefore represented in the JSON `error` field while the HTTP status remains 200.
- `deliver_page_reply_if_current` is `src/api.rs:750-775`: generation-checks, records spoken reply text, publishes the status, then synthesizes reply audio.

## 4. PBX thinking/model mutation

`src/pbx.rs:1441-1457`:

```rust
pub async fn set_thinking(&mut self, level: &str) -> Reply {
    match normalize_thinking(level) {
        Ok(value) if !value.is_empty() => {
            self.agent_thinking = value.clone();
            if self.route == OPERATOR {
                return self.reply(
                    [format!(
                        "Thinking is set to {value} for the next project call."
                    )],
                    None,
                );
            }
            self.redial("", &value, "", true).await
        }
        Ok(_) => self.reply(["Name a thinking level and I'll set it."], None),
        Err(e) => self.reply([e.to_string()], Some(e.to_string())),
    }
}
```

There is no `set_model` method on `Switchboard`. The equivalent is private `redial` at `src/pbx.rs:1120-1261`. The `set_model` agent-tool signal is handled at `src/pbx.rs:501-520` and invokes `redial`; page thinking changes also invoke `redial` for project legs.

## 5. `ModelCatalog`

- Types: `src/models.rs:48-62`; each `CatalogEntry` has `provider`, `model`, and `thinks`.
- Parsing: `ModelCatalog::parse` at `src/models.rs:182-199`. It splits whitespace rows, skips rows with fewer than five fields and the `provider` header, and sets `thinks` from column five being `"yes"`.
- Lazy construction: `src/pbx.rs:1054-1086`, especially `1074-1085`. `Switchboard` caches catalogs by `host + NUL + runtime`; it invokes `fetch_catalog(list_models_argv(...))`.
- `list_models_argv` uses local `runtime --list-models`, or SSH for remote projects: `src/pi_client.rs:753-762`.
- `fetch_catalog` executes and safely degrades to an empty catalog on spawn, timeout, output-limit, or non-success failure: `src/models.rs:297-370`.
- Resolution: `ModelCatalog::resolve(model, thinking)` at `src/models.rs:201-294`.
  It parses provider/model/thinking, normalizes the requested thinking level, requires a model name, requires provider-qualified names when the catalog is empty, filters by provider, prefers normalized exact model matches, otherwise substring matches, rejects ambiguity, rejects thinking for entries with `thinks == false`, and returns `ModelChoice`.
- The catalog is **not exposed to the browser**. There is no `/models` route, and status serialization exposes `levels`, `projects`, and model identity but not catalog entries. `BrowserMessage.entries` is transcript history, not model catalog data.

## 6. Status/WebSocket payload

- Serialization: `src/pbx.rs:276-290`, especially line 289:
  - `model`: current full spec (`operator_model` or `model_spec`), potentially including `:thinking`.
  - `model_name`: provider/model without thinking suffix.
  - `thinking`: effective reported level, falling back to requested suffix.
  - `thinking_requested`: requested suffix.
  - `thinking_confirmed`: whether the live leg reported an effective level.
  - `thinking_default`: configured default.
  - `levels`: `THINKING_LEVELS`.
  - `model_swaps`: feature gate.
- The status is sent initially over WebSocket by `send_snapshot`: `src/api.rs:924-942`; route callbacks also emit status at `src/api.rs:107-117`, and `publish_status` emits updates at `src/api.rs:235-241`.
- Runtime confirmation from the agent arrives through `/leg-state`: `src/api.rs:664-672`, which updates `thinking` and sets `thinking_confirmed: true`.
- Browser consumption:
  - `web/app.ts:459-465`: displays `msg.model_name || msg.model`; displays `msg.thinking`, adding `(requested)` when `!msg.thinking_confirmed`.
  - `web/app.ts:476-482`: uses `msg.thinking`, then `msg.thinking_default`, as the selected option.
  - `web/app.ts:483`: uses `msg.model_swaps` to disable the thinking control.
  - `web/app.ts:663-738`: decodes WebSocket messages and calls `setRoute(msg)` for `msg.type === "status"`.

## 7. Build and test commands

The available commands are:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --locked
npm run check
npm run build
npm test
```

- Rust CI confirms `cargo test --locked`: `.github/workflows/ci.yml:52-60`.
- `npm run check`, `npm run build`, and `npm test` are defined in `package.json:5-8`.
- `npm run check` runs `tsc --noEmit`.
- `npm run build` runs `tsc --project tsconfig.json`; `tsconfig.json:7` emits to `static/`, so `web/app.ts` compiles to `static/app.js`.
- `npm test` builds first, then runs the browser/extension tests. CI also checks `git diff --exit-code -- static` (`.github/workflows/ci.yml:47-50`).

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete file:line mapping covers the browser controls, HTML markup, /thinking handler, PBX mutation path, model catalog, WebSocket status payload, and build/test commands."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Repository source, CI workflow, package scripts, and TypeScript configuration inspected."
  ],
  "residualRisks": [
    "The model catalog is backend-only; a model switcher would need a new browser exposure/API path."
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed; produced an implementation map only.",
  "reviewFindings": [
    "none"
  ],
  "manualNotes": "No code was written or tests executed."
}
```

[38;2;136;136;136m✻ Turn took 2m 30s (Total time 2m 29s · 1 turn)[0m

Challenge specifically:
1. Does it actually mirror the existing /thinking handler's concurrency semantics (spawn_active_operation vs spawn_replacing_operation, deliver_page_reply_if_current, generation guard)? A model swap mid-turn is the dangerous case — does the plan handle it the same way thinking does?
2. Is anything invented that already exists? Flag any new helper that duplicates an existing one.
3. Is invalid-model input rejected server-side before it reaches the pi process?
4. Is the diff minimal, or is there speculative scope (new endpoints, new state, new abstractions) that should be cut?
5. Are the stated verification commands real and runnable in this repo?

List any required corrections explicitly and concretely, so the implementer can apply them directly. End with exactly one terminal line: `VERDICT: APPROVE` or `VERDICT: REVISE`.

---
**Output:**
Return the complete artifact in your final response.
The runtime will persist it to exactly this path: /home/kayne19/projects/switchboard/.pi-workflow/outputs/wf_1785952055827064028_3602195_0/review_plan.md
Do not call contact_supervisor merely because no write-capable tool is available.
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Review gate: required by reviewer.

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
    },
    {
      "id": "criterion-2",
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
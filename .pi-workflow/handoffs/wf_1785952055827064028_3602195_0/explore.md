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
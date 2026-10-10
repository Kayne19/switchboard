# switchboard

For Kayne's engineering preferences and project memory, read `BRAIN.md` and
load only the scopes it routes you to.

The voice front door for the lab: a caller reaches an operator agent, the
operator patches them through to a project's coding agent running in that
project's own directory, and that agent hands them back when they are done.
`README.md` explains the call path and the design; read it before changing
anything in `apps/backend/`.

This tree was extracted from the homelab repo, where it lived inside
`ansible/roles/damocles/files/switchboard/`. It is the only place the code is
worked on.

## The split with homelab

The application lives here. Its *deployment* lives in the homelab repo's
`damocles` role: the systemd units, the speech-to-text sidecar, the ssh config,
the project registry (`switchboard_projects`), the operator system prompt, the
persona, and every secret. Nothing here reaches damocles except through a
homelab pull request — that is deliberate and must not be worked around.

Homelab pins this repository by commit (`switchboard_version`), builds the
binary from a `git archive` of that commit, and deploys `static/` and
`extensions/` from the same tree. Merging here deploys nothing; a homelab pull
request that bumps the pin does.

The contract between the halves is the environment file. The role writes it,
this app reads it, and `docs/environment.md` lists every variable. Each is
public interface: changing or adding one is a change on both sides, and the PR
that does it should say so. That includes `SWITCHBOARD_GIT_SHA`, which crosses
at build time instead: the homelab builder sets it so `build.rs` can stamp a
binary built from `git archive` with its commit (see `README.md`).

## `extensions/` and `skills/switchboard/`

`operator-switchboard.ts` is plain TypeScript, and that file is what runs:
homelab deploys it from the pinned commit for the operator leg.

Project agents reach the caller through the `switchboard` Python skill module
in `skills/switchboard/` (standard library only), not through a TypeScript
extension. The host-agent installer (`apps/host-agent/install.mjs`) installs
it as a global prime-agent skill (`~/.prime/agent/skills/switchboard`) on each
project host, so every session has it. It talks only to the host agent on the host's local
skill socket (`docs/host-link.md`, "Skill socket"), takes its session id from
`RLM_SESSION_DIR` at `RLM_DEPTH` 0, and refuses subagents. The persona and the
call token come from the host agent at call time. Its tests are
`skills/switchboard/tests/` (`npm run test:skill`). A test asserts the module's
exact public surface; a change to the surface updates that test in the same
commit.

## Working here

- The service is Rust (`apps/backend/src/`), the browser client is TypeScript (`apps/frontend/src/`,
  compiled to the committed `static/`; the debug page compiles to the committed
  `static-debug/`, which the binary embeds and only the debug listener serves).
- The Rust toolchain is pinned in `rust-toolchain.toml` so a local run and CI
  agree. Bump it deliberately; do not work around it.
- Every gate CI runs: `cargo fmt --all -- --check`, `cargo test --locked`,
  `cargo clippy --locked --all-targets -- -D warnings`, and `npm test` followed
  by `git diff --exit-code -- static static-debug` — the compiled browser output
  is committed, so rebuild it in the same change. `npm test` ends with
  `scripts/check_hygiene.mjs`, which enforces the structural rules below that
  a grep can check (private modules, no lint allowances, one `Config`, a
  documented environment, one fake-executable writer, one skill socket path,
  one frame depth, one set of size caps, CPU-time budgets, no focused
  `.only` test, no user-agent checks, bounded test awaits, no page under
  the notch, one runtime ID prefix, stage-relative sizes, one writer per lifecycle
  machine, no new phase fields on a lifecycle owner, live paths,
  routes and settings in the docs); a new rule of that kind gets a check
  there. Both Playwright configs also set `forbidOnly` on CI, so a focused
  spec fails its browser leg.
- CI's `browser` job runs the Playwright specs in Chromium and in WebKit:
  `npm run test:browser` (every spec in `apps/frontend/tests/visual` but
  the pixel goldens, which are tagged `@golden`) and `npm run
  test:integration` (the production build), each in the Playwright
  projects `chromium` and `webkit`. It is a matrix of ten legs, so one
  runner does not take 45 minutes: for each engine, `browser (chromium
  1/4)` .. `browser (chromium 4/4)` each run a quarter of `test:browser`
  (`-- --project=chromium --fully-parallel --shard=i/4`, still one worker,
  so the timing checks stay valid), and `browser (chromium integration)`
  runs `test:integration -- --project=chromium` once; the `webkit` legs
  are the same. To rerun one leg's specs locally, pass it the same flags.
  The goldens are Chromium's alone, drawn on the dev box, and the runner's
  fonts raster differently, so they stay a local gate: run `npm run
  test:visual -- --project=chromium` before a change that moves pixels.
  The suite starts its own server on port 4183 (`PLAYWRIGHT_PORT` moves
  it) and fails rather than test a server it finds there; `test:integration`
  does the same on port 4184 (`PLAYWRIGHT_INTEGRATION_PORT` moves it). `master`
  requires only `test`; a red `browser` is still a failure to fix, not to
  merge over. Every job runs on a named Ubuntu release (`runs-on:
  ubuntu-24.04`), as the toolchain is pinned: the specs' geometry was
  measured with that release's fonts. Moving to the next release is its
  own pull request, which runs the browser suite there.
- Every CI job has a `timeout-minutes` (`test` 20, `browser` 35, about
  twice the slowest normal run), and on CI both Playwright configs set a
  `globalTimeout` of 30 minutes, so a hung leg names the tests that did not
  finish before the job is cut off. Each host-agent test has a 60-second
  default (`node --test --test-timeout`). A hang is a failure with a name,
  not six hours of a held runner; `browserCi.test.ts` pins the numbers'
  order.
- The iPad (iPadOS Safari, WebKit) is a first-class target, not a "should
  also work" one: a change that works in desktop Chromium and breaks there
  is broken. A browser runtime change (audio, capture, playback, gestures)
  says in its pull request what it does on WebKit. One implementation
  serves both engines: no user-agent checks and no WebKit-only CSS. A
  user-agent branch that cannot be avoided names the WebKit bug it works
  around in a comment and is listed in `docs/ipad.md`, which also holds the
  device checklist to run before a pin bump.
- A `static/` or `static-debug/` merge conflict is resolved by rebuilding from the merged source
  (`npm ci && npm run build`), never by picking a side (see #37).
- `master` requires a passing CI `test` check on an up-to-date head. If
  `master` moved while a PR was in CI, rebase and wait for the run on the new
  head; a merge attempted before it is refused. A head
  pushed by the Copilot agent gets no CI jobs until a maintainer approves its
  workflow runs on the pull request. An unapproved run has zero jobs and can
  end as a failure that GitHub blames on the workflow file; it is not (see
  #35). Approve it, or push the head yourself. CI runs on a pull request and
  on a push to `master`, not on a push to any other branch: open a pull
  request (a draft will do) to get a run.
- Rust tests live in `apps/backend/tests/`, each compiled as the `#[cfg(test)]`
  module of the source file it covers; browser, display, and operator
  extension tests live in `apps/frontend/tests/`; skill module tests live in
  `skills/switchboard/tests/`. Keep them passing on every commit.
- Read `docs/concurrency-and-test-hazards.md` before touching turn dispatch, page
  rescue, or any test that writes a fake executable. It records why the turn
  epoch is stamped where it is, why fake executables must go through
  `write_executable_script`, and why a broken pipe is never the error worth
  reporting.
- A unit-test time budget measures the test thread's CPU time with
  `leastCpuMs` (`apps/frontend/tests/unit/cpuTime.ts`), never the wall clock:
  under load the wall clock measures the machine, and wall-clock budgets
  failed 17 times in 7 loaded runs (`docs/concurrency-and-test-hazards.md`,
  "A time budget measured on the wall clock"). `scripts/check_hygiene.mjs`
  refuses `performance.now`, `Date.now` and `process.hrtime` in
  `apps/frontend/tests/unit` outside `cpuTime.ts`, and in
  `apps/host-agent/tests`.
- A backend test awaits a channel, a `Notify`, a watch, a stream, a
  oneshot or a task's `JoinHandle` through `within`
  (`apps/backend/src/main.rs`), which fails it by name after 10
  seconds: libtest has no per-test timeout, and a lost wake-up behind a bare
  await hangs `cargo test` with no output (`docs/concurrency-and-test-hazards.md`,
  "A test await with no deadline"). `scripts/check_hygiene.mjs` refuses a
  bare one in `apps/backend/tests`.
- Keep the backend module layout: one concern per file in `apps/backend/src/`,
  no new module layers until something concrete needs one.
- The backend's modules are private (`mod`, not `pub mod`, in `main.rs`), and
  must stay so. A `pub mod` makes every `pub` item inside it look exported, and
  rustc then stops reporting it when unused; that is how two dozen dead
  functions and a parallel lifecycle accumulated unnoticed. With private
  modules, clippy's `-D warnings` fails on dead code.
- No `#[allow(...)]` in the backend, its tests included, and no
  `#[expect(...)]`, `cfg_attr` allowance, `[lints]` table or `-A` rustflag
  either. An unused item is deleted or made `#[cfg(test)]`; an import one
  `cfg` block needs is written inside that block; a lint that is wrong is argued with in the commit, not silenced in
  the code. An allowance is a place the compiler was told to stop looking,
  and the last one here hid a dead import for months.
- Only `Config` (`apps/backend/src/main.rs`) reads the environment; modules
  take their settings from it. A second reader is a second parser of the same
  contract, and they drift.
- State that one module reads lives in a struct that module owns, with
  private fields and the narrowest setters its siblings need (`SpeechQueue`,
  `ClipState`, `TurnState` on `AppInner`; `OperatorLaunch`, `LegLaunch`,
  `DecisionState` on `Switchboard`). A field two modules read stays
  `pub(crate)` on the shared struct with both readers named in its comment.
  Do not add a `pub(crate)` field for one reader: nobody is holding that
  boundary.
- A browser command that acts carries its `generation`; one without is
  refused (if it would start something) or ignored (if it would end
  something), and the handler says which. It is never defaulted to the
  current generation: that is how a stale page acts on a new call
  (`docs/architecture.md`, rule 7).
- A bug fix lands with a test that fails on `master`: stash the source change
  and run the test once to see it fail. Say so in the PR.
- One implementation per lifecycle. A fallback is an adapter or an explicit
  refusal, not a second copy of the path kept for "when the real one is
  absent" (see rule 9 in `docs/architecture.md`).
- A lifecycle is one state type with one transition function. A change that
  adds a flag, a nullable slot, a timer or a token to a lifecycle owner, or a
  third copy of its end, extracts the machine first, in its own PR
  (`docs/architecture.md` rule 9; `codebase-hardening` doctrine 2a). The
  October 2026 audit traced 32 lifecycle bugs to a field left set in the
  wrong phase or an end missed on one exit, and each fix had added a flag.
  `scripts/check_hygiene.mjs` holds each machine to one writer and holds
  the owners that are not machines yet to the phase fields they have.
- Tests never touch the network, ElevenLabs, a whisper model, or the real `pi`
  or `ssh`. Fake executables go through `write_executable_script`; PBX tests
  drive transfers through `Prewarm::settled`, which exercises the production
  launch path.
- Secrets never land in this tree. The app reads them from the environment.
- `docs/` describes the system as it is. A plan or handoff for open work may
  live there while the work is open; delete it when the work lands (git keeps
  it) and move anything still open into an issue.

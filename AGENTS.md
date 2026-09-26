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

## `extensions/`

`agent-switchboard.ts` and `operator-switchboard.ts` are plain TypeScript, and
these files are what runs: homelab deploys them from the pinned commit, and the
service stages the agent extension onto each project host at startup
(`prewarm.rs`). The persona is not rendered into them; it arrives as
`SWITCHBOARD_PERSONA`, which the service passes to every project leg.

## Working here

- The service is Rust (`apps/backend/src/`), the browser client is TypeScript (`apps/frontend/src/`,
  compiled to the committed `static/`).
- The Rust toolchain is pinned in `rust-toolchain.toml` so a local run and CI
  agree. Bump it deliberately; do not work around it.
- Every gate CI runs: `cargo fmt --all -- --check`, `cargo test --locked`,
  `cargo clippy --locked --all-targets -- -D warnings`, and `npm test` followed
  by `git diff --exit-code -- static` — the compiled browser output is
  committed, so rebuild it in the same change.
- A `static/` merge conflict is resolved by rebuilding from the merged source
  (`npm ci && npm run build`), never by picking a side (see #37).
- `master` requires a passing CI `test` check on an up-to-date head. A head
  pushed by the Copilot agent gets no CI jobs until a maintainer approves its
  workflow runs on the pull request. An unapproved run has zero jobs and can
  end as a failure that GitHub blames on the workflow file; it is not (see
  #35). Approve it, or push the head yourself.
- Rust tests live in `apps/backend/tests/`, each compiled as the `#[cfg(test)]`
  module of the source file it covers; browser, display, and extension tests
  live in `apps/frontend/tests/`. Keep them passing on every commit.
- Read `docs/concurrency-and-test-hazards.md` before touching turn dispatch, page
  rescue, or any test that writes a fake executable. It records why the turn
  epoch is stamped where it is, why fake executables must go through
  `write_executable_script`, and why a broken pipe is never the error worth
  reporting.
- Keep the backend module layout: one concern per file in `apps/backend/src/`,
  no new module layers until something concrete needs one.
- The backend's modules are private (`mod`, not `pub mod`, in `main.rs`), and
  must stay so. A `pub mod` makes every `pub` item inside it look exported, and
  rustc then stops reporting it when unused; that is how two dozen dead
  functions and a parallel lifecycle accumulated unnoticed. With private
  modules, clippy's `-D warnings` fails on dead code.
- Only `Config` (`apps/backend/src/main.rs`) reads the environment; modules
  take their settings from it. A second reader is a second parser of the same
  contract, and they drift.
- One implementation per lifecycle. A fallback is an adapter or an explicit
  refusal, not a second copy of the path kept for "when the real one is
  absent" (see rule 9 in `docs/architecture.md`).
- Tests never touch the network, ElevenLabs, a whisper model, or the real `pi`
  or `ssh`. Fake executables go through `write_executable_script`; PBX tests
  drive transfers through `Prewarm::settled`, which exercises the production
  launch path.
- Secrets never land in this tree. The app reads them from the environment.
- `docs/` describes the system as it is. A plan or handoff for open work may
  live there while the work is open; delete it when the work lands (git keeps
  it) and move anything still open into an issue.

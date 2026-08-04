# switchboard

The voice front door for the lab: a caller reaches an operator agent, the
operator patches them through to a project's coding agent running in that
project's own directory, and that agent hands them back when they are done.
`README.md` explains the call path and the design; read it before changing
anything in `legacy/backend/`.

This tree was extracted from the homelab repo, where it lived inside
`ansible/roles/damocles/files/switchboard/`. It is now the place the code is
worked on.

## The split with homelab

The application lives here. Its *deployment* lives in the homelab repo's
`damocles` role: the systemd unit, the venv, the ssh config, the project
registry (`switchboard_projects`), the operator system prompt, the persona, and
every secret. Nothing here reaches damocles except through a homelab pull
request — that is deliberate and must not be worked around.

Until homelab is switched to a pinned-tag checkout (see
`docs/extraction-plan.md`), the deployed copy is still the one committed inside
that role. Which means: while both copies exist, a change here is not deployed,
and the two trees can drift. Cut the drift short — do the tag switch early.

The contract between the halves is the environment file. The role writes it,
this app reads it. Every `SWITCHBOARD_*` variable the code reads is public
interface: changing or adding one is a change on both sides, and the PR that
does it should say so.

## `extensions/`

`agent-switchboard.ts` and `operator-switchboard.ts` are plain TypeScript and
authoritative here. The persona is no longer rendered into them: it arrives as
`SWITCHBOARD_PERSONA`, read in `src/main.rs` and passed to the agent process in
`src/pbx.rs`, which is the fix `docs/extraction-plan.md` asked for first. The
stale `.ts.j2` copies have been removed; homelab still renders its own until the
cutover, so until then a change here reaches a project host only through the
extension staging path, not through a deploy.

## Working here

- The service is Rust (`src/`), the browser client is TypeScript (`web/`,
  compiled to the committed `static/`). The Python tree in `legacy/` is the
  compatibility baseline, not the running service.
- The Rust toolchain is pinned in `rust-toolchain.toml` so a local run and CI
  agree. Bump it deliberately; do not work around it.
- Every gate CI runs: `cargo fmt --all -- --check`, `cargo test --locked`,
  `cargo clippy --locked --all-targets -- -D warnings`,
  `python3 -m unittest discover -s legacy/tests`, and `npm test` followed by
  `git diff --exit-code -- static` — the compiled browser output is committed,
  so rebuild it in the same change.
- Compatibility tests live in `legacy/tests/`; browser tests stay in `tests/`.
  They are the reason this repo exists — keep them passing on every commit.
- No network, no ElevenLabs, no whisper model downloads in tests. Stub them.
- Read `docs/concurrency-and-test-hazards.md` before touching turn dispatch, page
  rescue, or any test that writes a fake executable. It records why the turn
  epoch is stamped where it is, why fake executables must go through
  `write_executable_script`, and why a broken pipe is never the error worth
  reporting.
- Keep the legacy module layout: one concern per file in `legacy/backend/`, no
  new package layers until something concrete needs one.
- Secrets never land in this tree. The app reads them from the environment.

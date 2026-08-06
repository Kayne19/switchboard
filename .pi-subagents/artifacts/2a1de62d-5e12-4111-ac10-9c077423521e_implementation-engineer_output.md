Implemented the remaining compatibility/documentation slice without editing `legacy/` or homelab.

Highlights:

- Unavailable model catalogs now pass through only provider-qualified specs and preserve normalized thinking suffixes; populated catalogs still enforce resolution/ambiguity rules.
- Candidate/project callback delivery now carries and validates the fresh per-process session token for speech/diagram callbacks. `delivered:false` is an extension tool error, preserving written fallback eligibility.
- Catalog snapshots remain usable for populated picker status, and failed picker requests restore the last committed native selection without overwriting newer status.
- Added callback-token, unavailable-catalog/suffix, picker restoration, and undelivered-speech regression coverage.
- Updated README, concurrency hazards, observability, and migration handoff docs for catalog fallback, callback identity, delivery ordering, speech fallback, logging/deadline contracts, and homelab boundary.
- Rebuilt committed `static/app.js` from web sources.

Checks:

- `cargo fmt --all` passed.
- `cargo test --locked` passed (69 tests).
- `cargo clippy --locked --all-targets -- -D warnings` passed.
- `npm test` passed.
- `python3 -m unittest discover -s legacy/tests` passed (143 tests).
- Documentation contract grep passed; `git diff --check` passed.
- Deterministic rebuild comparison passed. `git diff --exit-code -- static` is nonzero only because the intended static change is present relative to HEAD.
- No staged files; no legacy or homelab files changed.
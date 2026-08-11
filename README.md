# switchboard

The voice front door for the lab. You call the operator; the operator patches
you through to a project's coding agent, running in that project's own
directory on the host that holds the code; that agent hands you back when you
are done.

Deployed to `damocles` (313, 192.168.1.217) by `ansible/roles/damocles`. Do not
edit anything here on the box — it is overwritten on every deploy.

## The call path

```
browser mic --webm/opus--> /ws --faster-whisper--> transcript
    --> Switchboard.handle()  ── the active leg is either the operator or a project
    --> reply text --ElevenLabs--> mp3 --> /ws --> playback
```

Two kinds of leg, both a `pi --mode rpc` process driven over stdin/stdout:

| leg | runs | tools | lifetime |
|---|---|---|---|
| operator | on damocles | `list_projects`, `transfer_to_project` only (`--no-builtin-tools`) | persistent — it is the home base |
| project | on the host in the registry entry, `cd`'d into that project's directory | its normal coding tools | created on transfer, destroyed on return |

## Who does the talking

The **operator** never speaks for itself — everything it produces is meant to be
heard, so the switchboard synthesizes its reply directly. No mismatch to fix.

A **project agent** speaks for itself, with the `speak` tool. This is the part
worth understanding: a coding agent writes for a reader — markdown, paths,
diffs — and reading that aloud is the wrong output in the wrong place. Worse,
the switchboard cannot voice a written reply until the turn *settles*, so a
two-minute stretch of tool calls is two minutes of silence, which on a phone
call is indistinguishable from a dropped connection.

So the agent decides what to say and when, mid-turn, and its written output
stays written. `speak` POSTs to this service's `/speak`, which pushes audio
straight to the browser without waiting for anything.

The fallback matters too: if an agent finishes a turn having never called
`speak`, the switchboard voices its written reply rather than leaving the caller
in silence. It knows which happened because `speak` shows up in the same RPC
event stream it already watches. An agent on a host where the tool extension
could not be staged is told the opposite thing in its system prompt — write for
the switchboard to read out — so both paths produce a working call.

`speak` is deliberately **not** MCP. Pi has no built-in MCP because tool
definitions are expensive context; an adapter would add a config file, a
process, and a per-host install. A tool already staged to every host the
switchboard connects to has none of that.

## Showing rather than saying

Some answers are a shape, not a sentence. An architecture read out loud is a
list of nouns; the same thing drawn is understood at a glance. So a project
agent also gets `diagram`, which puts a Mermaid diagram on the caller's page
while the agent is still working.

It is `speak` with a different payload, for the same reason `speak` exists: it
has to land *mid-turn*, so it POSTs to `/diagram` and the service broadcasts on
the socket the browser is already holding, rather than waiting for the RPC
stream to settle. Nothing in the routing layer knows it happened — a diagram
changes neither the route nor whether a reply gets synthesized, so unlike a
transfer it is not a signal.

The page renders it: Mermaid 11 from a CDN, a dark neon theme, HTML labels on so
an agent can put an image inside a node, and a staggered reveal on top. The
source is parsed before anything is swapped in, so a malformed diagram fails on
the screen that can show the error instead of blanking a good diagram already
up. Details and the deliberate omissions are in `docs/diagram-tool.md`.

## Who decides where the caller goes

The switchboard does — not the agents. An agent calling `transfer_to_project` or
`return_to_operator` only raises a *signal*: the tool itself does nothing but
acknowledge, and `pbx.py` picks the call out of pi's `tool_execution_start`
event stream and swings the line over. That means a confused or wedged agent
cannot strand the caller, and every failure path (bad ssh key, wrong `cwd`,
missing agent binary, a leg that dies mid-call) ends with the caller back on the
operator being told what happened, rather than talking into a dead pipe.

For runtimes that cannot load a pi extension, the agent's system prompt tells it
to emit `[[SWITCHBOARD:RETURN]]` instead; `piclient.py` treats that line as the
same signal and strips it before anything is spoken.

Project agents get `transfer_to_project` too, so "send me to the other project"
is one hop instead of a round trip through the operator. They cannot read the
registry from a project host, so the extensions they may hand the caller to are
named in their system prompt; anything else, they send the caller back and let
the operator resolve it. A handoff back is delivered to the operator as its own
prompt, immediately — that is what lets an onward destination an agent was told
about ("send me back and tell them I want the homelab") be acted on instead of
sitting in a note until the caller repeats themselves.

The page is relabelled the moment the line swings rather than when the turn
ends, because bringing a leg up means ssh, an agent start and an intro prompt,
and the caller should not spend that looking at the name of whoever they just
left.

## Changing the model mid-call

A caller can ask the agent they are talking to for a different model or thinking
level, and the operator can name one on the way in (`transfer_to_project` takes
`model` and `thinking`). Both go through the same signal mechanism as a
transfer, for a blunter reason than usual: an agent cannot restart itself onto
another model, because the process it would have to replace is the one making
the call. `set_model` acknowledges, `pbx.py` tears the leg down and brings it
back up.

The conversation survives that restart. Every project leg is started with
`--session-id`, so the replacement process reopens the session file the old one
was writing and picks the call up mid-sentence. Preserving is the default;
`keep_context: false` mints a new id instead, and the agent is told the history
was cleared on purpose so it does not try to recall it.

What the caller says goes through whisper and then through a model's guess, so
`legacy/backend/models.py` refuses rather than guesses. A name is resolved against
`pi --list-models` **on the host the leg runs on** — providers are configured
per box, so asking damocles would answer for the wrong machine — and a phrase
matching two entries comes back as an error naming both. That is the case worth
spending code on: one model id served by two providers, picked wrong, leaves the
caller on the thing they were trying to get away from with no way to say so. The
resolved spec is always provider-qualified even when the caller was not that
specific.

If the catalog cannot be read at all, a provider-qualified spec is passed
through (it is unambiguous by construction) and a bare name is refused. A
thinking suffix such as `provider/model:high` is normalized and retained during
that fallback and on a context-preserving redial. When discovery succeeds, the
picker contains only the provider-qualified entries from that host's catalog;
the current entry is retained even if a refreshed catalog no longer lists it.

The operator is never swappable. It is where a failed swap lands the caller, so
it always answers on `switchboard_operator_model`. Set
`switchboard_model_swaps: false` in the role to turn the whole thing off.

## Thinking levels

Every leg is started at an explicit level. `switchboard_agent_thinking` supplies
one whenever the caller did not name their own, because pi does not report what
its own default would have been — an unpinned leg runs at a level nobody can
name, and a page that says "default" is telling you nothing you can act on.

Asking is not the same as getting. A model whose `thinkingLevelMap` has holes
gets clamped to a level it does have, silently, inside the session — so the
level on the command line can be a level nothing is running at. The agent
extension therefore reports `pi.getThinkingLevel()` back to `POST /leg-state`
when its session starts and whenever the level changes under it, and that
reported value is what the page shows. Until a leg reports, the page marks the
level as requested rather than stating it.

`POST /thinking` (the picker on the page) sets the level for the rest of the
process and re-dials the live project leg onto it, keeping the session file. The
operator is never re-dialled for this; its level is a deployed setting.

Project callbacks carry `SWITCHBOARD_SESSION_TOKEN`, an opaque token freshly
created for each process and distinct from the persistent Pi session ID. It
rejects stale speech, diagram, and thinking callbacks after a redial; it is a
correlation value, not authentication. A failed `/speak` delivery is reported
as an extension tool error, so the written reply remains eligible for fallback
synthesis rather than being suppressed by a tool-start event.

## Connecting without the operator

`POST /connect` (`{"project": "..."}`, or `"operator"` to come back) puts the
caller straight onto a project from the page. The operator is a router, not a
gate: when the caller already knows where they want to be, saying it out loud
and waiting to be understood is pure overhead. Any live leg is dropped first,
without the turn lock, for the same reason `/hangup` does not take it.

## Getting unstuck

`POST /hangup`, wired to the button on the page, drops the project leg and puts
the caller back on the operator. Every other way back runs through an agent
deciding to let go, which is no use when the agent is the problem — a leg on a
model that cannot hold a thread, a turn that will not settle. So this one asks
nobody, and deliberately does not take the turn lock: a rescue that waits for
the thing it is rescuing you from is not a rescue. A turn still in flight when
the button is pressed has its result discarded, because acting on it would swing
the route straight back.

The operator route remains the home base. If a page control reaches the service
while the operator process itself is wedged, that process is discarded and
recreated on the next utterance; the route still remains `operator`.

## When nobody says anything

`SWITCHBOARD_IDLE_TIMEOUT` (an hour by default, `switchboard_idle_timeout` in
the role) drops a project leg the caller has gone silent on and puts them back
on the operator. A call that is never ended otherwise holds an agent process and
an ssh connection open on someone else's box for as long as this service runs.
Nothing is synthesized when it fires — by definition nobody is listening — the
note only appears in the transcript, and the operator is told why the line is
free when they come back.

## Adding a project

Edit `switchboard_projects` in `ansible/roles/damocles/defaults/main.yml` and
open a PR. The deploy re-renders `/etc/switchboard/projects.json`, which both
this service and the operator's `list_projects` tool read, so they cannot
disagree. Aliases are matched against a speech-to-text transcript, so be
generous with them.

A project host needs three things, none of which this repo can do for hosts it
does not manage:

1. damocles's pubkey in the ssh user's `authorized_keys`
2. the agent runtime the entry names (`pi`) installed and authenticated there
3. the `cwd` to actually exist

The switchboard copies its own tools (`speak`, `return_to_operator`) into
`~/.cache/switchboard/` on the host the first time it connects, so that part
needs no setup.

If the agent binary is installed per-user (`~/.local/bin/pi` is the common
case), give `runtime` the **absolute path**. A non-interactive ssh session does
not get the PATH you see when you log in by hand, so a bare `pi` works when you
test it manually and then fails with "command not found" for the switchboard.

## Files

| file | what it is |
|---|---|
| `legacy/backend/main.py` | compatibility FastAPI app; not the active service |
| `legacy/backend/pbx.py` | legacy routing state, transfers, session lifecycle |
| `legacy/backend/piclient.py` | legacy pi RPC protocol — one turn in, text and signals out |
| `legacy/backend/registry.py` | legacy project directory and spoken-name resolution |
| `legacy/backend/models.py` | legacy spoken model name resolution |
| `legacy/backend/audio.py` | legacy whisper in, ElevenLabs out, and reply-length shaping |
| `static/index.html` | HTML shell for the tap-to-talk page |
| `web/` | TypeScript browser protocol, client, and diagram sources |
| `static/*.js` | committed deterministic browser build output |
| `static/openwakeword/` | same-origin Hey Jarvis ONNX, wrapper, and ONNX Runtime WASM assets |
| `web/hands_free.ts` | hands-free controller, real wake adapter, and separate VAD endpointing |
| `docs/hands-free.md` | hands-free lifecycle, asset provenance, and license obligations |
| `src/` | Rust service: API, routing, pi sessions, registry, models, history, audio |
| `extensions/*.ts` | plain TypeScript pi extensions; homelab templates remain authoritative until cutover |
| `docs/diagram-tool.md` | the `diagram` tool: payload, rendering, layout, and what was left out |
| `legacy/tests/` | Python compatibility tests (`python3 -m unittest discover -s legacy/tests`) |
| `tests/` | Node browser/diagram and pi-extension tests |

## Agent persona deployment contract

The plain project-agent extension reads `SWITCHBOARD_PERSONA` at runtime and the
switchboard passes it through to each agent's environment. The homelab env file
and its deployment template must provide this variable before deploying; the
persona is no longer rendered into the extension source. Keep the authoritative
Jinja deployment copies in homelab until that migration is complete. Project
processes also receive `SWITCHBOARD_SESSION_TOKEN`: a fresh per-process callback
correlation token distinct from the persistent `SWITCHBOARD_SESSION` identity.
It is not authentication, and deployment changes remain a separate homelab PR.

The Rust service keeps STT behind the transitional `SWITCHBOARD_STT_COMMAND`
sidecar contract: complete WebM bytes go to stdin and transcript text comes from
stdout. Deployments may additionally set `SWITCHBOARD_STT_STREAM_COMMAND` to a
long-lived worker. It receives length-prefixed frames (kind byte, big-endian
`u32` payload length, payload), starts with a JSONL `{"type":"ready"}` line,
and emits bounded JSONL `partial`/`final` records. A chunk payload starts with
an id length byte, the UTF-8 clip id, big-endian generation and sequence
numbers, then the WebM bytes, so concurrent clips remain attributable. Streaming is selected only
for WebM/Opus clients after the WebSocket hello handshake; unavailable or
backpressured workers explicitly fall back to the complete-clip contract.
Speech synthesis uses the shared `SWITCHBOARD_SPEECH_DEADLINE_MS` environment
contract (positive, bounded milliseconds; default `25000`) for `/speak`, normal
replies, and the project extension's abort timeout. Deployment overrides require
the corresponding homelab contract update. Adding the optional stream command
also requires a separate homelab environment-template change; no deployment
files live in this repository.
The Rust Whisper path is intentionally not declared production-equivalent until
it is benchmarked against the deployed faster-whisper model.

## Building the migrated slices

```bash
npm ci
npm test
python3 -m unittest discover -s legacy/tests
cargo fmt --all -- --check
cargo test --offline
cargo clippy --offline --all-targets -- -D warnings
```

The legacy Python service in `legacy/backend/` remains the compatibility
baseline until homelab cuts over to the pinned Rust binary. Do not remove its audio path before the STT sidecar
or a benchmarked Rust Whisper adapter is validated on the deployment host.
PBX mutation remains serialized, while live status, agent callbacks, steering,
and forced page rescue bypass that lock through bounded shared controls. The
forced-rescue path is covered under a deliberately wedged turn in the Rust
tests. Fake pi, SSH, TTS, and STT paths are also exercised without network
access. Repeat those boundaries on the deployment host as part of the live
cutover check; unit tests cannot establish microphone, model, or remote-host
behavior.

## Operating it

```bash
systemctl status switchboard
journalctl -u switchboard -f          # every transcript, route change and signal
curl -s localhost:8765/healthz | jq   # model, TTS config, current route
```

The browser page is `https://switchboard.home.arpa` (via caddy). It has to be
https: browsers only grant microphone access on a secure context, so hitting
`http://192.168.1.217:8765` directly will load the page and then fail to record.

Restarting drops whatever call is in progress and reloads the whisper model.

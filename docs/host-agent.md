# Host agent: prime-agent daemon findings (step-1 spike report)

This is the step-1 spike report for the `sb-one-assistant` plan (slice
`slice:spike-prime`). It records what the prime-agent daemon does, measured on
an isolated daemon, before the host agent is built. Later slices extend this
file into the host agent's design document.

Everything below was measured on this machine with:

- daemon: the native `prime-agent` binary 0.9.6 (Bun), protocol 7, schema
  `protocol-7-schema-30-f908f493c9e1`;
- client: the installed Node package `prime-agent` 0.9.5
  (`~/.local/npm-global/lib/node_modules/prime-agent`), which exports
  `DaemonClient`, protocol 7, schema revision 28;
- source references point at that 0.9.5 package's `dist/` (the 0.9.6 binary
  is minified; behaviour was confirmed by the probe, not by reading 0.9.6).

## The probe

`scripts/spikes/prime-daemon-probe.mjs` is a plain Node 22 script. It imports
`DaemonClient` from the installed prime-agent package and starts its own
daemon. It never talks to the user's daemon.

```sh
node scripts/spikes/prime-daemon-probe.mjs --isolated-root /tmp/sbp-<id> [--keep] [--only groups] [--verbose]
```

- `--isolated-root` is required. It must be absolute, at most 40 characters
  (Unix socket paths inside it must stay short), and not exist or be empty.
- Without it, or when it points at or inside `~/.prime`,
  `$TMPDIR/prime-agent-<uid>`, `/tmp/prime-agent-<uid>`, the directory of
  `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET` or the agent dir in
  `PRIME_AGENT_CODING_AGENT_DIR`, the probe prints `REFUSED: ...` and exits 2
  before it spawns or connects to anything.
- It prints `PASS <check>` or `FAIL <check>: <reason>` per check and `INFO`
  lines with measurements. It exits 0 only when every check passes.
- The model is a fake OpenAI-compatible server inside the probe on
  `127.0.0.1`. No credentials are copied. The daemon runs offline.
- It needs the real `prime-agent` binary, `uv` with a warm cache, a uv-managed
  CPython 3.11 and a systemd user manager. It is a spike tool, not a CI test.

A full run takes about two minutes and ends with `SUMMARY 52/52 checks passed`.

## Isolation recipe (unk:isolated-daemon)

The agent dir variable alone does not isolate a daemon. Several paths come
from `HOME` and `TMPDIR`, not from the agent dir:

| State | Default path | Source |
|---|---|---|
| agent dir (sessions, logs, worker descriptors, settings, auth) | `~/.prime/agent` | `config.js:407` `getAgentDir()`, `PRIME_AGENT_CODING_AGENT_DIR` |
| daemon socket | `$TMPDIR/prime-agent-<uid>/daemon.sock` | `daemon-socket.js:59-64,261-264` |
| worker sockets | `$TMPDIR/prime-agent-<uid>/worker-*.sock`, **even with `--daemon-socket` elsewhere** | `daemon-supervisor.js:408-414` |
| supervisor owner registry | `~/.prime/supervisor-owners` | `daemon-supervisor-ownership.js:218`, `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR` |
| kernel venv | `~/.prime/agent/kernel-venv` (not the agent dir variable) | `core/kernel/bootstrap.js:309-314`, `PRIME_AGENT_KERNEL_VENV` |
| Prime CLI credentials read by auth | `~/.prime/config.json` | `prime-inference-auth.js:16` |
| uv Python installs | `$XDG_DATA_HOME/uv/python` | uv |

The worker socket row is the trap: a daemon started with only a new agent dir
and `--daemon-socket` still puts its worker sockets in the live
`/tmp/prime-agent-<uid>/`.

The recipe the probe uses, for every process it starts (built from an
allowlist, never from the caller's environment, because a prime-agent session
exports `PRIME_AGENT_INTERNAL_*`, `RLM_*` and API keys):

- `HOME=<root>/home`, `TMPDIR=<root>/t`, `XDG_{DATA,CONFIG,CACHE,STATE}_HOME`
  inside `<root>/home`;
- `PRIME_AGENT_CODING_AGENT_DIR=<root>/home/.prime/agent`,
  `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR=<root>/home/.prime/supervisor-owners`,
  `PRIME_AGENT_KERNEL_VENV=<root>/home/.prime/agent/kernel-venv`;
- `--offline`, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`,
  `PRIME_AGENT_TELEMETRY=0`, `DO_NOT_TRACK=1`;
- `UV_OFFLINE=1` with the user's uv cache, and a copy of the user's
  uv-managed CPython 3.11 inside `<root>` (so the kernel bootstrap's
  `uv python install 3.11` never rewrites the user's uv Python links);
- `PYTHONDONTWRITEBYTECODE=1`, `NO_PROXY=*`;
- `prime-agent --mode daemon --daemon-socket <root>/daemon.sock --offline`.

The Bun binary honours `HOME` and `TMPDIR` for `os.homedir()` and
`os.tmpdir()` (checked with `BUN_BE_BUN=1 prime-agent -e ...`).

Evidence: probe checks `isolated-env` (every process in the probe's units has
`HOME`, `TMPDIR` and the agent dir inside the root, and no value that names
the live socket dir or `~/.prime`), `isolated-sockets` (every named Unix
socket of those processes is inside the root) and `isolated-network` (the
only TCP peer is the fake model on 127.0.0.1). Before and after listings of
the live socket dir, `~/.prime/supervisor-owners`, the live kernel venv and
`~/.local/share/prime-agent` did not change. Confidence: high.

## DaemonClient and resident sessions (unk:daemon-client)

Answer: yes. A Node program using the exported `DaemonClient` does every
operation the plan needs, with the caveats listed after the table.

| Operation | Command | Probe check |
|---|---|---|
| create resident, named, with config | `create {lifecycle: "resident", name, config: {cwd, provider, model, thinking, appendSystemPrompt, noBuiltinTools}}` | `create-resident-*`, `create-config-*` |
| survives its creator exiting | a separate process creates it and exits | `survive-creator-exit` |
| reopen a saved session | `create {sessionPath: <session id or .jsonl path>}` | `reopen-by-id`, `reopen-by-path` |
| prompt, steer, follow-up, abort | `prompt`, `steer`, `follow_up`, `abort` | `prompt`, `steer`, `follow_up`, `abort` |
| model and thinking | `set_model`, `set_thinking_level`, read back with `get_state` | `set_model`, `set_thinking_level-*` |
| settle | `wait_for_idle` | `wait_for_idle`, `settled-signal-*` |
| list, detach, reattach, kill | `list`, `detach`, `attach {resumeCursor}`, `kill` | `list`, `detach`, `reattach-*`, `kill` |

Details that the host agent must respect:

1. **Events.** An attached client gets
   `{type: "session_event", activeSessionId, event, meta: {sequence, cursor: {generation, sequence}}}`.
   `prompt`, `steer` and `follow_up` answer at admission, not at completion.
2. **`lifecycle` default.** Only `client_owned` sets an owner
   (`daemon-supervisor.js:2452`). Pass `resident` anyway.
3. **Names are unique for ever, not only while live.** A second create with a
   live session's name fails: `Agent name "X" is unavailable: an agent of that
   name already exists at depth 0 under this parent`. The same error happens
   after that session was killed, because the saved transcript keeps the name
   (`INFO name-reuse-after-kill`). A reopened session keeps its name
   (`INFO reopen-keeps-name`). So a fixed per-project name can be created
   once; after that the host agent must reopen the saved session by id or
   path, or use a new name.
4. **Reopen while live returns the same session.** `create {sessionPath}` on a
   session that is already live returns the existing worker
   (`INFO reopen-while-live`). The session lease keeps one writer.
5. **`config.appendSystemPrompt` replaces `APPEND_SYSTEM.md`.** The resource
   loader uses the config value instead of the discovered file
   (`resource-loader.js:344-345`). With it set, neither the project's
   `.prime/agent/APPEND_SYSTEM.md` nor the global one reaches the model
   (`INFO alpha-system-prompt-markers`). `AGENTS.md` still loads.
6. **`noBuiltinTools: true` removes `ipython`.** Only extension tools are
   sent (`INFO noBuiltinTools-tools-sent`). Without `ipython` the agent cannot
   call a Python skill. `noBuiltinTools: true` with `tools: ["ipython"]`
   sends exactly `ipython`.
7. **Thinking is clamped and readable.** `thinking: "xhigh"` on a model whose
   map drops `xhigh` and `max` gives `high` in the create summary and in
   `get_state`; `max` gives `high`; any level on a non-reasoning model gives
   `off`. `get_connection_state` also returns `availableThinkingLevels`.
8. **Abort suspends input.** After `abort`, `prompt` fails with `Cannot admit
   a session action while queued session input is suspended.` It still fails
   one second later. `resume_queue` clears the suspension; it answers with an
   error, `No queued work to resume`, but the next prompt is accepted
   (`prompt-after-abort`, `core/agent-session.js:6286-6295`, `6169-6182`). The host
   agent must send `resume_queue` after every abort and ignore that error.
9. **Busy sessions refuse plain prompts.** `prompt` on a running session fails
   with `Agent is already processing. Specify streamingBehavior ('steer' or
   'followUp') to queue the message.`
10. **Sessions start runs on their own.** When a subagent finishes, its parent
    gets `[child-exited: ...]` and starts a run with no client command
    (`INFO parent-run-after-child-finished`). Schedules and heartbeats can do
    the same. The host agent must treat an `agent_start` it did not cause as
    a turn.
11. **No event replay on reattach.** `attach` with a `resumeCursor` returns a
    fresh snapshot and `lastEventCursor`, but replays no missed events, and it
    still reports `replay.status: "complete"` (`INFO reattach-same-client`;
    the supervisor builds that value without looking at the cursor,
    `daemon-supervisor.js:4934-4942`). The host agent detects a gap itself: if
    the generation is the same and `lastEventCursor.sequence` is larger than
    its saved sequence, it missed events and must rebuild from
    `snapshot.messages` (`reattach-with-cursor`). A different generation
    means the worker restarted; the snapshot is again the baseline.
12. **Kill keeps the transcript.** `kill` stops the worker; the session leaves
    `list`; the `.jsonl` file stays and can be reopened. Any client can kill
    any session; the daemon has no creator check for resident sessions.
13. **Client-owned sessions are not a fallback.** A `client_owned` session is
    hidden from other clients' `list` (even with `includeClientOwned`) as
    soon as its owner exits, but its worker was still alive 30 seconds later
    (`INFO client-owned-after-creator-exit`).

Confidence: high for everything the probe checks; medium for items 10 and 13
beyond the cases measured.

## Settled turn (unk:turn-end)

`agent_end` is not the settled signal. Measured sequences (fake model):

| Case | Sequence |
|---|---|
| plain | agent_start > turn_start > message_end(stop) > turn_end > agent_end |
| steer while streaming | a first run ends with agent_end, then a second run with the steer: 2 × agent_end |
| follow_up while streaming | 2 × agent_end, same shape as steer |
| abort | agent_start > turn_start > message_end(aborted) > turn_end > agent_end |
| retry (one 503) | …message_end(error) > turn_end > agent_end > auto_retry_start(1) > agent_start > … > auto_retry_end(success) > turn_end > agent_end |
| retry exhausted | 3 × agent_end, then auto_retry_end(failed) after the last one |
| threshold compaction | … > agent_end > compaction_start(threshold) > compaction_end(threshold) |
| overflow compaction | …message_end(error) > agent_end > compaction_start(overflow) > compaction_end(overflow, willRetry) > agent_start > … > agent_end |

In every case `wait_for_idle` resolved after the last event of the turn (0 to
16 ms after the last `agent_end`, after `compaction_end` and
`auto_retry_end`), no lifecycle event followed it within 2 to 3 seconds, and
`get_state` then showed `isStreaming: false` and `isCompacting: false`
(`settled-signal-*` checks).

Recommended rule for the host agent:

- A turn is settled when a `wait_for_idle` request, sent after the host
  agent's last `prompt`, `steer`, `follow_up` or `abort` for that session,
  resolves.
- Use a long request timeout for it (the `DaemonClient` default is 30 s).
- Treat `agent_end` only as "a run ended". Do not report the turn finished on
  it.
- If an `agent_start` arrives when no turn is open (child finished, schedule,
  heartbeat), open a turn and settle it the same way.
- Do not use `activity` from `get_state`: it still said `working` at idle.

Confidence: high for the cases measured; medium for autonomous or goal
continuations, which were not measured.

## Project trust (unk:project-trust)

Nothing replaces `pi --approve`, and nothing needs to. prime-agent has no
trust gate: the 0.9.5 source has no trust or approve code path, and the 0.9.6
`--help` has no such flag. A session loads its cwd's resources
automatically: `AGENTS.md`, `.prime/agent/APPEND_SYSTEM.md`,
`.prime/agent/settings.json`, project skills and project TypeScript
extensions. No extension UI request is raised (`project-trust-no-approval-needed`).
A session with another cwd gets none of them
(`project-resources-scoped-to-cwd`).

Consequences:

- The homelab project loads its project resources as long as the session's
  `cwd` is the project folder.
- A project `APPEND_SYSTEM.md` replaces the global one (`resource-loader.js:687-695`),
  and `config.appendSystemPrompt` replaces both (finding 5 above).
- Project extensions run with the user's permissions, with no prompt.

Confidence: high.

## systemd layout (unk:daemon-supervision)

Workers are detached process groups, but they stay in the cgroup of the
process that started the daemon (`daemon-supervisor.js:2703-2708`).

- **Daemon in its own unit, host agent in another unit:** restarting the host
  agent unit keeps the session and its worker (same worker PID, same session,
  prompt works after) — `systemd-client-restart-keeps-resident-worker`,
  `attachable-after-client-unit-restart`.
- **Host agent starts the daemon** (as prime-agent's own CLI does): the daemon
  and every worker are in the host agent's cgroup. Restarting that unit kills
  them all, and the recreate then fails on the taken name —
  `systemd-shared-cgroup-kills-workers`.

Required layout: a dedicated user unit for the daemon
(`prime-agent --mode daemon --daemon-socket <default socket>`, `Restart=always`)
and a separate host agent unit that only connects. The host agent must never
start the daemon itself.

Not measured: restarting the daemon unit itself. With the default
`KillMode=control-group` that kills every resident worker; saved sessions can
be reopened by id. Whether `KillMode=process` plus the documented worker
adoption keeps workers across a supervisor restart is open.

Also open for step 2: the user's daemon today is started by an interactive
client (it runs in a login session scope, and linger is off on this machine).
A prime-agent CLI of another version replaces an idle daemon it considers
stale (`cli/daemon-launch.js:251-284`). Both matter for a shared daemon under
a unit.

Confidence: high for the two layouts measured.

## Python skill runtime (unk:skill-runtime)

A global Python skill placed in `<agent dir>/skills/<name>` (with
`SKILL.md`, `pyproject.toml`, `src/<name>/__init__.py`) is installed into the
kernel venv by the kernel bootstrap and works in a daemon-created resident
session:

- importable, and already imported into the kernel namespace
  (`skill-importable`, `skill-preimported`);
- at `RLM_DEPTH=0`, `RLM_SESSION_DIR` is `<agent dir>/session-artifacts/<sessionId>`,
  so its basename is the session id (`rlm-session-dir-is-session-id`);
- a subagent spawned with `rlm.spawn` imports the skill too, sees
  `RLM_DEPTH=1`, and its `RLM_SESSION_DIR` is `<parent dir>/sub-<8 hex>`
  (`subagent-depth-above-0`) — so refusing by depth is necessary and works;
- `~` in the kernel resolves to the worker's `HOME`;
- the clamped thinking level is readable from `get_state` and
  `get_connection_state` (see above).

Latency (6 turns, first one excluded; clock origin: the fake model finished
sending the `ipython` tool call):

| Path | Median |
|---|---|
| `tool_execution_start` event reaches a DaemonClient | 14.9 ms |
| module call's message reaches a local Unix socket | 15.6 ms |
| Python round trip on the socket (connect, send, reply) | 0.25 ms |

So a module call reaches a local listener at about the same time as the
tool-call event (under 1 ms later), and the socket round trip itself is well
under 1 ms. Voice latency will not come from this path.

Confidence: high.

## Version skew (dec:host-agent-ts)

The native binary on `PATH` is 0.9.6; the Node package that exports
`DaemonClient` is 0.9.5. The native updater does not update the Node package.

- Both speak protocol 7. The schema differs (28 in the client, 30 in the
  daemon). Every command the probe used works (`isolated-daemon-started` and
  all later checks). `DaemonClient.request` checks each command's
  compatibility against the daemon hello, so a missing capability fails
  cleanly.
- prime-agent's own launch helpers treat any `appVersion` mismatch as a stale
  daemon and shut down an idle one (`cli/daemon-launch.js:54-58,251-284`).
  The host agent must use `DaemonClient` directly, gate on
  `hello.protocol.version` (and command compatibility), not on `appVersion`,
  and never use those helpers.
- The docs still say protocol v4; the code says 7.

Consequence: "load the host's installed DaemonClient" works today, but the
installed client can lag the daemon. The host agent should report both
versions in its hello.

## Other facts

- A new resident session is ready in about 0.5 s. The kernel starts in the
  background at create; the first `ipython` call later took about 0.6 s.
- The first session in a fresh agent dir builds the kernel venv (uv, about
  30 s offline with a warm cache).
- The only non-agent model calls seen were compaction summaries (3 for a
  threshold compaction, 2 for an overflow compaction).
